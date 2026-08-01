// Playground generation pipeline against fal.ai. Triggered from
// POST /api/playground/generate. The request returns immediately with a job
// id; the SPA opens an EventSource on /api/playground/job/:jobId/events and
// receives pushed updates as fal's queue advances.
//
// Unlike the storyboard video pipeline (falVideoGenerate.js) there is no
// beat lock and no entity to write back to — outputs are persisted as
// project-scoped GridFS files tagged owner_type 'playground' and surfaced
// only through the job snapshot. The in-memory job registry below is a
// deliberate clone of the one in falVideoGenerate.js (module-private there;
// ~60 lines is cheaper than refactoring the 1000-line video pipeline).

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { readImageBuffer, uploadGeneratedImage } from '../mongo/images.js';
import { readAttachmentBuffer, uploadAttachmentBuffer } from '../mongo/attachments.js';
import { fal, isConfigured as falIsConfigured } from '../fal/client.js';
import { uploadFalAsset } from '../fal/upload.js';
import { prepareImageForFal } from '../fal/prepareImage.js';
import {
  getPlaygroundModel,
  buildPlaygroundInput,
  validateControlOptions,
  extractOutputMedia,
  classifyMediaKind,
} from '../fal/playgroundModels.js';

// In-memory job registry. Single-process runtime; jobs are lost on restart
// and evicted a few minutes after reaching a terminal state.
const jobs = new Map();
const listeners = new Map(); // jobId → Set<cb(snapshot)>
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

export class PlaygroundNotConfiguredError extends Error {
  constructor() {
    super('fal.ai is not configured (FAL_KEY missing).');
    this.code = 'FAL_NOT_CONFIGURED';
  }
}

export class UnknownPlaygroundModelError extends Error {
  constructor(modelId) {
    super(`Unknown playground model: ${modelId}`);
    this.code = 'UNKNOWN_MODEL';
  }
}

export class PlaygroundBadOptionsError extends Error {
  constructor(errors) {
    super(`Invalid options: ${errors.join('; ')}`);
    this.code = 'BAD_OPTIONS';
    this.errors = errors;
  }
}

export class PlaygroundMissingInputsError extends Error {
  constructor(missing, modelLabel) {
    super(`Cannot generate with ${modelLabel} — missing required inputs: ${missing.join(', ')}.`);
    this.code = 'MISSING_INPUTS';
    this.missing = missing;
  }
}

export function getPlaygroundJob(jobId) {
  return jobs.get(jobId) || null;
}

export function subscribeToPlaygroundJob(jobId, cb) {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(cb);
}

export function unsubscribeFromPlaygroundJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

export function serializePlaygroundJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    model_id: job.model_id,
    status: job.status,
    step: job.step,
    queue_position: job.queue_position,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    request_id: job.request_id,
    outputs: job.outputs || [],
    logs: (job.logs || []).slice(-10),
  };
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  const snap = serializePlaygroundJob(job);
  for (const cb of set) {
    try {
      cb(snap);
    } catch (e) {
      logger.warn(`playground gen: listener threw: ${e.message}`);
    }
  }
}

function setStep(job, status, step) {
  job.status = status;
  job.step = step;
  publish(job);
}

function scheduleEviction(job) {
  const t = setTimeout(() => {
    jobs.delete(job.job_id);
    listeners.delete(job.job_id);
  }, TERMINAL_RETENTION_MS);
  t.unref?.();
}

function applyQueueUpdate(job, update) {
  const status = String(update?.status || '').toUpperCase();
  if (status === 'IN_QUEUE') {
    job.status = 'IN_QUEUE';
    job.queue_position =
      typeof update.queue_position === 'number' ? update.queue_position : null;
    job.step =
      job.queue_position != null && job.queue_position > 0
        ? `Queued at fal (position ${job.queue_position})`
        : 'Queued at fal';
  } else if (status === 'IN_PROGRESS') {
    job.status = 'IN_PROGRESS';
    job.queue_position = null;
    job.step = `Running ${job.model_id}`;
  } else if (status === 'COMPLETED') {
    job.queue_position = null;
  }
  if (Array.isArray(update?.logs) && update.logs.length) {
    const tail = update.logs.slice(-5).map((l) => ({
      message: String(l?.message || ''),
      timestamp: l?.timestamp || new Date().toISOString(),
    }));
    job.logs = [...(job.logs || []), ...tail].slice(-25);
  }
}

