// Image-sheet background job engine.
//
// An "image sheet" is a batch of generated images created together for one host
// (a character or a beat). Each generated image is a normal artwork on the host
// (character.artworks[] / beat.artworks[]), so results appear on the Artwork tab
// for free and re-render live via the existing gateway `fields_updated`
// broadcasts. This module only adds the batch orchestration:
//
//   - CHARACTER: a fixed shot preset (characterSheetShots.js) → N prompts.
//   - BEAT: a dynamically-planned list of environment/background plates
//     (beatSheetPlanner.js) → N prompts.
//   Then a bounded-concurrency worker pool renders each prompt into a pending
//   artwork via the shared generateArtworkImageInline() path.
//
// Status lives in an in-memory job map (same convention as storyboard
// generation) which the SPA polls; the job shape mirrors the storyboard job so
// the SPA's progress component renders it unchanged. In-memory jobs are lost on
// process restart — accepted (already-created artwork docs persist; stuck
// pending tiles can be regenerated/deleted per-artwork).

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { isConfigured as falConfigured } from '../fal/client.js';
import { ALLOWED_IMAGE_MODELS } from './imageReplaceDispatch.js';
import { createPendingArtworkViaGateway, setArtworkStatusViaGateway } from './gateway.js';
import { generateArtworkImageInline } from './artworkJobs.js';
import { getCharacter } from '../mongo/characters.js';
import { getBeat } from '../mongo/plots.js';
import {
  loadDirectorNotesForPlanner,
  findCharactersInBeat,
  loadImageInput,
  STORYBOARD_MODEL,
} from './storyboardGenerate.js';
import { buildCharacterSheetShots, selectSheetShots } from './characterSheetShots.js';
import { planBeatSceneImages, MAX_SCENE_IMAGE_COUNT } from './beatSheetPlanner.js';
import { listStoryboards } from '../mongo/storyboards.js';
import { tuneStoryboardImageSheet } from './storyboardSheetTuner.js';

// How many provider calls run at once. Bounded to avoid hammering provider rate
// limits when a sheet has a dozen+ shots.
export const SHEET_CONCURRENCY = 3;

