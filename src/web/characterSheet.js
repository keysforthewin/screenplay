// characterSheet.js
//
// Generates a UE5 MetaHuman-style production character sheet from the
// character's `specifics.*` fields using OpenAI gpt-image-2. The result is
// stored in GridFS and recorded as `character.character_sheet_image_id`.
//
// Replace-on-regenerate: if the character already has a sheet, the prior
// GridFS file is deleted after the new one is recorded.
//
// Called by POST /api/character/:id/character-sheet in entityRoutes.js.

import { config } from '../config.js';
import { logger } from '../log.js';
import { buildCharacterSheetPrompt } from '../util/specifics.js';
import { stripMarkdown } from '../util/markdown.js';
import { getCharacter } from '../mongo/characters.js';
import { uploadGeneratedImage, deleteImage } from '../mongo/images.js';
import { generateCharacterSheetImage, GPT_IMAGE_MODEL } from '../openai/imageClient.js';
import { setCharacterSheetImageViaGateway } from './gateway.js';

// Allow tests to inject a fake generator.
let generatorImpl = generateCharacterSheetImage;
export function _setGeneratorForTests(fn) {
  generatorImpl = fn;
}
export function _resetGeneratorForTests() {
  generatorImpl = generateCharacterSheetImage;
}

export async function generateCharacterSheetForCharacter({ characterId, quality = 'auto' }) {
  if (!config.openai.apiKey) {
    const err = new Error('OPENAI_API_KEY is not configured.');
    err.status = 400;
    throw err;
  }
  const character = await getCharacter(characterId);
  if (!character) {
    const err = new Error(`Character not found: ${characterId}`);
    err.status = 404;
    throw err;
  }

  const specifics = character.specifics || {};
  const characterName = stripMarkdown(character.name || '') || null;
  const prompt = buildCharacterSheetPrompt(specifics, { characterName });

  const { buffer, contentType, model, latencyMs } = await generatorImpl({
    prompt,
    size: '1536x1024',
    quality,
  });

  const cid = character._id.toString();
  const file = await uploadGeneratedImage({
    buffer,
    contentType,
    prompt,
    generatedBy: model || GPT_IMAGE_MODEL,
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
    `character sheet: character=${cid} image=${file._id} quality=${quality} ${latencyMs ?? '?'}ms`,
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
