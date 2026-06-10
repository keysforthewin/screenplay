import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Projects = await import('../src/mongo/projects.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

const beatA = new ObjectId();
const beatB = new ObjectId();

// Insert a legacy-shaped storyboard doc (pre-frames model) straight into the
// fake collection so we can exercise the lazy backfill path.
async function insertLegacy(fields = {}) {
  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    beat_id: beatA,
    order: 1,
    text_prompt: '',
    summary: '',
    start_frame_id: null,
    start_frame_prompt: '',
    start_frame_reference_ids: [],
    previous_start_frame_id: null,
    last_start_frame_edit_prompt: '',
    end_frame_id: null,
    end_frame_prompt: '',
    end_frame_reference_ids: [],
    previous_end_frame_id: null,
    last_end_frame_edit_prompt: '',
    created_at: now,
    updated_at: now,
    ...fields,
  };
  await fakeDb.collection('storyboards').insertOne(doc);
  return doc;
}

describe('storyboards mongo helpers', () => {
  it('creates a storyboard with auto-incrementing order per beat', async () => {
    const a1 = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const a2 = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const b1 = await Storyboards.createStoryboard({ projectId, beatId: beatB });
    expect(a1.order).toBe(1);
    expect(a2.order).toBe(2);
    expect(b1.order).toBe(1);
    expect(a1.beat_id.toString()).toBe(beatA.toString());
  });

  it('seeds defaults: empty text, empty frames, no audio', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    expect(sb.text_prompt).toBe('');
    expect(sb.frames).toEqual([]);
    expect(sb.audio_file_id).toBe(null);
  });

  it('does not carry the retired start/end frame top-level fields', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    expect(sb.start_frame_id).toBeUndefined();
    expect(sb.end_frame_id).toBeUndefined();
    expect(sb.start_frame_prompt).toBeUndefined();
    expect(sb.start_frame_reference_ids).toBeUndefined();
    expect(sb.character_sheet_image_id).toBeUndefined();
  });

  it('listStoryboards filters by beat and sorts by order', async () => {
    const a1 = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const a2 = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await Storyboards.createStoryboard({ projectId, beatId: beatB });
    const list = await Storyboards.listStoryboards({ beatId: beatA });
    expect(list).toHaveLength(2);
    expect(list[0]._id.toString()).toBe(a1._id.toString());
    expect(list[1]._id.toString()).toBe(a2._id.toString());
  });

  it('countStoryboardsByBeat returns a Map keyed by beat hex id', async () => {
    await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await Storyboards.createStoryboard({ projectId, beatId: beatB });
    const counts = await Storyboards.countStoryboardsByBeat(projectId);
    expect(counts.get(beatA.toString())).toBe(2);
    expect(counts.get(beatB.toString())).toBe(1);
  });

  it('updateStoryboard accepts text_prompt and summary', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const updated = await Storyboards.updateStoryboard(projectId, sb._id, {
      text_prompt: 'A wide shot of the diner at dusk.',
      summary: 'Diner, dusk.',
    });
    expect(updated.text_prompt).toBe('A wide shot of the diner at dusk.');
    expect(updated.summary).toBe('Diner, dusk.');
  });

  it('updateStoryboard rejects the retired start_frame_id field', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(projectId, sb._id, { start_frame_id: new ObjectId() }),
    ).rejects.toThrow(/unknown field/);
  });

  it('updateStoryboard rejects unknown fields', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(projectId, sb._id, { random_field: 'nope' }),
    ).rejects.toThrow(/unknown field/);
  });

  it('reorderStoryboardsForBeat rewrites the order field', async () => {
    const a = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const b = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const c = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    expect(a.order).toBe(1);
    const reordered = await Storyboards.reorderStoryboardsForBeat(beatA, [
      c._id.toString(),
      a._id.toString(),
      b._id.toString(),
    ]);
    expect(reordered.map((s) => s._id.toString())).toEqual([
      c._id.toString(),
      a._id.toString(),
      b._id.toString(),
    ]);
    expect(reordered.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('reorderStoryboardsForBeat rejects mismatched length or foreign ids', async () => {
    await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.reorderStoryboardsForBeat(beatA, [new ObjectId().toString()]),
    ).rejects.toThrow(/length/);
  });

  it('deleteStoryboard removes a single storyboard', async () => {
    const a = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const b = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await Storyboards.deleteStoryboard(a._id);
    const list = await Storyboards.listStoryboards({ beatId: beatA });
    expect(list).toHaveLength(1);
    expect(list[0]._id.toString()).toBe(b._id.toString());
  });

  it('deleteStoryboardsForBeat clears all storyboards for that beat', async () => {
    await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await Storyboards.createStoryboard({ projectId, beatId: beatB });
    await Storyboards.deleteStoryboardsForBeat(beatA);
    const a = await Storyboards.listStoryboards({ beatId: beatA });
    const b = await Storyboards.listStoryboards({ beatId: beatB });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});

describe('frames pool', () => {
  it('addFrame appends an empty frame with a stable id and default fields', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { storyboard, frameId } = await Storyboards.addFrame(sb._id, {});
    expect(storyboard.frames).toHaveLength(1);
    const f = storyboard.frames[0];
    expect(f._id.toString()).toBe(frameId.toString());
    expect(f.image_id).toBe(null);
    expect(f.prompt).toBe('');
    expect(f.previous_image_id).toBe(null);
    expect(f.last_edit_prompt).toBe('');
    expect(f.reference_ids).toEqual([]);
  });

  it('addFrame stores a supplied image, prompt and references', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const img = new ObjectId();
    const ref = new ObjectId();
    const { storyboard } = await Storyboards.addFrame(sb._id, {
      imageId: img.toString(),
      prompt: 'Wide on the doorway.',
      referenceIds: [ref.toString()],
    });
    const f = storyboard.frames[0];
    expect(f.image_id.toString()).toBe(img.toString());
    expect(f.prompt).toBe('Wide on the doorway.');
    expect(f.reference_ids.map((x) => x.toString())).toEqual([ref.toString()]);
  });

  it('addFrame rejects a 7th frame (MAX_FRAMES = 6)', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    expect(Storyboards.MAX_FRAMES).toBe(6);
    for (let i = 0; i < 6; i++) await Storyboards.addFrame(sb._id, {});
    await expect(Storyboards.addFrame(sb._id, {})).rejects.toThrow(/6/);
  });

  it('removeFrame drops the entry and reports the undo image as orphaned', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const cur = new ObjectId();
    const prev = new ObjectId();
    const { frameId } = await Storyboards.addFrame(sb._id, { imageId: cur });
    // Simulate an edit so the frame has a previous (undo) image.
    await Storyboards.rotateFrameImageEdit({
      id: sb._id,
      frameId,
      newImageId: new ObjectId(),
      editPrompt: 'tweak',
    });
    // Re-read to get the real previous id, then remove.
    const reloaded = await Storyboards.getStoryboard(projectId, sb._id);
    const before = reloaded.frames.find((f) => f._id.equals(frameId));
    const prevId = before.previous_image_id;
    const { storyboard, orphanedImageIds } = await Storyboards.removeFrame(
      sb._id,
      frameId,
    );
    expect(storyboard.frames).toHaveLength(0);
    expect(orphanedImageIds.map((x) => String(x))).toContain(String(prevId));
    void cur;
    void prev;
  });

  it('removeFrame rejects an unknown frame id', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.removeFrame(sb._id, new ObjectId()),
    ).rejects.toThrow(/frame/i);
  });

  it('reorderFrames reorders the array by frame id', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const a = (await Storyboards.addFrame(sb._id, { prompt: 'a' })).frameId;
    const b = (await Storyboards.addFrame(sb._id, { prompt: 'b' })).frameId;
    const c = (await Storyboards.addFrame(sb._id, { prompt: 'c' })).frameId;
    const out = await Storyboards.reorderFrames(sb._id, [
      c.toString(),
      a.toString(),
      b.toString(),
    ]);
    expect(out.frames.map((f) => f.prompt)).toEqual(['c', 'a', 'b']);
  });

  it('reorderFrames rejects a set that does not match exactly', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const a = (await Storyboards.addFrame(sb._id, {})).frameId;
    await Storyboards.addFrame(sb._id, {});
    await expect(
      Storyboards.reorderFrames(sb._id, [a.toString()]),
    ).rejects.toThrow();
  });

  it('setFrameImage sets a frame current image', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    const img = new ObjectId();
    const out = await Storyboards.setFrameImage(sb._id, frameId, img);
    expect(out.frames[0].image_id.toString()).toBe(img.toString());
  });
});

