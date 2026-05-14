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
}));

const uploadedAttachments = [];
vi.mock('../src/mongo/attachments.js', () => ({
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
  uploadAttachmentBuffer: vi.fn(async (args) => {
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

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Falgen = await import('../src/web/falVideoGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');

async function waitForBeatLock(beatId) {
  await BeatLocks.withBeatLock(beatId, () => {});
}

async function seedScene({
  start = true,
  end = true,
  // `sheet` is accepted for backwards-compat with existing test calls but
  // ignored — the storyboard no longer has a character_sheet slot. The video
  // pipeline ignores character sheets too.
  sheet: _sheet = false,
  audio = false,
  charactersInScene = [],
} = {}) {
  const beat = await Plots.createBeat({ name: 'Test beat', body: 'body' });
  const sb = await Storyboards.createStoryboard({
    beatId: beat._id,
    textPrompt: 'Hero crosses the room.',
    durationSeconds: 5,
    charactersInScene,
  });
  const patch = {};
  if (start) {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from('start'), contentType: 'image/png' });
    patch.start_frame_id = id;
  }
  if (end) {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from('end'), contentType: 'image/png' });
    patch.end_frame_id = id;
  }
  if (audio) {
    const id = new ObjectId();
    fakeAttachmentStore.set(id.toString(), { buffer: Buffer.from('audio'), contentType: 'audio/mpeg' });
    patch.audio_file_id = id;
  }
  if (Object.keys(patch).length) await Storyboards.updateStoryboard(sb._id, patch);
  return { beat, sb: await Storyboards.getStoryboard(sb._id) };
}

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

beforeEach(() => {
  fakeDb.reset();
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
  it('happy path for Kling 3 Pro: uploads only start/end + pinned character sheet → single element → submit/subscribe/result', async () => {
    // Seeding a character in scene must NOT cause its sheet to be uploaded —
    // images come only from the storyboard's explicit image slots.
    await seedCharacter('Steve', { sheetCount: 2 });
    const { beat, sb } = await seedScene({
      start: true,
      end: true,
      charactersInScene: ['Steve'],
    });

    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
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

    // Only start + end get uploaded — character_sheet is no longer a slot
    // on the storyboard, and Steve's character-doc sheets are ignored.
    expect(falStubs.storageUploads.map((u) => u.name).sort()).toEqual(
      ['end.png', 'start.png'],
    );

    // The submit call shape: start_image_url, end_image_url, no elements.
    expect(falStubs.submitCalls).toHaveLength(1);
    const submitInput = falStubs.submitCalls[0].args.input;
    expect(submitInput.start_image_url).toMatch(/^https:\/\/fal\.media\/inputs\//);
    expect(submitInput.end_image_url).toMatch(/^https:\/\/fal\.media\/inputs\//);
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

    // Storyboard row updated via the gateway.
    const fresh = await Storyboards.getStoryboard(sb._id);
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

  it('Kling 3 Pro: omits the elements array when no character sheet is pinned (characters_in_scene is ignored)', async () => {
    await seedCharacter('Steve', { sheetCount: 2 });
    const { beat, sb } = await seedScene({
      start: true,
      end: true,
      sheet: false,
      charactersInScene: ['Steve'],
    });

    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
      modelId: 'kling-3-pro',
      durationSeconds: 5,
    });
    await waitForBeatLock(beat._id);
    expect(Falgen.getVideoGenerationJob(job_id).status).toBe('done');

    // Only start + end uploaded — Steve's sheets are not pulled.
    expect(falStubs.storageUploads.map((u) => u.name).sort()).toEqual(
      ['end.png', 'start.png'],
    );
    const submitInput = falStubs.submitCalls[0].args.input;
    expect(submitInput.elements).toBeUndefined();
  });

  it('Veo 3.1 first-last-frame requires both frames; submit input has first_frame_url + last_frame_url', async () => {
    const { beat, sb } = await seedScene({ start: true, end: true });
    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
      modelId: 'veo-3-1-flf',
      durationSeconds: 8,
    });
    await waitForBeatLock(beat._id);
    expect(Falgen.getVideoGenerationJob(job_id).status).toBe('done');

    expect(falStubs.submitCalls[0].model).toBe('fal-ai/veo3.1/first-last-frame-to-video');
    const input = falStubs.submitCalls[0].args.input;
    expect(input.first_frame_url).toBeTruthy();
    expect(input.last_frame_url).toBeTruthy();
    expect(input.duration).toBe('8s');
    expect(input.generate_audio).toBe(true);
  });

  it('Veo 3.1 rejects with MissingInputsError when end frame is absent', async () => {
    const { sb } = await seedScene({ start: true, end: false });
    await expect(
      Falgen.startVideoGenerationJob({ storyboardId: sb._id.toString(), modelId: 'veo-3-1-flf' }),
    ).rejects.toBeInstanceOf(Falgen.MissingInputsError);
  });

  it('Kling AI Avatar: image_url falls back to start_frame when character_sheet is unavailable; audio_url required', async () => {
    const { beat, sb } = await seedScene({ start: true, audio: true });
    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
      modelId: 'kling-avatar-v2-pro',
    });
    await waitForBeatLock(beat._id);
    expect(Falgen.getVideoGenerationJob(job_id).status).toBe('done');

    expect(falStubs.submitCalls[0].model).toBe('fal-ai/kling-video/ai-avatar/v2/pro');
    const input = falStubs.submitCalls[0].args.input;
    expect(input.image_url).toBeTruthy();
    expect(input.audio_url).toBeTruthy();

    // With character_sheet retired from the storyboard schema, kling-avatar
    // uses the start_frame as the visual anchor instead.
    const startUpload = falStubs.storageUploads.find((u) => u.name === 'start.png');
    expect(input.image_url).toBe(startUpload.url);
  });

  it('Kling AI Avatar rejects with MissingInputsError when audio is absent', async () => {
    const { sb } = await seedScene({ start: true, audio: false });
    await expect(
      Falgen.startVideoGenerationJob({
        storyboardId: sb._id.toString(),
        modelId: 'kling-avatar-v2-pro',
      }),
    ).rejects.toBeInstanceOf(Falgen.MissingInputsError);
  });

  it('throws FalNotConfiguredError when FAL_KEY is unset', async () => {
    falStubs.isConfigured = vi.fn(() => false);
    const { sb } = await seedScene({ start: true, end: true });
    await expect(
      Falgen.startVideoGenerationJob({ storyboardId: sb._id.toString(), modelId: 'kling-3-pro' }),
    ).rejects.toBeInstanceOf(Falgen.FalNotConfiguredError);
  });

  it('throws UnknownVideoModelError on an unregistered model id', async () => {
    const { sb } = await seedScene({ start: true });
    await expect(
      Falgen.startVideoGenerationJob({ storyboardId: sb._id.toString(), modelId: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(Falgen.UnknownVideoModelError);
  });

  it('SSE pub/sub fans out queue updates and terminal status to subscribers', async () => {
    const events = [];
    falStubs.subscribeImpl = async (_model, { onQueueUpdate }) => {
      onQueueUpdate({ status: 'IN_QUEUE', queue_position: 3 });
      onQueueUpdate({ status: 'IN_PROGRESS' });
    };

    const { beat, sb } = await seedScene({ start: true, end: true });
    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
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
    const { beat, sb } = await seedScene({ start: true, end: true });
    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
      modelId: 'kling-3-pro',
    });
    await waitForBeatLock(beat._id);
    const job = Falgen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/queue boom/);
  });

  it('Sora 2: does not mint character refs from characters_in_scene; just renders the start frame', async () => {
    // Even with named characters on the storyboard, the orchestrator must
    // not call fal-ai/sora-2/characters or upload any character sheets.
    await seedCharacter('Alice', { sheetCount: 1 });
    const { beat, sb } = await seedScene({
      start: true,
      charactersInScene: ['Alice'],
    });

    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
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

    const { job_id } = await Falgen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
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
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.video_parameters?.resolution).toBe('1080p');
    expect(fresh.video_cost_usd).toBeCloseTo(8 * 0.5, 6);
  });
});
