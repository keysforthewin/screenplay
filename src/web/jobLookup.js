// Shared "which job belongs to this beat?" lookup for the in-memory job
// registries on the Prompts tab. A page that was closed and reopened uses it
// to REATTACH: the job keeps running on the server regardless of who watches.
//
// Preference: the newest job still running; else the newest one that finished
// within `recentMs` (so coming back just after it ended still shows the
// result and its log); else null.

export const RECENT_JOB_MS = 10 * 60 * 1000;

const TERMINAL = new Set(['done', 'partial', 'error']);

export function isTerminalJobStatus(status) {
  return TERMINAL.has(status);
}

export function latestJobForBeat(jobs, beatId, { recentMs = RECENT_JOB_MS, filter = null } = {}) {
  const id = String(beatId || '');
  if (!id) return null;
  const mine = [...jobs.values()].filter((j) => String(j.beat_id) === id && (!filter || filter(j)));
  if (!mine.length) return null;
  const ts = (d) => (d ? new Date(d).getTime() : 0);
  const active = mine.filter((j) => !TERMINAL.has(j.status)).sort((a, b) => ts(b.started_at) - ts(a.started_at));
  if (active.length) return active[0];
  const cutoff = Date.now() - recentMs;
  const recent = mine.filter((j) => ts(j.finished_at) >= cutoff).sort((a, b) => ts(b.finished_at) - ts(a.finished_at));
  return recent[0] || null;
}
