// GET /api/image-models — the catalog behind the SPA's image-model picker —
// plus its refresh control endpoints.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

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

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}

describe('GET /api/image-models', () => {
  it('still returns the curated per-model info the bulk-generate dialog reads', async () => {
    const { status, json } = await getJson('/api/image-models');

    expect(status).toBe(200);
    expect(Array.isArray(json.models)).toBe(true);
    expect(json.models.map((m) => m.id)).toContain('nano-banana-pro');
    expect(json.models[0]).toHaveProperty('maxReferenceImages');
  });

  it('adds the full fal catalog with prices and the default model', async () => {
    const { json } = await getJson('/api/image-models');

    expect(Array.isArray(json.catalog)).toBe(true);
    expect(json.catalog.length).toBeGreaterThan(50);
    expect(json.default_model_id).toBe('nano-banana-pro');
    expect(json).toHaveProperty('catalog_generated_at');
    expect(json).toHaveProperty('configured');

    const priced = json.catalog.filter((m) => m.price?.display);
    expect(priced.length).toBeGreaterThan(0);
  });

  it('lists the hand-wired models first so the tuned paths stay one click away', async () => {
    const { json } = await getJson('/api/image-models');
    expect(json.catalog[0].is_wired).toBe(true);
  });

  it('only offers image-generation categories', async () => {
    const { json } = await getJson('/api/image-models');
    const categories = new Set(json.catalog.map((m) => m.category));
    expect([...categories].sort()).toEqual(['image-to-image', 'text-to-image']);
  });

  it('reports wired models as reference-capable, since the shortcut routes to /edit', async () => {
    const { json } = await getJson('/api/image-models');
    const nano = json.catalog.find((m) => m.id === 'nano-banana-pro');
    expect(nano.accepts_references).toBe(true);
    expect(nano.max_references).toBeGreaterThan(0);
  });
});

describe('image-model catalog refresh', () => {
  it('reports refresh state', async () => {
    const { status, json } = await getJson('/api/image-models/refresh');
    expect(status).toBe(200);
    expect(json).toHaveProperty('running');
  });

  it('starts the image job, or reports fal unconfigured', async () => {
    // Whether FAL_KEY is present depends on the developer's .env, so accept
    // either contract — but never let a POST spawn the real multi-minute
    // scrape: the stubbed runner keeps this test hermetic either way.
    const { _setScriptRunnerForTests, getCatalogRefreshState } = await import(
      '../src/fal/catalogRefresh.js'
    );
    let started = null;
    _setScriptRunnerForTests((script) => {
      started = script;
      return Promise.resolve();
    });
    try {
      const res = await fetch(`${baseUrl}/api/image-models/refresh`, { method: 'POST' });
      const json = await res.json();
      if (res.status === 503) {
        expect(json.error).toMatch(/FAL_KEY/);
        expect(started).toBeNull();
      } else {
        expect(res.status).toBe(200);
        expect(json.started).toBe(true);
        expect(started).toContain('playground');
        // The video catalog must not be touched by an image refresh.
        expect(getCatalogRefreshState('video').running).toBe(false);
      }
    } finally {
      _setScriptRunnerForTests(null);
    }
  });
});
