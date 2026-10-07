// The default video renderer (Admin → Video renderer): storage in
// app_settings, the resolver every video route falls back to, the admin
// GET/PUT routes, and the session-level read the Scenes-tab dialogs use.
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

const Settings = await import('../src/mongo/appSettings.js');
const VD = await import('../src/web/videoDefault.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  fakeDb.reset();
  process.env.ADMIN_USERNAME = 'Boss';
});
afterEach(() => { process.env.ADMIN_USERNAME = ''; });

const admin = { 'x-test-user': 'boss' };
const get = (path, headers = {}) => fetch(`${baseUrl}/api${path}`, { headers });
const put = (path, body, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('storage', () => {
  it('is empty until set, stores provider + model + params, and clears', async () => {
    expect(await Settings.getVideoDefaultSettings()).toMatchObject({ provider: null, model_id: null, params: {} });
    const d = await Settings.setVideoDefaultSettings({ provider: 'comfy', model_id: ' wan-2.2-14b-flf2v ', params: { steps: 20 } }, { updatedBy: 'boss' });
    expect(d).toMatchObject({ provider: 'comfy', model_id: 'wan-2.2-14b-flf2v', params: { steps: 20 }, updated_by: 'boss' });
    expect(await Settings.setVideoDefaultSettings(null)).toMatchObject({ provider: null, model_id: null });
    await expect(Settings.setVideoDefaultSettings({ provider: 'nope', model_id: 'x' })).rejects.toThrow(/provider/);
  });
});

describe('resolveVideoRenderer', () => {
  it('refuses when nothing is named and no default is set', async () => {
    await expect(VD.resolveVideoRenderer({})).rejects.toMatchObject({ code: 'NO_VIDEO_DEFAULT', status: 400 });
  });

  it('keeps an explicit model (inferring the provider from the ComfyUI registry) and falls back to the default otherwise', async () => {
    await Settings.setVideoDefaultSettings({ provider: 'comfy', model_id: 'wan-2.2-14b-flf2v', params: { steps: 20 } });
    expect(await VD.resolveVideoRenderer({ modelId: 'ltx-2.5-i2v' })).toMatchObject({ provider: 'comfy', modelId: 'ltx-2.5-i2v', fromDefault: false });
    expect(await VD.resolveVideoRenderer({ modelId: 'fal-ai/some-endpoint' })).toMatchObject({ provider: 'fal', fromDefault: false });
    expect(await VD.resolveVideoRenderer({})).toMatchObject({ provider: 'comfy', modelId: 'wan-2.2-14b-flf2v', params: { steps: 20 }, fromDefault: true });
    expect(await VD.resolveVideoRenderer({ provider: 'comfy' })).toMatchObject({ modelId: 'wan-2.2-14b-flf2v' });
    // A route for the OTHER provider cannot borrow a ComfyUI default.
    await expect(VD.resolveVideoRenderer({ provider: 'fal' })).rejects.toMatchObject({ code: 'NO_VIDEO_DEFAULT' });
  });
});

describe('/api/admin/video-default', () => {
  it('is admin-only', async () => {
    expect((await get('/admin/video-default', { 'x-test-user': 'Member' })).status).toBe(403);
    expect((await put('/admin/video-default', { provider: 'comfy', model_id: 'wan-2.2-14b-flf2v' }, { 'x-test-user': 'Member' })).status).toBe(403);
  });

  it('lists the ComfyUI registry, stores a known model, refuses an unknown one, and clears', async () => {
    let res = await get('/admin/video-default', admin);
    expect(res.status).toBe(200);
    let json = await res.json();
    expect(json.default.model_id).toBeNull();
    expect(json.comfy_models.some((m) => m.id === 'wan-2.2-14b-flf2v' && m.builtin)).toBe(true);

    res = await put('/admin/video-default', { provider: 'comfy', model_id: 'nope-model' }, admin);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown ComfyUI model/);

    res = await put('/admin/video-default', { provider: 'comfy', model_id: 'wan-2.2-14b-flf2v' }, admin);
    expect(res.status).toBe(200);
    json = await res.json();
    expect(json.default).toMatchObject({ provider: 'comfy', model_id: 'wan-2.2-14b-flf2v', label: 'Wan 2.2 14B (first → last frame)', known: true, spends_credits: false, updated_by: 'boss' });

    // The effective default is readable outside /admin (the Scenes tab's
    // Generate all videos button renders with it); with ADMIN_USERNAME set a
    // member needs a project grant to reach any project route, so the admin
    // stands in for a plain session here.
    res = await get('/video-default', admin);
    expect(res.status).toBe(200);
    expect((await res.json()).default).toMatchObject({ model_id: 'wan-2.2-14b-flf2v', spends_credits: false });

    res = await put('/admin/video-default', { model_id: null }, admin);
    expect((await res.json()).default.model_id).toBeNull();
  });
});
