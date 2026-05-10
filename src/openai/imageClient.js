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

// Console-log the full prompt before every image generation. The user wants
// to see exactly what's being sent so they can debug safety-system rejections.
function logPrompt(label, prompt, extras = {}) {
  const meta = Object.entries(extras)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  logger.info(
    `${label} ${meta}\n────── prompt (${prompt.length} chars) ──────\n${prompt}\n──────────────────────────────────────────`,
  );
}

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

  logPrompt(`openai images.generations → ${GPT_IMAGE_MODEL}`, prompt, {
    size,
    quality,
  });

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
  const usage = data?.usage || null;
  logger.info(
    `openai: ${GPT_IMAGE_MODEL} size=${size} quality=${quality} bytes=${buffer.length} in_tok=${usage?.input_tokens || 0} out_tok=${usage?.output_tokens || 0} total_tok=${usage?.total_tokens || 0} ${latencyMs}ms`,
  );
  return { buffer, contentType, model: GPT_IMAGE_MODEL, latencyMs, usage };
}

// images.edits — multipart POST that includes one or more reference images
// alongside the prompt. Used when the user wants existing imagery (the
// character's main image, additional pose references, etc.) to seed the sheet
// generation. Mirrors generateCharacterSheetImage's response shape so the
// caller can treat the two interchangeably.
export async function generateCharacterSheetImageEdit({
  prompt,
  inputImage,
  inputImages,
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
  const images = Array.isArray(inputImages) && inputImages.length
    ? inputImages
    : inputImage
      ? [inputImage]
      : [];
  if (!images.length) {
    throw new Error('generateCharacterSheetImageEdit: at least one input image is required.');
  }
  for (const img of images) {
    if (!img?.buffer || !img?.contentType) {
      throw new Error('generateCharacterSheetImageEdit: each input image needs buffer + contentType.');
    }
  }
  if (!VALID_SIZES.has(size)) {
    throw new Error(`generateCharacterSheetImageEdit: invalid size "${size}".`);
  }
  if (!VALID_QUALITIES.has(quality)) {
    throw new Error(`generateCharacterSheetImageEdit: invalid quality "${quality}".`);
  }

  logPrompt(`openai images.edits → ${GPT_IMAGE_MODEL}`, prompt, {
    size,
    quality,
    input_image_count: images.length,
    input_image_bytes: images.reduce((n, i) => n + i.buffer.length, 0),
  });

  const fd = new FormData();
  fd.append('model', GPT_IMAGE_MODEL);
  fd.append('prompt', prompt);
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    fd.append(
      'image[]',
      new Blob([img.buffer], { type: img.contentType }),
      `ref-${i}.${extensionForType(img.contentType)}`,
    );
  }
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
  const usage = data?.usage || null;
  logger.info(
    `openai edit: ${GPT_IMAGE_MODEL} size=${size} quality=${quality} in_count=${images.length} in_bytes=${images.reduce((n, i) => n + i.buffer.length, 0)} out_bytes=${buffer.length} in_tok=${usage?.input_tokens || 0} out_tok=${usage?.output_tokens || 0} total_tok=${usage?.total_tokens || 0} ${latencyMs}ms`,
  );
  return { buffer, contentType, model: GPT_IMAGE_MODEL, latencyMs, usage };
}
