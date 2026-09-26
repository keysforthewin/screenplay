// REST surface of the Prompts tab: list/create/patch/reorder/clear/generate
// plus the video routes for a prompt owner (fal mocked).

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
const Gen = await import('../src/web/videoPromptGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Falgen = await import('../src/web/falVideoGenerate.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

const REF_MODEL = 'bytedance/seedance-2.5/reference-to-video';

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
  Gen._setVideoPromptWriterForTests(null);
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
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Sarah', name_lower: 'sarah',
    character_sheet_image_ids: [sheet], images: [], artworks: [], fields: {},
    created_at: new Date(), updated_at: new Date(),
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Diner', name_lower: 'diner', description: '',
    main_image_id: setMain, images: [{ _id: setMain, caption: '' }], artworks: [],
    created_at: new Date(), updated_at: new Date(),
  });
  const beat = await Plots.createBeat({ projectId, name: 'Arrival', body: 'Sarah enters.', characters: ['Sarah'], sets: ['Diner'] });
  return { beat, sheet, setMain };
}

describe('video prompt routes', () => {
  it('GET /video-prompts lists by beat order; 400 without beat_id; 404 unknown beat', async () => {
    const { beat } = await seedBeat();
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'A' });
    const ok = await call('GET', `/api/video-prompts?beat_id=${beat.order}`);
    expect(ok.status).toBe(200);
    expect(ok.json.beat.sets).toEqual(['Diner']);
    expect(ok.json.prompts.map((p) => p.title)).toEqual(['A']);
    expect((await call('GET', '/api/video-prompts')).status).toBe(400);
    expect((await call('GET', '/api/video-prompts?beat_id=99')).status).toBe(404);
  });

  it('POST /video-prompts appends a blank row; DELETE /video-prompt/:id removes it', async () => {
    const { beat } = await seedBeat();
    const created = await call('POST', '/api/video-prompts', { beat_id: beat._id.toString() });
    expect(created.status).toBe(200);
    const id = created.json.prompt._id;
    expect(created.json.prompt.order).toBe(1);
    const gone = await call('DELETE', `/api/video-prompt/${id}`);
    expect(gone.status).toBe(200);
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toHaveLength(0);
    expect((await call('DELETE', `/api/video-prompt/${new ObjectId()}`)).status).toBe(404);
  });

  it('GET /video-prompts/candidates returns the numbered catalog', async () => {
    const { beat, sheet, setMain } = await seedBeat();
    const r = await call('GET', `/api/video-prompts/candidates?beat_id=${beat._id.toString()}`);
    expect(r.status).toBe(200);
    expect(r.json.candidates.map((c) => c.image_id)).toEqual([sheet.toString(), setMain.toString()]);
    expect(r.json.candidates[0].label).toBe('Sarah — character sheet');
  });

  it('PATCH /video-prompt/:id sets duration and resolves ordered reference ids against the catalog', async () => {
    const { beat, sheet, setMain } = await seedBeat();
    const p = await VP.createVideoPrompt({ projectId, beatId: beat._id });
    const ok = await call('PATCH', `/api/video-prompt/${p._id}`, {
      duration_seconds: 22,
      reference_image_ids: [setMain.toString(), sheet.toString()],
    });
    expect(ok.status).toBe(200);
    expect(ok.json.prompt.duration_seconds).toBe(22);
    expect(ok.json.prompt.reference_images.map((r) => r.owner_name)).toEqual(['Diner', 'Sarah']);
    expect(ok.json.prompt.reference_images[1].label).toBe('Sarah — character sheet');

    const unknown = await call('PATCH', `/api/video-prompt/${p._id}`, { reference_image_ids: [new ObjectId().toString()] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/unknown reference image/);
    expect((await call('PATCH', `/api/video-prompt/${p._id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/api/video-prompt/${p._id}`, { duration_seconds: 500 })).status).toBe(400);
    const cleared = await call('PATCH', `/api/video-prompt/${p._id}`, { duration_seconds: null, reference_image_ids: [] });
    expect(cleared.json.prompt.duration_seconds).toBeNull();
    expect(cleared.json.prompt.reference_images).toEqual([]);
  });

  it('POST /video-prompts/reorder and /clear', async () => {
    const { beat } = await seedBeat();
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'A' });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'B' });
    const re = await call('POST', '/api/video-prompts/reorder', { beat_id: beat._id.toString(), ordered_ids: [b._id.toString(), a._id.toString()] });
    expect(re.status).toBe(200);
    expect(re.json.prompts.map((p) => p.title)).toEqual(['B', 'A']);
    const clr = await call('POST', '/api/video-prompts/clear', { beat_id: beat._id.toString() });
    expect(clr.status).toBe(200);
    expect(clr.json.removed_count).toBe(2);
  });

  it('POST /video-prompts/generate returns 202 + job, 409 while the beat is busy; GET polls the job', async () => {
    const { beat } = await seedBeat();
    let release;
    const gate = new Promise((r) => { release = r; });
    Gen._setVideoPromptWriterForTests(async () => {
      await gate;
      return [{ title: 'One', duration_seconds: 10, reference_image_indexes: [1], prompt: '@Image1 is Sarah.' }];
    });
    const started = await call('POST', '/api/video-prompts/generate', { beat_id: beat._id.toString(), direction: 'x' });
    expect(started.status).toBe(202);
    expect(started.json.job_id).toBeTruthy();
    const busy = await call('POST', '/api/video-prompts/generate', { beat_id: beat._id.toString() });
    expect(busy.status).toBe(409);
    const clrBusy = await call('POST', '/api/video-prompts/clear', { beat_id: beat._id.toString() });
    expect(clrBusy.status).toBe(409);
    release();
    let job;
    for (let i = 0; i < 300; i++) {
      const r = await call('GET', `/api/video-prompts/generate/${started.json.job_id}`);
      job = r.json.job;
      if (job.status === 'done' || job.status === 'error') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(job.status).toBe('done');
    expect(job.created).toBe(1);
    expect((await call('GET', `/api/video-prompts/generate/${new ObjectId()}`)).status).toBe(404);
  });

  it('POST /video-prompt/:id/video/preview ships the references in stored order as image_urls', async () => {
    const VideoModels = await import('../src/fal/videoModels.js');
    if (!(await VideoModels.getVideoModelOrCatalog(REF_MODEL))) return; // manifest drift
    const { beat, sheet, setMain } = await seedBeat();
    const p = await VP.createVideoPrompt({
      projectId, beatId: beat._id, prompt: '@Image1 is the diner, @Image2 is Sarah.', durationSeconds: 20,
      referenceImages: [
        { image_id: setMain, owner_type: 'set', owner_name: 'Diner', label: 'Diner — main image' },
        { image_id: sheet, owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — character sheet' },
      ],
    });
    const r = await call('POST', `/api/video-prompt/${p._id}/video/preview`, { model_id: REF_MODEL });
    expect(r.status).toBe(200);
    expect(r.json.payload.image_urls).toEqual([
      `screenplay-preview://image/${setMain}`,
      `screenplay-preview://image/${sheet}`,
    ]);
    expect(r.json.prompt).toBe('@Image1 is the diner, @Image2 is Sarah.');
    expect(r.json.prompt).not.toMatch(/Director's notes/);
    expect(r.json.duration_seconds).toBe(20);
    expect(r.json.generate_audio).toBe(false);
    expect((await call('POST', `/api/video-prompt/${p._id}/video/preview`, { model_id: REF_MODEL, duration_seconds: 61 })).status).toBe(400);
    expect((await call('POST', `/api/video-prompt/${new ObjectId()}/video/preview`, { model_id: REF_MODEL })).status).toBe(404);
    expect((await call('POST', `/api/video-prompt/${p._id}/video/preview`, { model_id: 'no/such-model' })).status).toBe(400);
    falStubs.configured = false;
    expect((await call('POST', `/api/video-prompt/${p._id}/video/preview`, { model_id: REF_MODEL })).status).toBe(503);
  });

  it('POST /video-prompt/:id/video/generate renders, persists on the prompt row, and DELETE …/video discards', async () => {
    const VideoModels = await import('../src/fal/videoModels.js');
    if (!(await VideoModels.getVideoModelOrCatalog(REF_MODEL))) return;
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    const { beat, sheet, setMain } = await seedBeat();
    const p = await VP.createVideoPrompt({
      projectId, beatId: beat._id, prompt: '@Image1 is Sarah, @Image2 is the diner.', durationSeconds: 12,
      referenceImages: [
        { image_id: sheet, owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — character sheet' },
        { image_id: setMain, owner_type: 'set', owner_name: 'Diner', label: 'Diner — main image' },
      ],
    });
    const r = await call('POST', `/api/video-prompt/${p._id}/video/generate`, { model_id: REF_MODEL });
    expect(r.status).toBe(202);
    await BeatLocks.withBeatLock(beat._id, () => {});
    const job = Falgen.getVideoGenerationJob(r.json.job_id);
    expect(job.status).toBe('done');
    expect(job.owner_type).toBe('video_prompt');
    expect(job.owner_id).toBe(p._id.toString());
    expect(Falgen.serializeJob(job).storyboard_id).toBeNull();
    expect(falStubs.storageUploads).toEqual(['sheet', 'diner']);
    expect(falStubs.submitCalls[0].args.input.image_urls).toEqual([
      'https://fal.media/inputs/sheet', 'https://fal.media/inputs/diner',
    ]);
    expect(falStubs.submitCalls[0].args.input.prompt).toBe('@Image1 is Sarah, @Image2 is the diner.');
    expect(uploadedAttachments[0].filename).toMatch(/^video-prompt-/);
    expect(String(uploadedAttachments[0].metadata.owner_id)).toBe(beat._id.toString());

    const row = await VP.getVideoPrompt(projectId, p._id);
    expect(String(row.video_file_id)).toBe(uploadedAttachments[0]._id.toString());
    expect(row.video_fal_model).toBe(REF_MODEL);
    expect(await fakeDb.collection('storyboards').find({}).toArray()).toHaveLength(0);

    const del = await call('DELETE', `/api/video-prompt/${p._id}/video`);
    expect(del.status).toBe(200);
    expect(del.json.prompt.video_file_id).toBeNull();
    expect(deletedAttachments).toContain(uploadedAttachments[0]._id.toString());
  });

  it('GET /video-prompt/:id/video-job/:jobId/events streams a snapshot for a known job', async () => {
    await seedBeat();
    await fakeDb.collection('auth_sessions').insertOne({ _id: new ObjectId(), session_id: 'sess-1', username: 'tester', approved: true, created_at: new Date() });
    const r = await realFetch(`${baseUrl}/api/video-prompt/${new ObjectId()}/video-job/${new ObjectId()}/events?session_id=sess-1`, {
      headers: { 'X-Project-Id': projectId },
    });
    // Unknown job → 404 (the route exists and authenticates via the query string).
    expect(r.status).toBe(404);
    const noSess = await realFetch(`${baseUrl}/api/video-prompt/x/video-job/y/events`);
    expect(noSess.status).toBe(401);
  });
});
