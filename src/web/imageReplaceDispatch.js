// imageReplaceDispatch.js
//
// Image generation entry point for the SPA's "edit / regenerate image"
// dialogs on beat, character, and artwork galleries. Four logical models:
//
//   - nano-banana-pro    → fal-ai/nano-banana-pro (gen) / -pro/edit (img2img)
//   - flux-2-pro         → fal-ai/flux-2-pro (gen) / -2-pro/edit (img2img)
//   - flux-pro-kontext   → fal-ai/flux-pro/kontext (single) / /multi (multi)
//   - openai             → gpt-image-2 (gen + edit)
//
// Each FAL helper auto-routes between its generate and /edit endpoints based
// on whether any input images are present; the dispatcher only has to forward
// the inputImages array.
//
// Two modes:
//   - 'edit':     pass the existing image bytes + user prompt to the model.
//                 Optional referenceImages are prepended.
//   - 'generate': pure text-to-image when no references; if references are
//                 present, route through the provider's edit endpoint with the
//                 references as inputs (no separate "existing" image).
//
// All paths return { buffer, contentType, model } in the same shape. Sizing
// is left at 'auto' for OpenAI because the same dispatcher serves portrait
// character images and landscape beat images — the model picks based on
// prompt.

import { config } from '../config.js';
import { logger } from '../log.js';
import {
  generateCharacterSheetImage,
  generateCharacterSheetImageEdit,
  GPT_IMAGE_MODEL,
} from '../openai/imageClient.js';
import {
  generateFluxKontextImage,
  generateFlux2ProImage,
  generateNanoBananaProImage,
  FLUX_KONTEXT_MODEL,
  FLUX_2_PRO_MODEL,
  NANO_BANANA_PRO_GENERATE_MODEL,
} from '../fal/imageClient.js';
import { isConfigured as falConfigured } from '../fal/client.js';
import { recordOpenAIImageUsage, recordFalImageUsage } from '../mongo/tokenUsage.js';

export const ALLOWED_IMAGE_MODELS = ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai'];
const FAL_MODELS = new Set(['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext']);

export async function dispatchImageReplace({
  prompt,
  mode = 'edit',
  model = 'nano-banana-pro',
  existingImage = null,
  referenceImages = [],
  discordUser = null,
  channelId = null,
}) {
  if (!ALLOWED_IMAGE_MODELS.includes(model)) {
    const err = new Error(
      `Unknown image model "${model}". Allowed: ${ALLOWED_IMAGE_MODELS.join('|')}`,
    );
    err.status = 400;
    throw err;
  }
  if (!['edit', 'generate'].includes(mode)) {
    const err = new Error(`Unknown image mode "${mode}".`);
    err.status = 400;
    throw err;
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    const err = new Error('prompt is required.');
    err.status = 400;
    throw err;
  }
  if (mode === 'edit' && (!existingImage?.buffer || !existingImage?.contentType)) {
    const err = new Error('Edit mode requires an existing image with buffer + contentType.');
    err.status = 400;
    throw err;
  }
  if (model === 'openai' && !config.openai.apiKey) {
    const err = new Error('OPENAI_API_KEY is not configured.');
    err.status = 400;
    throw err;
  }
  if (FAL_MODELS.has(model) && !falConfigured()) {
    const err = new Error('FAL_KEY is not configured.');
    err.status = 400;
    throw err;
  }

  const refs = Array.isArray(referenceImages) ? referenceImages : [];
  for (const r of refs) {
    if (!r?.buffer || !r?.contentType) {
      const err = new Error('referenceImages entries must have buffer + contentType.');
      err.status = 400;
      throw err;
    }
  }
  const inputImages = [
    ...refs,
    ...(mode === 'edit' && existingImage ? [existingImage] : []),
  ];

  if (FAL_MODELS.has(model)) {
    let result;
    let fallbackModel;
    if (model === 'nano-banana-pro') {
      result = await generateNanoBananaProImage({ prompt, inputImages });
      fallbackModel = NANO_BANANA_PRO_GENERATE_MODEL;
    } else if (model === 'flux-2-pro') {
      result = await generateFlux2ProImage({ prompt, inputImages });
      fallbackModel = FLUX_2_PRO_MODEL;
    } else {
      result = await generateFluxKontextImage({ prompt, inputImages });
      fallbackModel = FLUX_KONTEXT_MODEL;
    }
    try {
      await recordFalImageUsage({
        discordUser,
        channelId,
        model: result.model || fallbackModel,
        meta: { input_image_count: inputImages.length, mode, logical_model: model },
      });
    } catch (e) {
      logger.warn(`fal token usage persist failed: ${e.message}`);
    }
    return {
      buffer: result.buffer,
      contentType: result.contentType,
      model: result.model || fallbackModel,
    };
  }

  // openai — route through the edits endpoint whenever any input image is
  // present. Pure text-to-image is reserved for the no-input case.
  const r = inputImages.length > 0
    ? await generateCharacterSheetImageEdit({
        prompt,
        inputImages,
        size: 'auto',
        quality: 'auto',
      })
    : await generateCharacterSheetImage({
        prompt,
        size: 'auto',
        quality: 'auto',
      });
  if (r.usage) {
    try {
      await recordOpenAIImageUsage({
        discordUser,
        channelId,
        model: r.model || GPT_IMAGE_MODEL,
        usage: r.usage,
      });
    } catch (e) {
      logger.warn(`openai token usage persist failed: ${e.message}`);
    }
  }
  return {
    buffer: r.buffer,
    contentType: r.contentType,
    model: r.model || GPT_IMAGE_MODEL,
  };
}
