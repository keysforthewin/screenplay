// Async artwork generation pipeline. Routes (POST /character/:id/artwork,
// POST /beat/:id/artwork, regenerate / edit) call into this module which:
//
//   1. Creates / locates the artwork doc (with status='pending'), broadcasts.
//   2. Returns the artwork to the caller immediately so the HTTP request is
//      ~10ms instead of ~30s.
//   3. Runs the actual provider call in `setImmediate`.
//   4. On completion, updates the artwork doc with the new result image and
//      broadcasts another `fields_updated` ping so connected SPAs re-render.
//   5. On failure, sets status='error' + error_message and broadcasts.
//
// State lives entirely on the artwork doc (via the artworks.js helpers) —
// no in-memory job map. The SPA picks up updates through the existing
// CollabSurface stateless broadcasts.
//
// Provider dispatch:
//   - generate / regenerate / edit → dispatchImageReplace() with the
//     user-selected model (nano-banana-pro | flux-2-pro | flux-pro-kontext |
//     openai). Edit mode passes the artwork's current result image as the
//     existing image; generate/regenerate use any reference images.

import { logger } from '../log.js';
import { readImageBuffer, uploadGeneratedImage } from '../mongo/images.js';
import {
  createPendingArtworkViaGateway,
  setArtworkStatusViaGateway,
  setArtworkResultViaGateway,
  patchArtworkViaGateway,
  undoArtworkEditViaGateway,
  removeArtworkViaGateway,
} from './gateway.js';
import { isValidImageModel, IMAGE_MODEL_ERROR } from './imageModelValidate.js';
import { kickoffArtworkVisionSeed } from './artworkVisionWorker.js';
import { announceMediaEvent } from '../discord/announcer.js';
import { beatUrl, characterUrl, setUrl } from './links.js';
import { getBeat } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { getSet } from '../mongo/sets.js';
import { getProjectById } from '../mongo/projects.js';
import { stripMarkdown } from '../util/markdown.js';

async function announceArtwork({ projectId, hostType, hostId, username, verb, fileId, prompt }) {
  try {
    if (!username) return;
    const project = projectId ? await getProjectById(projectId) : null;
    const projectTitle = project?.title ?? null;
    let entityLabel = null;
    let entityUrl = null;
    if (hostType === 'beat') {
      const beat = await getBeat(projectId, String(hostId));
      if (beat) {
        const name = stripMarkdown(beat.name || '').trim();
        const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
        entityLabel = name ? `${order}: ${name}` : order;
        entityUrl = beatUrl(projectTitle, beat);
      }
    } else if (hostType === 'character') {
      const character = await getCharacter(projectId, String(hostId));
      if (character) {
        const name = stripMarkdown(character.name || '').trim() || 'character';
        entityLabel = `Character: ${name}`;
        entityUrl = characterUrl(projectTitle, character);
      }
    } else if (hostType === 'set') {
      const set = await getSet(projectId, String(hostId));
      if (set) {
        const name = stripMarkdown(set.name || '').trim() || 'set';
        entityLabel = `Set: ${name}`;
        entityUrl = setUrl(projectTitle, set);
      }
    }
    announceMediaEvent({
      username,
      verb,
      entityLabel,
      entityUrl,
      imageFileId: fileId,
      prompt,
    }).catch(() => {});
  } catch (e) {
    logger.warn(`announceArtwork failed: ${e?.message || e}`);
  }
}

const DEFAULT_ARTWORK_MODEL = 'nano-banana-pro';

function logCrash(prefix, err) {
  logger.error(`${prefix}: ${err?.message || err}`);
  if (err?.stack) logger.debug(err.stack);
}

async function validateArtworkModel(model) {
  if (!(await isValidImageModel(model))) {
    const err = new Error(IMAGE_MODEL_ERROR);
    err.status = 400;
    throw err;
  }
}

