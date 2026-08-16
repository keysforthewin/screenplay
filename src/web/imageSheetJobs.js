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
import { isValidImageModel, IMAGE_MODEL_ERROR, assertImageModelConfigured } from './imageModelValidate.js';
import { createPendingArtworkViaGateway, setArtworkStatusViaGateway } from './gateway.js';
import { generateArtworkImageInline } from './artworkJobs.js';
import { getCharacter } from '../mongo/characters.js';
import { getBeat } from '../mongo/plots.js';
import {
  loadDirectorNotesForPlanner,
  findCharactersInBeat,
  findBeatsReferencingSet,
  loadImageInput,
  clipField,
  STORYBOARD_MODEL,
} from './storyboardGenerate.js';
import { clipBlock, MAX_CONTEXT_BEATS } from './setDescriptionGenerate.js';
import { buildCharacterSheetShots, selectSheetShots } from './characterSheetShots.js';
import { planBeatSceneImages, MAX_SCENE_IMAGE_COUNT } from './beatSheetPlanner.js';
import { listStoryboards } from '../mongo/storyboards.js';
import { tuneStoryboardImageSheet } from './storyboardSheetTuner.js';

// How many provider calls run at once. Bounded to avoid hammering provider rate
// limits when a sheet has a dozen+ shots.
export const SHEET_CONCURRENCY = 3;

const MAX_JOB_EVENTS = 100;
const VALID_HOST_TYPES = new Set(['character', 'beat', 'set']);

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

async function validateModel(model) {
  if (!(await isValidImageModel(model))) {
    throw httpError(IMAGE_MODEL_ERROR, 400);
  }
}

async function loadHostId(projectId, hostType, hostId) {
  if (hostType === 'character') {
    const c = await getCharacter(projectId, String(hostId));
    if (!c) throw httpError(`character not found: ${hostId}`, 404);
    return c._id.toString();
  }
  if (hostType === 'set') {
    const { getSet } = await import('../mongo/sets.js');
    const s = await getSet(projectId, String(hostId));
    if (!s) throw httpError(`set not found: ${hostId}`, 404);
    return s._id.toString();
  }
  const beat = await getBeat(projectId, String(hostId));
  if (!beat) throw httpError(`beat not found: ${hostId}`, 404);
  return beat._id.toString();
}

// The main beat is the plate source; give it a much roomier clip than the
// context beats' default so nothing plate-worthy is cut.
const MAIN_BEAT_BODY_CLIP = 12000;

// The plate planner's prompts are built from a beat-shaped context block. A
// set derives its plates from its own description plus the text of the beats
// that stage in it, so synthesize a beat-shaped object whose body carries
// both — description first (it is the set's visual bible), then one section
// per beat. When a `mainBeat` is chosen, plates are planned for THAT beat
// only; the other beats become explicitly-labeled background reading.
export function setAsPlannerBeat(set, { mainBeat = null, contextBeats = [] } = {}) {
  const sections = [];
  const description = String(set.description || '').trim();
  if (description) {
    sections.push([
      '## Set description (the look — palette, materials, light. Use it to GROUND',
      'the plates you plan; do NOT plan a plate per paragraph of it. Which plates',
      'exist, and how many, comes only from what the beat text below stages.)',
      '',
      description,
    ].join('\n'));
  }
  const beatSection = (b, { heading }) => {
    const name = clipBlock(b?.name, 200) || 'Untitled';
    const lines = [`${heading} Beat #${b?.order ?? '?'} — ${name}`];
    const desc = clipField(b?.desc);
    if (desc) lines.push(desc);
    const body = clipBlock(b?.body, b === mainBeat ? MAIN_BEAT_BODY_CLIP : undefined);
    if (body) lines.push('', body);
    return lines.join('\n');
  };
  if (mainBeat) {
    sections.push([
      `## MAIN BEAT — plan plates ONLY for this beat`,
      '',
      'Every plate must serve what THIS beat stages in this set. Do NOT plan',
      'plates for the context beats below. Copy each plate’s verbatim quote',
      'from THIS main-beat text.',
      '',
      beatSection(mainBeat, { heading: '###' }),
    ].join('\n'));
    if (contextBeats.length) {
      const ctx = contextBeats
        .slice(0, MAX_CONTEXT_BEATS)
        .map((b) => beatSection(b, { heading: '###' }));
      sections.push([
        '## Context beats (background reading ONLY — continuity for what happens',
        'before/after in this set; do NOT plan plates for these)',
        '',
        ctx.join('\n\n'),
      ].join('\n'));
    }
  } else {
    for (const b of contextBeats.slice(0, MAX_CONTEXT_BEATS)) {
      sections.push(beatSection(b, { heading: '##' }));
    }
  }
  return {
    order: 0,
    name: set.name || 'Set',
    desc: mainBeat
      ? 'Reusable set/location — plan plates ONLY for the angles, corners, and sub-locations the MAIN BEAT below stages in it. The context beats are continuity background, not plate sources.'
      : 'Reusable set/location — plan plates that cover the angles, corners, and sub-locations the beats below stage in it.',
    body: sections.join('\n\n'),
    characters: [],
    sets: [],
  };
}

