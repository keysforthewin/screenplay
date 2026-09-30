// The Prompts-tab agent tools (plan_cuts, render_cut_start_frames,
// render_cut_video, get_cut_job_status): argument threading into the job
// starters, the busy / disabled / consent texts, "scene.cut" resolution, and
// status formatting across the five job registries. The starters are mocked;
// the registries are real modules whose maps we fill through the mocks.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null, withDirectDocument: vi.fn(), broadcastRoomStateless: vi.fn(), isHocuspocusRunning: () => false,
}));

const calls = { plan: [], frames: [], single: [], render: [], comfy: [], fal: [] };
const registries = { render: new Map(), plan: new Map(), frames: new Map(), asm: new Map(), comfy: new Map(), fal: new Map() };
let comfyConfigured = false;
let throwWith = null; // { code, message } thrown by the starters

function maybeThrow() {
  if (!throwWith) return;
  const e = new Error(throwWith.message);
  e.code = throwWith.code;
  throw e;
}

vi.mock('../src/web/cutPlanner.js', () => ({
  startCutPlanJob: vi.fn(async (args) => { maybeThrow(); calls.plan.push(args); return 'plan-job-1'; }),
  getCutPlanJob: (id) => registries.plan.get(id) || null,
}));
vi.mock('../src/web/cutStartFrames.js', () => ({
  startCutStartFramesJob: vi.fn(async (args) => { maybeThrow(); calls.frames.push(args); registries.frames.set('frames-job-1', { job_id: 'frames-job-1', planned: 3, rendered: 0, failed: 0, skipped: 0, status: 'queued', results: [], warnings: [] }); return 'frames-job-1'; }),
  startSingleCutStartFrameJob: vi.fn(async (args) => { maybeThrow(); calls.single.push(args); return 'single-job-1'; }),
  getCutStartFrameJob: (id) => registries.frames.get(id) || null,
}));
vi.mock('../src/web/cutBeatRender.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    defaultProvider: () => (comfyConfigured ? 'comfy' : 'fal'),
    startCutBeatRenderJob: vi.fn(async (args) => { maybeThrow(); calls.render.push(args); return { job_id: 'render-job-1', planned: 3, skipped: 1 }; }),
    getCutBeatRenderJob: (id) => registries.render.get(id) || null,
  };
});
vi.mock('../src/web/comfyVideoGenerate.js', () => ({
  startComfyCutVideoJob: vi.fn(async (args) => { maybeThrow(); calls.comfy.push(args); return { job_id: 'comfy-job-1' }; }),
  getComfyVideoJob: (id) => registries.comfy.get(id) || null,
  serializeComfyJob: (j) => j,
}));
vi.mock('../src/web/falVideoGenerate.js', () => ({
  OWNER_VIDEO_PROMPT: 'video_prompt',
  startVideoGenerationJob: vi.fn(async (args) => { maybeThrow(); calls.fal.push(args); return { job_id: 'fal-job-1' }; }),
  getVideoGenerationJob: (id) => registries.fal.get(id) || null,
  serializeJob: (j) => j,
}));
vi.mock('../src/web/cutAssemble.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, getCutAssembleJob: (id) => registries.asm.get(id) || null };
});
vi.mock('../src/comfy/client.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, isComfyConfigured: () => comfyConfigured };
});
vi.mock('../src/server/index.js', () => ({ attachmentLink: (id) => `https://example.test/attachment/${id}` }));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const Settings = await import('../src/mongo/projectSettings.js');
const { HANDLERS } = await import('../src/agent/handlers.js');
const { isMutatingTool } = await import('../src/agent/reviewMode.js');

let projectId;
let ctx;
let beat;
let cut21;
let loose;

beforeEach(async () => {
  fakeDb.reset();
  for (const k of Object.keys(calls)) calls[k].length = 0;
  for (const r of Object.values(registries)) r.clear();
  comfyConfigured = false;
  throwWith = null;
  projectId = (await createProject('Cut Tools'))._id.toString();
  ctx = { projectId, projectTitle: 'Cut Tools', discordUser: { username: 'steve' } };
  beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'Sarah waits.' });
  const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One' });
  const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Two' });
  await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 1, order: 1, title: 'c11', prompt: 'p' });
  cut21 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s2._id, cutIndex: 1, order: 2, title: 'c21', prompt: 'p' });
  loose = await VP.createVideoPrompt({ projectId, beatId: beat._id, order: 3, title: 'legacy', prompt: 'p' });
});

describe('plan_cuts', () => {
  it('starts the planner with direction + render flag and links the Prompts page', async () => {
    const out = await HANDLERS.plan_cuts({ beat: '1', direction: 'two scenes', render_start_frames: true }, ctx);
    expect(calls.plan[0]).toMatchObject({ projectId, beatId: beat._id.toString(), direction: 'two scenes', renderStartFrames: true });
    expect(out).toMatch(/Planning cuts for beat "Diner" \(job plan-job-1\)/);
    expect(out).toMatch(/every start frame is rendered/);
    expect(out).toMatch(/get_cut_job_status\(\{job_id: "plan-job-1"\}\)/);
    expect(out).toMatch(/Edit in browser: .*\/p\/Cut%20Tools\/prompts\/1/);
  });

  it('reports a busy beat instead of throwing', async () => {
    throwWith = { code: 'BEAT_BUSY', message: 'busy' };
    expect(await HANDLERS.plan_cuts({ beat: '1' }, ctx)).toMatch(/already has Prompts-tab work running/);
  });
});

