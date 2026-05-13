// Tests for the per-row storyboard frame regenerator. The batch pipeline is
// covered by storyboard-generate.test.js; this file exercises the single-row
// helper that the SPA's Generate / Regenerate buttons drive.

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

// Map of imageId(string) → { buffer, contentType }. Tests register entries on
// this map so loadImageInput / loadBeatSetImage / loadCharacterReferenceImages
// return real bytes; everything not registered returns null (matches the
// production "missing image" branch).
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
  uploadGeneratedImage: vi.fn(async ({ filename, contentType }) => {
    return {
      _id: new ObjectId(),
      filename,
      content_type: contentType || 'image/png',
      size: 1024,
      uploaded_at: new Date(),
    };
  }),
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
  fakeImageStore.clear();
  BeatLocks._clearBeatLocksForTests();
  // Default the describer override to a no-op so tests that don't care
  // about captioning don't make real Anthropic calls. Tests that DO care
  // override this with a fake that returns a known description.
  Generate._setDescriberForTests(async () => ({ name: '', description: '' }));
  // Reset two-stage planner overrides so tests don't leak into each other.
  Generate._setOutlinePlannerForTests(null);
  Generate._setFrameRefinerForTests(null);
  _resetAnthropicClientForTests();
});

async function seedScenario({ withScene = true, characters = ['Alice', 'Bob'] } = {}) {
  // Characters with sheet image ids.
  const characterDocs = [];
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
    characterDocs.push({ ...c, sheetId });
  }

  // Beat with optional scene image.
  const beatPatch = {
    name: 'Diner reunion',
    desc: 'Alice meets Bob.',
    body: 'Alice arrives.',
    characters,
  };
  const beat = await Plots.createBeat(beatPatch);
  let sceneId = null;
  if (withScene) {
    sceneId = new ObjectId();
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
  }

  // Storyboard row.
  const sb = await Storyboards.createStoryboard({
    beatId: beat._id,
    textPrompt: 'Alice opens the diner door.',
  });

  return { beat, sb, characterDocs, sceneId };
}

