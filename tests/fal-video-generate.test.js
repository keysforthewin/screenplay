// Tests for the fal.ai video generation orchestrator. The fal client is
// mocked via vi.mock so we can drive specific submit / status / result
// paths without ever touching fal.ai. The Mongo layer uses the in-memory
// fake from tests/_fakeMongo.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

const fakeImageStore = new Map();
const fakeAttachmentStore = new Map();

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeImageStore.get(key);
    if (!entry) return null;
    return {
      buffer: entry.buffer,
      file: { _id: id, contentType: entry.contentType, metadata: {} },
    };
  }),
  // Used by the payload-preview path (describeImageInput) to render asset
  // metadata next to the JSON preview without uploading to fal.
  findImageFile: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeImageStore.get(key);
    if (!entry) return null;
    return {
      _id: new ObjectId(key),
      filename: `${key}.png`,
      contentType: entry.contentType,
      length: entry.buffer.length,
      metadata: { content_type: entry.contentType },
    };
  }),
}));

const uploadedAttachments = [];
vi.mock('../src/mongo/attachments.js', () => ({
  findAttachmentFile: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeAttachmentStore.get(key);
    if (!entry) return null;
    return { _id: id, filename: entry.filename || 'audio.mp3', contentType: entry.contentType, metadata: { content_type: entry.contentType } };
  }),
  readAttachmentBuffer: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeAttachmentStore.get(key);
    if (!entry) return null;
    return {
      buffer: entry.buffer,
      file: {
        _id: id,
        contentType: entry.contentType,
        metadata: { content_type: entry.contentType },
      },
    };
  }),
  uploadAttachmentBuffer: vi.fn(async (_projectId, args) => {
    const file = {
      _id: new ObjectId(),
      filename: args.filename,
      content_type: args.contentType,
      size: args.buffer?.length || 0,
      metadata: {
        owner_type: args.ownerType,
        owner_id: args.ownerId,
        content_type: args.contentType,
      },
      uploaded_at: new Date(),
    };
    uploadedAttachments.push({ ...file, buffer: args.buffer });
    return file;
  }),
}));

vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => false,
}));

// fal client mock. Each test pre-arms submit/subscribe/result/storage hooks
// via the helpers below.
let falStubs;
function resetFalStubs() {
  falStubs = {
    isConfigured: vi.fn(() => true),
    storageUploads: [],
    submitCalls: [],
    resultCalls: [],
    subscribeCalls: [],
    subscribeImpl: async () => undefined,
    submitImpl: async () => ({ request_id: 'req-fake-1' }),
    resultImpl: async () => ({ data: { video: { url: 'https://fal.media/out.mp4' } } }),
    storageImpl: async (file) => `https://fal.media/inputs/${file?.name || 'asset'}`,
  };
}
resetFalStubs();

vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => falStubs.isConfigured(),
  fal: {
    storage: {
      upload: vi.fn(async (file, opts) => {
        const url = await falStubs.storageImpl(file, opts);
        falStubs.storageUploads.push({ name: file?.name, type: file?.type, opts, url });
        return url;
      }),
    },
    queue: {
      submit: vi.fn(async (model, args) => {
        falStubs.submitCalls.push({ model, args });
        return falStubs.submitImpl(model, args);
      }),
      subscribeToStatus: vi.fn(async (model, args) => {
        falStubs.subscribeCalls.push({ model, args });
        return falStubs.subscribeImpl(model, args);
      }),
      result: vi.fn(async (model, args) => {
        falStubs.resultCalls.push({ model, args });
        return falStubs.resultImpl(model, args);
      }),
    },
  },
}));

// fetch is used by the orchestrator to download the rendered video URL.
const realFetch = global.fetch;
let videoBytes;
function installFetchMock() {
  videoBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'video/mp4' },
    arrayBuffer: async () => videoBytes.buffer,
  }));
}

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const Falgen = await import('../src/web/falVideoGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');

async function waitForBeatLock(beatId) {
  await BeatLocks.withBeatLock(beatId, () => {});
}

