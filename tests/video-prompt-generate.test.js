// Integration test for the Prompts-tab auto-generator: catalog construction,
// tool-result normalization, wipe-and-recreate, and the busy guard.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => false,
}));

// Image metadata for the catalog: name/description keyed by id.
const imageMeta = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    findImageFile: vi.fn(async (id) => {
      const m = imageMeta.get(String(id));
      if (!m) return null;
      return { _id: new ObjectId(String(id)), filename: 'x.png', contentType: 'image/png', length: 1, metadata: m };
    }),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Sets = await import('../src/mongo/sets.js');
const VP = await import('../src/mongo/videoPrompts.js');
const Gen = await import('../src/web/videoPromptGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  imageMeta.clear();
  projectId = (await createProject('Test Project'))._id.toString();
  BeatLocks._clearBeatLocksForTests();
  _resetAnthropicClientForTests();
  Gen._setVideoPromptWriterForTests(null);
});

function newImage(desc = '') {
  const id = new ObjectId();
  imageMeta.set(id.toString(), { description: desc, name: '' });
  return id;
}

async function seedBeatWithRefs() {
  // Only ARTWORK is catalogued: the uploaded sheet/portrait/main images below
  // must never appear.
  const uploadedSheet = newImage('Sarah full-body turnaround (uploaded sheet)');
  const uploadedPortrait = newImage('Sarah close portrait (uploaded)');
  const uploadedSetMain = newImage('Diner interior (uploaded main)');
  const sheet = newImage('Sarah full-body turnaround, red coat');
  const portrait = newImage('Sarah close portrait');
  const setMain = newImage('Diner interior, chrome counter, neon');
  const artworkId = newImage('Diner exterior at night');
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(),
    project_id: projectId,
    name: 'Sarah',
    name_lower: 'sarah',
    character_sheet_image_ids: [uploadedSheet],
    main_image_id: uploadedPortrait,
    images: [{ _id: uploadedPortrait, caption: 'portrait' }],
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: sheet, name: 'Turnaround', description: '' },
      { _id: new ObjectId(), status: 'done', result_image_id: portrait, name: 'Close', description: '' },
      { _id: new ObjectId(), status: 'error', result_image_id: null },
    ],
    fields: {},
    created_at: new Date(),
    updated_at: new Date(),
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(),
    project_id: projectId,
    name: 'Diner',
    name_lower: 'diner',
    description: 'A roadside diner.',
    main_image_id: uploadedSetMain,
    images: [{ _id: uploadedSetMain, caption: '' }],
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: setMain, name: 'Interior plate', description: '' },
      { _id: new ObjectId(), status: 'done', result_image_id: artworkId, name: 'Night plate', description: 'Diner exterior at night' },
      { _id: new ObjectId(), status: 'pending', result_image_id: null },
    ],
    created_at: new Date(),
    updated_at: new Date(),
  });
  const beat = await Plots.createBeat({
    projectId,
    name: 'Arrival',
    desc: 'Sarah walks into the diner.',
    body: 'Sarah pushes the door open. The bell rings. Everyone looks up.',
    characters: ['Sarah'],
    sets: ['Diner'],
  });
  return { beat, sheet, portrait, setMain, artworkId };
}

function fakeStreamClient(toolInput) {
  return {
    messages: {
      stream: vi.fn(() => ({
        finalMessage: async () => ({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'write_video_prompts', input: toolInput }],
        }),
      })),
    },
  };
}