describe('per-frame edit + undo', () => {
  it('rotateFrameImageEdit moves current→previous and installs the new image', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const cur = new ObjectId();
    const next = new ObjectId();
    const { frameId } = await Storyboards.addFrame(sb._id, { imageId: cur });
    const { storyboard, orphanedImageId } = await Storyboards.rotateFrameImageEdit({
      id: sb._id,
      frameId,
      newImageId: next,
      editPrompt: 'make it night',
    });
    const f = storyboard.frames.find((x) => x._id.equals(frameId));
    expect(f.image_id.toString()).toBe(next.toString());
    expect(f.previous_image_id.toString()).toBe(cur.toString());
    expect(f.last_edit_prompt).toBe('make it night');
    expect(orphanedImageId).toBe(null);
  });

  it('rotateFrameImageEdit reports the displaced previous image as an orphan', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const cur = new ObjectId();
    const { frameId } = await Storyboards.addFrame(sb._id, { imageId: cur });
    await Storyboards.rotateFrameImageEdit({
      id: sb._id,
      frameId,
      newImageId: new ObjectId(),
      editPrompt: 'a',
    });
    const firstPrev = cur;
    const { orphanedImageId } = await Storyboards.rotateFrameImageEdit({
      id: sb._id,
      frameId,
      newImageId: new ObjectId(),
      editPrompt: 'b',
    });
    expect(String(orphanedImageId)).toBe(String(firstPrev));
  });

  it('rotateFrameImageEdit throws when the frame has no current image', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    await expect(
      Storyboards.rotateFrameImageEdit({
        id: sb._id,
        frameId,
        newImageId: new ObjectId(),
        editPrompt: 'x',
      }),
    ).rejects.toThrow(/no current image/);
  });

  it('undoFrameImageEdit restores the previous image and clears undo state', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const cur = new ObjectId();
    const next = new ObjectId();
    const { frameId } = await Storyboards.addFrame(sb._id, { imageId: cur });
    await Storyboards.rotateFrameImageEdit({
      id: sb._id,
      frameId,
      newImageId: next,
      editPrompt: 'edit',
    });
    const { storyboard, orphanedImageId } = await Storyboards.undoFrameImageEdit({
      id: sb._id,
      frameId,
    });
    const f = storyboard.frames.find((x) => x._id.equals(frameId));
    expect(f.image_id.toString()).toBe(cur.toString());
    expect(f.previous_image_id).toBe(null);
    expect(f.last_edit_prompt).toBe('');
    expect(String(orphanedImageId)).toBe(String(next));
  });

  it('undoFrameImageEdit throws when there is nothing to undo', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, { imageId: new ObjectId() });
    await expect(
      Storyboards.undoFrameImageEdit({ id: sb._id, frameId }),
    ).rejects.toThrow(/nothing to undo/i);
  });
});

