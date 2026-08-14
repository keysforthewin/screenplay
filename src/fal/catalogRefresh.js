// Server-triggered regeneration of data/fal-models.json — the same two-step
// scrape as `npm run refresh:fal-models`, run as child processes so the
// long-lived bot process isn't blocked (the full pass takes a few minutes:
// one paged model listing plus one OpenAPI fetch per video endpoint).
//
// Single-flight: only one refresh runs at a time, process-wide. State lives
// in this module (not Mongo) — a crashed refresh just means the button can be
// clicked again after restart, and the catalog file on disk is only replaced
// by the cluster script's final write, so a failed run never corrupts it.
import { spawn } from 'node:child_process';

const SCRIPTS = [
  'scripts/list-fal-video-models.js',
  'scripts/cluster-fal-video-models.js',
];

const state = {
  running: false,
  started_at: null,
  finished_at: null,
  error: null,
  // Last stderr line from the running script — the scrape logs per-model
  // progress ("[42/349] ok: fal-ai/..."), which the SPA surfaces verbatim.
  progress: null,
};

export function getCatalogRefreshState() {
  return { ...state };
}

export function startCatalogRefresh() {
  if (state.running) {
    return { started: false, state: getCatalogRefreshState() };
  }
  state.running = true;
  state.started_at = new Date().toISOString();
  state.finished_at = null;
  state.error = null;
  state.progress = 'Starting…';
  runScriptsSequentially()
    .catch((e) => {
      state.error = e?.message || String(e);
    })
    .finally(() => {
      state.running = false;
      state.finished_at = new Date().toISOString();
      state.progress = null;
    });
  return { started: true, state: getCatalogRefreshState() };
}

async function runScriptsSequentially() {
  for (const script of SCRIPTS) {
    await runScript(script);
  }
}

function runScript(script) {
  return new Promise((resolve, reject) => {
    // cwd is the repo root in every run mode (npm scripts, docker WORKDIR),
    // which the scripts' relative paths (scripts/output/, data/) rely on.
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let tail = '';
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t) {
          state.progress = t;
          tail = t;
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}${tail ? ` — ${tail}` : ''}`));
    });
  });
}
