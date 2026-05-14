// storyboardImageDispatch.js
//
// Single decision point for storyboard frame image generation. Four logical
// models (nano-banana-pro, flux-2-pro, flux-pro-kontext, openai) and two modes
// (generate / edit). Fixes the size to true 16:9 for OpenAI and forwards
// aspect_ratio='16:9' for the FAL helpers.

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

// gpt-image-2's closest exact 16:9 size. Storyboard frames are framed for
// 16:9 throughout the pipeline.
const STORYBOARD_SIZE = '2048x1152';
const ASPECT_RATIO = '16:9';

export const ALLOWED_STORYBOARD_MODELS = ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai'];
const FAL_MODELS = new Set(['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext']);

export async function dispatchStoryboardImage({
  prompt,
  model = 'nano-banana-pro',
  inputImages = [],
  mode = 'generate',
}) {
  if (!ALLOWED_STORYBOARD_MODELS.includes(model)) {
    const err = new Error(
      `Unknown storyboard image model "${model}". Allowed: ${ALLOWED_STORYBOARD_MODELS.join('|')}`,
    );
    err.status = 400;
    throw err;
  }
  if (!['generate', 'edit'].includes(mode)) {
    const err = new Error(`Unknown storyboard image mode "${mode}".`);
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

  const refs = Array.isArray(inputImages) ? inputImages : [];
  if (mode === 'edit' && refs.length !== 1) {
    const err = new Error('Edit mode requires exactly one input image.');
    err.status = 400;
    throw err;
  }

  if (FAL_MODELS.has(model)) {
    let result;
    let fallbackModel;
    if (model === 'nano-banana-pro') {
      result = await generateNanoBananaProImage({
        prompt,
        inputImages: refs,
        aspectRatio: ASPECT_RATIO,
      });
      fallbackModel = NANO_BANANA_PRO_GENERATE_MODEL;
    } else if (model === 'flux-2-pro') {
      result = await generateFlux2ProImage({
        prompt,
        inputImages: refs,
        aspectRatio: ASPECT_RATIO,
      });
      fallbackModel = FLUX_2_PRO_MODEL;
    } else {
      result = await generateFluxKontextImage({
        prompt,
        inputImages: refs,
        aspectRatio: ASPECT_RATIO,
      });
      fallbackModel = FLUX_KONTEXT_MODEL;
    }
    try {
      await recordFalImageUsage({
        discordUser: null,
        channelId: null,
        model: result.model || fallbackModel,
        meta: { input_image_count: refs.length, mode, logical_model: model },
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

  // openai. images.edits when we have refs (or in edit mode), otherwise the
  // pure text-to-image endpoint.
  const useEdit = mode === 'edit' || refs.length > 0;
  const r = useEdit
    ? await generateCharacterSheetImageEdit({
        prompt,
        inputImages: refs,
        size: STORYBOARD_SIZE,
        quality: 'auto',
      })
    : await generateCharacterSheetImage({
        prompt,
        size: STORYBOARD_SIZE,
        quality: 'auto',
      });
  if (r.usage) {
    try {
      await recordOpenAIImageUsage({
        discordUser: null,
        channelId: null,
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