const MAX_JOB_EVENTS = 100;
const VALID_HOST_TYPES = new Set(['character', 'beat']);
// Which logical models are FAL-backed (need FAL_KEY) vs. openai (needs OPENAI key).
const FAL_MODELS = new Set(['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'gemini-25-flash', 'nano-banana-2', 'flux-2-klein']);

const jobs = new Map();
// Hosts with an in-flight sheet, keyed `${hostType}:${hostId}`. Prevents two
// simultaneous sheets on the same host (cheaper + more targeted than a lock).
const busyHosts = new Set();

export function getImageSheetJob(jobId) {
  return jobs.get(jobId) || null;
}

function makeJobId() {
  return new ObjectId().toString();
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function recordProgress(job, { phase, step, frame = null, total = null, message }) {
  if (!job) return;
  const ts = new Date();
  job.progress = { ts, phase, step, frame, total, message, started_at: ts };
  if (!Array.isArray(job.events)) job.events = [];
  job.events.push({ ts, phase, step, frame, total, message });
  if (job.events.length > MAX_JOB_EVENTS) {
    job.events.splice(0, job.events.length - MAX_JOB_EVENTS);
  }
}

function validateModel(model) {
  if (!ALLOWED_IMAGE_MODELS.includes(model)) {
    throw httpError(`model must be one of: ${ALLOWED_IMAGE_MODELS.join('|')}`, 400);
  }
}

// Fail the start cleanly (before creating any pending tiles) if the chosen
// provider has no API key configured.
function assertConfigured(model) {
  if (model === 'openai' && !config.openai?.apiKey) {
    throw httpError('OPENAI_API_KEY is not configured.', 400);
  }
  if (FAL_MODELS.has(model) && !falConfigured()) {
    throw httpError('FAL_KEY is not configured.', 400);
  }
}

async function loadHostId(projectId, hostType, hostId) {
  if (hostType === 'character') {
    const c = await getCharacter(projectId, String(hostId));
    if (!c) throw httpError(`character not found: ${hostId}`, 404);
    return c._id.toString();
  }
  const beat = await getBeat(projectId, String(hostId));
  if (!beat) throw httpError(`beat not found: ${hostId}`, 404);
  return beat._id.toString();
}

// Resolve the user-picked reference image ids to loadImageInput entries (bytes +
// stored description). Used only to feed descriptions to the beat planner.
async function loadReferenceInputs(referenceImageIds) {
  const out = [];
  for (const id of referenceImageIds || []) {
    const r = await loadImageInput(id);
    if (r) out.push(r);
  }
  return out;
}

// Plan the shot list for a CHARACTER (fixed preset). Beats are rendered from an
// explicit, pre-derived list passed straight to runSheetJob, so they never
// reach here.
async function planShots({ projectId, hostId, shotNames, shotCount }) {
  const character = await getCharacter(projectId, hostId);
  if (!character) throw new Error(`character not found: ${hostId}`);
  const directorNotes = await loadDirectorNotesForPlanner(projectId);
  return buildCharacterSheetShots({ character, directorNotes, shotNames, shotCount });
}

// Run `items` through `worker` with at most `limit` in flight at once.
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runNext = async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

// Trim/validate a client-supplied explicit shot list (beats). Returns an array
// of { name, prompt } (blanks dropped, lengths clamped, capped at the max), or
// null if `shots` is not an array.
function normalizeExplicitShots(shots, { max = MAX_SCENE_IMAGE_COUNT } = {}) {
  if (!Array.isArray(shots)) return null;
  const out = [];
  for (const s of shots) {
    const name = typeof s?.name === 'string' ? s.name.trim().slice(0, 200) : '';
    const prompt = typeof s?.prompt === 'string' ? s.prompt.trim().slice(0, 2000) : '';
    if (!name || !prompt) continue;
    out.push({ name, prompt });
    if (out.length >= max) break;
  }
  return out;
}

// Render one shot: create a pending artwork, then generate its image. Per-shot
// failures are swallowed (recorded on the job + the artwork) so other shots
// still land.
async function renderShot({ projectId, job, hostType, hostId, model, referenceImageIds, discordUser, shot, index }) {
  const order = index + 1;
  recordProgress(job, {
    phase: 'rendering',
    step: 'shot_start',
    frame: order,
    total: job.planned,
    message: `Rendering ${order}/${job.planned}: ${shot.name}…`,
  });
  let artworkId = null;
  try {
    const { artwork } = await createPendingArtworkViaGateway({
      projectId,
      hostType,
      hostId,
      prompt: shot.prompt,
      name: shot.name,
      model,
      referenceImageIds,
      jobId: job.job_id,
    });
    artworkId = artwork._id;
    await generateArtworkImageInline({
      projectId,
      hostType,
      hostId,
      artworkId,
      prompt: shot.prompt,
      model,
      referenceImageIds,
      discordUser,
    });
    job.completed += 1;
    recordProgress(job, {
      phase: 'rendering',
      step: 'shot_done',
      frame: order,
      total: job.planned,
      message: `Rendered ${order}/${job.planned}: ${shot.name}`,
    });
  } catch (e) {
    job.failed += 1;
    if (artworkId) {
      await setArtworkStatusViaGateway({
        projectId,
        hostType,
        hostId,
        artworkId,
        status: 'error',
        errorMessage: e.message,
      }).catch((err) => logger.warn(`image sheet: persist error status failed: ${err.message}`));
    }
    recordProgress(job, {
      phase: 'rendering',
      step: 'shot_failed',
      frame: order,
      total: job.planned,
      message: `Failed ${order}/${job.planned}: ${shot.name} — ${e.message}`,
    });
    logger.warn(`image sheet ${job.job_id} shot ${order} failed: ${e.message}`);
  }
}

async function announceSheet({ job, hostType, hostId, projectId, announceUsername }) {
  if (!announceUsername || job.completed <= 0) return;
  try {
    const { announceText } = await import('../discord/announcer.js');
    const noun = job.completed === 1 ? 'reference image' : 'reference images';
    const where = hostType === 'character' ? 'a character' : 'a beat';
    const suffix = job.failed > 0 ? ` (${job.failed} failed)` : '';
    await announceText(
      `🎨 ${announceUsername} generated an image sheet — ${job.completed} ${noun} on ${where}${suffix}`,
    ).catch(() => {});
  } catch (e) {
    logger.warn(`image sheet announce failed: ${e?.message || e}`);
  }
}

async function runSheetJob({ projectId, job, hostType, hostId, model, referenceImageIds, shotNames, shotCount, explicitShots, discordUser, announceUsername }) {
  try {
    const shots = explicitShots ?? await planShots({ projectId, hostId, shotNames, shotCount });
    job.planned = shots.length;
    if (!shots.length) {
      job.status = 'done';
      job.finished_at = new Date();
      recordProgress(job, { phase: 'done', step: 'job_done_empty', message: 'Nothing to generate — planner returned no shots.' });
      return;
    }
    job.status = 'rendering';
    recordProgress(job, {
      phase: 'rendering',
      step: 'render_start',
      total: job.planned,
      message: `Rendering ${job.planned} image${job.planned === 1 ? '' : 's'}…`,
    });
    await runPool(shots, SHEET_CONCURRENCY, (shot, index) =>
      renderShot({ projectId, job, hostType, hostId, model, referenceImageIds, discordUser, shot, index }),
    );
    job.status = job.failed === 0 ? 'done' : 'partial';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: job.status,
      step: 'job_done',
      total: job.planned,
      message: `Done — ${job.completed} generated${job.failed ? `, ${job.failed} failed` : ''}.`,
    });
    await announceSheet({ job, hostType, hostId, projectId, announceUsername });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'job_crashed', message: `Image sheet crashed: ${e.message}` });
    logger.error(`image sheet job ${job.job_id} crashed: ${e.message}`);
  }
}

