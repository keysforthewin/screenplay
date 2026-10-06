// "Generate all videos" (src/web/cutVideoBatch.js) and "Download all videos"
// (src/web/cutVideoJoin.js) with their routes (src/web/cutBatchRoutes.js).
// The per-cut render jobs are replaced by a fake provider; ffmpeg runs for
// real in one test when the binary is on PATH and is faked in the rest.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => { req.session = { username: 'tester' }; next(); },
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

// video_file_id → a file on disk the join copies to its own tmp path.
const clipFiles = new Map();
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    streamAttachmentToTmp: vi.fn(async (id) => {
      const src = clipFiles.get(String(id));
      if (!src) throw new Error(`Attachment not found: ${id}`);
      const dest = path.join(os.tmpdir(), `cut-batch-test-${String(id)}-${Math.random().toString(36).slice(2, 8)}.mp4`);
      await fsp.copyFile(src, dest);
      return { path: dest, file: { _id: id } };
    }),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const Batch = await import('../src/web/cutVideoBatch.js');
const Join = await import('../src/web/cutVideoJoin.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

let server, baseUrl, projectId, scratch;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'cut-batch-test-'));
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fsp.rm(scratch, { recursive: true, force: true });
});

// A fake render provider: every started job is recorded; the test settles it.
let provider;
function makeProvider({ failPreflight = null } = {}) {
  const jobs = new Map();
  const listeners = new Map();
  const p = {
    started: [],
    opts: null,
    jobs,
    settle(cutId, status = 'done', error = null) {
      const job = [...jobs.values()].find((j) => j.owner_id === cutId && j.status === 'running');
      if (!job) throw new Error(`no running job for ${cutId}`);
      job.status = status;
      job.error = error;
      for (const cb of listeners.get(job.job_id) || []) cb({ ...job });
    },
    factory: async (opts) => {
      p.opts = opts;
      return {
        preflight: async () => { if (failPreflight) throw failPreflight; },
        start: async (cutId) => {
          if (p.failStart?.[cutId]) throw p.failStart[cutId];
          const job = { job_id: new ObjectId().toString(), owner_id: cutId, status: 'running', error: null };
          jobs.set(job.job_id, job);
          p.started.push(cutId);
          return { job_id: job.job_id };
        },
        get: (jobId) => (jobs.has(jobId) ? { ...jobs.get(jobId) } : null),
        subscribe: (jobId, cb) => { listeners.set(jobId, [...(listeners.get(jobId) || []), cb]); },
        unsubscribe: (jobId) => { listeners.delete(jobId); },
        cancel: null,
      };
    },
  };
  return p;
}

beforeEach(async () => {
  fakeDb.reset();
  clipFiles.clear();
  Batch._resetCutBatchesForTests();
  await Join._resetCutVideoJoinJobsForTests();
  Join._setJoinSpawnImplForTests(null);
  provider = makeProvider();
  Batch._setCutBatchProvidersForTests({ comfy: provider.factory, fal: provider.factory }, { pollMs: 20 });
  projectId = (await createProject('Batch Project'))._id.toString();
});

async function call(method, urlPath, body, pid = projectId) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'X-Project-Id': pid, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* binary */ }
  return { status: res.status, json, headers: res.headers };
}

const frame = () => ({ image_id: new ObjectId(), prompt: 'frame', reference_ids: [] });

// Two scenes: 1.1 ready, 1.2 without an end frame, 2.1 ready with a clip, 2.2 ready.
async function seed() {
  const beat = await Plots.createBeat({ projectId, name: 'Arrival', body: 'Sarah enters.' });
  const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, order: 1, title: 'One' });
  const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, order: 2, title: 'Two' });
  const mk = (sceneId, extra = {}) =>
    VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId, prompt: 'She walks in.', durationSeconds: 5, startFrame: frame(), endFrame: frame(), ...extra });
  const a = await mk(s1._id);
  const b = await mk(s1._id, { endFrame: null });
  const c = await mk(s2._id);
  const d = await mk(s2._id);
  const clip = new ObjectId();
  await fakeDb.collection('video_prompts').updateOne({ _id: c._id }, { $set: { video_file_id: clip } });
  const id = (x) => x._id.toString();
  return { beat, beatId: beat._id.toString(), a: id(a), b: id(b), c: id(c), d: id(d), clip };
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not reached');
};

