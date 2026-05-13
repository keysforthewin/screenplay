// Shared fal.ai storage upload helper. Used by the video orchestrator
// (src/web/falVideoGenerate.js) and by the Sora character builder
// (src/fal/soraCharacters.js). Kept in src/fal/ so callers in src/fal/ can
// import it without creating an src/fal/ ↔ src/web/ cycle.

import { config } from '../config.js';
import { fal } from './client.js';

// Build a File-like Blob and hand it to fal.storage.upload. fal returns a
// public URL with the configured lifecycle. We give every upload a
// human-friendly filename so fal's logs / dashboards stay readable.
export async function uploadFalAsset({ buffer, contentType, name }) {
  const expiresIn = `${Math.max(1, config.fal.storageLifetimeDays)}d`;
  const file = new File([buffer], name || `asset-${Date.now()}.bin`, {
    type: contentType || 'application/octet-stream',
  });
  return fal.storage.upload(file, { lifecycle: { expiresIn } });
}
