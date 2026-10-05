// /api/admin/models — per-feature Claude model selection (admin only).
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

const { config } = await import('../src/config.js');
const { modelFor, setModelOverrides } = await import('../src/llm/modelSlots.js');
const { loadModelOverrides } = await import('../src/mongo/appSettings.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

// Fake Models API: an async-iterable page with one model the static catalog lacks.
_setAnthropicClientForTests({
  models: {
    list: async () => ({
      async *[Symbol.asyncIterator]() {
        yield { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' };
        yield { id: 'claude-brand-new-9', display_name: 'Claude Brand New 9' };
      },
    }),
  },
});

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
  setModelOverrides({});
  process.env.ADMIN_USERNAME = 'Boss';
});
afterEach(() => {
  process.env.ADMIN_USERNAME = '';
  process.env.LLM_HARNESS_ENABLED = '';
});

const admin = { 'x-test-user': 'boss' };
const get = (path, headers = {}) => fetch(`${baseUrl}/api${path}`, { headers });
const put = (path, body, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('GET /api/admin/models', () => {
  it('lists every slot with its env default and merges the live catalog', async () => {
    const res = await get('/admin/models', admin);
    expect(res.status).toBe(200);
    const json = await res.json();
    const keys = json.slots.map((s) => s.key);
    expect(keys).toEqual(['agent', 'writer', 'dialog', 'storyboard', 'critique', 'artwork_review', 'analysis', 'enhancer']);
    const writer = json.slots.find((s) => s.key === 'writer');
    expect(writer.override).toBeNull();
    expect(writer.default).toBe(config.anthropic.model);
    expect(writer.effective).toBe(config.anthropic.model);
    expect(json.live_catalog).toBe(true);
    expect(json.catalog.some((m) => m.id === 'claude-brand-new-9')).toBe(true);
    expect(json.catalog.some((m) => m.id === 'claude-haiku-4-5')).toBe(true);
  });

  it('is admin-only', async () => {
    const res = await get('/admin/models', { 'x-test-user': 'Member' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/admin/models', () => {
  it('persists overrides, applies them in-process, and survives a reload from Mongo', async () => {
    const res = await put('/admin/models', { slots: { writer: 'claude-fable-5-1', enhancer: 'claude-haiku-4-5' } }, admin);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slots.find((s) => s.key === 'writer').effective).toBe('claude-fable-5-1');
    expect(json.slots.find((s) => s.key === 'enhancer').effective).toBe('claude-haiku-4-5');
    expect(json.slots.find((s) => s.key === 'dialog').override).toBeNull();
    expect(json.updated_by).toBe('boss');
    expect(modelFor('writer')).toBe('claude-fable-5-1');
    expect(modelFor('enhancer')).toBe('claude-haiku-4-5');

    // Simulate a restart: wipe memory, reload from the stored doc.
    setModelOverrides({});
    expect(modelFor('writer')).toBe(config.anthropic.model);
    await loadModelOverrides();
    expect(modelFor('writer')).toBe('claude-fable-5-1');
  });

  it('merges partially and null reverts a slot to its default', async () => {
    await put('/admin/models', { slots: { writer: 'claude-opus-5', dialog: 'claude-opus-5' } }, admin);
    const res = await put('/admin/models', { slots: { writer: null } }, admin);
    const json = await res.json();
    expect(json.slots.find((s) => s.key === 'writer').override).toBeNull();
    expect(json.slots.find((s) => s.key === 'dialog').override).toBe('claude-opus-5');
    expect(modelFor('writer')).toBe(config.anthropic.model);
  });

  it('rejects unknown slots, malformed ids and non-object bodies', async () => {
    expect((await put('/admin/models', { slots: { bogus: 'claude-opus-5' } }, admin)).status).toBe(400);
    expect((await put('/admin/models', { slots: { writer: 'not a model!' } }, admin)).status).toBe(400);
    expect((await put('/admin/models', { slots: ['claude-opus-5'] }, admin)).status).toBe(400);
    expect(modelFor('writer')).toBe(config.anthropic.model);
  });

  it('is admin-only', async () => {
    const res = await put('/admin/models', { slots: { writer: 'claude-opus-5' } }, { 'x-test-user': 'Member' });
    expect(res.status).toBe(403);
    expect(modelFor('writer')).toBe(config.anthropic.model);
  });
});

describe('coding-agent providers', () => {
  const target = { provider: 'claude-code', model: 'opus', effort: 'high' };

  it('GET reports the harness providers and whether they are enabled', async () => {
    let json = await (await get('/admin/models', admin)).json();
    expect(json.harness.enabled).toBe(false);
    expect(json.harness.providers.map((p) => p.id)).toEqual(['claude-code', 'codex']);
    expect(json.harness.providers[0].efforts).toContain('max');
    process.env.LLM_HARNESS_ENABLED = '1';
    json = await (await get('/admin/models', admin)).json();
    expect(json.harness.enabled).toBe(true);
  });

  it('PUT refuses a harness target when the server has them disabled', async () => {
    const res = await put('/admin/models', { slots: { dialog: target } }, admin);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/disabled/);
    expect(modelFor('dialog')).toBe(config.anthropic.model);
  });

  it('PUT stores a harness target, encodes it in modelFor, and survives a reload', async () => {
    process.env.LLM_HARNESS_ENABLED = '1';
    const res = await put('/admin/models', { slots: { dialog: target, agent: { provider: 'codex', model: '', effort: null } } }, admin);
    expect(res.status).toBe(200);
    const json = await res.json();
    const dialog = json.slots.find((s) => s.key === 'dialog');
    expect(dialog.provider).toBe('claude-code');
    expect(dialog.harness_model).toBe('opus');
    expect(dialog.effort).toBe('high');
    expect(dialog.effective).toBe('claude-code:opus:high');
    expect(modelFor('agent')).toBe('codex:default:default');

    setModelOverrides({});
    await loadModelOverrides();
    expect(modelFor('dialog')).toBe('claude-code:opus:high');

    // The same stored doc on a server without the flag falls back to the API default.
    process.env.LLM_HARNESS_ENABLED = '';
    expect(modelFor('dialog')).toBe(config.anthropic.model);
  });

  it('PUT rejects unknown providers and efforts', async () => {
    process.env.LLM_HARNESS_ENABLED = '1';
    expect((await put('/admin/models', { slots: { dialog: { provider: 'gemini' } } }, admin)).status).toBe(400);
    expect((await put('/admin/models', { slots: { dialog: { provider: 'codex', effort: 'ludicrous' } } }, admin)).status).toBe(400);
    expect((await put('/admin/models', { slots: { dialog: { provider: 'codex', model: 'Has Space' } } }, admin)).status).toBe(400);
  });
});