describe('per-frame references', () => {
  it('pushFrameReferenceImage and pullFrameReferenceImage manage a frame ref list', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, frameId, r1);
    let out = await Storyboards.pushFrameReferenceImage(sb._id, frameId, r2);
    expect(out.frames[0].reference_ids).toHaveLength(2);
    out = await Storyboards.pullFrameReferenceImage(sb._id, frameId, r1);
    expect(out.frames[0].reference_ids).toHaveLength(1);
    expect(out.frames[0].reference_ids[0].toString()).toBe(r2.toString());
  });

  it('pushFrameReferenceImage is idempotent for duplicate ids', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    const r1 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, frameId, r1);
    const out = await Storyboards.pushFrameReferenceImage(sb._id, frameId, r1);
    expect(out.frames[0].reference_ids).toHaveLength(1);
  });

  it('reference lists are independent per frame', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const f1 = (await Storyboards.addFrame(sb._id, {})).frameId;
    const f2 = (await Storyboards.addFrame(sb._id, {})).frameId;
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, f1, r1);
    const out = await Storyboards.pushFrameReferenceImage(sb._id, f2, r2);
    expect(out.frames[0].reference_ids.map((x) => x.toString())).toEqual([
      r1.toString(),
    ]);
    expect(out.frames[1].reference_ids.map((x) => x.toString())).toEqual([
      r2.toString(),
    ]);
  });

  it('pushFrameReferenceImages appends many ids while deduping', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const r3 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, frameId, r1);
    const out = await Storyboards.pushFrameReferenceImages(sb._id, frameId, [
      r1.toString(),
      r2.toString(),
      r3.toString(),
      r2.toString(),
    ]);
    expect(out.frames[0].reference_ids.map((x) => x.toString())).toEqual([
      r1.toString(),
      r2.toString(),
      r3.toString(),
    ]);
  });

  it('setFrameReferenceImages replaces preserving order and deduping', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const r3 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, frameId, r1);
    await Storyboards.pushFrameReferenceImage(sb._id, frameId, r2);
    const out = await Storyboards.setFrameReferenceImages(sb._id, frameId, [
      r3.toString(),
      r1.toString(),
      r3.toString(),
    ]);
    expect(out.frames[0].reference_ids.map((x) => x.toString())).toEqual([
      r3.toString(),
      r1.toString(),
    ]);
  });

  it('setFrameReferenceImages clears the list when given an empty array', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    await Storyboards.pushFrameReferenceImage(sb._id, frameId, new ObjectId());
    const out = await Storyboards.setFrameReferenceImages(sb._id, frameId, []);
    expect(out.frames[0].reference_ids).toEqual([]);
  });

  it('frame helpers reject an unknown frame id', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.pushFrameReferenceImage(sb._id, new ObjectId(), new ObjectId()),
    ).rejects.toThrow(/frame/i);
  });
});

