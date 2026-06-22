// HTTP route test for GET /api/image-models
//
// Verifies the endpoint returns the full image-model metadata registry
// with all expected fields and known model ids.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const { createProject } = await import('../src/mongo/projects.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let projectId;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function getJson(path, headers = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'GET',
    headers: {
      'x-project-id': projectId,
      ...headers,
    },
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

describe('GET /api/image-models', () => {
  it('returns every model with full metadata', async () => {
    const { status, json } = await getJson('/image-models');

    expect(status).toBe(200);
    expect(Array.isArray(json.models)).toBe(true);

    const ids = json.models.map((m) => m.id);
    expect(ids).toContain('nano-banana-pro');
    expect(ids).toContain('flux-2-klein');

    const klein = json.models.find((m) => m.id === 'flux-2-klein');
    expect(klein.maxReferenceImages).toBe(4);
    expect(klein.inputFormats).toEqual(['PNG', 'JPEG', 'WebP']);
  });
});
