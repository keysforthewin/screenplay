// Fire-and-forget worker that runs after a library image is uploaded.
// Calls the vision LLM to generate a name + description, then writes them
// through the gateway so connected SPAs see the fields hydrate live.
//
// Never throws — failures are logged and swallowed. Callers do NOT await this
// (nothing to wait for from the user's perspective).

import { logger } from '../log.js';
import { analyzeLibraryImage } from '../llm/libraryImageMeta.js';
import { setLibraryImageMetaViaGateway } from './gateway.js';

export function kickoffLibraryVisionSeed(imageId, buffer, contentType) {
  if (!imageId || !Buffer.isBuffer(buffer) || !contentType) return;
  // Run on the next tick so the calling response can flush first.
  queueMicrotask(async () => {
    try {
      const { name, description } = await analyzeLibraryImage(buffer, contentType);
      if (!name && !description) {
        logger.info(`vision seed: image=${imageId} produced no caption`);
        return;
      }
      await setLibraryImageMetaViaGateway({
        imageId: String(imageId),
        name: name || undefined,
        description: description || undefined,
      });
      logger.info(`vision seed: image=${imageId} wrote name=${!!name} desc=${!!description}`);
    } catch (e) {
      logger.warn(`vision seed failed image=${imageId}: ${e.message}`);
    }
  });
}
