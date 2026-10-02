// Prompts-tab Render beat job end to end against the fakes: mode selection
// (lip-sync where every covered line is recorded), auto start frames, the
// ComfyUI path (serial, params from the saved per-model defaults, provider
// + seed persisted) and the fal path (bounded concurrency, joined dialogue
// audio), partial → resume → assemble, and the guards (busy, unconfigured,
// spend consent, nothing to render).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.COMFY_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-beat-render-'));

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null, withDirectDocument: vi.fn(), broadcastRoomStateless: vi.fn(), isHocuspocusRunning: () => false,
}));
vi.mock('../src/fal/prepareImage.js', () => ({
  prepareImageForFal: async ({ buffer, contentType }) => ({ buffer, contentType }),
  renameForContentType: (name) => name,
}));

const fakeImageStore = new Map();
const fakeAttachmentStore = new Map();
const uploadedImages = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readImageBuffer: vi.fn(async (id) => {
      const e = fakeImageStore.get(String(id));
      return e ? { buffer: e.buffer, file: { _id: id, contentType: e.contentType, metadata: {} } } : null;
    }),
    findImageFile: vi.fn(async (id) => {
      const e = fakeImageStore.get(String(id));
      return e ? { _id: new ObjectId(String(id)), contentType: e.contentType, metadata: {} } : null;
    }),
    uploadGeneratedImage: vi.fn(async (_pid, { filename }) => {
      const id = new ObjectId();
      fakeImageStore.set(id.toString(), { buffer: Buffer.from('still'), contentType: 'image/png' });
      uploadedImages.push(id);
      return { _id: id, filename, contentType: 'image/png', metadata: {} };
    }),
    deleteImages: vi.fn(async () => {}),
    deleteImage: vi.fn(async () => {}),
  };
});
const uploadedAttachments = [];
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readAttachmentBuffer: vi.fn(async (id) => {
      const e = fakeAttachmentStore.get(String(id));
      return e ? { buffer: e.buffer, file: { _id: id, contentType: e.contentType, metadata: { content_type: e.contentType } } } : null;
    }),
    findAttachmentFile: vi.fn(async (id) => {
      const e = fakeAttachmentStore.get(String(id));
      return e ? { _id: new ObjectId(String(id)), filename: 'a', contentType: e.contentType, metadata: { content_type: e.contentType } } : null;
    }),
    uploadAttachmentBuffer: vi.fn(async (_pid, args) => {
      const file = {
        _id: new ObjectId(), filename: args.filename, content_type: args.contentType, size: args.buffer?.length || 0,
        metadata: { owner_type: args.ownerType, owner_id: args.ownerId, content_type: args.contentType, generated_by: args.generatedBy || null },
      };
      fakeAttachmentStore.set(file._id.toString(), { buffer: args.buffer, contentType: args.contentType });
      uploadedAttachments.push(file);
      return file;
    }),
    deleteAttachment: vi.fn(async () => {}),
    deleteAttachments: vi.fn(async () => {}),
    streamAttachmentToTmp: vi.fn(async () => { throw new Error('not used'); }),
  };
});
vi.mock('../src/fal/videoPricing.js', async () => {
  const actual = await vi.importActual('../src/fal/videoPricing.js');
  return { ...actual, probeAudioDurationSeconds: vi.fn(async () => 3.2) };
});
vi.mock('../src/fal/videoModels.js', async () => {
  const actual = await vi.importActual('../src/fal/videoModels.js');
  return { ...actual, getVideoModelCatalogMeta: async () => null };
});

let falStubs;
function resetFalStubs() {
  falStubs = { submitCalls: [], inFlight: 0, maxInFlight: 0, failPrompts: new Set(), subscribeImpl: async () => undefined, configured: true };
}
resetFalStubs();
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => falStubs.configured,
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
          args.onQueueUpdate?.({ status: 'IN_PROGRESS', queue_position: 0, logs: [] });
          await falStubs.subscribeImpl(model, args);
        } finally {
          falStubs.inFlight -= 1;
        }
      }),
      result: vi.fn(async (_model, { requestId }) => {
        const call = falStubs.submitCalls[Number(requestId.split('-')[1]) - 1];
        if ([...falStubs.failPrompts].some((p) => call?.args?.input?.prompt?.includes(p))) throw new Error('fal exploded');
        return { data: { video: { url: 'https://fal.media/out.mp4' } } };
      }),
    },
  },
}));

