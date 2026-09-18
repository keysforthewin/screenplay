import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => { req.session = undefined; next(); },
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Route Beat Create'))._id.toString();
});

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project-Id': projectId },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('POST /api/beat', () => {
  it('appends an empty "New beat" at the end of the list', async () => {
    await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const { status, json } = await post('/api/beat', {});
    expect(status).toBe(201);
    expect(json.beat.name).toBe('New beat');
    expect(json.beat.body).toBe('');
    expect(json.beat.order).toBe(3);
    const plot = await Plots.getPlot(projectId);
    expect(plot.beats.map((b) => b.name)).toEqual(['A', 'B', 'New beat']);
  });

  it('allows repeated creates (beat names are not unique)', async () => {
    await post('/api/beat', {});
    const { status, json } = await post('/api/beat', {});
    expect(status).toBe(201);
    expect(json.beat.order).toBe(2);
  });

  it('honors an explicit name and rejects an over-long one', async () => {
    const ok = await post('/api/beat', { name: 'Cold open' });
    expect(ok.json.beat.name).toBe('Cold open');
    const bad = await post('/api/beat', { name: 'x'.repeat(201) });
    expect(bad.status).toBe(400);
  });
});
