// sheetImageDispatch.js
//
// Single decision point for character/scene sheet generation: which model
// (Gemini Nano Banana or OpenAI gpt-image-2) to call, and whether to attach
// the entity's main image as a reference. Both characterSheet.js and
// beatSceneSheet.js delegate here so the two stay parallel.

import { config } from '../config.js';
import { logger } from '../log.js';
import { readImageBuffer } from '../mongo/images.js';
import { validateImageBuffer } from '../mongo/imageBytes.js';
import {
  generateCharacterSheetImage,
  generateCharacterSheetImageEdit,
  GPT_IMAGE_MODEL,
} from '../openai/imageClient.js';
import { generateImage as geminiGenerate, NANO_BANANA_MODEL } from '../gemini/client.js';
import { recordGeminiImageUsage, recordOpenAIImageUsage } from '../mongo/tokenUsage.js';

const SHEET_SIZE = '1536x1024';

async function loadInputImage(imageId) {
  if (!imageId) return null;
  try {
    const r = await readImageBuffer(imageId);
    if (!r) return null;
    const declared = r.file.contentType || r.file.metadata?.contentType || null;
    const sniffed = validateImageBuffer(r.buffer);
    return { buffer: r.buffer, contentType: declared || sniffed };
  } catch (e) {
    logger.warn(`sheet gen: could not load image ${imageId}: ${e.message}`);
    return null;
  }
}

async function loadInputImages(imageIds) {
  const out = [];
  for (const id of imageIds || []) {
    const img = await loadInputImage(id);
    if (img) out.push(img);
  }
  return out;
}

export async function dispatchSheetGeneration({
  prompt,
  model = 'gemini',
  quality = 'auto',
  mainImageId = null,
  referenceImageIds = null,
  omitImages = false,
  discordUser = null,
  channelId = null,
}) {
  if (!['gemini', 'openai'].includes(model)) {
    const err = new Error(`Unknown sheet model "${model}".`);
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

  let inputImages = [];
  if (!omitImages) {
    if (Array.isArray(referenceImageIds) && referenceImageIds.length) {
      inputImages = await loadInputImages(referenceImageIds);
    } else if (mainImageId) {
      const single = await loadInputImage(mainImageId);
      if (single) inputImages = [single];
    }
  }
  const usedInputImage = inputImages.length > 0;

  if (model === 'gemini') {
    const t0 = Date.now();
    const { buffer, contentType, usageMetadata } = await geminiGenerate({
      prompt,
      inputImages: usedInputImage ? inputImages : undefined,
    });
    if (usageMetadata) {
      try {
        await recordGeminiImageUsage({
          discordUser,
          channelId,
          model: NANO_BANANA_MODEL,
          usageMetadata,
        });
      } catch (e) {
        logger.warn(`gemini token usage persist failed: ${e.message}`);
      }
    }
    return {
      buffer,
      contentType,
      model: NANO_BANANA_MODEL,
      latencyMs: Date.now() - t0,
      usedInputImage,
      inputImageCount: inputImages.length,
    };
  }

  // openai
  const r = usedInputImage
    ? await generateCharacterSheetImageEdit({
        prompt,
        inputImages,
        size: SHEET_SIZE,
        quality,
      })
    : await generateCharacterSheetImage({ prompt, size: SHEET_SIZE, quality });
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
    ...r,
    usedInputImage,
    inputImageCount: inputImages.length,
    model: r.model || GPT_IMAGE_MODEL,
  };
}
