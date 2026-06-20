// Tests for the per-beat "Dialogue Notes" field: schema persistence on the
// beat doc, and the dialogs y-doc room exposing/persisting the notes fragment.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const Dialogs = await import('../src/mongo/dialogs.js');
const { resolveRoom } = await import('../src/web/roomRegistry.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('beat dialog_notes field', () => {
  it('updateBeat accepts and persists dialog_notes', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'b' });
    await Plots.updateBeat(projectId, beat._id, { dialog_notes: 'Keep it clipped.' });
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.dialog_notes).toBe('Keep it clipped.');
  });
});

describe('dialogs room dialog_notes fragment', () => {
  it('exposes a dialog_notes fragment seeded from the beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'b' });
    await Plots.updateBeat(projectId, beat._id, { dialog_notes: 'seeded note' });

    const room = await resolveRoom(`dialogs:${beat._id.toString()}`);
    expect(room.fields).toContain('dialog_notes');
    expect(room.seed.dialog_notes).toBe('seeded note');
  });

  it('persists a changed dialog_notes fragment back to the beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'b' });
    const room = await resolveRoom(`dialogs:${beat._id.toString()}`);

    const result = await room.persistFields({ dialog_notes: 'written from y-doc' });
    expect(result.changed).toBe(true);

    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.dialog_notes).toBe('written from y-doc');
  });
});

describe('dialogs room direction fragment (voice-actor note)', () => {
  it('exposes an item:<id>:direction fragment seeded from the dialog', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'b' });
    const d = await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'Drive.', character: 'Bob' });
    await Dialogs.updateDialog(projectId, d._id, { direction: 'Urgent. Eyes on the road.' });

    const room = await resolveRoom(`dialogs:${beat._id.toString()}`);
    const field = `item:${d._id.toString()}:direction`;
    expect(room.fields).toContain(field);
    expect(room.seed[field]).toBe('Urgent. Eyes on the road.');
  });

  it('persists a changed direction fragment back to the dialog', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'b' });
    const d = await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'Drive.', character: 'Bob' });
    const room = await resolveRoom(`dialogs:${beat._id.toString()}`);
    const field = `item:${d._id.toString()}:direction`;

    const result = await room.persistFields({ [field]: 'written from y-doc' });
    expect(result.changed).toBe(true);

    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.direction).toBe('written from y-doc');
  });
});
