// characterSheet.js
//
// Generates a UE5 MetaHuman-style production character sheet. The user picks
// the model (Gemini Nano Banana or OpenAI gpt-image-2), may opt to send one
// or more reference images (multi-select), and may override the prompt that
// would otherwise be built from the character's `specifics.*` fields. The
// resulting GridFS file is appended to the character's
// `character_sheet_image_ids[]` array — old sheets are kept until the user
// deletes them.
//
// Called by POST /api/character/:id/character-sheet in entityRoutes.js.

import { logger } from '../log.js';
import { buildCharacterSheetPrompt } from '../util/specifics.js';
import { stripMarkdown } from '../util/markdown.js';
import { getCharacter } from '../mongo/characters.js';
import { uploadGeneratedImage } from '../mongo/images.js';
import { dispatchSheetGeneration } from './sheetImageDispatch.js';
import { appendCharacterSheetImageViaGateway } from './gateway.js';

// Allow tests to inject a fake dispatcher. The injected fn replaces
// `dispatchSheetGeneration`; signature: ({ prompt, model, quality,
// mainImageId, referenceImageIds, omitImages }) => { buffer, contentType,
// model, latencyMs, usedInputImage, inputImageCount }.
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
  customPrompt = null,
  sheetName = null,
  referenceImageIds = null,
  discordUser = null,
  channelId = null,
}) {
  const character = await getCharacter(characterId);
  if (!character) {
    const err = new Error(`Character not found: ${characterId}`);
    err.status = 404;
    throw err;
  }

  const specifics = character.specifics || {};
  const characterName = stripMarkdown(character.name || '') || null;
  const trimmedCustom = typeof customPrompt === 'string' ? customPrompt.trim() : '';
  const prompt = trimmedCustom
    ? trimmedCustom
    : buildCharacterSheetPrompt(specifics, { characterName });

  // Validate any provided reference image ids belong to this character's
  // portrait gallery. The dispatch layer will silently skip ids that fail
  // to load, but we want a clear 4xx for unknown ids rather than swallowing.
  let validatedRefs = null;
  if (Array.isArray(referenceImageIds) && referenceImageIds.length) {
    const allowed = new Set(
      (character.images || [])
        .map((img) => img?._id?.toString?.())
        .filter(Boolean),
    );
    if (character.main_image_id) allowed.add(character.main_image_id.toString());
    const seen = new Set();
    validatedRefs = [];
    for (const raw of referenceImageIds) {
      const id = String(raw || '');
      if (!/^[a-f0-9]{24}$/i.test(id)) {
        const err = new Error(`reference_image_ids: ${id} is not a 24-hex string.`);
        err.status = 400;
        throw err;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      if (!allowed.has(id)) {
        const err = new Error(`reference_image_ids: ${id} is not attached to this character.`);
        err.status = 400;
        throw err;
      }
      validatedRefs.push(id);
    }
  }

  const { buffer, contentType, model: usedModel, latencyMs, usedInputImage, inputImageCount } =
    await dispatchImpl({
      prompt,
      model,
      quality,
      mainImageId: character.main_image_id || null,
      referenceImageIds: validatedRefs,
      omitImages,
      discordUser,
      channelId,
    });

  const cid = character._id.toString();
  const existingCount = Array.isArray(character.character_sheet_image_ids)
    ? character.character_sheet_image_ids.length
    : character.character_sheet_image_id
      ? 1
      : 0;
  const finalSheetName =
    typeof sheetName === 'string' && sheetName.trim()
      ? sheetName.trim()
      : `Sheet ${existingCount + 1}`;

  const file = await uploadGeneratedImage({
    buffer,
    contentType,
    prompt,
    generatedBy: usedModel || model,
    ownerType: 'character',
    ownerId: cid,
    name: finalSheetName,
    filename: `character-sheet-${cid}-${Date.now()}.png`,
  });

  await appendCharacterSheetImageViaGateway({
    character: cid,
    imageId: file._id.toString(),
  });

  logger.info(
    `character sheet: character=${cid} image=${file._id} name="${finalSheetName}" model=${usedModel} input_images=${inputImageCount ?? (usedInputImage ? 1 : 0)} quality=${quality} ${latencyMs ?? '?'}ms`,
  );
  return {
    image_id: file._id.toString(),
    content_type: file.content_type,
    size: file.size,
    quality,
    model: usedModel,
    used_input_image: !!usedInputImage,
    input_image_count: inputImageCount ?? (usedInputImage ? 1 : 0),
    sheet_name: finalSheetName,
    latency_ms: latencyMs ?? null,
  };
}
