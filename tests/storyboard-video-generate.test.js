// Tests for the storyboard video generation orchestrator. The Wan client and
// OSS uploader are stubbed via the module's _setWan/_setOssImplForTests
// hooks so the test never hits Alibaba and we can drive specific success /
// failure paths.

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

// In-memory image/audio bytes keyed by id string. Tests register entries so
// readImageBuffer / readAttachmentBuffer return controllable buffers; unset
// ids return null, matching the production "not found" branch.
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

// Hocuspocus is never running in tests; the gateway falls back to direct
// Mongo writes through the storyboard helpers. We still need a stub for
// broadcastRoomStateless because the gateway imports it.
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => false,
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const VideoGen = await import('../src/web/storyboardVideoGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');

function makeFakeWan({ submitOk = true, taskStatuses = ['SUCCEEDED'], videoUrl = 'https://oss-out/v.mp4', videoBytes = new Uint8Array([0xff, 0xfe, 0xfd]) } = {}) {
  let pollIdx = 0;
  return {
    isConfigured: () => true,
    submitImageToVideo: vi.fn(async () => {
      if (!submitOk) throw new Error('submit failed');
      return { task_id: 'task-fake-1' };
    }),
    getTask: vi.fn(async () => {
      const status = taskStatuses[Math.min(pollIdx, taskStatuses.length - 1)];
      pollIdx += 1;
      return {
        status,
        video_url: status === 'SUCCEEDED' ? videoUrl : null,
        error_message: status === 'FAILED' ? 'fake failure' : null,
      };
    }),
    downloadVideo: vi.fn(async () => ({
      buffer: Buffer.from(videoBytes),
      contentType: 'video/mp4',
    })),
  };
}

function makeFakeOss() {
  const uploads = [];
  const deleted = [];
  return {
    impl: {
      isConfigured: () => true,
      uploadBuffer: vi.fn(async ({ buffer, contentType, keyPrefix }) => {
        uploads.push({ keyPrefix, contentType, size: buffer.length });
        const key = `wan-inputs/test/${keyPrefix || 'x'}-${uploads.length}.bin`;
        return { publicUrl: `https://oss.test/${key}`, key };
      }),
      deleteKeys: vi.fn(async (keys) => {
        deleted.push(...keys);
      }),
    },
    uploads,
    deleted,
  };
}

async function waitForBeatLock(beatId) {
  // Queue behind the current lock holder so we return only after the
  // orchestrator's background work finishes.
  await BeatLocks.withBeatLock(beatId, () => {});
}

async function seedScenario({
  withStart = true,
  withEnd = true,
  withSheet = true,
  withAudio = true,
} = {}) {
  const beat = await Plots.createBeat({ name: 'Test beat', body: 'body' });
  const sb = await Storyboards.createStoryboard({
    beatId: beat._id,
    textPrompt: 'Hero crosses the room.',
    durationSeconds: 5,
  });

  const patch = {};
  if (withStart) {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from('start-bytes'), contentType: 'image/png' });
    patch.start_frame_id = id;
  }
  if (withEnd) {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from('end-bytes'), contentType: 'image/png' });
    patch.end_frame_id = id;
  }
  if (withSheet) {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from('sheet-bytes'), contentType: 'image/png' });
    patch.character_sheet_image_id = id;
  }
  if (withAudio) {
    const id = new ObjectId();
    fakeAttachmentStore.set(id.toString(), {
      buffer: Buffer.from('audio-bytes'),
      contentType: 'audio/mpeg',
    });
    patch.audio_file_id = id;
  }
  if (Object.keys(patch).length) {
    await Storyboards.updateStoryboard(sb._id, patch);
  }
  const fresh = await Storyboards.getStoryboard(sb._id);
  return { beat, sb: fresh };
}

beforeEach(() => {
  fakeDb.reset();
  fakeImageStore.clear();
  fakeAttachmentStore.clear();
  uploadedAttachments.length = 0;
  BeatLocks._clearBeatLocksForTests();
  VideoGen._setWanImplForTests(null);
  VideoGen._setOssImplForTests(null);
});