// Resolve the user-picked reference image ids to loadImageInput entries (bytes
// + stored description), tagged with the requested id so the planner can map
// its per-plate reference_indexes back to these exact ids.
async function loadReferenceInputs(referenceImageIds) {
  const out = [];
  for (const id of referenceImageIds || []) {
    const r = await loadImageInput(id);
    if (r) out.push({ ...r, id: String(id) });
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

// Sanitize a client-supplied beat-id selection for a set's planner context.
function normalizeBeatIds(beatIds) {
  return (Array.isArray(beatIds) ? beatIds : [])
    .map(String)
    .filter((s) => /^[a-f0-9]{24}$/i.test(s))
    .slice(0, 50);
}

// Ceiling on the unioned reference pool sent to the image provider. Storyboard
// reference picking caps at 12; linked set galleries can be much bigger, so
// clamp the union to keep provider payloads sane.
export const MAX_SHEET_REFERENCE_IMAGES = 20;

// Sanitize a client-supplied reference-set selection (sets whose galleries
// join the render reference pool).
function normalizeReferenceSetIds(ids) {
  return (Array.isArray(ids) ? ids : [])
    .map(String)
    .filter((s) => /^[a-f0-9]{24}$/i.test(s))
    .slice(0, 10);
}

// Union the explicit reference ids with the gallery images of each listed set:
// explicit ids first, then galleries in selection order, deduped, capped.
// Unknown/foreign-project set ids and stale gallery ids drop silently — a
// stale id would otherwise fail every shot (loadImageBuffers throws on a
// missing file).
async function resolveSheetReferenceIds({ projectId, explicitIds = [], referenceSetIds = [] }) {
  const { getSet } = await import('../mongo/sets.js');
  const { findImageFile } = await import('../mongo/images.js');
  const seen = new Set();
  const candidates = [];
  const add = (id) => {
    const k = String(id || '');
    if (k && !seen.has(k)) {
      seen.add(k);
      candidates.push(k);
    }
  };
  for (const id of explicitIds) add(id);
  for (const sid of referenceSetIds) {
    const s = await getSet(projectId, sid);
    for (const img of s?.images || []) add(img?._id);
  }
  const out = [];
  for (const id of candidates) {
    if (out.length >= MAX_SHEET_REFERENCE_IMAGES) break;
    if (await findImageFile(id)) out.push(id);
  }
  return out;
}

// Ceiling on one shot's own reference list (mirrors the storyboard frame cap).
export const MAX_SHOT_REFERENCE_IMAGES = 12;

// Trim/validate a client-supplied explicit shot list (beats/sets). Returns an
// array of { name, prompt, reference_image_ids? } (blanks dropped, lengths
// clamped, capped at the max), or null if `shots` is not an array. A shot
// carries `reference_image_ids` only when the input provided an array — its
// ABSENCE means "use the sheet-level pool" (legacy clients), while an empty
// array means "render this shot with no references at all".
function normalizeExplicitShots(shots, { max = MAX_SCENE_IMAGE_COUNT } = {}) {
  if (!Array.isArray(shots)) return null;
  const out = [];
  for (const s of shots) {
    const name = typeof s?.name === 'string' ? s.name.trim().slice(0, 200) : '';
    const prompt = typeof s?.prompt === 'string' ? s.prompt.trim().slice(0, 2000) : '';
    if (!name || !prompt) continue;
    const shot = { name, prompt };
    if (Array.isArray(s?.reference_image_ids)) {
      shot.reference_image_ids = [...new Set(
        s.reference_image_ids.map(String).filter((x) => /^[a-f0-9]{24}$/i.test(x)),
      )].slice(0, MAX_SHOT_REFERENCE_IMAGES);
    }
    // Per-shot model override (split sheets render refs-plates and prompt-only
    // plates on different models). Absent = the sheet-level model.
    if (typeof s?.model === 'string' && s.model.trim()) {
      shot.model = s.model.trim().slice(0, 200);
    }
    out.push(shot);
    if (out.length >= max) break;
  }
  return out;
}

// Drop per-shot reference ids whose GridFS file no longer exists — a stale id
// would otherwise fail that shot's render (loadImageBuffers throws).
async function pruneStaleShotReferences(shots) {
  const { findImageFile } = await import('../mongo/images.js');
  const known = new Map();
  for (const shot of shots) {
    if (!Array.isArray(shot.reference_image_ids)) continue;
    const kept = [];
    for (const id of shot.reference_image_ids) {
      if (!known.has(id)) known.set(id, Boolean(await findImageFile(id)));
      if (known.get(id)) kept.push(id);
    }
    shot.reference_image_ids = kept;
  }
}

// Fail fast (400, before any pending tiles) on model/reference mismatches the
// provider would only reveal per-shot: a catalog endpoint that REQUIRES input
// images rendering with none (opaque 422), or the inverse — a shot carrying
// references on a catalog endpoint that takes no image input at all (the refs
// would be silently ignored and the user shown a prompt-only render they
// believed was reference-anchored). Wired shortcut models all generate
// prompt-only AND accept references, so only catalog rows constrain.
async function assertShotsSatisfyModelReferences({ model, explicitShots, poolIds }) {
  const { getImageModel } = await import('../fal/imageModelCatalog.js');
  // Cache catalog lookups per distinct model — split sheets carry a per-shot
  // model, so the guard checks each shot against ITS effective model.
  const rows = new Map();
  const rowFor = async (m) => {
    if (!rows.has(m)) rows.set(m, await getImageModel(m));
    return rows.get(m);
  };
  const requiresRefs = async (m) => Boolean((await rowFor(m))?.requires_references);
  const rejectsRefs = async (m) => {
    const row = await rowFor(m);
    return row ? !row.accepts_references : false;
  };
  const throwRefless = (refless) => {
    const names = refless.map((r) => `"${r.name}"`).join(', ');
    throw httpError(
      `"${refless[0].model}" requires reference images, but ${refless.length} plate${refless.length === 1 ? ' has' : 's have'} ` +
        `none: ${names}. Assign references to ${refless.length === 1 ? 'it' : 'each'} (+ Refs on the plate), ` +
        'or pick a model that can generate from a prompt alone.',
      400,
    );
  };
  const throwCantTake = (reffed) => {
    const names = reffed.map((r) => `"${r.name}"`).join(', ');
    throw httpError(
      `"${reffed[0].model}" cannot take reference images, but ${reffed.length} plate${reffed.length === 1 ? ' carries' : 's carry'} ` +
        `them: ${names}. Pick a model that accepts references for ${reffed.length === 1 ? 'it' : 'them'}, ` +
        'or remove the references to render from the prompt alone.',
      400,
    );
  };
  if (explicitShots) {
    const refless = [];
    const cantTake = [];
    for (const s of explicitShots) {
      const effectiveModel = s.model || model;
      const refs = Array.isArray(s.reference_image_ids) ? s.reference_image_ids : poolIds;
      if (refs.length === 0 && (await requiresRefs(effectiveModel))) {
        refless.push({ name: s.name, model: effectiveModel });
      } else if (refs.length > 0 && (await rejectsRefs(effectiveModel))) {
        cantTake.push({ name: s.name, model: effectiveModel });
      }
    }
    if (refless.length) throwRefless(refless);
    if (cantTake.length) throwCantTake(cantTake);
  } else if (!poolIds.length && (await requiresRefs(model))) {
    throw httpError(
      `"${model}" requires reference images — add at least one before generating.`,
      400,
    );
  } else if (poolIds.length && (await rejectsRefs(model))) {
    throw httpError(
      `"${model}" cannot take reference images, so the attached references would be ignored — ` +
        'pick a model that accepts references, or remove them to render from the prompt alone.',
      400,
    );
  }
}

// Render one shot: create a pending artwork, then generate its image. Per-shot
// failures are swallowed (recorded on the job + the artwork) so other shots
// still land.
async function renderShot({ projectId, job, hostType, hostId, model, referenceImageIds, discordUser, shot, index }) {
  const order = index + 1;
  // A shot that carries its own reference list (per-plate assignment from the
  // planner/review UI) renders with EXACTLY those references — an empty list
  // means none. Shots without one (character presets, legacy clients) use the
  // sheet-level pool.
  const shotReferenceIds = Array.isArray(shot.reference_image_ids)
    ? shot.reference_image_ids
    : referenceImageIds;
  // Split sheets render refs-plates and prompt-only plates on different models.
  const shotModel = shot.model || model;
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
      model: shotModel,
      referenceImageIds: shotReferenceIds,
      jobId: job.job_id,
    });
    artworkId = artwork._id;
    await generateArtworkImageInline({
      projectId,
      hostType,
      hostId,
      artworkId,
      prompt: shot.prompt,
      model: shotModel,
      referenceImageIds: shotReferenceIds,
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
    const where = hostType === 'character' ? 'a character' : hostType === 'set' ? 'a set' : 'a beat';
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
// The planning core shared by the derive→review flow and the auto sheet: load
// the host's planner context (for sets: the description + the text of the
// referencing beats, optionally narrowed to `beatIds` — unmatched ids are
// silently dropped so a concurrent unlink can't crash a plan) and run the
// two-phase plate planner. Returns { images }.
//
// Set semantics: with a matched `mainBeatId`, plates are planned for that beat
// only and `beatIds` is taken literally as the context selection (empty = no
// context). Without one (or when the id no longer references the set), the
// legacy rule holds: `beatIds` narrows the flattened selection, empty = all.
async function derivePlates({ projectId, hostType = 'beat', hostId, mainBeatId = null, beatIds = [], referenceImageIds, direction, previousPlates, onProgress }) {
  let beat;
  let characters;
  if (hostType === 'set') {
    const { getSet } = await import('../mongo/sets.js');
    const set = await getSet(projectId, hostId);
    if (!set) throw new Error(`set not found: ${hostId}`);
    const beats = await findBeatsReferencingSet(projectId, set);
    const mainBeat = mainBeatId
      ? beats.find((b) => b._id.toString() === String(mainBeatId)) || null
      : null;
    const wanted = new Set((beatIds || []).map(String).filter(Boolean));
    let contextBeats;
    if (mainBeat) {
      contextBeats = beats.filter(
        (b) => wanted.has(b._id.toString()) && b._id.toString() !== mainBeat._id.toString(),
      );
    } else {
      contextBeats = wanted.size ? beats.filter((b) => wanted.has(b._id.toString())) : beats;
    }
    beat = setAsPlannerBeat(set, { mainBeat, contextBeats });
    characters = [];
  } else {
    beat = await getBeat(projectId, hostId);
    if (!beat) throw new Error(`beat not found: ${hostId}`);
    characters = await findCharactersInBeat(projectId, beat);
  }
  const directorNotes = await loadDirectorNotesForPlanner(projectId);
  const referenceInputs = await loadReferenceInputs(referenceImageIds);
  return planBeatSceneImages({
    beat,
    characters,
    referenceInputs,
    direction,
    directorNotes,
    previousPlates,
    onProgress,
  });
}

async function runShotPlanJob({ projectId, job, hostType = 'beat', hostId, mainBeatId, beatIds, referenceImageIds, direction, previousPlates }) {
  try {
    job.status = 'planning';
    const { images } = await derivePlates({
      projectId,
      hostType,
      hostId,
      mainBeatId,
      beatIds,
      referenceImageIds,
      direction,
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
  hostType = 'beat',
  hostId,
  referenceImageIds = [],
  mainBeatId = null,
  beatIds = [],
  referenceSetIds = [],
  direction = '',
  previousPlates = [],
}) {
  if (!config.anthropic?.apiKey) {
    throw httpError('ANTHROPIC_API_KEY is not configured (required to derive plates).', 400);
  }
  if (hostType !== 'beat' && hostType !== 'set') {
    throw httpError(`invalid hostType for plate derivation: ${hostType}`, 400);
  }
  const resolvedHostId = await loadHostId(projectId, hostType, hostId);
  // On re-derive the client sends the plates it's reacting to; normalize/cap
  // them so the planner can revise rather than re-roll from scratch.
  const priorPlates = normalizeExplicitShots(previousPlates) || [];
  const cleanBeatIds = hostType === 'set' ? normalizeBeatIds(beatIds) : [];
  const cleanMainBeatId =
    hostType === 'set' && typeof mainBeatId === 'string' && /^[a-f0-9]{24}$/i.test(mainBeatId)
      ? mainBeatId
      : null;
  const cleanRefSetIds = hostType === 'set' ? normalizeReferenceSetIds(referenceSetIds) : [];
  let refIds = (referenceImageIds || []).map(String);
  if (cleanRefSetIds.length) {
    // Linked set galleries join the planner's reference pool (their stored
    // descriptions anchor the plate prompts, same ids the render step uses).
    refIds = await resolveSheetReferenceIds({
      projectId,
      explicitIds: refIds,
      referenceSetIds: cleanRefSetIds,
    });
  }
  // The pool is sent to the planner as inline image blocks — cap it so a large
  // gallery prefill can't balloon the multimodal request.
  refIds = refIds.slice(0, MAX_SHEET_REFERENCE_IMAGES);

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    host_type: hostType,
    host_id: resolvedHostId,
    project_id: projectId,
    kind: hostType === 'set' ? 'set_plan' : 'beat_plan',
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planner_model: STORYBOARD_MODEL,
    reference_image_ids: refIds,
    main_beat_id: cleanMainBeatId,
    beat_ids: cleanBeatIds,
    reference_set_ids: cleanRefSetIds,
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
    runShotPlanJob({ projectId, job, hostType, hostId: resolvedHostId, mainBeatId: cleanMainBeatId, beatIds: cleanBeatIds, referenceImageIds: refIds, direction, previousPlates: priorPlates })
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
  referenceSetIds = [],
  shotNames,
  shotCount,
  shots,
  discordUser = null,
  announceUsername = null,
}) {
  if (!VALID_HOST_TYPES.has(hostType)) throw httpError(`invalid hostType: ${hostType}`, 400);
  await validateModel(model);
  assertImageModelConfigured(model);
  const resolvedHostId = await loadHostId(projectId, hostType, hostId);
  const cleanRefSetIds = hostType === 'set' ? normalizeReferenceSetIds(referenceSetIds) : [];
  let refIds = (referenceImageIds || []).map(String);
  if (cleanRefSetIds.length) {
    refIds = await resolveSheetReferenceIds({
      projectId,
      explicitIds: refIds,
      referenceSetIds: cleanRefSetIds,
    });
  }

  // Beats and sets render an explicit, pre-derived shot list (the
  // derive→review→generate flow); characters plan their fixed preset.
  let explicitShots = null;
  if (hostType === 'beat' || hostType === 'set') {
    explicitShots = normalizeExplicitShots(shots);
    if (!explicitShots || !explicitShots.length) {
      throw httpError(`A ${hostType} image sheet needs a derived shot list (shots[]).`, 400);
    }
    // Split sheets carry per-shot model overrides — each one must be as valid
    // and configured as the sheet-level model.
    for (const m of new Set(explicitShots.map((s) => s.model).filter(Boolean))) {
      await validateModel(m);
      assertImageModelConfigured(m);
    }
    await pruneStaleShotReferences(explicitShots);
  }
  await assertShotsSatisfyModelReferences({ model, explicitShots, poolIds: refIds });

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
    kind: hostType === 'character' ? 'character_sheet' : hostType === 'set' ? 'set_sheet' : 'beat_sheet',
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    model,
    planner_model: null,
    reference_image_ids: refIds,
    reference_set_ids: cleanRefSetIds,
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
    runSheetJob({ projectId, job, hostType, hostId: resolvedHostId, model, referenceImageIds: refIds, shotNames, shotCount, explicitShots, discordUser, announceUsername })
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

