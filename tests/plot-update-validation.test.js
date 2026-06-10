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
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('updatePlot input validation', () => {
  it('throws when patch is a string (the model-passed-value-as-patch bug)', async () => {
    await expect(Plots.updatePlot(projectId, 'a long synopsis string')).rejects.toThrow(/must be an object/);
  });

  it('throws when patch is an array', async () => {
    await expect(Plots.updatePlot(projectId, ['synopsis', 'foo'])).rejects.toThrow(/must be an object.*array/);
  });

  it('throws when patch is null', async () => {
    await expect(Plots.updatePlot(projectId, null)).rejects.toThrow(/must be an object/);
  });

  it('throws when patch has no recognized fields', async () => {
    await expect(Plots.updatePlot(projectId, { foo: 'bar' })).rejects.toThrow(/no recognized fields/);
  });

  it('valid patch.synopsis still updates end-to-end', async () => {
    await Plots.updatePlot(projectId, { synopsis: 'A great movie about debugging.' });
    const plot = await Plots.getPlot(projectId);
    expect(plot.synopsis).toBe('A great movie about debugging.');
  });

  it('updatePlot throws when the doc disappears mid-write', async () => {
    await Plots.getPlot(projectId);
    const col = fakeDb.collection('plots');
    const spy = vi.spyOn(col, 'updateOne').mockResolvedValue({ matchedCount: 0 });
    try {
      await expect(Plots.updatePlot(projectId, { synopsis: 'wont land' })).rejects.toThrow(
        /updatePlot: plot doc.*not found/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
