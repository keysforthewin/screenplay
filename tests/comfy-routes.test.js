// REST surface of the ComfyUI provider: /comfy/models, /comfy/models/:id/slots,
// /comfy/defaults, the per-cut preview/generate/job routes and the pre-auth
// SSE stream. comfy-mcp is faked; Mongo is the in-memory fake.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.COMFYUI_URL = '';
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-routes-test-'));
process.env.COMFY_WORK_DIR = WORK_DIR;

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
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
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => false,
}));
vi.mock('../src/mongo/auth.js', () => ({
  getSession: vi.fn(async (sid) => (sid === 'sid-ok' ? { session_id: sid, username: 'tester' } : null)),
  touchSession: vi.fn(async () => {}),
}));
const fakeImageStore = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readImageBuffer: vi.fn(async (id) => {
      const entry = fakeImageStore.get(String(id));
      return entry ? { buffer: entry, file: { _id: id, contentType: 'image/png', metadata: {} } } : null;
    }),
  };
});
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    uploadAttachmentBuffer: vi.fn(async (_pid, args) => ({ _id: new ObjectId(), filename: args.filename, metadata: {} })),
    deleteAttachment: vi.fn(async () => {}),
    deleteAttachments: vi.fn(async () => {}),
  };
});
const TEMPLATE_PATH = path.join(WORK_DIR, 'template-stub.json');
fs.writeFileSync(TEMPLATE_PATH, '{}');
vi.mock('../src/comfy/templates.js', () => ({
  ensureTemplateFile: vi.fn(async () => ({ path: TEMPLATE_PATH, local_check: { checked: true, runnable: true } })),
  ComfyTemplateNotRunnableError: class extends Error {},
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Client = await import('../src/comfy/client.js');
const Gen = await import('../src/web/comfyVideoGenerate.js');
const Routes = await import('../src/web/comfyRoutes.js');
const CutVideoRoutes = await import('../src/web/cutVideoRoutes.js');

let server, baseUrl, projectId;
beforeAll(async () => {
  const app = express();
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use((req, _res, next) => {
    req.projectId = req.get('X-Project-Id') || null;
    req.session = { username: 'tester' };
    next();
  });
  router.get('/cut/:id/video-job/:jobId/events', CutVideoRoutes.cutVideoJobEventsHandler);
  router.use('/comfy', Routes.buildComfyRouter());
  Routes.registerCutVideoRoutes(router);
  CutVideoRoutes.registerCutFalVideoRoutes(router);
  app.use('/api', router);
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  fakeDb.reset();
  fakeImageStore.clear();
  BeatLocks._clearBeatLocksForTests();
  Gen._resetComfyJobsForTests();
  Gen._setComfyRunnerOptionsForTests({ pollIntervalMs: 2, jobTimeoutMs: 5000 });
  Client._setComfyClientForTests(null);
  Routes._resetComfyRoutesCacheForTests();
  projectId = (await createProject('Comfy Routes'))._id.toString();
});

async function call(method, p, body) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'X-Project-Id': projectId, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      switch (name) {
        case 'server_info':
          return { server: { running: true, url: 'http://127.0.0.1:8188' }, hardware: { gpu: { model: 'RTX', vram_bytes: 17e9 } }, compatibility: { comfy_cli_version: '1.22.0' } };
        case 'list_workflow_slots':
          return { slots: [{ address: '398.value', type: 'STRING', current_value: 'x' }] };
        case 'upload_file':
          return { uploads: args.paths.map((p) => ({ local_path: p, cloud_name: path.basename(p), subfolder: '', type: 'input' })) };
        case 'set_workflow_slot':
          return { ok: true };
        case 'run_workflow':
          return { prompt_id: 'p-route' };
        case 'job':
          return { status: 'completed' };
        case 'fetch_outputs':
          fs.mkdirSync(args.out_dir, { recursive: true });
          fs.writeFileSync(path.join(args.out_dir, 'clip.mp4'), 'bytes');
          return {};
        default:
          return {};
      }
    },
  };
}