describe('generate all videos', () => {
  it('queues every ready cut, runs them in order, records a failure and carries on', async () => {
    const { beatId, a, b, c, d } = await seed();
    const r = await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'comfy', model_id: 'wan', params: { steps: 8 } });
    expect(r.status).toBe(202);
    expect(provider.opts).toMatchObject({ projectId, modelId: 'wan', params: { steps: 8 }, announceUsername: 'tester' });
    const byCut = (batch) => Object.fromEntries(batch.items.map((it) => [it.cut_id, it]));
    let items = byCut(r.json.batch);
    expect(r.json.batch.items.map((it) => it.label)).toEqual(['1.1', '1.2', '2.1', '2.2']);
    expect(items[b]).toMatchObject({ status: 'skipped', reason: 'Needs a start frame and an end frame' });
    expect(items[c]).toMatchObject({ status: 'skipped', reason: 'Already has a video' });

    // ComfyUI: one cut at a time.
    await until(() => provider.started.length === 1);
    expect(provider.started).toEqual([a]);
    let g = await call('GET', `/api/cuts/videos/batch?beat_id=${beatId}`);
    expect(g.json.batch.status).toBe('running');
    expect(byCut(g.json.batch)[a].status).toBe('running');
    expect(byCut(g.json.batch)[d].status).toBe('queued');
    expect((await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'comfy', model_id: 'wan' })).status).toBe(409);

    provider.settle(a, 'error', 'GPU out of memory');
    await until(() => provider.started.length === 2);
    provider.settle(d);
    await until(async () => (await call('GET', `/api/cuts/videos/batch?beat_id=${beatId}`)).json.batch.status === 'done');
    g = await call('GET', `/api/cuts/videos/batch?beat_id=${beatId}`);
    items = byCut(g.json.batch);
    expect(items[a]).toMatchObject({ status: 'error', error: 'GPU out of memory' });
    expect(items[d].status).toBe('done');
    expect(g.json.batch.counts).toMatchObject({ total: 4, done: 1, error: 1, skipped: 2, queued: 0, running: 0 });
  });

  it('renders with the admin default video renderer when no model is named, and refuses when none is set', async () => {
    const { beatId, a, d } = await seed();
    let r = await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ code: 'NO_VIDEO_DEFAULT' });

    const Settings = await import('../src/mongo/appSettings.js');
    await Settings.setVideoDefaultSettings({ provider: 'comfy', model_id: 'wan-2.2-14b-flf2v', params: { steps: 20, cfg: 4 } });
    r = await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, params: { cfg: 3 } });
    expect(r.status).toBe(202);
    expect(r.json.batch).toMatchObject({ provider: 'comfy', model_id: 'wan-2.2-14b-flf2v' });
    // The default's params seed the render; the request's own win.
    expect(provider.opts).toMatchObject({ modelId: 'wan-2.2-14b-flf2v', params: { steps: 20, cfg: 3 } });
    await until(() => provider.started.length === 1);
    expect(provider.started).toEqual([a]);
    provider.settle(a);
    await until(() => provider.started.length === 2);
    provider.settle(d);
    await until(() => Batch.getCutVideoBatchForBeat(beatId).status === 'done');

    // Naming the other provider without a model does not borrow the ComfyUI default.
    r = await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'fal', skip_existing: false });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not fal/);
  });

  it('skip_existing: false re-renders cuts that have a clip; fal renders two side by side', async () => {
    const { beatId, a, c, d } = await seed();
    const r = await call('POST', '/api/cuts/videos/generate-all', {
      beat_id: beatId, provider: 'fal', model_id: 'fal/model', skip_existing: false, resolution: '720p', fps: 24, generate_audio: true,
    });
    expect(r.status).toBe(202);
    expect(provider.opts).toMatchObject({ resolution: '720p', fps: 24, generateAudio: true });
    await until(() => provider.started.length === 2);
    expect(provider.started).toEqual([a, c]);
    provider.settle(a);
    await until(() => provider.started.length === 3);
    provider.settle(c);
    provider.settle(d);
    await until(() => Batch.getCutVideoBatchForBeat(beatId).status === 'done');
    expect(Batch.serializeCutBatch(Batch.getCutVideoBatchForBeat(beatId)).counts).toMatchObject({ done: 3, skipped: 1 });
  });

  it('a cut someone started by hand is followed, a failed start is that cut\'s error', async () => {
    const { beatId, a, d } = await seed();
    const manual = { job_id: new ObjectId().toString(), owner_id: a, status: 'running', error: null };
    provider.jobs.set(manual.job_id, manual);
    provider.failStart = {
      [a]: Object.assign(new Error('busy'), { code: 'CUT_BUSY', job_id: manual.job_id }),
      [d]: Object.assign(new Error('Invalid parameters'), { errors: ['steps must be ≤ 50'] }),
    };
    await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'comfy', model_id: 'wan' });
    await until(() => Batch.getCutVideoBatchForBeat(beatId).items[0].job_id === manual.job_id);
    provider.settle(a);
    await until(() => Batch.getCutVideoBatchForBeat(beatId).status === 'done');
    const items = Batch.getCutVideoBatchForBeat(beatId).items;
    expect(items[0].status).toBe('done');
    expect(items[3]).toMatchObject({ status: 'error', error: 'Invalid parameters: steps must be ≤ 50' });
  });

  it('cancel stops before the cuts still waiting; a cut that lost a frame meanwhile is skipped', async () => {
    const { beatId, a, d } = await seed();
    await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'comfy', model_id: 'wan' });
    await until(() => provider.started.length === 1);
    const c = await call('POST', '/api/cuts/videos/batch/cancel', { beat_id: beatId });
    expect(c.status).toBe(200);
    expect(c.json.batch.items.find((it) => it.cut_id === d).status).toBe('cancelled');
    provider.settle(a);
    await until(() => Batch.getCutVideoBatchForBeat(beatId).status === 'cancelled');
    expect(provider.started).toEqual([a]);

    // A new batch can start once the last one has ended.
    await fakeDb.collection('video_prompts').updateOne({ _id: new ObjectId(d) }, { $set: { end_frame: null } });
    await fakeDb.collection('video_prompts').updateOne({ _id: new ObjectId(a) }, { $set: { video_file_id: null } });
    const again = await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'comfy', model_id: 'wan' });
    expect(again.status).toBe(202);
    expect(again.json.batch.items.find((it) => it.cut_id === d).status).toBe('skipped');
  });

  it('answers 4xx before anything is queued', async () => {
    const { beatId, a, d } = await seed();
    const post = (body) => call('POST', '/api/cuts/videos/generate-all', body);
    expect((await post({ provider: 'comfy', model_id: 'wan' })).status).toBe(400);
    expect((await post({ beat_id: beatId, provider: 'veo', model_id: 'wan' })).status).toBe(400);
    expect((await post({ beat_id: beatId, provider: 'comfy' })).status).toBe(400);
    expect((await post({ beat_id: new ObjectId().toString(), provider: 'comfy', model_id: 'wan' })).status).toBe(404);
    expect((await call('GET', `/api/cuts/videos/batch?beat_id=${beatId}`)).json.batch).toBe(null);
    expect((await call('POST', '/api/cuts/videos/batch/cancel', { beat_id: beatId })).status).toBe(404);

    // The provider refuses the model: its own status comes back, no batch exists.
    provider = makeProvider({ failPreflight: Object.assign(new Error('Unknown ComfyUI model'), { status: 400, code: 'UNKNOWN_MODEL' }) });
    Batch._setCutBatchProvidersForTests({ comfy: provider.factory }, { pollMs: 20 });
    const bad = await post({ beat_id: beatId, provider: 'comfy', model_id: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('UNKNOWN_MODEL');
    expect(Batch.getCutVideoBatchForBeat(beatId)).toBe(null);

    // Nothing to render.
    for (const id of [a, d]) await fakeDb.collection('video_prompts').updateOne({ _id: new ObjectId(id) }, { $set: { prompt: '' } });
    const none = await post({ beat_id: beatId, provider: 'comfy', model_id: 'wan' });
    expect(none.status).toBe(400);
    expect(none.json.error).toMatch(/No cut to generate/);
  });

  it('the real providers refuse an unconfigured ComfyUI and an unknown fal model', async () => {
    const { beatId } = await seed();
    Batch._setCutBatchProvidersForTests(null);
    const comfy = await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'comfy', model_id: 'wan' });
    expect(comfy.status).toBe(503);
    const fal = await call('POST', '/api/cuts/videos/generate-all', { beat_id: beatId, provider: 'fal', model_id: 'no/such-model' });
    expect([400, 503]).toContain(fal.status);
    expect(Batch.getCutVideoBatchForBeat(beatId)).toBe(null);
  });
});

