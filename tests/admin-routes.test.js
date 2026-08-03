// /api/admin/* — admin-only user listing and grant management.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
// Sessions are stubbed: the X-Test-User header names the logged-in user.
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
const put = (path, body, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('GET /api/admin/users', () => {
  it('lists users with grants for the admin', async () => {
    const p = await Projects.createProject('Western');
    const user = await Users.findOrCreateUserByName('Steve');
    await Users.setUserProjects(user._id.toString(), [p._id.toString()]);
    const r = await get('/admin/users', { 'X-Test-User': 'boss' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: user._id.toString(),
      name: 'Steve',
      project_ids: [p._id.toString()],
    });
  });

  it('403s non-admins', async () => {
    const r = await get('/admin/users', { 'X-Test-User': 'Steve' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'admin only' });
  });

  it('ignores a stale X-Project-Id header (resolveProject exemption)', async () => {
    const r = await get('/admin/users', {
      'X-Test-User': 'Boss',
      'X-Project-Id': new ObjectId().toString(),
    });
    expect(r.status).toBe(200);
  });
});

describe('PUT /api/admin/users/:id/projects', () => {
  it('replaces the grant set and records the granter', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const user = await Users.findOrCreateUserByName('Steve');
    await Users.setUserProjects(user._id.toString(), [a._id.toString()]);

    const r = await put(
      `/admin/users/${user._id.toString()}/projects`,
      { project_ids: [b._id.toString()] },
      { 'X-Test-User': 'Boss' },
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.project_ids).toEqual([b._id.toString()]);
    expect(body.last_granted_by).toBe('Boss');
    expect((await Users.findUserByName('Steve')).project_ids).toEqual([b._id.toString()]);
  });

  it('clears all grants with an empty array', async () => {
    const a = await Projects.createProject('A');
    const user = await Users.findOrCreateUserByName('Steve');
    await Users.setUserProjects(user._id.toString(), [a._id.toString()]);
    const r = await put(
      `/admin/users/${user._id.toString()}/projects`,
      { project_ids: [] },
      { 'X-Test-User': 'Boss' },
    );
    expect(r.status).toBe(200);
    expect((await Users.findUserByName('Steve')).project_ids).toEqual([]);
  });

  it('silently drops unknown project ids', async () => {
    const a = await Projects.createProject('A');
    const user = await Users.findOrCreateUserByName('Steve');
    const r = await put(
      `/admin/users/${user._id.toString()}/projects`,
      { project_ids: [a._id.toString(), new ObjectId().toString()] },
      { 'X-Test-User': 'Boss' },
    );
    expect(r.status).toBe(200);
    expect((await r.json()).project_ids).toEqual([a._id.toString()]);
  });

  it('400s malformed bodies, 404s unknown users, 403s non-admins', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    const path = `/admin/users/${user._id.toString()}/projects`;
    expect((await put(path, { project_ids: 'nope' }, { 'X-Test-User': 'Boss' })).status).toBe(400);
    expect((await put(path, { project_ids: ['zzz'] }, { 'X-Test-User': 'Boss' })).status).toBe(400);
    expect(
      (
        await put(
          `/admin/users/${new ObjectId().toString()}/projects`,
          { project_ids: [] },
          { 'X-Test-User': 'Boss' },
        )
      ).status,
    ).toBe(404);
    expect((await put(path, { project_ids: [] }, { 'X-Test-User': 'Steve' })).status).toBe(403);
  });
});
