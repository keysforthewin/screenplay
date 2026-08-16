// Generic image generation for any endpoint in the fal.ai catalog.
//
// The seven hand-wired models (src/fal/imageClient.js) have tuned generate/edit
// routing and per-model quirks. Everything else in the catalog runs through
// here: the catalog row (data/fal-playground-models.json) already records each
// endpoint's resolved param names and its output path, so this runner reads the
// schema rather than guessing at it — the same contract the playground uses.
//
// Returns the { buffer, contentType, model } shape dispatchImageReplace hands
// back for the wired models, so every caller downstream is unchanged.

import { logger } from '../log.js';
import { fal, isConfigured as falConfigured } from './client.js';
import { uploadFalAsset } from './upload.js';
import { prepareImageForFal } from './prepareImage.js';
import {
  buildPlaygroundInput,
  extractOutputMedia,
  getPlaygroundModel,
} from './playgroundModels.js';
import { validateImageBuffer } from '../mongo/imageBytes.js';

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// How many reference images this endpoint can actually take. `max: null` in the
// catalog means the endpoint documents no cap, so we pass everything through.
function referenceCapacity(row) {
  const image = row?.inputs?.image;
  if (!image || image.need === 'unused' || !(image.params || []).length) return 0;
  return Number.isFinite(image.max) ? image.max : Infinity;
}

async function fetchImageBytes(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`fal output download network error: ${e.message}`);
  }
  if (!res.ok) throw new Error(`fal output download failed (${res.status})`);
  const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const buffer = Buffer.from(await res.arrayBuffer());
  // Same gate every other image entry point goes through — a provider handing
  // back HTML or a truncated file must not reach GridFS.
  validateImageBuffer(buffer);
  return { buffer, contentType };
}

export async function generateCatalogImage({
  endpointId,
  prompt,
  referenceImages = [],
}) {
  if (!falConfigured()) throw badRequest('FAL_KEY is not configured.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw badRequest('prompt is required.');

  const row = await getPlaygroundModel(String(endpointId));
  if (!row) throw badRequest(`"${endpointId}" is not in the fal catalog.`);
  if (row.output?.kind !== 'image') {
    throw badRequest(`"${endpointId}" does not produce images.`);
  }

  // An endpoint that takes no image input at all cannot honor the caller's
  // references. Refuse rather than silently render prompt-only — a dropped
  // reference is indistinguishable from a bad render to the user, and they
  // explicitly attached it. (Over-capacity clamping below still just trims:
  // the render is still reference-anchored, only less redundantly.)
  const capacity = referenceCapacity(row);
  if ((referenceImages || []).length > 0 && capacity === 0) {
    throw badRequest(
      `"${row.endpoint_id}" cannot take reference images, but this render supplies ` +
        `${(referenceImages || []).length}. Pick a model that accepts references, or ` +
        'remove the references to render from the prompt alone.',
    );
  }
  const usable = (referenceImages || []).slice(0, capacity === Infinity ? undefined : capacity);
  if (usable.length < (referenceImages || []).length) {
    logger.info(
      `catalog image: ${endpointId} takes ${capacity} references, ` +
        `dropping ${(referenceImages || []).length - usable.length}`,
    );
  }

  // An edit-only endpoint called without its required input image(s) is a
  // guaranteed provider 422 — fail here with an actionable message instead.
  const image = row.inputs?.image;
  if (image?.need === 'required') {
    const minimum = Math.max(1, Number(image.required_count) || 1);
    if (usable.length < minimum) {
      throw badRequest(
        `"${row.endpoint_id}" requires at least ${minimum} input image${minimum === 1 ? '' : 's'} ` +
          `but this render has ${usable.length}. Assign reference images to it, or pick a model ` +
          'that can generate from a prompt alone.',
      );
    }
  }

  const imageUrls = [];
  for (const ref of usable) {
    if (!ref?.buffer || !ref?.contentType) {
      throw badRequest('referenceImages entries must have buffer + contentType.');
    }
    const prepared = await prepareImageForFal({
      buffer: ref.buffer,
      contentType: ref.contentType,
    });
    imageUrls.push(await uploadFalAsset({
      buffer: prepared.buffer,
      contentType: prepared.contentType,
      name: `catalog-ref-${imageUrls.length}`,
    }));
  }

  const input = buildPlaygroundInput(row, { prompt, imageUrls });
  const t0 = Date.now();
  logger.info(`catalog image → ${row.endpoint_id} prompt=${prompt.length}c refs=${imageUrls.length}`);
  let result;
  try {
    result = await fal.subscribe(row.endpoint_id, { input });
  } catch (e) {
    // The fal client's errors carry only statusText as message ("Unprocessable
    // Entity"); the actual validation detail lives in e.body. Re-throw with the
    // same rich formatting the wired models use.
    const { enrichFalError } = await import('./imageClient.js');
    throw enrichFalError(e, row.endpoint_id);
  }
  const data = result?.data || result;
  const media = extractOutputMedia(row, data).filter((m) => (m.kind || 'image') === 'image');
  if (!media.length) {
    throw new Error(
      `${row.endpoint_id} returned no image URL: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  const { buffer, contentType } = await fetchImageBytes(media[0].url);
  logger.info(
    `catalog image: ${row.endpoint_id} refs=${imageUrls.length} ` +
      `${buffer.length}b ${Date.now() - t0}ms`,
  );
  return { buffer, contentType, model: row.endpoint_id, inputImageCount: imageUrls.length };
}
