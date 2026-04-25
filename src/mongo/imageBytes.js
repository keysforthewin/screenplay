import { ObjectId } from 'mongodb';
import path from 'node:path';

export const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function extensionForType(contentType) {
  return EXT_BY_TYPE[contentType] || 'bin';
}

export function detectImageType(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function deriveImageFilename(sourceUrl, contentType) {
  try {
    const u = new URL(sourceUrl);
    const base = path.basename(u.pathname);
    if (base && base !== '/' && /\.[a-z0-9]+$/i.test(base)) return base;
  } catch {
    // fall through
  }
  return `image.${extensionForType(contentType)}`;
}

export function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  return new ObjectId(String(id));
}

export async function fetchImageFromUrl(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(`Invalid URL: ${sourceUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Failed to download image (${res.status} ${res.statusText})`);
  const declared = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large: ${buffer.length} bytes (max ${MAX_IMAGE_BYTES})`);
  }
  const sniffed = detectImageType(buffer);
  const contentType = ALLOWED_IMAGE_TYPES.has(declared) ? declared : sniffed;
  if (!contentType) {
    throw new Error(`Could not determine image type (declared: ${declared || 'none'})`);
  }
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error(`Unsupported image type: ${contentType}`);
  }
  if (sniffed && sniffed !== contentType) {
    throw new Error(`Image content does not match declared type (declared ${contentType}, actual ${sniffed})`);
  }
  return { buffer, contentType };
}

export function validateImageBuffer(buffer) {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large: ${buffer.length} bytes (max ${MAX_IMAGE_BYTES})`);
  }
  const sniffed = detectImageType(buffer);
  if (!sniffed || !ALLOWED_IMAGE_TYPES.has(sniffed)) {
    throw new Error('Unsupported or unrecognized image bytes');
  }
  return sniffed;
}