const TEMPLATE_PATH = path.join(process.env.COMFY_WORK_DIR, 'template-stub.json');
fs.writeFileSync(TEMPLATE_PATH, JSON.stringify({ nodes: [], stub: true }));
vi.mock('../src/comfy/templates.js', () => ({
  ensureTemplateFile: vi.fn(async () => ({ path: TEMPLATE_PATH, local_check: { checked: true, runnable: true } })),
  ComfyTemplateNotRunnableError: class extends Error {},
}));

const assembleCalls = [];
vi.mock('../src/web/cutAssemble.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    assemblePromptsBeatVideo: vi.fn(async ({ projectId, beat, cuts }) => {
      assembleCalls.push(cuts.map((c) => String(c._id)));
      const { setBeatPromptsVideoViaGateway } = await import('../src/web/gateway.js');
      const file = { _id: new ObjectId() };
      await setBeatPromptsVideoViaGateway({ projectId, beatId: beat._id, fileId: file._id, durationSeconds: 9 });
      return { file, durationSeconds: 9 };
    }),
  };
});

const realFetch = global.fetch;
const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const Settings = await import('../src/mongo/projectSettings.js');
const Audio = await import('../src/web/audioTranscode.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Falgen = await import('../src/web/falVideoGenerate.js');
const Client = await import('../src/comfy/client.js');
const Gen = await import('../src/web/comfyVideoGenerate.js');
const SF = await import('../src/web/cutStartFrames.js');
const Render = await import('../src/web/cutBeatRender.js');
const { config } = await import('../src/config.js');

let projectId;
let comfyConfigured;
const realIsConfigured = Client.isComfyConfigured;

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
  Gen._resetComfyJobsForTests();
  Gen._setComfyRunnerOptionsForTests({ pollIntervalMs: 2, jobTimeoutMs: 5000 });
  Render._resetCutBeatRenderForTests();
  comfyConfigured = false;
  Client._setComfyClientForTests(null);
  SF._setStartFrameDispatcherForTests(async () => ({ buffer: Buffer.from('png'), contentType: 'image/png' }));
  Audio.__setAudioFfmpegImplForTests(async ({ outputPath }) => fs.writeFileSync(outputPath, Buffer.from('mp3')));
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
  config.fal.videoConcurrency = 2;
  projectId = (await createProject('Cut Render'))._id.toString();
});
afterEach(() => {
  global.fetch = realFetch;
  Audio.__setAudioFfmpegImplForTests(null);
  SF._setStartFrameDispatcherForTests(null);
});
afterAll(async () => {
  await fs.promises.rm(process.env.COMFY_WORK_DIR, { recursive: true, force: true });
  void realIsConfigured;
});

// isComfyConfigured() is true whenever a test client is installed, so
// "enabling" ComfyUI here means installing one (a scripted fake).
function enableComfy(client = null) {
  const c = client || fakeComfyClient();
  Client._setComfyClientForTests(c);
  comfyConfigured = true;
  return c;
}

function fakeComfyClient({ failPrompts = new Set() } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      switch (name) {
        case 'upload_file':
          return { uploads: args.paths.map((p) => ({ local_path: p, cloud_name: path.basename(p), subfolder: '', type: 'input' })) };
        case 'list_workflow_slots':
          return { slots: [{ address: '398.value' }, { address: '340.value' }] };
        case 'set_workflow_slot': {
          const prompt = args.overrides.find((o) => o.address === '398.value' || o.address === '340.value')?.value || '';
          if ([...failPrompts].some((p) => prompt.includes(p))) throw new Client.ComfyToolError('set_workflow_slot', 'boom');
          return { ok: true };
        }
        case 'run_workflow':
          return { prompt_id: `prompt-${++i}`, status: 'queued' };
        case 'job':
          return { prompt_id: args.prompt_id, status: 'completed' };
        case 'fetch_outputs': {
          await fs.promises.mkdir(args.out_dir, { recursive: true });
          const out = path.join(args.out_dir, 'clip_00001_.mp4');
          await fs.promises.writeFile(out, Buffer.from('fake-mp4'));
          return { saved: [out] };
        }
        default:
          return {};
      }
    },
  };
}

