// fal.ai image generation adapter — fronts the Flux Pro Kontext, Flux 2 Pro,
// and Nano Banana Pro (Google Gemini 3 Pro Image) endpoints via @fal-ai/client.
// Designed to slot into storyboardImageDispatch.js / imageReplaceDispatch.js
// alongside the OpenAI branch.
//
// Each model exposes one helper that auto-routes between its generate and
// /edit endpoints based on whether the caller passes any input images. This
// keeps the dispatcher logic simple (model id + inputImages → image bytes).
//
// Graceful-missing-key pattern: callers that hit fal without FAL_KEY set get
// a 400-style error returned to the user; the rest of the bot keeps working.

import { fal, isConfigured as falConfigured } from './client.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { validateImageBuffer } from '../mongo/imageBytes.js';

// Flux Pro Kontext single + multi. Kontext is image-conditioned only — the
// single-image endpoint expects `image_url`, the /multi variant expects
// `image_urls`. With 0 references it runs as pure text-to-image (single).
export const FLUX_KONTEXT_MODEL = config.fal.fluxKontextModel;
export const FLUX_KONTEXT_MULTI_MODEL = config.fal.fluxKontextMultiModel;

// Nano Banana Pro (Google Gemini 3 Pro Image) — separate endpoints for
// text-to-image (bare) vs image-to-image (/edit). The bare endpoint silently
// drops image inputs, which is why we route through /edit whenever any input
// image is present. Multi-image blending is supported by /edit (up to 14).
export const NANO_BANANA_PRO_GENERATE_MODEL = config.fal.nanoBananaProGenerateModel;
export const NANO_BANANA_PRO_EDIT_MODEL = config.fal.nanoBananaProEditModel;

// Flux 2 Pro — same generate/edit split. /edit accepts up to 9 reference
// image URLs at $0.03/MP (FAL docs).
export const FLUX_2_PRO_MODEL = config.fal.flux2ProGenerateModel;
export const FLUX_2_PRO_EDIT_MODEL = config.fal.flux2ProEditModel;

// Per-endpoint max input images. Anything above is sliced to the cap with a
// warning — preferable to a hard 400 from fal.
export const FLUX_2_PRO_EDIT_MAX_INPUTS = 9;
export const NANO_BANANA_PRO_EDIT_MAX_INPUTS = 14;

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function inputToDataUrl(input) {
  const buffer = input?.buffer;
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('fal: input image missing buffer');
  }
  const sniffed = validateImageBuffer(buffer);
  if (!ALLOWED_CONTENT_TYPES.has(sniffed)) {
    throw new Error(`fal: unsupported input content type ${sniffed}`);
  }
  return `data:${sniffed};base64,${buffer.toString('base64')}`;
}

