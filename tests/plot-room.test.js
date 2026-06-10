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
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({}));

const { resolveRoom, parseRoomName, buildRoomName } = await import('../src/web/roomRegistry.js');
const Plots = await import('../src/mongo/plots.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('plot room', () => {
  it('parseRoomName recognizes the literal "plot" room', () => {
    expect(parseRoomName('plot')).toEqual({ type: 'plot' });
  });

  it('buildRoomName returns "plot" for type:plot', () => {
    expect(buildRoomName('plot')).toBe('plot');
  });

  it('describePlotRoom exposes title/synopsis/dialogue_style seeded from Mongo', async () => {
    await Plots.updatePlot(undefined, {
      title: 'Neon City',
      synopsis: 'A detective hunts a ghost.',
      dialogue_style: '1970s neo-noir.',
    });

    const desc = await resolveRoom('plot');
    expect(desc.type).toBe('plot');
    expect(desc.fields).toEqual(['title', 'synopsis', 'dialogue_style']);
    expect(desc.seed.title).toBe('Neon City');
    expect(desc.seed.synopsis).toBe('A detective hunts a ghost.');
    expect(desc.seed.dialogue_style).toBe('1970s neo-noir.');
  });

  it('persistFields writes only changed fields back to Mongo', async () => {
    await Plots.updatePlot(undefined, { title: 'Old', synopsis: 'keep', dialogue_style: 'keep too' });

    const desc = await resolveRoom('plot');
    const result = await desc.persistFields({
      title: 'New Title',
      synopsis: 'keep', // unchanged
      dialogue_style: 'keep too', // unchanged
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(['title']);

    const plot = await Plots.getPlot();
    expect(plot.title).toBe('New Title');
    expect(plot.synopsis).toBe('keep');
  });

  it('persistFields is a no-op when nothing changed', async () => {
    await Plots.updatePlot(undefined, { title: 'Same', synopsis: 'same', dialogue_style: 'same' });
    const desc = await resolveRoom('plot');
    const result = await desc.persistFields({
      title: 'Same',
      synopsis: 'same',
      dialogue_style: 'same',
    });
    expect(result.changed).toBe(false);
  });
});
