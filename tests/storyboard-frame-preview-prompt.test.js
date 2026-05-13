// Tests for the per-frame preview + prompt_override pipeline:
//
// - previewFrameGenerationPrompt: returns the assembled prompt and a
//   reference-bundle summary without calling the image model.
// - regenerateStoryboardFrameInternal with promptOverride: sends the
//   override verbatim with the same reference bundle, and does NOT
//   persist anywhere (the SPA's text_prompt editor is the source of
//   truth; the dialog edit is one-shot).

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

const fakeImageStore = new Map();

function fakeRef(label, contentType = 'image/png', description = '') {
  return { buffer: Buffer.from(`fake-${label}`), contentType, description };
}

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeImageStore.get(key);
    if (!entry) return null;
    return {
      buffer: entry.buffer,
      file: {
        _id: id,
        contentType: entry.contentType,
        metadata: { description: entry.description || '', name: entry.name || '' },
      },
    };
  }),
  uploadGeneratedImage: vi.fn(async ({ filename, contentType }) => ({
    _id: new ObjectId(),
    filename,
    content_type: contentType || 'image/png',
    size: 1024,
    uploaded_at: new Date(),
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const { _resetAnthropicClientForTests } = await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
  fakeImageStore.clear();
  BeatLocks._clearBeatLocksForTests();
  Generate._setDescriberForTests(async () => ({ name: '', description: '' }));
  _resetAnthropicClientForTests();
});

async function seed({
  characters = ['Alice'],
  textPrompt = 'Alice opens the diner door.',
  startFrameDescription = null,
  shotType = null,
  withStartFrame = false,
} = {}) {
  for (const name of characters) {
    const c = await Characters.createCharacter({ name });
    const sheetId = new ObjectId();
    fakeImageStore.set(sheetId.toString(), fakeRef(`sheet-${name}`));
    await fakeDb
      .collection('characters')
      .updateOne(
        { _id: c._id },
        { $set: { character_sheet_image_ids: [sheetId] } },
      );
  }
  const beat = await Plots.createBeat({
    name: 'Diner reunion',
    desc: 'Alice meets Bob.',
    body: 'Alice arrives.',
    characters,
  });
  const sceneId = new ObjectId();
  fakeImageStore.set(sceneId.toString(), fakeRef('scene'));
  await Plots.pushBeatImage(
    beat._id,
    {
      _id: sceneId,
      filename: 'scene.png',
      content_type: 'image/png',
      size: 1,
      uploaded_at: new Date(),
    },
    true,
  );
  const sb = await Storyboards.createStoryboard({
    beatId: beat._id,
    textPrompt,
  });
  const patch = {};
  if (startFrameDescription !== null) patch.start_frame_description = startFrameDescription;
  if (shotType !== null) patch.shot_type = shotType;
  if (withStartFrame) {
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    patch.start_frame_id = startId;
  }
  if (Object.keys(patch).length) {
    await Storyboards.updateStoryboard(sb._id, patch);
  }
  return { beat, sb: await Storyboards.getStoryboard(sb._id) };
}

describe('previewFrameGenerationPrompt', () => {
  it('returns the assembled prompt and ref summary for start_frame', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice stands at the door, hand on the handle.',
    });
    // Row-scope: pin Alice's sheet so the preview has a character reference
    // to summarize. Without a pin, refs are zero (no beat auto-load).
    const characters = await fakeDb.collection('characters').find({}).toArray();
    const aliceSheetId = characters[0].character_sheet_image_ids[0];
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: aliceSheetId,
    });

    const preview = await Generate.previewFrameGenerationPrompt({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    expect(typeof preview.prompt).toBe('string');
    expect(preview.prompt).toContain('Alice stands at the door, hand on the handle.');
    expect(preview.prompt).toMatch(/Render the beginning moment/);
    // Beat scene image is no longer auto-loaded.
    expect(preview.has_set_image).toBe(false);
    expect(preview.has_start_frame_ref).toBe(false);
    expect(preview.character_count).toBe(1);
    expect(preview.reference_count).toBeGreaterThanOrEqual(1);
  });

  it('uses sb.text_prompt verbatim for end_frame', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice is seated in the booth.',
      withStartFrame: true,
    });

    const preview = await Generate.previewFrameGenerationPrompt({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    expect(preview.prompt).toContain('Alice is seated in the booth.');
    expect(preview.prompt).toMatch(/start frame of this shot/i);
    expect(preview.has_start_frame_ref).toBe(true);
    // End-frame regen no longer pulls the beat scene image into the bundle.
    expect(preview.has_set_image).toBe(false);
  });

  it('does NOT mutate the storyboard on preview', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice is seated in the booth.',
      withStartFrame: true,
    });

    await Generate.previewFrameGenerationPrompt({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.text_prompt).toBe('Alice is seated in the booth.');
  });

  it('throws MissingStartFrameError for end_frame preview when no start frame exists', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice is seated.',
      withStartFrame: false,
    });
    await expect(
      Generate.previewFrameGenerationPrompt({
        storyboardId: sb._id.toString(),
        role: 'end_frame',
      }),
    ).rejects.toBeInstanceOf(Generate.MissingStartFrameError);
  });

  it('throws FrameRoleError for an unsupported role', async () => {
    const { sb } = await seed({ characters: [] });
    await expect(
      Generate.previewFrameGenerationPrompt({
        storyboardId: sb._id.toString(),
        role: 'character_sheet',
      }),
    ).rejects.toBeInstanceOf(Generate.FrameRoleError);
  });
});

