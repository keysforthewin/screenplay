// /api/admin/comfy/* — gallery search, template auto-map, and the registered
// ComfyUI models (admin only; 503 without a ComfyUI except the stored list).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => {
    req.session = { username: req.headers['x-test-user'] || 'Member' };
    next();
  },
}));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const TEMPLATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-comfy-'));
vi.mock('../src/comfy/templates.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    ensureTemplateFile: vi.fn(async (model) => {
      const p = path.join(TEMPLATE_DIR, `${model.template}.json`);
      fs.writeFileSync(p, '{}');
      if (model.template === 'video_broken') throw new mod.ComfyTemplateNotRunnableError('video_broken', { checked: true, runnable: false, errors: ['missing node X'] });
      return { path: p, local_check: { checked: true, runnable: true } };
    }),
    templateFilePath: (name) => path.join(TEMPLATE_DIR, `${name}.json`),
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const FULL = JSON.parse(readFileSync(path.join(here, 'fixtures/comfy/slots-full.json'), 'utf8'));

const Client = await import('../src/comfy/client.js');
const Models = await import('../src/comfy/videoModels.js');
const Settings = await import('../src/mongo/appSettings.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

function fakeClient() {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      switch (name) {
        case 'search_templates':
          return {
            templates: [
              { name: 'video_ltx2_3_ia2v', title: 'LTX-2.3 image+audio to video', tags: ['video'], local_check: { checked: true, runnable: true } },
              { name: 'api_kling_3', title: 'Kling 3 (API)', tags: ['API', 'video'] },
            ],
          };
        case 'get_template':
          if (args.name === 'nope') throw new Client.ComfyToolError('get_template', 'unknown template');
          return { name: args.name, title: 'LTX-2.3 image+audio to video', description: 'Lip-sync from a still and a recording.', tags: ['video'], local_check: { checked: true, runnable: true } };
        case 'list_workflow_slots':
          return { slots: FULL.video_ltx2_3_ia2v.slots };
        case 'list_workflow_notes':
          return { notes: [{ text: 'Use 24 fps.' }] };
        default:
          return {};
      }
    },
  };
}

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(TEMPLATE_DIR, { recursive: true, force: true });
});
beforeEach(() => {
  fakeDb.reset();
  Models.registerComfyVideoModels([]);
  Client._setComfyClientForTests(null);
  process.env.ADMIN_USERNAME = 'Boss';
});
afterEach(() => { process.env.ADMIN_USERNAME = ''; Client._setComfyClientForTests(null); });