function newImage() {
  const id = new ObjectId();
  fakeImageStore.set(id.toString(), { buffer: Buffer.from(`img-${id}`), contentType: 'image/png' });
  return id;
}

// cuts: [{ lines:[{who,text,audio}], still, clip, prompt, sfPrompt, endStill, efPrompt }]
async function seedBeat({ cuts }) {
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'Sarah waits.', characters: ['Sarah', 'Tom'], sets: ['Diner'] });
  const scene = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Arrival', slug: 'INT. DINER — NIGHT' });
  const rows = [];
  for (const c of cuts) {
    const ids = [];
    for (const line of c.lines || []) {
      const d = await Dialogs.createDialog({ projectId, beatId: beat._id, character: line.who, body: line.text });
      if (line.audio) {
        const aid = new ObjectId();
        fakeAttachmentStore.set(aid.toString(), { buffer: Buffer.from(`rec-${line.text}`), contentType: 'audio/webm' });
        await fakeDb.collection('dialogs').updateOne({ _id: d._id }, { $set: { audio_file_id: aid.toString(), audio_duration_seconds: 1.5 } });
      }
      ids.push(d._id);
    }
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, sceneId: scene._id, cutIndex: rows.length + 1,
      title: `Cut ${rows.length + 1}`, prompt: c.prompt ?? `Prompt ${rows.length + 1}: Sarah waits.`, durationSeconds: 4,
      dialogIds: ids,
    });
    const set = {
      start_frame: { image_id: c.still ? newImage() : null, prompt: c.sfPrompt ?? 'Sarah at the counter, warm tubes.', reference_ids: [], reference_scores: {} },
    };
    if (c.endStill || c.efPrompt !== undefined) {
      set.end_frame = { image_id: c.endStill ? newImage() : null, prompt: c.efPrompt ?? 'The door shut behind her.', reference_ids: [], reference_scores: {} };
    }
    if (c.clip) set.video_file_id = new ObjectId();
    await fakeDb.collection('video_prompts').updateOne({ _id: cut._id }, { $set: set });
    rows.push(await VP.getVideoPrompt(projectId, cut._id.toString()));
  }
  await VP.recomputeCutOrderForBeat(beat._id, [scene._id]);
  const dialogs = await Dialogs.listDialogs({ beatId: beat._id });
  return { beat, scene, cuts: await VP.listVideoPrompts({ projectId, beatId: beat._id }), dialogs };
}

