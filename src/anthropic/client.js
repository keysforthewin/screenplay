// Single Anthropic client for the whole process. The Anthropic SDK refuses to
// instantiate when `globalThis.window` is defined (its "running in a browser"
// guard). `src/web/headlessEditor.js` deliberately installs JSDOM globals so
// server-side Tiptap can run, which trips that guard. We dodge it by
// constructing the client BEFORE the first gateway operation (eagerly at boot
// from `src/index.js`) and caching the result.
//
// Tests can call `_setAnthropicClientForTests(fake)` to swap the singleton.
//
// The client handed out is a thin ROUTING wrapper: `messages.create|stream`
// with a coding-agent model id (`claude-code:…` / `codex:…`, produced by
// modelFor() when Admin → Models points a slot at a harness) go to
// src/llm/harness/; everything else reaches the real SDK untouched.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { harnessCreate, harnessStream, isHarnessModelId } from '../llm/harness/index.js';

let cached = null;

export function createRoutingClient(base) {
  const messages = Object.create(base.messages);
  messages.create = (params, opts) =>
    isHarnessModelId(params?.model) ? harnessCreate(params, { signal: opts?.signal }) : base.messages.create(params, opts);
  messages.stream = (params, opts) =>
    isHarnessModelId(params?.model) ? harnessStream(params) : base.messages.stream(params, opts);
  // No token counting through a harness; callers treat a throw as "unknown".
  messages.countTokens = (params, opts) =>
    isHarnessModelId(params?.model)
      ? Promise.reject(new Error('token counting is not available for coding-agent models'))
      : base.messages.countTokens(params, opts);
  const client = Object.create(base);
  Object.defineProperty(client, 'messages', { value: messages });
  return client;
}

export function getAnthropic() {
  if (cached) return cached;
  cached = createRoutingClient(new Anthropic({ apiKey: config.anthropic.apiKey }));
  return cached;
}

export function _setAnthropicClientForTests(client) {
  cached = client;
}

export function _resetAnthropicClientForTests() {
  cached = null;
}