describe('per-frame prompt', () => {
  it('setFramePrompt round-trips a frame prompt', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    const out = await Storyboards.setFramePrompt(projectId, sb._id, frameId, 'Door swings open.');
    expect(out.frames[0].prompt).toBe('Door swings open.');
  });
});

describe('cleanupBeatImageReferences over frames', () => {
  it('nulls matching frame images and pulls the id from reference lists across the beat', async () => {
    const target = new ObjectId();
    const sb1 = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const sb2 = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const f1 = (await Storyboards.addFrame(sb1._id, { imageId: target })).frameId;
    const f2 = (await Storyboards.addFrame(sb2._id, {})).frameId;
    await Storyboards.pushFrameReferenceImage(sb2._id, f2, target);

    const touched = await Storyboards.cleanupBeatImageReferences(beatA, target);
    expect(touched).toBe(2);

    const r1 = await Storyboards.getStoryboard(projectId, sb1._id);
    const r2 = await Storyboards.getStoryboard(projectId, sb2._id);
    expect(r1.frames.find((f) => f._id.equals(f1)).image_id).toBe(null);
    expect(r2.frames.find((f) => f._id.equals(f2)).reference_ids).toEqual([]);
  });
});

describe('legacy backfill → frames', () => {
  it('synthesizes frames from legacy start/end frame fields', async () => {
    const startImg = new ObjectId();
    const endImg = new ObjectId();
    const ref = new ObjectId();
    const doc = await insertLegacy({
      start_frame_id: startImg,
      start_frame_prompt: 'Wide.',
      start_frame_reference_ids: [ref],
      end_frame_id: endImg,
      end_frame_prompt: 'Close.',
    });
    const sb = await Storyboards.getStoryboard(projectId, doc._id);
    expect(sb.frames).toHaveLength(2);
    expect(sb.frames[0].image_id.toString()).toBe(startImg.toString());
    expect(sb.frames[0].prompt).toBe('Wide.');
    expect(sb.frames[0].reference_ids.map((x) => x.toString())).toEqual([
      ref.toString(),
    ]);
    expect(sb.frames[1].image_id.toString()).toBe(endImg.toString());
    expect(sb.frames[1].prompt).toBe('Close.');
  });

  it('maps an empty legacy doc to an empty frames array', async () => {
    const doc = await insertLegacy({});
    const sb = await Storyboards.getStoryboard(projectId, doc._id);
    expect(sb.frames).toEqual([]);
  });

  it('synthesizes a single frame when only the end frame existed', async () => {
    const endImg = new ObjectId();
    const doc = await insertLegacy({ end_frame_id: endImg });
    const sb = await Storyboards.getStoryboard(projectId, doc._id);
    expect(sb.frames).toHaveLength(1);
    expect(sb.frames[0].image_id.toString()).toBe(endImg.toString());
  });

  it('persists synthesized frames so frame ids are stable across reloads', async () => {
    const startImg = new ObjectId();
    const doc = await insertLegacy({ start_frame_id: startImg });
    const first = await Storyboards.getStoryboard(projectId, doc._id);
    const second = await Storyboards.getStoryboard(projectId, doc._id);
    expect(first.frames[0]._id.toString()).toBe(second.frames[0]._id.toString());
    // The raw doc now carries a frames array.
    const raw = await fakeDb.collection('storyboards').findOne({ _id: doc._id });
    expect(Array.isArray(raw.frames)).toBe(true);
  });
});

