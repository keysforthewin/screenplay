// imageProviderDispatch.js
//
// Routes `generate_image` / `edit_image` agent-tool calls to one of:
//   - nano-banana-pro   → fal-ai/nano-banana-pro / -pro/edit (default)
//   - flux-2-pro        → fal-ai/flux-2-pro / -2-pro/edit
//   - flux-pro-kontext  → fal-ai/flux-pro/kontext / /multi
//   - openai            → gpt-image-2
//
// Centralises per-provider config checks (returned as friendly error strings,
// never thrown — same pattern the handlers already use), the model call, and
// per-provider token-usage recording.

import { config } from '../config.js';
import { logger } from '../log.js';
import {
  generateCharacterSheetImage as openaiGenerate,
  generateCharacterSheetImageEdit as openaiEdit,
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

// gpt-image-2 accepts a fixed set of sizes (see VALID_SIZES in
// src/openai/imageClient.js). Map the agent-tool aspect_ratio enum to the
// closest landscape/portrait match. 4:3 / 3:4 fall back to the nearest 3:2 / 2:3.
const ASPECT_TO_OPENAI_SIZE = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
};
const DEFAULT_OPENAI_SIZE = '1536x1024';

export const ALLOWED_IMAGE_PROVIDERS = ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai'];
const FAL_PROVIDERS = new Set(['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext']);

export function checkProviderConfigured(provider) {
  if (provider === 'openai') {
    if (!config.openai.apiKey) {
      return 'Error: OpenAI is not configured. Set OPENAI_API_KEY to use `provider: "openai"`.';
    }
    return null;
  }
  if (FAL_PROVIDERS.has(provider)) {
    if (!falConfigured()) {
      return `Error: FAL is not configured. Set FAL_KEY to use \`provider: "${provider}"\`.`;
    }
    return null;
  }
  return `Error: Unknown image provider "${provider}". Allowed: ${ALLOWED_IMAGE_PROVIDERS.join('|')}`;
}

export async function generateOrEditImage({
  provider = 'nano-banana-pro',
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

  // FAL providers — wrap optional inputImage into the inputImages array shape
  // the FAL helpers expect, and let them auto-route between generate and /edit.
  const inputImages = inputImage ? [inputImage] : [];
  let result;
  let fallbackModel;
  if (provider === 'nano-banana-pro') {
    result = await generateNanoBananaProImage({
      prompt,
      inputImages,
      aspectRatio: aspectRatio || '16:9',
    });
    fallbackModel = NANO_BANANA_PRO_GENERATE_MODEL;
  } else if (provider === 'flux-2-pro') {
    result = await generateFlux2ProImage({
      prompt,
      inputImages,
      aspectRatio: aspectRatio || '16:9',
    });
    fallbackModel = FLUX_2_PRO_MODEL;
  } else if (provider === 'flux-pro-kontext') {
    result = await generateFluxKontextImage({
      prompt,
      inputImages,
      aspectRatio: aspectRatio || '16:9',
    });
    fallbackModel = FLUX_KONTEXT_MODEL;
  } else {
    throw new Error(`Unknown image provider "${provider}".`);
  }
  try {
    await recordFalImageUsage({
      discordUser,
      channelId,
      model: result.model || fallbackModel,
      meta: { input_image_count: inputImages.length, logical_model: provider },
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
