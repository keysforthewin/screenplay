// Test for the project-level dialogue style/influences field on the plot doc.

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

const Plots = await import('../src/mongo/plots.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('plot dialogue_style', () => {
  it('updatePlot accepts and persists dialogue_style', async () => {
    await Plots.updatePlot({ dialogue_style: '1970s neo-noir. Sparse, hard-boiled.' });
    const plot = await Plots.getPlot();
    expect(plot.dialogue_style).toBe('1970s neo-noir. Sparse, hard-boiled.');
  });
});