describe('regenerateStoryboardFrame', () => {
  it('sends no beat-derived references (no scene image, no auto-loaded characters) when the row has no pins', async () => {
    const { sb, sceneId } = await seedScenario();
    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('generated-png'), contentType: 'image/png' };
    });

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.model).toBe('gemini');
    expect(call.mode).toBe('generate');
    expect(call.prompt).toContain('Alice opens the diner door.');
    expect(call.prompt).toMatch(/Render the beginning moment/);

    // No row pins, first row, so no continuity either → empty inputImages.
    expect(call.inputImages).toEqual([]);
    // And no beat-derived sentences should leak into the prompt.
    expect(call.prompt).not.toMatch(/Reference materials/);
    expect(call.prompt).not.toMatch(/set image above/);
    expect(call.prompt).not.toMatch(/canonical reference for that character/);

    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_id).not.toBeNull();
    expect(stored.start_frame_id.toString()).toBe(result.image_id);
    expect(stored.end_frame_id).toBeNull();
    expect(stored.start_frame_id.toString()).not.toBe(sceneId.toString());
  });

  it('uses transform-style language when role is end_frame and only updates end_frame_id', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    // The new minimal end-frame pipeline requires a start frame to anchor on.
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('end-png'), contentType: 'image/png' };
    });

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    expect(calls[0].prompt).toMatch(/start frame of this shot/i);
    expect(calls[0].prompt).toMatch(/end frame of the same continuous shot/i);
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.end_frame_id.toString()).toBe(result.image_id);
    // start_frame_id was set in the seed, end_frame_id is what we just generated.
    expect(stored.start_frame_id.toString()).toBe(startId.toString());
  });

  it('sends only the row-pinned character_sheet_image_id (no beat scene, no other beat characters)', async () => {
    const { sb, characterDocs } = await seedScenario();
    // Pin a sheet on the row (as the batch does for single-character segments).
    const pinned = characterDocs[0].sheetId; // Alice's sheet.
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: pinned,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    // Only the pinned sheet — no fake-scene, no fake-sheet-Bob.
    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice']);
    // The labeled character name should land in the prompt.
    expect(calls[0].prompt).toContain('The image of Alice above');
    // Beat scene image must not be referenced.
    expect(calls[0].prompt).not.toMatch(/set image above/);
  });

  it('sends row reference_image_ids alongside any pinned sheet', async () => {
    const { sb, characterDocs } = await seedScenario({ characters: ['Alice'] });
    const refId = new ObjectId();
    fakeImageStore.set(refId.toString(), {
      ...fakeRef('row-ref', 'image/png'),
      name: 'Booth reference',
    });
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: characterDocs[0].sheetId,
      reference_image_ids: [refId],
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-row-ref']);
  });

  it('throws BeatBusyError if the beat is currently locked', async () => {
    const { beat, sb } = await seedScenario();
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));

    let release;
    const block = new Promise((r) => {
      release = r;
    });
    const lockHeld = BeatLocks.withBeatLock(beat._id, () => block);

    try {
      await expect(
        Generate.regenerateStoryboardFrame({
          storyboardId: sb._id.toString(),
          role: 'start_frame',
        }),
      ).rejects.toBeInstanceOf(Generate.BeatBusyError);
    } finally {
      release();
      await lockHeld;
    }
  });

  it('throws FrameRoleError for an unsupported role', async () => {
    const { sb } = await seedScenario({ characters: [] });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id.toString(),
        role: 'character_sheet',
      }),
    ).rejects.toBeInstanceOf(Generate.FrameRoleError);
  });

  it('throws when the storyboard does not exist', async () => {
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: new ObjectId().toString(),
        role: 'start_frame',
      }),
    ).rejects.toThrow(/Storyboard not found/);
  });

  it('attaches ONLY the row\'s start frame (no scene, no auto-loaded characters) for end_frame', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    // Pin a start_frame_id on the row and register its bytes.
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('end-out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    // End-frame full mode is anchored on the start frame; no beat scene
    // image, no auto-loaded character sheets (those would only come along
    // if explicitly pinned via sb.character_sheet_image_id or
    // sb.reference_image_ids).
    expect(refs).toEqual(['fake-row-start']);
    expect(calls[0].prompt).toMatch(/start frame of this shot/i);
  });

  it("appends the previous row's end_frame as a continuity ref when regenerating start_frame on row #2+", async () => {
    const { beat, sb: row1, characterDocs } = await seedScenario({ characters: ['Alice'] });
    // Mark row1's end_frame so regen of row2's start_frame can reference it.
    const prevEndId = new ObjectId();
    fakeImageStore.set(prevEndId.toString(), fakeRef('prev-end'));
    await Storyboards.updateStoryboard(row1._id, { end_frame_id: prevEndId });

    // Create row2 and pin Alice's sheet (row-scoped — beat auto-load no
    // longer happens, so the pin is needed for the sheet to appear).
    const row2 = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Alice slides into the booth.',
      charactersInScene: ['Alice'],
    });
    await Storyboards.updateStoryboard(row2._id, {
      character_sheet_image_id: characterDocs[0].sheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('start-out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: row2._id.toString(),
      role: 'start_frame',
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    // Pinned sheet + continuity (previous row's end frame) — continuity last.
    // No beat scene image (intentional under the row-only scope).
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-prev-end']);
    expect(calls[0].prompt).toMatch(/PREVIOUS shot's end frame/);
  });

  it('honors includeContinuity=false to drop the previous shot end frame even when one exists', async () => {
    const { beat, sb: row1, characterDocs } = await seedScenario({ characters: ['Alice'] });
    const prevEndId = new ObjectId();
    fakeImageStore.set(prevEndId.toString(), fakeRef('prev-end'));
    await Storyboards.updateStoryboard(row1._id, { end_frame_id: prevEndId });

    const row2 = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Alice slides into the booth.',
      charactersInScene: ['Alice'],
    });
    await Storyboards.updateStoryboard(row2._id, {
      character_sheet_image_id: characterDocs[0].sheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: row2._id.toString(),
      role: 'start_frame',
      includeContinuity: false,
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice']);
    expect(calls[0].prompt).not.toMatch(/PREVIOUS shot's end frame/);
  });

  it('uses no continuity ref when regenerating start_frame of the first row', async () => {
    const { sb, characterDocs } = await seedScenario({ characters: ['Alice'] });
    expect(sb.order).toBe(1);
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: characterDocs[0].sheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    // No previous row → no continuity ref. Only the pinned sheet.
    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice']);
    expect(calls[0].prompt).not.toMatch(/PREVIOUS shot's end frame/);
  });

  it('end_frame regen with includeStartFrame=false succeeds even when sb.start_frame_id is null', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    expect(sb.start_frame_id).toBeNull();

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
      includeStartFrame: false,
    });

    expect(result.image_id).toBeTruthy();
    expect(calls[0].inputImages).toEqual([]);
    // The "final image above is the start frame" framing must not appear.
    expect(calls[0].prompt).not.toMatch(/final image above is the start frame/i);
    expect(calls[0].prompt).toMatch(/Generate the end frame of this shot/i);
  });

  it('end_frame regen with includeStartFrame=false drops the start frame even when one exists on the row', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
      includeStartFrame: false,
    });

    expect(calls[0].inputImages).toEqual([]);
    expect(calls[0].prompt).not.toMatch(/final image above is the start frame/i);
  });

  it('emits a Shot type cue in the prompt when shot_type is set on the row', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    await Storyboards.updateStoryboard(sb._id, { shot_type: 'close_up' });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    expect(calls[0].prompt).toMatch(/Shot type: CLOSE UP\./);
  });

  it("does NOT inject start_frame_description as a verbal anchor for end_frame (the start frame image itself carries the visual)", async () => {
    // The old end-frame pipeline used buildVisualPrompt's "Reference details"
    // block to surface start_frame_description as a verbal anchor. The new
    // transform-focused pipeline omits all such scaffolding — the start
    // frame is the canvas, not a verbal reference.
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start', 'image/png'));
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_id: startId,
      start_frame_description:
        'Diner interior, pink booths, single hanging lamp, warm tungsten light from camera-left.',
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('end-out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    expect(calls[0].prompt).not.toMatch(/Reference details/);
    expect(calls[0].prompt).not.toMatch(/Start frame to match:/);
    expect(calls[0].prompt).not.toMatch(/PRIMARY reference/);
  });

  it('injects the pinned character sheet description from GridFS metadata as a verbal anchor', async () => {
    const c = await Characters.createCharacter({ name: 'Alice' });
    const sheetId = new ObjectId();
    fakeImageStore.set(sheetId.toString(), {
      ...fakeRef('sheet-Alice', 'image/png'),
      description: 'Alice has shoulder-length ash blonde hair and a denim jacket.',
    });
    await fakeDb
      .collection('characters')
      .updateOne(
        { _id: c._id },
        { $set: { character_sheet_image_ids: [sheetId] } },
      );

    const beat = await Plots.createBeat({
      name: 'Diner reunion',
      desc: '',
      body: '',
      characters: ['Alice'],
    });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Alice opens the diner door.',
    });
    // Row-scope: must pin the sheet on the row for it to be loaded.
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: sheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    expect(calls[0].prompt).toMatch(/Reference details/);
    expect(calls[0].prompt).toMatch(/Alice: Alice has shoulder-length ash blonde hair/);
    // Beat scene image is no longer auto-loaded under the row-scope, so the
    // set description must not appear either.
    expect(calls[0].prompt).not.toMatch(/Set: /);
  });

  it('skips the Reference details block when the pinned reference has no description', async () => {
    const { sb, characterDocs } = await seedScenario({ characters: ['Alice'] });
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: characterDocs[0].sheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    // Sheet has no description → no "Reference details" header.
    expect(calls[0].prompt).not.toMatch(/Reference details/);
    // The high-level "Reference materials" listing still appears because a
    // sheet is attached.
    expect(calls[0].prompt).toMatch(/Reference materials/);
  });

  it('captions the regenerated start frame and persists start_frame_description', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    // Override the describer to return a known fake caption.
    Generate._setDescriberForTests(async () => ({
      name: 'Diner doorway',
      description:
        'Wide shot of a diner doorway. Warm tungsten key from camera-left, pink booth visible behind.',
    }));
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('start-out'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_description).toMatch(/Wide shot of a diner doorway/);
  });

  it('passes imageModel="openai" through to the dispatcher on full regen', async () => {
    const { sb, characterDocs } = await seedScenario({ characters: ['Alice'] });
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: characterDocs[0].sheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
      imageModel: 'openai',
    });

    expect(calls[0].model).toBe('openai');
    expect(calls[0].mode).toBe('generate');
    // Row-scope: only the pinned sheet — no auto-loaded scene image.
    expect(calls[0].inputImages.map((i) => i.buffer.toString())).toEqual([
      'fake-sheet-Alice',
    ]);
  });

  it('edit mode skips reference loading and passes only the existing frame + edit prompt', async () => {
    const { sb } = await seedScenario({ characters: ['Alice', 'Bob'] });
    // Pin a start_frame on the row so edit mode has something to read.
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('existing-start'));
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('edited'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
      mode: 'edit',
      editPrompt: 'remove the lamp on the left',
      imageModel: 'gemini',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe('edit');
    expect(calls[0].model).toBe('gemini');
    // Only the existing start frame's bytes; no character sheets, scene image,
    // or continuity refs.
    expect(calls[0].inputImages.map((i) => i.buffer.toString())).toEqual([
      'fake-existing-start',
    ]);
    // The user's prompt is sent verbatim — none of the buildVisualPrompt
    // scaffolding ("Render the beginning moment", "Reference materials", etc.).
    expect(calls[0].prompt).toBe('remove the lamp on the left');
    expect(calls[0].prompt).not.toMatch(/Render the beginning moment/);
    expect(calls[0].prompt).not.toMatch(/Reference materials/);
  });

  it('edit mode without editPrompt throws EditModeError', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id.toString(),
        role: 'start_frame',
        mode: 'edit',
        editPrompt: '   ',
      }),
    ).rejects.toBeInstanceOf(Generate.EditModeError);
  });

  it('edit mode with no existing image throws EditModeError', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    // start_frame_id is null on a freshly-created row.
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id.toString(),
        role: 'start_frame',
        mode: 'edit',
        editPrompt: 'add fog',
      }),
    ).rejects.toBeInstanceOf(Generate.EditModeError);
  });

  it('custom mode sends the user prompt verbatim with no input images', async () => {
    const { sb } = await seedScenario({ characters: ['Alice', 'Bob'] });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('custom-out'), contentType: 'image/png' };
    });

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
      mode: 'custom',
      customPrompt: '  a lone red balloon drifting over a gray cityscape  ',
      imageModel: 'gemini',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe('generate');
    expect(calls[0].model).toBe('gemini');
    // Trimmed, verbatim — no buildVisualPrompt scaffolding.
    expect(calls[0].prompt).toBe(
      'a lone red balloon drifting over a gray cityscape',
    );
    expect(calls[0].prompt).not.toMatch(/Render the beginning moment/);
    expect(calls[0].prompt).not.toMatch(/Reference materials/);
    // No reference images at all.
    expect(calls[0].inputImages).toEqual([]);

    // Image was still persisted to the row.
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_id.toString()).toBe(result.image_id);
  });

  it('custom mode works when the slot is empty (no existing image required)', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    // Confirm precondition: no start frame yet.
    expect(sb.start_frame_id).toBeNull();

    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('custom-out'),
      contentType: 'image/png',
    }));

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
      mode: 'custom',
      customPrompt: 'a misty forest at dawn',
    });

    expect(result.image_id).toBeTruthy();
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_id.toString()).toBe(result.image_id);
  });

  it('custom mode without customPrompt throws EditModeError', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id.toString(),
        role: 'start_frame',
        mode: 'custom',
        customPrompt: '   ',
      }),
    ).rejects.toBeInstanceOf(Generate.EditModeError);
  });

  it('custom mode on start_frame still re-captions the new image', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setDescriberForTests(async () => ({
      name: '',
      description: 'caption for custom-generated start frame',
    }));
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('custom-out'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
      mode: 'custom',
      customPrompt: 'a misty forest at dawn',
    });

    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_description).toBe(
      'caption for custom-generated start frame',
    );
  });

  it('rejects an unknown mode', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id.toString(),
        role: 'start_frame',
        mode: 'bogus',
      }),
    ).rejects.toBeInstanceOf(Generate.EditModeError);
  });

  it('edit mode on start_frame still re-captions the new image', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('existing-start'));
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });

    const describerCalls = [];
    Generate._setDescriberForTests(async (args) => {
      describerCalls.push(args);
      return { name: '', description: 'updated caption after edit' };
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('edited'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
      mode: 'edit',
      editPrompt: 'add fog',
    });

    expect(describerCalls).toHaveLength(1);
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_description).toBe('updated caption after edit');
  });

  it('attaches BOTH the character sheet and the main portrait when both exist on the pinned character', async () => {
    // The owning character has a sheet AND a main portrait. The row pins
    // the sheet; loadEndFramePinnedSheet also pulls the owner's portrait.
    const c = await Characters.createCharacter({ name: 'Alice' });
    const sheetId = new ObjectId();
    const portraitId = new ObjectId();
    fakeImageStore.set(sheetId.toString(), fakeRef('sheet-Alice'));
    fakeImageStore.set(portraitId.toString(), fakeRef('portrait-Alice'));
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          character_sheet_image_ids: [sheetId],
          main_image_id: portraitId,
        },
      },
    );
    const beat = await Plots.createBeat({
      name: 'B',
      desc: '',
      body: '',
      characters: ['Alice'],
    });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Alice walks in.',
    });
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: sheetId,
    });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    // Sheet + portrait — both Alice refs land in inputImages. No scene.
    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-portrait-Alice']);
    // The grouped "two images" anchor line is emitted in the prompt.
    expect(calls[0].prompt).toMatch(/two images of Alice/);
    expect(calls[0].prompt).toMatch(/turnaround character sheet/);
  });

  it('still pins the character_sheet on a single-character segment even when dual refs are loaded (batch path)', async () => {
    // This exercises the BATCH renderFrame's single-char pin — when a beat
    // names exactly one character and that character has both a sheet and
    // a portrait, the pin should still attach the sheet id to the row.
    Generate._setOutlinePlannerForTests(async () => [
      {
        description: 'Alice walks in.',
        shot_type: 'medium',
        duration_seconds: 5,
        transition_in: '',
        characters_in_scene: ['Alice'],
      },
    ]);
    Generate._setFrameRefinerForTests(async () => ({
      start_prompt: 'Medium of Alice.',
      end_prompt: 'Alice takes a step.',
    }));
    const c = await Characters.createCharacter({ name: 'Alice' });
    const sheetId = new ObjectId();
    const portraitId = new ObjectId();
    fakeImageStore.set(sheetId.toString(), fakeRef('sheet-Alice'));
    fakeImageStore.set(portraitId.toString(), fakeRef('portrait-Alice'));
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          character_sheet_image_ids: [sheetId],
          main_image_id: portraitId,
        },
      },
    );
    const beat = await Plots.createBeat({
      name: 'B',
      desc: '',
      body: '',
      characters: ['Alice'],
    });

    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('out'),
      contentType: 'image/png',
    }));

    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    for (let i = 0; i < 200; i++) {
      const j = Generate.getStoryboardGenerationJob(jobId);
      if (j && (j.status === 'done' || j.status === 'partial')) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(1);
    // Even though Alice contributed two refs to inputImages, the row pin
    // resolves the character_sheet to the sheet id (not the portrait).
    expect(stored[0].character_sheet_image_id?.toString()).toBe(sheetId.toString());
  });

  it('permits camera moves and pose changes in the end-frame transform prompt', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    const p = calls[0].prompt;
    // Old wording forbade camera movement — make sure it's gone.
    expect(p).not.toMatch(/Only the character's pose ?\/ ?motion changes/);
    expect(p).not.toMatch(/Reproduce the start frame's exact .* composition/);
    // New transform-style wording allows camera reframe / pose changes.
    expect(p).toMatch(/camera reframe, pose, expression, action/i);
    expect(p).toMatch(/continuation, not a new scene/i);
  });

  it('uses sb.text_prompt verbatim for end_frame regen (no derivation, no rewrite)', async () => {
    // Storyboard rows have one prompt field — text_prompt. The regen
    // pipeline reads it directly and wraps it in transform-style
    // scaffolding for the image model.
    const { beat, sb: seededSb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(seededSb._id, {
      start_frame_id: startId,
      text_prompt: 'Same crane shot; coffee cup pushed forward an inch.',
    });
    void beat;

    const dispatcherCalls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      dispatcherCalls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: seededSb._id.toString(),
      role: 'end_frame',
    });

    expect(dispatcherCalls[0].prompt).toContain('Same crane shot; coffee cup pushed forward an inch.');
    expect(dispatcherCalls[0].prompt).toMatch(/start frame of this shot/i);
    // text_prompt is NOT mutated by regen.
    const stored = await Storyboards.getStoryboard(seededSb._id);
    expect(stored.text_prompt).toBe('Same crane shot; coffee cup pushed forward an inch.');
  });
});

