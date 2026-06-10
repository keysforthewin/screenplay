// tests/plots-scene-bible.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { getPlot, createBeat, getBeat, setBeatSceneBible } = await import(
  '../src/mongo/plots.js'
);

describe('scene_bible on beats', () => {
  beforeEach(() => fakeDb.reset());

  it('backfills scene_bible: null on beats that lack it', async () => {
    await createBeat({ name: 'Diner', desc: 'A diner' });
    const beat = await getBeat(undefined, 'Diner');
    expect(beat.scene_bible).toBeNull();
  });

  it('setBeatSceneBible persists a normalized bible and re-reads it', async () => {
    await createBeat({ name: 'Diner', desc: 'A diner' });
    await setBeatSceneBible(undefined, 'Diner', { location: '  Corner diner  ', bogus: 'x' });
    const beat = await getBeat(undefined, 'Diner');
    expect(beat.scene_bible.location).toBe('Corner diner');
    expect(beat.scene_bible).not.toHaveProperty('bogus');
    expect(beat.scene_bible.mood).toBe('');
  });

  it('setBeatSceneBible(id, null) clears the bible back to null', async () => {
    await createBeat({ name: 'Diner', desc: 'A diner' });
    await setBeatSceneBible(undefined, 'Diner', { mood: 'tense' });
    let beat = await getBeat(undefined, 'Diner');
    expect(beat.scene_bible.mood).toBe('tense');
    await setBeatSceneBible(undefined, 'Diner', null);
    beat = await getBeat(undefined, 'Diner');
    expect(beat.scene_bible).toBeNull();
  });

  it('createBeat returns a beat that already has scene_bible: null', async () => {
    const beat = await createBeat({ name: 'Solo', desc: 'A scene' });
    expect(beat.scene_bible).toBeNull();
  });
});
