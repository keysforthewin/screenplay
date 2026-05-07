// beatSceneSheet.js
//
// Mirror of characterSheet.js for *beats* (scenes). Generates a UE5
// production-grade scene reference sheet from `beat.specifics.*` using
// OpenAI gpt-image-2 and stores it as `beat.scene_sheet_image_id`.
//
// Replace-on-regenerate: the prior GridFS file is deleted after the new one
// is recorded.

import { config } from '../config.js';
import { logger } from '../log.js';
import { buildSceneSheetPrompt } from '../util/beatSpecifics.js';
import { stripMarkdown } from '../util/markdown.js';
import { getBeat } from '../mongo/plots.js';
import { uploadGeneratedImage, deleteImage } from '../mongo/images.js';
import { generateCharacterSheetImage, GPT_IMAGE_MODEL } from '../openai/imageClient.js';
import { setBeatSceneSheetImageViaGateway } from './gateway.js';

let generatorImpl = generateCharacterSheetImage;
export function _setGeneratorForTests(fn) {
  generatorImpl = fn;
}
export function _resetGeneratorForTests() {
  generatorImpl = generateCharacterSheetImage;
}

export async function generateSceneSheetForBeat({ beatId, quality = 'auto' }) {
  if (!config.openai.apiKey) {
    const err = new Error('OPENAI_API_KEY is not configured.');
    err.status = 400;
    throw err;
  }
  const beat = await getBeat(beatId);
  if (!beat) {
    const err = new Error(`Beat not found: ${beatId}`);
    err.status = 404;
    throw err;
  }

  const specifics = beat.specifics || {};
  const sceneName = stripMarkdown(beat.name || '') || null;
  const prompt = buildSceneSheetPrompt(specifics, { sceneName });

  const { buffer, contentType, model, latencyMs } = await generatorImpl({
    prompt,
    size: '1536x1024',
    quality,
  });

  const id = beat._id.toString();
  const file = await uploadGeneratedImage({
    buffer,
    contentType,
    prompt,
    generatedBy: model || GPT_IMAGE_MODEL,
    ownerType: 'beat',
    ownerId: id,
    filename: `scene-sheet-${id}-${Date.now()}.png`,
  });

  const previousId = beat.scene_sheet_image_id
    ? beat.scene_sheet_image_id.toString()
    : null;

  await setBeatSceneSheetImageViaGateway({
    beatId: id,
    imageId: file._id.toString(),
  });

  if (previousId && previousId !== file._id.toString()) {
    try {
      await deleteImage(previousId);
    } catch (e) {
      logger.warn(`scene sheet: failed to delete old image ${previousId}: ${e.message}`);
    }
  }

  logger.info(
    `scene sheet: beat=${id} image=${file._id} quality=${quality} ${latencyMs ?? '?'}ms`,
  );
  return {
    image_id: file._id.toString(),
    content_type: file.content_type,
    size: file.size,
    quality,
    model: model || GPT_IMAGE_MODEL,
    latency_ms: latencyMs ?? null,
  };
}