// Required-slot validation against the catalog row's classified inputs.
function computeMissing(row, { prompt, refs }) {
  const slots = row.inputs || {};
  const counts = { image: 0, audio: 0, video: 0 };
  for (const r of refs) {
    if (counts[r.kind] !== undefined) counts[r.kind] += 1;
  }
  const missing = [];
  if (slots.prompt === 'required' && !(typeof prompt === 'string' && prompt.trim())) {
    missing.push('prompt');
  }
  if ((slots.image?.required_count || 0) > counts.image) missing.push('image');
  if (slots.audio?.need === 'required' && !counts.audio) missing.push('audio');
  if (slots.video?.need === 'required' && !counts.video) missing.push('video');
  return missing;
}

const EXT_BY_TYPE = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
function extForType(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE[base] || 'bin';
}

async function fetchMediaBytes(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`fal output download network error: ${e.message}`);
  }
  if (!res.ok) {
    throw new Error(`fal output download failed (${res.status})`);
  }
  const contentType = res.headers.get('content-type') || null;
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType };
}

// Load a reference file from GridFS, enforcing that it is a playground
// upload belonging to this project — stale/cross-project ids behave as
// not-found, mirroring the project_id verification convention elsewhere.
async function loadRef(projectId, ref) {
  const read = ref.kind === 'image'
    ? await readImageBuffer(ref.file_id)
    : await readAttachmentBuffer(ref.file_id);
  const meta = read?.file?.metadata || null;
  if (!read || !meta || String(meta.project_id) !== String(projectId) || meta.owner_type !== 'playground') {
    throw new Error(`Playground reference not found: ${ref.file_id}`);
  }
  return read;
}

async function runJob(job, { projectId, row, prompt, refs, options }) {
  // 1. Load refs from GridFS and upload to fal storage.
  setStep(job, 'uploading', 'Uploading reference files');
  const imageUrls = [];
  let audioUrl = null;
  let videoUrl = null;
  for (const ref of refs) {
    const read = await loadRef(projectId, ref);
    const meta = read.file.metadata || {};
    let { buffer } = read;
    let contentType = meta.content_type || null;
    if (ref.kind === 'image') {
      const prepared = await prepareImageForFal({ buffer, contentType });
      buffer = prepared.buffer;
      contentType = prepared.contentType;
    }
    const url = await uploadFalAsset({
      buffer,
      contentType,
      name: `playground-${ref.kind}-${ref.file_id}`,
    });
    if (ref.kind === 'image') imageUrls.push(url);
    else if (ref.kind === 'audio') audioUrl = url;
    else if (ref.kind === 'video') videoUrl = url;
  }

  // 2. Build the input and submit to fal's queue (submit + subscribeToStatus
  //    so the request_id lands in the snapshot for reconnects).
  const input = buildPlaygroundInput(row, { prompt, imageUrls, audioUrl, videoUrl, options });
  setStep(job, 'submitting', `Submitting to ${row.display_name}`);
  const submission = await fal.queue.submit(row.endpoint_id, { input });
  job.request_id = submission.request_id;
  logger.info(
    `playground gen submit job=${job.job_id} model=${row.endpoint_id} request_id=${submission.request_id}`,
  );

  await fal.queue.subscribeToStatus(row.endpoint_id, {
    requestId: submission.request_id,
    logs: true,
    onQueueUpdate: (update) => {
      applyQueueUpdate(job, update);
      publish(job);
    },
  });

  // 3. Pull the result and extract every media URL.
  setStep(job, 'downloading', 'Downloading output');
  const result = await fal.queue.result(row.endpoint_id, {
    requestId: submission.request_id,
  });
  const data = result?.data || result;
  const media = extractOutputMedia(row, data);
  if (!media.length) {
    throw new Error(
      `fal returned no media URL in result.data: ${JSON.stringify(data).slice(0, 500)}`,
    );
  }

  // 4. Persist each output into GridFS (bucket chosen by the *downloaded*
  //    content type, falling back to the catalog's declared kind).
  setStep(job, 'persisting', 'Saving output');
  const outputs = [];
  for (const item of media) {
    const { buffer, contentType } = await fetchMediaBytes(item.url);
    const kind = classifyMediaKind(contentType) || item.kind || row.output?.kind;
    if (kind === 'image') {
      const file = await uploadGeneratedImage(projectId, {
        buffer,
        contentType: contentType || undefined,
        prompt: prompt || null,
        generatedBy: row.endpoint_id,
        ownerType: 'playground',
      });
      outputs.push({ kind: 'image', file_id: file._id.toString() });
    } else {
      const file = await uploadAttachmentBuffer(projectId, {
        buffer,
        filename: `playground-${Date.now()}.${extForType(contentType)}`,
        contentType: contentType || 'application/octet-stream',
        ownerType: 'playground',
      });
      outputs.push({ kind, file_id: file._id.toString() });
    }
  }

  job.outputs = outputs;
  job.finished_at = new Date();
  setStep(job, 'done', 'Done');
  logger.info(`playground gen job ${job.job_id} done model=${row.endpoint_id} outputs=${outputs.length}`);
}