describe('storyboard scalar metadata', () => {
  it('seeds new metadata fields as null/[] by default', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    expect(sb.duration_seconds).toBe(null);
    expect(sb.shot_type).toBe(null);
    expect(sb.transition_in).toBe(null);
    expect(sb.characters_in_scene).toEqual([]);
  });

  it('accepts metadata at create time and persists it', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      durationSeconds: 5,
      shotType: 'close_up',
      transitionIn: 'Picks up where #1 left off.',
      charactersInScene: ['Alice'],
    });
    expect(sb.duration_seconds).toBe(5);
    expect(sb.shot_type).toBe('close_up');
    expect(sb.transition_in).toBe('Picks up where #1 left off.');
    expect(sb.characters_in_scene).toEqual(['Alice']);
  });

  it('createStoryboard ignores invalid shot_type silently (planner pre-validates)', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      shotType: 'not_a_real_thing',
    });
    expect(sb.shot_type).toBe(null);
  });

  it('createStoryboard keeps all characters_in_scene (no cap)', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      charactersInScene: ['Alice', 'Bob', 'Carol', 'Dave'],
    });
    expect(sb.characters_in_scene).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('createStoryboard dedupes characters_in_scene case-insensitively', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      charactersInScene: ['Alice', 'alice', '**Alice**', 'Bob'],
    });
    expect(sb.characters_in_scene).toEqual(['Alice', 'Bob']);
  });

  it('createStoryboard strips markdown from character names', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      charactersInScene: ['**Alice**', '_Bob_'],
    });
    expect(sb.characters_in_scene).toEqual(['Alice', 'Bob']);
  });

  it('updateStoryboard accepts a valid shot_type + duration combination', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const updated = await Storyboards.updateStoryboard(projectId, sb._id, {
      shot_type: 'cinematic_wide',
      duration_seconds: 12,
    });
    expect(updated.shot_type).toBe('cinematic_wide');
    expect(updated.duration_seconds).toBe(12);
  });

  it('updateStoryboard clamps duration_seconds to the cap for the new shot_type', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const updated = await Storyboards.updateStoryboard(projectId, sb._id, {
      shot_type: 'close_up',
      duration_seconds: 12,
    });
    expect(updated.shot_type).toBe('close_up');
    expect(updated.duration_seconds).toBe(5);
  });

  it('updateStoryboard clamps duration_seconds against existing shot_type when only duration changes', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      shotType: 'two_shot',
    });
    const updated = await Storyboards.updateStoryboard(projectId, sb._id, {
      duration_seconds: 30,
    });
    expect(updated.duration_seconds).toBe(5);
  });

  it('updateStoryboard rejects an unknown shot_type', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(projectId, sb._id, { shot_type: 'epic_montage' }),
    ).rejects.toThrow(/shot_type must be one of/);
  });

  it('updateStoryboard rejects a non-numeric duration_seconds', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(projectId, sb._id, { duration_seconds: 'lots' }),
    ).rejects.toThrow(/duration_seconds must be/);
  });

  it('updateStoryboard accepts null duration_seconds to clear it', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      durationSeconds: 5,
      shotType: 'close_up',
    });
    const cleared = await Storyboards.updateStoryboard(projectId, sb._id, {
      duration_seconds: null,
    });
    expect(cleared.duration_seconds).toBe(null);
  });

  it('updateStoryboard truncates transition_in to MAX_TRANSITION_LEN', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const longString = 'a'.repeat(500);
    const updated = await Storyboards.updateStoryboard(projectId, sb._id, {
      transition_in: longString,
    });
    expect(updated.transition_in).toHaveLength(Storyboards.MAX_TRANSITION_LEN);
  });

  it('updateStoryboard accepts null transition_in to clear it', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      transitionIn: 'a continuity note',
    });
    const cleared = await Storyboards.updateStoryboard(projectId, sb._id, {
      transition_in: null,
    });
    expect(cleared.transition_in).toBe(null);
  });

  it('updateStoryboard keeps all characters_in_scene and dedupes', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const updated = await Storyboards.updateStoryboard(projectId, sb._id, {
      characters_in_scene: ['Alice', 'Bob', 'Carol', 'Dave', 'alice'],
    });
    expect(updated.characters_in_scene).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('updateStoryboard rejects non-array characters_in_scene', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(projectId, sb._id, { characters_in_scene: 'Alice' }),
    ).rejects.toThrow(/characters_in_scene must be/);
  });

  it('clampDuration helper is idempotent inside the cap and clamps above', () => {
    expect(Storyboards.clampDuration(5, 'close_up')).toBe(5);
    expect(Storyboards.clampDuration(12, 'cinematic_wide')).toBe(12);
    expect(Storyboards.clampDuration(20, 'cinematic_wide')).toBe(15);
    expect(Storyboards.clampDuration(0, 'close_up')).toBe(null);
    expect(Storyboards.clampDuration(-3, 'close_up')).toBe(null);
    expect(Storyboards.clampDuration('not a number', 'close_up')).toBe(null);
  });

  it('durationCapFor falls back to ABSOLUTE_DURATION_CAP for unknown shot_types', () => {
    expect(Storyboards.durationCapFor(null)).toBe(Storyboards.ABSOLUTE_DURATION_CAP);
    expect(Storyboards.durationCapFor('not_a_type')).toBe(
      Storyboards.ABSOLUTE_DURATION_CAP,
    );
  });
});

