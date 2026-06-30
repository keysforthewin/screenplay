// editAttribution.js
//
// Carries the "on behalf of" web-user identity for the current async scope so
// the mutation gateway can attribute AI-driven text edits to the human who
// triggered them (instead of tagging them as the bot). Used by the chat agent
// (set explicitly — it detaches onto a mutex) and by an entityRoutes middleware
// that wraps every authenticated request.

import { AsyncLocalStorage } from 'node:async_hooks';

const editorStore = new AsyncLocalStorage();

// Run `fn` with `name` as the attributed editor. A falsy/blank name runs `fn`
// with no scope, so callers don't need to branch. Returns whatever `fn` returns
// (sync value or Promise), so it wraps both `() => next()` and `() => runAgent(...)`.
export function runAsEditor(name, fn) {
  const editor = typeof name === 'string' && name.trim() ? name.trim() : null;
  if (!editor) return fn();
  return editorStore.run({ name: editor }, fn);
}

// The attributed editor name for the current scope, or null.
export function currentEditor() {
  return editorStore.getStore()?.name ?? null;
}