// Run the two-phase derivation for a beat and park the result on the job for
// review. Renders NOTHING — the SPA polls GET /image-sheet/:jobId, reads
// job.shots once status === 'derived', lets the user edit, then POSTs the
// reviewed list back to /beat/:id/image-sheet. No busyHosts lock: deriving has no side
// effects.
async function runShotPlanJob({ projectId, job, hostId, referenceImageIds, direction, previousPlates }) {
  try {
    job.status = 'planning';
    const beat = await getBeat(projectId, hostId);
    if (!beat) throw new Error(`beat not found: ${hostId}`);
    const characters = await findCharactersInBeat(projectId, beat);
    const directorNotes = await loadDirectorNotesForPlanner(projectId);
    const referenceInputs = await loadReferenceInputs(referenceImageIds);
    const { images } = await planBeatSceneImages({
      beat,
      characters,
      referenceInputs,
      direction,
      directorNotes,
      previousPlates,
      onProgress: (e) => recordProgress(job, e),
    });
    job.shots = images;
    job.planned = images.length;
    job.status = 'derived';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'derived',
      step: 'derive_done',
      total: images.length,
      message: `Derived ${images.length} plate${images.length === 1 ? '' : 's'} — review and generate.`,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'derive_crashed', message: `Derivation failed: ${e.message}` });
    logger.error(`shot-plan job ${job.job_id} crashed: ${e.message}`);
  }
}

// Start a background plate-derivation job for a beat. Returns { job_id }
// immediately (HTTP 202). Throws an error carrying `.status` for not-found /
// config conditions (surfaced before the job is created).
export async function startShotPlanJob({
  projectId,
  hostId,
  referenceImageIds = [],
  direction = '',
  previousPlates = [],
}) {
  if (!config.anthropic?.apiKey) {
    throw httpError('ANTHROPIC_API_KEY is not configured (required to derive beat plates).', 400);
  }
  const beat = await getBeat(projectId, String(hostId));
  if (!beat) throw httpError(`beat not found: ${hostId}`, 404);
  const resolvedHostId = beat._id.toString();
  // On re-derive the client sends the plates it's reacting to; normalize/cap
  // them so the planner can revise rather than re-roll from scratch.
  const priorPlates = normalizeExplicitShots(previousPlates) || [];

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    host_type: 'beat',
    host_id: resolvedHostId,
    project_id: projectId,
    kind: 'beat_plan',
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planner_model: STORYBOARD_MODEL,
    reference_image_ids: (referenceImageIds || []).map(String),
    planned: 0,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
    shots: null,
  };
  jobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: 'Queued plate derivation…' });

  setImmediate(() => {
    runShotPlanJob({ projectId, job, hostId: resolvedHostId, referenceImageIds, direction, previousPlates: priorPlates })
      .catch((e) => {
        job.status = 'error';
        job.error = e.message;
        job.finished_at = new Date();
        logger.error(`shot-plan job ${jobId} crashed (outer): ${e.message}`);
      });
  });

  return { job_id: jobId };
}

// Run the storyboard-driven tune scan for a beat and park the proposed new
// plates on the job for review. Renders NOTHING — the SPA polls
// GET /image-sheet/:jobId until status === 'derived', shows job.shots for
// review, then POSTs the reviewed list to /beat/:id/image-sheet (same as the
// derive→review→generate flow). No busyHosts lock: scanning has no side effects.
async function runTuneScanJob({ projectId, job, hostId }) {
  try {
    job.status = 'planning';
    const beat = await getBeat(projectId, hostId);
    if (!beat) throw new Error(`beat not found: ${hostId}`);
    const storyboards = await listStoryboards({ beatId: beat._id });
    if (!storyboards.length) {
      job.shots = [];
      job.planned = 0;
      job.status = 'derived';
      job.finished_at = new Date();
      recordProgress(job, { phase: 'derived', step: 'tune_empty', message: 'No storyboard elements to scan.' });
      return;
    }
    const existingPlates = (beat.artworks || [])
      .filter((a) => a?.status === 'done' && a.result_image_id)
      .map((a) => ({ name: (a.name || '').trim(), prompt: (a.prompt || '').trim() }));
    const { images } = await tuneStoryboardImageSheet({
      storyboards,
      existingPlates,
      onProgress: (e) => recordProgress(job, e),
    });
    job.shots = images;
    job.planned = images.length;
    job.status = 'derived';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'derived',
      step: 'derive_done',
      total: images.length,
      message: `Proposed ${images.length} new plate${images.length === 1 ? '' : 's'} — review and generate.`,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'tune_crashed', message: `Tune failed: ${e.message}` });
    logger.error(`tune-scan job ${job.job_id} crashed: ${e.message}`);
  }
}