describe('download all videos', () => {
  it('parses a probed format and builds the ffmpeg argument lists', () => {
    expect(Join.parseVideoFormat('1281,720,30000/1001')).toEqual({ width: 1280, height: 720, fps: '30000/1001' });
    expect(Join.parseVideoFormat('')).toEqual({ width: 1920, height: 1080, fps: '24' });
    expect(Join.parseVideoFormat('1280,720,0/0').fps).toBe('24');
    const silent = Join.normalizeArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', hasAudio: false, format: { width: 1280, height: 720, fps: '24' } });
    expect(silent.join(' ')).toContain('anullsrc=channel_layout=stereo');
    expect(silent).toContain('-shortest');
    expect(silent.join(' ')).toContain('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720');
    const loud = Join.normalizeArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', hasAudio: true, format: { width: 1280, height: 720, fps: '24' } });
    expect(loud).not.toContain('-shortest');
    expect(loud.join(' ')).toContain('-map 0:a:0');
  });

  it('joins the cuts that have a clip in page order and serves the file', async () => {
    const { beatId, a, d, clip } = await seed();
    const clipA = new ObjectId();
    const clipD = new ObjectId();
    await fakeDb.collection('video_prompts').updateOne({ _id: new ObjectId(a) }, { $set: { video_file_id: clipA } });
    await fakeDb.collection('video_prompts').updateOne({ _id: new ObjectId(d) }, { $set: { video_file_id: clipD } });
    for (const id of [clipA, clip, clipD]) {
      const p = path.join(scratch, `${id}.mp4`);
      await fsp.writeFile(p, `clip-${id}`);
      clipFiles.set(String(id), p);
    }
    const calls = [];
    Join._setJoinSpawnImplForTests(async ({ bin, args }) => {
      calls.push({ bin, args });
      if (bin === 'ffprobe') return { stdout: args.includes('stream=width,height,r_frame_rate') ? '1280,720,24/1' : '' };
      const out = args[args.length - 1];
      if (args.includes('concat')) {
        const list = await fsp.readFile(args[args.indexOf('-i') + 1], 'utf8');
        const parts = [];
        for (const line of list.trim().split('\n')) parts.push(await fsp.readFile(/^file '(.*)'$/.exec(line)[1], 'utf8'));
        await fsp.writeFile(out, parts.join('|'));
      } else {
        await fsp.writeFile(out, await fsp.readFile(args[args.indexOf('-i') + 1], 'utf8'));
      }
      return { stdout: '' };
    });

    const r = await call('POST', '/api/cuts/videos/download', { beat_id: beatId });
    expect(r.status).toBe(202);
    expect(r.json.job).toMatchObject({ status: 'running', clip_count: 3, missing: ['1.2'], filename: 'Batch-Project-beat-1-Arrival.mp4' });
    expect(r.json.job.path).toBeUndefined();
    const jobUrl = `/api/cuts/videos/download/${r.json.job.job_id}`;
    await until(async () => (await call('GET', jobUrl)).json.job.status === 'done');

    const res = await fetch(`${baseUrl}${jobUrl}/file`, { headers: { 'X-Project-Id': projectId } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Batch-Project-beat-1-Arrival.mp4"');
    expect(await res.text()).toBe(`clip-${clipA}|clip-${clip}|clip-${clipD}`);
    expect(calls.filter((c) => c.bin === 'ffmpeg')).toHaveLength(4);

    // Another project cannot read the job.
    const other = (await createProject('Other'))._id.toString();
    expect((await call('GET', jobUrl, undefined, other)).status).toBe(404);
    expect((await call('GET', `/api/cuts/videos/download/${new ObjectId()}`)).status).toBe(404);
  });

  it('400 when no cut has a clip, 404 on an unknown beat, an ffmpeg failure names the cut', async () => {
    const { beatId, c, clip } = await seed();
    expect((await call('POST', '/api/cuts/videos/download', {})).status).toBe(400);
    expect((await call('POST', '/api/cuts/videos/download', { beat_id: new ObjectId().toString() })).status).toBe(404);

    const p = path.join(scratch, 'broken.mp4');
    await fsp.writeFile(p, 'x');
    clipFiles.set(String(clip), p);
    Join._setJoinSpawnImplForTests(async ({ bin }) => {
      if (bin === 'ffprobe') return { stdout: '' };
      throw new Error('Invalid data found when processing input');
    });
    const r = await call('POST', '/api/cuts/videos/download', { beat_id: beatId });
    const jobUrl = `/api/cuts/videos/download/${r.json.job.job_id}`;
    await until(async () => (await call('GET', jobUrl)).json.job.status === 'error');
    expect((await call('GET', jobUrl)).json.job.error).toBe('Cut 2.1: Invalid data found when processing input');
    expect((await call('GET', `${jobUrl}/file`)).status).toBe(409);

    await fakeDb.collection('video_prompts').updateOne({ _id: new ObjectId(c) }, { $set: { video_file_id: null } });
    const none = await call('POST', '/api/cuts/videos/download', { beat_id: beatId });
    expect(none.status).toBe(400);
    expect(none.json.error).toMatch(/No cut of this beat has a video/);
  });

  it.skipIf(!hasFfmpeg)('real ffmpeg: clips of different sizes, one silent, become one MP4', async () => {
    const make = (name, args) => {
      const out = path.join(scratch, name);
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, '-pix_fmt', 'yuv420p', out]);
      if (r.status !== 0) throw new Error(r.stderr.toString());
      return out;
    };
    const one = new ObjectId();
    const two = new ObjectId();
    clipFiles.set(String(one), make('one.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=1']));
    clipFiles.set(String(two), make('two.mp4', [
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest',
    ]));
    const out = path.join(scratch, 'joined.mp4');
    const r = await Join.joinClips({ clips: [{ video_file_id: one, label: '1.1' }, { video_file_id: two, label: '1.2' }], outputPath: out });
    expect(r.clipCount).toBe(2);
    expect(r.durationSeconds).toBeGreaterThan(1.8);
    expect(r.durationSeconds).toBeLessThan(2.3);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', out]).stdout.toString();
    expect(probe).toMatch(/video,320,240|320,240/);
    expect(probe).toMatch(/audio/);
  }, 60_000);
});
