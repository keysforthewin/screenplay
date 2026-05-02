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

describe('plot title', () => {
  it('getPlot initializes title to empty string on a fresh doc', async () => {
    const plot = await Plots.getPlot();
    expect(plot.title).toBe('');
  });

  it('getPlot lazily backfills title on a legacy doc that has no title field', async () => {
    await fakeDb.collection('plots').insertOne({
      _id: 'main',
      synopsis: 'legacy',
      beats: [],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });
    const plot = await Plots.getPlot();
    expect(plot.title).toBe('');
    const stored = await fakeDb.collection('plots').findOne({ _id: 'main' });
    expect(stored.title).toBe('');
  });

  it('updatePlot persists a new title and returns it', async () => {
    const updated = await Plots.updatePlot({ title: 'The Long Drive' });
    expect(updated.title).toBe('The Long Drive');
    const fresh = await Plots.getPlot();
    expect(fresh.title).toBe('The Long Drive');
  });

  it('updatePlot trims surrounding whitespace on title', async () => {
    const updated = await Plots.updatePlot({ title: '   Caper   ' });
    expect(updated.title).toBe('Caper');
  });

  it('updatePlot accepts an empty title string to clear the title', async () => {
    await Plots.updatePlot({ title: 'Working Title' });
    const cleared = await Plots.updatePlot({ title: '' });
    expect(cleared.title).toBe('');
  });

  it('updatePlot rejects non-string title values', async () => {
    await expect(Plots.updatePlot({ title: 42 })).rejects.toThrow(/`title` must be a string/);
  });

  it('updatePlot still rejects when patch has no recognized fields (regression)', async () => {
    await expect(Plots.updatePlot({ foo: 'bar' })).rejects.toThrow(/no recognized fields/);
  });

  it('updatePlot can update title and synopsis in one call', async () => {
    const out = await Plots.updatePlot({ title: 'Caper', synopsis: 'A heist gone right.' });
    expect(out.title).toBe('Caper');
    expect(out.synopsis).toBe('A heist gone right.');
  });
});