function newImage() {
  const img = new ObjectId();
  fakeImageStore.set(img.toString(), Buffer.from('png'));
  return img;
}

// A cut in a new scene of `beatId` (or of a new beat).
async function seedCut({ withStartFrame = true, beatId = null, prompt = 'A held medium shot. Stop when she blinks.' } = {}) {
  const beat = beatId ? { _id: beatId } : await Plots.createBeat({ projectId, name: 'B', body: 'x', characters: [], sets: [] });
  const scene = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'S' });
  return VP.createVideoPrompt({
    projectId,
    beatId: beat._id,
    sceneId: scene._id,
    title: 'c',
    prompt,
    startFrame: withStartFrame ? { image_id: newImage(), prompt: '' } : null,
  });
}

describe('GET /comfy/models', () => {
  it('reports unconfigured with the registry when COMFYUI_URL is unset', async () => {
    const r = await call('GET', '/api/comfy/models');
    expect(r.status).toBe(200);
    expect(r.json.configured).toBe(false);
    expect(r.json.reason).toMatch(/ComfyUI rendering is disabled on this server/);
    expect(r.json.server).toBeNull();
    expect(r.json.models.map((m) => m.id)).toContain('ltx-2.5-i2v');
    expect(r.json.models.find((m) => m.id === 'kling-3.0').spends_credits).toBe(true);
    expect(r.json.models[0].params.duration_seconds.address).toBeUndefined();
  });

  it('adds a cached server summary when configured', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const a = await call('GET', '/api/comfy/models');
    const b = await call('GET', '/api/comfy/models');
    expect(a.json.configured).toBe(true);
    expect(a.json.reason).toBeNull();
    expect(a.json.server).toMatchObject({ running: true, gpu: 'RTX', comfy_cli_version: '1.22.0' });
    // No COMFYUI_URL under test → nothing to probe; the shape is still there.
    expect(a.json.server.target).toEqual({ url: null, reachable: null, comfyui_version: null, error: null });
    expect(b.json.server.running).toBe(true);
    expect(client.calls.filter((c) => c.name === 'server_info')).toHaveLength(1);
  });

  it('probes the COMFYUI_URL target directly (comfy-cli only knows about a local install)', async () => {
    Client._setComfyClientForTests(fakeClient());
    Routes._resetComfyRoutesCacheForTests();
    const { config } = await import('../src/config.js');
    const prev = config.comfy.url;
    config.comfy.url = 'http://host.docker.internal:18188';
    const probed = [];
    Routes._setComfyTargetProbeForTests(async (url) => {
      probed.push(url);
      return { reachable: true, comfyui_version: '0.3.60', error: null };
    });
    try {
      const r = await call('GET', '/api/comfy/models');
      expect(probed).toEqual(['http://host.docker.internal:18188']);
      expect(r.json.server.target).toEqual({ url: 'http://host.docker.internal:18188', reachable: true, comfyui_version: '0.3.60', error: null });
    } finally {
      config.comfy.url = prev;
      Routes._setComfyTargetProbeForTests(null);
      Routes._resetComfyRoutesCacheForTests();
    }
  });

  it('GET /comfy/models/:id/slots lists the template slots (503 unconfigured, 404 unknown)', async () => {
    expect((await call('GET', '/api/comfy/models/ltx-2.5-i2v/slots')).status).toBe(503);
    expect((await call('GET', '/api/comfy/models/nope/slots')).status).toBe(404);
    Client._setComfyClientForTests(fakeClient());
    const r = await call('GET', '/api/comfy/models/ltx-2.5-i2v/slots');
    expect(r.status).toBe(200);
    expect(r.json.template).toBe('video_ltx2_5_i2v');
    expect(r.json.slots[0].address).toBe('398.value');
  });
});

