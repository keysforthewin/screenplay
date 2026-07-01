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
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId, ctx;
beforeEach(async () => {
  fakeDb.reset();
  vi.clearAllMocks();
  projectId = (await createProject('Handler Reorder'))._id.toString();
  ctx = { projectId, projectTitle: 'Handler Reorder' };
});

describe('reorder_beats handler', () => {
  it('reorders and renumbers, returning a confirmation', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const C = await Plots.createBeat({ projectId, name: 'C', body: 'x' });
    const out = await HANDLERS.reorder_beats(
      { beat_ids: [C._id.toString(), A._id.toString(), B._id.toString()] },
      ctx,
    );
    expect(out).toMatch(/Reordered 3 beat/);
    const beats = await Plots.listBeats(projectId);
    expect(beats.map((b) => b.name)).toEqual(['C', 'A', 'B']);
    expect(beats.map((b) => b.order)).toEqual([1, 2, 3]);
  });
});