describe('render_cut_start_frames', () => {
  it('whole beat → bulk job over both frames with skip flag; one cut by "scene.cut" → a job over that cut', async () => {
    const all = await HANDLERS.render_cut_start_frames({ beat: '1', skip_rendered: false, image_model: 'nano-banana-pro' }, ctx);
    expect(calls.frames[0]).toMatchObject({ projectId, beatId: beat._id.toString(), frames: ['start', 'end'], skipRendered: false, imageModel: 'nano-banana-pro' });
    expect(all).toMatch(/start and end frames for beat "Diner": 3 frames/);
    const one = await HANDLERS.render_cut_start_frames({ beat: '1', cut: '2.1', frames: 'end' }, ctx);
    expect(calls.frames[1]).toMatchObject({ projectId, cutIds: [cut21._id.toString()], frames: ['end'], skipRendered: true, imageModel: null });
    expect(one).toMatch(/end frame for cut 2\.1 of beat "Diner"/);
    expect(calls.single).toHaveLength(0);
  });

  it('resolves "#N" / N for unsorted rows and a 24-hex id; unknown labels come back as text', async () => {
    await HANDLERS.render_cut_start_frames({ beat: '1', cut: '#3' }, ctx);
    expect(calls.frames[0].cutIds).toEqual([loose._id.toString()]);
    await HANDLERS.render_cut_start_frames({ beat: '1', cut: cut21._id.toString() }, ctx);
    expect(calls.frames[1].cutIds).toEqual([cut21._id.toString()]);
    const bad = await HANDLERS.render_cut_start_frames({ beat: '1', cut: '9.9' }, ctx);
    expect(bad).toMatch(/Cut not found: "9\.9" in beat "Diner"/);
    expect(calls.frames).toHaveLength(2);
  });
});