// Start a background tune-scan job for a beat. Returns { job_id } immediately
// (HTTP 202). Throws an error carrying `.status` for not-found / config issues.
export async function startTuneScanJob({ projectId, hostId, referenceImageIds = [] }) {
  if (!config.anthropic?.apiKey) {
    throw httpError('ANTHROPIC_API_KEY is not configured (required to tune the image sheet).', 400);
  }
  const beat = await getBeat(projectId, String(hostId));
  if (!beat) throw httpError(`beat not found: ${hostId}`, 404);
  const resolvedHostId = beat._id.toString();

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    host_type: 'beat',
    host_id: resolvedHostId,
    project_id: projectId,
    kind: 'beat_tune',
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planner_model: STORYBOARD_MODEL,
    reference_image_ids: (referenceImageIds || []).map(String),
    planned: 0,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
    shots: null,
  };
  jobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: 'Queued image-sheet tune…' });

  setImmediate(() => {
    runTuneScanJob({ projectId, job, hostId: resolvedHostId }).catch((e) => {
      job.status = 'error';
      job.error = e.message;
      job.finished_at = new Date();
      logger.error(`tune-scan job ${jobId} crashed (outer): ${e.message}`);
    });
  });

  return { job_id: jobId };
}

// Start a background image-sheet job. Returns { job_id, planned, host_type,
// host_id } immediately (HTTP 202). `planned` is the shot count for characters
// and null for beats (known only after planning). Throws an error carrying a
// `.status` for validation / not-found / busy-host conditions.
export async function startImageSheetJob({
  projectId,
  hostType,
  hostId,
  model,
  referenceImageIds = [],
  shotNames,
  shotCount,
  shots,
  discordUser = null,
  announceUsername = null,
}) {
  if (!VALID_HOST_TYPES.has(hostType)) throw httpError(`invalid hostType: ${hostType}`, 400);
  validateModel(model);
  assertConfigured(model);
  const resolvedHostId = await loadHostId(projectId, hostType, hostId);

  // Beats render an explicit, pre-derived shot list (the derive→review→generate
  // flow); characters plan their fixed preset.
  let explicitShots = null;
  if (hostType === 'beat') {
    explicitShots = normalizeExplicitShots(shots);
    if (!explicitShots || !explicitShots.length) {
      throw httpError('A beat image sheet needs a derived shot list (shots[]).', 400);
    }
  }

  const busyKey = `${hostType}:${resolvedHostId}`;
  if (busyHosts.has(busyKey)) {
    throw httpError('An image sheet is already generating for this item.', 409);
  }
  busyHosts.add(busyKey);

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    host_type: hostType,
    host_id: resolvedHostId,
    project_id: projectId,
    kind: hostType === 'character' ? 'character_sheet' : 'beat_sheet',
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    model,
    planner_model: null,
    reference_image_ids: (referenceImageIds || []).map(String),
    planned: hostType === 'character' ? selectSheetShots({ shotNames, shotCount }).length : explicitShots.length,
    shots: explicitShots,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
  };
  jobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: 'Queued image sheet…' });

  // Fire-and-forget; the runner records its own errors. Release the host on
  // completion regardless of outcome.
  setImmediate(() => {
    runSheetJob({ projectId, job, hostType, hostId: resolvedHostId, model, referenceImageIds, shotNames, shotCount, explicitShots, discordUser, announceUsername })
      .catch((e) => {
        job.status = 'error';
        job.error = e.message;
        job.finished_at = new Date();
        logger.error(`image sheet job ${jobId} crashed (outer): ${e.message}`);
      })
      .finally(() => busyHosts.delete(busyKey));
  });

  return {
    job_id: jobId,
    planned: hostType === 'character' ? job.planned : explicitShots.length,
    host_type: hostType,
    host_id: resolvedHostId,
  };
}
