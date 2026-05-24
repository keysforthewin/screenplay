// Downscale + re-encode oversized images before they're uploaded to fal.ai
// as model inputs.
//
// Why this exists: fal rejects input files over 10 MB (its file_too_large
// threshold is 10485760 bytes), and several model backends — notably
// bytedance/omnihuman — refuse an oversized input image with a generic
// `file_download_error` ("Failed to download the file...") even though the
// fal.media URL is perfectly public. Storyboard frames are routinely 4K PNGs
// (3840x2160, ~14 MB) that no video model can use — they all render at
// 720p/1080p — so feeding the full-resolution frame is both wasteful and
// triggers the failure.
//
// We resize the longest edge down to MAX_DIM and re-encode when an image is
// over the byte ceiling OR the dimension cap; images already within limits
// are returned byte-for-byte (no quality loss, no needless work).

import sharp from 'sharp';
import { logger } from '../log.js';

// Longest-edge cap. 2048 comfortably exceeds any 1080p model's needs while
// keeping JPEG output far under fal's 10 MB ceiling.
const MAX_DIM = 2048;
// Re-encode trigger. Set below fal's 10 MB hard cap so we leave margin for
// content-type/transfer overhead.
const MAX_BYTES = 8 * 1024 * 1024;
const JPEG_QUALITY = 90;

// Returns { buffer, contentType }. When no transform is needed the input
// buffer is returned unchanged (same reference). Non-decodable buffers are
// passed through too — fal will validate them — so this never breaks the
// upload pipeline for an input sharp can't read.
export async function prepareImageForFal({ buffer, contentType }) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch (e) {
    logger.warn(
      `fal image prep: could not read image metadata (${e.message}); uploading as-is`,
    );
    return { buffer, contentType };
  }

  const width = meta.width || 0;
  const height = meta.height || 0;
  const overBytes = buffer.length > MAX_BYTES;
  const overDims = width > MAX_DIM || height > MAX_DIM;
  if (!overBytes && !overDims) {
    return { buffer, contentType };
  }

  const resize = (img) =>
    img.rotate().resize({
      width: MAX_DIM,
      height: MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    });

  // Keep PNG (lossless, preserves transparency) for images with an alpha
  // channel; everything else becomes JPEG, which is dramatically smaller for
  // photographic frames.
  if (meta.hasAlpha) {
    const png = await resize(sharp(buffer)).png({ compressionLevel: 9 }).toBuffer();
    if (png.length <= MAX_BYTES) {
      return { buffer: png, contentType: 'image/png' };
    }
    // A resized PNG that's still over the ceiling (extreme detail/noise):
    // flatten onto white and ship JPEG so we're guaranteed under the limit.
    const jpeg = await resize(sharp(buffer))
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { buffer: jpeg, contentType: 'image/jpeg' };
  }

  const jpeg = await resize(sharp(buffer))
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return { buffer: jpeg, contentType: 'image/jpeg' };
}

// fal's served filename should carry an extension matching the content type
// we actually upload — some model backends sniff the URL extension. Swaps the
// extension on a base name (e.g. 'start.png' + 'image/jpeg' -> 'start.jpg').
export function extForContentType(contentType) {
  switch (String(contentType || '').toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

export function renameForContentType(name, contentType) {
  const ext = extForContentType(contentType);
  const base = String(name || 'asset').replace(/\.[^./\\]+$/, '');
  return `${base}.${ext}`;
}