// A cut with (optionally) a rendered start frame and a joined dialogue
// recording — the only inputs a cut can hand a fal model besides its ordered
// reference images.
async function seedScene({ start = true, audio = false } = {}) {
  const beat = await Plots.createBeat({ projectId, name: 'Test beat', body: 'body' });
  const row = await VP.createVideoPrompt({
    projectId,
    beatId: beat._id,
    title: 'Crossing',
    prompt: 'Hero crosses the room.',
    durationSeconds: 5,
  });
  const patch = {};
  if (start) {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from('start'), contentType: 'image/png' });
    patch.start_frame = { image_id: id, prompt: 'Hero at the door' };
  }
  if (audio) {
    const id = new ObjectId();
    fakeAttachmentStore.set(id.toString(), { buffer: Buffer.from('audio'), contentType: 'audio/mpeg' });
    patch.audio_file_id = id;
    patch.audio_duration_seconds = 4;
  }
  if (Object.keys(patch).length) await VP.updateVideoPrompt(projectId, row._id, patch);
  return { beat, sb: await VP.getVideoPrompt(projectId, row._id) };
}

const own = (row) => ({ kind: 'video_prompt', id: row._id.toString() });

async function seedCharacter(name, { sheetCount = 1 } = {}) {
  const sheetIds = [];
  for (let i = 0; i < sheetCount; i++) {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from(`${name}-sheet-${i}`), contentType: 'image/png' });
    sheetIds.push(id);
  }
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(),
    name,
    name_lower: name.toLowerCase(),
    character_sheet_image_ids: sheetIds,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return { name, sheetIds };
}

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  fakeImageStore.clear();
  fakeAttachmentStore.clear();
  uploadedAttachments.length = 0;
  BeatLocks._clearBeatLocksForTests();
  Falgen._resetForTests();
  resetFalStubs();
  installFetchMock();
});

afterEach(() => {
  global.fetch = realFetch;
});

import { afterEach } from 'vitest';

