// Vision pass for generated artwork: look at the rendered plate and write a
// `description` onto the artwork doc (plus a `name`, when it has none yet).
//
// Artwork descriptions matter for more than browsing. The frame-reference
// scorer reads them (src/web/frameReferences.js) when deciding which plates to
// feed a storyboard frame, and the readiness report flags galleries that have
// none. Generated artwork used to lean on its own `prompt` for that, which
// says what was ASKED for rather than what came back — and imported artwork
// has no prompt at all.
//
// Two entry points, same work:
//   describeArtwork()          — awaited, throws; backs the manual "Describe"
//                                button (POST .../artwork/:id/describe).
//   kickoffArtworkVisionSeed() — fire-and-forget, never throws; runs after a
//                                render lands and on the entity-GET backfill.
//
// Mirrors src/web/libraryVisionWorker.js, which does the same job for plain
// gallery images (those live in GridFS metadata; artwork lives in the host
// doc's artworks[] array, so the two can't share a writer).

import { logger } from '../log.js';
import { describeReferenceImage } from '../llm/referenceImageDescription.js';
import { readImageBuffer } from '../mongo/images.js';
import { getArtwork } from '../mongo/artworks.js';
import { patchArtworkViaGateway } from './gateway.js';

// A set's plates are locations, a character's are portraits; beat artwork is
// mixed, so it gets the catch-all describer.
const KIND_BY_HOST = {
  character: 'character',
  set: 'location',
  beat: 'auto',
};

// Describe one artwork and persist the result. Throws on a missing artwork,
// a missing result image, or a provider error — callers that must not fail
// (the render pipeline, the lazy backfill) go through the kickoff wrapper.
//
// `buffer`/`contentType` may be supplied by a caller that already has the
// bytes in hand (the generate path does); otherwise they're read from GridFS.
export async function describeArtwork({
  projectId,
  hostType,
  hostId,
  artworkId,
  buffer = null,
  contentType = null,
}) {
  const found = await getArtwork({ projectId, hostType, hostId, artworkId });
  if (!found?.artwork) {
    const err = new Error(`Artwork ${artworkId} not found on ${hostType} ${hostId}`);
    err.status = 404;
    throw err;
  }
  const artwork = found.artwork;
  const resultImageId = artwork.result_image_id;
  if (!resultImageId) {
    const err = new Error('Artwork has no result image to describe yet.');
    err.status = 400;
    throw err;
  }

  let buf = buffer;
  let ct = contentType;
  if (!Buffer.isBuffer(buf) || !ct) {
    const downloaded = await readImageBuffer(String(resultImageId));
    if (!downloaded) {
      const err = new Error(`Artwork result image not found: ${resultImageId}`);
      err.status = 404;
      throw err;
    }
    buf = downloaded.buffer;
    ct = downloaded.file?.contentType || ct;
  }

  const kind = KIND_BY_HOST[hostType] || 'auto';
  const { name, description } = await describeReferenceImage({
    buffer: buf,
    contentType: ct,
    kind,
  });

  // describeReferenceImage collapses its own failures to empty strings, so an
  // empty result is "nothing to say", not an error. Never overwrite a name the
  // user (or the planner) chose — only fill a blank one.
  const patch = {};
  if (description) patch.description = description;
  if (name && !String(artwork.name || '').trim()) patch.name = name;
  if (!Object.keys(patch).length) {
    logger.info(`artwork describe: ${hostType}:${hostId} artwork=${artworkId} produced nothing`);
    return { artwork, changed: false };
  }

  const updated = await patchArtworkViaGateway({
    projectId,
    hostType,
    hostId,
    artworkId,
    patch,
  });
  logger.info(
    `artwork describe: ${hostType}:${hostId} artwork=${artworkId} ` +
      `desc=${(patch.description || '').length}c name=${!!patch.name}`,
  );
  return { artwork: updated.artwork, changed: true };
}

// In-memory guard so several triggers for the same artwork (a render landing
// while two browser tabs both fire the lazy backfill) collapse to one call.
const inFlight = new Set();

export function kickoffArtworkVisionSeed({
  projectId,
  hostType,
  hostId,
  artworkId,
  buffer = null,
  contentType = null,
}) {
  if (!artworkId) return;
  const key = String(artworkId);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  queueMicrotask(async () => {
    try {
      await describeArtwork({ projectId, hostType, hostId, artworkId, buffer, contentType });
    } catch (e) {
      logger.warn(`artwork describe failed ${hostType}:${hostId} artwork=${key}: ${e.message}`);
    } finally {
      inFlight.delete(key);
    }
  });
}
