// imageReplaceDispatch.js
//
// Image generation entry point for the SPA's "edit / regenerate image"
// dialog on beat and character galleries. Two modes:
//
// - 'edit':     pass the existing image bytes + user prompt to the chosen
//               provider's edits endpoint. The original is the only reference.
// - 'generate': pure text-to-image with no references — the slot is replaced
//               with a fresh image built from the prompt alone.
//
// Both modes return { buffer, contentType, model } in the same shape so the
// caller can persist without branching. Sizing is left at 'auto' for OpenAI
// because the same dialog is used for portrait-orientation character images
// and landscape-orientation beat images — the model picks based on prompt.
//
// Mirrors src/web/storyboardImageDispatch.js but without the 16:9 size lock.

import { config } from '../config.js';
import { logger } from '../log.js';
import { generateImage as geminiGenerate, NANO_BANANA_MODEL } from '../gemini/client.js';
import {
  generateCharacterSheetImage,
  generateCharacterSheetImageEdit,
  GPT_IMAGE_MODEL,
} from '../openai/imageClient.js';
import { recordGeminiImageUsage, recordOpenAIImageUsage } from '../mongo/tokenUsage.js';

export async function dispatchImageReplace({
  prompt,
  mode = 'edit',
  model = 'gemini',
  existingImage = null,
  discordUser = null,
  channelId = null,
}) {
  if (!['gemini', 'openai'].includes(model)) {
    const err = new Error(`Unknown image model "${model}".`);
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
  if (model === 'gemini' && !config.gemini.apiKey && !config.gemini.vertex.project) {
    const err = new Error(
      'Gemini is not configured. Set GEMINI_API_KEY or GEMINI_VERTEX_PROJECT (with credentials).',
    );
    err.status = 400;
    throw err;
  }

  const inputImages = mode === 'edit' ? [existingImage] : [];

  if (model === 'gemini') {
    const result = await geminiGenerate({
      prompt,
      inputImages: inputImages.length ? inputImages : undefined,
    });
    if (result.usageMetadata) {
      try {
        await recordGeminiImageUsage({
          discordUser,
          channelId,
          model: NANO_BANANA_MODEL,
          usageMetadata: result.usageMetadata,
        });
      } catch (e) {
        logger.warn(`gemini token usage persist failed: ${e.message}`);
      }
    }
    return {
      buffer: result.buffer,
      contentType: result.contentType,
      model: NANO_BANANA_MODEL,
    };
  }

  // openai
  const r = mode === 'edit'
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
