// beatSceneSheet.js
//
// Mirror of characterSheet.js for *beats* (scenes). Generates a UE5
// production-grade scene reference sheet from `beat.specifics.*` and stores
// it as `beat.scene_sheet_image_id`. Model selection (Gemini vs OpenAI) and
// the optional main-image reference are routed through
// `dispatchSheetGeneration`.
//
// Replace-on-regenerate: the prior GridFS file is deleted after the new one
// is recorded.

import { logger } from '../log.js';
import { buildSceneSheetPrompt } from '../util/beatSpecifics.js';
import { stripMarkdown } from '../util/markdown.js';
import { getBeat } from '../mongo/plots.js';
import { uploadGeneratedImage, deleteImage } from '../mongo/images.js';
import { dispatchSheetGeneration } from './sheetImageDispatch.js';
import { setBeatSceneSheetImageViaGateway } from './gateway.js';

let dispatchImpl = dispatchSheetGeneration;
export function _setGeneratorForTests(fn) {
  dispatchImpl = fn;
}
export function _resetGeneratorForTests() {
  dispatchImpl = dispatchSheetGeneration;
}

export async function generateSceneSheetForBeat({
  beatId,
  quality = 'auto',
  model = 'gemini',
  omitImages = false,
  discordUser = null,
  channelId = null,
}) {
  const beat = await getBeat(beatId);
  if (!beat) {
    const err = new Error(`Beat not found: ${beatId}`);
    err.status = 404;
    throw err;
  }

  const specifics = beat.specifics || {};
  const sceneName = stripMarkdown(beat.name || '') || null;
  const prompt = buildSceneSheetPrompt(specifics, { sceneName });

  const { buffer, contentType, model: usedModel, latencyMs, usedInputImage } =
    await dispatchImpl({
      prompt,
      model,
      quality,
      mainImageId: beat.main_image_id || null,
      omitImages,
      discordUser,
      channelId,
    });

  const id = beat._id.toString();
  const file = await uploadGeneratedImage({
    buffer,
    contentType,
    prompt,
    generatedBy: usedModel || model,
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
    `scene sheet: beat=${id} image=${file._id} model=${usedModel} input_image=${usedInputImage ? 'yes' : 'no'} quality=${quality} ${latencyMs ?? '?'}ms`,
  );
  return {
    image_id: file._id.toString(),
    content_type: file.content_type,
    size: file.size,
    quality,
    model: usedModel,
    used_input_image: !!usedInputImage,
    latency_ms: latencyMs ?? null,
  };
}
