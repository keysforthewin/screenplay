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
