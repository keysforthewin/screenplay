// Storyboard video generation pipeline against fal.ai. Triggered from
// POST /api/storyboard/:id/video/generate. The request returns immediately
// with a job id; the actual work runs in the background under the per-beat
// lock so it can't race a storyboard regenerate / edit. The SPA opens an
// EventSource on /api/storyboard/:id/video-job/:jobId/events and receives
// pushed updates as fal's queue advances.
//
// Pipeline:
//   1. Validate the chosen model's required inputs are present on the row.
//   2. Read each needed input from GridFS and upload to fal storage. fal
//      bills for storage and accepts a lifecycle hint, so we expire inputs
//      after config.fal.storageLifetimeDays (default 7).
//   3. For Kling 3 Pro: assemble `elements` from storyboard.characters_in_scene
//      by looking up each character's character_sheet_image_ids[], uploading
//      each, and packaging (frontal + reference URLs) per element.
//   4. fal.queue.submit → request_id.
//   5. fal.queue.subscribeToStatus emits IN_QUEUE / IN_PROGRESS / COMPLETED
//      callbacks; each callback fans out to the SSE listeners for this job
//      AND updates the persisted-in-memory job snapshot (for reconnects).
//   6. fal.queue.result → the model entry's extractVideoUrl picks the
//      output URL.
//   7. Download the MP4 bytes; persist into GridFS attachments bucket as a
//      beat-owned attachment, tagged metadata.kind='video' and
//      metadata.generated_by=<fal model id>.
//   8. setStoryboardVideoViaGateway() — the gateway broadcasts a
//      fields_updated ping so the connected SPA renders the new video.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { readImageBuffer } from '../mongo/images.js';
import {
  readAttachmentBuffer,
  uploadAttachmentBuffer,
} from '../mongo/attachments.js';
import { getStoryboard as mongoGetStoryboard } from '../mongo/storyboards.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { setStoryboardVideoViaGateway } from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { fal, isConfigured as falIsConfigured } from '../fal/client.js';
import {
  getVideoModelOrCatalog,
  validateStoryboardInputs,
} from '../fal/videoModels.js';

// In-memory job registry. Single-process runtime, like the old Wan
// orchestrator. Jobs are lost on restart; the SPA's EventSource simply
// closes when the server is unreachable, and the user can kick off another.
const jobs = new Map();

// Pub/sub for SSE listeners. listeners.get(jobId) is a Set of (snapshot) =>
// void callbacks the route registers via subscribeToJob.
const listeners = new Map();

// How long to keep a finished job in the map so a slow-to-connect SSE
// client still gets the terminal state on a refresh.
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

function makeJobId() {
  return new ObjectId().toString();
}

export function getVideoGenerationJob(jobId) {
  return jobs.get(jobId) || null;
}

export function subscribeToJob(jobId, cb) {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(cb);
}

export function unsubscribeFromJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  // Snapshot — don't expose the live mutable object to listeners.
  const snap = serializeJob(job);
  for (const cb of set) {
    try {
      cb(snap);
    } catch (e) {
      logger.warn(`fal video gen: listener threw: ${e.message}`);
    }
  }
}

export function serializeJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    storyboard_id: job.storyboard_id,
    beat_id: job.beat_id,
    model_id: job.model_id,
    fal_model: job.fal_model,
    status: job.status,
    step: job.step,
    queue_position: job.queue_position,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    request_id: job.request_id,
    video_file_id: job.video_file_id,
    logs: (job.logs || []).slice(-10),
  };
}

