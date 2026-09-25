// Beat render job end to end against the fakes: mode selection, auto-keyframe,
// dialogue audio concat, bounded concurrency, partial → resume → assemble,
// busy guard, and the SSE snapshot merge of per-shot fal state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
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
vi.mock('../src/fal/prepareImage.js', () => ({
  prepareImageForFal: async ({ buffer, contentType }) => ({ buffer, contentType }),
  renameForContentType: (name) => name,
}));

const fakeImageStore = new Map();
const fakeAttachmentStore = new Map();
const uploadedImages = [];
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeImageStore.get(key);
    if (!entry) return null;
    return { buffer: entry.buffer, file: { _id: id, contentType: entry.contentType, metadata: {} } };
  }),
  findImageFile: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeImageStore.get(key);
    return entry ? { _id: new ObjectId(key), contentType: entry.contentType, metadata: {} } : null;
  }),
  uploadGeneratedImage: vi.fn(async (_pid, { filename }) => {
    const id = new ObjectId();
    fakeImageStore.set(id.toString(), { buffer: Buffer.from('still'), contentType: 'image/png' });
    uploadedImages.push(id);
    return { _id: id, filename, contentType: 'image/png', metadata: {} };
  }),
  deleteImages: vi.fn(async () => {}),
  deleteImage: vi.fn(async () => {}),
}));

const uploadedAttachments = [];
vi.mock('../src/mongo/attachments.js', () => ({
  readAttachmentBuffer: vi.fn(async (id) => {
    const key = id?.toString?.() || String(id);
    const entry = fakeAttachmentStore.get(key);
    if (!entry) return null;
    return { buffer: entry.buffer, file: { _id: id, contentType: entry.contentType, metadata: { content_type: entry.contentType } } };
  }),
  uploadAttachmentBuffer: vi.fn(async (_projectId, args) => {
    const file = {
      _id: new ObjectId(),
      filename: args.filename,
      content_type: args.contentType,
      size: args.buffer?.length || 0,
      metadata: { owner_type: args.ownerType, owner_id: args.ownerId, content_type: args.contentType, generated_by: args.generatedBy || null },
      uploaded_at: new Date(),
    };
    fakeAttachmentStore.set(file._id.toString(), { buffer: args.buffer, contentType: args.contentType });
    uploadedAttachments.push({ ...file, buffer: args.buffer });
    return file;
  }),
  findAttachmentFile: vi.fn(async () => null),
  deleteAttachment: vi.fn(async () => {}),
  deleteAttachments: vi.fn(async () => {}),
  streamAttachmentToTmp: vi.fn(async () => { throw new Error('not used'); }),
}));

// Duration probe for the concat MP3 the lipsync path attaches.
vi.mock('../src/fal/videoPricing.js', async () => {
  const actual = await vi.importActual('../src/fal/videoPricing.js');
  return { ...actual, probeAudioDurationSeconds: vi.fn(async () => 3.2) };
});

// A synthetic reference-to-video model, registered under a fake endpoint.
const DIRECT_MODEL = {
  id: 'fake/direct',
  label: 'Fake Direct',
  falModel: 'fake/direct',
  durations: ['4', '8'],
  defaultDuration: '4',
  supportsGenerateAudio: false,
  inputs: { startFrame: 'unused', endFrame: 'unused', characterSheet: 'unused', referenceImages: 'optional', audio: 'unused', videoInput: 'unused' },
  buildInput: (b) => ({ prompt: b.prompt, image_urls: b.referenceImageUrls, duration: String(b.durationSeconds) }),
  extractVideoUrl: (d) => d?.video?.url || null,
};
vi.mock('../src/fal/videoModels.js', async () => {
  const actual = await vi.importActual('../src/fal/videoModels.js');
  return {
    ...actual,
    resolveVideoModelByAnyId: async (id) => (id === 'fake/direct' ? DIRECT_MODEL : actual.resolveVideoModelByAnyId(id)),
    getVideoModelCatalogMeta: async () => null,
  };
});

