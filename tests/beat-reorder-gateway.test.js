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

const announceCalls = [];
vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: async (payload) => {
    announceCalls.push(payload);
  },
  announceText: async () => {},
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Gateway = await import('../src/web/gateway.js');
const { runAsEditor } = await import('../src/web/editAttribution.js');

// Announcements are fire-and-forget; let the microtask queue drain.
const settle = () => new Promise((r) => setTimeout(r, 0));

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  vi.clearAllMocks();
  announceCalls.length = 0;
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

describe('beat lifecycle announcements', () => {
  it('announces a create performed on behalf of a web user', async () => {
    const b = await runAsEditor('Steve', () =>
      Gateway.createBeatViaGateway({ projectId, name: 'The Heist', body: 'x' }),
    );
    await settle();
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].username).toBe('Steve');
    expect(announceCalls[0].verb).toBe('created');
    expect(announceCalls[0].entityLabel).toBe(`Beat ${b.order}: The Heist`);
    expect(announceCalls[0].entityUrl).toContain(`/beat/${b.order}`);
  });

  it('announces a delete performed on behalf of a web user', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await runAsEditor('Steve', () =>
      Gateway.deleteBeatViaGateway(projectId, A._id.toString()),
    );
    await settle();
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].username).toBe('Steve');
    expect(announceCalls[0].verb).toBe('deleted');
    expect(announceCalls[0].entityLabel).toContain('A');
  });

  it('stays silent without an editor scope (Discord-run agent)', async () => {
    const b = await Gateway.createBeatViaGateway({ projectId, name: 'Silent', body: 'x' });
    await Gateway.deleteBeatViaGateway(projectId, b._id.toString());
    await settle();
    expect(announceCalls).toHaveLength(0);
  });

  it('announces a reorder performed on behalf of a web user', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    await runAsEditor('Steve', () =>
      Gateway.reorderBeatsViaGateway({
        projectId,
        orderedIds: [B._id.toString(), A._id.toString()],
      }),
    );
    await settle();
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].username).toBe('Steve');
    expect(announceCalls[0].verb).toBe('reordered the beats in');
    expect(announceCalls[0].entityLabel).toBe('GW Reorder');
  });

  it('reorder stays silent without an editor scope', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    await Gateway.reorderBeatsViaGateway({
      projectId,
      orderedIds: [B._id.toString(), A._id.toString()],
    });
    await settle();
    expect(announceCalls).toHaveLength(0);
  });

  it('announces an order move via updateBeatViaGateway', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    await runAsEditor('Steve', () =>
      Gateway.updateBeatViaGateway(projectId, A._id.toString(), { order: 2 }),
    );
    await settle();
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].username).toBe('Steve');
    expect(announceCalls[0].verb).toBe('moved');
    expect(announceCalls[0].entityLabel).toBe('Beat 2: A');
  });
});
