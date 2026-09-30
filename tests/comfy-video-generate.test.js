// The ComfyUI cut render job: upload → set slots → run → poll → fetch →
// persist, with the comfy-mcp client faked and the template ensured from a
// stub file. Mongo is the in-memory fake; Hocuspocus is down so the gateway
// writes straight to Mongo.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.COMFYUI_URL = '';
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-gen-test-'));
process.env.COMFY_WORK_DIR = WORK_DIR;

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
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

const fakeImageStore = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readImageBuffer: vi.fn(async (id) => {
      const entry = fakeImageStore.get(String(id));
      if (!entry) return null;
      return { buffer: entry.buffer, file: { _id: id, contentType: entry.contentType || 'image/png', metadata: {} } };
    }),
  };
});

const uploadedAttachments = [];
const deletedAttachments = [];
const fakeAttachmentStore = new Map();
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readAttachmentBuffer: vi.fn(async (id) => {
      const entry = fakeAttachmentStore.get(String(id));
      if (!entry) return null;
      return { buffer: entry.buffer, file: { _id: id, contentType: entry.contentType, metadata: { content_type: entry.contentType } } };
    }),
    uploadAttachmentBuffer: vi.fn(async (_projectId, args) => {
      const file = {
        _id: new ObjectId(),
        filename: args.filename,
        content_type: args.contentType,
        size: args.buffer.length,
        metadata: { owner_type: args.ownerType, owner_id: args.ownerId, generated_by: args.generatedBy, prompt: args.prompt },
      };
      fakeAttachmentStore.set(file._id.toString(), { buffer: args.buffer, contentType: args.contentType });
      uploadedAttachments.push(file);
      return file;
    }),
    deleteAttachment: vi.fn(async (id) => {
      deletedAttachments.push(String(id));
    }),
    deleteAttachments: vi.fn(async (ids) => {
      for (const id of ids) deletedAttachments.push(String(id));
    }),
  };
});

// Duration probe for the joined dialogue MP3 a lip-sync render attaches.
vi.mock('../src/fal/videoPricing.js', async () => {
  const actual = await vi.importActual('../src/fal/videoPricing.js');
  return { ...actual, probeAudioDurationSeconds: vi.fn(async () => 3.2) };
});

const TEMPLATE_PATH = path.join(WORK_DIR, 'template-stub.json');
fs.writeFileSync(TEMPLATE_PATH, JSON.stringify({ nodes: [], stub: true }));
vi.mock('../src/comfy/templates.js', () => ({
  ensureTemplateFile: vi.fn(async () => ({ path: TEMPLATE_PATH, local_check: { checked: true, runnable: true } })),
  ComfyTemplateNotRunnableError: class extends Error {},
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Client = await import('../src/comfy/client.js');
const Gen = await import('../src/web/comfyVideoGenerate.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Audio = await import('../src/web/audioTranscode.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  fakeImageStore.clear();
  uploadedAttachments.length = 0;
  deletedAttachments.length = 0;
  BeatLocks._clearBeatLocksForTests();
  Gen._resetComfyJobsForTests();
  Gen._setComfyRunnerOptionsForTests({ pollIntervalMs: 2, jobTimeoutMs: 5000 });
  Client._setComfyClientForTests(null);
  fakeAttachmentStore.clear();
  Audio.__setAudioFfmpegImplForTests(async ({ outputPath }) => {
    fs.writeFileSync(outputPath, Buffer.from('joined-mp3'));
  });
  projectId = (await createProject('Comfy Gen'))._id.toString();
});

afterAll(async () => {
  await fsp.rm(WORK_DIR, { recursive: true, force: true });
});

function newImage(contentType = 'image/png') {
  const id = new ObjectId();
  fakeImageStore.set(id.toString(), { buffer: Buffer.from(`img-${id}`), contentType });
  return id;
}

async function seedCut({ withStartFrame = true, refs = 0, videoFileId = null } = {}) {
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'Sarah waits.', characters: ['Sarah'], sets: ['Diner'] });
  const cut = await VP.createVideoPrompt({
    projectId,
    beatId: beat._id,
    title: 'Cut 1',
    prompt: 'Medium shot from the aisle: **Sarah** pushes the cup one inch. Same light: warm tubes. Camera in the aisle. Stop when her hand lets go.',
    durationSeconds: 5,
    referenceImages: Array.from({ length: refs }, (_, i) => ({ image_id: newImage(), owner_type: 'character', owner_name: 'Sarah', label: `ref ${i + 1}` })),
  });
  const extra = {
    reference_binding: '@Image1 controls Sarah only; ignore the room from it.',
    exclusions: ['Do not show the door yet.'],
    start_frame: withStartFrame ? { image_id: newImage('image/jpeg'), prompt: 'still', reference_ids: [] } : null,
  };
  if (videoFileId) extra.video_file_id = videoFileId;
  await fakeDb.collection('video_prompts').updateOne({ _id: cut._id }, { $set: extra });
  return { beat, cut: await VP.getVideoPrompt(projectId, cut._id.toString()) };
}

