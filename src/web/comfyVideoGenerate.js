// Cut → video through ComfyUI (comfy-mcp). The Prompts tab's second video
// provider, beside fal (src/web/falVideoGenerate.js). Triggered from
// POST /api/cut/:id/video/generate; returns a job id immediately, then runs
// in the background under a GLOBAL queue of one (a single GPU) and the
// per-beat lock. The SPA streams /api/cut/:id/video-job/:jobId/events.
//
// Pipeline per job:
//   1. Resolve the cut, the registry model, validate + clamp the params,
//      assemble the prompt (binding only for reference-taking models,
//      exclusions appended), pick the images the model needs. A lip-sync
//      model (inputs.audio required) also needs every covered dialogue line
//      recorded; the duration defaults to the joined recordings' length.
//   2. Ensure the template workflow JSON is fetched and runnable.
//   3. Write the start frame / references as PNGs (and, for lip-sync, the
//      joined recordings as an MP3 — persisted on the cut as audio_file_id)
//      into the job dir and upload them into ComfyUI's input directory
//      (comfy-mcp upload_file).
//   4. Copy the template into the job dir and set every slot override
//      (canonical params → addresses, fixed pins, derived values, image
//      slots, advanced passthrough).
//   5. run_workflow(wait=false) → prompt_id; poll job(status) until a
//      terminal state (job(error) explains failures).
//   6. fetch_outputs into the job dir, find the clip, persist it as a
//      beat-owned GridFS attachment, point the cut at it through
//      setVideoPromptVideoViaGateway (previous clip deleted), clean up.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { readImageBuffer } from '../mongo/images.js';
import { uploadAttachmentBuffer } from '../mongo/attachments.js';
import { getVideoPrompt } from '../mongo/videoPrompts.js';
import { listDialogs, ensureDialogAudioDurations } from '../mongo/dialogs.js';
import { stripMarkdown } from '../util/markdown.js';
import { setVideoPromptVideoViaGateway, setVideoPromptAudioViaGateway } from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import {
  coveredDialogsFor,
  speechSecondsFor,
  unrecordedLineNumbers,
  buildCoveredDialogueAudio,
} from './dialogueAudio.js';
import {
  comfy,
  isComfyConfigured,
  ComfyNotConfiguredError,
  ComfyToolError,
} from '../comfy/client.js';
import { getComfyVideoModel, describeComfyVideoModel } from '../comfy/videoModels.js';
import {
  validateComfyParams,
  buildSlotOverrides,
  assembleCutPrompt,
  slotAddressesFromListing,
  randomSeed,
} from '../comfy/paramMap.js';
import { ensureTemplateFile } from '../comfy/templates.js';

// ─── Errors ─────────────────────────────────────────────────────────────────

export class CutNotFoundError extends Error {
  constructor(id) {
    super(`Cut not found: ${id}`);
    this.code = 'CUT_NOT_FOUND';
    this.status = 404;
  }
}

export class UnknownComfyModelError extends Error {
  constructor(id) {
    super(`Unknown ComfyUI model: ${id}`);
    this.code = 'UNKNOWN_COMFY_MODEL';
    this.status = 400;
  }
}

export class InvalidComfyParamsError extends Error {
  constructor(errors) {
    super(`Invalid parameters: ${errors.join('; ')}`);
    this.code = 'INVALID_COMFY_PARAMS';
    this.status = 400;
    this.errors = errors;
  }
}

export class MissingStartFrameError extends Error {
  constructor(modelLabel) {
    super(`${modelLabel} needs a start frame — render the cut's start frame first.`);
    this.code = 'MISSING_START_FRAME';
    this.status = 400;
  }
}

export class MissingEndFrameError extends Error {
  constructor(modelLabel) {
    super(`${modelLabel} needs an end frame — render the cut's end frame first.`);
    this.code = 'MISSING_END_FRAME';
    this.status = 400;
  }
}

export class MissingReferenceImagesError extends Error {
  constructor(modelLabel) {
    super(`${modelLabel} needs at least one reference image on the cut.`);
    this.code = 'MISSING_REFERENCE_IMAGES';
    this.status = 400;
  }
}

