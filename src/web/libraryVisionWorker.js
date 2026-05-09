// Fire-and-forget worker that runs after an image is uploaded (or when a
// page-load discovers an owned image with no name/description). Calls the
// vision LLM to generate a name + description, then writes them through the
// gateway so connected SPAs see the fields hydrate live.
//
// Never throws — failures are logged and swallowed. Callers do NOT await
// this (nothing to wait for from the user's perspective). An in-memory
// dedup set prevents the same image from being captioned in parallel by
// multiple lazy-backfill triggers (e.g. several browser tabs refreshing).

import { logger } from '../log.js';
import { analyzeLibraryImage } from '../llm/libraryImageMeta.js';
import { readImageBuffer } from '../mongo/images.js';
import {
  setLibraryImageMetaViaGateway,
  setOwnedImageMetaViaGateway,
} from './gateway.js';

const inFlight = new Set();

function markStart(imageId) {
  if (inFlight.has(imageId)) return false;
  inFlight.add(imageId);
  return true;
}

function markDone(imageId) {
  inFlight.delete(imageId);
}

async function writeMeta({ imageId, ownerType, ownerId, name, description }) {
  if (ownerType === 'beat' || ownerType === 'character') {
    await setOwnedImageMetaViaGateway({
      imageId: String(imageId),
      ownerType,
      ownerId: String(ownerId),
      name: name || undefined,
      description: description || undefined,
    });
    return;
  }
  await setLibraryImageMetaViaGateway({
    imageId: String(imageId),
    name: name || undefined,
    description: description || undefined,
  });
}

// Core worker — schedules a microtask, calls the vision LLM, writes results.
//
// `buffer` and `contentType` may be omitted; in that case the worker
// downloads the image bytes from GridFS itself. This is the path used by
// the lazy-backfill on GET /character and GET /beat where we don't have
// the buffer in hand.
export function kickoffImageVisionSeed(
  imageId,
  buffer = null,
  contentType = null,
  { ownerType = null, ownerId = null } = {},
) {
  if (!imageId) return;
  const idStr = String(imageId);
  if (!markStart(idStr)) return;
  queueMicrotask(async () => {
    try {
      let buf = buffer;
      let ct = contentType;
      if (!Buffer.isBuffer(buf) || !ct) {
        const downloaded = await readImageBuffer(idStr);
        if (!downloaded) {
          logger.warn(`vision seed: image=${idStr} not found`);
          return;
        }
        buf = downloaded.buffer;
        ct = downloaded.file?.contentType || ct;
      }
      const { name, description } = await analyzeLibraryImage(buf, ct);
      if (!name && !description) {
        logger.info(`vision seed: image=${idStr} produced no caption`);
        return;
      }
      await writeMeta({
        imageId: idStr,
        ownerType,
        ownerId,
        name,
        description,
      });
      logger.info(
        `vision seed: image=${idStr} owner=${ownerType || 'library'}/${ownerId || '-'} ` +
          `wrote name=${!!name} desc=${!!description}`,
      );
    } catch (e) {
      logger.warn(`vision seed failed image=${idStr}: ${e.message}`);
    } finally {
      markDone(idStr);
    }
  });
}

// Backwards-compatible alias used by the existing library upload route.
export function kickoffLibraryVisionSeed(imageId, buffer, contentType) {
  kickoffImageVisionSeed(imageId, buffer, contentType);
}