const admin = { 'x-test-user': 'boss' };
const req = (method, p, body, headers = admin) =>
  fetch(`${baseUrl}/api${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

describe('/api/admin/comfy', () => {
  it('is admin-only and 503 for gallery calls without a ComfyUI, while the stored list still answers', async () => {
    expect((await req('GET', '/admin/comfy/models', undefined, { 'x-test-user': 'Member' })).status).toBe(403);
    const list = await json(await req('GET', '/admin/comfy/models'));
    expect(list.status).toBe(200);
    expect(list.body.registered).toEqual([]);
    expect(list.body.builtin_ids).toContain('ltx-2.3-ia2v');
    const search = await json(await req('GET', '/admin/comfy/templates?query=ltx'));
    expect(search.status).toBe(503);
    expect(search.body.code).toBe('COMFY_NOT_CONFIGURED');
    expect((await req('GET', '/admin/comfy/templates/video_ltx2_3_ia2v')).status).toBe(503);
  });

  it('searches the gallery (local-only filter) and maps a template into a proposal with slots and notes', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const all = await json(await req('GET', '/admin/comfy/templates?query=ltx'));
    expect(all.status).toBe(200);
    expect(all.body.templates.map((t) => t.name)).toEqual(['video_ltx2_3_ia2v', 'api_kling_3']);
    expect(all.body.templates[1].api).toBe(true);
    const local = await json(await req('GET', '/admin/comfy/templates?query=ltx&exclude_api=1'));
    expect(local.body.templates.map((t) => t.name)).toEqual(['video_ltx2_3_ia2v']);

    const detail = await json(await req('GET', '/admin/comfy/templates/video_ltx2_3_ia2v'));
    expect(detail.status).toBe(200);
    expect(detail.body.template.runnable).toBe(true);
    expect(detail.body.slots).toHaveLength(83);
    expect(detail.body.notes).toEqual([{ text: 'Use 24 fps.' }]);
    expect(detail.body.proposal.params.prompt.address).toBe('340.value');
    expect(detail.body.proposal.audioSlots).toEqual([{ address: '276.audio', role: 'dialogue' }]);
    expect(detail.body.existing).toBeNull();
    expect((await req('GET', '/admin/comfy/templates/nope')).status).toBe(404);
    expect((await req('GET', '/admin/comfy/templates/bad%20name')).status).toBe(400);
  });

  it('a template that is not runnable here still maps (the check is shown, not enforced)', async () => {
    Client._setComfyClientForTests(fakeClient());
    const detail = await json(await req('GET', '/admin/comfy/templates/video_broken'));
    expect(detail.status).toBe(200);
    expect(detail.body.local_check).toMatchObject({ checked: true, runnable: false });
    expect(detail.body.template.runnable).toBe(false);
    expect(detail.body.proposal.template).toBe('video_broken');
  });

  it('PUT validates against the live slot listing, stores, applies live; DELETE removes registered models only', async () => {
    Client._setComfyClientForTests(fakeClient());
    const detail = await json(await req('GET', '/admin/comfy/templates/video_ltx2_3_ia2v'));
    const proposal = { ...detail.body.proposal, id: 'my-ltx-lipsync', label: 'My LTX lip-sync' };

    const bad = await json(await req('PUT', '/admin/comfy/models/my-ltx-lipsync', { ...proposal, params: { ...proposal.params, prompt: { address: '1.nope', type: 'string' } } }));
    expect(bad.status).toBe(400);
    expect(bad.body.errors.join(' ')).toMatch(/1\.nope is not a slot/);
    expect((await json(await req('PUT', '/admin/comfy/models/ltx-2.5-i2v', proposal))).status).toBe(400);
    expect((await json(await req('PUT', '/admin/comfy/models/other-id', proposal))).body.error).toMatch(/must match/);

    const ok = await json(await req('PUT', '/admin/comfy/models/my-ltx-lipsync', proposal));
    expect(ok.status).toBe(200);
    expect(ok.body.model).toMatchObject({ id: 'my-ltx-lipsync', registered: true, template: 'video_ltx2_3_ia2v' });
    expect(ok.body.model.inputs.audio).toBe('required');
    expect(Models.getComfyVideoModel('my-ltx-lipsync')?.params.prompt.address).toBe('340.value');
    expect((await Settings.getComfyModelSettings()).models.map((m) => m.id)).toEqual(['my-ltx-lipsync']);

    // Visible to the render dialogs through the shared registry.
    const models = await json(await req('GET', '/comfy/models'));
    expect(models.body.models.some((m) => m.id === 'my-ltx-lipsync' && m.registered)).toBe(true);

    // Boot reload from the stored doc.
    Models.registerComfyVideoModels([]);
    await Settings.loadComfyModelOverrides();
    expect(Models.getComfyVideoModel('my-ltx-lipsync')).toBeTruthy();

    expect((await req('DELETE', '/admin/comfy/models/ltx-2.5-i2v')).status).toBe(400);
    expect((await req('DELETE', '/admin/comfy/models/unknown')).status).toBe(404);
    const del = await json(await req('DELETE', '/admin/comfy/models/my-ltx-lipsync'));
    expect(del.status).toBe(200);
    expect(del.body.registered).toEqual([]);
    expect(Models.getComfyVideoModel('my-ltx-lipsync')).toBeNull();
  });
});