export class MissingDialogueAudioError extends Error {
  constructor(modelLabel, lines = []) {
    super(
      lines.length
        ? `${modelLabel} lip-syncs the covered lines' recordings — line${lines.length === 1 ? '' : 's'} ${lines.join(', ')} ${lines.length === 1 ? 'has' : 'have'} no recording yet.`
        : `${modelLabel} lip-syncs recorded dialogue — this cut covers no dialogue lines.`,
    );
    this.code = 'MISSING_DIALOGUE_AUDIO';
    this.status = 400;
    this.lines = lines;
  }
}

export class SpendConsentRequiredError extends Error {
  constructor(modelLabel) {
    super(`${modelLabel} spends Comfy credits — confirm the spend to render with it.`);
    this.code = 'SPEND_CONSENT_REQUIRED';
    this.status = 402;
  }
}

export class ComfyBusyError extends Error {
  constructor(beatId) {
    super(`Work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
    this.status = 409;
  }
}

// ─── Job registry (same snapshot shape as the fal registry) ─────────────────

const jobs = new Map();
const listeners = new Map();
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

const runnerOptions = {
  pollIntervalMs: null, // null → config.comfy.pollIntervalMs at run time
  jobTimeoutMs: null,
};

export function _setComfyRunnerOptionsForTests(opts = null) {
  runnerOptions.pollIntervalMs = opts?.pollIntervalMs ?? null;
  runnerOptions.jobTimeoutMs = opts?.jobTimeoutMs ?? null;
}

export function _resetComfyJobsForTests() {
  jobs.clear();
  listeners.clear();
  queueTail = Promise.resolve();
}

export function getComfyVideoJob(jobId) {
  return jobs.get(jobId) || null;
}

export function subscribeToComfyJob(jobId, cb) {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(cb);
}

export function unsubscribeFromComfyJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

export function serializeComfyJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    provider: 'comfy',
    storyboard_id: null,
    owner_type: 'video_prompt',
    owner_id: job.owner_id,
    beat_id: job.beat_id,
    model_id: job.model_id,
    template: job.template,
    fal_model: null,
    status: job.status,
    step: job.step,
    queue_position: job.queue_position ?? null,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    request_id: job.prompt_id,
    prompt_id: job.prompt_id,
    video_file_id: job.video_file_id,
    estimated_cost_usd: null,
    spends_credits: !!job.spends_credits,
    params: job.params,
    logs: (job.logs || []).slice(-10),
  };
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  const snap = serializeComfyJob(job);
  for (const cb of set) {
    try {
      cb(snap);
    } catch (e) {
      logger.warn(`comfy video gen: listener threw: ${e.message}`);
    }
  }
}

function pushLog(job, message) {
  job.logs.push({ at: new Date().toISOString(), message });
  if (job.logs.length > 50) job.logs.splice(0, job.logs.length - 50);
}

function setStep(job, status, step) {
  job.status = status;
  job.step = step;
  pushLog(job, step);
  publish(job);
}

function scheduleForget(jobId) {
  const t = setTimeout(() => {
    jobs.delete(jobId);
    listeners.delete(jobId);
  }, TERMINAL_RETENTION_MS);
  t.unref?.();
}

// One GPU: renders run strictly one at a time, in submission order.
let queueTail = Promise.resolve();
export function enqueue(fn) {
  const next = queueTail.then(fn, fn);
  queueTail = next.catch(() => {});
  return next;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Preparation (shared by preview and start) ──────────────────────────────

function needs(model, key) {
  return model?.inputs?.[key] === 'required';
}
function accepts(model, key) {
  const v = model?.inputs?.[key];
  return v && v !== 'unused';
}

function idString(v) {
  if (!v) return null;
  return v.toString?.() || String(v);
}

// Resolve everything a render needs without side effects. Throws the typed
// errors the routes map to 4xx/5xx.
export async function prepareCutRender({
  projectId,
  cutId,
  modelId,
  params = {},
  advanced = [],
  confirmSpend = false,
  promptOverride = null,
}) {
  if (!isComfyConfigured()) throw new ComfyNotConfiguredError();
  const cut = await getVideoPrompt(projectId, cutId);
  if (!cut) throw new CutNotFoundError(cutId);
  const model = getComfyVideoModel(modelId);
  if (!model || model.available === false) throw new UnknownComfyModelError(modelId);
  if (model.spends_credits && !confirmSpend) throw new SpendConsentRequiredError(model.label);

  // Lip-sync models: every covered line must be recorded; the clip defaults to
  // the joined recordings' length (the user may lengthen it).
  let audio = null;
  let effectiveParams = params && typeof params === 'object' ? { ...params } : {};
  if (needs(model, 'audio')) {
    const rawDialogs = await listDialogs({ projectId, beatId: cut.beat_id });
    const dialogs = await ensureDialogAudioDurations(projectId, rawDialogs).catch(() => rawDialogs);
    const covered = coveredDialogsFor(cut, dialogs);
    if (!covered.length) throw new MissingDialogueAudioError(model.label, []);
    const unrecorded = unrecordedLineNumbers(covered, dialogs);
    if (unrecorded.length) throw new MissingDialogueAudioError(model.label, unrecorded);
    const speech = speechSecondsFor(covered);
    audio = {
      covered,
      covered_dialog_ids: covered.map((d) => idString(d._id)),
      lines: covered.length,
      speech_seconds: speech,
    };
    if (effectiveParams.duration_seconds == null || effectiveParams.duration_seconds === '') {
      effectiveParams.duration_seconds = Math.max(1, Math.ceil(speech || 1));
    }
  }

  const validated = validateComfyParams(model, effectiveParams);
  if (validated.errors.length) throw new InvalidComfyParamsError(validated.errors);
  // One seed for preview, run and the persisted parameters, so a render can
  // be reproduced (or varied deliberately) later.
  if (validated.params.seed == null && model.params?.seed) validated.params.seed = randomSeed();

  const prompt = assembleCutPrompt(model, cut, { promptOverride, stripMarkdown });
  if (!prompt) throw new InvalidComfyParamsError(['the cut has no prompt text']);
  validated.params.prompt = prompt;

  const startFrameImageId = idString(cut.start_frame?.image_id);
  if (needs(model, 'startFrame') && !startFrameImageId) throw new MissingStartFrameError(model.label);
  const endFrameImageId = idString(cut.end_frame?.image_id);
  if (needs(model, 'endFrame') && !endFrameImageId) throw new MissingEndFrameError(model.label);
  const referenceImageIds = (Array.isArray(cut.reference_images) ? cut.reference_images : [])
    .map((r) => idString(r?.image_id))
    .filter(Boolean)
    .slice(0, model.maxReferenceImages || 0);
  if (needs(model, 'referenceImages') && !referenceImageIds.length) {
    throw new MissingReferenceImagesError(model.label);
  }

  const cutKey = idString(cut._id);
  const imageFilenames = {
    start_frame: accepts(model, 'startFrame') && startFrameImageId ? `cut-${cutKey}-start.png` : null,
    end_frame: accepts(model, 'endFrame') && endFrameImageId ? `cut-${cutKey}-end.png` : null,
    reference: accepts(model, 'referenceImages')
      ? referenceImageIds.map((_, i) => `cut-${cutKey}-ref-${i + 1}.png`)
      : [],
    audio: audio ? `cut-${cutKey}-dialogue.mp3` : null,
  };
  if (audio) audio.filename = imageFilenames.audio;
  const advancedList = Array.isArray(advanced) ? advanced : [];
  const built = buildSlotOverrides(model, {
    params: validated.params,
    imageFilenames,
    advanced: advancedList,
    filenamePrefix: `video/screenplay/cut-${cutKey}`,
  });
  return {
    cut,
    model,
    params: validated.params,
    prompt,
    startFrameImageId: accepts(model, 'startFrame') ? startFrameImageId : null,
    endFrameImageId: accepts(model, 'endFrame') ? endFrameImageId : null,
    referenceImageIds: accepts(model, 'referenceImages') ? referenceImageIds : [],
    imageFilenames,
    audio,
    advanced: advancedList,
    overrides: built.overrides,
    warnings: [...validated.warnings, ...built.warnings],
  };
}

export async function buildComfyPayloadPreview(args) {
  const prep = await prepareCutRender(args);
  return {
    model: describeComfyVideoModel(prep.model),
    params: prep.params,
    prompt: prep.prompt,
    overrides: prep.overrides,
    warnings: prep.warnings,
    spends_credits: !!prep.model.spends_credits,
    start_frame_image_id: prep.startFrameImageId,
    end_frame_image_id: prep.endFrameImageId,
    reference_image_ids: prep.referenceImageIds,
    audio: prep.audio
      ? { lines: prep.audio.lines, speech_seconds: prep.audio.speech_seconds, covered_dialog_ids: prep.audio.covered_dialog_ids }
      : null,
  };
}

// ─── Start ──────────────────────────────────────────────────────────────────

function createJob(prep) {
  const jobId = new ObjectId().toString();
  const job = {
    job_id: jobId,
    owner_id: idString(prep.cut._id),
    beat_id: idString(prep.cut.beat_id),
    model_id: prep.model.id,
    template: prep.model.template,
    status: 'queued',
    step: 'Waiting for the ComfyUI queue',
    queue_position: null,
    started_at: new Date(),
    finished_at: null,
    error: null,
    prompt_id: null,
    video_file_id: null,
    spends_credits: !!prep.model.spends_credits,
    params: prep.params,
    logs: [],
  };
  jobs.set(jobId, job);
  pushLog(job, job.step);
  return job;
}

function failPlumbing(job, e) {
  // runJob handles its own errors; this only catches lock/queue plumbing.
  if (job.status !== 'error' && job.status !== 'done') {
    job.status = 'error';
    job.error = e?.message || String(e);
    job.finished_at = new Date();
    publish(job);
  }
}

// Single-cut render from the SPA or the agent. The beat lock is taken FIRST
// and held while the job waits its turn on the GPU queue: a queued job then
// already owns its beat, so a bulk render for the same beat is refused (409)
// instead of taking the lock and waiting behind a job that waits on it.
export async function startComfyCutVideoJob({
  projectId,
  cutId,
  modelId,
  params = {},
  advanced = [],
  confirmSpend = false,
  promptOverride = null,
  announceUsername = null,
}) {
  const prep = await prepareCutRender({ projectId, cutId, modelId, params, advanced, confirmSpend, promptOverride });
  const beatId = idString(prep.cut.beat_id);
  if (isBeatLocked(beatId)) throw new ComfyBusyError(beatId);
  const job = createJob(prep);
  withBeatLock(beatId, () =>
    enqueue(() => runJob({ job, prep, projectId, confirmSpend, announceUsername })),
  ).catch((e) => failPlumbing(job, e));
  return { job_id: job.job_id };
}

// Render one cut while the CALLER already holds the beat lock (the Prompts
// tab's Render beat job runs its cuts through this). Registers a normal job
// (so the per-cut SSE stream works), waits its turn on the GPU queue, runs it
// to completion and returns the finished job — status 'done' or 'error'
// (runJob never throws; it records the error on the job).
export async function runComfyCutRenderInline({ prep, projectId, confirmSpend = false, announceUsername = null, onJobCreated = null }) {
  const job = createJob(prep);
  try {
    onJobCreated?.(job);
  } catch {
    // observers never fail the render
  }
  try {
    await enqueue(() => runJob({ job, prep, projectId, confirmSpend, announceUsername }));
  } catch (e) {
    failPlumbing(job, e);
  }
  return job;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const OK_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'done']);
const FAIL_STATUSES = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov']);

function extensionForType(ct) {
  if (ct === 'image/jpeg') return 'jpg';
  if (ct === 'image/webp') return 'webp';
  return 'png';
}

async function writeImageToJobDir(imageId, jobDir, baseName) {
  const read = await readImageBuffer(imageId);
  if (!read) throw new Error(`Failed to read image ${imageId} from storage.`);
  const ct = read.file?.contentType || read.file?.metadata?.content_type || 'image/png';
  const ext = extensionForType(ct);
  // Keep the extension honest so ComfyUI's LoadImage decodes it correctly.
  const name = baseName.replace(/\.png$/i, `.${ext}`);
  const abs = path.join(jobDir, name);
  await fsp.writeFile(abs, read.buffer);
  return { abs, name };
}

// comfy-cli echoes the staged names back; prefer them, fall back to the
// basename we uploaded (overwrite=true keeps names unchanged).
// comfy-cli 1.22 answers { uploads: [{ local_path, cloud_name, subfolder, type }] }
// (verified live); older shapes are tolerated.
export function uploadedNameFor(result, abs) {
  const base = path.basename(abs);
  const rows = []
    .concat(
      result?.uploads || [],
      result?.uploaded || [],
      result?.files || [],
      result?.results || [],
      Array.isArray(result) ? result : [],
    )
    .filter((r) => r && typeof r === 'object');
  for (const r of rows) {
    const src = String(r.local_path || r.source || r.path || r.file || '');
    if (src && path.basename(src) === base) {
      const stored = r.cloud_name || r.name || r.stored_name || r.filename || r.uploaded_name;
      const sub = typeof r.subfolder === 'string' && r.subfolder ? `${r.subfolder}/` : '';
      if (stored) return `${sub}${String(stored)}`;
    }
  }
  return base;
}

export function promptIdFrom(result) {
  const candidates = [
    result?.prompt_id,
    result?.id,
    result?.job?.prompt_id,
    result?.job_id,
    result?.data?.prompt_id,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

async function findVideoFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
        const st = await fsp.stat(p).catch(() => null);
        if (st) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  await walk(dir);
  out.sort((a, b) => b.mtime - a.mtime || b.size - a.size);
  return out;
}

function contentTypeForVideo(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

function describeError(e) {
  if (e instanceof ComfyToolError) return e.message;
  return e?.message || String(e);
}

// Poll a submitted prompt to a terminal state. Resolves on success; throws
// with ComfyUI's own explanation on failure or after the job timeout. Shared
// with the still-image runner (src/web/comfyImageGenerate.js).
export async function waitForComfyPrompt(promptId, { onStatus = null } = {}) {
  const pollMs = runnerOptions.pollIntervalMs ?? config.comfy.pollIntervalMs;
  const timeoutMs = runnerOptions.jobTimeoutMs ?? config.comfy.jobTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  for (;;) {
    const st = await comfy.job('status', promptId);
    const status = String(st?.status || '').toLowerCase();
    if (status !== lastStatus) {
      lastStatus = status;
      onStatus?.(status);
    }
    if (OK_STATUSES.has(status)) return;
    if (FAIL_STATUSES.has(status)) {
      let detail = null;
      try {
        detail = await comfy.job('error', promptId);
      } catch {}
      const msg =
        detail?.exception_message ||
        detail?.error?.message ||
        (typeof detail?.error === 'string' ? detail.error : null) ||
        st?.error?.message ||
        (typeof st?.error === 'string' ? st.error : null) ||
        `ComfyUI job ${status}`;
      const code = detail?.error_code ? ` (${detail.error_code})` : '';
      throw new Error(`${msg}${code}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`ComfyUI render timed out after ${Math.round(timeoutMs / 1000)}s (status: ${status || 'unknown'})`);
    }
    await sleep(pollMs);
  }
}

