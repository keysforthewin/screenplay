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
const Gateway = await import('../src/web/gateway.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  vi.clearAllMocks();
  projectId = (await createProject('GW Reorder'))._id.toString();
});

describe('reorderBeatsViaGateway', () => {
  it('renumbers and returns the reordered beats without a running Hocuspocus', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const out = await Gateway.reorderBeatsViaGateway({
      projectId,
      orderedIds: [B._id.toString(), A._id.toString()],
    });
    expect(out.map((x) => x.name)).toEqual(['B', 'A']);
    expect(out.map((x) => x.order)).toEqual([1, 2]);
  });
});

describe('create/deleteBeatViaGateway', () => {
  it('createBeatViaGateway inserts + renumbers', async () => {
    await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const b = await Gateway.createBeatViaGateway({ projectId, name: 'NEW', body: 'x', order: 1 });
    expect(b.order).toBe(1);
    expect((await Plots.listBeats(projectId)).map((x) => x.name)).toEqual(['NEW', 'A']);
  });

  it('deleteBeatViaGateway removes + closes the gap', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    await Gateway.deleteBeatViaGateway(projectId, A._id.toString());
    expect((await Plots.listBeats(projectId)).map((x) => x.order)).toEqual([1]);
  });
});