describe('startVideoGenerationJob', () => {
  it('happy path for Kling 3 Pro: uploads only the start frame of the cut → submit/subscribe/result', async () => {
    // A character existing in the project must NOT cause its sheet to be
    // uploaded — images come only from the cut's own start frame and references.
    await seedCharacter('Steve', { sheetCount: 2 });
    const { beat, sb } = await seedScene({ start: true });

    const { job_id } = await Falgen.startVideoGenerationJob({ projectId,
      owner: own(sb),
      modelId: 'kling-3-pro',
      durationSeconds: 7,
    });
    expect(job_id).toBeTruthy();

    await waitForBeatLock(beat._id);

    const job = Falgen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.video_file_id).toBeTruthy();
    expect(job.request_id).toBe('req-fake-1');

    // Only the start frame gets uploaded — Steve's sheets are ignored.
    expect(falStubs.storageUploads.map((u) => u.name).sort()).toEqual(['start.png']);

    // The submit call shape: start_image_url, no end frame, no elements.
    expect(falStubs.submitCalls).toHaveLength(1);
    const submitInput = falStubs.submitCalls[0].args.input;
    expect(submitInput.start_image_url).toMatch(/^https:\/\/fal\.media\/inputs\//);
    expect(submitInput.end_image_url).toBeUndefined();
    expect(submitInput.duration).toBe('7');
    expect(submitInput.generate_audio).toBe(true);
    expect(submitInput.elements).toBeUndefined();

    // subscribeToStatus and result were both called against the kling model.
    expect(falStubs.subscribeCalls[0].model).toBe('fal-ai/kling-video/v3/pro/image-to-video');
    expect(falStubs.resultCalls[0].args.requestId).toBe('req-fake-1');

    // GridFS attachment was created beat-owned, video/mp4.
    expect(uploadedAttachments).toHaveLength(1);
    const persisted = uploadedAttachments[0];
    expect(persisted.content_type).toBe('video/mp4');
    expect(persisted.metadata.owner_type).toBe('beat');
    expect(persisted.metadata.owner_id?.toString?.()).toBe(beat._id.toString());

    // The cut row is updated via the gateway.
    const fresh = await VP.getVideoPrompt(projectId, sb._id);
    expect(fresh.video_file_id?.toString()).toBe(job.video_file_id);
    expect(fresh.video_duration_seconds).toBe(7);
    // Enriched metadata: model identification, params, and cost are all
    // persisted so the inline panel can render them later.
    expect(fresh.video_fal_model).toBe('fal-ai/kling-video/v3/pro/image-to-video');
    expect(fresh.video_model_id).toBe('kling-3-pro');
    expect(fresh.video_model_label).toBe('Kling 3 Pro');
    expect(fresh.video_model_lab).toBe('Kling');
    expect(fresh.video_model_family).toBe('Kling v3');
    expect(fresh.video_model_added_at).toBeInstanceOf(Date);
    expect(fresh.video_parameters).toMatchObject({
      duration_seconds: 7,
      generate_audio: true,
    });
    // Kling 3 Pro audio-on at 7s = 7 * $0.168 = $1.176.
    expect(fresh.video_cost_usd).toBeCloseTo(7 * 0.168, 6);
  });

  it('Kling AI Avatar: image_url falls back to start_frame when character_sheet is unavailable; audio_url required', async () => {
    const { beat, sb } = await seedScene({ start: true, audio: true });
    const { job_id } = await Falgen.startVideoGenerationJob({ projectId,
      owner: own(sb),
      modelId: 'kling-avatar-v2-pro',
    });
    await waitForBeatLock(beat._id);
    expect(Falgen.getVideoGenerationJob(job_id).status).toBe('done');

    expect(falStubs.submitCalls[0].model).toBe('fal-ai/kling-video/ai-avatar/v2/pro');
    const input = falStubs.submitCalls[0].args.input;
    expect(input.image_url).toBeTruthy();
    expect(input.audio_url).toBeTruthy();

    // With no character-sheet slot on a cut, kling-avatar
    // uses the start_frame as the visual anchor instead.
    const startUpload = falStubs.storageUploads.find((u) => u.name === 'start.png');
    expect(input.image_url).toBe(startUpload.url);
  });

  it('Kling AI Avatar rejects with MissingInputsError when audio is absent', async () => {
    const { sb } = await seedScene({ start: true, audio: false });
    await expect(
      Falgen.startVideoGenerationJob({ projectId,
        owner: own(sb),
        modelId: 'kling-avatar-v2-pro',
      }),
    ).rejects.toBeInstanceOf(Falgen.MissingInputsError);
  });

  it('throws FalNotConfiguredError when FAL_KEY is unset', async () => {
    falStubs.isConfigured = vi.fn(() => false);
    const { sb } = await seedScene({ start: true });
    await expect(
      Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' }),
    ).rejects.toBeInstanceOf(Falgen.FalNotConfiguredError);
  });

  it('throws UnknownVideoModelError on an unregistered model id', async () => {
    const { sb } = await seedScene({ start: true });
    await expect(
      Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(Falgen.UnknownVideoModelError);
  });

  it('SSE pub/sub fans out queue updates and terminal status to subscribers', async () => {
    const events = [];
    falStubs.subscribeImpl = async (_model, { onQueueUpdate }) => {
      onQueueUpdate({ status: 'IN_QUEUE', queue_position: 3 });
      onQueueUpdate({ status: 'IN_PROGRESS' });
    };

    const { beat, sb } = await seedScene({ start: true });
    const { job_id } = await Falgen.startVideoGenerationJob({ projectId,
      owner: own(sb),
      modelId: 'kling-3-pro',
    });
    Falgen.subscribeToJob(job_id, (snap) => events.push({ status: snap.status, qp: snap.queue_position }));
    await waitForBeatLock(beat._id);

    const statuses = events.map((e) => e.status);
    expect(statuses).toContain('IN_QUEUE');
    expect(statuses).toContain('IN_PROGRESS');
    expect(statuses[statuses.length - 1]).toBe('done');
    expect(events.find((e) => e.status === 'IN_QUEUE').qp).toBe(3);
  });

  it('records job error and broadcasts when fal.queue.subscribeToStatus rejects', async () => {
    falStubs.subscribeImpl = async () => {
      throw new Error('queue boom');
    };
    const { beat, sb } = await seedScene({ start: true });
    const { job_id } = await Falgen.startVideoGenerationJob({ projectId,
      owner: own(sb),
      modelId: 'kling-3-pro',
    });
    await waitForBeatLock(beat._id);
    const job = Falgen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/queue boom/);
  });

  it('surfaces fal validation detail in job.error instead of bare "Unprocessable Entity"', async () => {
    // The fal SDK's ApiError.message is just the HTTP status text; the real
    // reason (e.g. content_policy_violation on start_image_url) lives in
    // body.detail. The SPA shows job.error, so it must carry the detail.
    falStubs.subscribeImpl = async () => {
      throw Object.assign(new Error('Unprocessable Entity'), {
        status: 422,
        body: {
          detail: [
            {
              loc: ['body', 'start_image_url'],
              msg: 'The content could not be processed because it contained material flagged by a content checker.',
              type: 'content_policy_violation',
            },
          ],
        },
      });
    };
    const { beat, sb } = await seedScene({ start: true });
    const { job_id } = await Falgen.startVideoGenerationJob({ projectId,
      owner: own(sb),
      modelId: 'kling-3-pro',
    });
    await waitForBeatLock(beat._id);
    const job = Falgen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/start_image_url/);
    expect(job.error).toMatch(/content checker/);
  });

  it('Sora 2: does not mint character refs; just renders the start frame', async () => {
    // Even with characters in the project, the orchestrator must
    // not call fal-ai/sora-2/characters or upload any character sheets.
    await seedCharacter('Alice', { sheetCount: 1 });
    const { beat, sb } = await seedScene({ start: true });

    const { job_id } = await Falgen.startVideoGenerationJob({ projectId,
      owner: own(sb),
      modelId: 'sora-2',
      durationSeconds: 8,
    });
    await waitForBeatLock(beat._id);

    const job = Falgen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();

    // Only the start frame gets uploaded.
    expect(falStubs.storageUploads.map((u) => u.name)).toEqual(['start.png']);

    // Single submit: image-to-video. No characters endpoint.
    expect(falStubs.submitCalls.map((c) => c.model)).toEqual([
      'fal-ai/sora-2/image-to-video',
    ]);
    const videoSubmit = falStubs.submitCalls[0].args.input;
    expect(videoSubmit.image_url).toMatch(/^https:\/\/fal\.media\/inputs\//);
    expect(videoSubmit.character_ids).toBeUndefined();
    expect(videoSubmit.prompt).not.toMatch(/^With characters:/);
    expect(videoSubmit.duration).toBe('8');
  });

  it('Sora 2 Pro: passes user-selected resolution to fal and records the tier cost', async () => {
    const { beat, sb } = await seedScene({ start: true });

    const { job_id } = await Falgen.startVideoGenerationJob({ projectId,
      owner: own(sb),
      modelId: 'sora-2-pro',
      durationSeconds: 8,
      resolution: '1080p',
    });
    await waitForBeatLock(beat._id);
    const job = Falgen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('done');

    // The payload reflects the user's resolution (not the hard-coded 'auto').
    expect(falStubs.submitCalls[0].args.input.resolution).toBe('1080p');

    // 1080p on Sora 2 Pro is $0.50/s. 8s × $0.50 = $4.00.
    const fresh = await VP.getVideoPrompt(projectId, sb._id);
    expect(fresh.video_parameters?.resolution).toBe('1080p');
    expect(fresh.video_cost_usd).toBeCloseTo(8 * 0.5, 6);
  });
});