// fal client: records submits, resolves through a per-test hook so tests can
// gate concurrency or fail specific shots.
let falStubs;
function resetFalStubs() {
  falStubs = {
    submitCalls: [],
    inFlight: 0,
    maxInFlight: 0,
    failModelsFor: new Set(), // storyboard ids (via prompt marker) that should fail
    subscribeImpl: async () => undefined,
  };
}
resetFalStubs();
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => true,
  fal: {
    storage: { upload: vi.fn(async (file) => `https://fal.media/inputs/${file?.name || 'asset'}`) },
    queue: {
      submit: vi.fn(async (model, args) => {
        falStubs.submitCalls.push({ model, args });
        return { request_id: `req-${falStubs.submitCalls.length}` };
      }),
      subscribeToStatus: vi.fn(async (model, args) => {
        falStubs.inFlight += 1;
        falStubs.maxInFlight = Math.max(falStubs.maxInFlight, falStubs.inFlight);
        try {
          args.onQueueUpdate?.({ status: 'IN_PROGRESS', queue_position: 0, logs: [{ message: 'working' }] });
          await falStubs.subscribeImpl(model, args);
        } finally {
          falStubs.inFlight -= 1;
        }
      }),
      result: vi.fn(async (model, { requestId }) => {
        const call = falStubs.submitCalls[Number(requestId.split('-')[1]) - 1];
        if (falStubs.failModelsFor.has(call?.args?.input?.prompt)) throw new Error('fal exploded');
        return { data: { video: { url: 'https://fal.media/out.mp4' } } };
      }),
    },
  },
}));

const realFetch = global.fetch;
const assembleCalls = [];
vi.mock('../src/web/beatAssemble.js', () => ({
  assembleBeatVideo: vi.fn(async ({ projectId, beat, shots }) => {
    assembleCalls.push(shots.map((s) => String(s._id)));
    const { setBeatVideoViaGateway } = await import('../src/web/gateway.js');
    const file = { _id: new ObjectId() };
    await setBeatVideoViaGateway({ projectId, beatId: beat._id, fileId: file._id, durationSeconds: 9 });
    return { file, durationSeconds: 9 };
  }),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Settings = await import('../src/mongo/projectSettings.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const Audio = await import('../src/web/audioTranscode.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Falgen = await import('../src/web/falVideoGenerate.js');
const Render = await import('../src/web/beatRender.js');
const { config } = await import('../src/config.js');

let projectId;
let audioConcatCalls;

beforeEach(async () => {
  fakeDb.reset();
  fakeImageStore.clear();
  fakeAttachmentStore.clear();
  uploadedImages.length = 0;
  uploadedAttachments.length = 0;
  assembleCalls.length = 0;
  resetFalStubs();
  BeatLocks._clearBeatLocksForTests();
  Falgen._resetForTests();
  Render._resetBeatRenderForTests();
  projectId = (await createProject('Test Project'))._id.toString();
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'video/mp4' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  }));
  audioConcatCalls = [];
  Audio.__setAudioFfmpegImplForTests(async ({ args, inputPaths, outputPath }) => {
    audioConcatCalls.push({ args, inputs: inputPaths ? inputPaths.length : 1 });
    fs.writeFileSync(outputPath, Buffer.from('mp3'));
  });
  Generate._setImageDispatcherForTests(async () => ({ buffer: Buffer.from('png'), contentType: 'image/png' }));
  config.fal.videoConcurrency = 2;
});
afterEach(() => {
  global.fetch = realFetch;
  Audio.__setAudioFfmpegImplForTests(null);
  Generate._setImageDispatcherForTests(null);
});

async function seedBeat({ shots }) {
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'x', characters: ['Sarah', 'Tom'] });
  const dialogs = [];
  const rows = [];
  for (const s of shots) {
    const lineIds = [];
    for (const line of s.lines || []) {
      const d = await Dialogs.createDialog({ projectId, beatId: beat._id, character: line.who, body: line.text });
      if (line.audio) {
        const aid = new ObjectId();
        fakeAttachmentStore.set(aid.toString(), { buffer: Buffer.from(`rec-${line.text}`), contentType: 'audio/webm' });
        await fakeDb.collection('dialogs').updateOne({ _id: d._id }, { $set: { audio_file_id: aid.toString(), audio_duration_seconds: 1.5 } });
      }
      dialogs.push(d);
      lineIds.push(d._id);
    }
    const sb = await Storyboards.createStoryboard({
      projectId,
      beatId: beat._id,
      textPrompt: s.prompt ?? `Prompt ${rows.length}`,
      shotType: s.shotType || 'medium',
      durationSeconds: s.duration || 4,
      charactersInScene: s.cast || ['Sarah'],
      dialogIds: lineIds,
    });
    // Planner rows always carry frames[0] (empty prompt + scored references);
    // seed it the same way here. `bare` rows keep an empty pool on purpose.
    if (!s.bare) {
      let imageId = null;
      if (s.still) {
        imageId = new ObjectId();
        fakeImageStore.set(imageId.toString(), { buffer: Buffer.from('start'), contentType: 'image/png' });
      }
      const refIds = (s.refs || []).map(() => new ObjectId());
      for (const id of refIds) fakeImageStore.set(id.toString(), { buffer: Buffer.from('ref'), contentType: 'image/png' });
      await Storyboards.addFrame(sb._id, { imageId, referenceIds: refIds });
      if (refIds.length) {
        await fakeDb.collection('storyboards').updateOne(
          { _id: sb._id },
          { $set: { 'frames.0.reference_scores': Object.fromEntries(refIds.map((id, i) => [String(id), 1 - i * 0.1])) } },
        );
      }
    }
    if (s.clip) {
      await Storyboards.updateStoryboard(projectId, sb._id, { video_file_id: new ObjectId() });
    }
    rows.push(await Storyboards.getStoryboard(projectId, sb._id));
  }
  void dialogs;
  return { beat, rows, dialogs: await Dialogs.listDialogs({ beatId: beat._id }) };
}

