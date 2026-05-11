// Alibaba Wan 2.7 image-to-video on DashScope.
//
// Submit / poll / download against the asynchronous video-synthesis surface:
//
//   POST {baseUrl}/api/v1/services/aigc/video-generation/video-synthesis
//        Authorization: Bearer ${apiKey}
//        X-DashScope-Async: enable
//        body: { model, input, parameters }
//        → { output: { task_status: "PENDING", task_id: "..." } }
//
//   GET  {baseUrl}/api/v1/tasks/{task_id}
//        Authorization: Bearer ${apiKey}
//        → { output: { task_status, video_url?, ... }, usage? }
//
// The wan2.7-i2v mode accepts a start frame URL, an optional end frame URL, an
// optional reference image URL (character sheet for likeness lock), and an
// optional audio URL (drives lip-sync / cadence). Input URLs must be publicly
// fetchable from Alibaba's servers — we shovel GridFS bytes through OSS and
// hand back signed URLs in src/wan/ossUpload.js.
//
// Graceful-missing-key pattern: callers should check `isConfigured()` first;
// the submit/poll/download helpers throw a user-readable Error when the key
// is missing so the orchestrator can surface it to the SPA without crashing.

import { config } from '../config.js';
import { logger } from '../log.js';

const MISSING_KEY_ERR =
  'DashScope API key not configured. Set DASHSCOPE_API_KEY in your env to enable Wan 2.7 video generation.';

export function isConfigured() {
  return Boolean(config.wan.apiKey);
}

function authHeaders() {
  if (!config.wan.apiKey) throw new Error(MISSING_KEY_ERR);
  return {
    Authorization: `Bearer ${config.wan.apiKey}`,
    'Content-Type': 'application/json',
  };
}

function submitUrl() {
  return `${config.wan.baseUrl.replace(/\/$/, '')}/api/v1/services/aigc/video-generation/video-synthesis`;
}

function taskUrl(taskId) {
  return `${config.wan.baseUrl.replace(/\/$/, '')}/api/v1/tasks/${encodeURIComponent(taskId)}`;
}

// Submit an image-to-video task. Returns { task_id }.
//
// Required: firstFrameUrl. Optional but recommended for this app's flow:
// lastFrameUrl (end frame), refImageUrl (character sheet for likeness),
// audioUrl (drives lip-sync). Wan accepts plain HTTP(S) URLs; the upstream
// server must be able to fetch them (no LAN / private hosts).
export async function submitImageToVideo({
  prompt,
  firstFrameUrl,
  lastFrameUrl = null,
  refImageUrl = null,
  audioUrl = null,
  durationSeconds = null,
  resolution = null,
  negativePrompt = null,
  seed = null,
  promptExtend = true,
} = {}) {
  if (!firstFrameUrl) throw new Error('firstFrameUrl is required.');
  const input = {
    prompt: String(prompt || '').trim(),
    first_frame_url: firstFrameUrl,
  };
  if (lastFrameUrl) input.last_frame_url = lastFrameUrl;
  if (refImageUrl) input.ref_image_url = refImageUrl;
  if (audioUrl) input.audio_url = audioUrl;
  if (negativePrompt) input.negative_prompt = String(negativePrompt);

  const parameters = {};
  if (resolution) parameters.resolution = resolution;
  if (durationSeconds != null && Number.isFinite(Number(durationSeconds))) {
    parameters.duration = Number(durationSeconds);
  }
  if (seed != null && Number.isFinite(Number(seed))) parameters.seed = Number(seed);
  if (promptExtend != null) parameters.prompt_extend = Boolean(promptExtend);

  const body = {
    model: config.wan.model,
    input,
    parameters,
  };

  const headers = { ...authHeaders(), 'X-DashScope-Async': 'enable' };
  const t0 = Date.now();
  logger.info(
    `wan → submit model=${config.wan.model} firstFrame=${truncUrl(firstFrameUrl)} lastFrame=${lastFrameUrl ? truncUrl(lastFrameUrl) : '-'} ref=${refImageUrl ? truncUrl(refImageUrl) : '-'} audio=${audioUrl ? truncUrl(audioUrl) : '-'} dur=${parameters.duration || '-'}s res=${parameters.resolution || '-'}`,
  );
  let res;
  try {
    res = await fetch(submitUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Wan submit network error: ${e.message}`);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Wan submit returned non-JSON (status ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    const apiMsg = parsed?.message || parsed?.error?.message || text.slice(0, 500);
    throw new Error(`Wan submit failed (${res.status}): ${apiMsg}`);
  }
  const taskId = parsed?.output?.task_id;
  if (!taskId) {
    throw new Error(`Wan submit succeeded but returned no task_id: ${text.slice(0, 500)}`);
  }
  logger.info(`wan ← task_id=${taskId} status=${parsed?.output?.task_status || '?'} ${Date.now() - t0}ms`);
  return { task_id: taskId, raw: parsed };
}

// Poll a single task. Returns { status, video_url?, error_message?, raw }.
// Status values per DashScope: PENDING | RUNNING | SUCCEEDED | FAILED |
// CANCELED | UNKNOWN.
export async function getTask(taskId) {
  if (!taskId) throw new Error('taskId required');
  const headers = authHeaders();
  let res;
  try {
    res = await fetch(taskUrl(taskId), { headers });
  } catch (e) {
    throw new Error(`Wan poll network error: ${e.message}`);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Wan poll returned non-JSON (status ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    const apiMsg = parsed?.message || parsed?.error?.message || text.slice(0, 500);
    throw new Error(`Wan poll failed (${res.status}): ${apiMsg}`);
  }
  const out = parsed?.output || {};
  return {
    status: out.task_status || 'UNKNOWN',
    video_url: out.video_url || null,
    error_message: out.message || parsed?.message || null,
    submit_time: out.submit_time || null,
    end_time: out.end_time || null,
    raw: parsed,
  };
}

// Download a video URL into a Buffer. Wan output URLs are short-lived signed
// OSS links (24h), so we always copy the bytes into our own GridFS rather
// than relying on the URL surviving.
export async function downloadVideo(videoUrl) {
  if (!videoUrl) throw new Error('videoUrl required');
  let res;
  try {
    res = await fetch(videoUrl);
  } catch (e) {
    throw new Error(`Wan video download network error: ${e.message}`);
  }
  if (!res.ok) {
    throw new Error(`Wan video download failed (${res.status})`);
  }
  const ct = res.headers.get('content-type') || 'video/mp4';
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: ct };
}

function truncUrl(url) {
  if (typeof url !== 'string') return '?';
  return url.length > 80 ? `${url.slice(0, 80)}…` : url;
}
