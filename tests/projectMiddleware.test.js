// resolveProject() Express middleware: X-Project-Id header, ?project_id= query
// fallback (SSE), default-project fallback, 404 on unknown ids. Tested as a
// plain async function with stub req/res/next (no HTTP server needed).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resolveProject } = await import('../src/web/projectMiddleware.js');
const Projects = await import('../src/mongo/projects.js');

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function stubReq({ header, query } = {}) {
  const headers = header ? { 'x-project-id': header } : {};
  return {
    headers,
    query: query || {},
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

describe('resolveProject middleware', () => {
  beforeEach(() => fakeDb.reset());

  it('resolves a known X-Project-Id header into req.projectId/req.projectTitle', async () => {
    const p = await Projects.createProject('Western');
    const req = stubReq({ header: p._id.toString() });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.projectId).toBe(p._id.toString());
    expect(req.projectTitle).toBe('Western');
  });

  it('falls back to ?project_id= when the header is missing (SSE / EventSource)', async () => {
    const p = await Projects.createProject('Western');
    const req = stubReq({ query: { project_id: p._id.toString() } });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.projectId).toBe(p._id.toString());
    expect(req.projectTitle).toBe('Western');
  });

  it('prefers the header over the query when both are present', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const req = stubReq({
      header: a._id.toString(),
      query: { project_id: b._id.toString() },
    });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(req.projectId).toBe(a._id.toString());
  });

  it('uses the default project when neither header nor query is present', async () => {
    const req = stubReq();
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Empty collection → getDefaultProject lazily creates "Screenplay".
    expect(req.projectTitle).toBe('Screenplay');
    expect(req.projectId).toMatch(/^[a-f0-9]{24}$/);
  });

  it('404s {error:"unknown project"} for an unknown 24-hex id', async () => {
    await Projects.createProject('Western');
    const req = stubReq({ header: new ObjectId().toString() });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'unknown project' });
  });

  it('404s for a malformed (non-hex) id', async () => {
    const req = stubReq({ header: 'not-a-project-id' });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'unknown project' });
  });

  it('skips resolution for GET /projects even with a stale/invalid X-Project-Id', async () => {
    // Carried improvement 3: a stale header for a vanished project must not
    // block the recovery fetch that lists all projects.
    const { ObjectId } = await import('mongodb');
    const req = {
      method: 'GET',
      path: '/projects',
      headers: { 'x-project-id': new ObjectId().toString() },
      query: {},
      get(name) { return this.headers[String(name).toLowerCase()]; },
    };
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // req.projectId is not set — the route handler doesn't need it.
    expect(req.projectId).toBeUndefined();
  });
});
