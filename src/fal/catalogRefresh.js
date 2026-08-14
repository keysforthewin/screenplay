// Server-triggered regeneration of the fal.ai catalogs — the same scrapes as
// `npm run refresh:fal-models` / `npm run refresh:playground-models`, run as
// child processes so the long-lived bot process isn't blocked (a full pass
// takes a few minutes: one paged model listing plus one OpenAPI fetch per
// endpoint).
//
// Two independent jobs, each with its own single-flight slot:
//   video — data/fal-models.json, behind the Generate-video dialog's picker
//   image — data/fal-playground-models.json, which also backs the image-model
//           picker (src/fal/imageModelCatalog.js narrows it to image output)
//
// Single-flight per job, process-wide. State lives in this module (not Mongo) —
// a crashed refresh just means the button can be clicked again after restart,
// and each catalog file on disk is only replaced by its script's final write,
// so a failed run never corrupts it.
import { spawn } from 'node:child_process';

const JOB_SCRIPTS = {
  video: ['scripts/list-fal-video-models.js', 'scripts/cluster-fal-video-models.js'],
  image: ['scripts/build-fal-playground-catalog.js'],
};

function freshState() {
  return {
    running: false,
    started_at: null,
    finished_at: null,
    error: null,
    // Last stderr line from the running script — the scrapes log per-model
    // progress ("[42/349] ok: fal-ai/..."), which the SPA surfaces verbatim.
    progress: null,
  };
}

const states = new Map(Object.keys(JOB_SCRIPTS).map((job) => [job, freshState()]));

function stateFor(job) {
  const state = states.get(job);
  if (!state) {
    throw new Error(`unknown catalog job "${job}" (expected: ${Object.keys(JOB_SCRIPTS).join('|')})`);
  }
  return state;
}

// Test seam: swap the child-process spawn for a stub so the suite never
// actually scrapes fal.ai. Pass null to restore the real runner.
let scriptRunnerOverride = null;
export function _setScriptRunnerForTests(fn) {
  scriptRunnerOverride = fn;
}

export function getCatalogRefreshState(job = 'video') {
  return { ...stateFor(job) };
}

export function startCatalogRefresh(job = 'video') {
  const state = stateFor(job);
  if (state.running) {
    return { started: false, state: getCatalogRefreshState(job) };
  }
  state.running = true;
  state.started_at = new Date().toISOString();
  state.finished_at = null;
  state.error = null;
  state.progress = 'Starting…';
  runScriptsSequentially(job, state)
    .catch((e) => {
      state.error = e?.message || String(e);
    })
    .finally(() => {
      state.running = false;
      state.finished_at = new Date().toISOString();
      state.progress = null;
    });
  return { started: true, state: getCatalogRefreshState(job) };
}

async function runScriptsSequentially(job, state) {
  for (const script of JOB_SCRIPTS[job]) {
    await (scriptRunnerOverride || runScript)(script, state);
  }
}

function runScript(script, state) {
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
