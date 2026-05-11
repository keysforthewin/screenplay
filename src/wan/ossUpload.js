// Aliyun OSS helper for Wan video generation.
//
// Wan's DashScope API only accepts public URLs for input images and audio
// (image bytes / data URIs aren't a documented input mode for wan2.7-i2v).
// Our images and audio live in private GridFS, so before submitting we
// upload the four inputs to an OSS bucket and hand back short-lived signed
// URLs that Wan's servers can fetch.
//
// We never reuse keys — every upload gets a fresh random key under
// `wan-inputs/<yyyymmdd>/<uuid>.<ext>` so collisions are impossible and
// signed URLs from past runs never accidentally surface a new file's bytes.
//
// The bucket is assumed to be in a region that DashScope can reach (any
// public OSS region works). Lifecycle rules on the bucket should clean
// these keys up — we generate URLs that expire after 30 min by default but
// the objects themselves persist until the bucket policy removes them.
//
// Graceful-missing-key pattern: each export throws a user-readable Error if
// any of the four required env vars is missing, so the orchestrator's
// caller can surface the message to the SPA without crashing.

import { randomUUID } from 'node:crypto';
import OSS from 'ali-oss';
import { config } from '../config.js';
import { logger } from '../log.js';

let _client = null;
function getClient() {
  if (_client) return _client;
  const { accessKeyId, accessKeySecret, bucket, region } = config.aliyunOss;
  if (!accessKeyId || !accessKeySecret || !bucket || !region) {
    const missing = [
      !accessKeyId && 'ALIYUN_OSS_ACCESS_KEY_ID',
      !accessKeySecret && 'ALIYUN_OSS_ACCESS_KEY_SECRET',
      !bucket && 'ALIYUN_OSS_BUCKET',
      !region && 'ALIYUN_OSS_REGION',
    ]
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `Aliyun OSS is not configured (missing ${missing}). Set these env vars to enable Wan 2.7 video generation.`,
    );
  }
  _client = new OSS({ accessKeyId, accessKeySecret, bucket, region });
  return _client;
}

export function isConfigured() {
  const { accessKeyId, accessKeySecret, bucket, region } = config.aliyunOss;
  return Boolean(accessKeyId && accessKeySecret && bucket && region);
}

function extFor(contentType) {
  if (!contentType) return 'bin';
  const ct = String(contentType).toLowerCase();
  if (ct.startsWith('image/png')) return 'png';
  if (ct.startsWith('image/jpeg') || ct.startsWith('image/jpg')) return 'jpg';
  if (ct.startsWith('image/webp')) return 'webp';
  if (ct.startsWith('image/bmp')) return 'bmp';
  if (ct.startsWith('audio/wav') || ct.startsWith('audio/wave') || ct.startsWith('audio/x-wav')) {
    return 'wav';
  }
  if (ct.startsWith('audio/mpeg') || ct.startsWith('audio/mp3')) return 'mp3';
  if (ct.startsWith('audio/mp4') || ct.startsWith('audio/m4a') || ct.startsWith('audio/aac')) {
    return 'm4a';
  }
  if (ct.startsWith('audio/webm')) return 'webm';
  if (ct.startsWith('audio/ogg')) return 'ogg';
  if (ct.startsWith('video/mp4')) return 'mp4';
  return 'bin';
}

function todayPrefix() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

// Upload a Buffer to OSS and return a public signed URL.
//
// Args:
//   buffer       — raw bytes
//   contentType  — used to pick a sensible extension on the OSS key and as
//                  the object's Content-Type so Wan's fetcher reads the
//                  right mime back.
//   keyPrefix    — optional logical subfolder (e.g. "start-frame"); the
//                  final OSS key is `wan-inputs/<yyyymmdd>/<keyPrefix>-<uuid>.<ext>`.
//   expiresSeconds — override the default signed-URL TTL.
//
// Returns: { publicUrl, key }.
export async function uploadBuffer({
  buffer,
  contentType,
  keyPrefix = '',
  expiresSeconds = null,
} = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('uploadBuffer: buffer (Buffer) is required');
  }
  if (!buffer.length) {
    throw new Error('uploadBuffer: buffer is empty');
  }
  const client = getClient();
  const ext = extFor(contentType);
  const prefix = keyPrefix ? `${keyPrefix}-` : '';
  const key = `wan-inputs/${todayPrefix()}/${prefix}${randomUUID()}.${ext}`;
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  const t0 = Date.now();
  try {
    await client.put(key, buffer, { headers });
  } catch (e) {
    throw new Error(`OSS upload failed (${key}): ${e.message}`);
  }
  const expires =
    expiresSeconds != null
      ? Number(expiresSeconds)
      : config.aliyunOss.signedUrlExpiresSeconds;
  const publicUrl = client.signatureUrl(key, { expires, method: 'GET' });
  logger.info(
    `wan oss → key=${key} bytes=${buffer.length} ct=${contentType || '?'} ${Date.now() - t0}ms`,
  );
  return { publicUrl, key };
}

// Best-effort cleanup of keys we created during a single video-gen run. Wan
// has already pulled the bytes by the time we call this; failures are
// logged-not-thrown so a stuck cleanup doesn't fail the user's video.
export async function deleteKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  if (!isConfigured()) return;
  let client;
  try {
    client = getClient();
  } catch {
    return;
  }
  for (const key of keys) {
    if (!key) continue;
    try {
      await client.delete(key);
    } catch (e) {
      logger.warn(`wan oss delete ${key} failed: ${e.message}`);
    }
  }
}
