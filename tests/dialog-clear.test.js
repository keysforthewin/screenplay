// Tests for the page-level "Delete all" gateway helper.

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
const Gateway = await import('../src/web/gateway.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('deleteAllDialogsForBeatViaGateway', () => {
  it('removes every dialog for the beat and returns a count', async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'B', desc: '', body: '', characters: [],
    });
    await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'one', character: 'Alice' });
    await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'two', character: 'Bob' });
    await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'three', character: 'Alice' });

    const result = await Gateway.deleteAllDialogsForBeatViaGateway({ projectId, beatId: beat._id });
    expect(result).toEqual({ ok: true, removed_count: 3 });

    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after).toHaveLength(0);
  });

  it('does not affect dialogs on other beats', async () => {
    const beatA = await Plots.createBeat({ projectId, name: 'A', desc: '', body: '', characters: [] });
    const beatB = await Plots.createBeat({ projectId, name: 'B', desc: '', body: '', characters: [] });
    await Dialogs.createDialog({ projectId, beatId: beatA._id, body: 'a1', character: 'Alice' });
    await Dialogs.createDialog({ projectId, beatId: beatB._id, body: 'b1', character: 'Bob' });
    await Dialogs.createDialog({ projectId, beatId: beatB._id, body: 'b2', character: 'Bob' });

    await Gateway.deleteAllDialogsForBeatViaGateway({ projectId, beatId: beatB._id });

    const stillA = await Dialogs.listDialogs({ beatId: beatA._id });
    const goneB = await Dialogs.listDialogs({ beatId: beatB._id });
    expect(stillA.map((s) => s.body)).toEqual(['a1']);
    expect(goneB).toHaveLength(0);
  });

  it('is a no-op when the beat has no dialogs', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'E', desc: '', body: '', characters: [] });
    const result = await Gateway.deleteAllDialogsForBeatViaGateway({ projectId, beatId: beat._id });
    expect(result).toEqual({ ok: true, removed_count: 0 });
  });
});
