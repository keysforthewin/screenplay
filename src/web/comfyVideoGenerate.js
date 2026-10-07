// Cut → video through ComfyUI (comfy-mcp). The Scenes tab's second video
// provider, beside fal (src/web/falVideoGenerate.js). Triggered from
// POST /api/cut/:id/video/generate; returns a job id immediately, then runs
// in the background under a GLOBAL queue of one (a single GPU), one job per
// cut. The SPA streams /api/cut/:id/video-job/:jobId/events.
//
// Pipeline per job:
//   1. Resolve the cut, the registry model, validate + clamp the params, take
//      the cut's video prompt and the frames the model needs.
//   2. Ensure the template workflow JSON is fetched and runnable.
//   3. Write the start / end frame as PNGs into the job dir and upload them
//      into ComfyUI's input directory (comfy-mcp upload_file).
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
import { stripMarkdown } from '../util/markdown.js';
import { setVideoPromptVideoViaGateway } from './gateway.js';
import { isTerminalJobStatus, RECENT_JOB_MS } from './jobLookup.js';
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
import { LTX_NATIVE_MAX_SECONDS, LTX_LONG_CLIP_MAX_SECONDS } from '../comfy/videoModels.js';
import { buildLtxKeyframeWorkflow, ltxFrameCount, placeKeyframes } from '../comfy/ltxKeyframeWorkflow.js';

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

export class SpendConsentRequiredError extends Error {
  constructor(modelLabel) {
    super(`${modelLabel} spends Comfy credits — confirm the spend to render with it.`);
    this.code = 'SPEND_CONSENT_REQUIRED';
    this.status = 402;
  }
}

export class ComfyCutBusyError extends Error {
  constructor(cutId, jobId) {
    super(`Cut ${cutId} already has a ComfyUI render queued or running`);
    this.code = 'CUT_BUSY';
    this.status = 409;
    this.job_id = jobId;
  }
}

