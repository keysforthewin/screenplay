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
const { buildCritiqueContext } = await import('../src/web/critiqueContext.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  await Plots.updatePlot(projectId, { synopsis: 'The whole story.' });
});

describe('buildCritiqueContext', () => {
  it('finds prev/next neighbors by order and builds the spine', async () => {
    await Plots.createBeat({ projectId, name: 'One', desc: 'd1', body: 'b1', order: 1 });
    const mid = await Plots.createBeat({ projectId, name: 'Two', desc: 'd2', body: 'b2', order: 2 });
    await Plots.createBeat({ projectId, name: 'Three', desc: 'd3', body: 'b3', order: 3 });
    const beat = await Plots.getBeat(projectId, mid._id.toString());
    const ctx = await buildCritiqueContext(projectId, beat);
    expect(ctx.prevBeat.order).toBe(1);
    expect(ctx.nextBeat.order).toBe(3);
    expect(ctx.spine).toHaveLength(3);
    expect(ctx.plot.synopsis).toBe('The whole story.');
    expect(ctx.styleGuide.length).toBeGreaterThan(20);
  });

  it('returns null neighbors at the ends', async () => {
    const first = await Plots.createBeat({ projectId, name: 'One', body: 'b1', order: 1 });
    await Plots.createBeat({ projectId, name: 'Two', body: 'b2', order: 2 });
    const beat = await Plots.getBeat(projectId, first._id.toString());
    const ctx = await buildCritiqueContext(projectId, beat);
    expect(ctx.prevBeat).toBeNull();
    expect(ctx.nextBeat.order).toBe(2);
    const last = await Plots.getBeat(projectId, (await Plots.listBeats(projectId)).at(-1)._id.toString());
    const lastCtx = await buildCritiqueContext(projectId, last);
    expect(lastCtx.nextBeat).toBeNull();
    expect(lastCtx.prevBeat.order).toBe(1);
  });
});
