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
  // Default the derivation hook to a no-op so tests that don't care about
  // end-prompt rewriting don't hit Anthropic. Tests that DO care override
  // this explicitly.
  Generate._setEndPromptDerivationForTests(async () => null);
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
  it('passes the scene image + every beat character sheet to gemini and persists the start frame', async () => {
    const { beat, sb, characterDocs, sceneId } = await seedScenario();
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
    // Default model is gemini; mode is generate (not edit).
    expect(call.model).toBe('gemini');
    expect(call.mode).toBe('generate');
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
    Generate._setImageDispatcherForTests(async (args) => {
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
    Generate._setImageDispatcherForTests(async (args) => {
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
    Generate._setImageDispatcherForTests(async (args) => {
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

  it('appends the row\'s start_frame as a continuity ref when regenerating end_frame', async () => {
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
    Generate._setImageDispatcherForTests(async (args) => {
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
    Generate._setImageDispatcherForTests(async (args) => {
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

  it("injects the storyboard's start_frame_description as a verbal anchor when regenerating end_frame", async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    // Pin a start_frame_id on the row + a denormalized description that
    // simulates what the batch render would have written.
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

    // The verbal anchor is injected under the "Reference details" header.
    expect(calls[0].prompt).toMatch(/Reference details/);
    expect(calls[0].prompt).toMatch(/Start frame to match: Diner interior, pink booths/);
    // And the existing PRIMARY/secondary directive is in place.
    expect(calls[0].prompt).toMatch(/PRIMARY reference/);
  });

  it('falls back to GridFS metadata description when start_frame_description is empty', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    // Stored on the GridFS file, not on the storyboard doc.
    fakeImageStore.set(startId.toString(), {
      ...fakeRef('row-start', 'image/png'),
      description: 'Stored on GridFS, not the storyboard.',
    });
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });
    // start_frame_description left empty.

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('end-out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    expect(calls[0].prompt).toMatch(
      /Start frame to match: Stored on GridFS, not the storyboard\./,
    );
  });

  it('injects character and set descriptions from GridFS metadata as verbal anchors', async () => {
    // Seed scenario but with descriptions on the character sheet and scene image.
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
    const sceneId = new ObjectId();
    fakeImageStore.set(sceneId.toString(), {
      ...fakeRef('scene', 'image/png'),
      description:
        'Mid-century roadside diner with checkered linoleum floor and a single neon OPEN sign in the window.',
    });
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
      textPrompt: 'Alice opens the diner door.',
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
    expect(calls[0].prompt).toMatch(/Set: Mid-century roadside diner/);
  });

  it('skips the Reference details block entirely when no reference has a description', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });

    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'start_frame',
    });

    // No descriptions on any reference → no "Reference details" header.
    expect(calls[0].prompt).not.toMatch(/Reference details/);
    // Original "Reference materials" listing still works (existing test
    // covers that explicitly; this is the negative form).
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
    const { sb } = await seedScenario({ characters: ['Alice'] });
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
    // Full regen still loads sheet + scene refs.
    expect(calls[0].inputImages.map((i) => i.buffer.toString())).toEqual([
      'fake-sheet-Alice',
      'fake-scene',
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

  it('attaches BOTH the character sheet and the main portrait when both exist', async () => {
    // Hand-build a single-character beat where Alice has a sheet AND a main
    // portrait. The default seedScenario only sets a sheet.
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
      textPrompt: 'Alice walks in.',
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

    // Sheet, portrait, scene — both Alice refs land in inputImages.
    const refs = calls[0].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['fake-sheet-Alice', 'fake-portrait-Alice', 'fake-scene']);
    // The grouped "two images" anchor line is emitted in the prompt.
    expect(calls[0].prompt).toMatch(/two images of Alice/);
    expect(calls[0].prompt).toMatch(/turnaround character sheet/);
  });

  it('falls back to portrait alone when a character has no sheet', async () => {
    const c = await Characters.createCharacter({ name: 'Alice' });
    const portraitId = new ObjectId();
    fakeImageStore.set(portraitId.toString(), fakeRef('portrait-Alice'));
    await fakeDb
      .collection('characters')
      .updateOne(
        { _id: c._id },
        { $set: { main_image_id: portraitId } },
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
    expect(refs).toEqual(['fake-portrait-Alice']);
    // Single-image grouping → single-reference wording.
    expect(calls[0].prompt).toMatch(/The image of Alice above/);
    expect(calls[0].prompt).not.toMatch(/two images of Alice/);
  });

  it('prefers sheets over portraits when the budget cap would force a drop', async () => {
    // Two characters, each with sheet+portrait, plus a scene image. Total
    // refs = 4 character + 1 scene = 5, but MAX_REFERENCE_IMAGES = 4 means
    // the start frame's effective char cap is 2 (4 - set - reserved cont).
    const docs = [];
    for (const name of ['Alice', 'Bob']) {
      const c = await Characters.createCharacter({ name });
      const sheetId = new ObjectId();
      const portraitId = new ObjectId();
      fakeImageStore.set(sheetId.toString(), fakeRef(`sheet-${name}`));
      fakeImageStore.set(portraitId.toString(), fakeRef(`portrait-${name}`));
      await fakeDb.collection('characters').updateOne(
        { _id: c._id },
        {
          $set: {
            character_sheet_image_ids: [sheetId],
            main_image_id: portraitId,
          },
        },
      );
      docs.push({ name, sheetId, portraitId });
    }
    const beat = await Plots.createBeat({
      name: 'B',
      desc: '',
      body: '',
      characters: ['Alice', 'Bob'],
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
      textPrompt: 'Two-shot of Alice and Bob.',
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
    // Sheets win when budget is tight: both sheets land FIRST in priority
    // order; portraits fill any remaining slot. The second portrait drops
    // because the per-call cap (MAX_REFERENCE_IMAGES = 4) is full.
    expect(refs[0]).toBe('fake-sheet-Alice');
    expect(refs[1]).toBe('fake-sheet-Bob');
    expect(refs).toContain('fake-scene');
    // portrait_Bob must be dropped — not enough slots.
    expect(refs).not.toContain('fake-portrait-Bob');
    expect(refs).toHaveLength(4); // MAX_REFERENCE_IMAGES
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

  it('softens the continuity directive so camera moves are permitted', async () => {
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
    // New wording explicitly allows the camera to shift.
    expect(p).toMatch(/camera position, angle, and distance MAY shift/i);
    expect(p).toMatch(/intentional motion progression/i);
  });

  it('runs the end_prompt derivation when start_prompt and start_frame_description are set', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_id: startId,
      start_prompt: 'High crane shot looking down at the booth, neon glow on the tabletop.',
      end_prompt: 'Same crane shot; coffee cup pushed forward an inch.',
      start_frame_description: 'High overhead shot of a pink vinyl booth lit by warm neon.',
    });

    const derivedCalls = [];
    Generate._setEndPromptDerivationForTests(async (args) => {
      derivedCalls.push(args);
      return 'Camera has descended to eye level across the booth; the coffee cup is now in the foreground.';
    });

    const dispatcherCalls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      dispatcherCalls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    // Derivation was invoked with the row's prompts + caption.
    expect(derivedCalls).toHaveLength(1);
    expect(derivedCalls[0].startPrompt).toMatch(/High crane shot/);
    expect(derivedCalls[0].endPrompt).toMatch(/Same crane shot/);
    expect(derivedCalls[0].startDescription).toMatch(/High overhead shot/);

    // Derived prompt landed in the dispatcher request.
    expect(dispatcherCalls[0].prompt).toMatch(/Camera has descended to eye level/);
    // And was persisted on the row for next time.
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.end_prompt).toMatch(/Camera has descended to eye level/);
  });

  it('skips derivation when start_prompt is empty (legacy row)', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    // Legacy row: no start_prompt persisted, only start_frame_description.
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_id: startId,
      start_frame_description: 'Some old caption.',
    });

    const derivedCalls = [];
    Generate._setEndPromptDerivationForTests(async (args) => {
      derivedCalls.push(args);
      return 'derived';
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('out'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    expect(derivedCalls).toHaveLength(0);
    const stored = await Storyboards.getStoryboard(sb._id);
    expect(stored.end_prompt).toBe('');
  });

  it('falls back to original end_prompt when derivation returns null', async () => {
    const { sb } = await seedScenario({ characters: ['Alice'] });
    const startId = new ObjectId();
    fakeImageStore.set(startId.toString(), fakeRef('row-start'));
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_id: startId,
      start_prompt: 'High crane shot.',
      end_prompt: 'Same crane, slight reframe.',
      start_frame_description: 'Caption.',
    });

    Generate._setEndPromptDerivationForTests(async () => null);
    const dispatcherCalls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      dispatcherCalls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id.toString(),
      role: 'end_frame',
    });

    // Falls back to the persisted end_prompt verbatim.
    expect(dispatcherCalls[0].prompt).toMatch(/Same crane, slight reframe/);
    const stored = await Storyboards.getStoryboard(sb._id);
    // end_prompt remains the planner's original — derivation didn't overwrite.
    expect(stored.end_prompt).toBe('Same crane, slight reframe.');
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
      role: 'end_frame',
    });
    const second = await waitForFrameJob(secondId);
    expect(second.status).toBe('done');
  });
});
