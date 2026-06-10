// REST endpoints for project management + project-scoped /api/info.
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

const Projects = await import('../src/mongo/projects.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

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
beforeEach(() => fakeDb.reset());

const post = (path, body, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const get = (path, headers = {}) => fetch(`${baseUrl}/api${path}`, { headers });

describe('GET /api/projects', () => {
  it('lists projects as {projects:[{id,title,created_at}]}', async () => {
    await Projects.createProject('Western');
    const r = await get('/projects');
    expect(r.status).toBe(200);
    const body = await r.json();
    const titles = body.projects.map((p) => p.title);
    expect(titles).toContain('Western');
    for (const p of body.projects) {
      expect(p.id).toMatch(/^[a-f0-9]{24}$/);
      expect(p.title).toBeTruthy();
      expect(p.created_at).toBeTruthy();
    }
  });
});

describe('POST /api/projects', () => {
  it('creates a project, seeds templates + an empty plot doc, returns 201', async () => {
    const r = await post('/projects', { title: 'Space Opera' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.id).toMatch(/^[a-f0-9]{24}$/);
    expect(body.title).toBe('Space Opera');
    // seedProjectDefaults ran: composite-keyed templates + a plot doc exist.
    const prompts = fakeDb.collection('prompts')._docs;
    expect(prompts.some((d) => d._id === `${body.id}:character_template`)).toBe(true);
    expect(prompts.some((d) => d._id === `${body.id}:plot_template`)).toBe(true);
    const plots = fakeDb.collection('plots')._docs;
    expect(plots.some((d) => String(d.project_id) === body.id)).toBe(true);
  });

  it('400s on invalid titles (empty, slash, >120 chars, missing)', async () => {
    expect((await post('/projects', { title: '   ' })).status).toBe(400);
    expect((await post('/projects', { title: 'a/b' })).status).toBe(400);
    expect((await post('/projects', { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await post('/projects', {})).status).toBe(400);
  });

  it('409s on a duplicate title (case-insensitive)', async () => {
    await Projects.createProject('Noir');
    const r = await post('/projects', { title: 'noir' });
    expect(r.status).toBe(409);
  });
});

describe('GET /api/info', () => {
  it('returns the default project when no header is sent', async () => {
    const r = await get('/info');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.project_id).toMatch(/^[a-f0-9]{24}$/);
    expect(body.project_title).toBe('Screenplay'); // lazily created default
    expect(body).toHaveProperty('hocuspocus_url');
    expect(body).toHaveProperty('screenplay_title');
  });

  it('scopes to the X-Project-Id header project', async () => {
    const p = await Projects.createProject('Western');
    const r = await get('/info', { 'X-Project-Id': p._id.toString() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.project_id).toBe(p._id.toString());
    expect(body.project_title).toBe('Western');
  });

  it('404s {error:"unknown project"} for an unknown project id', async () => {
    const r = await get('/info', { 'X-Project-Id': new ObjectId().toString() });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown project' });
  });
});