// Dialogue lines for a cut: each entry { who, text, audio } → a dialog row,
// recorded when `audio` is true. Returns the dialog ids in order.
async function seedLines(beatId, lines) {
  const ids = [];
  for (const line of lines) {
    const d = await Dialogs.createDialog({ projectId, beatId, character: line.who, body: line.text });
    if (line.audio) {
      const aid = new ObjectId();
      fakeAttachmentStore.set(aid.toString(), { buffer: Buffer.from(`rec-${line.text}`), contentType: 'audio/webm' });
      await fakeDb.collection('dialogs').updateOne({ _id: d._id }, { $set: { audio_file_id: aid.toString(), audio_duration_seconds: 1.5 } });
    }
    ids.push(d._id);
  }
  return ids;
}

// A scripted comfy-mcp: records every call, serves statuses in order, and
// writes a clip into the out_dir fetch_outputs is asked for.
function fakeClient({ statuses = ['queued', 'running', 'completed'], errorDetail = null, failRun = false } = {}) {
  const calls = [];
  let i = 0;
  const client = {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      switch (name) {
        case 'upload_file':
          return { uploads: args.paths.map((p) => ({ local_path: p, cloud_name: path.basename(p), subfolder: '', type: 'input' })) };
        case 'list_workflow_slots':
          return { slots: [{ address: '398.value' }, { address: '398/373.text' }, { address: '395.image' }, { address: '340.value' }, { address: '340/314.text' }] };
        case 'set_workflow_slot':
          return { ok: true, path: args.workflow_path };
        case 'run_workflow':
          if (failRun) throw new Client.ComfyToolError('run_workflow', 'spend_consent_required');
          return { prompt_id: 'prompt-1', status: 'queued' };
        case 'job': {
          if (args.action === 'error') return errorDetail;
          const status = statuses[Math.min(i, statuses.length - 1)];
          i += 1;
          return { prompt_id: args.prompt_id, status };
        }
        case 'fetch_outputs': {
          await fsp.mkdir(args.out_dir, { recursive: true });
          const out = path.join(args.out_dir, 'clip_00001_.mp4');
          await fsp.writeFile(out, Buffer.from('fake-mp4-bytes'));
          return { saved: [out] };
        }
        case 'server_info':
          return { server: { running: true, url: 'http://127.0.0.1:8188' } };
        default:
          return {};
      }
    },
  };
  return client;
}

