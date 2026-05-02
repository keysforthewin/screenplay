import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Plots = await import('../src/mongo/plots.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('updatePlot input validation', () => {
  it('throws when patch is a string (the model-passed-value-as-patch bug)', async () => {
    await expect(Plots.updatePlot('a long synopsis string')).rejects.toThrow(/must be an object/);
  });

  it('throws when patch is an array', async () => {
    await expect(Plots.updatePlot(['synopsis', 'foo'])).rejects.toThrow(/must be an object.*array/);
  });

  it('throws when patch is null', async () => {
    await expect(Plots.updatePlot(null)).rejects.toThrow(/must be an object/);
  });

  it('throws when patch has no recognized fields', async () => {
    await expect(Plots.updatePlot({ foo: 'bar' })).rejects.toThrow(/no recognized fields/);
  });

  it('valid patch.synopsis still updates end-to-end', async () => {
    await Plots.updatePlot({ synopsis: 'A great movie about debugging.' });
    const plot = await Plots.getPlot();
    expect(plot.synopsis).toBe('A great movie about debugging.');
  });

  it('updatePlot throws when the doc disappears mid-write', async () => {
    await Plots.getPlot();
    const col = fakeDb.collection('plots');
    const spy = vi.spyOn(col, 'updateOne').mockResolvedValue({ matchedCount: 0 });
    try {
      await expect(Plots.updatePlot({ synopsis: 'wont land' })).rejects.toThrow(
        /updatePlot: plot doc.*not found/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
