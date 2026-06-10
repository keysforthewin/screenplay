import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
const { resolveRoom } = await import('../src/web/roomRegistry.js');

describe('beat room scene_bible fragments', () => {
  let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

  it('exposes a fragment per scene_bible field, seeded from the stored bible', async () => {
    await createBeat({ projectId, name: 'Diner', desc: 'd' });
    const beat = await getBeat(projectId, 'Diner');
    await setBeatSceneBible(projectId, beat._id, { location: 'Corner diner', mood: 'tense' });

    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    expect(desc.fields).toContain('scene_bible.location');
    expect(desc.fields).toContain('scene_bible.camera_language');
    expect(desc.seed['scene_bible.location']).toBe('Corner diner');
    expect(desc.seed['scene_bible.mood']).toBe('tense');
    expect(desc.seed['scene_bible.palette']).toBe('');
  });

  it('persistFields writes a changed bible field back via setBeatSceneBible', async () => {
    await createBeat({ projectId, name: 'Diner', desc: 'd' });
    const beat = await getBeat(projectId, 'Diner');
    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    const snapshot = {};
    for (const f of desc.fields) snapshot[f] = desc.seed[f] ?? '';
    snapshot['scene_bible.location'] = 'Rainy alley';
    const result = await desc.persistFields(snapshot);
    expect(result.changed).toBe(true);
    expect(result.fields).toContain('scene_bible.location');
    const updated = await getBeat(projectId, 'Diner');
    expect(updated.scene_bible.location).toBe('Rainy alley');
  });

  it('persistFields does nothing when no bible field changed', async () => {
    await createBeat({ projectId, name: 'Diner', desc: 'd' });
    const beat = await getBeat(projectId, 'Diner');
    await setBeatSceneBible(projectId, beat._id, { location: 'Corner diner' });
    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    const snapshot = {};
    for (const f of desc.fields) snapshot[f] = desc.seed[f] ?? '';
    const result = await desc.persistFields(snapshot);
    expect(result.changed).toBe(false);
  });

  it('does not re-persist a bible field whose only difference is trailing whitespace', async () => {
    await createBeat({ projectId, name: 'Diner', desc: 'd' });
    const beat = await getBeat(projectId, 'Diner');

    // First store tick: the y-doc fragment has trailing whitespace.
    let desc = await resolveRoom(`beat:${beat._id.toString()}`);
    const snap = {};
    for (const f of desc.fields) snap[f] = desc.seed[f] ?? '';
    snap['scene_bible.location'] = 'Rainy alley ';
    const r1 = await desc.persistFields(snap);
    expect(r1.changed).toBe(true);

    // Second tick: stored value is now trimmed, but the y-doc fragment is
    // unchanged (still 'Rainy alley '). This must NOT re-persist.
    desc = await resolveRoom(`beat:${beat._id.toString()}`);
    const snap2 = {};
    for (const f of desc.fields) snap2[f] = desc.seed[f] ?? '';
    snap2['scene_bible.location'] = 'Rainy alley ';
    const r2 = await desc.persistFields(snap2);
    expect(r2.changed).toBe(false);
  });
});