async function waitForTerminal(jobId, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    const job = Gen.getComfyVideoJob(jobId);
    if (job && (job.status === 'done' || job.status === 'error')) return job;
    if (Date.now() > until) throw new Error(`job ${jobId} did not finish: ${JSON.stringify(Gen.serializeComfyJob(job))}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('comfy cut render job', () => {
  it('refuses when ComfyUI is not configured', async () => {
    const { cut } = await seedCut();
    await expect(
      Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v' }),
    ).rejects.toBeInstanceOf(Client.ComfyNotConfiguredError);
  });

  it('renders a cut end to end: upload → slots → run → poll → fetch → persist, replacing the previous clip', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const previous = new ObjectId();
    const { cut } = await seedCut({ videoFileId: previous });
    const snapshots = [];
    const { job_id } = await Gen.startComfyCutVideoJob({
      projectId,
      cutId: cut._id.toString(),
      modelId: 'ltx-2.5-i2v',
      params: { duration_seconds: 4, seed: 11 },
      advanced: [{ address: '398/373.text', value: 'blurry' }],
    });
    Gen.subscribeToComfyJob(job_id, (s) => snapshots.push(s));
    const job = await waitForTerminal(job_id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.prompt_id).toBe('prompt-1');

    const names = client.calls.map((c) => c.name);
    expect(names.indexOf('upload_file')).toBeLessThan(names.indexOf('set_workflow_slot'));
    expect(names.indexOf('set_workflow_slot')).toBeLessThan(names.indexOf('run_workflow'));
    expect(names.indexOf('run_workflow')).toBeLessThan(names.indexOf('fetch_outputs'));
    expect(names.filter((n) => n === 'job')).toHaveLength(3);

    const upload = client.calls.find((c) => c.name === 'upload_file');
    expect(upload.args.overwrite).toBe(true);
    expect(upload.args.paths[0].endsWith(`cut-${cut._id}-start.jpg`)).toBe(true);
    expect(fs.existsSync(upload.args.paths[0])).toBe(false); // job dir cleaned up

    const set = client.calls.find((c) => c.name === 'set_workflow_slot');
    const m = Object.fromEntries(set.args.overrides.map((o) => [o.address, o.value]));
    expect(m['395.image']).toBe(`cut-${cut._id}-start.jpg`);
    expect(m['398.value']).toContain('Sarah pushes the cup');
    expect(m['398.value']).not.toContain('@Image1'); // i2v: no binding
    expect(m['398.value'].endsWith('Do not show the door yet.')).toBe(true);
    expect(m['398.value_2']).toBe(4);
    expect(m['398.noise_seed']).toBe(11);
    expect(m['398/373.text']).toBe('blurry');
    expect(set.args.stdout).toBe(false);

    const run = client.calls.find((c) => c.name === 'run_workflow');
    expect(run.args.wait).toBe(false);
    expect(run.args.confirm_spend).toBe(false);

    expect(uploadedAttachments).toHaveLength(1);
    expect(uploadedAttachments[0].filename).toMatch(/^cut-[a-f0-9]{24}-comfy-\d+\.mp4$/);
    expect(uploadedAttachments[0].metadata.generated_by).toBe('comfy/video_ltx2_5_i2v');
    expect(uploadedAttachments[0].metadata.owner_type).toBe('beat');
    expect(deletedAttachments).toContain(previous.toString());

    const after = await VP.getVideoPrompt(projectId, cut._id.toString());
    expect(String(after.video_file_id)).toBe(uploadedAttachments[0]._id.toString());
    expect(after.video_model_id).toBe('comfy:ltx-2.5-i2v');
    expect(after.video_model_lab).toBe('ComfyUI (local)');
    expect(after.video_duration_seconds).toBe(4);
    expect(after.video_parameters).toMatchObject({ provider: 'comfy', template: 'video_ltx2_5_i2v', prompt_id: 'prompt-1' });

    expect(snapshots.every((s) => s.provider === 'comfy' && s.owner_type === 'video_prompt')).toBe(true);
    expect(snapshots.at(-1).status).toBe('done');
    expect(snapshots.at(-1).video_file_id).toBe(uploadedAttachments[0]._id.toString());
  });

  it('first-last-frame (wan-2.2-14b-flf2v): refuses a cut without an end frame, then uploads both stills into their slots and derives the frame count', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const { cut } = await seedCut();
    await expect(Gen.prepareCutRender({ projectId, cutId: cut._id.toString(), modelId: 'wan-2.2-14b-flf2v' })).rejects.toMatchObject({ code: 'MISSING_END_FRAME', status: 400 });

    await fakeDb.collection('video_prompts').updateOne({ _id: cut._id }, { $set: { end_frame: { image_id: newImage(), prompt: 'end', reference_ids: [] } } });
    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'wan-2.2-14b-flf2v', params: { duration_seconds: 5, fps: 16, steps: 20 } });
    const job = await waitForTerminal(job_id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    const upload = client.calls.find((c) => c.name === 'upload_file');
    expect(upload.args.paths.map((p) => path.basename(p))).toEqual([`cut-${cut._id}-start.jpg`, `cut-${cut._id}-end.png`]);
    const set = client.calls.find((c) => c.name === 'set_workflow_slot');
    const m = Object.fromEntries(set.args.overrides.map((o) => [o.address, o.value]));
    expect(m['80.image']).toBe(`cut-${cut._id}-start.jpg`);
    expect(m['89.image']).toBe(`cut-${cut._id}-end.png`);
    expect(m['81.length']).toBe(81); // 16 fps × 5 s, Wan 4n+1
    expect(m['84.end_at_step']).toBe(10);
    expect(m['87.start_at_step']).toBe(10);
    expect(m['90.text']).toContain('Sarah pushes the cup');
  });

  it('surfaces the ComfyUI error detail when the job fails', async () => {
    Client._setComfyClientForTests(fakeClient({ statuses: ['running', 'failed'], errorDetail: { exception_message: 'CUDA out of memory', error_code: 'server_died' } }));
    const { cut } = await seedCut();
    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'wan-2.2-14b-i2v' });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toContain('CUDA out of memory');
    expect(job.error).toContain('server_died');
    expect(uploadedAttachments).toHaveLength(0);
  });

  it('times out a render that never finishes', async () => {
    Gen._setComfyRunnerOptionsForTests({ pollIntervalMs: 2, jobTimeoutMs: 30 });
    Client._setComfyClientForTests(fakeClient({ statuses: ['running'] }));
    const { cut } = await seedCut();
    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v' });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/timed out/);
  });

  it('reports tool errors from run_workflow as the job error', async () => {
    Client._setComfyClientForTests(fakeClient({ failRun: true }));
    const { cut } = await seedCut();
    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v' });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toContain('spend_consent_required');
  });

  it('validates inputs before queueing: start frame, references, consent, model, params', async () => {
    Client._setComfyClientForTests(fakeClient());
    const { cut: noFrame } = await seedCut({ withStartFrame: false });
    await expect(Gen.startComfyCutVideoJob({ projectId, cutId: noFrame._id.toString(), modelId: 'ltx-2.5-i2v' })).rejects.toBeInstanceOf(
      Gen.MissingStartFrameError,
    );
    await expect(
      Gen.startComfyCutVideoJob({ projectId, cutId: noFrame._id.toString(), modelId: 'seedance-2.0-r2v', confirmSpend: true }),
    ).rejects.toBeInstanceOf(Gen.MissingReferenceImagesError);
    await expect(
      Gen.startComfyCutVideoJob({ projectId, cutId: noFrame._id.toString(), modelId: 'seedance-2.0-r2v' }),
    ).rejects.toMatchObject({ status: 402, code: 'SPEND_CONSENT_REQUIRED' });
    await expect(Gen.startComfyCutVideoJob({ projectId, cutId: noFrame._id.toString(), modelId: 'nope' })).rejects.toBeInstanceOf(
      Gen.UnknownComfyModelError,
    );
    await expect(
      Gen.startComfyCutVideoJob({ projectId, cutId: noFrame._id.toString(), modelId: 'ltx-2.5-i2v', params: { aspect_ratio: '5:4' } }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_COMFY_PARAMS' });
    await expect(Gen.startComfyCutVideoJob({ projectId, cutId: new ObjectId().toString(), modelId: 'ltx-2.5-i2v' })).rejects.toBeInstanceOf(
      Gen.CutNotFoundError,
    );
  });

  it('reference-to-video: preview prepends the binding and sends the references, and the render passes consent through', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const { cut } = await seedCut({ withStartFrame: false, refs: 2 });
    const preview = await Gen.buildComfyPayloadPreview({
      projectId,
      cutId: cut._id.toString(),
      modelId: 'seedance-2.0-r2v',
      confirmSpend: true,
    });
    expect(preview.prompt.startsWith('@Image1 controls Sarah')).toBe(true);
    expect(preview.spends_credits).toBe(true);
    expect(preview.reference_image_ids).toHaveLength(1); // template has one reference slot
    expect(preview.start_frame_image_id).toBeNull();
    const m = Object.fromEntries(preview.overrides.map((o) => [o.address, o.value]));
    expect(m['356.image']).toBe(`cut-${cut._id}-ref-1.png`);
    expect(m['361.model']).toBe('Seedance 2.0');

    const { job_id } = await Gen.startComfyCutVideoJob({
      projectId,
      cutId: cut._id.toString(),
      modelId: 'seedance-2.0-r2v',
      confirmSpend: true,
    });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('done');
    const run = client.calls.find((c) => c.name === 'run_workflow');
    expect(run.args.confirm_spend).toBe(true);
    const upload = client.calls.find((c) => c.name === 'upload_file');
    expect(upload.args.paths).toHaveLength(1);
    const after = await VP.getVideoPrompt(projectId, cut._id.toString());
    expect(after.video_model_lab).toBe('ComfyUI (API)');
  });

  it('persists provider comfy and the seed it actually used, and never repeats an exclusion already in the block', async () => {
    Client._setComfyClientForTests(fakeClient());
    const { cut } = await seedCut();
    await fakeDb.collection('video_prompts').updateOne(
      { _id: cut._id },
      { $set: { exclusions: ['Do not show the door yet.', 'Stop when her hand lets go.'] } },
    );
    const preview = await Gen.buildComfyPayloadPreview({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 3 } });
    expect(Number.isInteger(preview.params.seed)).toBe(true);
    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 3 } });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('done');
    expect(Number.isInteger(job.params.seed)).toBe(true);
    const after = await VP.getVideoPrompt(projectId, cut._id.toString());
    expect(after.video_provider).toBe('comfy');
    expect(after.video_comfy).toMatchObject({ model_id: 'ltx-2.5-i2v', template: 'video_ltx2_5_i2v', prompt_id: 'prompt-1' });
    expect(after.video_comfy.params.seed).toBe(job.params.seed);
    expect(after.video_parameters.params.seed).toBe(job.params.seed);
    const sent = preview.prompt;
    expect(sent.split('Stop when her hand lets go.').length).toBe(2); // once — already in the block
    expect(sent.endsWith('Do not show the door yet.')).toBe(true);
  });

  describe('lip-sync (ltx-2.3-ia2v)', () => {
    it('refuses a cut with no covered lines or with an unrecorded line (400 MISSING_DIALOGUE_AUDIO)', async () => {
      Client._setComfyClientForTests(fakeClient());
      const { beat, cut } = await seedCut();
      await expect(Gen.prepareCutRender({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.3-ia2v' })).rejects.toMatchObject({
        code: 'MISSING_DIALOGUE_AUDIO',
        status: 400,
        lines: [],
      });
      const ids = await seedLines(beat._id, [{ who: 'Sarah', text: 'Hi', audio: true }, { who: 'Tom', text: 'Hey' }]);
      await VP.updateVideoPrompt(projectId, cut._id, { dialog_ids: ids });
      const err = await Gen.prepareCutRender({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.3-ia2v' }).catch((e) => e);
      expect(err.code).toBe('MISSING_DIALOGUE_AUDIO');
      expect(err.lines).toEqual([2]);
      expect(err.message).toMatch(/line 2 has no recording/);
    });

    it('joins the covered recordings, uploads the MP3 into the LoadAudio slot, defaults the duration to the speech, persists the cut audio', async () => {
      const client = fakeClient();
      Client._setComfyClientForTests(client);
      const { beat, cut } = await seedCut();
      const ids = await seedLines(beat._id, [{ who: 'Sarah', text: 'Hi', audio: true }, { who: 'Tom', text: 'Hey', audio: true }]);
      await VP.updateVideoPrompt(projectId, cut._id, { dialog_ids: ids });

      const preview = await Gen.buildComfyPayloadPreview({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.3-ia2v', params: {} });
      expect(preview.audio).toMatchObject({ lines: 2 });
      expect(preview.audio.speech_seconds).toBeCloseTo(3 + 0.25 + 0.3, 5);
      expect(preview.params.duration_seconds).toBe(4); // ceil(3.55)
      expect(preview.params.prompt_enhance).toBe(false);

      const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.3-ia2v', params: {} });
      const job = await waitForTerminal(job_id);
      expect(job.error).toBeNull();
      expect(job.status).toBe('done');

      const upload = client.calls.find((c) => c.name === 'upload_file');
      expect(upload.args.paths.some((p) => p.endsWith(`cut-${cut._id}-start.jpg`))).toBe(true);
      expect(upload.args.paths.some((p) => p.endsWith(`cut-${cut._id}-dialogue.mp3`))).toBe(true);
      const set = client.calls.find((c) => c.name === 'set_workflow_slot');
      const m = Object.fromEntries(set.args.overrides.map((o) => [o.address, o.value]));
      expect(m['269.image']).toBe(`cut-${cut._id}-start.jpg`);
      expect(m['276.audio']).toBe(`cut-${cut._id}-dialogue.mp3`);
      expect(m['340.value_4']).toBe(4);
      expect(m['340.value_5']).toBe(false);
      expect(m['340.value']).not.toMatch(/\bHi\b|\bHey\b/); // dialogue words never enter a prompt

      const mp3 = uploadedAttachments.find((a) => a.metadata.generated_by === 'dialog-concat');
      expect(mp3).toBeTruthy();
      expect(mp3.metadata.owner_type).toBe('beat');
      const after = await VP.getVideoPrompt(projectId, cut._id.toString());
      expect(String(after.audio_file_id)).toBe(mp3._id.toString());
      expect(after.audio_duration_seconds).toBe(3.2);
      expect(after.video_provider).toBe('comfy');
      expect(after.video_comfy.model_id).toBe('ltx-2.3-ia2v');
    });
  });

  it('runComfyCutRenderInline renders while the caller holds the beat lock and returns the finished job', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const { beat, cut } = await seedCut();
    const prep = await Gen.prepareCutRender({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    let created = null;
    const job = await BeatLocks.withBeatLock(beat._id, () =>
      Gen.runComfyCutRenderInline({ prep, projectId, onJobCreated: (j) => (created = j.job_id) }),
    );
    expect(job.status).toBe('done');
    expect(job.job_id).toBe(created);
    expect(Gen.getComfyVideoJob(created).video_file_id).toBe(job.video_file_id);
    expect(client.calls.some((c) => c.name === 'run_workflow')).toBe(true);
  });

  it('a queued single-cut job already holds its beat lock, so a second start for the beat is refused', async () => {
    let releaseRun;
    const gate = new Promise((r) => (releaseRun = r));
    const client = fakeClient();
    const inner = client.callTool.bind(client);
    client.callTool = async (name, args) => {
      if (name === 'run_workflow') await gate;
      return inner(name, args);
    };
    Client._setComfyClientForTests(client);
    const { beat, cut } = await seedCut();
    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(true);
    await expect(Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v' })).rejects.toBeInstanceOf(Gen.ComfyBusyError);
    releaseRun();
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('done');
    await new Promise((r) => setTimeout(r, 5));
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(false);
  });

  it('refuses to queue behind a held beat lock', async () => {
    Client._setComfyClientForTests(fakeClient());
    const { beat, cut } = await seedCut();
    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => (release = r)));
    await expect(Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v' })).rejects.toBeInstanceOf(
      Gen.ComfyBusyError,
    );
    release();
  });
});
