// storyboardImageDispatch.js
//
// Single decision point for storyboard frame image generation: which model
// (Gemini Nano Banana or OpenAI gpt-image-2), and whether we're running a
// fresh generation (text + optional reference images) or an edit pass on a
// single existing image. Mirrors the structure of sheetImageDispatch.js but
// fixes the size to true 16:9 for OpenAI and exposes a generate/edit flag the
// per-frame regen path uses for inline tweaks.

import { config } from '../config.js';
import { logger } from '../log.js';
import { generateImage as geminiGenerate, NANO_BANANA_MODEL } from '../gemini/client.js';
import {
  generateCharacterSheetImage,
  generateCharacterSheetImageEdit,
  GPT_IMAGE_MODEL,
} from '../openai/imageClient.js';
import { recordGeminiImageUsage, recordOpenAIImageUsage } from '../mongo/tokenUsage.js';

// gpt-image-2's closest exact 16:9 size. Storyboard frames are framed for
// 16:9 throughout the pipeline (Gemini gets `aspectRatio: '16:9'`), so this
// matches.
const STORYBOARD_SIZE = '2048x1152';
const ASPECT_RATIO = '16:9';

export async function dispatchStoryboardImage({
  prompt,
  model = 'gemini',
  inputImages = [],
  mode = 'generate',
}) {
  if (!['gemini', 'openai'].includes(model)) {
    const err = new Error(`Unknown storyboard image model "${model}".`);
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
  if (model === 'gemini' && !config.gemini.apiKey && !config.gemini.vertex.project) {
    const err = new Error(
      'Gemini is not configured. Set GEMINI_API_KEY or GEMINI_VERTEX_PROJECT (with credentials).',
    );
    err.status = 400;
    throw err;
  }

  const refs = Array.isArray(inputImages) ? inputImages : [];
  if (mode === 'edit' && refs.length !== 1) {
    const err = new Error('Edit mode requires exactly one input image.');
    err.status = 400;
    throw err;
  }

  if (model === 'gemini') {
    const result = await geminiGenerate({
      prompt,
      aspectRatio: ASPECT_RATIO,
      inputImages: refs.length ? refs : undefined,
    });
    if (result.usageMetadata) {
      try {
        await recordGeminiImageUsage({
          discordUser: null,
          channelId: null,
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

  // openai. images.edits when we have refs (or in edit mode), otherwise the
  // pure text-to-image endpoint. Both come back in the same shape.
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
