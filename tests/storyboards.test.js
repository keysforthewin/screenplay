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
    expect(sb.start_frame_prompt).toBe('');
    expect(sb.start_frame_reference_ids).toEqual([]);
    expect(sb.end_frame_id).toBe(null);
    expect(sb.end_frame_prompt).toBe('');
    expect(sb.end_frame_reference_ids).toEqual([]);
    expect(sb.audio_file_id).toBe(null);
  });

  it('does not carry the removed character_sheet_image_id or reference_image_ids fields', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    expect(sb.character_sheet_image_id).toBeUndefined();
    expect(sb.reference_image_ids).toBeUndefined();
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

  it.each(['start_frame', 'end_frame'])(
    'pushFrameReferenceImage and pullFrameReferenceImage manage %s refs',
    async (role) => {
      const field =
        role === 'start_frame'
          ? 'start_frame_reference_ids'
          : 'end_frame_reference_ids';
      const sb = await Storyboards.createStoryboard({ beatId: beatA });
      const r1 = new ObjectId();
      const r2 = new ObjectId();
      let next = await Storyboards.pushFrameReferenceImage(sb._id, role, r1);
      next = await Storyboards.pushFrameReferenceImage(sb._id, role, r2);
      expect(next[field]).toHaveLength(2);
      next = await Storyboards.pullFrameReferenceImage(sb._id, role, r1);
      expect(next[field]).toHaveLength(1);
      expect(next[field][0].toString()).toBe(r2.toString());
    },
  );

  it('pushFrameReferenceImage is idempotent for duplicate ids', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const r1 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, 'start_frame', r1);
    const next = await Storyboards.pushFrameReferenceImage(sb._id, 'start_frame', r1);
    expect(next.start_frame_reference_ids).toHaveLength(1);
  });

  it('start_frame refs and end_frame refs are independent', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, 'start_frame', r1);
    const after = await Storyboards.pushFrameReferenceImage(sb._id, 'end_frame', r2);
    expect(after.start_frame_reference_ids.map((x) => x.toString())).toEqual([
      r1.toString(),
    ]);
    expect(after.end_frame_reference_ids.map((x) => x.toString())).toEqual([
      r2.toString(),
    ]);
  });

  it('pushFrameReferenceImages appends many ids while deduping vs existing', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const r3 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, 'start_frame', r1);
    const next = await Storyboards.pushFrameReferenceImages(sb._id, 'start_frame', [
      r1.toString(),
      r2.toString(),
      r3.toString(),
      r2.toString(),
    ]);
    const ids = next.start_frame_reference_ids.map((x) => x.toString());
    expect(ids).toEqual([r1.toString(), r2.toString(), r3.toString()]);
  });

  it('setFrameReferenceImages replaces the list, preserving order and deduping', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const r3 = new ObjectId();
    await Storyboards.pushFrameReferenceImage(sb._id, 'end_frame', r1);
    await Storyboards.pushFrameReferenceImage(sb._id, 'end_frame', r2);
    const next = await Storyboards.setFrameReferenceImages(sb._id, 'end_frame', [
      r3.toString(),
      r1.toString(),
      r3.toString(),
    ]);
    expect(next.end_frame_reference_ids.map((x) => x.toString())).toEqual([
      r3.toString(),
      r1.toString(),
    ]);
  });

  it('setFrameReferenceImages clears the list when given an empty array', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    await Storyboards.pushFrameReferenceImage(sb._id, 'start_frame', new ObjectId());
    const next = await Storyboards.setFrameReferenceImages(sb._id, 'start_frame', []);
    expect(next.start_frame_reference_ids).toEqual([]);
  });

  it('frame ref helpers reject unknown roles', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    await expect(
      Storyboards.pushFrameReferenceImage(sb._id, 'character_sheet', new ObjectId()),
    ).rejects.toThrow(/invalid frame role/);
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

describe('storyboard scalar metadata', () => {
  it('seeds new metadata fields as null/[] by default', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    expect(sb.duration_seconds).toBe(null);
    expect(sb.shot_type).toBe(null);
    expect(sb.transition_in).toBe(null);
    expect(sb.characters_in_scene).toEqual([]);
  });

  it('accepts metadata at create time and persists it', async () => {
    const sb = await Storyboards.createStoryboard({
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
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      shotType: 'not_a_real_thing',
    });
    expect(sb.shot_type).toBe(null);
  });

  it('createStoryboard trims characters_in_scene at MAX_CHARS_PER_SHOT', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      charactersInScene: ['Alice', 'Bob', 'Carol', 'Dave'],
    });
    expect(sb.characters_in_scene).toEqual(['Alice', 'Bob']);
  });

  it('createStoryboard strips markdown from character names', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      charactersInScene: ['**Alice**', '_Bob_'],
    });
    expect(sb.characters_in_scene).toEqual(['Alice', 'Bob']);
  });

  it('updateStoryboard accepts a valid shot_type + duration combination', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const updated = await Storyboards.updateStoryboard(sb._id, {
      shot_type: 'cinematic_wide',
      duration_seconds: 12,
    });
    expect(updated.shot_type).toBe('cinematic_wide');
    expect(updated.duration_seconds).toBe(12);
  });

  it('updateStoryboard clamps duration_seconds to the cap for the new shot_type', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const updated = await Storyboards.updateStoryboard(sb._id, {
      shot_type: 'close_up',
      duration_seconds: 12,
    });
    expect(updated.shot_type).toBe('close_up');
    // close_up cap is 5
    expect(updated.duration_seconds).toBe(5);
  });

  it('updateStoryboard clamps duration_seconds against existing shot_type when only duration changes', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      shotType: 'two_shot',
    });
    const updated = await Storyboards.updateStoryboard(sb._id, {
      duration_seconds: 30,
    });
    // two_shot cap is 5
    expect(updated.duration_seconds).toBe(5);
  });

  it('updateStoryboard rejects an unknown shot_type', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(sb._id, { shot_type: 'epic_montage' }),
    ).rejects.toThrow(/shot_type must be one of/);
  });

  it('updateStoryboard rejects a non-numeric duration_seconds', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(sb._id, { duration_seconds: 'lots' }),
    ).rejects.toThrow(/duration_seconds must be/);
  });

  it('updateStoryboard accepts null duration_seconds to clear it', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      durationSeconds: 5,
      shotType: 'close_up',
    });
    const cleared = await Storyboards.updateStoryboard(sb._id, {
      duration_seconds: null,
    });
    expect(cleared.duration_seconds).toBe(null);
  });

  it('updateStoryboard truncates transition_in to MAX_TRANSITION_LEN', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const longString = 'a'.repeat(500);
    const updated = await Storyboards.updateStoryboard(sb._id, {
      transition_in: longString,
    });
    expect(updated.transition_in).toHaveLength(Storyboards.MAX_TRANSITION_LEN);
  });

  it('updateStoryboard accepts null transition_in to clear it', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      transitionIn: 'a continuity note',
    });
    const cleared = await Storyboards.updateStoryboard(sb._id, {
      transition_in: null,
    });
    expect(cleared.transition_in).toBe(null);
  });

  it('updateStoryboard trims and dedups characters_in_scene', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const updated = await Storyboards.updateStoryboard(sb._id, {
      characters_in_scene: ['Alice', 'Bob', 'Carol', 'Dave'],
    });
    expect(updated.characters_in_scene).toEqual(['Alice', 'Bob']);
  });

  it('updateStoryboard rejects non-array characters_in_scene', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    await expect(
      Storyboards.updateStoryboard(sb._id, { characters_in_scene: 'Alice' }),
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

describe('storyboard frame prompts', () => {
  it('seeds start_frame_prompt and end_frame_prompt as empty strings', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    expect(sb.start_frame_prompt).toBe('');
    expect(sb.end_frame_prompt).toBe('');
  });

  it('updateStoryboard round-trips frame prompt fields', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const updated = await Storyboards.updateStoryboard(sb._id, {
      start_frame_prompt: 'Wide on the diner doorway.',
      end_frame_prompt: 'Door swings open; light spills out.',
    });
    expect(updated.start_frame_prompt).toBe('Wide on the diner doorway.');
    expect(updated.end_frame_prompt).toBe('Door swings open; light spills out.');
  });

  it('backfill synthesizes empty frame prompts on legacy docs', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    await fakeDb.collection('storyboards').updateOne(
      { _id: sb._id },
      { $unset: { start_frame_prompt: '', end_frame_prompt: '' } },
    );
    const reloaded = await Storyboards.getStoryboard(sb._id);
    expect(reloaded.start_frame_prompt).toBe('');
    expect(reloaded.end_frame_prompt).toBe('');
  });
});

describe('storyboard summary field', () => {
  it('seeds summary as empty string and accepts it at create time', async () => {
    const empty = await Storyboards.createStoryboard({ beatId: beatA });
    expect(empty.summary).toBe('');

    const seeded = await Storyboards.createStoryboard({
      beatId: beatA,
      summary: 'Diner exterior, dusk.',
    });
    expect(seeded.summary).toBe('Diner exterior, dusk.');
  });

  it('backfill synthesizes an empty summary on legacy docs', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    // Simulate a legacy doc that pre-dates the summary field.
    await fakeDb.collection('storyboards').updateOne(
      { _id: sb._id },
      { $unset: { summary: '' } },
    );
    const reloaded = await Storyboards.getStoryboard(sb._id);
    expect(reloaded.summary).toBe('');
  });

  it('updateStoryboard round-trips the summary field', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const updated = await Storyboards.updateStoryboard(sb._id, {
      summary: 'A wide shot of the diner at dusk.',
    });
    expect(updated.summary).toBe('A wide shot of the diner at dusk.');
  });
});
