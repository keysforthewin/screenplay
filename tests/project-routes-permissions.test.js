// Per-project authorization over the /api router: filtered GET /projects,
// admin-only create/rename/delete, requireProjectAccess 403s on project-scoped
// routes, and the legacy open mode when ADMIN_USERNAME is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => {
    req.session = { username: req.headers['x-test-user'] || 'Member' };
    next();
  },
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const Projects = await import('../src/mongo/projects.js');
const Users = await import('../src/mongo/users.js');
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
beforeEach(() => {
  fakeDb.reset();
  process.env.ADMIN_USERNAME = 'Boss';
});
afterEach(() => {
  process.env.ADMIN_USERNAME = '';
});

const get = (path, headers = {}) => fetch(`${baseUrl}/api${path}`, { headers });
const send = (method) => (path, body, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = send('POST');
const patch = send('PATCH');
const del = send('DELETE');

async function grant(name, projectIds) {
  const user = await Users.findOrCreateUserByName(name);
  await Users.setUserProjects(user._id.toString(), projectIds);
  return user;
}

describe('GET /api/projects filtering', () => {
  it('members see only granted projects; admin sees all', async () => {
    const a = await Projects.createProject('A');
    await Projects.createProject('B');
    await grant('Steve', [a._id.toString()]);

    const member = await (await get('/projects', { 'X-Test-User': 'Steve' })).json();
    expect(member.projects.map((p) => p.title)).toEqual(['A']);

    const admin = await (await get('/projects', { 'X-Test-User': 'Boss' })).json();
    expect(admin.projects.map((p) => p.title)).toEqual(['A', 'B']);

    const stranger = await (await get('/projects', { 'X-Test-User': 'Nobody' })).json();
    expect(stranger.projects).toEqual([]);
  });

  it('returns everything when ADMIN_USERNAME is unset (legacy open mode)', async () => {
    process.env.ADMIN_USERNAME = '';
    await Projects.createProject('A');
    await Projects.createProject('B');
    const body = await (await get('/projects', { 'X-Test-User': 'Nobody' })).json();
    expect(body.projects.map((p) => p.title)).toEqual(['A', 'B']);
  });
});

describe('requireProjectAccess on project-scoped routes', () => {
  it('403s a member on an ungranted project, passes a granted one', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    await grant('Steve', [a._id.toString()]);

    const okRes = await get('/info', {
      'X-Test-User': 'Steve',
      'X-Project-Id': a._id.toString(),
    });
    expect(okRes.status).toBe(200);

    const forbidden = await get('/info', {
      'X-Test-User': 'Steve',
      'X-Project-Id': b._id.toString(),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'forbidden project' });

    const admin = await get('/info', {
      'X-Test-User': 'Boss',
      'X-Project-Id': b._id.toString(),
    });
    expect(admin.status).toBe(200);
  });

  it('the headerless default-project fallback fails closed for ungranted users', async () => {
    await Projects.createProject('Only');
    const r = await get('/info', { 'X-Test-User': 'Nobody' });
    expect(r.status).toBe(403);
  });

  it('passes everyone when ADMIN_USERNAME is unset', async () => {
    const a = await Projects.createProject('A');
    process.env.ADMIN_USERNAME = '';
    const r = await get('/info', {
      'X-Test-User': 'Nobody',
      'X-Project-Id': a._id.toString(),
    });
    expect(r.status).toBe(200);
  });
});

describe('admin-only project mutations', () => {
  it('create/rename/delete 403 for members, work for the admin', async () => {
    const a = await Projects.createProject('A');
    await grant('Steve', [a._id.toString()]);

    expect((await post('/projects', { title: 'New' }, { 'X-Test-User': 'Steve' })).status).toBe(403);
    expect(
      (
        await patch(`/projects/${a._id.toString()}`, { title: 'Renamed' }, { 'X-Test-User': 'Steve' })
      ).status,
    ).toBe(403);
    expect(
      (await del(`/projects/${a._id.toString()}`, undefined, { 'X-Test-User': 'Steve' })).status,
    ).toBe(403);

    expect((await post('/projects', { title: 'New' }, { 'X-Test-User': 'Boss' })).status).toBe(201);
    expect(
      (
        await patch(`/projects/${a._id.toString()}`, { title: 'Renamed' }, { 'X-Test-User': 'Boss' })
      ).status,
    ).toBe(200);
    expect(
      (await del(`/projects/${a._id.toString()}`, undefined, { 'X-Test-User': 'Boss' })).status,
    ).toBe(200);
  });

  it('stay open when ADMIN_USERNAME is unset (legacy regression pin)', async () => {
    process.env.ADMIN_USERNAME = '';
    expect((await post('/projects', { title: 'New' }, { 'X-Test-User': 'Anyone' })).status).toBe(201);
  });
});
