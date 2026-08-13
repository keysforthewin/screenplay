// findBeatsReferencingSet + GET /set/:id/beats — the reverse beat→set index
// used by the set page's beat multi-selects (description generation, shot
// planning, auto image sheets).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({
  deleteEntity: async () => {},
  deleteProjectChunks: async () => {},
}));

const Projects = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const Plots = await import('../src/mongo/plots.js');
const { findBeatsReferencingSet } = await import('../src/web/storyboardGenerate.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let p1;

beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r()));
});
beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
});

const get = (path) => fetch(`${baseUrl}/api${path}`, { headers: { 'X-Project-Id': p1 } });

describe('findBeatsReferencingSet', () => {
  it('matches beat.sets entries case-insensitively with markdown stripped, sorted by order', async () => {
    const set = await Sets.createSet({ projectId: p1, name: '**Alley**' });
    await Plots.createBeat({ projectId: p1, name: 'One', body: 'INT. ALLEY', sets: ['**Alley**'] });
    await Plots.createBeat({ projectId: p1, name: 'Two', body: '', sets: ['Rooftop'] });
    await Plots.createBeat({ projectId: p1, name: 'Three', body: 'BACK IN THE ALLEY', sets: ['alley', 'Rooftop'] });
    await Plots.createBeat({ projectId: p1, name: 'Four', body: 'x' });

    const beats = await findBeatsReferencingSet(p1, set);
    expect(beats.map((b) => b.name)).toEqual(['One', 'Three']);
    expect(beats.map((b) => b.order)).toEqual([1, 3]);
  });

  it('returns [] for a set no beat references', async () => {
    const set = await Sets.createSet({ projectId: p1, name: 'Orphan' });
    await Plots.createBeat({ projectId: p1, name: 'One', sets: ['Somewhere Else'] });
    expect(await findBeatsReferencingSet(p1, set)).toEqual([]);
  });
});

describe('GET /set/:id/beats', () => {
  it('returns the referencing beats with body_empty flags', async () => {
    const set = await Sets.createSet({ projectId: p1, name: 'Alley' });
    const b1 = await Plots.createBeat({ projectId: p1, name: '**One**', desc: 'd1', body: 'INT. ALLEY - NIGHT', sets: ['alley'] });
    await Plots.createBeat({ projectId: p1, name: 'Two', body: 'x', sets: ['Rooftop'] });
    const b3 = await Plots.createBeat({ projectId: p1, name: 'Three', desc: '', body: '  ', sets: ['Alley'] });

    const r = await get(`/set/${set._id.toString()}/beats`);
    expect(r.status).toBe(200);
    const { beats } = await r.json();
    expect(beats).toEqual([
      { _id: b1._id.toString(), order: 1, name: '**One**', plain_name: 'One', desc: 'd1', body_empty: false },
      { _id: b3._id.toString(), order: 3, name: 'Three', plain_name: 'Three', desc: '', body_empty: true },
    ]);
  });

  it('resolves the set by name too and 404s on a miss', async () => {
    await Sets.createSet({ projectId: p1, name: 'Alley' });
    expect((await get('/set/alley/beats')).status).toBe(200);
    expect((await get(`/set/${new ObjectId().toString()}/beats`)).status).toBe(404);
  });
});