// Decode a result URL (or inline base64 data URL) returned by fal into a
// Buffer + contentType. fal endpoints return images as either
// `{ url, content_type }` (signed URL) or a data URL inline.
async function fetchResultImage(image) {
  if (!image) throw new Error('fal: empty result image');
  const ct = image.content_type || 'image/png';
  if (typeof image.url === 'string' && image.url.startsWith('data:')) {
    const m = image.url.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('fal: malformed inline data URL');
    return { buffer: Buffer.from(m[2], 'base64'), contentType: m[1] };
  }
  if (typeof image.url === 'string') {
    const res = await fetch(image.url);
    if (!res.ok) {
      throw new Error(`fal: result fetch failed ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    return {
      buffer: Buffer.from(ab),
      contentType: res.headers.get('content-type') || ct,
    };
  }
  throw new Error('fal: result image has no url');
}

function requireFal() {
  if (!falConfigured()) {
    const err = new Error('FAL_KEY is not configured.');
    err.status = 400;
    throw err;
  }
}

function requirePrompt(prompt) {
  if (!prompt || !prompt.trim()) {
    throw new Error('Empty prompt; nothing to generate.');
  }
}

async function callFal({ modelId, payload }) {
  try {
    const out = await fal.subscribe(modelId, { input: payload, logs: false });
    const result = out?.data || out;
    const image = result?.images?.[0] || result?.image;
    if (!image) {
      throw new Error(`fal ${modelId}: response did not include an image`);
    }
    const { buffer, contentType } = await fetchResultImage(image);
    return { buffer, contentType, model: modelId };
  } catch (err) {
    throw enrichFalError(err, modelId);
  }
}

// Shared generate/edit-split driver for fal models that take `aspect_ratio`
// and accept `image_urls` on their /edit endpoint (Nano Banana Pro/2, Gemini
// 2.5 Flash, Flux 2 Pro). 0 refs → bare generate endpoint; ≥1 ref → /edit with
// image_urls, truncated to maxEditInputs.
async function falGenerateEdit({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
  generateModel,
  editModel,
  maxEditInputs,
  label,
}) {
  requirePrompt(prompt);
  requireFal();
  const refs = Array.isArray(inputImages) ? inputImages : [];
  const payload = {
    prompt,
    aspect_ratio: aspectRatio,
    num_images: 1,
    output_format: 'png',
  };
  let modelId;
  if (refs.length === 0) {
    modelId = generateModel;
  } else {
    modelId = editModel;
    let capped = refs;
    if (refs.length > maxEditInputs) {
      logger.warn(
        `fal ${label}/edit: ${refs.length} refs exceeds cap ${maxEditInputs}; truncating`,
      );
      capped = refs.slice(0, maxEditInputs);
    }
    payload.image_urls = capped.map(inputToDataUrl);
  }
  logger.info(
    `fal ${label} → model=${modelId} prompt=${prompt.length}c refs=${refs.length}`,
  );
  return callFal({ modelId, payload });
}

// Generate (or refine) an image via Flux Pro Kontext. When `inputImages` is
// non-empty Kontext anchors on them as the visual reference and treats the
// prompt as the modification instruction; when empty it runs as pure
// text-to-image through the single-image endpoint.
export async function generateFluxKontextImage({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
}) {
  requirePrompt(prompt);
  requireFal();
  const refs = Array.isArray(inputImages) ? inputImages : [];
  const imageUrls = refs.map(inputToDataUrl);
  const payload = {
    prompt,
    aspect_ratio: aspectRatio,
    num_images: 1,
    output_format: 'png',
    safety_tolerance: '2',
  };
  let modelId = FLUX_KONTEXT_MODEL;
  if (imageUrls.length === 1) {
    payload.image_url = imageUrls[0];
  } else if (imageUrls.length > 1) {
    payload.image_urls = imageUrls;
    modelId = FLUX_KONTEXT_MULTI_MODEL;
  }
  logger.info(
    `fal flux-kontext → model=${modelId} prompt=${prompt.length}c refs=${refs.length}`,
  );
  return callFal({ modelId, payload });
}

// Nano Banana Pro (Gemini 3 Pro Image). Auto-routes between the bare
// text-to-image endpoint (no refs) and /edit (image-to-image, ≥1 ref).
// /edit supports multi-image blending up to NANO_BANANA_PRO_EDIT_MAX_INPUTS.
export async function generateNanoBananaProImage({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
}) {
  return falGenerateEdit({
    prompt,
    inputImages,
    aspectRatio,
    generateModel: NANO_BANANA_PRO_GENERATE_MODEL,
    editModel: NANO_BANANA_PRO_EDIT_MODEL,
    maxEditInputs: NANO_BANANA_PRO_EDIT_MAX_INPUTS,
    label: 'nano-banana-pro',
  });
}

// Flux 2 Pro. Auto-routes between text-to-image (no refs) and /edit
// (image-to-image, ≥1 ref). /edit caps at FLUX_2_PRO_EDIT_MAX_INPUTS refs.
export async function generateFlux2ProImage({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
}) {
  return falGenerateEdit({
    prompt,
    inputImages,
    aspectRatio,
    generateModel: FLUX_2_PRO_MODEL,
    editModel: FLUX_2_PRO_EDIT_MODEL,
    maxEditInputs: FLUX_2_PRO_EDIT_MAX_INPUTS,
    label: 'flux-2-pro',
  });
}

// ---------------------------------------------------------------------------
// Fast models
// ---------------------------------------------------------------------------

// Gemini 2.5 Flash Image (original "Nano Banana"). Same generate/edit split as
// Nano Banana Pro; cheaper and faster. /edit blends multiple references.
export const GEMINI_25_FLASH_GENERATE_MODEL = config.fal.gemini25FlashGenerateModel;
export const GEMINI_25_FLASH_EDIT_MODEL = config.fal.gemini25FlashEditModel;
export const GEMINI_25_FLASH_EDIT_MAX_INPUTS = 10;

export async function generateGemini25FlashImage({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
}) {
  return falGenerateEdit({
    prompt,
    inputImages,
    aspectRatio,
    generateModel: GEMINI_25_FLASH_GENERATE_MODEL,
    editModel: GEMINI_25_FLASH_EDIT_MODEL,
    maxEditInputs: GEMINI_25_FLASH_EDIT_MAX_INPUTS,
    label: 'gemini-25-flash',
  });
}

// Nano Banana 2 (Gemini 3.1 Flash). Newer fast Gemini; identical call shape.
export const NANO_BANANA_2_GENERATE_MODEL = config.fal.nanoBanana2GenerateModel;
export const NANO_BANANA_2_EDIT_MODEL = config.fal.nanoBanana2EditModel;
export const NANO_BANANA_2_EDIT_MAX_INPUTS = 10;

export async function generateNanoBanana2Image({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
}) {
  return falGenerateEdit({
    prompt,
    inputImages,
    aspectRatio,
    generateModel: NANO_BANANA_2_GENERATE_MODEL,
    editModel: NANO_BANANA_2_EDIT_MODEL,
    maxEditInputs: NANO_BANANA_2_EDIT_MAX_INPUTS,
    label: 'nano-banana-2',
  });
}

// FLUX.2 [klein] 9B. Distilled 4-step model. Unlike the Gemini/Flux-Pro family
// it takes `image_size` ({width,height}) instead of `aspect_ratio`, and its
// /edit endpoint caps references at 4 — so it gets its own function rather than
// going through falGenerateEdit.
export const FLUX_2_KLEIN_GENERATE_MODEL = config.fal.flux2KleinGenerateModel;
export const FLUX_2_KLEIN_EDIT_MODEL = config.fal.flux2KleinEditModel;
export const FLUX_2_KLEIN_EDIT_MAX_INPUTS = 4;

// Map the aspect ratios the pipeline uses to explicit pixel dims. 16:9 matches
// the storyboard pipeline's 2048x1152. Unmapped ratios fall through to the
// model default (image_size omitted).
const KLEIN_SIZE_BY_ASPECT = {
  '16:9': { width: 2048, height: 1152 },
  '9:16': { width: 1152, height: 2048 },
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1536, height: 1152 },
  '3:4': { width: 1152, height: 1536 },
};

export async function generateFlux2KleinImage({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
}) {
  requirePrompt(prompt);
  requireFal();
  const refs = Array.isArray(inputImages) ? inputImages : [];
  const payload = { prompt, num_images: 1, output_format: 'png' };
  let modelId;
  if (refs.length === 0) {
    modelId = FLUX_2_KLEIN_GENERATE_MODEL;
    const size = KLEIN_SIZE_BY_ASPECT[aspectRatio];
    if (size) payload.image_size = size;
  } else {
    modelId = FLUX_2_KLEIN_EDIT_MODEL;
    let capped = refs;
    if (refs.length > FLUX_2_KLEIN_EDIT_MAX_INPUTS) {
      logger.warn(
        `fal flux-2-klein/edit: ${refs.length} refs exceeds cap ${FLUX_2_KLEIN_EDIT_MAX_INPUTS}; truncating`,
      );
      capped = refs.slice(0, FLUX_2_KLEIN_EDIT_MAX_INPUTS);
    }
    payload.image_urls = capped.map(inputToDataUrl);
    // image_size omitted in edit mode — Klein inherits the reference frame size.
  }
  logger.info(
    `fal flux-2-klein → model=${modelId} prompt=${prompt.length}c refs=${refs.length}`,
  );
  return callFal({ modelId, payload });
}

function extractFalDetail(body) {
  if (!body) return null;
  if (typeof body === 'string') return body;
  if (typeof body.detail === 'string') return body.detail;
  if (Array.isArray(body.detail)) {
    const parts = body.detail
      .map((d) => {
        if (!d) return '';
        if (typeof d === 'string') return d;
        const loc = Array.isArray(d.loc) ? d.loc.join('.') : '';
        const msg = d.msg || d.message || JSON.stringify(d);
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (parts.length) return parts.join('; ');
  }
  if (typeof body.message === 'string') return body.message;
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return null;
  }
}

function enrichFalError(err, model) {
  const status = err?.status;
  const body = err?.body;
  const requestId = err?.requestId;
  const detail = extractFalDetail(body);
  const parts = [`fal ${model}`];
  if (status) parts.push(`HTTP ${status}`);
  parts.push(detail || err?.message || 'unknown fal error');
  if (requestId) parts.push(`request_id=${requestId}`);
  const message = parts.join(' — ');
  logger.error(
    `fal image failed: ${message}` +
      (body ? ` body=${JSON.stringify(body).slice(0, 1000)}` : ''),
  );
  const out = new Error(message);
  // Always mark with a 4xx-style status so entityRoutes surfaces the detailed
  // message to the SPA instead of the express default error handler swallowing
  // it as a generic 500. Pass-through fal 4xx codes verbatim; map fal 5xx (or
  // missing status) to 502.
  if (typeof status === 'number' && status >= 400 && status < 500) {
    out.status = status;
  } else {
    out.status = 502;
  }
  if (requestId) out.requestId = requestId;
  return out;
}