async function waitForJob(jobId) {
  for (let i = 0; i < 400; i++) {
    const job = Render.getBeatRenderJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return Render.serializeBeatJob(job);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('beat render job never finished');
}

describe('buildBeatRenderPlan', () => {
  it('picks lipsync for fully recorded shots, direct when configured, start_only otherwise, and flags auto stills', async () => {
    const { beat, rows, dialogs } = await seedBeat({
      shots: [
        { lines: [{ who: 'Sarah', text: 'Hi', audio: true }, { who: 'Tom', text: 'Hey', audio: true }] },
        { lines: [{ who: 'Sarah', text: 'Unrecorded' }] },
        { still: true },
        { clip: true },
      ],
    });
    const base = { projectId, beat, shots: rows, dialogs, modelDefaults: { lipsync: null, video_direct: null, video_start_only: null } };

    const noDirect = await Render.buildBeatRenderPlan(base);
    expect(noDirect.shots.map((s) => s.mode)).toEqual(['lipsync', 'start_only', 'start_only', null]);
    expect(noDirect.shots[0].auto_keyframe).toBe(true); // kling-avatar needs a still
    expect(noDirect.shots[0].model_id).toBe(Render.FALLBACK_LIPSYNC_MODEL_ID);
    expect(noDirect.shots[0].speech_seconds).toBeCloseTo(3 + 0.25 + 0.3, 5);
    expect(noDirect.shots[1].auto_keyframe).toBe(true);
    expect(noDirect.shots[1].warnings.join(' ')).toMatch(/no recording/);
    expect(noDirect.shots[2].auto_keyframe).toBe(false); // has a still already
    expect(noDirect.shots[3].skipped).toBe(true);
    expect(noDirect.shots[3].skip_reason).toBe('already rendered');

    const withDirect = await Render.buildBeatRenderPlan({ ...base, modelDefaults: { ...base.modelDefaults, video_direct: 'fake/direct' } });
    expect(withDirect.shots.map((s) => s.mode)).toEqual(['lipsync', 'direct', 'direct', null]);
    expect(withDirect.shots[1].auto_keyframe).toBe(false);
    expect(withDirect.shots[1].model_label).toBe('Fake Direct');
    expect(withDirect.models.direct.known).toBe(true);

    const rerender = await Render.buildBeatRenderPlan({ ...base, skipRendered: false });
    expect(rerender.shots[3].skipped).toBe(false);
    expect(rerender.shots[3].mode).toBe('start_only');
  });

  it('skips shots without a prompt and reports an unknown model as blocked', async () => {
    const { beat, rows, dialogs } = await seedBeat({ shots: [{ prompt: '' }, { still: true }] });
    const plan = await Render.buildBeatRenderPlan({
      projectId, beat, shots: rows, dialogs,
      modelDefaults: { lipsync: null, video_direct: null, video_start_only: 'nope/unknown' },
    });
    expect(plan.shots[0].skipped).toBe(true);
    expect(plan.shots[0].skip_reason).toBe('no prompt');
    expect(plan.shots[1].status).toBe('blocked');
    expect(plan.shots[1].missing).toEqual(['video model']);
  });
});

describe('startBeatRenderJob', () => {
  it('renders every shot (auto still + concat audio where needed), then assembles', async () => {
    await Settings.setModelDefaults(projectId, { video_direct: 'fake/direct' });
    const { beat, rows } = await seedBeat({
      shots: [
        { lines: [{ who: 'Sarah', text: 'Hi', audio: true }, { who: 'Tom', text: 'Hey', audio: true }], prompt: 'P-lip' },
        { refs: ['a', 'b'], prompt: 'P-direct' },
        { still: true, prompt: 'P-still' },
      ],
    });
    const { job_id, planned, skipped } = await Render.startBeatRenderJob({ projectId, beatId: beat._id });
    expect(planned).toBe(3);
    expect(skipped).toBe(0);
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(3);
    expect(job.failed).toBe(0);
    expect(job.video_file_id).toBeTruthy();
    expect(job.video_duration_seconds).toBe(9);
    expect(assembleCalls).toHaveLength(1);
    expect(assembleCalls[0]).toEqual(rows.map((r) => String(r._id)));

    // Lipsync shot: a still was rendered first (kling-avatar needs one), the two
    // recordings were joined into one MP3 and attached as the scene audio.
    expect(uploadedImages).toHaveLength(1);
    expect(audioConcatCalls).toHaveLength(1);
    expect(audioConcatCalls[0].inputs).toBe(2);
    const lip = await Storyboards.getStoryboard(projectId, rows[0]._id);
    expect(lip.audio_file_id).toBeTruthy();
    expect(lip.audio_duration_seconds).toBe(3.2);
    expect(lip.frames[0].image_id).toBeTruthy();
    const lipSubmit = falStubs.submitCalls.find((c) => c.args.input.prompt.startsWith('P-lip'));
    expect(lipSubmit.model).toBe('fal-ai/kling-video/ai-avatar/v2/pro');
    expect(lipSubmit.args.input.audio_url).toMatch(/^https:\/\/fal\.media/);

    // Direct shot: scored references went out, no still was rendered for it.
    const direct = falStubs.submitCalls.find((c) => c.model === 'fake/direct');
    expect(direct.args.input.image_urls).toHaveLength(2);
    expect(direct.args.input.duration).toBe('4');

    // Every shot now has a clip; the beat points at the assembled video.
    for (const r of rows) expect((await Storyboards.getStoryboard(projectId, r._id)).video_file_id).toBeTruthy();
    expect((await Plots.getBeat(projectId, beat._id)).video_file_id).toBe(job.video_file_id);
    // Prompts never carry dialogue words.
    for (const c of falStubs.submitCalls) {
      expect(c.args.input.prompt).not.toMatch(/\bHi\b|\bHey\b/);
    }
  });

  it('keeps at most FAL_VIDEO_CONCURRENCY shots in flight', async () => {
    await Settings.setModelDefaults(projectId, { video_direct: 'fake/direct' });
    const { beat } = await seedBeat({ shots: [{}, {}, {}, {}, {}] });
    falStubs.subscribeImpl = () => new Promise((r) => setTimeout(r, 15));
    const { job_id } = await Render.startBeatRenderJob({ projectId, beatId: beat._id });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(falStubs.maxInFlight).toBe(2);
    expect(falStubs.maxInFlight).toBeLessThanOrEqual(config.fal.videoConcurrency);
  });

  it('a failed shot leaves the job partial without assembly; a re-run renders only that shot and assembles', async () => {
    await Settings.setModelDefaults(projectId, { video_direct: 'fake/direct' });
    const { beat, rows } = await seedBeat({ shots: [{ prompt: 'P-ok' }, { prompt: 'P-bad' }, { prompt: 'P-ok2' }] });
    falStubs.failModelsFor.add('P-bad');
    const first = await waitForJob((await Render.startBeatRenderJob({ projectId, beatId: beat._id })).job_id);
    expect(first.status).toBe('partial');
    expect(first.completed).toBe(2);
    expect(first.failed).toBe(1);
    expect(first.assembly_skipped_reason).toMatch(/1 shot failed/);
    expect(first.shots[1].status).toBe('failed');
    expect(first.shots[1].error).toMatch(/fal exploded/);
    expect(assembleCalls).toHaveLength(0);
    expect((await Storyboards.getStoryboard(projectId, rows[1]._id)).video_file_id).toBeNull();

    falStubs.failModelsFor.clear();
    const submitsBefore = falStubs.submitCalls.length;
    const resume = await Render.startBeatRenderJob({ projectId, beatId: beat._id });
    expect(resume.planned).toBe(1);
    expect(resume.skipped).toBe(2);
    const second = await waitForJob(resume.job_id);
    expect(second.status).toBe('done');
    expect(falStubs.submitCalls.length - submitsBefore).toBe(1);
    expect(assembleCalls).toHaveLength(1);
    expect(second.video_file_id).toBeTruthy();
  });

  it('seeds a frame slot for a hand-added row that needs an auto still', async () => {
    const { beat, rows } = await seedBeat({ shots: [{ bare: true, prompt: 'P-bare' }] });
    expect(rows[0].frames).toEqual([]);
    const { job_id } = await Render.startBeatRenderJob({ projectId, beatId: beat._id });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.shots[0].auto_keyframe).toBe(true);
    const fresh = await Storyboards.getStoryboard(projectId, rows[0]._id);
    expect(fresh.frames).toHaveLength(1);
    expect(fresh.frames[0].image_id).toBeTruthy();
    expect(fresh.frames[0].prompt).toBe('');
  });

  it('assembles without rendering when every shot already has a clip', async () => {
    const { beat } = await seedBeat({ shots: [{ clip: true }, { clip: true }] });
    const out = await Render.startBeatRenderJob({ projectId, beatId: beat._id });
    expect(out.planned).toBe(0);
    const job = await waitForJob(out.job_id);
    expect(job.status).toBe('done');
    expect(falStubs.submitCalls).toHaveLength(0);
    expect(assembleCalls).toHaveLength(1);
  });

  it('refuses a beat with no shots and a beat whose lock is held', async () => {
    const empty = await Plots.createBeat({ projectId, name: 'Empty' });
    await expect(Render.startBeatRenderJob({ projectId, beatId: empty._id })).rejects.toBeInstanceOf(Render.BeatRenderEmptyError);

    const { beat } = await seedBeat({ shots: [{ still: true }] });
    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => { release = r; }));
    await expect(Render.startBeatRenderJob({ projectId, beatId: beat._id })).rejects.toBeInstanceOf(Render.BeatRenderBusyError);
    release();
  });

  it('streams per-shot fal state into the beat job snapshots', async () => {
    await Settings.setModelDefaults(projectId, { video_direct: 'fake/direct' });
    const { beat } = await seedBeat({ shots: [{ prompt: 'P-one' }] });
    falStubs.subscribeImpl = () => new Promise((r) => setTimeout(r, 10));
    const { job_id } = await Render.startBeatRenderJob({ projectId, beatId: beat._id });
    const seen = [];
    const listener = (snap) => seen.push(snap.shots[0]?.status);
    Render.subscribeToBeatJob(job_id, listener);
    const job = await waitForJob(job_id);
    Render.unsubscribeFromBeatJob(job_id, listener);
    expect(job.shots[0].job_id).toMatch(/^[a-z0-9-]+$/i);
    expect(job.shots[0].status).toBe('done');
    // The per-shot fal status (IN_PROGRESS) surfaced through the beat stream.
    expect(seen).toContain('IN_PROGRESS');
    expect(job.events.some((e) => e.step === 'shot_done')).toBe(true);
    expect(job.events.some((e) => e.step === 'job_done')).toBe(true);
  });
});

describe('buildBeatRenderPreview', () => {
  it('returns the plan with counts, coverage, and assembly outlook', async () => {
    await Settings.setModelDefaults(projectId, { video_direct: 'fake/direct' });
    const { beat } = await seedBeat({
      shots: [
        { lines: [{ who: 'Sarah', text: 'Hi', audio: true }] },
        { lines: [{ who: 'Tom', text: 'Never assigned' }], cast: ['Sarah'] },
      ],
    });
    // Unassign line 2 so coverage has something to say.
    const rows = await Storyboards.listStoryboards({ beatId: beat._id });
    await Storyboards.updateStoryboard(projectId, rows[1]._id, { dialog_ids: [] });
    const preview = await Render.buildBeatRenderPreview({ projectId, beatId: beat._id });
    expect(preview.beat._id).toBe(String(beat._id));
    expect(preview.fal_configured).toBe(true);
    expect(preview.counts).toMatchObject({ total: 2, to_render: 2, lipsync: 1, direct: 1, auto_keyframes: 1 });
    expect(preview.will_assemble).toBe(true);
    expect(preview.coverage.checks.map((c) => c.code)).toContain('dialog_unassigned');
    expect(preview.models.direct.label).toBe('Fake Direct');
  });
});
