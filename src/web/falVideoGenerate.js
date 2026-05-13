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
//      after config.fal.storageLifetimeDays (default 7). Only images
//      explicitly attached to the storyboard row (start_frame_id,
//      end_frame_id, character_sheet_image_id, reference_image_ids[]) are
//      ever uploaded — we never auto-pull character sheets by name or
//      reuse one slot's image as another slot's input.
//   3. fal.queue.submit → request_id.
//   4. fal.queue.subscribeToStatus emits IN_QUEUE / IN_PROGRESS / COMPLETED
//      callbacks; each callback fans out to the SSE listeners for this job
//      AND updates the persisted-in-memory job snapshot (for reconnects).
//   5. fal.queue.result → the model entry's extractVideoUrl picks the
//      output URL.
//   6. Download the MP4 bytes; persist into GridFS attachments bucket as a
//      beat-owned attachment, tagged metadata.kind='video' and
//      metadata.generated_by=<fal model id>.
//   7. setStoryboardVideoViaGateway() — the gateway broadcasts a
//      fields_updated ping so the connected SPA renders the new video.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { findImageFile, readImageBuffer } from '../mongo/images.js';
import {
  findAttachmentFile,
  readAttachmentBuffer,
  uploadAttachmentBuffer,
} from '../mongo/attachments.js';
import { getStoryboard as mongoGetStoryboard } from '../mongo/storyboards.js';
import { stripMarkdown } from '../util/markdown.js';
import { setStoryboardVideoViaGateway } from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { fal, isConfigured as falIsConfigured } from '../fal/client.js';
import { uploadFalAsset } from '../fal/upload.js';
import {
  getVideoModelOrCatalog,
  getVideoModelCatalogMeta,
  validateStoryboardInputs,
} from '../fal/videoModels.js';
import { estimateRegisteredCost, estimateCatalogCost } from '../fal/videoPricing.js';

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
    estimated_cost_usd: job.estimated_cost_usd ?? null,
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
  resolution = null,
  fps = null,
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
      resolution,
      fps,
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

async function buildReferenceImageUrls(referenceImageIds) {
  if (!Array.isArray(referenceImageIds) || !referenceImageIds.length) return [];
  const out = [];
  for (let i = 0; i < referenceImageIds.length; i++) {
    const url = await loadAndUploadImage(referenceImageIds[i], `reference-${i}.png`);
    if (url) out.push(url);
  }
  return out;
}

// Sentinel URL scheme used by the preview path in place of real fal.media URLs.
// The SPA recognises these and renders the matching image/audio thumbnail
// inline next to the JSON payload preview, so the user can see exactly which
// asset will go out as each input field. The scheme is intentionally not a
// real URL — fal would reject it — so any code path that submits a preview
// payload by mistake will fail loudly instead of silently shipping the wrong
// thing.
const PREVIEW_IMAGE_SCHEME = 'screenplay-preview://image/';
const PREVIEW_ATTACHMENT_SCHEME = 'screenplay-preview://attachment/';

function previewImageUrl(id) {
  return id ? `${PREVIEW_IMAGE_SCHEME}${String(id)}` : null;
}
function previewAttachmentUrl(id) {
  return id ? `${PREVIEW_ATTACHMENT_SCHEME}${String(id)}` : null;
}

async function describeImageInput({ slot, imageId, name }) {
  if (!imageId) return null;
  const file = await findImageFile(imageId);
  if (!file) {
    return {
      slot,
      kind: 'image',
      image_id: String(imageId),
      filename: null,
      content_type: null,
      size: null,
      missing: true,
      sentinel: previewImageUrl(imageId),
      name_for_fal: name,
    };
  }
  return {
    slot,
    kind: 'image',
    image_id: String(file._id),
    filename: file.filename || null,
    content_type:
      file.contentType || file.metadata?.content_type || null,
    size: typeof file.length === 'number' ? file.length : null,
    sentinel: previewImageUrl(file._id),
    name_for_fal: name,
  };
}

