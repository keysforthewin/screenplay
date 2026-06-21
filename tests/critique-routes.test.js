import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
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
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const G = await import('../src/web/critiqueGenerate.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
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
  projectId = (await createProject('P'))._id.toString();
  await Plots.updatePlot(projectId, { synopsis: 'S' });
});
afterEach(() => { G._setFacetGeneratorForTests(null); _setAnthropicClientForTests(null); });

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}
async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

describe('critique routes', () => {
  it('GET /beat/:id/critique returns null before any run', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const { status, json } = await get(`/api/beat/${beat._id}/critique`);
    expect(status).toBe(200);
    expect(json.critique).toBeNull();
  });

  it('GET /beat/:id/critique 404s for an unknown beat', async () => {
    const { status } = await get('/api/beat/999/critique');
    expect(status).toBe(404);
  });

  it('POST /beat/:id/critique returns 202 + job_id', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b', order: 1 });
    G._setFacetGeneratorForTests(async () => ({ score: 7, comments: 'ok' }));
    const { status, json } = await post(`/api/beat/${beat._id}/critique`, {});
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();
    // Drain the fire-and-forget run so it completes under the test's override.
    const terminal = (s) => ['done', 'partial', 'error'].includes(s);
    for (let i = 0; i < 100; i++) {
      const j = G.getCritiqueJob(json.job_id);
      if (!j || terminal(j.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  it('POST /beat/:id/normalize rewrites the body', async () => {
    _setAnthropicClientForTests({ messages: { create: async () => ({ content: [{ type: 'text', text: 'NORM' }] }) } });
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'prose' });
    const { status, json } = await post(`/api/beat/${beat._id}/normalize`, {});
    expect(status).toBe(200);
    expect(json.body).toBe('NORM');
  });

  it('POST /beat/:id/regenerate 409s with no critique', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const { status } = await post(`/api/beat/${beat._id}/regenerate`, {});
    expect(status).toBe(409);
  });

  it('POST /beat/:id/restore-body returns restored:false when nothing stashed', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const { status, json } = await post(`/api/beat/${beat._id}/restore-body`, {});
    expect(status).toBe(200);
    expect(json).toEqual({ restored: false });
  });
});
