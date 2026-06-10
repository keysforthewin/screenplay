import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const Plots = await import('../src/mongo/plots.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => fakeDb.reset());

describe('agent plot-field tools', () => {
  it('edit accepts plot field dialogue_style (whole replace)', async () => {
    const out = await HANDLERS.edit({
      collection: 'plot',
      field: 'dialogue_style',
      edits: [{ find: '', replace: '1970s neo-noir. Sparse, hard-boiled.' }],
    });
    expect(out).toMatch(/Replaced plot\.dialogue_style/);
    const plot = await Plots.getPlot();
    expect(plot.dialogue_style).toBe('1970s neo-noir. Sparse, hard-boiled.');
  });

  it('edit applies find/replace to plot.synopsis', async () => {
    await Plots.updatePlot(undefined, { synopsis: 'A quiet town.' });
    const out = await HANDLERS.edit({
      collection: 'plot',
      field: 'synopsis',
      edits: [{ find: 'quiet', replace: 'haunted' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    const plot = await Plots.getPlot();
    expect(plot.synopsis).toBe('A haunted town.');
  });

  it('edit rejects an unknown plot field', async () => {
    const out = await HANDLERS.edit({
      collection: 'plot',
      field: 'bogus',
      edits: [{ find: '', replace: 'x' }],
    });
    expect(out).toMatch(/plot field must be/);
  });

  it('add_film_dialogue_sample appends a formatted sample to the global dialogue style', async () => {
    await Plots.updatePlot(undefined, { dialogue_style: 'Base style.' });
    const out = await HANDLERS.add_film_dialogue_sample({
      film: 'Chinatown',
      sample: 'JAKE: How much better can you eat?',
      note: 'clipped, hard-boiled',
    });
    expect(out).toMatch(/Chinatown/);
    const plot = await Plots.getPlot();
    expect(plot.dialogue_style).toContain('Base style.');
    expect(plot.dialogue_style).toContain('Chinatown');
    expect(plot.dialogue_style).toContain('JAKE: How much better can you eat?');
  });

  it('add_film_dialogue_sample requires film and sample', async () => {
    expect(await HANDLERS.add_film_dialogue_sample({ sample: 'x' })).toMatch(/`film` is required/);
    expect(await HANDLERS.add_film_dialogue_sample({ film: 'x' })).toMatch(/`sample` is required/);
  });
});
