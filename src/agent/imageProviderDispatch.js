// imageProviderDispatch.js
//
// Routes `generate_image` / `edit_image` agent-tool calls to either Google's
// Nano Banana (gemini-2.5-flash-image) or OpenAI's gpt-image-2. Centralises:
//   - per-provider config checks (returned as friendly error strings, never
//     thrown — same pattern the handlers already use for Gemini)
//   - the model call itself
//   - aspect-ratio → OpenAI size mapping
//   - per-provider token-usage recording
//
// Mirrors src/web/sheetImageDispatch.js, which does the same job for the web
// character-sheet / scene-sheet routes.

import { config } from '../config.js';
import { logger } from '../log.js';
import { generateImage as geminiGenerate, NANO_BANANA_MODEL } from '../gemini/client.js';
import {
  generateCharacterSheetImage as openaiGenerate,
  generateCharacterSheetImageEdit as openaiEdit,
  GPT_IMAGE_MODEL,
} from '../openai/imageClient.js';
import { recordGeminiImageUsage, recordOpenAIImageUsage } from '../mongo/tokenUsage.js';

// gpt-image-2 accepts a fixed set of sizes (see VALID_SIZES in
// src/openai/imageClient.js). Map the agent-tool aspect_ratio enum to the
// closest landscape/portrait match. 4:3 / 3:4 don't have exact gpt-image-2
// equivalents — fall back to the nearest 3:2 / 2:3.
const ASPECT_TO_OPENAI_SIZE = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
};
const DEFAULT_OPENAI_SIZE = '1536x1024';

export function checkProviderConfigured(provider) {
  if (provider === 'openai') {
    if (!config.openai.apiKey) {
      return 'Error: OpenAI is not configured. Set OPENAI_API_KEY to use `provider: "openai"`.';
    }
    return null;
  }
  if (!config.gemini.apiKey && !config.gemini.vertex.project) {
    return 'Error: Gemini is not configured. Set GEMINI_VERTEX_PROJECT (+ GOOGLE_APPLICATION_CREDENTIALS) for Vertex AI, or GEMINI_API_KEY for the Developer API.';
  }
  return null;
}

export async function generateOrEditImage({
  provider = 'gemini',
  prompt,
  aspectRatio,
  inputImage = null,
  discordUser = null,
  channelId = null,
}) {
  if (provider === 'openai') {
    const size = ASPECT_TO_OPENAI_SIZE[aspectRatio] || DEFAULT_OPENAI_SIZE;
    const r = inputImage
      ? await openaiEdit({ prompt, inputImage, size, quality: 'auto' })
      : await openaiGenerate({ prompt, size, quality: 'auto' });
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

  // default: gemini / nano banana
  const { buffer, contentType, usageMetadata } = await geminiGenerate({
    prompt,
    aspectRatio,
    inputImage: inputImage || undefined,
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
  return { buffer, contentType, model: NANO_BANANA_MODEL };
}
