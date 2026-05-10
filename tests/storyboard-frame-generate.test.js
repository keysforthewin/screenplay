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

function fakeRef(label, contentType = 'image/png') {
  return { buffer: Buffer.from(`fake-${label}`), contentType };
}

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeImageStore.get(key);
    if (!entry) return null;
    return {
      buffer: entry.buffer,
      file: { _id: id, contentType: entry.contentType, metadata: {} },
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

beforeEach(() => {
  fakeDb.reset();
  fakeImageStore.clear();
  BeatLocks._clearBeatLocksForTests();
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
  it('passes the scene image + every beat character sheet to gemini and persists the start frame', async () => {
    const { beat, sb, characterDocs, sceneId } = await seedScenario();
    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('generated-png'), contentType: 'image/png' };
    });

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.aspectRatio).toBe('16:9');
    // start vs end disambiguation is in the suffix added by buildVisualPrompt.
    expect(call.prompt).toContain('Alice opens the diner door.');
    expect(call.prompt).toMatch(/Render the beginning moment/);

    // Both character sheets + the scene image were attached, in that order.
    const expectedRefs = [
      ...characterDocs.map((c) => `fake-sheet-${c.name}`),
      'fake-scene',
    ];
    expect(call.inputImages.map((i) => i.buffer.toString())).toEqual(expectedRefs);

    // The storyboard row's start_frame_id was set to the new upload's id.
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.start_frame_id).not.toBeNull();
    expect(stored.start_frame_id.toString()).toBe(result.image_id);
    // End frame untouched.
    expect(stored.end_frame_id).toBeNull();
    // Scene id (which we did *not* generate) didn't leak in.
    expect(stored.start_frame_id.toString()).not.toBe(sceneId.toString());
  });

  it('uses end-moment language when role is end_frame and only updates end_frame_id', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('end-png'), contentType: 'image/png' };
    });

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    expect(calls[0].prompt).toMatch(/Render the end moment/);
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.end_frame_id.toString()).toBe(result.image_id);
    expect(stored.start_frame_id).toBeNull();
  });

  it('prefers the row-pinned character_sheet_image_id over the full beat character list', async () => {
    const { sb, characterDocs } = await seedScenario();
    // Pin a sheet on the row (as the batch does for single-character segments).
    const pinned = characterDocs[0].sheetId; // Alice's sheet.
    await Storyboards.updateStoryboard(sb._id, {
      character_sheet_image_id: pinned,
    });

    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    // Only Alice's sheet should appear (Bob's is dropped because the row
    // pinned a single-character sheet), plus the scene image.
    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-scene']);
    // The labeled character name should land in the prompt.
    expect(calls[0].prompt).toContain('The image of Alice above');
  });

  it('still succeeds when the beat has no scene image', async () => {
    const { sb } = await seedScenario({ withScene: false, characters: ['Alice'] });
    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('no-scene'), contentType: 'image/png' };
    });

    const result = await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    expect(calls[0].inputImages.map((i) => i.buffer.toString())).toEqual([
      'fake-sheet-Alice',
    ]);
    expect(result.image_id).toBeTruthy();
  });

  it('throws BeatBusyError if the beat is currently locked', async () => {
    const { beat, sb } = await seedScenario();
    Generate._setGeminiForTests(async () => ({
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
    Generate._setGeminiForTests(async () => ({
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
    Generate._setGeminiForTests(async () => ({
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

  it('appends the row\'s start_frame as a continuity ref when regenerating end_frame', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    // Pin a start_frame_id on the row and register its bytes.
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });

    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('end-out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    // Sheet + scene + continuity (the row's own start frame) — continuity last.
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-scene', 'fake-row-start']);
    expect(calls[0].prompt).toMatch(/THIS shot's start frame/);
  });

  it("appends the previous row's end_frame as a continuity ref when regenerating start_frame on row #2+", async () => {
    const { beat, sb: row1 } = await seedScenario({ characters: ['Alice'] });
    // Mark row1's end_frame so regen of row2's start_frame can reference it.
    const prevEndId = new ObjectId();
    fakeImageStore.set(prevEndId.toString(), fakeRef('prev-end'));
    await Storyboards.updateStoryboard(row1._id, { end_frame_id: prevEndId });

    // Create row2 and pin a single character so the sheet count is small.
    const row2 = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Alice slides into the booth.',
      charactersInScene: ['Alice'],
    });

    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('start-out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: row2._id.toString(),
      role: 'start_frame',
    });

    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    // Sheet + scene + continuity (previous row's end frame) — continuity last.
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-scene', 'fake-prev-end']);
    expect(calls[0].prompt).toMatch(/PREVIOUS shot's end frame/);
  });

  it('uses no continuity ref when regenerating start_frame of the first row', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    expect(sb.order).toBe(1);

    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    // No continuity ref attached.
    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-scene']);
    expect(calls[0].prompt).not.toMatch(/PREVIOUS shot's end frame/);
  });

  it('emits a Shot type cue in the prompt when shot_type is set on the row', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    await Storyboards.updateStoryboard(sb._id, { shot_type: 'close_up' });

    const calls = [];
    Generate._setGeminiForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    expect(calls[0].prompt).toMatch(/Shot type: CLOSE UP\./);
  });
});
