// Shared job-status helpers for the in-memory job registries on the Scenes
// tab. A page that was closed and reopened REATTACHES to a job: it keeps
// running on the server regardless of who watches, and one that ended in the
// last RECENT_JOB_MS is still reported.

export const RECENT_JOB_MS = 10 * 60 * 1000;

const TERMINAL = new Set(['done', 'partial', 'error']);

export function isTerminalJobStatus(status) {
  return TERMINAL.has(status);
}