async function describeAttachmentInput({ slot, attachmentId, name }) {
  if (!attachmentId) return null;
  const file = await findAttachmentFile(attachmentId);
  if (!file) {
    return {
      slot,
      kind: 'attachment',
      attachment_id: String(attachmentId),
      filename: null,
      content_type: null,
      size: null,
      missing: true,
      sentinel: previewAttachmentUrl(attachmentId),
      name_for_fal: name,
    };
  }
  return {
    slot,
    kind: 'attachment',
    attachment_id: String(file._id),
    filename: file.filename || null,
    content_type:
      file.contentType || file.metadata?.content_type || null,
    size: typeof file.length === 'number' ? file.length : null,
    sentinel: previewAttachmentUrl(file._id),
    name_for_fal: name,
  };
}

// Build a preview of the exact payload the orchestrator would send to
// fal.ai, WITHOUT uploading anything to fal storage. Every image/audio URL
// in the payload is replaced with a screenplay-preview:// sentinel so the
// SPA can render the matching thumbnail next to the field. The user must
// approve this preview before startVideoGenerationJob() is called for real.
//
// Returns:
//   {
//     model: { id, label, fal_model, description, supports_generate_audio,
//              inputs, durations, default_duration },
//     prompt: <final prompt string after override + visual anchor + cap>,
//     duration_seconds: <integer chosen for this submit>,
//     generate_audio: <boolean>,
//     inputs: [
//       { slot, kind, image_id|attachment_id, filename, content_type, size,
//         sentinel, name_for_fal, missing? },
//       ...
//     ],
//     payload: <object that would be passed as fal.queue.submit input>,
//     warnings: string[],
//   }
//
// Throws the same FalNotConfiguredError / UnknownVideoModelError /
// MissingInputsError the real submit path throws so the route can return
// matching status codes.
export async function buildVideoPayloadPreview({
  storyboardId,
  modelId = null,
  prompt = null,
  durationSeconds = null,
  generateAudio = true,
  resolution = null,
  fps = null,
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

  const needs = model.inputs;
  const wants = (key) => needs[key] && needs[key] !== 'unused';

  const warnings = [];
  const inputs = [];

  if (wants('startFrame')) {
    const desc = await describeImageInput({
      slot: 'startFrame',
      imageId: sb.start_frame_id,
      name: 'start.png',
    });
    if (desc) inputs.push(desc);
  }
  if (wants('endFrame')) {
    const desc = await describeImageInput({
      slot: 'endFrame',
      imageId: sb.end_frame_id,
      name: 'end.png',
    });
    if (desc) inputs.push(desc);
  }
  if (wants('characterSheet')) {
    const desc = await describeImageInput({
      slot: 'characterSheet',
      imageId: sb.character_sheet_image_id,
      name: 'sheet.png',
    });
    if (desc) inputs.push(desc);
  }
  if (wants('audio')) {
    const desc = await describeAttachmentInput({
      slot: 'audio',
      attachmentId: sb.audio_file_id,
      name: 'audio.bin',
    });
    if (desc) inputs.push(desc);
  }
  if (wants('referenceImages')) {
    const ids = Array.isArray(sb.reference_image_ids) ? sb.reference_image_ids : [];
    for (let i = 0; i < ids.length; i++) {
      const desc = await describeImageInput({
        slot: 'referenceImages',
        imageId: ids[i],
        name: `reference-${i}.png`,
      });
      if (desc) inputs.push(desc);
    }
  }

  for (const i of inputs) {
    if (i.missing) {
      warnings.push(
        `${i.slot} ${i.kind} ${i.image_id || i.attachment_id} is missing from storage — fal would fail when fetching it.`,
      );
    }
  }

  const finalPrompt = buildPrompt({ override: prompt, storyboard: sb });
  const finalDuration = pickDurationSeconds({
    requested: durationSeconds,
    storyboard: sb,
    model,
  });
  const finalGenerateAudio = model.supportsGenerateAudio
    ? Boolean(generateAudio)
    : false;

  const bundle = {
    prompt: finalPrompt,
    startFrameUrl: previewImageUrl(sb.start_frame_id),
    endFrameUrl: previewImageUrl(sb.end_frame_id),
    characterSheetUrl: previewImageUrl(sb.character_sheet_image_id),
    audioUrl: previewAttachmentUrl(sb.audio_file_id),
    referenceImageUrls: (sb.reference_image_ids || [])
      .map((id) => previewImageUrl(id))
      .filter(Boolean),
    durationSeconds: finalDuration,
    generateAudio: finalGenerateAudio,
    resolution: resolution || null,
    fps: Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : null,
    audioDurationSeconds:
      typeof sb.audio_duration_seconds === 'number' &&
      Number.isFinite(sb.audio_duration_seconds) &&
      sb.audio_duration_seconds > 0
        ? sb.audio_duration_seconds
        : null,
  };

  // model.buildInput synthesises only from the bundle — there's no hidden
  // I/O — so we get the EXACT object the orchestrator would submit, but
  // with sentinel URLs in every image/audio slot.
  let payload;
  try {
    payload = model.buildInput(bundle);
  } catch (e) {
    throw new Error(`buildInput failed for model ${model.id}: ${e.message}`);
  }

  // Look up release metadata (lab/family/added_at) plus best-effort
  // pricing for catalog-only models. Cheap (one JSON parse) and surfaces
  // the same data the inline panel will show after the video lands.
  const catalogMeta = await getVideoModelCatalogMeta(model.falModel || model.id);
  const cost = computeCost({
    model,
    bundle,
    payload,
    catalogRow: catalogMeta
      ? {
          price_text: catalogMeta.pricing?.note || null,
          ...catalogMeta,
        }
      : null,
  });
  const parameters = buildPersistedParameters({
    bundle,
    payload,
    audioDurationSeconds: bundle.audioDurationSeconds,
  });

  return {
    model: {
      id: model.id,
      label: model.label,
      fal_model: model.falModel,
      description: model.description || null,
      supports_generate_audio: Boolean(model.supportsGenerateAudio),
      inputs: model.inputs,
      durations: Array.isArray(model.durations) ? model.durations : [],
      default_duration: model.defaultDuration ?? null,
      pricing_id: model.pricingId || null,
      lab: catalogMeta?.model_lab || null,
      family: catalogMeta?.model_family || null,
      added_at: catalogMeta?.added_at || null,
    },
    prompt: finalPrompt,
    duration_seconds: finalDuration,
    generate_audio: finalGenerateAudio,
    inputs,
    payload,
    parameters,
    estimated_cost_usd: cost?.totalUsd ?? null,
    pricing_basis: cost?.basis ?? null,
    pricing_exact: cost?.exact ?? null,
    warnings,
  };
}

async function runVideoGenerationJob({
  job,
  storyboard,
  model,
  prompt,
  durationSeconds,
  generateAudio,
  resolution = null,
  fps = null,
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

    // Only images explicitly attached to the storyboard get uploaded. We don't
    // chase character documents by name from characters_in_scene, and we don't
    // fall back to start_frame / character_sheet when reference_image_ids is
    // empty — if the user wanted those as references they'd pin them.
    const referenceImageUrls = wants('referenceImages')
      ? await buildReferenceImageUrls(storyboard.reference_image_ids || [])
      : [];

    // 2. Build the model-specific input from the unified bundle.
    const bundle = {
      prompt: buildPrompt({ override: prompt, storyboard }),
      startFrameUrl,
      endFrameUrl,
      characterSheetUrl,
      audioUrl,
      referenceImageUrls,
      durationSeconds: pickDurationSeconds({ requested: durationSeconds, storyboard, model }),
      generateAudio: model.supportsGenerateAudio ? Boolean(generateAudio) : false,
      resolution: resolution || null,
      fps: Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : null,
      audioDurationSeconds:
        typeof storyboard.audio_duration_seconds === 'number' &&
        Number.isFinite(storyboard.audio_duration_seconds) &&
        storyboard.audio_duration_seconds > 0
          ? storyboard.audio_duration_seconds
          : null,
    };
    const input = model.buildInput(bundle);

    // Snapshot release metadata + cost while we have the model in hand.
    // catalogMeta may be null (no fal-models.json on disk, or this
    // endpoint isn't in the manifest) — we degrade to model.label only.
    const catalogMeta = await getVideoModelCatalogMeta(model.falModel || model.id);
    const cost = computeCost({
      model,
      bundle,
      payload: input,
      catalogRow: catalogMeta
        ? { ...catalogMeta, price_text: catalogMeta.pricing?.note || null }
        : null,
    });
    job.estimated_cost_usd = cost?.totalUsd ?? null;
    const persistedParameters = buildPersistedParameters({
      bundle,
      payload: input,
      audioDurationSeconds: bundle.audioDurationSeconds,
    });

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
      modelId: model.id,
      modelLabel: model.label,
      falModel: model.falModel,
      modelLab: catalogMeta?.model_lab || null,
      modelFamily: catalogMeta?.model_family || null,
      modelAddedAt: catalogMeta?.added_at || null,
      parameters: persistedParameters,
      costUsd: cost?.totalUsd ?? null,
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

// Build the `parameters` snapshot we persist on the storyboard. The
// caller hands in the bundle (what we'd pass to model.buildInput) AND
// the resulting payload (so resolution/aspect_ratio fields filled in by
// buildInput are captured). URLs and sentinel strings are stripped; we
// only keep small primitive values that describe HOW the model was
// invoked.
function buildPersistedParameters({ bundle, payload, audioDurationSeconds = null }) {
  const out = {};
  if (Number.isFinite(Number(bundle.durationSeconds))) {
    out.duration_seconds = Number(bundle.durationSeconds);
  }
  if (typeof bundle.generateAudio === 'boolean') {
    out.generate_audio = bundle.generateAudio;
  }
  if (payload && typeof payload === 'object') {
    if (typeof payload.resolution === 'string') out.resolution = payload.resolution;
    if (typeof payload.aspect_ratio === 'string') out.aspect_ratio = payload.aspect_ratio;
    if (typeof payload.video_size === 'string') out.video_size = payload.video_size;
    if (Number.isFinite(Number(payload.fps)) && Number(payload.fps) > 0) {
      out.fps = Number(payload.fps);
    }
    if (Number.isFinite(Number(payload.num_frames)) && Number(payload.num_frames) > 0) {
      out.num_frames = Number(payload.num_frames);
    }
  }
  if (Number.isFinite(Number(audioDurationSeconds)) && Number(audioDurationSeconds) > 0) {
    out.audio_duration_seconds = Number(audioDurationSeconds);
  }
  const prompt = typeof bundle.prompt === 'string' ? bundle.prompt : '';
  out.prompt_chars = prompt.length;
  if (prompt) {
    out.prompt_preview = prompt.length > 160 ? `${prompt.slice(0, 157)}…` : prompt;
  }
  return out;
}

// Compute the canonical cost estimate for a given bundle+payload. Tries
// the structured PRICING table first (model.pricingId), falls back to
// the catalog's regex-parsed price_text when no structured rate exists,
// returns null otherwise.
function computeCost({ model, bundle, payload, catalogRow }) {
  const lookup = {
    durationSeconds: bundle.durationSeconds,
    generateAudio: bundle.generateAudio,
    audioDurationSeconds: bundle.audioDurationSeconds ?? null,
    resolution: payload?.resolution || null,
  };
  if (model?.pricingId) {
    const est = estimateRegisteredCost(model.pricingId, lookup);
    if (est) return est;
  }
  if (catalogRow) {
    const est = estimateCatalogCost(catalogRow, lookup);
    if (est) return est;
  }
  return null;
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
