import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Reorder Test'))._id.toString();
});

describe('normalizeBeatOrders', () => {
  it('rewrites gapped/tied/decimal orders to a contiguous 1..N by sort', () => {
    const input = [
      { _id: 'a', order: 5 },
      { _id: 'b', order: 1 },
      { _id: 'c', order: 1.5 },
      { _id: 'd', order: 1 },
    ];
    const out = Plots.normalizeBeatOrders(input);
    // Sorted by order (ties keep input order): b(1), d(1), c(1.5), a(5)
    expect(out.map((x) => x._id)).toEqual(['b', 'd', 'c', 'a']);
    expect(out.map((x) => x.order)).toEqual([1, 2, 3, 4]);
  });

  it('does not mutate the input array or its already-correct members', () => {
    const b0 = { _id: 'x', order: 1 };
    const input = [b0, { _id: 'y', order: 2 }];
    const out = Plots.normalizeBeatOrders(input);
    expect(out[0]).toBe(b0); // unchanged reference
    expect(input.map((x) => x.order)).toEqual([1, 2]); // input untouched
  });
});

describe('beat mutations keep order contiguous 1..N', () => {
  async function makeBeats(names) {
    const beats = [];
    for (const n of names) beats.push(await Plots.createBeat({ projectId, name: n, body: 'x' }));
    return beats;
  }
  const orders = async () =>
    (await Plots.listBeats(projectId)).map((b) => b.order);
  const names = async () =>
    (await Plots.listBeats(projectId)).map((b) => b.name);

  it('createBeat with order=N inserts at position N and renumbers', async () => {
    await makeBeats(['A', 'B', 'C']); // 1,2,3
    const inserted = await Plots.createBeat({ projectId, name: 'NEW', body: 'x', order: 2 });
    expect(inserted.order).toBe(2);
    expect(await names()).toEqual(['A', 'NEW', 'B', 'C']);
    expect(await orders()).toEqual([1, 2, 3, 4]);
  });

  it('createBeat without order appends at the end', async () => {
    await makeBeats(['A', 'B']);
    const inserted = await Plots.createBeat({ projectId, name: 'Z', body: 'x' });
    expect(inserted.order).toBe(3);
    expect(await names()).toEqual(['A', 'B', 'Z']);
  });

  it('updateBeat order=N moves the beat to position N and renumbers', async () => {
    const [a, b, c, d] = await makeBeats(['A', 'B', 'C', 'D']);
    const moved = await Plots.updateBeat(projectId, d._id.toString(), { order: 2 });
    expect(moved.order).toBe(2);
    expect(await names()).toEqual(['A', 'D', 'B', 'C']);
    expect(await orders()).toEqual([1, 2, 3, 4]);
  });

  it('updateBeat order past the end clamps to last', async () => {
    const [a, b, c] = await makeBeats(['A', 'B', 'C']);
    await Plots.updateBeat(projectId, a._id.toString(), { order: 99 });
    expect(await names()).toEqual(['B', 'C', 'A']);
    expect(await orders()).toEqual([1, 2, 3]);
  });

  it('deleteBeat closes the numbering gap', async () => {
    const [a, b, c, d] = await makeBeats(['A', 'B', 'C', 'D']);
    await Plots.deleteBeat(projectId, b._id.toString());
    expect(await names()).toEqual(['A', 'C', 'D']);
    expect(await orders()).toEqual([1, 2, 3]);
  });
});