async function waitForJob(jobId) {
  for (let i = 0; i < 800; i++) {
    const job = Render.getCutBeatRenderJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return Render.serializeCutBeatJob(job);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('cut render job never finished');
}

describe('buildCutRenderPlan', () => {
  it('fal: lip-sync for fully recorded cuts, clip otherwise, auto start frame when the still is missing, skips rendered rows', async () => {
    const { beat, cuts, dialogs, scene } = await seedBeat({
      cuts: [
        { lines: [{ who: 'Sarah', text: 'Hi', audio: true }, { who: 'Tom', text: 'Hey', audio: true }] },
        { lines: [{ who: 'Sarah', text: 'Unrecorded' }], still: true },
        { clip: true, still: true },
        { prompt: '' },
      ],
    });
    const plan = await Render.buildCutRenderPlan({ beat, cuts, scenes: [scene], dialogs, provider: 'fal', modelDefaults: { lipsync: null, video_start_only: null } });
    expect(plan.provider).toBe('fal');
    expect(plan.cuts.map((c) => c.label)).toEqual(['1.1', '1.2', '1.3', '1.4']);
    expect(plan.cuts.map((c) => c.mode)).toEqual(['lipsync', 'clip', null, null]);
    expect(plan.cuts[0].model_id).toBe(Render.FAL_FALLBACK_LIPSYNC_MODEL_ID);
    expect(plan.cuts[0].auto_start_frame).toBe(true);
    expect(plan.cuts[0].speech_seconds).toBeCloseTo(3.55, 5);
    expect(plan.cuts[0].duration_seconds).toBe(5);
    expect(plan.cuts[1].auto_start_frame).toBe(false);
    expect(plan.cuts[1].warnings.join(' ')).toMatch(/no recording/);
    expect(plan.cuts[2].skipped).toBe(true);
    expect(plan.cuts[2].skip_reason).toBe('already rendered');
    expect(plan.cuts[3].skip_reason).toBe('no prompt');
    const rerender = await Render.buildCutRenderPlan({ beat, cuts, scenes: [scene], dialogs, provider: 'fal', skipRendered: false });
    expect(rerender.cuts[2].mode).toBe('clip');
  });

  it('comfy: ltx-2.3-ia2v for recorded cuts with the duration set to the speech, the saved clip model + params otherwise; blocked without a still prompt', async () => {
    enableComfy();
    const { beat, cuts, dialogs, scene } = await seedBeat({
      cuts: [
        { lines: [{ who: 'Sarah', text: 'Hi', audio: true }] },
        { still: true },
        { sfPrompt: '' },
      ],
    });
    const plan = await Render.buildCutRenderPlan({
      beat, cuts, scenes: [scene], dialogs, provider: 'comfy',
      comfyDefaults: { model_id: 'wan-2.2-14b-i2v', params_by_model: { 'wan-2.2-14b-i2v': { steps: 6 } } },
    });
    expect(plan.models.lipsync.id).toBe('ltx-2.3-ia2v');
    expect(plan.models.clip.id).toBe('wan-2.2-14b-i2v');
    expect(plan.cuts[0].mode).toBe('lipsync');
    expect(plan.cuts[0].params.duration_seconds).toBe(2); // ceil(1.5)
    expect(plan.cuts[0].auto_start_frame).toBe(true);
    expect(plan.cuts[1].mode).toBe('clip');
    expect(plan.cuts[1].params).toMatchObject({ steps: 6, duration_seconds: 4 });
    expect(plan.cuts[1]).toMatchObject({ cut_seconds: 4, duration_seconds: 4 });
    // A length in the params never overrides the cut's own; a travelling
    // camera renders its handles on top (cutTiming.js).
    await VP.updateVideoPrompt(projectId, cuts[1]._id.toString(), { camera: { movement: 'pan' }, duration_seconds: 6 });
    const fresh = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    const forced = await Render.buildCutRenderPlan({
      beat, cuts: fresh, scenes: [scene], dialogs, provider: 'comfy',
      comfyDefaults: { model_id: 'wan-2.2-14b-i2v', params_by_model: {} },
      paramsByModel: { 'wan-2.2-14b-i2v': { steps: 6, duration_seconds: 5 } },
    });
    expect(forced.cuts[1].params).toMatchObject({ steps: 6, duration_seconds: 7 });
    expect(forced.cuts[1]).toMatchObject({ cut_seconds: 6, duration_seconds: 7 });
    expect(forced.cuts[1].timing).toMatchObject({ head: 0.5, tail: 0.5 });
    expect(plan.cuts[2].status).toBe('blocked');
    expect(plan.cuts[2].missing).toEqual(['start frame']);
    // No end-frame input on these models → never an end frame.
    expect(plan.cuts.every((c) => c.auto_end_frame === false)).toBe(true);
    const explicit = await Render.buildCutRenderPlan({ beat, cuts, scenes: [scene], dialogs, provider: 'comfy', models: { clip: 'kling-3.0' } });
    expect(explicit.cuts[1].spends_credits).toBe(true);
    await expect(Render.buildCutRenderPlan({ beat, cuts, dialogs, provider: 'nope' })).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' });
  });

  it('comfy first-last-frame: auto end frame when the cut has an end prompt, blocked without one, nothing to do when rendered', async () => {
    enableComfy();
    const { beat, cuts, dialogs, scene } = await seedBeat({
      cuts: [
        { still: true, efPrompt: 'The marquee.' },
        { still: true, endStill: true },
        { still: true },
      ],
    });
    const plan = await Render.buildCutRenderPlan({ beat, cuts, scenes: [scene], dialogs, provider: 'comfy', models: { clip: 'wan-2.2-14b-flf2v' } });
    expect(plan.cuts.map((c) => c.auto_end_frame)).toEqual([true, false, false]);
    expect(plan.cuts[1].has_end_frame).toBe(true);
    expect(plan.cuts[2].status).toBe('blocked');
    expect(plan.cuts[2].missing).toEqual(['end frame']);
  });
});

describe('startCutBeatRenderJob (fal)', () => {
  it('renders every cut — auto start frame, joined recordings on the lip-sync cut — then assembles the beat MP4', async () => {
    const { beat } = await seedBeat({
      cuts: [
        { lines: [{ who: 'Sarah', text: 'Hi', audio: true }, { who: 'Tom', text: 'Hey', audio: true }], prompt: 'P-lip' },
        { still: true, prompt: 'P-clip' },
      ],
    });
    const { job_id, planned } = await Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'fal' });
    expect(planned).toBe(2);
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(2);
    expect(job.cuts.every((c) => c.status === 'done' && c.video_file_id)).toBe(true);
    expect(uploadedImages).toHaveLength(1); // the auto start frame
    const cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(cuts.every((c) => c.video_file_id)).toBe(true);
    expect(cuts[0].start_frame.image_id).toBeTruthy();
    expect(String(cuts[0].audio_file_id)).toBe(uploadedAttachments.find((a) => a.metadata.generated_by === 'dialog-concat')._id.toString());
    expect(cuts[0].audio_duration_seconds).toBe(3.2);
    expect(falStubs.submitCalls).toHaveLength(2);
    expect(falStubs.submitCalls.every((c) => !/\bHi\b|\bHey\b/.test(c.args.input.prompt))).toBe(true);
    expect(assembleCalls).toHaveLength(1);
    const after = await Plots.getBeat(projectId, beat._id);
    expect(after.prompts_video_file_id).toBeTruthy();
    expect(job.video_file_id).toBe(String(after.prompts_video_file_id));
  });

  it('ends partial when a cut fails, then a re-run renders only the gap and assembles', async () => {
    const { beat } = await seedBeat({ cuts: [{ still: true, prompt: 'P-ok' }, { still: true, prompt: 'P-bad' }] });
    falStubs.failPrompts.add('P-bad');
    const first = await waitForJob((await Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'fal' })).job_id);
    expect(first.status).toBe('partial');
    expect(first.failed).toBe(1);
    expect(first.assembly_skipped_reason).toMatch(/1 cut failed/);
    expect(assembleCalls).toHaveLength(0);

    falStubs.failPrompts.clear();
    const { job_id, planned, skipped } = await Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'fal' });
    expect(planned).toBe(1);
    expect(skipped).toBe(1);
    const second = await waitForJob(job_id);
    expect(second.status).toBe('done');
    expect(assembleCalls).toHaveLength(1);
  });

  it('guards: 409 while the beat is locked, 400 with nothing to render, 503 when fal is unconfigured', async () => {
    const { beat } = await seedBeat({ cuts: [{ still: true }] });
    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => (release = r)));
    await expect(Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'fal' })).rejects.toMatchObject({ code: 'BEAT_BUSY' });
    release();
    await new Promise((r) => setTimeout(r, 5));
    const empty = await seedBeat({ cuts: [{ prompt: '' }] });
    await expect(Render.startCutBeatRenderJob({ projectId, beatId: empty.beat._id, provider: 'fal' })).rejects.toMatchObject({ code: 'CUT_RENDER_EMPTY' });
    falStubs.configured = false;
    await expect(Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'fal' })).rejects.toMatchObject({ code: 'FAL_NOT_CONFIGURED' });
    await expect(Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'comfy' })).rejects.toMatchObject({ code: 'COMFY_NOT_CONFIGURED', status: 503 });
  });
});