async function waitForJob(jobId) {
  for (let i = 0; i < 300; i++) {
    const job = Gen.getVideoPromptGenerationJob(jobId);
    if (job && (job.status === 'done' || job.status === 'error')) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job never completed');
}

describe('buildReferenceCatalog', () => {
  it('numbers done artworks only (characters then sets), skipping uploaded sheets/portraits/gallery and non-done artworks', async () => {
    const { beat, sheet, portrait, setMain, artworkId } = await seedBeatWithRefs();
    const catalog = await Gen.buildReferenceCatalog(projectId, beat);
    expect(catalog.map((e) => e.image_id)).toEqual([
      sheet.toString(), portrait.toString(), setMain.toString(), artworkId.toString(),
    ]);
    expect(catalog.map((e) => e.index)).toEqual([1, 2, 3, 4]);
    expect(catalog[0]).toMatchObject({ owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — artwork: Turnaround' });
    expect(catalog[0].description).toBe('Sarah full-body turnaround, red coat');
    expect(catalog[2]).toMatchObject({ owner_type: 'set', owner_name: 'Diner', label: 'Diner — artwork: Interior plate' });
    expect(catalog[3].label).toBe('Diner — artwork: Night plate');
    const text = Gen.formatReferenceCatalog(catalog);
    expect(text).toContain('1. [CHARACTER Sarah] Sarah — artwork: Turnaround — Sarah full-body turnaround, red coat');
    expect(text).toContain('3. [SET Diner] Diner — artwork: Interior plate');
    expect(text).not.toMatch(/uploaded/);
  });

  it('a beat whose hosts have no artwork yields an empty catalog even when they have uploads', async () => {
    const portrait = newImage('uploaded portrait');
    await fakeDb.collection('characters').insertOne({
      _id: new ObjectId(), project_id: projectId, name: 'Tom', name_lower: 'tom',
      character_sheet_image_ids: [newImage('sheet')], main_image_id: portrait, images: [{ _id: portrait }], artworks: [],
      fields: {}, created_at: new Date(), updated_at: new Date(),
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', characters: ['Tom'] });
    expect(await Gen.buildReferenceCatalog(projectId, beat)).toEqual([]);
    expect(Gen.formatReferenceCatalog([])).toMatch(/no artwork available/);
  });
});

describe('normalizePromptEntries', () => {
  const catalog = [
    { index: 1, image_id: 'a'.repeat(24), owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — sheet' },
    { index: 2, image_id: 'b'.repeat(24), owner_type: 'set', owner_name: 'Diner', label: 'Diner — main' },
  ];

  it('maps indexes to ordered references and keeps in-range @Image handles', () => {
    const { prompts, warnings } = Gen.normalizePromptEntries(
      [{ title: 'Arrival', duration_seconds: 12, reference_image_indexes: [2, 1], prompt: '@Image1 is the diner, @Image2 is Sarah.' }],
      catalog,
    );
    expect(warnings).toEqual([]);
    expect(prompts[0].reference_images.map((r) => r.image_id)).toEqual(['b'.repeat(24), 'a'.repeat(24)]);
    expect(prompts[0].reference_images[0].owner_name).toBe('Diner');
    expect(prompts[0].prompt).toBe('@Image1 is the diner, @Image2 is Sarah.');
    expect(prompts[0].duration_seconds).toBe(12);
  });

  it('drops unknown/duplicate indexes, caps at 9, rewrites dangling handles, clamps duration', () => {
    const big = Array.from({ length: 12 }, (_, i) => ({
      index: i + 1, image_id: String(i).padStart(24, '0'), owner_type: 'set', owner_name: 'S', label: `S ${i}`,
    }));
    const { prompts, warnings } = Gen.normalizePromptEntries(
      [
        { title: '', duration_seconds: 45, reference_image_indexes: [1, 1, 99, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], prompt: '@Image1 walks. @Image12 waits.' },
        { title: 'empty', duration_seconds: 2, reference_image_indexes: [], prompt: '   ' },
      ],
      big,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0].title).toBe('Prompt 1');
    expect(prompts[0].reference_images).toHaveLength(9);
    expect(prompts[0].duration_seconds).toBe(30);
    expect(prompts[0].prompt).toBe('@Image1 walks. the subject waits.');
    expect(warnings.some((w) => /unknown reference image #99/.test(w))).toBe(true);
    expect(warnings.some((w) => /more than 9/.test(w))).toBe(true);
    expect(warnings.some((w) => /1 @Image handle pointed past/.test(w))).toBe(true);
    expect(warnings.some((w) => /45s clamped to 30s/.test(w))).toBe(true);
  });

  it('never carries dialogue words into the tool schema (words are context only)', () => {
    const props = Gen.WRITE_PROMPTS_TOOL.input_schema.properties.prompts.items.properties;
    expect(Object.keys(props).sort()).toEqual(['duration_seconds', 'prompt', 'reference_image_indexes', 'title']);
    // strict schemas reject numeric bounds — make sure none crept in
    expect(props.duration_seconds).toEqual({ type: 'integer', description: expect.any(String) });
    expect(props.reference_image_indexes.items).toEqual({ type: 'integer' });
    expect(Gen.WRITE_PROMPTS_TOOL.strict).toBe(true);
  });
});

describe('startVideoPromptGenerationJob', () => {
  it('sends the beat, dialogue rule and catalog in the user text and writes the rows with seeded text', async () => {
    const { beat, sheet, setMain } = await seedBeatWithRefs();
    let seenUserText = '';
    Gen._setVideoPromptWriterForTests(async ({ userText }) => {
      seenUserText = userText;
      return [
        { title: 'Arrival', duration_seconds: 14, reference_image_indexes: [1, 3], prompt: '@Image1 is Sarah, @Image2 is the diner. [Wide shot, static] she enters.' },
        { title: 'Looks', duration_seconds: 8, reference_image_indexes: [1], prompt: '@Image1 is Sarah. [Close-up, push in] she scans the room.' },
      ];
    });
    const jobId = await Gen.startVideoPromptGenerationJob({ projectId, beatId: beat._id.toString(), direction: 'Keep it tight.' });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.generated).toBe(2);
    expect(job.created).toBe(2);
    expect(job.warnings).toEqual([]);

    expect(seenUserText).toContain('# Beat #1: Arrival');
    expect(seenUserText).toContain('Sarah pushes the door open.');
    expect(seenUserText).toContain('# Reference image catalog');
    expect(seenUserText).toContain('1. [CHARACTER Sarah]');
    expect(seenUserText).toContain("Director's commentary:");
    expect(seenUserText).toContain('Keep it tight.');
    expect(Gen.SYSTEM_PROMPT).toContain('NEVER write the words');

    const rows = await VP.listVideoPrompts({ beatId: beat._id });
    expect(rows.map((r) => r.title)).toEqual(['Arrival', 'Looks']);
    expect(rows.map((r) => r.order)).toEqual([1, 2]);
    expect(rows[0].reference_images.map((r) => r.image_id.toString())).toEqual([sheet.toString(), setMain.toString()]);
    expect(rows[0].reference_images[1]).toMatchObject({ owner_type: 'set', owner_name: 'Diner' });
    expect(rows[0].duration_seconds).toBe(14);
    expect(rows[0].prompt).toContain('[Wide shot, static]');
  });

  it('uses the real Anthropic streaming shape when no override is set', async () => {
    const { beat } = await seedBeatWithRefs();
    const client = fakeStreamClient({
      prompts: [{ title: 'One', duration_seconds: 10, reference_image_indexes: [1], prompt: '@Image1 is Sarah.' }],
    });
    _setAnthropicClientForTests(client);
    const jobId = await Gen.startVideoPromptGenerationJob({ projectId, beatId: beat._id.toString() });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
    const call = client.messages.stream.mock.calls[0][0];
    expect(call.tools[0].name).toBe('write_video_prompts');
    expect(call.tool_choice).toEqual({ type: 'auto' });
    expect(call.max_tokens).toBe(16000);
    expect((await VP.listVideoPrompts({ beatId: beat._id }))).toHaveLength(1);
  });

  it('keeps existing rows when the model returns nothing, replaces them otherwise', async () => {
    const { beat } = await seedBeatWithRefs();
    const old = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'old', prompt: 'old' });

    Gen._setVideoPromptWriterForTests(async () => []);
    let job = await waitForJob(await Gen.startVideoPromptGenerationJob({ projectId, beatId: beat._id.toString() }));
    expect(job.status).toBe('done');
    expect(job.created).toBe(0);
    let rows = await VP.listVideoPrompts({ beatId: beat._id });
    expect(rows.map((r) => r._id.toString())).toEqual([old._id.toString()]);

    Gen._setVideoPromptWriterForTests(async () => [
      { title: 'new', duration_seconds: 10, reference_image_indexes: [], prompt: 'A new prompt.' },
    ]);
    job = await waitForJob(await Gen.startVideoPromptGenerationJob({ projectId, beatId: beat._id.toString() }));
    expect(job.status).toBe('done');
    rows = await VP.listVideoPrompts({ beatId: beat._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('new');
    expect(rows[0]._id.toString()).not.toBe(old._id.toString());
  });

  it('refuses to start while the beat is locked', async () => {
    const { beat } = await seedBeatWithRefs();
    let release;
    const held = new Promise((r) => { release = r; });
    const lock = BeatLocks.withBeatLock(beat._id, () => held);
    await expect(
      Gen.startVideoPromptGenerationJob({ projectId, beatId: beat._id.toString() }),
    ).rejects.toBeInstanceOf(Gen.BeatBusyError);
    release();
    await lock;
  });

  it('records a crash on the job instead of throwing', async () => {
    const { beat } = await seedBeatWithRefs();
    Gen._setVideoPromptWriterForTests(async () => { throw new Error('boom'); });
    const job = await waitForJob(await Gen.startVideoPromptGenerationJob({ projectId, beatId: beat._id.toString() }));
    expect(job.status).toBe('error');
    expect(job.error).toBe('boom');
  });
});
