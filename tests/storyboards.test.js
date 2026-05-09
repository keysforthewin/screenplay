import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Storyboards = await import('../src/mongo/storyboards.js');

beforeEach(() => {
  fakeDb.reset();
});

const beatA = new ObjectId();
const beatB = new ObjectId();

describe('storyboards mongo helpers', () => {
  it('creates a storyboard with auto-incrementing order per beat', async () => {
    const a1 = await Storyboards.createStoryboard({ beatId: beatA });
    const a2 = await Storyboards.createStoryboard({ beatId: beatA });
    const b1 = await Storyboards.createStoryboard({ beatId: beatB });
    expect(a1.order).toBe(1);
    expect(a2.order).toBe(2);
    expect(b1.order).toBe(1);
    expect(a1.beat_id.toString()).toBe(beatA.toString());
  });

  it('seeds defaults: empty text, no images, no audio', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    expect(sb.text_prompt).toBe('');
    expect(sb.start_frame_id).toBe(null);
    expect(sb.end_frame_id).toBe(null);
    expect(sb.character_sheet_image_id).toBe(null);
    expect(sb.reference_image_ids).toEqual([]);
    expect(sb.audio_file_id).toBe(null);
  });

  it('listStoryboards filters by beat and sorts by order', async () => {
    const a1 = await Storyboards.createStoryboard({ beatId: beatA });
    const a2 = await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.createStoryboard({ beatId: beatB });
    const list = await Storyboards.listStoryboards({ beatId: beatA });
    expect(list).toHaveLength(2);
    expect(list[0]._id.toString()).toBe(a1._id.toString());
    expect(list[1]._id.toString()).toBe(a2._id.toString());
  });

  it('countStoryboardsByBeat returns a Map keyed by beat hex id', async () => {
    await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.createStoryboard({ beatId: beatB });
    const counts = await Storyboards.countStoryboardsByBeat();
    expect(counts.get(beatA.toString())).toBe(2);
    expect(counts.get(beatB.toString())).toBe(1);
  });

  it('updateStoryboard accepts text_prompt and image role fields', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const imgId = new ObjectId();
    const updated = await Storyboards.updateStoryboard(sb._id, {
      text_prompt: 'A wide shot of the diner at dusk.',
      start_frame_id: imgId.toString(),
    });
    expect(updated.text_prompt).toBe('A wide shot of the diner at dusk.');
    expect(updated.start_frame_id.toString()).toBe(imgId.toString());
  });

  it('updateStoryboard rejects unknown fields', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(sb._id, { random_field: 'nope' }),
    ).rejects.toThrow(/unknown field/);
  });

  it('updateStoryboard accepts null to clear an image role', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const imgId = new ObjectId();
    await Storyboards.updateStoryboard(sb._id, { end_frame_id: imgId });
    const cleared = await Storyboards.updateStoryboard(sb._id, {
      end_frame_id: null,
    });
    expect(cleared.end_frame_id).toBe(null);
  });

  it('pushReferenceImage and pullReferenceImage manage the array', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    let next = await Storyboards.pushReferenceImage(sb._id, r1);
    next = await Storyboards.pushReferenceImage(sb._id, r2);
    expect(next.reference_image_ids).toHaveLength(2);
    next = await Storyboards.pullReferenceImage(sb._id, r1);
    expect(next.reference_image_ids).toHaveLength(1);
    expect(next.reference_image_ids[0].toString()).toBe(r2.toString());
  });

  it('pushReferenceImage is idempotent for duplicate ids', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const r1 = new ObjectId();
    await Storyboards.pushReferenceImage(sb._id, r1);
    const next = await Storyboards.pushReferenceImage(sb._id, r1);
    expect(next.reference_image_ids).toHaveLength(1);
  });

  it('reorderStoryboardsForBeat rewrites the order field', async () => {
    const a = await Storyboards.createStoryboard({ beatId: beatA });
    const b = await Storyboards.createStoryboard({ beatId: beatA });
    const c = await Storyboards.createStoryboard({ beatId: beatA });
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
    await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.createStoryboard({ beatId: beatA });
    await expect(
      Storyboards.reorderStoryboardsForBeat(beatA, [new ObjectId().toString()]),
    ).rejects.toThrow(/length/);
  });

  it('deleteStoryboard removes a single storyboard', async () => {
    const a = await Storyboards.createStoryboard({ beatId: beatA });
    const b = await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.deleteStoryboard(a._id);
    const list = await Storyboards.listStoryboards({ beatId: beatA });
    expect(list).toHaveLength(1);
    expect(list[0]._id.toString()).toBe(b._id.toString());
  });

  it('deleteStoryboardsForBeat clears all storyboards for that beat', async () => {
    await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.createStoryboard({ beatId: beatB });
    await Storyboards.deleteStoryboardsForBeat(beatA);
    const a = await Storyboards.listStoryboards({ beatId: beatA });
    const b = await Storyboards.listStoryboards({ beatId: beatB });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});