// Resolve a list of image ids to {buffer, contentType} entries. Bad ids
// throw so the runner can mark the artwork as errored.
async function loadImageBuffers(imageIds) {
  const out = [];
  for (const id of imageIds || []) {
    const r = await readImageBuffer(id);
    if (!r) throw new Error(`Reference image ${id} not found`);
    const declared = r.file.contentType || r.file.metadata?.contentType || null;
    out.push({ buffer: r.buffer, contentType: declared || 'image/png' });
  }
  return out;
}

async function runProviderForGenerate({ prompt, model, referenceImages, discordUser, channelId }) {
  const { dispatchImageReplace } = await import('./imageReplaceDispatch.js');
  return dispatchImageReplace({
    prompt,
    mode: 'generate',
    model,
    referenceImages,
    discordUser,
    channelId,
  });
}

async function runProviderForEdit({ prompt, model, existingImage, referenceImages = [], discordUser, channelId }) {
  const { dispatchImageReplace } = await import('./imageReplaceDispatch.js');
  return dispatchImageReplace({
    prompt,
    mode: 'edit',
    model,
    existingImage,
    referenceImages,
    discordUser,
    channelId,
  });
}

// ── Generate (new artwork) ────────────────────────────────────────────────
// Creates a pending artwork on the host and kicks off the provider call.
// Returns the pending artwork immediately.
export async function startGenerateArtworkJob({
  projectId = null,
  hostType,
  hostId,
  prompt,
  name = '',
  model,
  referenceImageIds = [],
  discordUser = null,
  channelId = null,
  announceUsername = null,
}) {
  await validateArtworkModel(model);
  const { artwork } = await createPendingArtworkViaGateway({
    projectId,
    hostType,
    hostId,
    prompt,
    name,
    model,
    referenceImageIds,
  });
  setImmediate(() => {
    runGenerate({
      projectId,
      hostType,
      hostId,
      artworkId: artwork._id,
      prompt,
      model,
      referenceImageIds,
      discordUser,
      channelId,
      announceUsername,
      announceVerb: 'created artwork on',
    }).catch((e) => logCrash('artwork generate job', e));
  });
  return artwork;
}

// Generate one image for an ALREADY-CREATED pending artwork and flip it to
// `done`: load reference bytes → call the provider → upload to GridFS →
// record the generation parameters → setArtworkResult. Returns
// `{ fileId, model }` on success and THROWS on failure — the caller owns the
// error→status write. Shared by the single-artwork generate job (runGenerate
// below) and the image-sheet batch worker (src/web/imageSheetJobs.js) so the
// provider/upload/result policy lives in exactly one place.
//
// The artwork's `model` field deliberately stays the picker id the user chose
// ('flux-2-pro', a catalog endpoint id, …) — regenerate/retry validate it
// against the picker list, so overwriting it with the routed endpoint
// ('fal-ai/flux-2-pro/edit') would break both. What actually ran is recorded
// on `generation` instead, alongside the exact prompt and references sent, so
// any thumbnail can show precisely how its image was produced.
export async function generateArtworkImageInline({
  projectId = null,
  hostType,
  hostId,
  artworkId,
  prompt,
  model,
  referenceImageIds = [],
  discordUser = null,
  channelId = null,
}) {
  const referenceImages = await loadImageBuffers(referenceImageIds);
  const result = await runProviderForGenerate({
    prompt,
    model,
    referenceImages,
    discordUser,
    channelId,
  });
  const file = await uploadGeneratedImage(projectId, {
    buffer: result.buffer,
    contentType: result.contentType,
    prompt,
    generatedBy: result.model || model,
    ownerType: hostType,
    ownerId: hostId,
    filename: `${hostType}-${hostId}-artwork-${Date.now()}.png`,
  });
  await patchArtworkViaGateway({
    projectId,
    hostType,
    hostId,
    artworkId,
    patch: {
      generation: {
        requested_model: model,
        endpoint: result.model || model,
        mode: 'generate',
        prompt: String(prompt || ''),
        reference_image_ids: (referenceImageIds || []).map(String),
        reference_sent_count: Number.isFinite(result.inputImageCount)
          ? result.inputImageCount
          : referenceImages.length,
        completed_at: new Date(),
      },
    },
  });
  await setArtworkResultViaGateway({
    projectId,
    hostType,
    hostId,
    artworkId,
    resultImageId: file._id,
    rotateToPrevious: false,
  });
  // Describe what actually came back, using the bytes already in hand. Runs in
  // the background: the caller's job is done once the result is persisted, and
  // a vision hiccup must never fail a render that succeeded.
  kickoffArtworkVisionSeed({
    projectId,
    hostType,
    hostId,
    artworkId,
    buffer: result.buffer,
    contentType: result.contentType,
  });
  return { fileId: file._id, model: result.model || model };
}

