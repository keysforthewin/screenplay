// imageClient.js
//
// Thin client around POST /v1/images/generations using OpenAI's gpt-image-2.
// Plain fetch — one endpoint, no need to pull in the openai SDK.
//
// Mirrors the optional-integration pattern of src/gemini/client.js: callers
// gate on `config.openai.apiKey` themselves and surface a friendly error
// string to the user when it's missing. This module assumes the key is set.

import { config } from '../config.js';
import { logger } from '../log.js';
import { validateImageBuffer, extensionForType } from '../mongo/imageBytes.js';

export const GPT_IMAGE_MODEL = 'gpt-image-2';
const ENDPOINT = 'https://api.openai.com/v1/images/generations';
const EDIT_ENDPOINT = 'https://api.openai.com/v1/images/edits';
const DEFAULT_TIMEOUT_MS = 180_000;

const VALID_SIZES = new Set([
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
  'auto',
]);
const VALID_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);

export async function generateCharacterSheetImage({
  prompt,
  size = '1536x1024',
  quality = 'auto',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('generateCharacterSheetImage: `prompt` is required.');
  }
  if (!VALID_SIZES.has(size)) {
    throw new Error(`generateCharacterSheetImage: invalid size "${size}".`);
  }
  if (!VALID_QUALITIES.has(quality)) {
    throw new Error(`generateCharacterSheetImage: invalid quality "${quality}".`);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: GPT_IMAGE_MODEL,
        prompt,
        size,
        quality,
        n: 1,
      }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(
        `OpenAI image generation timed out after ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message || body;
    } catch {}
    logger.warn(`openai images: HTTP ${res.status} ${detail.slice(0, 300)}`);
    throw new Error(`OpenAI image generation failed (HTTP ${res.status}): ${detail}`);
  }

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('OpenAI image response missing b64_json payload.');
  }
  const buffer = Buffer.from(b64, 'base64');
  const contentType = validateImageBuffer(buffer);
  logger.info(
    `openai: ${GPT_IMAGE_MODEL} size=${size} quality=${quality} bytes=${buffer.length} ${latencyMs}ms`,
  );
  return { buffer, contentType, model: GPT_IMAGE_MODEL, latencyMs };
}

// images.edits — multipart POST that includes a reference image alongside the
// prompt. Used when the user wants the character's main image to seed the sheet
// generation. Mirrors generateCharacterSheetImage's response shape so the caller
// can treat the two interchangeably.
export async function generateCharacterSheetImageEdit({
  prompt,
  inputImage,
  size = '1536x1024',
  quality = 'auto',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('generateCharacterSheetImageEdit: `prompt` is required.');
  }
  if (!inputImage?.buffer || !inputImage?.contentType) {
    throw new Error('generateCharacterSheetImageEdit: `inputImage` is required.');
  }
  if (!VALID_SIZES.has(size)) {
    throw new Error(`generateCharacterSheetImageEdit: invalid size "${size}".`);
  }
  if (!VALID_QUALITIES.has(quality)) {
    throw new Error(`generateCharacterSheetImageEdit: invalid quality "${quality}".`);
  }

  const fd = new FormData();
  fd.append('model', GPT_IMAGE_MODEL);
  fd.append('prompt', prompt);
  fd.append(
    'image[]',
    new Blob([inputImage.buffer], { type: inputImage.contentType }),
    `main.${extensionForType(inputImage.contentType)}`,
  );
  fd.append('size', size);
  fd.append('quality', quality);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(EDIT_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
      body: fd,
      signal: ac.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(
        `OpenAI image edit timed out after ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message || body;
    } catch {}
    logger.warn(`openai images.edits: HTTP ${res.status} ${detail.slice(0, 300)}`);
    throw new Error(`OpenAI image edit failed (HTTP ${res.status}): ${detail}`);
  }

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('OpenAI image edit response missing b64_json payload.');
  }
  const buffer = Buffer.from(b64, 'base64');
  const contentType = validateImageBuffer(buffer);
  logger.info(
    `openai edit: ${GPT_IMAGE_MODEL} size=${size} quality=${quality} in_bytes=${inputImage.buffer.length} out_bytes=${buffer.length} ${latencyMs}ms`,
  );
  return { buffer, contentType, model: GPT_IMAGE_MODEL, latencyMs };
}
