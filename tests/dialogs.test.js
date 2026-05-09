import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Dialogs = await import('../src/mongo/dialogs.js');

beforeEach(() => {
  fakeDb.reset();
});

const beatA = new ObjectId();
const beatB = new ObjectId();

describe('dialogs mongo helpers', () => {
  it('creates a dialog with auto-incrementing order per beat', async () => {
    const a1 = await Dialogs.createDialog({ beatId: beatA });
    const a2 = await Dialogs.createDialog({ beatId: beatA });
    const b1 = await Dialogs.createDialog({ beatId: beatB });
    expect(a1.order).toBe(1);
    expect(a2.order).toBe(2);
    expect(b1.order).toBe(1);
    expect(a1.beat_id.toString()).toBe(beatA.toString());
  });

  it('seeds defaults: empty body, empty character', async () => {
    const d = await Dialogs.createDialog({ beatId: beatA });
    expect(d.body).toBe('');
    expect(d.character).toBe('');
  });

  it('createDialog accepts initial body and character', async () => {
    const d = await Dialogs.createDialog({
      beatId: beatA,
      body: 'I see you.',
      character: 'Alice',
    });
    expect(d.body).toBe('I see you.');
    expect(d.character).toBe('Alice');
  });

  it('listDialogs filters by beat and sorts by order', async () => {
    const a1 = await Dialogs.createDialog({ beatId: beatA });
    const a2 = await Dialogs.createDialog({ beatId: beatA });
    await Dialogs.createDialog({ beatId: beatB });
    const list = await Dialogs.listDialogs({ beatId: beatA });
    expect(list).toHaveLength(2);
    expect(list[0]._id.toString()).toBe(a1._id.toString());
    expect(list[1]._id.toString()).toBe(a2._id.toString());
  });

  it('countDialogsByBeat returns a Map keyed by beat hex id', async () => {
    await Dialogs.createDialog({ beatId: beatA });
    await Dialogs.createDialog({ beatId: beatA });
    await Dialogs.createDialog({ beatId: beatB });
    const counts = await Dialogs.countDialogsByBeat();
    expect(counts.get(beatA.toString())).toBe(2);
    expect(counts.get(beatB.toString())).toBe(1);
  });

  it('updateDialog accepts body and character fields', async () => {
    const d = await Dialogs.createDialog({ beatId: beatA });
    const updated = await Dialogs.updateDialog(d._id, {
      body: "Don't go in there.",
      character: 'Bob',
    });
    expect(updated.body).toBe("Don't go in there.");
    expect(updated.character).toBe('Bob');
  });

  it('updateDialog rejects unknown fields', async () => {
    const d = await Dialogs.createDialog({ beatId: beatA });
    await expect(
      Dialogs.updateDialog(d._id, { random_field: 'nope' }),
    ).rejects.toThrow(/unknown field/);
  });

  it('reorderDialogsForBeat rewrites the order field', async () => {
    const a = await Dialogs.createDialog({ beatId: beatA });
    const b = await Dialogs.createDialog({ beatId: beatA });
    const c = await Dialogs.createDialog({ beatId: beatA });
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
    await Dialogs.createDialog({ beatId: beatA });
    await Dialogs.createDialog({ beatId: beatA });
    await expect(
      Dialogs.reorderDialogsForBeat(beatA, [new ObjectId().toString()]),
    ).rejects.toThrow(/length/);
  });

  it('deleteDialog removes a single dialog', async () => {
    const a = await Dialogs.createDialog({ beatId: beatA });
    const b = await Dialogs.createDialog({ beatId: beatA });
    await Dialogs.deleteDialog(a._id);
    const list = await Dialogs.listDialogs({ beatId: beatA });
    expect(list).toHaveLength(1);
    expect(list[0]._id.toString()).toBe(b._id.toString());
  });

  it('deleteDialogsForBeat clears all dialogs for that beat only', async () => {
    await Dialogs.createDialog({ beatId: beatA });
    await Dialogs.createDialog({ beatId: beatA });
    await Dialogs.createDialog({ beatId: beatB });
    await Dialogs.deleteDialogsForBeat(beatA);
    const a = await Dialogs.listDialogs({ beatId: beatA });
    const b = await Dialogs.listDialogs({ beatId: beatB });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});