async function runGenerate(opts) {
  const {
    projectId,
    hostType,
    hostId,
    artworkId,
    prompt,
    model,
    referenceImageIds,
    discordUser,
    channelId,
    announceUsername,
    announceVerb,
  } = opts;
  try {
    const { fileId } = await generateArtworkImageInline({
      projectId,
      hostType,
      hostId,
      artworkId,
      prompt,
      model,
      referenceImageIds,
      discordUser,
      channelId,
    });
    if (announceUsername) {
      announceArtwork({
        projectId,
        hostType,
        hostId,
        username: announceUsername,
        verb: announceVerb || 'created artwork on',
        fileId,
        prompt,
      });
    }
  } catch (err) {
    logger.warn(`artwork generate ${hostType}:${hostId} ${artworkId} failed: ${err.message}`);
    await setArtworkStatusViaGateway({
      projectId,
      hostType,
      hostId,
      artworkId,
      status: 'error',
      errorMessage: err.message,
    }).catch((e) => logCrash('artwork status persist', e));
  }
}

// ── Regenerate (existing artwork, fresh provider call) ────────────────────
// The artwork doc already exists. We update prompt/model/refs, flip status
// to pending, and kick off the provider. The old result_image_id is
// orphaned (deleted from GridFS) only after the new upload succeeds —
// handled by setArtworkResultViaGateway with rotateToPrevious=false.
export async function startRegenerateArtworkJob({
  projectId = null,
  hostType,
  hostId,
  artworkId,
  prompt,
  name = null,
  model,
  referenceImageIds = [],
  discordUser = null,
  channelId = null,
  announceUsername = null,
}) {
  await validateArtworkModel(model);
  const patch = { prompt, model, reference_image_ids: referenceImageIds };
  if (typeof name === 'string') patch.name = name;
  await patchArtworkViaGateway({ projectId, hostType, hostId, artworkId, patch });
  const { artwork } = await setArtworkStatusViaGateway({
    projectId,
    hostType,
    hostId,
    artworkId,
    status: 'pending',
  });
  setImmediate(() => {
    runGenerate({
      projectId,
      hostType,
      hostId,
      artworkId,
      prompt,
      model,
      referenceImageIds,
      discordUser,
      channelId,
      announceUsername,
      announceVerb: 'regenerated artwork on',
    }).catch((e) => logCrash('artwork regenerate job', e));
  });
  return artwork;
}

// ── Edit (in-line) ────────────────────────────────────────────────────────
// Loads the artwork's current `result_image_id`, sends it + the prompt to the
// user-selected model through the unified dispatcher, and on success rotates
// current → previous. Single-step undo is supported through
// previous_result_image_id; older previous images are deleted from GridFS by
// setArtworkResultViaGateway.
export async function startEditArtworkJob({
  projectId = null,
  hostType,
  hostId,
  artworkId,
  prompt,
  model = DEFAULT_ARTWORK_MODEL,
  referenceImageIds = [],
  discordUser = null,
  channelId = null,
  announceUsername = null,
}) {
  await validateArtworkModel(model);
  await patchArtworkViaGateway({
    projectId,
    hostType,
    hostId,
    artworkId,
    patch: { last_edit_prompt: prompt },
  });
  const { artwork } = await setArtworkStatusViaGateway({
    projectId,
    hostType,
    hostId,
    artworkId,
    status: 'pending',
  });
  setImmediate(() => {
    runEdit({
      projectId,
      hostType,
      hostId,
      artworkId,
      prompt,
      model,
      currentResultImageId: artwork.result_image_id,
      referenceImageIds,
      discordUser,
      channelId,
      announceUsername,
    }).catch((e) => logCrash('artwork edit job', e));
  });
  return artwork;
}

