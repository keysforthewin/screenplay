// In-process per-beat mutex for background jobs that rewrite a beat's rows.
//
// The cut planner (which deletes a beat's scenes and cuts then recreates
// them), the render jobs and the assemblers must never run against the same beat
// concurrently — otherwise an edit applied against a stale snapshot would race
// the deletion, and two concurrent generates would each delete-then-recreate
// and stack the new items.
//
// `withBeatLock` queues `fn` behind any prior work for the same beat. The
// generation route uses `isBeatLocked` to refuse to even start a second job
// for a beat (mis-clicks shouldn't queue an expensive Anthropic+Gemini run).

const beatLocks = new Map(); // beatId(string) → tail Promise

export function withBeatLock(beatId, fn) {
  const key = String(beatId);
  const prev = beatLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (beatLocks.get(key) === next) beatLocks.delete(key);
  });
  beatLocks.set(key, next);
  return next;
}

export function isBeatLocked(beatId) {
  return beatLocks.has(String(beatId));
}

export function _clearBeatLocksForTests() {
  beatLocks.clear();
}
