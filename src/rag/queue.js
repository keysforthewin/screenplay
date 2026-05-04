// In-process debounce queue for reindex operations. Keyed by
// "<entityType>:<entityId>". Multiple enqueues for the same key collapse into
// a single delayed run; if a run is in flight when a new enqueue arrives, the
// next run is chained behind the current promise.
//
// Errors are caught and logged. A failed run is re-enqueued at most once with
// a 5s backoff; beyond that, the item is dropped (the CLI reindex script is
// the recovery path).

import { config } from '../config.js';
import { logger } from '../log.js';

const FAIL_RETRY_MS = 5000;

const pending = new Map(); // key -> { timer, retries }
const inflight = new Map(); // key -> Promise

let _runner = null;

// The runner is lazy-injected to avoid an indexer ↔ queue import cycle.
export function setReindexRunner(fn) {
  _runner = fn;
}

function keyFor(entityType, entityId) {
  return `${entityType}:${entityId}`;
}

async function runOne(entityType, entityId) {
  if (!_runner) return;
  const key = keyFor(entityType, entityId);
  const prior = inflight.get(key);
  if (prior) {
    // Chain after the current run.
    inflight.set(
      key,
      prior.finally(() => runOne(entityType, entityId)).catch(() => {}),
    );
    return inflight.get(key);
  }
  const p = (async () => {
    try {
      await _runner(entityType, entityId);
    } catch (e) {
      const state = pending.get(key);
      const retries = state?.retries ?? 0;
      if (retries < 1) {
        logger.warn(
          `rag: reindex failed (${key}) — retry in ${FAIL_RETRY_MS}ms: ${e.message}`,
        );
        const timer = setTimeout(() => {
          pending.delete(key);
          runOne(entityType, entityId);
        }, FAIL_RETRY_MS);
        pending.set(key, { timer, retries: retries + 1 });
      } else {
        logger.warn(`rag: reindex dropped (${key}) after retries: ${e.message}`);
      }
    }
  })();
  inflight.set(key, p);
  try {
    await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

export function enqueueReindex(entityType, entityId) {
  if (!entityType || !entityId) return;
  const key = keyFor(entityType, entityId);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);
  const delay = config.rag?.debounceMs ?? 1000;
  const timer = setTimeout(() => {
    pending.delete(key);
    runOne(entityType, String(entityId));
  }, delay);
  pending.set(key, { timer, retries: 0 });
}

export async function flushAll() {
  // Trigger all pending timers immediately and wait for everything in-flight.
  const items = [...pending.entries()];
  for (const [key, state] of items) {
    clearTimeout(state.timer);
    pending.delete(key);
    const [entityType, entityId] = key.split(':');
    // fire-and-forget; in-flight tracking handles awaiting
    runOne(entityType, entityId);
  }
  // Wait for anything currently in flight.
  while (inflight.size) {
    await Promise.allSettled([...inflight.values()]);
  }
}

export function _resetForTests() {
  for (const state of pending.values()) clearTimeout(state.timer);
  pending.clear();
  inflight.clear();
  _runner = null;
}