async function runEdit(opts) {
  const {
    projectId,
    hostType,
    hostId,
    artworkId,
    prompt,
    model,
    currentResultImageId,
    referenceImageIds = [],
    discordUser,
    channelId,
    announceUsername,
  } = opts;
  try {
    if (!currentResultImageId) {
      throw new Error('Cannot edit an artwork with no current result image.');
    }
    const r = await readImageBuffer(currentResultImageId);
    if (!r) {
      throw new Error(`Current result image ${currentResultImageId} not found in GridFS`);
    }
    const declared = r.file.contentType || r.file.metadata?.contentType || 'image/png';
    const referenceImages = await loadImageBuffers(referenceImageIds);
    const result = await runProviderForEdit({
      prompt,
      model,
      existingImage: { buffer: r.buffer, contentType: declared },
      referenceImages,
      discordUser,
      channelId,
    });
    const file = await uploadGeneratedImage(projectId, {
      buffer: result.buffer,
      contentType: result.contentType,
      prompt,
      generatedBy: result.model || model,
      ownerType: hostType,
      ownerId: hostId,
      filename: `${hostType}-${hostId}-artwork-edit-${Date.now()}.png`,
    });
    await patchArtworkViaGateway({
      projectId,
      hostType,
      hostId,
      artworkId,
      patch: {
        generation: {
          requested_model: model,
          endpoint: result.model || model,
          mode: 'edit',
          prompt: String(prompt || ''),
          existing_image_id: String(currentResultImageId),
          reference_image_ids: (referenceImageIds || []).map(String),
          // In edit mode the provider's input count includes the existing
          // image at position 0; references are everything after it.
          reference_sent_count: Number.isFinite(result.inputImageCount)
            ? Math.max(0, result.inputImageCount - 1)
            : referenceImages.length,
          completed_at: new Date(),
        },
      },
    });
    await setArtworkResultViaGateway({
      projectId,
      hostType,
      hostId,
      artworkId,
      resultImageId: file._id,
      rotateToPrevious: true,
    });
    // The picture changed, so the old description no longer matches it.
    kickoffArtworkVisionSeed({
      projectId,
      hostType,
      hostId,
      artworkId,
      buffer: result.buffer,
      contentType: result.contentType,
    });
    if (announceUsername) {
      announceArtwork({
        projectId,
        hostType,
        hostId,
        username: announceUsername,
        verb: 'edited artwork on',
        fileId: file._id,
        prompt,
      });
    }
  } catch (err) {
    logger.warn(`artwork edit ${hostType}:${hostId} ${artworkId} failed: ${err.message}`);
    await setArtworkStatusViaGateway({
      projectId,
      hostType,
      hostId,
      artworkId,
      status: 'error',
      errorMessage: err.message,
    }).catch((e) => logCrash('artwork status persist', e));
  }
}

// ── Undo (synchronous) ────────────────────────────────────────────────────
// Swap previous_result_image_id → result_image_id. The image that was
// current is deleted from GridFS by undoArtworkEditViaGateway.
export async function undoArtworkEdit({ projectId, hostType, hostId, artworkId }) {
  const { artwork } = await undoArtworkEditViaGateway({ projectId, hostType, hostId, artworkId });
  return artwork;
}

// ── Delete ────────────────────────────────────────────────────────────────
// Removes the artwork and purges its current + previous result images from
// GridFS. Returns the removed artwork doc.
export async function deleteArtwork({ projectId, hostType, hostId, artworkId }) {
  return removeArtworkViaGateway({ projectId, hostType, hostId, artworkId });
}
