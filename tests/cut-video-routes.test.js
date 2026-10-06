// The cut video routes shared by both providers (src/web/cutVideoRoutes.js):
// the reference catalog, the fal preview/generate/discard path for a cut, the
// shared job snapshot and its pre-auth SSE (fal mocked; ComfyUI unconfigured).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
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

const fakeImageStore = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readImageBuffer: vi.fn(async (id) => {
      const entry = fakeImageStore.get(String(id));
      if (!entry) return null;
      return { buffer: entry.buffer, file: { _id: id, contentType: 'image/png', metadata: {} } };
    }),
    findImageFile: vi.fn(async (id) => {
      const entry = fakeImageStore.get(String(id));
      if (!entry) return null;
      return {
        _id: new ObjectId(String(id)),
        filename: `${id}.png`,
        contentType: 'image/png',
        length: entry.buffer.length,
        metadata: { content_type: 'image/png', description: entry.description || '' },
      };
    }),
  };
});

const uploadedAttachments = [];
const deletedAttachments = [];
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    uploadAttachmentBuffer: vi.fn(async (_projectId, args) => {
      const file = { _id: new ObjectId(), filename: args.filename, metadata: { owner_type: args.ownerType, owner_id: args.ownerId } };
      uploadedAttachments.push(file);
      return file;
    }),
    deleteAttachment: vi.fn(async (id) => { deletedAttachments.push(String(id)); }),
    deleteAttachments: vi.fn(async (ids) => { for (const id of ids) deletedAttachments.push(String(id)); }),
  };
});

let falStubs;
function resetFalStubs() {
  falStubs = {
    configured: true,
    storageUploads: [],
    submitCalls: [],
  };
}
resetFalStubs();
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => falStubs.configured,
  fal: {
    storage: {
      upload: vi.fn(async (file) => {
        const bytes = Buffer.from(await file.arrayBuffer()).toString();
        falStubs.storageUploads.push(bytes);
        return `https://fal.media/inputs/${bytes}`;
      }),
    },
    queue: {
      submit: vi.fn(async (model, args) => {
        falStubs.submitCalls.push({ model, args });
        return { request_id: 'req-1' };
      }),
      subscribeToStatus: vi.fn(async () => undefined),
      result: vi.fn(async () => ({ data: { video: { url: 'https://fal.media/out.mp4' } } })),
    },
  },
}));

const realFetch = global.fetch;

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Falgen = await import('../src/web/falVideoGenerate.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

// A registry model (no dependency on the untracked fal catalog in data/).
const FLF_MODEL = 'veo-3-1-flf';

let server, baseUrl, projectId;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  global.fetch = realFetch;
});
beforeEach(async () => {
  fakeDb.reset();
  fakeImageStore.clear();
  uploadedAttachments.length = 0;
  deletedAttachments.length = 0;
  resetFalStubs();
  BeatLocks._clearBeatLocksForTests();
  Falgen._resetForTests();
  projectId = (await createProject('Route Prompts'))._id.toString();
});

async function call(method, path, body, pid = projectId) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: { 'X-Project-Id': pid, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function newImage(desc = '') {
  const id = new ObjectId();
  fakeImageStore.set(id.toString(), { buffer: Buffer.from(desc || id.toString()), description: desc });
  return id;
}

async function seedBeat() {
  const sheet = newImage('sheet');
  const setMain = newImage('diner');
  const uploaded = newImage('uploaded-portrait');
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Sarah', name_lower: 'sarah',
    character_sheet_image_ids: [uploaded], main_image_id: uploaded, images: [{ _id: uploaded }], fields: {},
    artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: sheet, name: 'Sheet', description: 'sheet' }],
    created_at: new Date(), updated_at: new Date(),
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Diner', name_lower: 'diner', description: '',
    images: [],
    artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: setMain, name: 'Main', description: 'diner' }],
    created_at: new Date(), updated_at: new Date(),
  });
  const beat = await Plots.createBeat({ projectId, name: 'Arrival', body: 'Sarah enters.', characters: ['Sarah'], sets: ['Diner'] });
  const scene = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Arrival' });
  return { beat, scene, sheet, setMain };
}

