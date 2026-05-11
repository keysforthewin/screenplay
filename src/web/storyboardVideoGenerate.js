// Storyboard video generation pipeline (Alibaba Wan 2.7 image-to-video).
//
// Triggered from POST /api/storyboard/:id/video/generate. The request returns
// immediately with a job id; the work runs in the background under the
// per-beat lock so it can't race a storyboard regenerate / edit. The SPA polls
// GET /api/storyboard/:id/video-job/:jobId every ~2s and renders a smooth
// progress bar driven by a rolling-average duration estimate.
//
// Pipeline:
//   1. Validate the storyboard has all four inputs (start frame, end frame,
//      character sheet, audio).
//   2. Read each input from GridFS and upload to Aliyun OSS (Wan needs public
//      URLs — our /image and /attachment routes are session-gated).
//   3. Submit to Wan's wan2.7-i2v endpoint with the four signed URLs.
//   4. Poll the task endpoint every config.wan.pollIntervalMs until SUCCEEDED,
//      FAILED, or the overall timeout (config.wan.timeoutMs).
//   5. Download the resulting MP4 (Wan's signed URLs expire in 24h — we never
//      persist them).
//   6. Save into the attachments GridFS bucket as a beat-owned attachment,
//      tagged metadata.kind='video', metadata.generated_by='wan2.7-i2v'.
//   7. Update the storyboard's video_file_id via the gateway (broadcasts a
//      fields_updated ping so connected SPAs refresh).
//   8. Record the actual elapsed seconds into a rolling-average list so the
//      next run's ETA gets more accurate over time.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { readImageBuffer } from '../mongo/images.js';
import { readAttachmentBuffer, uploadAttachmentBuffer } from '../mongo/attachments.js';
import { getStoryboard as mongoGetStoryboard } from '../mongo/storyboards.js';
import { stripMarkdown } from '../util/markdown.js';
import { setStoryboardVideoViaGateway } from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import * as wanClient from '../wan/client.js';
import * as ossUpload from '../wan/ossUpload.js';

// Rolling average of recent end-to-end durations (seconds). Used to drive
// the SPA's progress bar. Starts empty; first run uses INITIAL_ESTIMATE.
const INITIAL_ESTIMATE_SECONDS = 180;
const recentDurationsSeconds = [];
const ROLLING_MAX = 10;

export function getEstimatedSeconds() {
  if (!recentDurationsSeconds.length) return INITIAL_ESTIMATE_SECONDS;
  const sum = recentDurationsSeconds.reduce((a, b) => a + b, 0);
  return Math.max(30, Math.round(sum / recentDurationsSeconds.length));
}

function recordDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  recentDurationsSeconds.push(seconds);
  if (recentDurationsSeconds.length > ROLLING_MAX) recentDurationsSeconds.shift();
}

// In-memory job registry. Sufficient for single-process runtime; jobs are
// lost on restart (matches existing storyboard-batch-gen). The SPA's polling
// loop tolerates "job not found" — user just kicks off another one.
const jobs = new Map();

function makeJobId() {
  return new ObjectId().toString();
}

export function getVideoGenerationJob(jobId) {
  return jobs.get(jobId) || null;
}

