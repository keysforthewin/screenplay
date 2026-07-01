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
  projectId = (await createProject('Route Reorder'))._id.toString();
});

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('POST /api/beats/reorder', () => {
  it('renumbers beats into the given order', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const { status, json } = await post('/api/beats/reorder', {
      ordered_ids: [B._id.toString(), A._id.toString()],
    });
    expect(status).toBe(200);
    expect(json.beats.map((b) => b.name)).toEqual(['B', 'A']);
    expect(json.beats.map((b) => b.order)).toEqual([1, 2]);
  });

  it('returns 400 when ordered_ids is not an array', async () => {
    const { status, json } = await post('/api/beats/reorder', { ordered_ids: 'nope' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/ordered_ids/);
  });
});