describe('cut video routes', () => {
  it('GET /cuts/candidates returns the numbered catalog; 400/404 on a missing or unknown beat', async () => {
    const { beat, sheet, setMain } = await seedBeat();
    const r = await call('GET', `/api/cuts/candidates?beat_id=${beat._id.toString()}`);
    expect(r.status).toBe(200);
    expect(r.json.candidates.map((c) => c.image_id)).toEqual([sheet.toString(), setMain.toString()]);
    expect(r.json.candidates[0].label).toBe('Sarah — artwork: Sheet');
    expect((await call('GET', '/api/cuts/candidates')).status).toBe(400);
    expect((await call('GET', `/api/cuts/candidates?beat_id=${new ObjectId()}`)).status).toBe(404);
  });

  it('POST /cut/:id/fal-video/preview ships the start and end frames and the cut prompt', async () => {
    const { beat, scene, sheet, setMain } = await seedBeat();
    const p = await VP.createVideoPrompt({
      projectId, beatId: beat._id, sceneId: scene._id, prompt: 'Sarah crosses the diner.', durationSeconds: 6,
      startFrame: { image_id: setMain }, endFrame: { image_id: sheet },
    });
    const r = await call('POST', `/api/cut/${p._id}/fal-video/preview`, { model_id: FLF_MODEL });
    expect(r.status).toBe(200);
    expect(r.json.payload.first_frame_url).toBe(`screenplay-preview://image/${setMain}`);
    expect(r.json.payload.last_frame_url).toBe(`screenplay-preview://image/${sheet}`);
    expect(r.json.payload.image_urls).toBeUndefined();
    expect(r.json.prompt).toBe('Sarah crosses the diner.');
    expect(r.json.prompt).not.toMatch(/Director's notes/);
    expect(r.json.duration_seconds).toBe(6);
    expect((await call('POST', `/api/cut/${new ObjectId()}/fal-video/preview`, { model_id: FLF_MODEL })).status).toBe(404);
    expect((await call('POST', `/api/cut/${p._id}/fal-video/preview`, { model_id: 'no/such-model' })).status).toBe(400);
    falStubs.configured = false;
    expect((await call('POST', `/api/cut/${p._id}/fal-video/preview`, { model_id: FLF_MODEL })).status).toBe(503);
  });

  it('POST /cut/:id/fal-video/generate renders, persists on the cut, the job is readable, and DELETE /cut/:id/video discards', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    const { beat, scene, sheet, setMain } = await seedBeat();
    const p = await VP.createVideoPrompt({
      projectId, beatId: beat._id, sceneId: scene._id, prompt: 'Sarah crosses the diner.', durationSeconds: 8,
      startFrame: { image_id: setMain }, endFrame: { image_id: sheet },
    });
    const r = await call('POST', `/api/cut/${p._id}/fal-video/generate`, { model_id: FLF_MODEL });
    expect(r.status).toBe(202);
    await vi.waitFor(() => {
      const st = Falgen.getVideoGenerationJob(r.json.job_id)?.status;
      if (st !== 'done' && st !== 'error') throw new Error(`job still ${st}`);
    });
    const job = Falgen.getVideoGenerationJob(r.json.job_id);
    expect(job.status).toBe('done');
    expect(job.owner_type).toBe('video_prompt');
    expect(job.owner_id).toBe(p._id.toString());
    expect([...falStubs.storageUploads].sort()).toEqual(['diner', 'sheet']);
    expect(falStubs.submitCalls[0].args.input.first_frame_url).toBe('https://fal.media/inputs/diner');
    expect(falStubs.submitCalls[0].args.input.last_frame_url).toBe('https://fal.media/inputs/sheet');
    expect(falStubs.submitCalls[0].args.input.prompt).toBe('Sarah crosses the diner.');
    expect(uploadedAttachments[0].filename).toMatch(/^video-prompt-/);
    expect(String(uploadedAttachments[0].metadata.owner_id)).toBe(beat._id.toString());

    // The shared job route finds fal jobs too (ComfyUI registry checked first).
    const snap = await call('GET', `/api/cut/${p._id}/video-job/${r.json.job_id}`);
    expect(snap.status).toBe(200);
    expect(snap.json.job.status).toBe('done');
    expect(snap.json.job).not.toHaveProperty('storyboard_id');
    expect((await call('GET', `/api/cut/${p._id}/video-job/${new ObjectId()}`)).status).toBe(404);

    const row = await VP.getVideoPrompt(projectId, p._id);
    expect(String(row.video_file_id)).toBe(uploadedAttachments[0]._id.toString());
    expect(row.video_model_id).toBe(FLF_MODEL);

    const del = await call('DELETE', `/api/cut/${p._id}/video`);
    expect(del.status).toBe(200);
    expect(del.json.cut.video_file_id).toBeNull();
    expect(deletedAttachments).toContain(uploadedAttachments[0]._id.toString());
    expect((await call('DELETE', `/api/cut/${new ObjectId()}/video`)).status).toBe(404);
  });

  it('GET /cut/:id/video-job/:jobId/events authenticates via the query string and 404s unknown jobs', async () => {
    await seedBeat();
    await fakeDb.collection('auth_sessions').insertOne({ _id: new ObjectId(), session_id: 'sess-1', username: 'tester', approved: true, created_at: new Date() });
    const r = await realFetch(`${baseUrl}/api/cut/${new ObjectId()}/video-job/${new ObjectId()}/events?session_id=sess-1`, {
      headers: { 'X-Project-Id': projectId },
    });
    expect(r.status).toBe(404);
    const noSess = await realFetch(`${baseUrl}/api/cut/x/video-job/y/events`);
    expect(noSess.status).toBe(401);
  });

  it('the legacy /video-prompt* paths are gone', async () => {
    const { beat } = await seedBeat();
    const status = async (method, path) =>
      (await realFetch(`${baseUrl}${path}`, { method, headers: { 'X-Project-Id': projectId, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).status;
    expect(await status('GET', `/api/video-prompts?beat_id=${beat.order}`)).toBe(404);
    expect(await status('GET', `/api/video-prompts/candidates?beat_id=${beat._id}`)).toBe(404);
    expect(await status('POST', `/api/video-prompt/${new ObjectId()}/video/preview`)).toBe(404);
  });
});