export class VideoBeatBusyError extends Error {
  constructor(beatId) {
    super(`Storyboard work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

export class MissingInputsError extends Error {
  constructor(missing, modelLabel) {
    super(
      `Cannot generate video with ${modelLabel} — missing required inputs: ${missing.join(
        ', ',
      )}.`,
    );
    this.code = 'MISSING_INPUTS';
    this.missing = missing;
  }
}

export class FalNotConfiguredError extends Error {
  constructor() {
    super(
      'fal.ai is not configured. Set FAL_KEY in your env to enable video generation.',
    );
    this.code = 'FAL_NOT_CONFIGURED';
  }
}

export class UnknownVideoModelError extends Error {
  constructor(modelId) {
    super(`Unknown video model: ${modelId}`);
    this.code = 'UNKNOWN_MODEL';
  }
}

// Validate inputs + start the background job. Returns { job_id } so the SPA
// can immediately open its SSE stream.
export async function startVideoGenerationJob({
  storyboardId,
  modelId = null,
  prompt = null,
  durationSeconds = null,
  generateAudio = true,
} = {}) {
  if (!falIsConfigured()) {
    throw new FalNotConfiguredError();
  }

  const chosenId = modelId || config.fal.defaultModelId;
  const model = await getVideoModelOrCatalog(chosenId);
  if (!model) throw new UnknownVideoModelError(chosenId);

  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);

  const missing = validateStoryboardInputs(model, sb);
  if (missing.length) throw new MissingInputsError(missing, model.label);

  if (isBeatLocked(sb.beat_id)) {
    throw new VideoBeatBusyError(sb.beat_id.toString());
  }

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    storyboard_id: sb._id.toString(),
    beat_id: sb.beat_id.toString(),
    model_id: model.id,
    fal_model: model.falModel,
    status: 'queued',
    step: 'Queued',
    queue_position: null,
    started_at: new Date(),
    finished_at: null,
    error: null,
    request_id: null,
    video_file_id: null,
    logs: [],
  };
  jobs.set(jobId, job);
  publish(job);

  withBeatLock(sb.beat_id, () =>
    runVideoGenerationJob({
      job,
      storyboard: sb,
      model,
      prompt,
      durationSeconds,
      generateAudio,
    }),
  )
    .catch((e) => {
      if (job.status !== 'done' && job.status !== 'error') {
        job.status = 'error';
        job.error = e?.message || String(e);
        job.finished_at = new Date();
        publish(job);
      }
      logger.error(`fal video gen job ${jobId} crashed: ${e?.message || e}`);
    })
    .finally(() => {
      scheduleJobEviction(jobId);
    });

  return { job_id: jobId };
}

function scheduleJobEviction(jobId) {
  setTimeout(() => {
    jobs.delete(jobId);
    listeners.delete(jobId);
  }, TERMINAL_RETENTION_MS).unref?.();
}

function setStep(job, status, step) {
  job.status = status;
  job.step = step;
  publish(job);
}

// Build a File-like Blob and hand it to fal.storage.upload. fal returns a
// public URL with the configured lifecycle. We give every upload a
// human-friendly filename so fal's logs / dashboards stay readable.
async function uploadFalAsset({ buffer, contentType, name }) {
  const expiresIn = `${Math.max(1, config.fal.storageLifetimeDays)}d`;
  const file = new File([buffer], name || `asset-${Date.now()}.bin`, {
    type: contentType || 'application/octet-stream',
  });
  return fal.storage.upload(file, { lifecycle: { expiresIn } });
}

async function loadAndUploadImage(imageId, name) {
  if (!imageId) return null;
  const read = await readImageBuffer(imageId);
  if (!read) throw new Error(`Failed to read image ${imageId} from storage.`);
  const ct =
    read.file?.contentType || read.file?.metadata?.content_type || 'image/png';
  return uploadFalAsset({ buffer: read.buffer, contentType: ct, name });
}

async function loadAndUploadAttachment(attachmentId, name) {
  if (!attachmentId) return null;
  const read = await readAttachmentBuffer(attachmentId);
  if (!read) throw new Error(`Failed to read attachment ${attachmentId} from storage.`);
  const ct =
    read.file?.contentType || read.file?.metadata?.content_type || 'application/octet-stream';
  return uploadFalAsset({ buffer: read.buffer, contentType: ct, name });
}

// Build the `elements` array for Kling 3 Pro from a storyboard's
// characters_in_scene. For each named character we look up the modern
// character_sheet_image_ids[] (with legacy single-id fallback handled by
// getCharacter), use the first sheet as `frontal_image_url` and any
// remaining sheets as `reference_image_urls`. Characters with no sheets are
// skipped silently.
async function buildCharacterElements(charactersInScene) {
  if (!Array.isArray(charactersInScene) || !charactersInScene.length) return [];
  const out = [];
  for (const name of charactersInScene) {
    if (!name) continue;
    let character;
    try {
      character = await getCharacter(name);
    } catch (e) {
      logger.warn(`fal video gen: getCharacter("${name}") threw: ${e.message}`);
      continue;
    }
    if (!character) continue;
    const sheetIds = Array.isArray(character.character_sheet_image_ids)
      ? character.character_sheet_image_ids
      : [];
    if (!sheetIds.length) continue;
    const [first, ...rest] = sheetIds;
    const frontalUrl = await loadAndUploadImage(first, `${name}-sheet-0.png`);
    if (!frontalUrl) continue;
    const referenceUrls = [];
    for (let i = 0; i < rest.length; i++) {
      const url = await loadAndUploadImage(rest[i], `${name}-sheet-${i + 1}.png`);
      if (url) referenceUrls.push(url);
    }
    out.push({ frontalUrl, referenceUrls });
  }
  return out;
}

async function buildReferenceImageUrls(referenceImageIds) {
  if (!Array.isArray(referenceImageIds) || !referenceImageIds.length) return [];
  const out = [];
  for (let i = 0; i < referenceImageIds.length; i++) {
    const url = await loadAndUploadImage(referenceImageIds[i], `reference-${i}.png`);
    if (url) out.push(url);
  }
  return out;
}

async function runVideoGenerationJob({
  job,
  storyboard,
  model,
  prompt,
  durationSeconds,
  generateAudio,
}) {
  try {
    setStep(job, 'preparing', 'Preparing inputs');

    // 1. Resolve which inputs this model actually needs, so we don't waste
    //    bytes uploading frames a model ignores.
    const needs = model.inputs;
    const wants = (key) => needs[key] && needs[key] !== 'unused';

    setStep(job, 'uploading', 'Uploading inputs to fal storage');
    const [
      startFrameUrl,
      endFrameUrl,
      characterSheetUrl,
      audioUrl,
    ] = await Promise.all([
      wants('startFrame') ? loadAndUploadImage(storyboard.start_frame_id, 'start.png') : null,
      wants('endFrame') ? loadAndUploadImage(storyboard.end_frame_id, 'end.png') : null,
      wants('characterSheet') ? loadAndUploadImage(storyboard.character_sheet_image_id, 'sheet.png') : null,
      wants('audio') ? loadAndUploadAttachment(storyboard.audio_file_id, 'audio.bin') : null,
    ]);

    const characterElements = wants('characterElements')
      ? await buildCharacterElements(storyboard.characters_in_scene)
      : [];
    let referenceImageUrls = [];
    if (wants('referenceImages')) {
      const explicitIds = Array.isArray(storyboard.reference_image_ids)
        ? storyboard.reference_image_ids
        : [];
      if (explicitIds.length) {
        referenceImageUrls = await buildReferenceImageUrls(explicitIds);
      } else {
        const fallbackIds = [
          storyboard.start_frame_id,
          storyboard.character_sheet_image_id,
        ].filter(Boolean);
        if (fallbackIds.length) {
          logger.info(
            `fal video gen: ${model.id} requires reference images but none attached; falling back to start_frame/character_sheet (${fallbackIds.length} image${fallbackIds.length === 1 ? '' : 's'}).`,
          );
        }
        referenceImageUrls = await buildReferenceImageUrls(fallbackIds);
      }
    }

    // 2. Build the model-specific input from the unified bundle.
    const bundle = {
      prompt: buildPrompt({ override: prompt, storyboard }),
      startFrameUrl,
      endFrameUrl,
      characterSheetUrl,
      audioUrl,
      characterElements,
      referenceImageUrls,
      durationSeconds: pickDurationSeconds({ requested: durationSeconds, storyboard, model }),
      generateAudio: model.supportsGenerateAudio ? Boolean(generateAudio) : false,
    };
    const input = model.buildInput(bundle);

    // 3. Submit to fal's queue. We use submit + subscribeToStatus rather
    //    than fal.subscribe so we can capture the request_id for telemetry
    //    and so the in-memory snapshot has it for reconnects.
    setStep(job, 'submitting', `Submitting to ${model.label}`);
    const submission = await fal.queue.submit(model.falModel, { input });
    job.request_id = submission.request_id;
    logger.info(
      `fal video gen submit job=${job.job_id} model=${model.falModel} request_id=${submission.request_id}`,
    );

    // 4. Subscribe to status. Each update writes back into the job and
    //    fans out to listeners. subscribeToStatus resolves on terminal
    //    status (COMPLETED). Any non-terminal error rejects.
    await fal.queue.subscribeToStatus(model.falModel, {
      requestId: submission.request_id,
      logs: true,
      onQueueUpdate: (update) => {
        applyQueueUpdate(job, update);
        publish(job);
      },
    });

    // 5. Pull the result and extract the video URL.
    setStep(job, 'downloading', 'Downloading rendered video');
    const result = await fal.queue.result(model.falModel, {
      requestId: submission.request_id,
    });
    const data = result?.data || result;
    const videoUrl = model.extractVideoUrl(data);
    if (!videoUrl) {
      throw new Error(
        `fal returned no video URL in result.data: ${JSON.stringify(data).slice(0, 500)}`,
      );
    }

    const { buffer, contentType } = await fetchVideoBytes(videoUrl);

    // 6. Persist into GridFS attachments as a beat-owned video.
    setStep(job, 'persisting', 'Saving video');
    const file = await uploadAttachmentBuffer({
      buffer,
      filename: `storyboard-${storyboard._id}-video-${Date.now()}.mp4`,
      contentType: contentType || 'video/mp4',
      ownerType: 'beat',
      ownerId: storyboard.beat_id,
    });

    await setStoryboardVideoViaGateway({
      storyboardId: storyboard._id,
      videoFileId: file._id,
      durationSeconds: bundle.durationSeconds,
    });

    job.video_file_id = file._id.toString();
    job.finished_at = new Date();
    setStep(job, 'done', 'Done');
    logger.info(
      `fal video gen job ${job.job_id} done storyboard=${storyboard._id} request_id=${submission.request_id}`,
    );
  } catch (e) {
    job.status = 'error';
    job.error = e?.message || String(e);
    job.finished_at = new Date();
    publish(job);
    logger.warn(
      `fal video gen job ${job.job_id} failed: ${e?.message || e}` +
        (e?.status ? ` status=${e.status}` : '') +
        (e?.body ? ` body=${JSON.stringify(e.body).slice(0, 500)}` : '') +
        (e?.requestId ? ` request_id=${e.requestId}` : ''),
    );
  }
}

// fal's queue update has shape { status, queue_position, logs?: [{message,timestamp}] }.
// We mirror the relevant bits into our job snapshot.
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
    job.step = `Rendering on ${job.model_id}`;
  } else if (status === 'COMPLETED') {
    // The orchestrator handles the COMPLETED → 'downloading' → 'done'
    // transitions itself; we just record the queue exit here.
    job.queue_position = null;
  }
  if (Array.isArray(update?.logs) && update.logs.length) {
    const tail = update.logs.slice(-5).map((l) => ({
      message: String(l?.message || ''),
      timestamp: l?.timestamp || new Date().toISOString(),
    }));
    job.logs = (job.logs || []).concat(tail).slice(-50);
  }
}

async function fetchVideoBytes(videoUrl) {
  let res;
  try {
    res = await fetch(videoUrl);
  } catch (e) {
    throw new Error(`fal video download network error: ${e.message}`);
  }
  if (!res.ok) {
    throw new Error(`fal video download failed (${res.status})`);
  }
  const ct = res.headers.get('content-type') || 'video/mp4';
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: ct };
}

function buildPrompt({ override, storyboard }) {
  const raw =
    (typeof override === 'string' && override.trim()) ||
    stripMarkdown(storyboard.text_prompt || '').trim() ||
    'Cinematic shot.';
  const startDesc = stripMarkdown(storyboard.start_frame_description || '').trim();
  const lines = [raw];
  if (startDesc && raw.length + startDesc.length < 1800) {
    lines.push('', `Visual anchor: ${startDesc}`);
  }
  return lines.join('\n');
}

function pickDurationSeconds({ requested, storyboard, model }) {
  const candidate =
    Number.isFinite(Number(requested)) && Number(requested) > 0
      ? Number(requested)
      : Number.isFinite(Number(storyboard.duration_seconds)) &&
          Number(storyboard.duration_seconds) > 0
        ? Number(storyboard.duration_seconds)
        : Number(model.defaultDuration) || 5;
  // If the model lists allowed durations, snap to the nearest. The Kling
  // and Veo models accept string seconds in a fixed set; we normalize to
  // an integer in JS and let buildInput stringify per its conventions.
  if (Array.isArray(model.durations) && model.durations.length) {
    const allowed = model.durations.map((d) => Number(d)).filter(Number.isFinite);
    if (allowed.length) {
      let closest = allowed[0];
      let bestDelta = Math.abs(candidate - closest);
      for (const a of allowed) {
        const d = Math.abs(candidate - a);
        if (d < bestDelta) {
          bestDelta = d;
          closest = a;
        }
      }
      return closest;
    }
  }
  return Math.round(candidate);
}

// Exposed for tests that want to clear state between runs without
// spinning up the whole process.
export function _resetForTests() {
  jobs.clear();
  listeners.clear();
}