describe('/comfy/defaults', () => {
  it('round-trips the model and per-model params; rejects bad shapes', async () => {
    expect((await call('GET', '/api/comfy/defaults')).json).toEqual({ model_id: null, params_by_model: {} });
    const put = await call('PUT', '/api/comfy/defaults', {
      model_id: 'ltx-2.5-i2v',
      // The length and the seed belong to one render: never remembered.
      params_by_model: { 'ltx-2.5-i2v': { duration_seconds: 6, seed: 7, megapixels: 0.5 } },
    });
    expect(put.status).toBe(200);
    expect(put.json.model_id).toBe('ltx-2.5-i2v');
    const again = await call('PUT', '/api/comfy/defaults', { params_by_model: { 'wan-2.2-14b-i2v': { steps: 6 } } });
    expect(again.json.params_by_model).toEqual({ 'ltx-2.5-i2v': { megapixels: 0.5 }, 'wan-2.2-14b-i2v': { steps: 6 } });
    const cleared = await call('PUT', '/api/comfy/defaults', { model_id: null, params_by_model: { 'wan-2.2-14b-i2v': null } });
    expect(cleared.json).toEqual({ model_id: null, params_by_model: { 'ltx-2.5-i2v': { megapixels: 0.5 } } });
    expect((await call('PUT', '/api/comfy/defaults', {})).status).toBe(400);
    expect((await call('PUT', '/api/comfy/defaults', { params_by_model: { x: { nested: {} } } })).status).toBe(400);
  });
});

