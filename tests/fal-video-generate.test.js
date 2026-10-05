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
const VS = await import('../src/mongo/videoScenes.js');
const Falgen = await import('../src/web/falVideoGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');

// Jobs run in the background (no beat lock any more): poll the registry.
async function waitJob(jobId) {
  for (let i = 0; i < 500; i++) {
    const job = Falgen.getVideoGenerationJob(jobId);
    if (job && (job.status === 'done' || job.status === 'error')) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`fal job ${jobId} never finished`);
}

function newImage(bytes) {
  const id = new ObjectId();
  fakeImageStore.set(id.toString(), { buffer: Buffer.from(bytes), contentType: 'image/png' });
  return id;
}

// A cut in a scene, with (optionally) a rendered start and end frame — its
// prompt, its length and those two stills are all a cut hands a fal model.
// `beat` adds the cut to an existing beat (a new scene of it).
async function seedScene({ start = true, end = false, beat = null, prompt = 'Hero crosses the room.' } = {}) {
  const theBeat = beat || (await Plots.createBeat({ projectId, name: 'Test beat', body: 'body' }));
  const scene = await VS.createVideoScene({ projectId, beatId: theBeat._id, title: 'Scene' });
  const row = await VP.createVideoPrompt({
    projectId,
    beatId: theBeat._id,
    sceneId: scene._id,
    title: 'Crossing',
    prompt,
    durationSeconds: 5,
    // The frame's own references feed the IMAGE model only.
    startFrame: start ? { image_id: newImage('start'), prompt: 'Hero at the door', reference_ids: [newImage('artwork')] } : null,
    endFrame: end ? { image_id: newImage('end'), prompt: 'Hero at the window' } : null,
  });
  return { beat: theBeat, scene, sb: await VP.getVideoPrompt(projectId, row._id) };
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

    await waitJob(job_id);

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

  it('an audio-driven model (Kling AI Avatar) is refused: a cut carries no recording', async () => {
    const { sb } = await seedScene({ start: true });
    const err = await Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-avatar-v2-pro' }).catch((e) => e);
    expect(err).toBeInstanceOf(Falgen.MissingInputsError);
    expect(err.code).toBe('MISSING_INPUTS');
    expect(err.missing.join(' ')).toMatch(/audio/i);
    expect(falStubs.submitCalls).toHaveLength(0);
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
    await waitJob(job_id);

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
    await waitJob(job_id);
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
    await waitJob(job_id);
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
    await waitJob(job_id);

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
    await waitJob(job_id);
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

describe('prepareShotVideoJob', () => {
  it('validates without creating a job, and resolves a registered endpoint id', async () => {
    const { sb } = await seedScene({ start: true });
    const prepared = await Falgen.prepareShotVideoJob({
      projectId,
      owner: own(sb),
      modelId: 'fal-ai/kling-video/v3/pro/image-to-video',
    });
    expect(prepared.model.id).toBe('kling-3-pro');
    expect(prepared.assignment.startFrameId?.toString()).toBe(sb.start_frame.image_id.toString());
    expect(prepared.row._id.toString()).toBe(sb._id.toString());
    expect(prepared.row.__owner).toEqual({ kind: 'video_prompt', id: sb._id.toString() });
    expect(falStubs.submitCalls).toHaveLength(0);
  });

  it('throws MissingInputsError for a model whose required inputs are absent', async () => {
    const { sb } = await seedScene({ start: false });
    await expect(
      Falgen.prepareShotVideoJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' }),
    ).rejects.toThrow(/start frame/);
    await expect(
      Falgen.prepareShotVideoJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' }),
    ).rejects.toBeInstanceOf(Falgen.MissingInputsError);
  });

  it('requires a cut owner; an unknown or cross-project cut throws before any job is created', async () => {
    const { sb } = await seedScene({ start: true });
    await expect(Falgen.prepareShotVideoJob({ projectId, modelId: 'kling-3-pro' })).rejects.toThrow(/requires a cut owner/);
    await expect(
      Falgen.prepareShotVideoJob({ projectId, modelId: 'kling-3-pro', owner: { kind: 'storyboard', id: sb._id.toString() } }),
    ).rejects.toThrow(/requires a cut owner/);
    await expect(
      Falgen.prepareShotVideoJob({ projectId, modelId: 'kling-3-pro', owner: { kind: Falgen.OWNER_VIDEO_PROMPT, id: new ObjectId().toString() } }),
    ).rejects.toThrow(/Video prompt not found/);
    const other = (await createProject('Other'))._id.toString();
    await expect(Falgen.prepareShotVideoJob({ projectId: other, modelId: 'kling-3-pro', owner: own(sb) })).rejects.toThrow(
      /Video prompt not found/,
    );
  });

  it('the bulk-render entry point and the beat-busy error are gone', () => {
    expect(Falgen.runShotVideoInline).toBeUndefined();
    expect(Falgen.VideoBeatBusyError).toBeUndefined();
  });
});

describe('one render per cut, no beat lock', () => {
  // Holds every fal job inside subscribeToStatus until release() is called.
  function holdFal() {
    let release;
    const gate = new Promise((r) => { release = r; });
    falStubs.subscribeImpl = async () => { await gate; };
    return release;
  }
  const until = async (fn) => {
    for (let i = 0; i < 500; i++) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('condition never met');
  };

  it('a second start for the same cut is CUT_BUSY with the running job id; free again once it ends', async () => {
    const release = holdFal();
    const { sb } = await seedScene({ start: true });
    const first = await Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' });
    const err = await Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'sora-2' }).catch((e) => e);
    expect(err).toBeInstanceOf(Falgen.VideoCutBusyError);
    expect(err).toMatchObject({ code: 'CUT_BUSY', job_id: first.job_id });
    expect(err.message).toMatch(/already rendering for this cut/);
    // Still busy once the job is inside fal's queue.
    await until(() => falStubs.subscribeCalls.length === 1);
    await expect(Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' })).rejects.toMatchObject({
      code: 'CUT_BUSY',
      job_id: first.job_id,
    });
    expect(falStubs.submitCalls).toHaveLength(1);
    release();
    expect((await waitJob(first.job_id)).status).toBe('done');
    const again = await Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' });
    expect(again.job_id).not.toBe(first.job_id);
    expect((await waitJob(again.job_id)).status).toBe('done');
    expect(falStubs.submitCalls).toHaveLength(2);
  });

  it('a failed render frees the cut too', async () => {
    falStubs.subscribeImpl = async () => { throw new Error('queue boom'); };
    const { sb } = await seedScene({ start: true });
    const first = await Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' });
    expect((await waitJob(first.job_id)).status).toBe('error');
    falStubs.subscribeImpl = async () => undefined;
    const again = await Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' });
    expect((await waitJob(again.job_id)).status).toBe('done');
  });

  it('two different cuts of one beat both start and render side by side', async () => {
    const release = holdFal();
    const { beat, sb: one } = await seedScene({ start: true });
    const { sb: two } = await seedScene({ start: true, beat });
    expect(two.beat_id.toString()).toBe(one.beat_id.toString());
    const a = await Falgen.startVideoGenerationJob({ projectId, owner: own(one), modelId: 'kling-3-pro' });
    const b = await Falgen.startVideoGenerationJob({ projectId, owner: own(two), modelId: 'kling-3-pro' });
    expect(b.job_id).not.toBe(a.job_id);
    // Both are in fal's queue at once — neither waited for the other.
    await until(() => falStubs.subscribeCalls.length === 2);
    expect(Falgen.getVideoGenerationJob(a.job_id).status).not.toBe('done');
    expect(Falgen.getVideoGenerationJob(b.job_id).status).not.toBe('done');
    expect(Falgen.getVideoGenerationJob(a.job_id).owner_id).toBe(one._id.toString());
    expect(Falgen.getVideoGenerationJob(b.job_id).owner_id).toBe(two._id.toString());
    expect(Falgen.getVideoGenerationJob(a.job_id).beat_id).toBe(beat._id.toString());
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(false);
    release();
    expect((await waitJob(a.job_id)).status).toBe('done');
    expect((await waitJob(b.job_id)).status).toBe('done');
    const [r1, r2] = [await VP.getVideoPrompt(projectId, one._id), await VP.getVideoPrompt(projectId, two._id)];
    expect(r1.video_file_id).toBeTruthy();
    expect(r2.video_file_id).toBeTruthy();
    expect(String(r1.video_file_id)).not.toBe(String(r2.video_file_id));
  });

  it('a held beat lock does not stop a cut from rendering', async () => {
    const { beat, sb } = await seedScene({ start: true });
    let unlock;
    const held = BeatLocks.withBeatLock(beat._id, () => new Promise((r) => { unlock = r; }));
    const { job_id } = await Falgen.startVideoGenerationJob({ projectId, owner: own(sb), modelId: 'kling-3-pro' });
    expect((await waitJob(job_id)).status).toBe('done');
    unlock();
    await held;
  });
});