async function waitForFrameJob(jobId, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = Generate.getFrameGenerationJob(jobId);
    if (j && (j.status === 'done' || j.status === 'error')) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  return Generate.getFrameGenerationJob(jobId);
}

describe('startFrameGenerationJob', () => {
  it('runs the worker in the background and lands status=done with the new image id', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('bg-out'),
      contentType: 'image/png',
    }));

    const jobId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });
    expect(typeof jobId).toBe('string');

    // Status is queued or running before the worker finishes.
    const initial = Generate.getFrameGenerationJob(jobId);
    expect(initial).toBeTruthy();
    expect(['queued', 'running']).toContain(initial.status);

    const job = await waitForFrameJob(jobId);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.image_id).toBeTruthy();
    expect(job.finished_at).toBeInstanceOf(Date);

    // The storyboard row was updated through the gateway.
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_id.toString()).toBe(job.image_id);
  });

  it('throws BeatBusyError before queueing if the beat lock is already held', async () => {
    const { beat, sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));

    let release;
    const block = new Promise((r) => {
      release = r;
    });
    const lockHeld = BeatLocks.withBeatLock(beat._id, () => block);

    try {
      await expect(
        Generate.startFrameGenerationJob({
          storyboardId: sb._id.toString(),
          role: 'start_frame',
        }),
      ).rejects.toBeInstanceOf(Generate.BeatBusyError);
    } finally {
      release();
      await lockHeld;
    }
  });

  it('rejects bad role / mode at the gate, before a job record is created', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    await expect(
      Generate.startFrameGenerationJob({
        storyboardId: sb._id.toString(),
        role: 'character_sheet',
      }),
    ).rejects.toBeInstanceOf(Generate.FrameRoleError);
    await expect(
      Generate.startFrameGenerationJob({
        storyboardId: sb._id.toString(),
        role: 'start_frame',
        mode: 'bogus',
      }),
    ).rejects.toBeInstanceOf(Generate.EditModeError);
  });

  it('records dispatcher errors on the job with status=error', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setImageDispatcherForTests(async () => {
      throw new Error('upstream image API exploded');
    });

    const jobId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    const job = await waitForFrameJob(jobId);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/upstream image API exploded/);
    expect(job.image_id).toBeNull();
    expect(job.finished_at).toBeInstanceOf(Date);

    // Storyboard row was not mutated.
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_id).toBeNull();
  });

  it('releases the beat lock after the job finishes (so a follow-up job can be queued)', async () => {
    const { beat, sb } = await seedScenario({ characters: ['Alice'] });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('first'),
      contentType: 'image/png',
    }));

    const firstId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });
    const first = await waitForFrameJob(firstId);
    expect(first.status).toBe('done');
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(false);

    // Second start succeeds; lock was released cleanly.
    const secondId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });
    const second = await waitForFrameJob(secondId);
    expect(second.status).toBe('done');
  });
});
