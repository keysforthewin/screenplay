// characterSheet.js
//
// Generates a UE5 MetaHuman-style production character sheet from the
// character's `specifics.*` fields. The user picks the model (Gemini Nano
// Banana or OpenAI gpt-image-2) and may opt to send the character's main
// image as a reference; both decisions are routed through
// `dispatchSheetGeneration`. Result is stored in GridFS and recorded as
// `character.character_sheet_image_id`.
//
// Replace-on-regenerate: if the character already has a sheet, the prior
// GridFS file is deleted after the new one is recorded.
//
// Called by POST /api/character/:id/character-sheet in entityRoutes.js.

import { logger } from '../log.js';
import { buildCharacterSheetPrompt } from '../util/specifics.js';
import { stripMarkdown } from '../util/markdown.js';
import { getCharacter } from '../mongo/characters.js';
import { uploadGeneratedImage, deleteImage } from '../mongo/images.js';
import { dispatchSheetGeneration } from './sheetImageDispatch.js';
import { setCharacterSheetImageViaGateway } from './gateway.js';

// Allow tests to inject a fake dispatcher. The injected fn replaces
// `dispatchSheetGeneration`; signature: ({ prompt, model, quality,
// mainImageId, omitImages }) => { buffer, contentType, model, latencyMs }.
let dispatchImpl = dispatchSheetGeneration;
export function _setGeneratorForTests(fn) {
  dispatchImpl = fn;
}
export function _resetGeneratorForTests() {
  dispatchImpl = dispatchSheetGeneration;
}

export async function generateCharacterSheetForCharacter({
  characterId,
  quality = 'auto',
  model = 'gemini',
  omitImages = false,
}) {
  const character = await getCharacter(characterId);
  if (!character) {
    const err = new Error(`Character not found: ${characterId}`);
    err.status = 404;
    throw err;
  }

  const specifics = character.specifics || {};
  const characterName = stripMarkdown(character.name || '') || null;
  const prompt = buildCharacterSheetPrompt(specifics, { characterName });

  const { buffer, contentType, model: usedModel, latencyMs, usedInputImage } =
    await dispatchImpl({
      prompt,
      model,
      quality,
      mainImageId: character.main_image_id || null,
      omitImages,
    });

  const cid = character._id.toString();
  const file = await uploadGeneratedImage({
    buffer,
    contentType,
    prompt,
    generatedBy: usedModel || model,
    ownerType: 'character',
    ownerId: cid,
    filename: `character-sheet-${cid}-${Date.now()}.png`,
  });

  const previousId = character.character_sheet_image_id
    ? character.character_sheet_image_id.toString()
    : null;

  await setCharacterSheetImageViaGateway({
    character: cid,
    imageId: file._id.toString(),
  });

  if (previousId && previousId !== file._id.toString()) {
    try {
      await deleteImage(previousId);
    } catch (e) {
      logger.warn(`character sheet: failed to delete old image ${previousId}: ${e.message}`);
    }
  }

  logger.info(
    `character sheet: character=${cid} image=${file._id} model=${usedModel} input_image=${usedInputImage ? 'yes' : 'no'} quality=${quality} ${latencyMs ?? '?'}ms`,
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