describe('cut render routes', () => {
  it('maps the typed errors: 503 unconfigured, 404 cut, 400 model/params, 402 consent', async () => {
    const cut = await seedCut();
    expect((await call('POST', `/api/cut/${cut._id}/video/generate`, { model_id: 'ltx-2.5-i2v' })).status).toBe(503);
    Client._setComfyClientForTests(fakeClient());
    expect((await call('POST', `/api/cut/${new ObjectId()}/video/generate`, { model_id: 'ltx-2.5-i2v' })).status).toBe(404);
    expect((await call('POST', `/api/cut/${cut._id}/video/generate`, {})).status).toBe(400);
    expect((await call('POST', `/api/cut/${cut._id}/video/generate`, { model_id: 'nope' })).status).toBe(400);
    const consent = await call('POST', `/api/cut/${cut._id}/video/generate`, { model_id: 'seedance-2.5-i2v-1080p' });
    expect(consent.status).toBe(402);
    expect(consent.json.code).toBe('SPEND_CONSENT_REQUIRED');
    const bad = await call('POST', `/api/cut/${cut._id}/video/preview`, { model_id: 'ltx-2.5-i2v', params: { fps: 'fast' } });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0]).toContain('fps');
    const noFrame = await seedCut({ withStartFrame: false });
    const nf = await call('POST', `/api/cut/${noFrame._id}/video/preview`, { model_id: 'ltx-2.5-i2v' });
    expect(nf.status).toBe(400);
    expect(nf.json.code).toBe('MISSING_START_FRAME');
    // A cut carries no dialogue recording and no reference images of its own:
    // the lip-sync model and the reference-to-video model are both 400s.
    const lip = await call('POST', `/api/cut/${cut._id}/video/preview`, { model_id: 'ltx-2.3-ia2v' });
    expect(lip.status).toBe(400);
    expect(lip.json.code).toBe('INVALID_COMFY_PARAMS');
    expect(lip.json.error).toMatch(/dialogue recording/);
    const r2v = await call('POST', `/api/cut/${cut._id}/video/generate`, { model_id: 'seedance-2.0-r2v', confirm_spend: true });
    expect(r2v.status).toBe(400);
    expect(r2v.json.code).toBe('MISSING_REFERENCE_IMAGES');
  });

  it('preview returns the assembled prompt and overrides without touching ComfyUI', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const cut = await seedCut();
    const r = await call('POST', `/api/cut/${cut._id}/video/preview`, { model_id: 'ltx-2.5-i2v', params: { duration_seconds: 3 } });
    expect(r.status).toBe(200);
    expect(r.json.prompt).toBe('A held medium shot. Stop when she blinks.');
    expect(r.json).not.toHaveProperty('timing');
    expect(r.json).not.toHaveProperty('audio');
    expect(r.json.overrides.find((o) => o.address === '398.value_2').value).toBe(3);
    expect(r.json.model.id).toBe('ltx-2.5-i2v');
    expect(client.calls).toHaveLength(0);
  });

  it('generate returns 202, the job snapshot is readable, and the SSE stream needs a valid session', async () => {
    Client._setComfyClientForTests(fakeClient());
    const cut = await seedCut();
    const r = await call('POST', `/api/cut/${cut._id}/video/generate`, { model_id: 'ltx-2.5-i2v', params: { duration_seconds: 3 } });
    expect(r.status).toBe(202);
    const jobId = r.json.job_id;
    expect(jobId).toMatch(/^[a-f0-9]{24}$/);

    const missing = await fetch(`${baseUrl}/api/cut/${cut._id}/video-job/${jobId}/events`);
    expect(missing.status).toBe(401);
    const bad = await fetch(`${baseUrl}/api/cut/${cut._id}/video-job/${jobId}/events?session_id=nope`);
    expect(bad.status).toBe(401);
    const unknown = await fetch(`${baseUrl}/api/cut/${cut._id}/video-job/${new ObjectId()}/events?session_id=sid-ok`);
    expect(unknown.status).toBe(404);

    const es = await fetch(`${baseUrl}/api/cut/${cut._id}/video-job/${jobId}/events?session_id=sid-ok`);
    expect(es.status).toBe(200);
    expect(es.headers.get('content-type')).toContain('text/event-stream');
    const text = await es.text(); // the job finishes quickly, so the stream closes
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"provider":"comfy"');

    const until = Date.now() + 3000;
    let snap;
    for (;;) {
      snap = (await call('GET', `/api/cut/${cut._id}/video-job/${jobId}`)).json.job;
      if (snap.status === 'done' || snap.status === 'error' || Date.now() > until) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(snap.status).toBe('done');
    expect(snap.video_file_id).toMatch(/^[a-f0-9]{24}$/);
    expect((await call('GET', `/api/cut/${cut._id}/video-job/${new ObjectId()}`)).status).toBe(404);
  });
  it('queues a second cut of the same beat (no beat lock), refuses a duplicate for one cut (409 + job id), and cancels only queued jobs', async () => {
    let open;
    const client = fakeClient();
    const inner = client.callTool.bind(client);
    client.callTool = async (name, args) => {
      if (name === 'run_workflow') await new Promise((r) => (open = r));
      return inner(name, args);
    };
    Client._setComfyClientForTests(client);
    const cut = await seedCut();
    const cut2 = await seedCut({ beatId: cut.beat_id, prompt: 'Close on the cup. Stop when it stops.' });

    const a = await call('POST', `/api/cut/${cut._id}/video/generate`, { model_id: 'ltx-2.5-i2v', params: { duration_seconds: 3 } });
    expect(a.status).toBe(202);
    const dup = await call('POST', `/api/cut/${cut._id}/video/generate`, { model_id: 'ltx-2.5-i2v', params: { duration_seconds: 3 } });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ code: 'CUT_BUSY', job_id: a.json.job_id });
    const b = await call('POST', `/api/cut/${cut2._id}/video/generate`, { model_id: 'ltx-2.5-i2v', params: { duration_seconds: 3 } });
    expect(b.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(BeatLocks.isBeatLocked(cut.beat_id)).toBe(false);

    expect((await call('POST', `/api/cut/${cut2._id}/video/job/${new ObjectId()}/cancel`)).status).toBe(404);
    expect((await call('POST', `/api/cut/${cut._id}/video/job/${b.json.job_id}/cancel`)).status).toBe(404); // wrong cut
    expect((await call('POST', `/api/cut/${cut._id}/video/job/${a.json.job_id}/cancel`)).status).toBe(409); // running
    const cancelled = await call('POST', `/api/cut/${cut2._id}/video/job/${b.json.job_id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.job).toMatchObject({ status: 'error', cancelled: true });
    open();
  });
});