export class ComfyJobNotCancellableError extends Error {
  constructor(status) {
    super(`Only a job still waiting in the queue can be removed (this one is ${status})`);
    this.code = 'NOT_QUEUED';
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
  waiting.length = 0;
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
    cancelled: !!job.cancelled,
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

// Video jobs waiting for the GPU, in queue order — the source of each job's
// queue_position. (Still-image renders share the GPU queue but are not
// listed, so a position can be optimistic while frames render.)
const waiting = [];

function refreshQueuePositions() {
  waiting.forEach((id, i) => {
    const job = jobs.get(id);
    if (!job) return;
    const position = i + 1;
    if (job.queue_position === position) return;
    job.queue_position = position;
    job.step = i === 0 ? 'Next in the ComfyUI queue' : `Waiting for the ComfyUI queue (${i} ahead)`;
    publish(job);
  });
}

function leaveQueue(job) {
  const i = waiting.indexOf(job.job_id);
  if (i !== -1) waiting.splice(i, 1);
  job.queue_position = null;
  refreshQueuePositions();
}

function activeJobForCut(cutId) {
  for (const job of jobs.values()) {
    if (job.owner_id === cutId && !isTerminalJobStatus(job.status)) return job;
  }
  return null;
}

// Every ComfyUI cut job of a beat a reopened page should show: the active
// ones plus those that finished recently, newest per cut.
export function listComfyCutJobsForBeat(beatId, { recentMs = RECENT_JOB_MS } = {}) {
  const id = String(beatId || '');
  const cutoff = Date.now() - recentMs;
  const ts = (d) => (d ? new Date(d).getTime() : 0);
  const byCut = new Map();
  for (const job of jobs.values()) {
    if (job.beat_id !== id) continue;
    const terminal = isTerminalJobStatus(job.status);
    if (terminal && ts(job.finished_at) < cutoff) continue;
    const prev = byCut.get(job.owner_id);
    const rank = (j) => (isTerminalJobStatus(j.status) ? 0 : 1);
    if (!prev || rank(job) > rank(prev) || (rank(job) === rank(prev) && ts(job.started_at) > ts(prev.started_at))) {
      byCut.set(job.owner_id, job);
    }
  }
  return [...byCut.values()].map(serializeComfyJob);
}

// Remove a job that is still waiting for the GPU. Its queue slot runs as a
// no-op when reached; a job already running is not interrupted.
export function cancelComfyCutVideoJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status !== 'queued') throw new ComfyJobNotCancellableError(job.status);
  job.cancelled = true;
  job.status = 'error';
  job.error = 'Removed from the queue';
  job.step = 'Removed from the queue';
  job.finished_at = new Date();
  pushLog(job, job.step);
  leaveQueue(job);
  publish(job);
  scheduleForget(job.job_id);
  return serializeComfyJob(job);
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

// Snap a length UP to what the model can render: its step (whole seconds for
// an int param), then its min/max. null when there is no length.
export function snapDurationUp(seconds, spec = null) {
  let n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const step = positive(spec?.step) || (spec?.type === 'int' ? 1 : null);
  if (step) n = Math.ceil(n / step - 1e-9) * step;
  if (spec?.type === 'int') n = Math.ceil(n - 1e-9);
  const min = positive(spec?.min);
  const max = positive(spec?.max);
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return Math.round(n * 1000) / 1000;
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

  // The Scenes tab supplies a prompt and two frames — nothing else.
  if (needs(model, 'audio')) {
    throw new InvalidComfyParamsError([`${model.label} needs a dialogue recording, which a cut does not carry`]);
  }
  const effectiveParams = params && typeof params === 'object' ? { ...params } : {};
  // No length from the caller: the cut's own, snapped up to what this model
  // renders.
  if (model.params?.duration_seconds && (effectiveParams.duration_seconds == null || effectiveParams.duration_seconds === '')) {
    const seconds = snapDurationUp(cut.duration_seconds, model.params.duration_seconds);
    if (seconds != null) effectiveParams.duration_seconds = seconds;
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
  // A cut has no reference images of its own (each FRAME has); a
  // reference-to-video model cannot be driven from here.
  const referenceImageIds = [];
  if (needs(model, 'referenceImages')) throw new MissingReferenceImagesError(model.label);

  const cutKey = idString(cut._id);
  const warnings = [...validated.warnings];

  // Keyframes: pictures the clip must pass through between its frames. Only
  // a model that declares `inputs.keyframes` renders them; for any other the
  // cut's keyframes are ignored, and the preview says so.
  const keyframesWithImages = (cut.keyframes || []).filter((k) => k.image_id);
  let keyframes = [];
  let frames = null;
  if (accepts(model, 'keyframes')) {
    const fps = Number(validated.params.fps) || 24;
    const seconds = Number(validated.params.duration_seconds) || 0;
    if (model.graph && !validated.params.long_clip && seconds > LTX_NATIVE_MAX_SECONDS) {
      throw new InvalidComfyParamsError([
        `${model.label} renders up to ${LTX_NATIVE_MAX_SECONDS} s in one pass; turn on long_clip (context windows) for a ${seconds} s cut`,
      ]);
    }
    if (model.graph && seconds > LTX_LONG_CLIP_MAX_SECONDS) {
      throw new InvalidComfyParamsError([`${model.label} renders at most ${LTX_LONG_CLIP_MAX_SECONDS} s`]);
    }
    frames = ltxFrameCount(seconds, fps);
    const outside = keyframesWithImages.filter((k) => !(k.at_seconds > 0 && k.at_seconds < seconds));
    if (outside.length) {
      throw new InvalidComfyParamsError(
        outside.map((k) => `keyframe at ${k.at_seconds} s lies outside the ${seconds} s clip — move it or lengthen the cut`),
      );
    }
    const placed = placeKeyframes(
      keyframesWithImages.map((k, i) => ({
        filename: `cut-${cutKey}-kf-${i + 1}.png`,
        at_seconds: k.at_seconds,
        strength: k.strength,
        keyframe_id: idString(k.id),
        image_id: idString(k.image_id),
      })),
      { fps, frames, defaultStrength: Number(validated.params.guide_strength) || 0.7 },
    );
    warnings.push(...placed.warnings);
    keyframes = placed.guides.map((g) => {
      const src = keyframesWithImages.find((k) => `cut-${cutKey}-kf-${keyframesWithImages.indexOf(k) + 1}.png` === g.filename);
      return { ...g, keyframe_id: idString(src?.id), image_id: idString(src?.image_id) };
    });
  } else if (keyframesWithImages.length) {
    warnings.push(`${keyframesWithImages.length} keyframe${keyframesWithImages.length === 1 ? '' : 's'} ignored: ${model.label} renders a start and an end frame only`);
  }

  const imageFilenames = {
    start_frame: accepts(model, 'startFrame') && startFrameImageId ? `cut-${cutKey}-start.png` : null,
    end_frame: accepts(model, 'endFrame') && endFrameImageId ? `cut-${cutKey}-end.png` : null,
    reference: accepts(model, 'referenceImages')
      ? referenceImageIds.map((_, i) => `cut-${cutKey}-ref-${i + 1}.png`)
      : [],
    keyframes: keyframes.map((k) => ({ filename: k.filename, frame_idx: k.frame_idx, strength: k.strength })),
    audio: null,
  };
  const advancedList = Array.isArray(advanced) ? advanced : [];
  let overrides = [];
  if (model.graph) {
    // A builder model takes no slot overrides; `advanced` has nowhere to go.
    if (advancedList.length) warnings.push('advanced slot overrides are ignored by a builder model');
  } else {
    const built = buildSlotOverrides(model, {
      params: validated.params,
      imageFilenames,
      advanced: advancedList,
      filenamePrefix: `video/screenplay/cut-${cutKey}`,
    });
    overrides = built.overrides;
    warnings.push(...built.warnings);
  }
  return {
    cut,
    model,
    params: validated.params,
    prompt,
    startFrameImageId: accepts(model, 'startFrame') ? startFrameImageId : null,
    endFrameImageId: accepts(model, 'endFrame') ? endFrameImageId : null,
    referenceImageIds: accepts(model, 'referenceImages') ? referenceImageIds : [],
    keyframes,
    ignoredKeyframes: accepts(model, 'keyframes') ? 0 : keyframesWithImages.length,
    frames,
    imageFilenames,
    advanced: model.graph ? [] : advancedList,
    overrides,
    warnings,
  };
}

// The API-format graph a builder model renders with. `imageFilenames` carries
// the UPLOADED names (the preview passes the planned ones).
function buildGraphWorkflow(prep, imageFilenames) {
  if (prep.model.graph !== 'ltx25-keyframes') throw new Error(`unknown graph builder: ${prep.model.graph}`);
  const p = prep.params;
  return buildLtxKeyframeWorkflow({
    prompt: prep.prompt,
    negativePrompt: p.negative_prompt || undefined,
    width: p.width,
    height: p.height,
    frames: prep.frames,
    fps: p.fps,
    seed: p.seed,
    images: {
      start_frame: imageFilenames.start_frame,
      end_frame: imageFilenames.end_frame,
      keyframes: imageFilenames.keyframes,
    },
    guideStrength: p.guide_strength,
    longClip: !!p.long_clip,
    filenamePrefix: `video/screenplay/cut-${idString(prep.cut._id)}`,
  });
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
    keyframes: prep.keyframes.map(({ keyframe_id, image_id, at_seconds, frame_idx, strength }) => ({ keyframe_id, image_id, at_seconds, frame_idx, strength })),
    ignored_keyframes: prep.ignoredKeyframes,
    frames: prep.frames,
    workflow: prep.model.graph ? buildGraphWorkflow(prep, prep.imageFilenames).workflow : null,
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
    template: prep.model.template || prep.model.graph,
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
  waiting.push(jobId);
  refreshQueuePositions();
  return job;
}

function failPlumbing(job, e) {
  // runJob handles its own errors; this only catches lock/queue plumbing.
  leaveQueue(job);
  if (job.status !== 'error' && job.status !== 'done') {
    job.status = 'error';
    job.error = e?.message || String(e);
    job.finished_at = new Date();
    publish(job);
  }
}

// Single-cut render from the SPA. One job per cut; any number of cuts wait
// FIFO on the one-GPU queue.
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
  const cutKey = idString(prep.cut._id);
  const existing = activeJobForCut(cutKey);
  if (existing) throw new ComfyCutBusyError(cutKey, existing.job_id);
  const job = createJob(prep);
  enqueue(() => runJob({ job, prep, projectId, confirmSpend, announceUsername })).catch((e) => failPlumbing(job, e));
  return { job_id: job.job_id };
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
  if (job.cancelled) return;
  leaveQueue(job);
  const { cut, model } = prep;
  const jobDir = path.join(config.comfy.workDir, job.job_id);
  const outDir = path.join(jobDir, 'out');
  try {
    await fsp.mkdir(outDir, { recursive: true });

    // 1. Template (a builder model has none — its graph is written in step 3).
    let tpl = null;
    if (!model.graph) {
      setStep(job, 'running', 'Preparing the workflow template');
      tpl = await ensureTemplateFile(model);
    }

    // 2. Images.
    const imageFilenames = { start_frame: null, end_frame: null, reference: [], keyframes: [], audio: null };
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
    for (const k of prep.keyframes) {
      const w = await writeImageToJobDir(k.image_id, jobDir, k.filename);
      toUpload.push({ role: 'keyframe', keyframe: k, ...w });
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
        else if (u.role === 'keyframe') {
          imageFilenames.keyframes.push({ filename: stored, frame_idx: u.keyframe.frame_idx, strength: u.keyframe.strength, keyframe_id: u.keyframe.keyframe_id });
        }
        else imageFilenames.reference.push(stored);
      }
    }

    // 3. The workflow: a builder model's graph is written and pre-flighted;
    //    a template model's copy is parameterised through set_workflow_slot.
    const workflowPath = path.join(jobDir, 'workflow.json');
    let guides = null;
    if (model.graph) {
      setStep(job, 'running', `Building the workflow (${imageFilenames.keyframes.length} keyframe${imageFilenames.keyframes.length === 1 ? '' : 's'})`);
      for (const w of prep.warnings) pushLog(job, `warning: ${w}`);
      const built = buildGraphWorkflow(prep, imageFilenames);
      guides = built.guides;
      await fsp.writeFile(workflowPath, JSON.stringify(built.workflow));
      const report = await comfy.validateWorkflow(workflowPath);
      if (report && report.valid === false) {
        const findings = (report.errors || []).map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e)));
        throw new Error(`the generated workflow failed ComfyUI validation: ${findings.join('; ') || 'no details'}`);
      }
      for (const w of report?.warnings || []) pushLog(job, `validation: ${typeof w === 'string' ? w : w.message || JSON.stringify(w)}`);
    } else {
      setStep(job, 'running', 'Setting workflow parameters');
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
    }

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
      generatedBy: `comfy/${model.template || model.graph}`,
    });
    // What the clip was rendered with — for a builder model also where each
    // guide sat (so a clip records the keyframe placement it was given).
    const comfyRecord = {
      template: model.template,
      graph: model.graph || null,
      model_id: model.id,
      params: prep.params,
      prompt_id: promptId,
      ...(guides
        ? {
            guides: guides.map((g) => {
              const u = g.role === 'keyframe' ? imageFilenames.keyframes.find((k) => k.filename === g.filename) : null;
              return { frame_idx: g.frame_idx, strength: g.strength, role: g.role, ...(u?.keyframe_id ? { keyframe_id: u.keyframe_id } : {}) };
            }),
            frames: prep.frames,
          }
        : {}),
    };
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
      parameters: { provider: 'comfy', ...comfyRecord },
      costUsd: null,
      provider: 'comfy',
      comfy: comfyRecord,
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
    const { scenesUrl } = await import('./links.js');
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
      entityUrl: beat ? scenesUrl(project?.title ?? null, beat) : null,
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
