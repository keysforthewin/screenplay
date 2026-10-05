// "Generate all videos" for one beat's Scenes tab: a background batch that
// renders every cut that has both frames, one cut after another, through the
// same per-cut jobs the Generate video buttons start (comfyVideoGenerate.js /
// falVideoGenerate.js). Meant to be left running overnight: a cut that fails
// is recorded and the batch moves on.
//
// One batch per beat at a time, in memory (like every other render job here —
// a restart ends it; clips already saved stay). The SPA polls
// GET /cuts/videos/batch?beat_id= and shows each cut's status.

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { getVideoPrompt, listVideoPrompts } from '../mongo/videoPrompts.js';
import { listVideoScenes } from '../mongo/videoScenes.js';
import { isTerminalJobStatus } from './jobLookup.js';

export const BATCH_PROVIDERS = ['comfy', 'fal'];
// ComfyUI is one GPU; fal renders cuts side by side.
const CONCURRENCY = { comfy: 1, fal: 2 };
const JOB_POLL_MS = 5000;
const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;

export class CutBatchError extends Error {
  constructor(message, { status = 400, code = 'CUT_BATCH_INVALID' } = {}) {
    super(message);
    this.name = 'CutBatchError';
    this.status = status;
    this.code = code;
  }
}

// ─── Providers ──────────────────────────────────────────────────────────────
// Each: preflight(cutId) throws what the single-cut route would answer;
// start(cutId) → { job_id }; get / subscribe / unsubscribe / cancel on a job.

async function comfyProvider({ projectId, modelId, params, confirmSpend, announceUsername }) {
  const Comfy = await import('./comfyVideoGenerate.js');
  const args = (cutId) => ({ projectId, cutId, modelId, params, confirmSpend });
  return {
    preflight: (cutId) => Comfy.prepareCutRender(args(cutId)),
    start: (cutId) => Comfy.startComfyCutVideoJob({ ...args(cutId), announceUsername }),
    get: (jobId) => Comfy.serializeComfyJob(Comfy.getComfyVideoJob(jobId)),
    subscribe: Comfy.subscribeToComfyJob,
    unsubscribe: Comfy.unsubscribeFromComfyJob,
    cancel: (jobId) => Comfy.cancelComfyCutVideoJob(jobId),
  };
}

async function falProvider({ projectId, modelId, resolution, fps, generateAudio, announceUsername }) {
  const Fal = await import('./falVideoGenerate.js');
  const owner = (cutId) => ({ kind: Fal.OWNER_VIDEO_PROMPT, id: cutId });
  return {
    preflight: (cutId) => Fal.prepareShotVideoJob({ projectId, modelId, owner: owner(cutId) }),
    start: (cutId) =>
      Fal.startVideoGenerationJob({
        projectId,
        modelId,
        resolution,
        fps,
        generateAudio: !!generateAudio,
        includeDirectorNotes: false,
        owner: owner(cutId),
        announceUsername,
      }),
    get: (jobId) => Fal.serializeJob(Fal.getVideoGenerationJob(jobId)),
    subscribe: Fal.subscribeToJob,
    unsubscribe: Fal.unsubscribeFromJob,
    cancel: null,
  };
}

let providerFactories = { comfy: comfyProvider, fal: falProvider };
let jobPollMs = JOB_POLL_MS;
export function _setCutBatchProvidersForTests(factories = null, { pollMs = null } = {}) {
  providerFactories = factories ? { comfy: comfyProvider, fal: falProvider, ...factories } : { comfy: comfyProvider, fal: falProvider };
  jobPollMs = pollMs ?? JOB_POLL_MS;
}

// ─── Registry ───────────────────────────────────────────────────────────────

const batches = new Map(); // beatId → batch

export function _resetCutBatchesForTests() {
  batches.clear();
}