/**
 * Validate synchronously (throws the typed errors above), then run the job in
 * the background. Returns { job_id } immediately.
 */
export async function startPlaygroundJob({ projectId, modelId, prompt = null, refs = [], options = {}, catalogPath } = {}) {
  if (!projectId) throw new Error('projectId required');
  if (!falIsConfigured()) throw new PlaygroundNotConfiguredError();
  const row = await getPlaygroundModel(modelId, catalogPath ? { catalogPath } : {});
  if (!row) throw new UnknownPlaygroundModelError(modelId);

  const cleanRefs = (Array.isArray(refs) ? refs : []).map((r) => ({
    file_id: String(r?.file_id || ''),
    kind: String(r?.kind || ''),
  })).filter((r) => r.file_id && ['image', 'audio', 'video'].includes(r.kind));

  const missing = computeMissing(row, { prompt, refs: cleanRefs });
  if (missing.length) throw new PlaygroundMissingInputsError(missing, row.display_name);
  const { clean: cleanOptions, errors: optionErrors } = validateControlOptions(
    row,
    options && typeof options === 'object' ? options : {},
  );
  if (optionErrors.length) throw new PlaygroundBadOptionsError(optionErrors);
  const max = row.inputs?.image?.max;
  const imageCount = cleanRefs.filter((r) => r.kind === 'image').length;
  if (max !== null && max !== undefined && imageCount > max) {
    throw new PlaygroundMissingInputsError(
      [`too many images (max ${max})`],
      row.display_name,
    );
  }

  const job = {
    job_id: new ObjectId().toString(),
    model_id: row.endpoint_id,
    status: 'starting',
    step: 'Starting',
    queue_position: null,
    started_at: new Date(),
    finished_at: null,
    error: null,
    request_id: null,
    outputs: [],
    logs: [],
  };
  jobs.set(job.job_id, job);

  runJob(job, { projectId, row, prompt, refs: cleanRefs, options: cleanOptions })
    .catch((err) => {
      logger.warn(`playground gen job ${job.job_id} failed: ${err.message}`);
      job.status = 'error';
      job.error = err.message;
      job.finished_at = new Date();
      publish(job);
    })
    .finally(() => scheduleEviction(job));

  return { job_id: job.job_id };
}