describe('storyboard summary field', () => {
  it('seeds summary as empty string and accepts it at create time', async () => {
    const empty = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    expect(empty.summary).toBe('');

    const seeded = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      summary: 'Diner exterior, dusk.',
    });
    expect(seeded.summary).toBe('Diner exterior, dusk.');
  });

  it('backfill synthesizes an empty summary on legacy docs', async () => {
    const doc = await insertLegacy({});
    await fakeDb.collection('storyboards').updateOne(
      { _id: doc._id },
      { $unset: { summary: '' } },
    );
    const reloaded = await Storyboards.getStoryboard(projectId, doc._id);
    expect(reloaded.summary).toBe('');
  });

  it('updateStoryboard round-trips the summary field', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const updated = await Storyboards.updateStoryboard(projectId, sb._id, {
      summary: 'A wide shot of the diner at dusk.',
    });
    expect(updated.summary).toBe('A wide shot of the diner at dusk.');
  });
});

describe('multi-project storyboards', () => {
  it('createStoryboard stamps project_id and listing/counting are scoped', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const sb = await Storyboards.createStoryboard({ projectId: p1, beatId: beatA });
    expect(sb.project_id).toBe(p1);
    expect(await Storyboards.listStoryboards({ projectId: p1 })).toHaveLength(1);
    expect(await Storyboards.listStoryboards({ projectId: p2 })).toHaveLength(0);
    expect((await Storyboards.countStoryboardsByBeat(p1)).get(beatA.toString())).toBe(1);
    expect((await Storyboards.countStoryboardsByBeat(p2)).size).toBe(0);
  });

  it('id-addressed helpers verify project after locate — stale id ⇒ not-found', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const sb = await Storyboards.createStoryboard({ projectId: p1, beatId: beatA });
    expect((await Storyboards.getStoryboard(p1, sb._id)).project_id).toBe(p1);
    expect(await Storyboards.getStoryboard(p2, sb._id)).toBe(null);
    await expect(
      Storyboards.updateStoryboard(p2, sb._id, { summary: 'cross-project write' }),
    ).rejects.toThrow(/not found/i);
    expect((await Storyboards.updateStoryboard(p1, sb._id, { summary: 'ok' })).summary).toBe('ok');
    await expect(
      Storyboards.setFramePrompt(p2, sb._id, 'frame-x', 'nope'),
    ).rejects.toThrow(/not found/i);
    expect(
      (await Storyboards.getPreviousStoryboardInBeat(p1, beatA, sb.order + 1))._id.toString(),
    ).toBe(sb._id.toString());
    expect(await Storyboards.getPreviousStoryboardInBeat(p2, beatA, sb.order + 1)).toBe(null);
  });

  it('legacy storyboards without project_id stay reachable from any project', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const legacy = await insertLegacy();
    expect((await Storyboards.getStoryboard(p1, legacy._id))._id.toString()).toBe(
      legacy._id.toString(),
    );
  });

  describe('unverified id-addressed helpers work on non-default-project docs (gating lives at routes/gateway)', () => {
    it('addFrame, reorderFrames, removeFrame and deleteStoryboard succeed when called with bare id on a non-default-project storyboard', async () => {
      // Bootstrap: default project must exist first so resolveProjectId(undefined) works
      // elsewhere; then create a second project that is NOT the default.
      await Projects.getDefaultProject();
      const pOther = (await Projects.createProject('Other'))._id.toString();

      // Create a storyboard in the non-default project.
      const sb = await Storyboards.createStoryboard({ projectId: pOther, beatId: beatA });
      expect(sb.project_id).toBe(pOther);

      // addFrame — bare id (no projectId), valid args per exported signature.
      const { storyboard: afterAdd, frameId } = await Storyboards.addFrame(sb._id, {
        prompt: 'Wide on the doorway.',
      });
      expect(afterAdd.frames).toHaveLength(1);
      expect(afterAdd.frames[0].prompt).toBe('Wide on the doorway.');

      // Add a second frame so reorderFrames has two ids to work with.
      const { frameId: frameId2 } = await Storyboards.addFrame(sb._id, { prompt: 'Close on the handle.' });

      // reorderFrames — bare id, must succeed and re-order correctly.
      const reordered = await Storyboards.reorderFrames(sb._id, [
        frameId2.toString(),
        frameId.toString(),
      ]);
      expect(reordered.frames.map((f) => f.prompt)).toEqual([
        'Close on the handle.',
        'Wide on the doorway.',
      ]);

      // removeFrame — bare id, must succeed.
      const { storyboard: afterRemove } = await Storyboards.removeFrame(sb._id, frameId);
      expect(afterRemove.frames).toHaveLength(1);
      expect(afterRemove.frames[0].prompt).toBe('Close on the handle.');

      // deleteStoryboard — bare id, must succeed and leave no doc.
      await Storyboards.deleteStoryboard(sb._id);
      expect(await Storyboards.getStoryboard(pOther, sb._id)).toBe(null);
    });
  });
});