function countItems(items) {
  const counts = { total: items.length, queued: 0, running: 0, done: 0, error: 0, skipped: 0, cancelled: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  return counts;
}

export function serializeCutBatch(batch) {
  if (!batch) return null;
  return {
    batch_id: batch.batch_id,
    beat_id: batch.beat_id,
    provider: batch.provider,
    model_id: batch.model_id,
    status: batch.status,
    started_by: batch.started_by,
    started_at: batch.started_at,
    finished_at: batch.finished_at,
    counts: countItems(batch.items),
    items: batch.items.map((it) => ({ ...it })),
  };
}

export function getCutVideoBatchForBeat(beatId) {
  const batch = batches.get(String(beatId || '')) || null;
  if (!batch) return null;
  if (batch.finished_at && Date.now() - new Date(batch.finished_at).getTime() > FINISHED_RETENTION_MS) {
    batches.delete(batch.beat_id);
    return null;
  }
  return batch;
}

// "2.3" for cut 3 of scene 2 — what the Scenes tab shows.
export function orderedCutsWithLabels(scenes, cuts) {
  const sceneOrder = new Map((scenes || []).map((s) => [String(s._id), s.order]));
  return [...(cuts || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((cut) => {
      const so = cut.scene_id ? sceneOrder.get(String(cut.scene_id)) : null;
      return { cut, label: so != null && cut.cut_index != null ? `${so}.${cut.cut_index}` : `#${cut.order ?? '?'}` };
    });
}

function skipReason(cut, { skipExisting }) {
  if (!cut.start_frame?.image_id || !cut.end_frame?.image_id) return 'Needs a start frame and an end frame';
  if (!String(cut.prompt || '').trim()) return 'No video prompt';
  if (skipExisting && cut.video_file_id) return 'Already has a video';
  return null;
}

// Validate, then start the batch in the background. Throws CutBatchError (or
// the provider's own typed error for a bad model / missing configuration) so
// the route can answer 4xx before anything is queued.
export async function startCutVideoBatch({
  projectId,
  beatId,
  provider,
  modelId,
  params = {},
  confirmSpend = false,
  resolution = null,
  fps = null,
  generateAudio = false,
  skipExisting = true,
  announceUsername = null,
}) {
  if (!BATCH_PROVIDERS.includes(provider)) throw new CutBatchError('provider must be "comfy" or "fal"');
  if (!modelId) throw new CutBatchError('model_id required');
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new CutBatchError('beat not found', { status: 404, code: 'BEAT_NOT_FOUND' });
  const beatKey = beat._id.toString();
  const active = getCutVideoBatchForBeat(beatKey);
  if (active && active.status === 'running') {
    throw new CutBatchError('This beat already has a batch running', { status: 409, code: 'BATCH_BUSY' });
  }

  const [scenes, cuts] = await Promise.all([
    listVideoScenes({ projectId, beatId: beat._id }),
    listVideoPrompts({ projectId, beatId: beat._id }),
  ]);
  const items = orderedCutsWithLabels(scenes, cuts).map(({ cut, label }) => {
    const reason = skipReason(cut, { skipExisting });
    return {
      cut_id: cut._id.toString(),
      label,
      status: reason ? 'skipped' : 'queued',
      reason,
      error: null,
      job_id: null,
      started_at: null,
      finished_at: null,
    };
  });
  const first = items.find((it) => it.status === 'queued');
  if (!first) throw new CutBatchError('No cut to generate: every cut is missing a frame or a prompt, or already has a video');

  const api = await providerFactories[provider]({
    projectId,
    modelId,
    params,
    confirmSpend,
    resolution,
    fps,
    generateAudio,
    announceUsername,
  });
  // The first cut stands in for the rest: an unknown model, a provider that
  // is not configured or a model a cut cannot drive fails here, not at 3 am.
  await api.preflight(first.cut_id);

  const batch = {
    batch_id: new ObjectId().toString(),
    beat_id: beatKey,
    provider,
    model_id: modelId,
    status: 'running',
    cancelled: false,
    started_by: announceUsername,
    started_at: new Date(),
    finished_at: null,
    items,
  };
  batches.set(beatKey, batch);
  logger.info(`cut batch ${batch.batch_id}: beat=${beatKey} provider=${provider} model=${modelId} cuts=${items.filter((i) => i.status === 'queued').length}`);

  runBatch({ batch, api, projectId, skipExisting }).catch((e) => {
    logger.error(`cut batch ${batch.batch_id} crashed: ${e?.message || e}`);
    finishBatch(batch);
  });
  return batch;
}

function finishBatch(batch) {
  for (const it of batch.items) {
    if (it.status === 'queued' || it.status === 'running') {
      it.status = batch.cancelled ? 'cancelled' : 'error';
      if (!batch.cancelled) it.error = it.error || 'The batch stopped before this cut';
      it.finished_at = new Date();
    }
  }
  batch.status = batch.cancelled ? 'cancelled' : 'done';
  batch.finished_at = new Date();
  const c = countItems(batch.items);
  logger.info(`cut batch ${batch.batch_id} ${batch.status}: done=${c.done} error=${c.error} skipped=${c.skipped} cancelled=${c.cancelled}`);
}

async function runBatch({ batch, api, projectId, skipExisting }) {
  const queue = batch.items.filter((it) => it.status === 'queued');
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const item = queue[next++];
      if (batch.cancelled) return;
      await runItem({ batch, item, api, projectId, skipExisting });
    }
  }
  const width = Math.min(CONCURRENCY[batch.provider] || 1, queue.length);
  await Promise.all(Array.from({ length: width }, worker));
  finishBatch(batch);
}

async function runItem({ batch, item, api, projectId, skipExisting }) {
  const skip = (reason) => {
    item.status = 'skipped';
    item.reason = reason;
    item.finished_at = new Date();
  };
  try {
    // The page may have changed since the batch was queued hours ago.
    const cut = await getVideoPrompt(projectId, item.cut_id);
    if (!cut) return skip('The cut was deleted');
    const reason = skipReason(cut, { skipExisting });
    if (reason) return skip(reason);

    item.status = 'running';
    item.started_at = new Date();
    let jobId;
    try {
      ({ job_id: jobId } = await api.start(item.cut_id));
    } catch (e) {
      // Someone started this cut by hand: follow that render instead.
      if (e?.code === 'CUT_BUSY' && e.job_id && api.get(e.job_id)) jobId = e.job_id;
      else throw e;
    }
    item.job_id = jobId;
    const snap = await waitForJob(api, jobId);
    if (snap.status === 'done') {
      item.status = 'done';
    } else if (batch.cancelled && snap.cancelled) {
      item.status = 'cancelled';
    } else {
      item.status = 'error';
      item.error = snap.error || 'The render failed';
    }
  } catch (e) {
    item.status = 'error';
    item.error = Array.isArray(e?.errors) && e.errors.length ? `${e.message}: ${e.errors.join('; ')}` : e?.message || String(e);
    logger.warn(`cut batch ${batch.batch_id}: cut ${item.label} failed: ${item.error}`);
  } finally {
    item.finished_at = item.finished_at || new Date();
  }
}

// Resolves with the job's terminal snapshot. Subscribed for the usual case;
// polled as well, because a finished job is forgotten after a few minutes
// and a listener registered a moment too late would wait forever.
function waitForJob(api, jobId) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (snap) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      api.unsubscribe(jobId, listener);
      resolve(snap);
    };
    const listener = (snap) => {
      if (snap && isTerminalJobStatus(snap.status)) finish(snap);
    };
    const check = () => {
      const snap = api.get(jobId);
      if (!snap) finish({ status: 'error', error: 'The render job was lost' });
      else if (isTerminalJobStatus(snap.status)) finish(snap);
    };
    api.subscribe(jobId, listener);
    timer = setInterval(check, jobPollMs);
    timer.unref?.();
    check();
  });
}

// Stop after the renders in flight: cuts still waiting are not started. A
// ComfyUI job still waiting for the GPU is taken out of its queue.
export async function cancelCutVideoBatch(beatId) {
  const batch = getCutVideoBatchForBeat(beatId);
  if (!batch) return null;
  if (batch.status !== 'running') return batch;
  batch.cancelled = true;
  for (const it of batch.items) {
    if (it.status === 'queued') {
      it.status = 'cancelled';
      it.finished_at = new Date();
    }
  }
  if (batch.provider === 'comfy') {
    const { cancelComfyCutVideoJob } = await import('./comfyVideoGenerate.js');
    for (const it of batch.items) {
      if (it.status !== 'running' || !it.job_id) continue;
      try {
        cancelComfyCutVideoJob(it.job_id);
      } catch {
        // already rendering — it finishes and the batch ends after it
      }
    }
  }
  return batch;
}