describe('startVideoGenerationJob', () => {
  it('runs the happy path end-to-end and attaches the video to the storyboard', async () => {
    const { beat, sb } = await seedScenario();
    const wan = makeFakeWan();
    const oss = makeFakeOss();
    VideoGen._setWanImplForTests(wan);
    VideoGen._setOssImplForTests(oss.impl);

    const { job_id, estimated_seconds } = await VideoGen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
      durationSeconds: 6,
      resolution: '720P',
    });
    expect(job_id).toBeTruthy();
    expect(estimated_seconds).toBeGreaterThan(0);

    await waitForBeatLock(beat._id);

    const job = VideoGen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.task_id).toBe('task-fake-1');
    expect(job.video_file_id).toBeTruthy();

    // Four OSS uploads in the expected key categories.
    expect(oss.uploads.map((u) => u.keyPrefix).sort()).toEqual(
      ['audio', 'end', 'sheet', 'start'].sort(),
    );

    // Submission carried the four public URLs + the chosen duration/resolution.
    expect(wan.submitImageToVideo).toHaveBeenCalledTimes(1);
    const submitArgs = wan.submitImageToVideo.mock.calls[0][0];
    expect(submitArgs.firstFrameUrl).toMatch(/^https:\/\/oss.test\/wan-inputs/);
    expect(submitArgs.lastFrameUrl).toMatch(/^https:\/\/oss.test\/wan-inputs/);
    expect(submitArgs.refImageUrl).toMatch(/^https:\/\/oss.test\/wan-inputs/);
    expect(submitArgs.audioUrl).toMatch(/^https:\/\/oss.test\/wan-inputs/);
    expect(submitArgs.durationSeconds).toBe(6);
    expect(submitArgs.resolution).toBe('720P');
    // Prompt strips markdown and falls back to the row's text_prompt.
    expect(submitArgs.prompt).toMatch(/Hero crosses the room\./);

    // Storyboard row was updated via the gateway.
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.video_file_id?.toString()).toBe(job.video_file_id);
    expect(fresh.video_duration_seconds).toBe(6);
    expect(fresh.video_generated_at).toBeInstanceOf(Date);

    // GridFS attachment was created with the right metadata.
    expect(uploadedAttachments).toHaveLength(1);
    const persisted = uploadedAttachments[0];
    expect(persisted.content_type).toBe('video/mp4');
    expect(persisted.metadata.owner_type).toBe('beat');
    expect(persisted.metadata.owner_id?.toString?.()).toBe(beat._id.toString());

    // Best-effort cleanup of OSS keys runs in the orchestrator's `finally`.
    // Give the microtask queue a tick to flush it.
    await new Promise((r) => setImmediate(r));
    expect(oss.deleted.length).toBe(4);
  });

  it('rejects with MissingInputsError when any required input is absent', async () => {
    const { sb } = await seedScenario({ withAudio: false });
    VideoGen._setWanImplForTests(makeFakeWan());
    VideoGen._setOssImplForTests(makeFakeOss().impl);

    await expect(
      VideoGen.startVideoGenerationJob({ storyboardId: sb._id.toString() }),
    ).rejects.toBeInstanceOf(VideoGen.MissingInputsError);
  });

  it('rejects with VideoBeatBusyError when the beat lock is already held', async () => {
    const { beat, sb } = await seedScenario();
    VideoGen._setWanImplForTests(makeFakeWan());
    VideoGen._setOssImplForTests(makeFakeOss().impl);

    let release;
    const block = new Promise((r) => {
      release = r;
    });
    const lockHeld = BeatLocks.withBeatLock(beat._id, () => block);

    try {
      await expect(
        VideoGen.startVideoGenerationJob({ storyboardId: sb._id.toString() }),
      ).rejects.toBeInstanceOf(VideoGen.VideoBeatBusyError);
    } finally {
      release();
      await lockHeld;
    }
  });

  it('records an error on the job when Wan reports FAILED', async () => {
    const { beat, sb } = await seedScenario();
    const wan = makeFakeWan({ taskStatuses: ['RUNNING', 'FAILED'] });
    // RUNNING then FAILED — but the orchestrator's poll interval is config-
    // driven, so we shorten it for this test by stubbing setTimeout? No, the
    // simpler path: make the first status FAILED so it terminates on the
    // first poll.
    wan.getTask.mockReset();
    wan.getTask.mockResolvedValueOnce({
      status: 'FAILED',
      video_url: null,
      error_message: 'invalid input',
    });

    VideoGen._setWanImplForTests(wan);
    VideoGen._setOssImplForTests(makeFakeOss().impl);

    const { job_id } = await VideoGen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
    });
    await waitForBeatLock(beat._id);
    const job = VideoGen.getVideoGenerationJob(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/FAILED/);
    expect(job.error).toMatch(/invalid input/);

    // The storyboard's video_file_id was NOT set.
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.video_file_id).toBeNull();
  });

  it('surfaces a friendly error when DashScope is not configured', async () => {
    const { sb } = await seedScenario();
    VideoGen._setWanImplForTests({
      isConfigured: () => false,
      submitImageToVideo: vi.fn(),
      getTask: vi.fn(),
      downloadVideo: vi.fn(),
    });
    VideoGen._setOssImplForTests(makeFakeOss().impl);
    await expect(
      VideoGen.startVideoGenerationJob({ storyboardId: sb._id.toString() }),
    ).rejects.toBeInstanceOf(VideoGen.WanNotConfiguredError);
  });

  it('surfaces a friendly error when OSS is not configured', async () => {
    const { sb } = await seedScenario();
    VideoGen._setWanImplForTests(makeFakeWan());
    VideoGen._setOssImplForTests({
      isConfigured: () => false,
      uploadBuffer: vi.fn(),
      deleteKeys: vi.fn(),
    });
    await expect(
      VideoGen.startVideoGenerationJob({ storyboardId: sb._id.toString() }),
    ).rejects.toBeInstanceOf(VideoGen.WanNotConfiguredError);
  });

  it('uses the row\'s text_prompt when no prompt override is supplied', async () => {
    const { beat, sb } = await seedScenario();
    await Storyboards.updateStoryboard(sb._id, {
      text_prompt: '**Bold** scene with markdown.',
    });
    const wan = makeFakeWan();
    VideoGen._setWanImplForTests(wan);
    VideoGen._setOssImplForTests(makeFakeOss().impl);

    const { job_id } = await VideoGen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
    });
    await waitForBeatLock(beat._id);
    expect(VideoGen.getVideoGenerationJob(job_id).status).toBe('done');

    const promptArg = wan.submitImageToVideo.mock.calls[0][0].prompt;
    // Markdown stripped, content preserved.
    expect(promptArg).toMatch(/Bold scene with markdown\./);
    expect(promptArg).not.toMatch(/\*\*/);
  });

  it('estimated_seconds reflects historical durations after a successful run', async () => {
    // First run records its elapsed time into the rolling average.
    const { beat, sb } = await seedScenario();
    VideoGen._setWanImplForTests(makeFakeWan());
    VideoGen._setOssImplForTests(makeFakeOss().impl);
    const first = await VideoGen.startVideoGenerationJob({
      storyboardId: sb._id.toString(),
    });
    await waitForBeatLock(beat._id);
    expect(VideoGen.getVideoGenerationJob(first.job_id).status).toBe('done');

    // Second seed scenario for a second run. Its estimated_seconds should be
    // derived from the rolling average (which now has at least one entry),
    // bounded below by 30s.
    const second = await seedScenario();
    VideoGen._setWanImplForTests(makeFakeWan());
    VideoGen._setOssImplForTests(makeFakeOss().impl);
    const next = await VideoGen.startVideoGenerationJob({
      storyboardId: second.sb._id.toString(),
    });
    expect(next.estimated_seconds).toBeGreaterThanOrEqual(30);
  });
});
