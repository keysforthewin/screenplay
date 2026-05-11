// Thin wrapper around `@fal-ai/client`. Configures the SDK singleton once
// against config.fal.apiKey and re-exports it.
//
// Graceful-missing-key pattern: callers should check `isConfigured()` before
// touching anything that hits fal; we never throw at import time, so the rest
// of the bot keeps working when FAL_KEY is unset.

import { fal } from '@fal-ai/client';
import { config } from '../config.js';

if (config.fal.apiKey) {
  fal.config({ credentials: config.fal.apiKey });
}

export function isConfigured() {
  return Boolean(config.fal.apiKey);
}

export { fal };
