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

const TEMPLATE_PATH = path.join(WORK_DIR, 'template-stub.json');
fs.writeFileSync(TEMPLATE_PATH, JSON.stringify({ nodes: [], stub: true }));
vi.mock('../src/comfy/templates.js', () => ({
  ensureTemplateFile: vi.fn(async () => ({ path: TEMPLATE_PATH, local_check: { checked: true, runnable: true } })),
  ComfyTemplateNotRunnableError: class extends Error {},
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Client = await import('../src/comfy/client.js');
const Gen = await import('../src/web/comfyVideoGenerate.js');

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

const CUT_PROMPT = 'Medium shot from the aisle: **Sarah** pushes the cup one inch. Stop when her hand lets go.';
const CUT_PROMPT_PLAIN = CUT_PROMPT.replace(/\*\*/g, '');

async function seedCut({ withStartFrame = true, videoFileId = null, prompt = CUT_PROMPT } = {}) {
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'Sarah waits.', characters: ['Sarah'], sets: ['Diner'] });
  const scene = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One' });
  const cut = await VP.createVideoPrompt({
    projectId,
    beatId: beat._id,
    sceneId: scene._id,
    title: 'Cut 1',
    prompt,
    durationSeconds: 5,
    // The frame's own references are for the IMAGE model; a video render never sends them.
    startFrame: withStartFrame ? { image_id: newImage('image/jpeg'), prompt: 'still', reference_ids: [newImage()] } : null,
  });
  if (videoFileId) await VP.updateVideoPrompt(projectId, cut._id, { video_file_id: videoFileId });
  return { beat, scene, cut: await VP.getVideoPrompt(projectId, cut._id.toString()) };
}

// A scripted comfy-mcp: records every call, serves statuses in order, and
// writes a clip into the out_dir fetch_outputs is asked for.
function fakeClient({ statuses = ['queued', 'running', 'completed'], errorDetail = null, failRun = false } = {}) {
  const calls = [];
  let i = 0;
  const client = {
    calls,
    validated: [],
    validation: null,
    async callTool(name, args) {
      calls.push({ name, args });
      switch (name) {
        case 'upload_file':
          return { uploads: args.paths.map((p) => ({ local_path: p, cloud_name: path.basename(p), subfolder: '', type: 'input' })) };
        case 'list_workflow_slots':
          return { slots: [{ address: '398.value' }, { address: '398/373.text' }, { address: '395.image' }, { address: '340.value' }, { address: '340/314.text' }] };
        case 'set_workflow_slot':
          return { ok: true, path: args.workflow_path };
        case 'validate_workflow': {
          // The builder test reads the graph the job wrote.
          const graph = JSON.parse(await fsp.readFile(args.workflow_path, 'utf8'));
          client.validated.push(graph);
          return client.validation || { valid: true, errors: [], warnings: [{ message: 'fake warning' }] };
        }
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
    // Only the start frame is uploaded — not the frame's reference images.
    expect(upload.args.paths).toHaveLength(1);
    expect(upload.args.paths[0].endsWith(`cut-${cut._id}-start.jpg`)).toBe(true);
    expect(fs.existsSync(upload.args.paths[0])).toBe(false); // job dir cleaned up

    const set = client.calls.find((c) => c.name === 'set_workflow_slot');
    const m = Object.fromEntries(set.args.overrides.map((o) => [o.address, o.value]));
    expect(m['395.image']).toBe(`cut-${cut._id}-start.jpg`);
    // The prompt is the cut's own video prompt, markdown stripped — nothing added.
    expect(m['398.value']).toBe(CUT_PROMPT_PLAIN);
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

  it('builder model (ltx-2.5-keyframes): uploads start + keyframes + end, writes and validates an API graph with one guide per picture, no template or slots', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const { cut } = await seedCut();
    const id = cut._id.toString();
    await VP.updateVideoPrompt(projectId, id, { duration_seconds: 10, end_frame: { image_id: newImage(), prompt: 'end' } });
    // Two keyframes with pictures and one without (never sent). Half-second
    // times at 24 fps are 12 frames apart, so they never share an 8-frame
    // slot — collisions are the builder test's business.
    const k1 = newImage();
    const k2 = newImage();
    await VP.updateVideoPrompt(projectId, id, {
      keyframes: [
        { at_seconds: 2.5, image_id: k1, prompt: 'a', strength: 0.4 },
        { at_seconds: 6, prompt: 'no picture yet' },
        { at_seconds: 7.5, image_id: k2 }, // no strength of its own → guide_strength
      ],
    });

    const preview = await Gen.buildComfyPayloadPreview({ projectId, cutId: id, modelId: 'ltx-2.5-keyframes', params: { seed: 5 } });
    expect(preview.model.graph).toBe('ltx25-keyframes');
    expect(preview.model.inputs.keyframes).toBe('optional');
    expect(preview.overrides).toEqual([]);
    expect(preview.frames).toBe(241); // 10 s × 24 fps → 8k+1
    expect(preview.ignored_keyframes).toBe(0);
    expect(preview.keyframes.map((k) => [k.at_seconds, k.frame_idx, k.strength])).toEqual([
      [2.5, 56, 0.4],
      [7.5, 176, 0.7], // the default guide_strength
    ]);
    expect(Object.values(preview.workflow).filter((n) => n.class_type === 'LTXVAddGuide')).toHaveLength(4);

    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: id, modelId: 'ltx-2.5-keyframes', params: { seed: 5 }, advanced: [{ address: 'x.y', value: 1 }] });
    const job = await waitForTerminal(job_id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    const names = client.calls.map((c) => c.name);
    expect(names).not.toContain('set_workflow_slot');
    expect(names).not.toContain('list_workflow_slots');
    expect(names).not.toContain('fetch_template');
    expect(names.indexOf('upload_file')).toBeLessThan(names.indexOf('validate_workflow'));
    expect(names.indexOf('validate_workflow')).toBeLessThan(names.indexOf('run_workflow'));
    const upload = client.calls.find((c) => c.name === 'upload_file');
    expect(upload.args.paths.map((p) => path.basename(p))).toEqual([`cut-${id}-start.jpg`, `cut-${id}-end.png`, `cut-${id}-kf-1.png`, `cut-${id}-kf-2.png`]);
    const graph = client.validated[0];
    const guides = Object.values(graph).filter((n) => n.class_type === 'LTXVAddGuide');
    expect(guides.map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[0, 0.7], [56, 0.4], [176, 0.7], [-1, 0.7]]);
    const loads = Object.values(graph).filter((n) => n.class_type === 'LoadImage').map((n) => n.inputs.image);
    expect(loads).toEqual([`cut-${id}-start.jpg`, `cut-${id}-kf-1.png`, `cut-${id}-kf-2.png`, `cut-${id}-end.png`]);
    expect(Object.values(graph).find((n) => n.class_type === 'EmptyLTXVLatentVideo').inputs.length).toBe(241);
    expect(Object.values(graph).find((n) => n.class_type === 'RandomNoise').inputs.noise_seed).toBe(5);
    expect(Object.values(graph).filter((n) => n.class_type === 'LTXVContextWindows')).toHaveLength(0);
    expect(job.logs.some((l) => /advanced slot overrides are ignored/.test(l.message))).toBe(true);
    expect(job.logs.some((l) => /validation: fake warning/.test(l.message))).toBe(true);

    expect(uploadedAttachments[0].metadata.generated_by).toBe('comfy/ltx25-keyframes');
    const after = await VP.getVideoPrompt(projectId, id);
    expect(after.video_model_id).toBe('comfy:ltx-2.5-keyframes');
    expect(after.video_comfy).toMatchObject({ template: null, graph: 'ltx25-keyframes', model_id: 'ltx-2.5-keyframes', frames: 241 });
    const kfs = after.keyframes;
    expect(after.video_comfy.guides).toEqual([
      { frame_idx: 0, strength: 0.7, role: 'start' },
      { frame_idx: 56, strength: 0.4, role: 'keyframe', keyframe_id: kfs[0].id.toString() },
      { frame_idx: 176, strength: 0.7, role: 'keyframe', keyframe_id: kfs[2].id.toString() },
      { frame_idx: -1, strength: 0.7, role: 'end' },
    ]);

    // Gates: a long cut needs long_clip (which adds context windows); a
    // keyframe outside the clip is refused; an invalid graph fails the job.
    await VP.updateVideoPrompt(projectId, id, { duration_seconds: 30 });
    await expect(Gen.prepareCutRender({ projectId, cutId: id, modelId: 'ltx-2.5-keyframes' })).rejects.toMatchObject({ code: 'INVALID_COMFY_PARAMS' });
    const long = await Gen.buildComfyPayloadPreview({ projectId, cutId: id, modelId: 'ltx-2.5-keyframes', params: { long_clip: true } });
    expect(long.frames).toBe(721);
    expect(Object.values(long.workflow).filter((n) => n.class_type === 'LTXVContextWindows')).toHaveLength(1);
    await expect(Gen.prepareCutRender({ projectId, cutId: id, modelId: 'ltx-2.5-keyframes', params: { long_clip: true, duration_seconds: 3 } })).rejects.toThrow(/keyframe at 7.5 s lies outside/);
    client.validation = { valid: false, errors: [{ message: 'bad input' }] };
    const bad = await waitForTerminal((await Gen.startComfyCutVideoJob({ projectId, cutId: id, modelId: 'ltx-2.5-keyframes', params: { long_clip: true } })).job_id);
    expect(bad.status).toBe('error');
    expect(bad.error).toMatch(/failed ComfyUI validation: bad input/);

    // Any other model ignores the keyframes and says so.
    const other = await Gen.buildComfyPayloadPreview({ projectId, cutId: id, modelId: 'ltx-2.5-i2v' });
    expect(other.ignored_keyframes).toBe(2);
    expect(other.keyframes).toEqual([]);
    expect(other.warnings.some((w) => /2 keyframes ignored/.test(w))).toBe(true);
  });

  it("renders the cut's own length when no duration is given, snapped up to what the model renders", async () => {
    Client._setComfyClientForTests(fakeClient());
    const { cut } = await seedCut();
    const id = cut._id.toString();
    let prep = await Gen.prepareCutRender({ projectId, cutId: id, modelId: 'ltx-2.5-i2v' });
    expect(prep.params.duration_seconds).toBe(5);
    // No handles, trims or timing report any more.
    expect(prep).not.toHaveProperty('timing');
    expect(prep).not.toHaveProperty('audio');
    // A quick cut on a whole-second model renders 2 s; Wan takes 1.5 as is.
    await VP.updateVideoPrompt(projectId, id, { duration_seconds: 1.5 });
    expect((await Gen.prepareCutRender({ projectId, cutId: id, modelId: 'ltx-2.5-i2v' })).params.duration_seconds).toBe(2);
    expect((await Gen.prepareCutRender({ projectId, cutId: id, modelId: 'wan-2.2-14b-i2v' })).params.duration_seconds).toBe(1.5);
    // An explicit length wins; an empty one falls back to the cut's.
    prep = await Gen.prepareCutRender({ projectId, cutId: id, modelId: 'ltx-2.5-i2v', params: { duration_seconds: 9 } });
    expect(prep.params.duration_seconds).toBe(9);
    prep = await Gen.prepareCutRender({ projectId, cutId: id, modelId: 'ltx-2.5-i2v', params: { duration_seconds: '' } });
    expect(prep.params.duration_seconds).toBe(2);
    // A cut with no length leaves the model's own default in place.
    const spec = (await import('../src/comfy/videoModels.js')).getComfyVideoModel('ltx-2.5-i2v').params.duration_seconds;
    await VP.updateVideoPrompt(projectId, id, { duration_seconds: null });
    prep = await Gen.prepareCutRender({ projectId, cutId: id, modelId: 'ltx-2.5-i2v' });
    expect(prep.params.duration_seconds).toBe(spec.default);
    const preview = await Gen.buildComfyPayloadPreview({ projectId, cutId: id, modelId: 'ltx-2.5-i2v' });
    expect(preview).not.toHaveProperty('timing');
    expect(preview).not.toHaveProperty('audio');
  });

  it('snapDurationUp rounds a length up to the step, then into min/max; null without a length', () => {
    expect(Gen.snapDurationUp(1.5, { type: 'int' })).toBe(2);
    expect(Gen.snapDurationUp(2, { type: 'int' })).toBe(2);
    expect(Gen.snapDurationUp(1.5, { type: 'float' })).toBe(1.5);
    expect(Gen.snapDurationUp(1.2, { type: 'float', step: 0.5 })).toBe(1.5);
    expect(Gen.snapDurationUp(1.5, { type: 'float', step: 0.5 })).toBe(1.5);
    expect(Gen.snapDurationUp(2.1, { step: 2 })).toBe(4);
    expect(Gen.snapDurationUp(1, { type: 'int', min: 4, max: 12 })).toBe(4);
    expect(Gen.snapDurationUp(30, { type: 'int', min: 4, max: 12 })).toBe(12);
    expect(Gen.snapDurationUp(3.3)).toBe(3.3);
    expect(Gen.snapDurationUp(3.3, null)).toBe(3.3);
    for (const none of [null, undefined, '', 0, -2, 'abc']) expect(Gen.snapDurationUp(none, { type: 'int' })).toBeNull();
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

  it('validates inputs before queueing: start frame, reference / audio models, consent, model, params, prompt', async () => {
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
    // A cut has no reference images of its own, so a model that REQUIRES them
    // cannot be driven from the Scenes tab — even when the frames list some.
    const { cut: framed } = await seedCut();
    expect(framed.start_frame.reference_ids).toHaveLength(1);
    await expect(
      Gen.prepareCutRender({ projectId, cutId: framed._id.toString(), modelId: 'seedance-2.0-r2v', confirmSpend: true }),
    ).rejects.toMatchObject({ code: 'MISSING_REFERENCE_IMAGES', status: 400 });
    // Lip-sync is gone from the cut path: an audio-required model is a 400.
    const audio = await Gen.prepareCutRender({ projectId, cutId: framed._id.toString(), modelId: 'ltx-2.3-ia2v' }).catch((e) => e);
    expect(audio).toBeInstanceOf(Gen.InvalidComfyParamsError);
    expect(audio).toMatchObject({ code: 'INVALID_COMFY_PARAMS', status: 400 });
    expect(audio.message).toMatch(/needs a dialogue recording/);
    expect(Gen.MissingDialogueAudioError).toBeUndefined();
    // No video prompt on the cut.
    const { cut: silent } = await seedCut({ prompt: ' ** ** ' });
    const empty = await Gen.prepareCutRender({ projectId, cutId: silent._id.toString(), modelId: 'ltx-2.5-i2v' }).catch((e) => e);
    expect(empty).toMatchObject({ code: 'INVALID_COMFY_PARAMS' });
    expect(empty.message).toMatch(/the cut has no prompt text/);
    // …unless the caller supplies one.
    const over = await Gen.prepareCutRender({ projectId, cutId: silent._id.toString(), modelId: 'ltx-2.5-i2v', promptOverride: '  A custom prompt. ' });
    expect(over.prompt).toBe('A custom prompt.');
    // Another project cannot render it.
    const other = (await createProject('Other'))._id.toString();
    await expect(Gen.prepareCutRender({ projectId: other, cutId: framed._id.toString(), modelId: 'ltx-2.5-i2v' })).rejects.toBeInstanceOf(
      Gen.CutNotFoundError,
    );
  });

  it('the preview is the cut prompt + the frames it will send; an API model passes consent through to the run', async () => {
    const client = fakeClient();
    Client._setComfyClientForTests(client);
    const { cut } = await seedCut();
    const endImage = newImage();
    await VP.updateVideoPrompt(projectId, cut._id, { end_frame: { image_id: endImage, prompt: 'end' } });
    const preview = await Gen.buildComfyPayloadPreview({ projectId, cutId: cut._id.toString(), modelId: 'kling-3.0', confirmSpend: true });
    expect(Object.keys(preview).sort()).toEqual(
      ['end_frame_image_id', 'frames', 'ignored_keyframes', 'keyframes', 'model', 'overrides', 'params', 'prompt', 'workflow', 'reference_image_ids', 'spends_credits', 'start_frame_image_id', 'warnings'].sort(),
    );
    expect(preview.prompt).toBe(CUT_PROMPT_PLAIN);
    expect(preview.spends_credits).toBe(true);
    expect(preview.start_frame_image_id).toBe(String(cut.start_frame.image_id));
    // Kling takes no end frame and no model takes cut-level references.
    expect(preview.end_frame_image_id).toBeNull();
    expect(preview.reference_image_ids).toEqual([]);
    // A first-last-frame model reports both stills.
    const flf = await Gen.buildComfyPayloadPreview({ projectId, cutId: cut._id.toString(), modelId: 'wan-2.2-14b-flf2v' });
    expect(flf.end_frame_image_id).toBe(String(endImage));
    expect(flf.spends_credits).toBe(false);

    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'kling-3.0', confirmSpend: true });
    const job = await waitForTerminal(job_id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    const run = client.calls.find((c) => c.name === 'run_workflow');
    expect(run.args.confirm_spend).toBe(true);
    const upload = client.calls.find((c) => c.name === 'upload_file');
    expect(upload.args.paths).toHaveLength(1);
    const after = await VP.getVideoPrompt(projectId, cut._id.toString());
    expect(after.video_model_lab).toBe('ComfyUI (API)');
  });

  it('persists provider comfy and the seed it actually used', async () => {
    Client._setComfyClientForTests(fakeClient());
    const { cut } = await seedCut();
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
    expect(preview.prompt).toBe(CUT_PROMPT_PLAIN);
    expect(after.video_comfy.params.prompt).toBe(CUT_PROMPT_PLAIN);
  });

  it('the bulk-render and lip-sync entry points are gone', () => {
    expect(Gen.runComfyCutRenderInline).toBeUndefined();
    expect(Gen.MissingDialogueAudioError).toBeUndefined();
    expect(Gen.ComfyBusyError).toBeUndefined();
  });

  // A client whose run_workflow waits on a gate per call, so the test can
  // hold the GPU queue while it inspects the waiting jobs.
  function gatedClient() {
    const gates = [];
    const client = fakeClient();
    const inner = client.callTool.bind(client);
    client.callTool = async (name, args) => {
      if (name === 'run_workflow') await new Promise((r) => gates.push(r));
      return inner(name, args);
    };
    // Opens the next run_workflow gate, waiting for the job to reach it first
    // (a fixed tick was too short under a loaded full-suite run).
    const openNext = async () => {
      const until = Date.now() + 3000;
      while (!gates.length) {
        if (Date.now() > until) throw new Error('no run_workflow call arrived to open');
        await new Promise((r) => setTimeout(r, 2));
      }
      gates.shift()();
    };
    return { client, openNext };
  }

  async function secondCut(beat) {
    const scene = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Another' });
    return VP.createVideoPrompt({
      projectId,
      beatId: beat._id,
      sceneId: scene._id,
      title: 'Cut 2',
      prompt: 'Close on the cup. Stop when it stops.',
      durationSeconds: 3,
      startFrame: { image_id: newImage(), prompt: 'still' },
    });
  }

  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  it('queues several cuts on the one-GPU queue and runs them one at a time — without holding the beat lock', async () => {
    const { client, openNext } = gatedClient();
    Client._setComfyClientForTests(client);
    const { beat, cut } = await seedCut();
    const cut2 = await secondCut(beat);
    const a = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    const b = await Gen.startComfyCutVideoJob({ projectId, cutId: cut2._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    await tick();
    expect(Gen.getComfyVideoJob(a.job_id).status).toBe('running');
    const queued = Gen.serializeComfyJob(Gen.getComfyVideoJob(b.job_id));
    expect(queued.status).toBe('queued');
    expect(queued.queue_position).toBe(1);
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(false);

    // The same cut again is refused with its running job's id.
    const dup = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v' }).catch((e) => e);
    expect(dup).toBeInstanceOf(Gen.ComfyCutBusyError);
    expect(dup.job_id).toBe(a.job_id);

    const listed = Gen.listComfyCutJobsForBeat(beat._id.toString());
    expect(listed.map((j) => j.job_id).sort()).toEqual([a.job_id, b.job_id].sort());

    await openNext();
    expect((await waitForTerminal(a.job_id)).status).toBe('done');
    await tick();
    expect(Gen.getComfyVideoJob(b.job_id).status).toBe('running');
    expect(Gen.getComfyVideoJob(b.job_id).queue_position).toBe(null);
    await openNext();
    expect((await waitForTerminal(b.job_id)).status).toBe('done');
    // Finished: the cut is free for another render.
    const again = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    await openNext();
    expect((await waitForTerminal(again.job_id)).status).toBe('done');
  });

  it('removes a queued job from the queue without running it, and refuses to cancel a running one', async () => {
    const { client, openNext } = gatedClient();
    Client._setComfyClientForTests(client);
    const { beat, cut } = await seedCut();
    const cut2 = await secondCut(beat);
    const a = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    const b = await Gen.startComfyCutVideoJob({ projectId, cutId: cut2._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    await tick();
    expect(() => Gen.cancelComfyCutVideoJob(a.job_id)).toThrow(Gen.ComfyJobNotCancellableError);
    const snap = Gen.cancelComfyCutVideoJob(b.job_id);
    expect(snap.status).toBe('error');
    expect(snap.cancelled).toBe(true);
    expect(snap.error).toBe('Removed from the queue');
    // The cancelled cut can be queued again right away.
    const c = await Gen.startComfyCutVideoJob({ projectId, cutId: cut2._id.toString(), modelId: 'ltx-2.5-i2v', params: { duration_seconds: 2 } });
    expect(Gen.getComfyVideoJob(c.job_id).queue_position).toBe(1);
    Gen.cancelComfyCutVideoJob(c.job_id);
    await openNext();
    expect((await waitForTerminal(a.job_id)).status).toBe('done');
    await tick();
    expect(client.calls.filter((x) => x.name === 'run_workflow')).toHaveLength(1);
  });

  it('a held beat lock does not stop a cut from rendering', async () => {
    Client._setComfyClientForTests(fakeClient());
    const { beat, cut } = await seedCut();
    let release;
    const held = BeatLocks.withBeatLock(beat._id, () => new Promise((r) => (release = r)));
    const { job_id } = await Gen.startComfyCutVideoJob({ projectId, cutId: cut._id.toString(), modelId: 'ltx-2.5-i2v' });
    expect((await waitForTerminal(job_id)).status).toBe('done');
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(true);
    release();
    await held;
  });
});
