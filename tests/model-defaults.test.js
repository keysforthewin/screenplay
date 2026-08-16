// Per-project default generation models:
//   src/mongo/projectSettings.js (get/setModelDefaults)
//   GET/PUT /api/model-defaults (entityRoutes)
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
const Settings = await import('../src/mongo/projectSettings.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Model Defaults Project'))._id.toString();
});

const get = () => fetch(`${baseUrl}/api/model-defaults`);
const put = (body) =>
  fetch(`${baseUrl}/api/model-defaults`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const ALL_NULL = {
  image_with_refs: null,
  image_prompt_only: null,
  video_start_end: null,
  video_start_only: null,
  lipsync: null,
};

describe('projectSettings model defaults', () => {
  it('returns every slot as null when nothing is stored', async () => {
    expect(await Settings.getModelDefaults(projectId)).toEqual(ALL_NULL);
  });

  it('merges partial patches and trims values', async () => {
    await Settings.setModelDefaults(projectId, { image_with_refs: ' fal-ai/nano-banana/edit ' });
    const merged = await Settings.setModelDefaults(projectId, { lipsync: 'fal-ai/some-avatar' });
    expect(merged).toEqual({
      ...ALL_NULL,
      image_with_refs: 'fal-ai/nano-banana/edit',
      lipsync: 'fal-ai/some-avatar',
    });
  });

  it('clears a slot with null or empty string', async () => {
    await Settings.setModelDefaults(projectId, { video_start_end: 'fal-ai/kling' });
    expect((await Settings.setModelDefaults(projectId, { video_start_end: null })).video_start_end)
      .toBeNull();
    await Settings.setModelDefaults(projectId, { video_start_end: 'fal-ai/kling' });
    expect((await Settings.setModelDefaults(projectId, { video_start_end: '' })).video_start_end)
      .toBeNull();
  });

  it('rejects unknown slots and bad values', async () => {
    await expect(Settings.setModelDefaults(projectId, { nope: 'x' }))
      .rejects.toThrow(/unknown model default/);
    await expect(Settings.setModelDefaults(projectId, { lipsync: 42 }))
      .rejects.toThrow(/invalid model id/);
    await expect(Settings.setModelDefaults(projectId, { lipsync: 'x'.repeat(301) }))
      .rejects.toThrow(/invalid model id/);
  });

  it('throws without a projectId', async () => {
    await expect(Settings.getModelDefaults('')).rejects.toThrow('projectId required');
    await expect(Settings.setModelDefaults(null, {})).rejects.toThrow('projectId required');
  });

  it('scopes defaults per project', async () => {
    const other = (await createProject('Other Project'))._id.toString();
    await Settings.setModelDefaults(projectId, { image_prompt_only: 'fal-ai/flux-2-pro' });
    expect((await Settings.getModelDefaults(other)).image_prompt_only).toBeNull();
  });
});

describe('GET/PUT /api/model-defaults', () => {
  it('round-trips a patch through the endpoints', async () => {
    let r = await get();
    expect(r.status).toBe(200);
    expect((await r.json()).model_defaults).toEqual(ALL_NULL);

    r = await put({ image_with_refs: 'fal-ai/nano-banana/edit', video_start_only: 'fal-ai/kling' });
    expect(r.status).toBe(200);
    expect((await r.json()).model_defaults).toEqual({
      ...ALL_NULL,
      image_with_refs: 'fal-ai/nano-banana/edit',
      video_start_only: 'fal-ai/kling',
    });

    r = await get();
    expect((await r.json()).model_defaults.image_with_refs).toBe('fal-ai/nano-banana/edit');
  });

  it('400s on unknown slots and non-object bodies', async () => {
    let r = await put({ bogus: 'x' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/unknown model default/);

    r = await put(['not', 'an', 'object']);
    expect(r.status).toBe(400);

    r = await put({ lipsync: 12 });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/invalid model id/);
  });
});
