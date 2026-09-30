// Unit tests for the `video_scenes` collection helpers (Prompts tab scenes).

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

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VS = await import('../src/mongo/videoScenes.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Scenes Test'))._id.toString();
});

async function makeBeat(name = 'Diner') {
  return Plots.createBeat({ projectId, name, desc: '', body: '' });
}

describe('video_scenes normalizers', () => {
  it('normalizeDirectorsRead fills every field and drops unknown keys', () => {
    const read = VS.normalizeDirectorsRead({ turn: ' waiting to leaving ', bogus: 'x', pov: 7 });
    expect(Object.keys(read)).toEqual([...VS.DIRECTORS_READ_FIELDS]);
    expect(read.turn).toBe('waiting to leaving');
    expect(read.pov).toBe('7');
    expect(read.hidden_want).toBe('');
    expect(read.bogus).toBeUndefined();
    expect(VS.normalizeDirectorsRead(null).dramatic_function).toBe('');
  });

  it('normalizeScope fills every bucket with string arrays', () => {
    const scope = VS.normalizeScope({ already_happened: ['Tom got wet', 3, ''], nope: ['x'] });
    expect(Object.keys(scope)).toEqual([...VS.SCOPE_BUCKETS]);
    expect(scope.already_happened).toEqual(['Tom got wet', '3']);
    expect(scope.do_not_show_yet).toEqual([]);
    expect(VS.normalizeScope('junk').reserved_for_later).toEqual([]);
  });

  it('normalizeTextSpan and normalizeLoad coerce shapes', () => {
    expect(VS.normalizeTextSpan({ starts_with: ' INT. ', ends_with: null })).toEqual({
      starts_with: 'INT.',
      ends_with: '',
    });
    expect(VS.normalizeLoad({ beats: '5', load_points: 2, total_seconds: 15, s: 2.1, verdict: 'Stretch' })).toEqual({
      beats: 5,
      load_points: 2,
      total_seconds: 15,
      s: 2.1,
      verdict: 'stretch',
    });
    expect(VS.normalizeLoad({ verdict: 'wild', s: 'nan' })).toEqual({
      beats: null,
      load_points: null,
      total_seconds: null,
      s: null,
      verdict: null,
    });
  });
});

