// Single Anthropic client for the whole process. The Anthropic SDK refuses to
// instantiate when `globalThis.window` is defined (its "running in a browser"
// guard). `src/web/headlessEditor.js` deliberately installs JSDOM globals so
// server-side Tiptap can run, which trips that guard. We dodge it by
// constructing the client BEFORE the first gateway operation (eagerly at boot
// from `src/index.js`) and caching the result.
//
// Tests can call `_setAnthropicClientForTests(fake)` to swap the singleton.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let cached = null;

export function getAnthropic() {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: config.anthropic.apiKey });
  return cached;
}

export function _setAnthropicClientForTests(client) {
  cached = client;
}

export function _resetAnthropicClientForTests() {
  cached = null;
}
