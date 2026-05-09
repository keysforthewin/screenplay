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

const SHEET_SIZE = '1536x1024';

async function loadInputImage(mainImageId) {
  if (!mainImageId) return null;
  try {
    const r = await readImageBuffer(mainImageId);
    if (!r) return null;
    const declared = r.file.contentType || r.file.metadata?.contentType || null;
    const sniffed = validateImageBuffer(r.buffer);
    return { buffer: r.buffer, contentType: declared || sniffed };
  } catch (e) {
    logger.warn(`sheet gen: could not load main image ${mainImageId}: ${e.message}`);
    return null;
  }
}

export async function dispatchSheetGeneration({
  prompt,
  model = 'gemini',
  quality = 'auto',
  mainImageId = null,
  omitImages = false,
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

  const inputImage = omitImages ? null : await loadInputImage(mainImageId);

  if (model === 'gemini') {
    const t0 = Date.now();
    const { buffer, contentType } = await geminiGenerate({ prompt, inputImage });
    return {
      buffer,
      contentType,
      model: NANO_BANANA_MODEL,
      latencyMs: Date.now() - t0,
      usedInputImage: !!inputImage,
    };
  }

  // openai
  if (inputImage) {
    const r = await generateCharacterSheetImageEdit({
      prompt,
      inputImage,
      size: SHEET_SIZE,
      quality,
    });
    return { ...r, usedInputImage: true };
  }
  const r = await generateCharacterSheetImage({
    prompt,
    size: SHEET_SIZE,
    quality,
  });
  return { ...r, usedInputImage: false, model: r.model || GPT_IMAGE_MODEL };
}