describe('video_scenes collection', () => {
  it('createVideoScene appends with contiguous order, stamps project_id and normalizes fields', async () => {
    const beat = await makeBeat();
    const dialogId = new ObjectId();
    const a = await VS.createVideoScene({
      projectId,
      beatId: beat._id,
      title: 'Sarah waits',
      slug: 'INT. DINER — NIGHT',
      setNames: ['Diner', ''],
      characterNames: ['Sarah', 'Tom'],
      textSpan: { starts_with: 'Sarah waits', ends_with: 'she leaves.' },
      directorsRead: { turn: 'waiting to leaving' },
      intention: 'Make the audience feel her certainty crack.',
      scope: { reserved_for_later: ['the phone call'] },
      floorPlan: 'A night diner, the door at the far end.',
      dialogIds: [dialogId, dialogId, 'nope'],
      load: { beats: 5, load_points: 2, total_seconds: 15, s: 2.1, verdict: 'stretch' },
    });
    const b = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Tom arrives' });
    expect(a.order).toBe(1);
    expect(b.order).toBe(2);
    expect(a.project_id).toBe(projectId);
    expect(a.set_names).toEqual(['Diner']);
    expect(a.directors_read.turn).toBe('waiting to leaving');
    expect(a.directors_read.pov).toBe('');
    expect(a.scope.reserved_for_later).toEqual(['the phone call']);
    expect(a.scope.already_happened).toEqual([]);
    expect(a.dialog_ids.map(String)).toEqual([dialogId.toString()]);
    expect(a.load.verdict).toBe('stretch');
    expect(b.floor_plan).toBe('');
    expect(b.load).toEqual({ beats: null, load_points: null, total_seconds: null, s: null, verdict: null });
    const list = await VS.listVideoScenes({ projectId, beatId: beat._id });
    expect(list.map((s) => s.title)).toEqual(['Sarah waits', 'Tom arrives']);
    await expect(VS.createVideoScene({ projectId })).rejects.toThrow(/beatId required/);
  });

  it('updateVideoScene whitelists fields and normalizes', async () => {
    const beat = await makeBeat();
    const s = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'A' });
    const updated = await VS.updateVideoScene(projectId, s._id, {
      title: ' B ',
      floor_plan: 'Counter along the right wall.',
      directors_read: { pov: 'hers' },
      scope: { do_not_show_yet: ['the exit'] },
      load: { verdict: 'safe', s: 3.2 },
      set_names: ['Diner'],
    });
    expect(updated.title).toBe('B');
    expect(updated.floor_plan).toBe('Counter along the right wall.');
    expect(updated.directors_read.pov).toBe('hers');
    expect(updated.scope.do_not_show_yet).toEqual(['the exit']);
    expect(updated.load.verdict).toBe('safe');
    expect(updated.set_names).toEqual(['Diner']);
    await expect(VS.updateVideoScene(projectId, s._id, { bogus: 1 })).rejects.toThrow(/unknown field/);
    await expect(VS.updateVideoScene(projectId, s._id, { order: 'x' })).rejects.toThrow(/order must be/);
    await expect(VS.updateVideoScene(projectId, s._id, {})).rejects.toThrow(/no changes/);
  });

  it('getVideoScene verifies the project — a cross-project id behaves as not-found', async () => {
    const beat = await makeBeat();
    const s = await VS.createVideoScene({ projectId, beatId: beat._id });
    const other = (await createProject('Other'))._id.toString();
    expect(await VS.getVideoScene(projectId, s._id)).not.toBeNull();
    expect(await VS.getVideoScene(other, s._id)).toBeNull();
    expect(await VS.getVideoScene(projectId, 'not-an-id')).toBeNull();
    await expect(VS.updateVideoScene(other, s._id, { title: 'x' })).rejects.toThrow(/not found/);
  });

  it('reorderVideoScenesForBeat requires the full id set with no duplicates', async () => {
    const beat = await makeBeat();
    const a = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'A' });
    const b = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'B' });
    const c = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'C' });
    const after = await VS.reorderVideoScenesForBeat(beat._id, [c._id, a._id, b._id]);
    expect(after.map((s) => s.title)).toEqual(['C', 'A', 'B']);
    expect(after.map((s) => s.order)).toEqual([1, 2, 3]);
    await expect(VS.reorderVideoScenesForBeat(beat._id, [a._id, b._id])).rejects.toThrow(/length/);
    await expect(VS.reorderVideoScenesForBeat(beat._id, [a._id, a._id, b._id])).rejects.toThrow(/duplicate/);
    await expect(
      VS.reorderVideoScenesForBeat(beat._id, [a._id, b._id, new ObjectId()]),
    ).rejects.toThrow(/not in this beat/);
  });

  it('deleteVideoScene / deleteVideoScenesForBeat / countVideoScenesByBeat', async () => {
    const beatA = await makeBeat('A');
    const beatB = await makeBeat('B');
    const s1 = await VS.createVideoScene({ projectId, beatId: beatA._id });
    await VS.createVideoScene({ projectId, beatId: beatB._id });
    await VS.createVideoScene({ projectId, beatId: beatB._id });
    const counts = await VS.countVideoScenesByBeat(projectId);
    expect(counts.get(beatA._id.toString())).toBe(1);
    expect(counts.get(beatB._id.toString())).toBe(2);
    const gone = await VS.deleteVideoScene(s1._id);
    expect(gone._id.toString()).toBe(s1._id.toString());
    expect(await VS.listVideoScenes({ projectId, beatId: beatA._id })).toHaveLength(0);
    await expect(VS.deleteVideoScene(s1._id)).rejects.toThrow(/not found/);
    const removed = await VS.deleteVideoScenesForBeat(beatB._id);
    expect(removed).toHaveLength(2);
    expect(await VS.listVideoScenes({ projectId, beatId: beatB._id })).toHaveLength(0);
  });

  it('listVideoScenes without a beat lists the project only', async () => {
    const beat = await makeBeat();
    await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Mine' });
    const other = (await createProject('Other'))._id.toString();
    const otherBeat = await Plots.createBeat({ projectId: other, name: 'X', desc: '', body: '' });
    await VS.createVideoScene({ projectId: other, beatId: otherBeat._id, title: 'Theirs' });
    const mine = await VS.listVideoScenes({ projectId });
    expect(mine.map((s) => s.title)).toEqual(['Mine']);
    await expect(VS.listVideoScenes({})).rejects.toThrow();
  });
});