describe('regenerateStoryboardFrame with promptOverride', () => {
  it('sends the override verbatim with no scaffolding', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice is seated in the booth.',
      withStartFrame: true,
    });
    const imageCalls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      imageCalls.push(args);
      return { buffer: Buffer.from('end-bytes'), contentType: 'image/png' };
    });

    const userPrompt =
      'Wide shot — the room is filled with bright pink balloons. Alice sits laughing.';

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
      promptOverride: userPrompt,
    });

    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0].prompt).toBe(userPrompt);
    // The transform prompt scaffolding ("start frame of this shot", etc.)
    // is NOT present — pure override.
    expect(imageCalls[0].prompt).not.toMatch(/start frame of this shot/i);
    expect(imageCalls[0].prompt).not.toMatch(/Additional reference images/);
  });

  it('end_frame override attaches ONLY the start frame when nothing else is pinned', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      withStartFrame: true,
    });
    const imageCalls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      imageCalls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
      promptOverride: 'anything',
    });

    const refBuffers = imageCalls[0].inputImages.map((i) => i.buffer.toString());
    // Only the start frame — no scene image, no auto-loaded character sheets.
    expect(refBuffers).toEqual(['fake-row-start']);
  });

  it('does NOT persist the override anywhere on the storyboard', async () => {
    // Override is a one-shot tweak for this generation. The SPA's text_prompt
    // editor is the canonical source of truth and the dialog should NOT
    // overwrite it from the regen flow.
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Original prompt — should remain after regen.',
      withStartFrame: true,
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('o'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
      promptOverride: 'NEW USER-EDITED PROMPT',
    });

    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.text_prompt).toBe('Original prompt — should remain after regen.');
  });

  it('does NOT mutate text_prompt during normal (no-override) end_frame regen', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice is seated in the booth.',
      withStartFrame: true,
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.text_prompt).toBe('Alice is seated in the booth.');
  });
});

describe('end_frame full mode: minimal references', () => {
  it('attaches ONLY the start frame when no sheet/refs pinned on the row', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice closes the door behind her.',
      withStartFrame: true,
    });
    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('o'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    expect(calls[0].inputImages.map((i) => i.buffer.toString())).toEqual([
      'fake-row-start',
    ]);
    expect(calls[0].prompt).toContain('Alice closes the door behind her.');
    expect(calls[0].prompt).toMatch(/start frame of this shot/i);
    expect(calls[0].prompt).not.toMatch(/Additional reference images/);
  });

  it('adds the pinned character sheet before the start frame when set on the row', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      withStartFrame: true,
    });
    // Find Alice's character_sheet_image_id and pin it on the row.
    const characters = await fakeDb.collection('characters').find({}).toArray();
    const aliceSheetId = characters[0].character_sheet_image_ids[0];
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: aliceSheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('o'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-row-start']);
    expect(calls[0].prompt).toMatch(/Additional reference images/);
    expect(calls[0].prompt).toMatch(/canonical reference for that character/);
    expect(calls[0].prompt).toMatch(/Alice/);
  });

  it('adds storyboard reference_image_ids before the start frame when present', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      withStartFrame: true,
    });
    const refIdA = new ObjectId();
    const refIdB = new ObjectId();
    fakeImageStore.set(refIdA.toString(), {
      ...fakeRef('ref-A'),
      name: 'mood-board.png',
    });
    fakeImageStore.set(refIdB.toString(), {
      ...fakeRef('ref-B'),
      name: 'lighting-ref.png',
    });
    await Storyboards.updateStoryboard(sb._id, {
      reference_image_ids: [refIdA, refIdB],
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('o'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    // Order: reference_images... → start frame last.
    expect(refs).toEqual(['fake-ref-A', 'fake-ref-B', 'fake-row-start']);
    expect(calls[0].prompt).toMatch(/Reference image above: mood-board\.png/);
    expect(calls[0].prompt).toMatch(/Reference image above: lighting-ref\.png/);
  });

  it('throws MissingStartFrameError when sb.start_frame_id is null', async () => {
    const { sb } = await seed({
      characters: ['Alice'],
      textPrompt: 'Alice closes the door.',
      withStartFrame: false,
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('o'),
      contentType: 'image/png',
    }));

    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id.toString(),
        role: 'end_frame',
      }),
    ).rejects.toBeInstanceOf(Generate.MissingStartFrameError);
  });

});