export class VideoBeatBusyError extends Error {
  constructor(beatId) {
    super(`Storyboard work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

export class MissingInputsError extends Error {
  constructor(missing) {
    super(
      `Cannot generate video — missing required inputs: ${missing.join(', ')}. ` +
        'Add a start frame, end frame, character sheet, and audio first.',
    );
    this.code = 'MISSING_INPUTS';
    this.missing = missing;
  }
}

export class WanNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.code = 'WAN_NOT_CONFIGURED';
  }
}

const TERMINAL_OK = new Set(['SUCCEEDED']);
const TERMINAL_FAIL = new Set(['FAILED', 'CANCELED', 'UNKNOWN']);

// Hooks for tests. Each defaults to the real module; tests override with
// fakes to assert the orchestrator's behavior without hitting Alibaba.
let _wanImpl = wanClient;
let _ossImpl = ossUpload;
export function _setWanImplForTests(impl) {
  _wanImpl = impl || wanClient;
}
export function _setOssImplForTests(impl) {
  _ossImpl = impl || ossUpload;
}

// Validate inputs + start the background job. Returns { job_id,
// estimated_seconds } so the SPA can prime its progress bar before the first
// poll lands.
export async function startVideoGenerationJob({
  storyboardId,
  prompt = null,
  durationSeconds = null,
  resolution = null,
} = {}) {
  if (!_wanImpl.isConfigured()) {
    throw new WanNotConfiguredError(
      'DashScope API key not configured. Set DASHSCOPE_API_KEY to enable Wan 2.7 video generation.',
    );
  }
  if (!_ossImpl.isConfigured()) {
    throw new WanNotConfiguredError(
      'Aliyun OSS is not configured. Set ALIYUN_OSS_ACCESS_KEY_ID, ALIYUN_OSS_ACCESS_KEY_SECRET, ALIYUN_OSS_BUCKET, and ALIYUN_OSS_REGION to enable Wan 2.7 video generation.',
    );
  }

  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);

  const missing = [];
  if (!sb.start_frame_id) missing.push('start frame');
  if (!sb.end_frame_id) missing.push('end frame');
  if (!sb.character_sheet_image_id) missing.push('character sheet');
  if (!sb.audio_file_id) missing.push('audio');
  if (missing.length) throw new MissingInputsError(missing);

  if (isBeatLocked(sb.beat_id)) {
    throw new VideoBeatBusyError(sb.beat_id.toString());
  }

  const jobId = makeJobId();
  const estimated = getEstimatedSeconds();
  const job = {
    job_id: jobId,
    storyboard_id: sb._id.toString(),
    beat_id: sb.beat_id.toString(),
    status: 'queued',
    step: 'Queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    estimated_seconds: estimated,
    task_id: null,
    video_file_id: null,
  };
  jobs.set(jobId, job);

  // Fire-and-forget under the beat lock. Errors are recorded on the job; we
  // catch here so the lock doesn't see an unhandled rejection.
  withBeatLock(sb.beat_id, () =>
    runVideoGenerationJob({
      job,
      storyboard: sb,
      prompt,
      durationSeconds,
      resolution,
    }),
  ).catch((e) => {
    if (job.status !== 'done' && job.status !== 'error') {
      job.status = 'error';
      job.error = e?.message || String(e);
      job.finished_at = new Date();
    }
    logger.error(`wan video gen job ${jobId} crashed: ${e?.message || e}`);
  });

  return { job_id: jobId, estimated_seconds: estimated };
}

async function runVideoGenerationJob({ job, storyboard, prompt, durationSeconds, resolution }) {
  const t0 = Date.now();
  const ossKeysToCleanup = [];
  try {
    // 1. Load all four inputs from GridFS in parallel.
    job.status = 'loading';
    job.step = 'Loading inputs';
    const [startFrame, endFrame, charSheet, audio] = await Promise.all([
      readImageBuffer(storyboard.start_frame_id),
      readImageBuffer(storyboard.end_frame_id),
      readImageBuffer(storyboard.character_sheet_image_id),
      readAttachmentBuffer(storyboard.audio_file_id),
    ]);
    if (!startFrame) throw new Error('Failed to read start frame from storage.');
    if (!endFrame) throw new Error('Failed to read end frame from storage.');
    if (!charSheet) throw new Error('Failed to read character sheet from storage.');
    if (!audio) throw new Error('Failed to read audio from storage.');

    const audioContentType =
      audio.file?.contentType || audio.file?.metadata?.content_type || 'audio/webm';

    // 2. Push each input through OSS so Wan's servers can fetch them.
    job.status = 'uploading';
    job.step = 'Uploading inputs to OSS';
    const [startUp, endUp, sheetUp, audioUp] = await Promise.all([
      _ossImpl.uploadBuffer({
        buffer: startFrame.buffer,
        contentType: startFrame.file.contentType || 'image/png',
        keyPrefix: 'start',
      }),
      _ossImpl.uploadBuffer({
        buffer: endFrame.buffer,
        contentType: endFrame.file.contentType || 'image/png',
        keyPrefix: 'end',
      }),
      _ossImpl.uploadBuffer({
        buffer: charSheet.buffer,
        contentType: charSheet.file.contentType || 'image/png',
        keyPrefix: 'sheet',
      }),
      _ossImpl.uploadBuffer({
        buffer: audio.buffer,
        contentType: audioContentType,
        keyPrefix: 'audio',
      }),
    ]);
    ossKeysToCleanup.push(startUp.key, endUp.key, sheetUp.key, audioUp.key);

    // 3. Build a prompt. Prefer the explicit override, then the row's
    //    text_prompt (markdown stripped), then a generic fallback. Wan caps
    //    prompts at 1500 chars.
    const promptText = buildPrompt({
      override: prompt,
      storyboard,
    });

    // 4. Submit. Use the SPA-supplied duration / resolution when set,
    //    otherwise the row's own duration_seconds, otherwise the configured
    //    default.
    job.status = 'submitting';
    job.step = 'Submitting to Wan 2.7';
    const submission = await _wanImpl.submitImageToVideo({
      prompt: promptText,
      firstFrameUrl: startUp.publicUrl,
      lastFrameUrl: endUp.publicUrl,
      refImageUrl: sheetUp.publicUrl,
      audioUrl: audioUp.publicUrl,
      durationSeconds:
        Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
          ? Number(durationSeconds)
          : Number.isFinite(Number(storyboard.duration_seconds)) && Number(storyboard.duration_seconds) > 0
            ? Number(storyboard.duration_seconds)
            : config.wan.defaultDurationSeconds,
      resolution: resolution || config.wan.defaultResolution,
    });
    job.task_id = submission.task_id;

    // 5. Poll until terminal.
    job.status = 'rendering';
    job.step = 'Wan is rendering the video';
    const videoUrl = await pollUntilDone({ taskId: submission.task_id, job });

    // 6. Download the MP4.
    job.status = 'downloading';
    job.step = 'Downloading rendered video';
    const { buffer: videoBuffer, contentType: videoContentType } =
      await _wanImpl.downloadVideo(videoUrl);
    if (!videoContentType.startsWith('video/')) {
      logger.warn(
        `wan: downloaded content-type "${videoContentType}" is not video/*; storing anyway`,
      );
    }

    // 7. Persist into GridFS as a beat-owned attachment.
    job.status = 'persisting';
    job.step = 'Saving video';
    const file = await uploadAttachmentBuffer({
      buffer: videoBuffer,
      filename: `storyboard-${storyboard._id}-video-${Date.now()}.mp4`,
      contentType: videoContentType || 'video/mp4',
      ownerType: 'beat',
      ownerId: storyboard.beat_id,
    });

    const elapsedSeconds = Math.round((Date.now() - t0) / 1000);
    const effectiveDuration =
      Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
        ? Number(durationSeconds)
        : Number.isFinite(Number(storyboard.duration_seconds)) && Number(storyboard.duration_seconds) > 0
          ? Number(storyboard.duration_seconds)
          : config.wan.defaultDurationSeconds;

    await setStoryboardVideoViaGateway({
      storyboardId: storyboard._id,
      videoFileId: file._id,
      durationSeconds: effectiveDuration,
    });

    recordDuration(elapsedSeconds);
    job.status = 'done';
    job.step = 'Done';
    job.video_file_id = file._id.toString();
    job.finished_at = new Date();
    logger.info(
      `wan video gen job ${job.job_id} done storyboard=${storyboard._id} elapsed=${elapsedSeconds}s task=${submission.task_id}`,
    );
  } catch (e) {
    job.status = 'error';
    job.error = e?.message || String(e);
    job.finished_at = new Date();
    logger.warn(`wan video gen job ${job.job_id} failed: ${e?.message || e}`);
  } finally {
    // Best-effort cleanup of OSS keys we created. Wan has already pulled the
    // bytes; this saves bucket space. Failures are logged-not-thrown.
    if (ossKeysToCleanup.length) {
      _ossImpl.deleteKeys(ossKeysToCleanup).catch(() => {});
    }
  }
}

async function pollUntilDone({ taskId, job }) {
  const startedAt = Date.now();
  const interval = config.wan.pollIntervalMs;
  const timeout = config.wan.timeoutMs;
  // Poll once immediately, then on interval. DashScope status starts at
  // PENDING and moves to RUNNING; both map to job.status='rendering'.
  while (true) {
    if (Date.now() - startedAt > timeout) {
      throw new Error(`Wan video generation timed out after ${Math.round(timeout / 1000)}s`);
    }
    let polled;
    try {
      polled = await _wanImpl.getTask(taskId);
    } catch (e) {
      // Transient poll errors should not kill the job — sleep and retry. If
      // it keeps failing, the overall timeout above ends the loop.
      logger.warn(`wan poll transient error: ${e.message}`);
      await sleep(interval);
      continue;
    }
    const status = String(polled.status || '').toUpperCase();
    if (TERMINAL_OK.has(status)) {
      if (!polled.video_url) {
        throw new Error('Wan reported SUCCEEDED but returned no video_url.');
      }
      return polled.video_url;
    }
    if (TERMINAL_FAIL.has(status) && status !== 'UNKNOWN') {
      throw new Error(`Wan reported ${status}${polled.error_message ? `: ${polled.error_message}` : ''}`);
    }
    // PENDING / RUNNING / UNKNOWN (transient): keep going. Update step text so
    // the SPA reflects what Wan thinks it's doing.
    if (status === 'PENDING') job.step = 'Queued at Wan';
    else if (status === 'RUNNING') job.step = 'Wan is rendering the video';
    await sleep(interval);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt({ override, storyboard }) {
  const raw =
    (typeof override === 'string' && override.trim()) ||
    stripMarkdown(storyboard.text_prompt || '').trim() ||
    'Cinematic shot.';
  const startDesc = stripMarkdown(storyboard.start_frame_description || '').trim();
  const lines = [raw];
  if (startDesc && raw.length + startDesc.length < 1400) {
    lines.push('', `Visual anchor: ${startDesc}`);
  }
  const joined = lines.join('\n');
  return joined.length > 1500 ? joined.slice(0, 1500) : joined;
}
