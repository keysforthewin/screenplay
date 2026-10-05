// Unit tests for the `video_scenes` collection helpers (Scenes tab scenes).

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

describe('video_scenes collection', () => {
  it('createVideoScene appends with contiguous order, stamps project_id and stores only the scene shape', async () => {
    const beat = await makeBeat();
    const id = new ObjectId();
    const a = await VS.createVideoScene({
      id,
      projectId,
      beatId: beat._id,
      title: 'Sarah waits',
      // Fields of the retired planner are not part of a scene any more.
      slug: 'INT. DINER — NIGHT',
      floorPlan: 'A night diner, the door at the far end.',
      directorsRead: { turn: 'waiting to leaving' },
    });
    const b = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Tom arrives' });
    expect(a._id.toString()).toBe(id.toString());
    expect(a.order).toBe(1);
    expect(b.order).toBe(2);
    expect(a.project_id).toBe(projectId);
    expect(Object.keys(a).sort()).toEqual(['_id', 'beat_id', 'created_at', 'order', 'project_id', 'title', 'updated_at']);
    expect(Object.keys(fakeDb.collection('video_scenes')._docs[0]).sort()).toEqual(Object.keys(a).sort());
    expect((await VS.createVideoScene({ projectId, beatId: beat._id })).title).toBe('');
    const explicit = await VS.createVideoScene({ projectId, beatId: beat._id, order: 9, title: 'Late' });
    expect(explicit.order).toBe(9);
    const list = await VS.listVideoScenes({ projectId, beatId: beat._id });
    expect(list.map((s) => s.title)).toEqual(['Sarah waits', 'Tom arrives', '', 'Late']);
    await expect(VS.createVideoScene({ projectId })).rejects.toThrow(/beatId required/);
  });

  it('updateVideoScene accepts only title and order', async () => {
    const beat = await makeBeat();
    const s = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'A' });
    // The title is stored exactly as the y-doc fragment renders it.
    const updated = await VS.updateVideoScene(projectId, s._id, { title: ' B ', order: '3' });
    expect(updated.title).toBe(' B ');
    expect(updated.order).toBe(3);
    for (const gone of ['floor_plan', 'directors_read', 'scope', 'load', 'set_names', 'slug', 'tempo', 'kind']) {
      await expect(VS.updateVideoScene(projectId, s._id, { [gone]: 'x' })).rejects.toThrow(/unknown field/);
    }
    await expect(VS.updateVideoScene(projectId, s._id, { bogus: 1 })).rejects.toThrow(/unknown field/);
    await expect(VS.updateVideoScene(projectId, s._id, { order: 'x' })).rejects.toThrow(/order must be/);
    await expect(VS.updateVideoScene(projectId, s._id, {})).rejects.toThrow(/no changes/);
    await expect(VS.updateVideoScene(projectId, s._id, null)).rejects.toThrow(/must be an object/);
  });

  it('the planner-era exports are gone', () => {
    for (const name of [
      'normalizeDirectorsRead',
      'normalizeScope',
      'normalizeTextSpan',
      'normalizeLoad',
      'setVideoSceneVideo',
      'countVideoScenesByBeat',
    ]) {
      expect(VS[name]).toBeUndefined();
    }
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

  it('deleteVideoScene / deleteVideoScenesForBeat', async () => {
    const beatA = await makeBeat('A');
    const beatB = await makeBeat('B');
    const s1 = await VS.createVideoScene({ projectId, beatId: beatA._id });
    await VS.createVideoScene({ projectId, beatId: beatB._id });
    await VS.createVideoScene({ projectId, beatId: beatB._id });
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