describe('startCutBeatRenderJob (ComfyUI)', () => {
  it('renders cuts one at a time with the saved params, lip-syncs the recorded cut through ltx-2.3-ia2v, persists provider comfy, assembles', async () => {
    const client = enableComfy();
    await Settings.setComfyDefaults(projectId, { model_id: 'ltx-2.5-i2v', params_by_model: { 'ltx-2.5-i2v': { megapixels: 0.3 } } });
    const { beat } = await seedBeat({
      cuts: [
        { lines: [{ who: 'Sarah', text: 'Hi', audio: true }], prompt: 'P-lip', still: true },
        { prompt: 'P-clip' },
      ],
    });
    const snapshots = [];
    const { job_id } = await Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'comfy' });
    Render.subscribeToCutBeatJob(job_id, (s) => snapshots.push(s));
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.provider).toBe('comfy');
    expect(job.cuts.map((c) => c.mode)).toEqual(['lipsync', 'clip']);
    expect(job.cuts.map((c) => c.model_id)).toEqual(['ltx-2.3-ia2v', 'ltx-2.5-i2v']);
    expect(job.cuts[1].auto_start_frame).toBe(true);
    expect(uploadedImages).toHaveLength(1);

    const sets = client.calls.filter((c) => c.name === 'set_workflow_slot').map((c) => Object.fromEntries(c.args.overrides.map((o) => [o.address, o.value])));
    expect(sets).toHaveLength(2);
    expect(sets[0]['276.audio']).toMatch(/dialogue\.mp3$/);
    expect(sets[0]['340.value_4']).toBe(2);
    expect(sets[1]['403.megapixels']).toBe(0.3);
    const runs = client.calls.filter((c) => c.name === 'run_workflow');
    expect(runs).toHaveLength(2);
    expect(client.calls.map((c) => c.name).filter((n) => n === 'upload_file')).toHaveLength(2);

    const cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    expect(cuts.every((c) => c.video_provider === 'comfy' && c.video_file_id)).toBe(true);
    expect(cuts[0].audio_file_id).toBeTruthy();
    expect(Number.isInteger(cuts[1].video_comfy.params.seed)).toBe(true);
    expect(assembleCalls).toHaveLength(1);
    expect(snapshots.some((s) => s.cuts.some((c) => c.job_id))).toBe(true);
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(false);
  });

  it('a first-last-frame model: the missing end frame is rendered first and both stills go into their slots', async () => {
    const client = enableComfy();
    const { beat } = await seedBeat({ cuts: [{ prompt: 'P-flf', still: true, efPrompt: 'The marquee at night.' }] });
    const { job_id } = await Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'comfy', models: { clip: 'wan-2.2-14b-flf2v' } });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.cuts[0].auto_end_frame).toBe(true);
    expect(uploadedImages).toHaveLength(1);
    const cut = (await VP.listVideoPrompts({ projectId, beatId: beat._id }))[0];
    expect(cut.end_frame.image_id).toBeTruthy();
    const set = Object.fromEntries(client.calls.find((c) => c.name === 'set_workflow_slot').args.overrides.map((o) => [o.address, o.value]));
    expect(set['80.image']).toMatch(/-start\.png$/);
    expect(set['89.image']).toMatch(/-end\.png$/);
  });

  it('a first-last-frame model: the fresh end frame is checked against the start frame and repaired before the clip renders; a pair that still differs renders with a warning', async () => {
    const FC = await import('../src/web/cutFrameCheck.js');
    const issue = { kind: 'wardrobe', frame_to_fix: 'end', note: 'The jacket became a T-shirt.', fix_instruction: 'Put the jacket back.' };
    try {
      enableComfy();
      let seen = 0;
      FC._setFrameCheckerForTests(async () => ({ issues: seen++ === 0 ? [issue] : [] }));
      let made = await seedBeat({ cuts: [{ prompt: 'P-flf', still: true, efPrompt: 'The marquee at night.' }] });
      let job = await waitForJob((await Render.startCutBeatRenderJob({ projectId, beatId: made.beat._id, provider: 'comfy', models: { clip: 'wan-2.2-14b-flf2v' } })).job_id);
      expect(job.status).toBe('done');
      // The end frame render plus one repair edit of it.
      expect(uploadedImages).toHaveLength(2);
      let cut = (await VP.listVideoPrompts({ projectId, beatId: made.beat._id }))[0];
      expect(cut.frame_check).toMatchObject({ status: 'pass', rounds: 1 });
      expect(job.cuts[0].warnings.join(' ')).not.toMatch(/still disagree/);
      expect(cut.video_file_id).toBeTruthy();

      FC._setFrameCheckerForTests(async () => ({ issues: [issue] }));
      made = await seedBeat({ cuts: [{ prompt: 'P-flf', still: true, efPrompt: 'The marquee at night.' }] });
      job = await waitForJob((await Render.startCutBeatRenderJob({ projectId, beatId: made.beat._id, provider: 'comfy', models: { clip: 'wan-2.2-14b-flf2v' } })).job_id);
      expect(job.status).toBe('done');
      cut = (await VP.listVideoPrompts({ projectId, beatId: made.beat._id }))[0];
      expect(cut.frame_check).toMatchObject({ status: 'fail', rounds: 2 });
      expect(job.cuts[0].warnings.join(' ')).toMatch(/The start and end frames still disagree: The jacket became a T-shirt\./);
      expect(cut.video_file_id).toBeTruthy();
    } finally {
      FC._setFrameCheckerForTests(null);
    }
  });

  it('requires spend consent for API models (402) and passes it through when given', async () => {
    const client = enableComfy();
    const { beat } = await seedBeat({ cuts: [{ still: true }] });
    await expect(Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'comfy', models: { clip: 'kling-3.0' } })).rejects.toMatchObject({
      code: 'SPEND_CONSENT_REQUIRED',
    });
    const preview = await Render.buildCutRenderPreview({ projectId, beatId: beat._id, provider: 'comfy', models: { clip: 'kling-3.0' } });
    expect(preview.spends_credits).toBe(true);
    expect(preview.counts.to_render).toBe(1);
    const { job_id } = await Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'comfy', models: { clip: 'kling-3.0' }, confirmSpend: true });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(client.calls.find((c) => c.name === 'run_workflow').args.confirm_spend).toBe(true);
  });

  it('a failing ComfyUI cut marks the job partial and leaves the others rendered', async () => {
    enableComfy(fakeComfyClient({ failPrompts: new Set(['P-bad']) }));
    const { beat } = await seedBeat({ cuts: [{ still: true, prompt: 'P-bad' }, { still: true, prompt: 'P-ok' }] });
    const job = await waitForJob((await Render.startCutBeatRenderJob({ projectId, beatId: beat._id, provider: 'comfy' })).job_id);
    expect(job.status).toBe('partial');
    expect(job.cuts[0].status).toBe('failed');
    expect(job.cuts[0].error).toMatch(/boom/);
    expect(job.cuts[1].status).toBe('done');
  });
});

describe('buildCutRenderPreview', () => {
  it('reports the provider state, counts and will_assemble', async () => {
    const { beat } = await seedBeat({ cuts: [{ still: true }, { clip: true, still: true }] });
    const preview = await Render.buildCutRenderPreview({ projectId, beatId: beat._id, provider: 'fal' });
    expect(preview.comfy_configured).toBe(false);
    expect(preview.comfy_disabled_reason).toBe(Render.COMFY_DISABLED_MESSAGE);
    expect(preview.fal_configured).toBe(true);
    expect(preview.counts).toMatchObject({ total: 2, to_render: 1, skipped: 1, blocked: 0, auto_start_frames: 0, lipsync: 0, clip: 1 });
    expect(preview.will_assemble).toBe(true);
    expect(Render.defaultProvider()).toBe('fal');
    enableComfy();
    expect(Render.defaultProvider()).toBe('comfy');
  });
});