describe('render_cut_video', () => {
  it('whole beat: default provider fal when ComfyUI is off; threads models, skip and consent', async () => {
    const out = await HANDLERS.render_cut_video({ beat: '1', model: 'kling-3-pro', lipsync_model: 'kling-avatar-v2-pro', skip_rendered: false }, ctx);
    expect(calls.render[0]).toMatchObject({
      projectId, beatId: beat._id.toString(), provider: 'fal',
      models: { clip: 'kling-3-pro', lipsync: 'kling-avatar-v2-pro' }, skipRendered: false, confirmSpend: false, announceUsername: 'steve',
    });
    expect(out).toMatch(/Rendering beat "Diner" on fal\.ai: 3 cuts to render, 1 skipped/);
    expect(out).toMatch(/get_cut_job_status\(\{job_id: "render-job-1"\}\)/);
  });

  it('says ComfyUI is disabled when asked for it on a server without it', async () => {
    const out = await HANDLERS.render_cut_video({ beat: '1', provider: 'comfy' }, ctx);
    expect(out).toMatch(/ComfyUI rendering is disabled on this server\. Use provider "fal"/);
    expect(calls.render).toHaveLength(0);
  });

  it('defaults to ComfyUI when configured; a single cut goes to the ComfyUI job with the saved params', async () => {
    comfyConfigured = true;
    await Settings.setComfyDefaults(projectId, { model_id: 'wan-2.2-14b-i2v', params_by_model: { 'wan-2.2-14b-i2v': { steps: 6 } } });
    const whole = await HANDLERS.render_cut_video({ beat: '1' }, ctx);
    expect(calls.render[0].provider).toBe('comfy');
    expect(whole).toMatch(/on ComfyUI/);
    const one = await HANDLERS.render_cut_video({ beat: '1', cut: '2.1', confirm_spend: true }, ctx);
    expect(calls.comfy[0]).toMatchObject({ projectId, cutId: cut21._id.toString(), modelId: 'wan-2.2-14b-i2v', params: { steps: 6 }, confirmSpend: true, announceUsername: 'steve' });
    expect(one).toMatch(/Rendering cut 2\.1 of beat "Diner" on ComfyUI \(wan-2\.2-14b-i2v, job comfy-job-1\)/);
  });

  it('a single cut on fal uses the video_prompt owner; consent and input errors come back as text', async () => {
    const one = await HANDLERS.render_cut_video({ beat: '1', cut: '#3', provider: 'fal', model: 'kling-3-pro' }, ctx);
    expect(calls.fal[0]).toMatchObject({ projectId, owner: { kind: 'video_prompt', id: loose._id.toString() }, modelId: 'kling-3-pro', generateAudio: false, includeDirectorNotes: false });
    expect(one).toMatch(/Rendering cut #3 of beat "Diner" on fal\.ai \(job fal-job-1\)/);
    throwWith = { code: 'SPEND_CONSENT_REQUIRED', message: 'Kling spends credits.' };
    expect(await HANDLERS.render_cut_video({ beat: '1', provider: 'fal' }, ctx)).toMatch(/confirm the Comfy credit spend, then call render_cut_video again with confirm_spend: true/);
    throwWith = { code: 'CUT_RENDER_EMPTY', message: 'Nothing to render.' };
    expect(await HANDLERS.render_cut_video({ beat: '1', provider: 'fal' }, ctx)).toMatch(/Cannot render for beat "Diner": Nothing to render\./);
    throwWith = { code: 'BEAT_BUSY', message: 'busy' };
    expect(await HANDLERS.render_cut_video({ beat: '1', provider: 'fal' }, ctx)).toMatch(/already has Prompts-tab work running/);
  });
});

describe('get_cut_job_status', () => {
  it('formats a cut render job with per-cut lines and the beat video link', async () => {
    registries.render.set('r1', {
      job_id: 'r1', provider: 'comfy', status: 'done', phase: 'done', planned: 2, completed: 2, failed: 0, skipped: 1,
      progress: { message: 'Beat video ready (9s).' }, events: [], models: {},
      cuts: [
        { label: '1.1', mode: 'lipsync', status: 'done', model_label: 'LTX-2.3 lip-sync (image + audio to video)', auto_start_frame: true },
        { label: '2.1', mode: 'clip', status: 'done', model_label: 'LTX-2.5 (image to video)' },
        { label: '#3', skipped: true, skip_reason: 'already rendered', status: 'skipped' },
      ],
      video_file_id: 'abc', assembly_skipped_reason: null,
    });
    const out = await HANDLERS.get_cut_job_status({ job_id: 'r1' }, ctx);
    expect(out).toMatch(/^Cut render job r1 \(ComfyUI\): done \(done\) — Beat video ready/);
    expect(out).toMatch(/Cuts: 2\/2 rendered, 1 skipped/);
    expect(out).toMatch(/- 1\.1 · lipsync · done · LTX-2\.3 lip-sync .* · auto start frame/);
    expect(out).toMatch(/- #3 · skipped \(already rendered\)/);
    expect(out).toMatch(/Beat video: https:\/\/example\.test\/attachment\/abc/);
  });

  it('formats plan, start-frame, assembly, comfy and fal jobs, and says when nothing matches', async () => {
    registries.plan.set('p1', { job_id: 'p1', kind: 'plan', status: 'done', phase: 'done', scenes_total: 2, scenes_done: 2, cuts_total: 5, cuts_done: 5, lint_count: 1, warnings: ['w1'], start_frames: { planned: 5, rendered: 4, failed: 1 }, error: null });
    const plan = await HANDLERS.get_cut_job_status({ job_id: 'p1' }, ctx);
    expect(plan).toMatch(/Cut plan job p1: done/);
    expect(plan).toMatch(/Scenes: 2\/2 · cuts: 5\/5 · 1 lint note/);
    expect(plan).toMatch(/Start frames: 4\/5 rendered, 1 failed/);
    expect(plan).toMatch(/Next: review the blocks/);

    registries.frames.set('f1', { job_id: 'f1', status: 'partial', planned: 3, rendered: 2, failed: 1, skipped: 0, results: [{ cut_id: 'x', error: 'no prompt' }], warnings: [] });
    expect(await HANDLERS.get_cut_job_status({ job_id: 'f1' }, ctx)).toMatch(/Frames: 2\/3 rendered, 1 failed[\s\S]*- x: no prompt/);

    registries.asm.set('a1', { job_id: 'a1', scene_id: null, status: 'done', phase: 'done', video_file_id: 'vid', error: null });
    expect(await HANDLERS.get_cut_job_status({ job_id: 'a1' }, ctx)).toMatch(/Beat assembly job a1: done[\s\S]*attachment\/vid/);

    registries.comfy.set('c1', { job_id: 'c1', model_id: 'ltx-2.5-i2v', status: 'running', step: 'Sampling', queue_position: 0, error: null, video_file_id: null });
    expect(await HANDLERS.get_cut_job_status({ job_id: 'c1' }, ctx)).toMatch(/ComfyUI cut render c1 \(ltx-2\.5-i2v\): running — Sampling \(queue 0\)/);

    registries.fal.set('v1', { job_id: 'v1', model_id: 'kling-3-pro', status: 'done', step: 'Done', error: null, video_file_id: 'clip1' });
    expect(await HANDLERS.get_cut_job_status({ job_id: 'v1' }, ctx)).toMatch(/fal\.ai cut render v1 \(kling-3-pro\): done[\s\S]*attachment\/clip1/);

    expect(await HANDLERS.get_cut_job_status({ job_id: 'nope' }, ctx)).toMatch(/No job found/);
  });
});

describe('review mode', () => {
  it('treats the render/plan jobs as mutating tools', () => {
    for (const n of ['plan_cuts', 'render_cut_start_frames', 'render_cut_video']) expect(isMutatingTool(n), n).toBe(true);
    expect(isMutatingTool('get_cut_job_status')).toBe(false);
  });
});