describe('what a cut hands the video model', () => {
  const REF_MODEL = 'bytedance/seedance-2.5/reference-to-video';
  const bytesUrl = async (file) => `https://fal.media/inputs/${Buffer.from(await file.arrayBuffer()).toString()}`;

  it('loadVideoPromptOwner: prompt, length and the two frames — no references, binding, exclusions or audio', async () => {
    const { sb } = await seedScene({ start: true, end: true, prompt: '**Hero** crosses the room.' });
    // Leftovers of the retired planner on an old row are ignored.
    await fakeDb.collection('video_prompts').updateOne(
      { _id: sb._id },
      {
        $set: {
          reference_binding: '@Image1 is Sarah.',
          exclusions: ['No text on screen.'],
          audio_file_id: new ObjectId(),
          audio_duration_seconds: 3.2,
          reference_images: [{ image_id: new ObjectId() }],
        },
      },
    );
    const shim = await Falgen.loadVideoPromptOwner(projectId, sb._id.toString());
    expect(shim.text_prompt).toBe('**Hero** crosses the room.');
    expect(shim.duration_seconds).toBe(5);
    expect(shim.title).toBe('Crossing');
    expect(shim.frames.map((f) => String(f.image_id))).toEqual([String(sb.start_frame.image_id), String(sb.end_frame.image_id)]);
    expect(shim.frames.every((f) => f.reference_ids.length === 0)).toBe(true);
    expect(String(shim.__start_frame_id)).toBe(String(sb.start_frame.image_id));
    expect(String(shim.__end_frame_id)).toBe(String(sb.end_frame.image_id));
    expect(shim.reference_image_ids).toEqual([]);
    expect(shim.audio_file_id).toBeNull();
    expect(shim.audio_duration_seconds).toBeNull();
    expect(shim.__binding).toBeNull();
    expect(shim.__owner).toEqual({ kind: 'video_prompt', id: sb._id.toString() });
    expect(await Falgen.loadVideoPromptOwner(projectId, new ObjectId().toString())).toBeNull();
    // No frames rendered: one empty start slot.
    const { sb: bare } = await seedScene({ start: false });
    const bareShim = await Falgen.loadVideoPromptOwner(projectId, bare._id.toString());
    expect(bareShim.frames).toEqual([{ image_id: null, reference_ids: [], reference_scores: {} }]);
    expect(bareShim.__start_frame_id).toBeNull();
    expect(bareShim.__end_frame_id).toBeNull();
  });

  it('the prompt sent is the cut\'s own, markdown stripped; director notes ride along only when asked', async () => {
    await fakeDb.collection('prompts').insertOne({
      _id: `${projectId}:director_notes`,
      notes: [{ _id: new ObjectId(), text: 'Always shoot from the hip.' }],
    });
    const { sb } = await seedScene({ start: true, prompt: '**Hero** crosses the room.' });
    const { job_id } = await Falgen.startVideoGenerationJob({
      projectId,
      modelId: 'kling-3-pro',
      owner: own(sb),
      includeDirectorNotes: false,
    });
    const job = await waitJob(job_id);
    expect(job.status).toBe('done');
    expect(job.owner_type).toBe('video_prompt');
    expect(job.owner_id).toBe(sb._id.toString());
    expect(falStubs.submitCalls[0].args.input.prompt).toBe('Hero crosses the room.');
    expect(uploadedAttachments[0].filename).toMatch(/^video-prompt-/);
    expect(uploadedAttachments[0].metadata.owner_type).toBe('beat');
    // No length asked for: the cut's own.
    const fresh = await VP.getVideoPrompt(projectId, sb._id);
    expect(fresh.video_parameters.duration_seconds).toBe(5);

    const without = await Falgen.buildVideoPayloadPreview({ projectId, modelId: 'kling-3-pro', owner: own(sb), includeDirectorNotes: false });
    expect(without.prompt).toBe('Hero crosses the room.');
    expect(without.duration_seconds).toBe(5);
    const withNotes = await Falgen.buildVideoPayloadPreview({ projectId, modelId: 'kling-3-pro', owner: own(sb) });
    expect(withNotes.prompt.startsWith('Hero crosses the room.')).toBe(true);
    expect(withNotes.prompt).toMatch(/shoot from the hip/);
    // A prompt typed into the dialog replaces the cut's.
    const over = await Falgen.buildVideoPayloadPreview({ projectId, modelId: 'kling-3-pro', owner: own(sb), prompt: 'Something else.', includeDirectorNotes: false });
    expect(over.prompt).toBe('Something else.');
  });

  it('a start-frame model gets the cut\'s rendered start frame and nothing from the frame\'s reference list', async () => {
    falStubs.storageImpl = bytesUrl;
    const { sb } = await seedScene({ start: true });
    expect(sb.start_frame.reference_ids).toHaveLength(1);
    const preview = await Falgen.buildVideoPayloadPreview({ projectId, modelId: 'kling-3-pro', owner: own(sb), includeDirectorNotes: false });
    expect(preview.inputs.map((i) => [i.slot, i.image_id])).toEqual([['startFrame', String(sb.start_frame.image_id)]]);
    const { job_id } = await Falgen.startVideoGenerationJob({ projectId, modelId: 'kling-3-pro', owner: own(sb) });
    expect((await waitJob(job_id)).status).toBe('done');
    expect(falStubs.storageUploads.map((u) => u.url)).toEqual(['https://fal.media/inputs/start']);
    const input = falStubs.submitCalls[0].args.input;
    expect(input.start_image_url).toBe('https://fal.media/inputs/start');
    expect(input.end_image_url).toBeUndefined();
    expect(input.image_urls).toBeUndefined();
  });

  it('a first-last-frame model lands on the cut\'s end frame; an end frame alone never becomes the start', async () => {
    falStubs.storageImpl = bytesUrl;
    // End frame only: Kling's start slot stays empty (refused), never the end still.
    const { sb: endOnly } = await seedScene({ start: false, end: true });
    await expect(Falgen.prepareShotVideoJob({ projectId, modelId: 'kling-3-pro', owner: own(endOnly) })).rejects.toThrow(/start frame/);

    const { sb } = await seedScene({ start: true, end: true });
    const prepared = await Falgen.prepareShotVideoJob({ projectId, modelId: 'veo-3-1-flf', owner: own(sb) });
    expect(prepared.assignment.startFrameId?.toString()).toBe(sb.start_frame.image_id.toString());
    expect(prepared.assignment.endFrameId?.toString()).toBe(sb.end_frame.image_id.toString());

    const { job_id } = await Falgen.startVideoGenerationJob({ projectId, modelId: 'kling-3-pro', owner: own(sb), durationSeconds: 5 });
    expect((await waitJob(job_id)).status).toBe('done');
    const input = falStubs.submitCalls.at(-1).args.input;
    expect(input.start_image_url).toBe('https://fal.media/inputs/start');
    expect(input.end_image_url).toBe('https://fal.media/inputs/end');
  });

  it('a reference-to-video model is sent no reference images: a cut has none of its own', async () => {
    const VideoModels = await import('../src/fal/videoModels.js');
    if (!(await VideoModels.getVideoModelOrCatalog(REF_MODEL))) return; // manifest drift
    const { sb } = await seedScene({ start: true, end: true });
    const outcome = await Falgen.buildVideoPayloadPreview({ projectId, modelId: REF_MODEL, owner: own(sb), includeDirectorNotes: false }).catch((e) => e);
    if (outcome instanceof Error) {
      // The model requires references → refused up front.
      expect(outcome).toBeInstanceOf(Falgen.MissingInputsError);
    } else {
      expect(outcome.inputs.filter((i) => i.slot === 'referenceImages')).toEqual([]);
      expect(outcome.payload.image_urls || []).toEqual([]);
      expect(outcome.prompt).toBe('Hero crosses the room.');
    }
  });
});
