import { ObjectId } from 'mongodb';
import path from 'node:path';
import { USER_AGENT } from './imageBytes.js';

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  return new ObjectId(String(id));
}

export function deriveAttachmentFilename(sourceUrl, contentType) {
  try {
    const u = new URL(sourceUrl);
    const base = path.basename(u.pathname);
    if (base && base !== '/' && /\.[a-z0-9]+$/i.test(base)) return base;
  } catch {
    // fall through
  }
  const ext = extensionForType(contentType);
  return `attachment.${ext}`;
}

function extensionForType(contentType) {
  if (!contentType) return 'bin';
  const ct = String(contentType).toLowerCase();
  const slash = ct.indexOf('/');
  if (slash < 0) return 'bin';
  const sub = ct.slice(slash + 1).split(/[;+]/, 1)[0].trim();
  if (!sub || /[^a-z0-9.-]/.test(sub)) return 'bin';
  return sub;
}

export async function fetchAttachmentFromUrl(sourceUrl, hintedContentType = null) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(`Invalid URL: ${sourceUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  const res = await fetch(sourceUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Failed to download file (${res.status} ${res.statusText})`);
  }
  const declared = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('Downloaded file is empty (0 bytes).');
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `File too large: ${buffer.length} bytes (max ${MAX_ATTACHMENT_BYTES}).`,
    );
  }
  const contentType =
    (hintedContentType && String(hintedContentType).trim()) ||
    declared ||
    'application/octet-stream';
  return { buffer, contentType, size: buffer.length };
}
