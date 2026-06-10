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

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('plot dialogue_style', () => {
  it('updatePlot accepts and persists dialogue_style', async () => {
    await Plots.updatePlot(projectId, { dialogue_style: '1970s neo-noir. Sparse, hard-boiled.' });
    const plot = await Plots.getPlot(projectId);
    expect(plot.dialogue_style).toBe('1970s neo-noir. Sparse, hard-boiled.');
  });
});
