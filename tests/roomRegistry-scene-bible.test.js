import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
const { resolveRoom } = await import('../src/web/roomRegistry.js');

describe('beat room scene_bible fragments', () => {
  beforeEach(() => fakeDb.reset());

  it('exposes a fragment per scene_bible field, seeded from the stored bible', async () => {
    await createBeat({ name: 'Diner', desc: 'd' });
    const beat = await getBeat('Diner');
    await setBeatSceneBible(beat._id, { location: 'Corner diner', mood: 'tense' });

    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    expect(desc.fields).toContain('scene_bible.location');
    expect(desc.fields).toContain('scene_bible.camera_language');
    expect(desc.seed['scene_bible.location']).toBe('Corner diner');
    expect(desc.seed['scene_bible.mood']).toBe('tense');
    expect(desc.seed['scene_bible.palette']).toBe('');
  });

  it('persistFields writes a changed bible field back via setBeatSceneBible', async () => {
    await createBeat({ name: 'Diner', desc: 'd' });
    const beat = await getBeat('Diner');
    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    const snapshot = {};
    for (const f of desc.fields) snapshot[f] = desc.seed[f] ?? '';
    snapshot['scene_bible.location'] = 'Rainy alley';
    const result = await desc.persistFields(snapshot);
    expect(result.changed).toBe(true);
    expect(result.fields).toContain('scene_bible.location');
    const updated = await getBeat('Diner');
    expect(updated.scene_bible.location).toBe('Rainy alley');
  });

  it('persistFields does nothing when no bible field changed', async () => {
    await createBeat({ name: 'Diner', desc: 'd' });
    const beat = await getBeat('Diner');
    await setBeatSceneBible(beat._id, { location: 'Corner diner' });
    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    const snapshot = {};
    for (const f of desc.fields) snapshot[f] = desc.seed[f] ?? '';
    const result = await desc.persistFields(snapshot);
    expect(result.changed).toBe(false);
  });
});