describe('prepareShotVideoJob / runShotVideoInline (beat renderer building blocks)', () => {
  it('prepareShotVideoJob validates without creating a job, and resolves a registered endpoint id', async () => {
    const { sb } = await seedScene({ start: true });
    const prepared = await Falgen.prepareShotVideoJob({
      projectId,
      owner: own(sb),
      modelId: 'fal-ai/kling-video/v3/pro/image-to-video',
    });
    expect(prepared.model.id).toBe('kling-3-pro');
    expect(prepared.assignment.startFrameId).toBeTruthy();
    expect(prepared.row._id.toString()).toBe(sb._id.toString());
    expect(falStubs.submitCalls).toHaveLength(0);
  });

  it('prepareShotVideoJob throws MissingInputsError for a model whose required inputs are absent', async () => {
    const { sb } = await seedScene({ start: false });
    await expect(
      Falgen.prepareShotVideoJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' }),
    ).rejects.toBeInstanceOf(Falgen.MissingInputsError);
  });

  it('runShotVideoInline renders under a lock the caller already holds and returns the finished job', async () => {
    const { beat, sb } = await seedScene({ start: true });
    const created = [];
    const job = await BeatLocks.withBeatLock(beat._id, () =>
      Falgen.runShotVideoInline({
        projectId,
        owner: own(sb),
        modelId: 'kling-3-pro',
        durationSeconds: 4,
        onJobCreated: (j) => created.push(j.job_id),
      }),
    );
    expect(created).toHaveLength(1);
    expect(job.job_id).toBe(created[0]);
    expect(job.status).toBe('done');
    expect(job.video_file_id).toBeTruthy();
    // The job is registered for SSE / reconnect like a normal one.
    expect(Falgen.getVideoGenerationJob(job.job_id)?.status).toBe('done');
    expect(falStubs.submitCalls).toHaveLength(1);
    const fresh = await VP.getVideoPrompt(projectId, sb._id);
    expect(fresh.video_file_id?.toString()).toBe(job.video_file_id);
  });

  it('runShotVideoInline reports a fal failure on the job instead of throwing', async () => {
    const { beat, sb } = await seedScene({ start: true });
    falStubs.resultImpl = async () => { throw new Error('fal exploded'); };
    const job = await BeatLocks.withBeatLock(beat._id, () =>
      Falgen.runShotVideoInline({ projectId, owner: own(sb), modelId: 'kling-3-pro' }),
    );
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/fal exploded/);
  });
});


