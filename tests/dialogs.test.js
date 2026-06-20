import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Projects = await import('../src/mongo/projects.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

const beatA = new ObjectId();
const beatB = new ObjectId();

describe('dialogs mongo helpers', () => {
  it('creates a dialog with auto-incrementing order per beat', async () => {
    const a1 = await Dialogs.createDialog({ projectId, beatId: beatA });
    const a2 = await Dialogs.createDialog({ projectId, beatId: beatA });
    const b1 = await Dialogs.createDialog({ projectId, beatId: beatB });
    expect(a1.order).toBe(1);
    expect(a2.order).toBe(2);
    expect(b1.order).toBe(1);
    expect(a1.beat_id.toString()).toBe(beatA.toString());
  });

  it('seeds defaults: empty body, empty character', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    expect(d.body).toBe('');
    expect(d.character).toBe('');
  });

  it('createDialog accepts initial body and character', async () => {
    const d = await Dialogs.createDialog({ projectId,
      beatId: beatA,
      body: 'I see you.',
      character: 'Alice',
    });
    expect(d.body).toBe('I see you.');
    expect(d.character).toBe('Alice');
  });

  it('listDialogs filters by beat and sorts by order', async () => {
    const a1 = await Dialogs.createDialog({ projectId, beatId: beatA });
    const a2 = await Dialogs.createDialog({ projectId, beatId: beatA });
    await Dialogs.createDialog({ projectId, beatId: beatB });
    const list = await Dialogs.listDialogs({ beatId: beatA });
    expect(list).toHaveLength(2);
    expect(list[0]._id.toString()).toBe(a1._id.toString());
    expect(list[1]._id.toString()).toBe(a2._id.toString());
  });

  it('countDialogsByBeat returns a Map keyed by beat hex id', async () => {
    await Dialogs.createDialog({ projectId, beatId: beatA });
    await Dialogs.createDialog({ projectId, beatId: beatA });
    await Dialogs.createDialog({ projectId, beatId: beatB });
    const counts = await Dialogs.countDialogsByBeat(projectId);
    expect(counts.get(beatA.toString())).toBe(2);
    expect(counts.get(beatB.toString())).toBe(1);
  });

  it('updateDialog accepts body and character fields', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    const updated = await Dialogs.updateDialog(projectId, d._id, {
      body: "Don't go in there.",
      character: 'Bob',
    });
    expect(updated.body).toBe("Don't go in there.");
    expect(updated.character).toBe('Bob');
  });

  it('updateDialog rejects unknown fields', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    await expect(
      Dialogs.updateDialog(projectId, d._id, { random_field: 'nope' }),
    ).rejects.toThrow(/unknown field/);
  });

  it('createDialog defaults direction to an empty string', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    expect(d.direction).toBe('');
  });

  it('updateDialog accepts the direction field (the voice-actor note)', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    const updated = await Dialogs.updateDialog(projectId, d._id, {
      direction: 'Mid-argument. He is cornered — play it quiet, not shouting.',
    });
    expect(updated.direction).toBe(
      'Mid-argument. He is cornered — play it quiet, not shouting.',
    );
  });

  it('listDialogs backfills direction for legacy docs missing the field', async () => {
    fakeDb.collection('dialogs')._docs.push({
      _id: new ObjectId(),
      beat_id: beatA,
      order: 1,
      body: 'old line',
      character: 'Old Speaker',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const [legacy] = await Dialogs.listDialogs({ beatId: beatA });
    expect(legacy.direction).toBe('');
  });

  it('createDialog defaults audio_file_id to null', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    expect(d.audio_file_id).toBe(null);
  });

  it('updateDialog accepts audio_file_id as a 24-hex string', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    const fileId = new ObjectId();
    const updated = await Dialogs.updateDialog(projectId, d._id, {
      audio_file_id: fileId.toString(),
    });
    expect(updated.audio_file_id.toString()).toBe(fileId.toString());
  });

  it('updateDialog clears audio_file_id when set to null', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    const fileId = new ObjectId();
    await Dialogs.updateDialog(projectId, d._id, { audio_file_id: fileId.toString() });
    const cleared = await Dialogs.updateDialog(projectId, d._id, { audio_file_id: null });
    expect(cleared.audio_file_id).toBe(null);
  });

  it('updateDialog rejects non-hex audio_file_id', async () => {
    const d = await Dialogs.createDialog({ projectId, beatId: beatA });
    await expect(
      Dialogs.updateDialog(projectId, d._id, { audio_file_id: 'not-an-id' }),
    ).rejects.toThrow(/invalid file id/);
  });

  it('listDialogs backfills audio_file_id for legacy docs missing the field', async () => {
    // Simulate a pre-migration doc inserted before audio_file_id existed.
    fakeDb.collection('dialogs')._docs.push({
      _id: new ObjectId(),
      beat_id: beatA,
      order: 1,
      body: 'old line',
      character: 'Old Speaker',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const [legacy] = await Dialogs.listDialogs({ beatId: beatA });
    expect(legacy.audio_file_id).toBe(null);
  });

  it('reorderDialogsForBeat rewrites the order field', async () => {
    const a = await Dialogs.createDialog({ projectId, beatId: beatA });
    const b = await Dialogs.createDialog({ projectId, beatId: beatA });
    const c = await Dialogs.createDialog({ projectId, beatId: beatA });
    expect(a.order).toBe(1);
    const reordered = await Dialogs.reorderDialogsForBeat(beatA, [
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

  it('reorderDialogsForBeat rejects mismatched length', async () => {
    await Dialogs.createDialog({ projectId, beatId: beatA });
    await Dialogs.createDialog({ projectId, beatId: beatA });
    await expect(
      Dialogs.reorderDialogsForBeat(beatA, [new ObjectId().toString()]),
    ).rejects.toThrow(/length/);
  });

  it('deleteDialog removes a single dialog', async () => {
    const a = await Dialogs.createDialog({ projectId, beatId: beatA });
    const b = await Dialogs.createDialog({ projectId, beatId: beatA });
    await Dialogs.deleteDialog(a._id);
    const list = await Dialogs.listDialogs({ beatId: beatA });
    expect(list).toHaveLength(1);
    expect(list[0]._id.toString()).toBe(b._id.toString());
  });

  it('deleteDialogsForBeat clears all dialogs for that beat only', async () => {
    await Dialogs.createDialog({ projectId, beatId: beatA });
    await Dialogs.createDialog({ projectId, beatId: beatA });
    await Dialogs.createDialog({ projectId, beatId: beatB });
    await Dialogs.deleteDialogsForBeat(beatA);
    const a = await Dialogs.listDialogs({ beatId: beatA });
    const b = await Dialogs.listDialogs({ beatId: beatB });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});

describe('multi-project dialogs', () => {
  it('createDialog stamps project_id and listing/counting are scoped', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const d = await Dialogs.createDialog({ projectId: p1, beatId: beatA });
    expect(d.project_id).toBe(p1);
    expect(await Dialogs.listDialogs({ projectId: p1 })).toHaveLength(1);
    expect(await Dialogs.listDialogs({ projectId: p2 })).toHaveLength(0);
    expect((await Dialogs.countDialogsByBeat(p1)).get(beatA.toString())).toBe(1);
    expect((await Dialogs.countDialogsByBeat(p2)).size).toBe(0);
  });

  it('getDialog/updateDialog verify project after locate — stale id ⇒ not-found', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const d = await Dialogs.createDialog({ projectId: p1, beatId: beatA, body: 'hi' });
    expect((await Dialogs.getDialog(p1, d._id)).body).toBe('hi');
    expect(await Dialogs.getDialog(p2, d._id)).toBe(null);
    await expect(Dialogs.updateDialog(p2, d._id, { body: 'x' })).rejects.toThrow(/not found/i);
    expect((await Dialogs.updateDialog(p1, d._id, { body: 'edited' })).body).toBe('edited');
  });

  describe('unverified id-addressed helpers work on non-default-project docs (gating lives at routes/gateway)', () => {
    it('deleteDialog succeeds when called with bare id on a non-default-project dialog', async () => {
      // Bootstrap: default project must exist first so resolveProjectId(undefined) works
      // elsewhere; then create a second project that is NOT the default.
      await Projects.getDefaultProject();
      const pOther = (await Projects.createProject('Other'))._id.toString();

      // Create a dialog in the non-default project.
      const d = await Dialogs.createDialog({ projectId: pOther, beatId: beatA, body: 'A line.' });
      expect(d.project_id).toBe(pOther);

      // deleteDialog — bare id (no projectId), must succeed and leave no doc.
      await Dialogs.deleteDialog(d._id);
      expect(await Dialogs.getDialog(pOther, d._id)).toBe(null);
    });
  });
});