async function runJob({ job, prep, projectId, confirmSpend, announceUsername }) {
  const { cut, model } = prep;
  const jobDir = path.join(config.comfy.workDir, job.job_id);
  const outDir = path.join(jobDir, 'out');
  try {
    await fsp.mkdir(outDir, { recursive: true });

    // 1. Template.
    setStep(job, 'running', 'Preparing the workflow template');
    const tpl = await ensureTemplateFile(model);

    // 2. Images (+ the joined dialogue recording for lip-sync models).
    const imageFilenames = { start_frame: null, end_frame: null, reference: [], audio: null };
    const toUpload = [];
    if (prep.startFrameImageId) {
      setStep(job, 'running', 'Uploading the start frame');
      const w = await writeImageToJobDir(prep.startFrameImageId, jobDir, prep.imageFilenames.start_frame);
      toUpload.push({ role: 'start_frame', ...w });
    }
    if (prep.endFrameImageId) {
      const w = await writeImageToJobDir(prep.endFrameImageId, jobDir, prep.imageFilenames.end_frame);
      toUpload.push({ role: 'end_frame', ...w });
    }
    for (let i = 0; i < prep.referenceImageIds.length; i++) {
      const w = await writeImageToJobDir(prep.referenceImageIds[i], jobDir, prep.imageFilenames.reference[i]);
      toUpload.push({ role: 'reference', ...w });
    }
    if (prep.audio) {
      setStep(job, 'running', `Joining ${prep.audio.lines} recording${prep.audio.lines === 1 ? '' : 's'}`);
      const joined = await buildCoveredDialogueAudio({
        projectId,
        beatId: cut.beat_id,
        covered: prep.audio.covered,
        filename: `cut-${job.owner_id}-dialogue-${Date.now()}.mp3`,
      });
      await setVideoPromptAudioViaGateway({ projectId, promptId: idString(cut._id), audioFileId: joined.file._id });
      const abs = path.join(jobDir, prep.imageFilenames.audio);
      await fsp.writeFile(abs, joined.buffer);
      toUpload.push({ role: 'audio', abs, name: prep.imageFilenames.audio });
    }
    if (toUpload.length) {
      setStep(job, 'running', `Uploading ${toUpload.length} file${toUpload.length === 1 ? '' : 's'} to ComfyUI`);
      const result = await comfy.uploadFile(
        toUpload.map((u) => u.abs),
        { overwrite: true },
      );
      for (const u of toUpload) {
        const stored = uploadedNameFor(result, u.abs);
        if (u.role === 'start_frame') imageFilenames.start_frame = stored;
        else if (u.role === 'end_frame') imageFilenames.end_frame = stored;
        else if (u.role === 'audio') imageFilenames.audio = stored;
        else imageFilenames.reference.push(stored);
      }
    }

    // 3. Parameterise a copy of the template.
    setStep(job, 'running', 'Setting workflow parameters');
    const workflowPath = path.join(jobDir, 'workflow.json');
    await fsp.copyFile(tpl.path, workflowPath);
    let slotAddresses = null;
    if (prep.advanced.length) {
      const listing = await comfy.listWorkflowSlots(workflowPath);
      slotAddresses = slotAddressesFromListing(listing);
    }
    const built = buildSlotOverrides(model, {
      params: prep.params,
      imageFilenames,
      advanced: prep.advanced,
      slotAddresses,
      filenamePrefix: `video/screenplay/cut-${job.owner_id}`,
    });
    for (const w of built.warnings) pushLog(job, `warning: ${w}`);
    await comfy.setWorkflowSlot(workflowPath, built.overrides, { stdout: false });

    // 4. Submit.
    setStep(job, 'running', model.spends_credits ? 'Submitting to the partner API via ComfyUI' : 'Submitting to ComfyUI');
    const submitted = await comfy.runWorkflow(workflowPath, { wait: false, confirmSpend: !!confirmSpend });
    const promptId = promptIdFrom(submitted);
    if (!promptId) {
      throw new Error(`ComfyUI returned no prompt id: ${JSON.stringify(submitted).slice(0, 500)}`);
    }
    job.prompt_id = promptId;
    setStep(job, 'running', 'Queued on ComfyUI');

    // 5. Poll.
    await waitForComfyPrompt(promptId, {
      onStatus: (status) => setStep(job, 'running', status ? `Rendering on ComfyUI (${status})` : 'Rendering on ComfyUI'),
    });

    // 6. Outputs.
    setStep(job, 'running', 'Downloading the rendered clip');
    await comfy.fetchOutputs(promptId, outDir);
    const videos = await findVideoFiles(outDir);
    if (!videos.length) {
      throw new Error('ComfyUI finished but no video file was found among the outputs.');
    }
    const clip = videos[0];
    const buffer = await fsp.readFile(clip.path);

    setStep(job, 'running', 'Saving video');
    const previousId = cut.video_file_id ? idString(cut.video_file_id) : null;
    const file = await uploadAttachmentBuffer(projectId, {
      buffer,
      filename: `cut-${job.owner_id}-comfy-${Date.now()}${path.extname(clip.path).toLowerCase() || '.mp4'}`,
      contentType: contentTypeForVideo(clip.path),
      ownerType: 'beat',
      ownerId: cut.beat_id,
      prompt: prep.prompt,
      generatedBy: `comfy/${model.template}`,
    });
    await setVideoPromptVideoViaGateway({
      projectId,
      promptId: idString(cut._id),
      videoFileId: file._id,
      durationSeconds: prep.params.duration_seconds ?? null,
      modelId: `comfy:${model.id}`,
      modelLabel: model.label,
      falModel: null,
      modelLab: model.kind === 'local' ? 'ComfyUI (local)' : 'ComfyUI (API)',
      modelFamily: model.family,
      modelAddedAt: null,
      parameters: {
        provider: 'comfy',
        template: model.template,
        model_id: model.id,
        params: prep.params,
        prompt_id: promptId,
      },
      costUsd: null,
      provider: 'comfy',
      comfy: { template: model.template, model_id: model.id, params: prep.params, prompt_id: promptId },
    });
    if (previousId && previousId !== idString(file._id)) {
      try {
        const { deleteAttachment } = await import('../mongo/attachments.js');
        await deleteAttachment(previousId);
      } catch (e) {
        logger.warn(`comfy video gen: previous clip ${previousId} cleanup failed: ${e?.message || e}`);
      }
    }

    job.video_file_id = idString(file._id);
    job.finished_at = new Date();
    // Scratch is gone before the job reports done, so a caller that acts on
    // "done" never races the cleanup.
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    setStep(job, 'done', 'Done');
    logger.info(
      `comfy video gen job ${job.job_id} done cut=${job.owner_id} model=${model.id} prompt_id=${promptId} ` +
        `duration=${prep.params.duration_seconds ?? '?'}s kind=${model.kind}`,
    );
    announce({ projectId, cut, model, file, prompt: prep.prompt, announceUsername }).catch(() => {});
  } catch (e) {
    job.status = 'error';
    job.error = describeError(e);
    job.finished_at = new Date();
    publish(job);
    logger.warn(`comfy video gen job ${job.job_id} failed: ${job.error}`);
  } finally {
    scheduleForget(job.job_id);
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function announce({ projectId, cut, model, file, prompt, announceUsername }) {
  if (!announceUsername) return;
  try {
    const { announceMediaEvent } = await import('../discord/announcer.js');
    const { promptsUrl } = await import('./links.js');
    const { getBeat } = await import('../mongo/plots.js');
    const { getProjectById } = await import('../mongo/projects.js');
    const beat = await getBeat(projectId, String(cut.beat_id));
    const project = projectId ? await getProjectById(projectId) : null;
    const name = beat ? stripMarkdown(beat.name || '').trim() : '';
    const order = beat && Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
    const beatLabel = name ? `${order}: ${name}` : order;
    const entityLabel = `Cut${Number.isFinite(cut.order) ? ` ${cut.order}` : ''} — ${beatLabel}`;
    await announceMediaEvent({
      username: announceUsername,
      verb: 'generated video for',
      entityLabel,
      entityUrl: beat ? promptsUrl(project?.title ?? null, beat) : null,
      mediaFileId: file._id,
      mediaLabel: `video (${model.label} via ComfyUI)`,
      prompt,
    });
  } catch (e) {
    logger.warn(`comfy video gen announce failed: ${e?.message || e}`);
  }
}

// Keep the work dir tidy on boot: a crashed process can leave job dirs.
export async function cleanupComfyWorkDir() {
  try {
    if (!fs.existsSync(config.comfy.workDir)) return;
    await fsp.rm(config.comfy.workDir, { recursive: true, force: true });
  } catch {}
}