describe('video prompt owner (Prompts tab rows)', () => {
  const REF_MODEL = 'bytedance/seedance-2.5/reference-to-video';

  async function seedPromptRow() {
    const beat = await Plots.createBeat({ projectId, name: 'Prompt beat', body: 'body' });
    const a = new ObjectId();
    const b = new ObjectId();
    fakeImageStore.set(a.toString(), { buffer: Buffer.from('sarah-sheet'), contentType: 'image/png' });
    fakeImageStore.set(b.toString(), { buffer: Buffer.from('diner-main'), contentType: 'image/png' });
    const row = await VP.createVideoPrompt({
      projectId,
      beatId: beat._id,
      title: 'Arrival',
      prompt: '@Image1 is Sarah, @Image2 is the diner. [Wide shot, static] she enters.',
      durationSeconds: 12,
      referenceImages: [
        { image_id: a, owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — character sheet' },
        { image_id: b, owner_type: 'set', owner_name: 'Diner', label: 'Diner — main image' },
      ],
    });
    return { beat, row, a, b };
  }

  it('ships the ordered references as image_urls, skips director notes, persists on the prompt row', async () => {
    const VideoModels = await import('../src/fal/videoModels.js');
    if (!(await VideoModels.getVideoModelOrCatalog(REF_MODEL))) return; // manifest drift
    await fakeDb.collection('prompts').insertOne({
      _id: `${projectId}:director_notes`,
      notes: [{ _id: new ObjectId(), text: 'Always shoot from the hip.' }],
    });
    falStubs.storageImpl = async (file) =>
      `https://fal.media/inputs/${Buffer.from(await file.arrayBuffer()).toString()}`;
    const { beat, row } = await seedPromptRow();

    const { job_id } = await Falgen.startVideoGenerationJob({
      projectId,
      modelId: REF_MODEL,
      owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() },
      includeDirectorNotes: false,
      generateAudio: false,
    });
    await waitForBeatLock(beat._id);
    const job = Falgen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('done');
    expect(job.owner_type).toBe('video_prompt');
    expect(job.owner_id).toBe(row._id.toString());

    const input = falStubs.submitCalls[0].args.input;
    expect(input.image_urls).toEqual([
      'https://fal.media/inputs/sarah-sheet',
      'https://fal.media/inputs/diner-main',
    ]);
    expect(input.prompt).toBe('@Image1 is Sarah, @Image2 is the diner. [Wide shot, static] she enters.');
    expect(input.prompt).not.toMatch(/shoot from the hip/);
    expect(uploadedAttachments[0].filename).toMatch(/^video-prompt-/);
    expect(uploadedAttachments[0].metadata.owner_type).toBe('beat');

    const fresh = await VP.getVideoPrompt(projectId, row._id);
    expect(fresh.video_file_id?.toString()).toBe(job.video_file_id);
    expect(fresh.video_fal_model).toBe(REF_MODEL);
    expect(fresh.video_parameters.duration_seconds).toBe(12);
  });

  it('preview for a prompt owner uses the row prompt/duration and the stored reference order', async () => {
    const VideoModels = await import('../src/fal/videoModels.js');
    if (!(await VideoModels.getVideoModelOrCatalog(REF_MODEL))) return;
    const { row, a, b } = await seedPromptRow();
    const preview = await Falgen.buildVideoPayloadPreview({
      projectId,
      modelId: REF_MODEL,
      owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() },
      includeDirectorNotes: false,
    });
    expect(preview.payload.image_urls).toEqual([
      `screenplay-preview://image/${a}`,
      `screenplay-preview://image/${b}`,
    ]);
    expect(preview.prompt).toMatch(/^@Image1 is Sarah/);
    expect(preview.duration_seconds).toBe(12);
    expect(preview.inputs.filter((i) => i.slot === 'referenceImages').map((i) => i.image_id)).toEqual([a.toString(), b.toString()]);
  });

  it('a start-frame model gets the cut\'s rendered start frame, never a reference', async () => {
    const { row, a } = await seedPromptRow();
    const start = new ObjectId();
    fakeImageStore.set(start.toString(), { buffer: Buffer.from('start-still'), contentType: 'image/png' });
    await VP.updateVideoPrompt(projectId, row._id, { start_frame: { image_id: start, prompt: 'Sarah at the door' } });
    const prepared = await Falgen.prepareShotVideoJob({
      projectId,
      modelId: 'kling-3-pro',
      owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() },
    });
    expect(prepared.assignment.startFrameId?.toString()).toBe(start.toString());
    expect(prepared.assignment.startFrameId?.toString()).not.toBe(a.toString());
    expect(prepared.row.__owner).toEqual({ kind: 'video_prompt', id: row._id.toString() });
  });

  it('a first-last-frame model lands on the cut\'s end frame; an end frame alone never becomes the start', async () => {
    falStubs.storageImpl = async (file) =>
      `https://fal.media/inputs/${Buffer.from(await file.arrayBuffer()).toString()}`;
    const { beat, row } = await seedPromptRow();
    const start = new ObjectId();
    const end = new ObjectId();
    fakeImageStore.set(start.toString(), { buffer: Buffer.from('start-still'), contentType: 'image/png' });
    fakeImageStore.set(end.toString(), { buffer: Buffer.from('end-still'), contentType: 'image/png' });

    // End frame only: Kling's start slot stays empty (refused), never the end still.
    await VP.updateVideoPrompt(projectId, row._id, { end_frame: { image_id: end, prompt: 'The marquee' } });
    await expect(
      Falgen.prepareShotVideoJob({ projectId, modelId: 'kling-3-pro', owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() } }),
    ).rejects.toThrow(/start frame/);

    await VP.updateVideoPrompt(projectId, row._id, { start_frame: { image_id: start, prompt: 'The sky' } });
    const prepared = await Falgen.prepareShotVideoJob({ projectId, modelId: 'veo-3-1-flf', owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() } });
    expect(prepared.assignment.startFrameId?.toString()).toBe(start.toString());
    expect(prepared.assignment.endFrameId?.toString()).toBe(end.toString());

    const { job_id } = await Falgen.startVideoGenerationJob({
      projectId, modelId: 'kling-3-pro', owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() }, durationSeconds: 5,
    });
    await waitForBeatLock(beat._id);
    expect(Falgen.getVideoGenerationJob(job_id).status).toBe('done');
    const input = falStubs.submitCalls.at(-1).args.input;
    expect(input.start_image_url).toBe('https://fal.media/inputs/start-still');
    expect(input.end_image_url).toBe('https://fal.media/inputs/end-still');
  });

  it('a start-frame model refuses a cut without a rendered start frame', async () => {
    const { row } = await seedPromptRow();
    await expect(
      Falgen.prepareShotVideoJob({
        projectId,
        modelId: 'kling-3-pro',
        owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() },
      }),
    ).rejects.toThrow(/start frame/);
  });

  it('carries the cut audio, prepends the reference binding for reference models only, appends unseen exclusions', async () => {
    const VideoModels = await import('../src/fal/videoModels.js');
    if (!(await VideoModels.getVideoModelOrCatalog(REF_MODEL))) return;
    const { row } = await seedPromptRow();
    const audioId = new ObjectId();
    await VP.updateVideoPrompt(projectId, row._id, {
      reference_binding: '@Image1 is Sarah. @Image2 is the diner.',
      exclusions: ['No text on screen.', 'she enters.'],
      audio_file_id: audioId,
      audio_duration_seconds: 3.2,
    });
    const shim = await Falgen.loadVideoPromptOwner(projectId, row._id.toString());
    expect(shim.audio_file_id?.toString()).toBe(audioId.toString());
    expect(shim.audio_duration_seconds).toBe(3.2);
    expect(shim.__binding).toBe('@Image1 is Sarah. @Image2 is the diner.');
    // "she enters." already sits in the block → only the new exclusion is appended.
    expect(shim.text_prompt).toBe('@Image1 is Sarah, @Image2 is the diner. [Wide shot, static] she enters.\n\nNo text on screen.');

    const preview = await Falgen.buildVideoPayloadPreview({
      projectId,
      modelId: REF_MODEL,
      owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: row._id.toString() },
      includeDirectorNotes: false,
    });
    expect(preview.prompt.startsWith('@Image1 is Sarah. @Image2 is the diner.\n\n@Image1 is Sarah, @Image2')).toBe(true);
  });

  it('an unknown prompt id throws before any job is created', async () => {
    await expect(
      Falgen.prepareShotVideoJob({
        projectId,
        modelId: 'kling-3-pro',
        owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: new ObjectId().toString() },
      }),
    ).rejects.toThrow(/Video prompt not found/);
  });
});
