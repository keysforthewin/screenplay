// src/web/cutStartFrames.js
// Pass 5 of the scene/cut planner: render each cut's START FRAME — the t=0
// still an image-to-video model opens on — from the cut's start_frame.prompt
// plus the artwork of every character in frame and the cut's set(s); and its
// END FRAME — the still a first-last-frame model lands on — the same way from
// end_frame, with the rendered start frame added as a last "continuity"
// reference (light, palette, wardrobe; never its framing). Every function
// takes `frame: 'start' | 'end'`; the start frame is the default.
//
// References: the planner's picks (start_frame.reference_ids) win; when a
// cut has none, the scored artwork selector
// (selectFrameReferencesForShot) fills them from the cut's
// characters_in_scene / sets_in_scene and the ids + scores are persisted so
// the SPA can show and edit them. Rendering goes through the same
// dispatchStillImage, so every image model
// the picker offers works here. Persistence goes through
// setVideoPromptStartFrameViaGateway, which keeps one undo step.
//
// Two entry points: renderStartFramesForCuts (caller holds the beat lock —
// the planner job calls it inline) and the job starters below (they take
// the lock themselves).

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { uploadGeneratedImage } from '../mongo/images.js';
import { getBeat } from '../mongo/plots.js';
import { getModelDefaults } from '../mongo/projectSettings.js';
import { getVideoPrompt, listVideoPrompts } from '../mongo/videoPrompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { orderReferenceIdsByScore, selectFrameReferencesForShot, MAX_ATTACHED_REFERENCE_IMAGES } from './frameReferences.js';
import { cutFrameKey, setVideoPromptStartFrameViaGateway, setVideoPromptTextFieldViaGateway } from './gateway.js';
import { maxReferenceImagesFor } from './imageModelInfo.js';
import { isComfyImageModelId } from '../comfy/imageModels.js';
import { dispatchStillImage } from './stillImageDispatch.js';
import { composeStartFramePrompt, orderReferencesByRole } from './startFramePrompt.js';
import { loadImageInput } from './beatPlanShared.js';

export const DEFAULT_START_FRAME_MODEL = 'nano-banana-pro';
export const START_FRAME_CONCURRENCY = 2;
export const CUT_FRAMES = ['start', 'end'];

// A `frames` request value → an ordered, de-duplicated list; start always
// renders before end so the end frame can lean on a fresh start frame.
export function normalizeFrames(raw, fallback = ['start']) {
  const list = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String);
  const out = CUT_FRAMES.filter((f) => list.includes(f));
  return out.length ? out : [...fallback];
}

let dispatcherOverride = null;
export function _setStartFrameDispatcherForTests(fn) {
  dispatcherOverride = fn;
}
function dispatch(args) {
  return dispatcherOverride ? dispatcherOverride(args) : dispatchStillImage(args);
}

export class CutNotFoundError extends Error {
  constructor(id) {
    super(`Cut not found: ${id}`);
    this.code = 'CUT_NOT_FOUND';
    this.status = 404;
  }
}

export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
    this.status = 409;
  }
}

export class StartFrameInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_START_FRAME_INPUT';
    this.status = 400;
  }
}

async function resolveImageModel(projectId, imageModel) {
  if (imageModel) return imageModel;
  try {
    const d = await getModelDefaults(projectId);
    if (d?.image_with_refs) return d.image_with_refs;
  } catch (e) {
    logger.warn(`cut start frame: model defaults failed: ${e?.message || e}`);
  }
  return DEFAULT_START_FRAME_MODEL;
}

// The cut as the reference selector expects it.
function cutAsShot(cut) {
  return {
    _id: cut._id,
    beat_id: cut.beat_id,
    characters_in_scene: cut.characters_in_scene || [],
    sets_in_scene: cut.sets_in_scene || [],
  };
}

// Reference ids + scores for the render: the planner's picks when present
// (unscored: they are ordered as stored), else the scored auto-selection.
// A list the planner (or a hand edit) chose is respected even when empty —
// "no set artwork fits this camera" must not be refilled with one that
// does not.
async function resolveReferences({ projectId, cut, key = 'start_frame', prompt, imageModel }) {
  const picked = (cut[key]?.reference_ids || []).map(String).filter(Boolean);
  if (picked.length || cut[key]?.references_planned) {
    return { ids: picked, scores: cut[key]?.reference_scores || {}, auto: false };
  }
  try {
    const { ids, referenceScores } = await selectFrameReferencesForShot({
      projectId,
      sb: cutAsShot(cut),
      frameText: prompt,
      imageModel,
    });
    return { ids: ids.map(String), scores: referenceScores || {}, auto: true };
  } catch (e) {
    logger.warn(`cut start frame: auto references failed for ${cut._id}: ${e?.message || e}`);
    return { ids: [], scores: {}, auto: true };
  }
}

// Who each reference shows, by image id: { name, ownerType } from the beat's
// artwork catalog. Every model is told — the binding decides whether an
// image is copied or only consulted (startFramePrompt.js).
async function referenceRoster(projectId, beat) {
  const roster = new Map();
  if (!beat) return roster;
  try {
    const { buildReferenceCatalog } = await import('./referenceCatalog.js');
    for (const e of await buildReferenceCatalog(projectId, beat)) {
      roster.set(String(e.image_id), { name: e.owner_name, ownerType: e.owner_type });
    }
  } catch (e) {
    logger.warn(`cut start frame: reference roster failed: ${e?.message || e}`);
  }
  return roster;
}

// A character reference carries identity; a set reference is a look
// reference unless the planner said this camera reproduces its framing.
export function referenceRole(id, roster, uses = {}) {
  const who = roster.get(String(id));
  if (who?.ownerType === 'character') return 'identity';
  return uses?.[String(id)] === 'framing' ? 'framing' : 'look';
}

// `continuityId` (the end frame's own start frame) rides along last and only
// when the model has room left after the artwork — the artwork wins the cap.
async function loadReferenceBuffers(ids, scores, imageModel, roster = new Map(), uses = {}, continuityId = null) {
  const cap = Math.min(MAX_ATTACHED_REFERENCE_IMAGES, maxReferenceImagesFor(imageModel));
  const ordered = orderReferenceIdsByScore({ referenceIds: ids, referenceScores: scores, maxTotal: cap });
  const out = [];
  for (const id of ordered) {
    const ref = await loadImageInput(id);
    if (!ref) continue;
    const who = roster.get(String(id));
    out.push({
      buffer: ref.buffer,
      contentType: ref.contentType,
      label: who ? (who.ownerType === 'set' ? `the set "${who.name}"` : who.name) : '',
      role: referenceRole(id, roster, uses),
    });
  }
  if (continuityId && out.length < cap) {
    const ref = await loadImageInput(continuityId);
    if (ref) out.push({ buffer: ref.buffer, contentType: ref.contentType, label: 'the opening frame of this shot', role: 'continuity' });
  }
  return orderReferencesByRole(out);
}

// Render ONE cut's start (or end) frame and persist it. Returns { image_id,
// reference_ids, cut }. `mode: 'edit'` re-renders the existing frame with
// editPrompt (+ optional one-shot extra references).
export async function renderCutStartFrame({
  projectId,
  cut,
  beat,
  frame = 'start',
  imageModel = null,
  prompt = null,
  mode = 'generate',
  editPrompt = null,
  editReferenceImageIds = [],
  comfyParams = null,
}) {
  const key = cutFrameKey(frame);
  const current = cut[key] || null;
  const model = await resolveImageModel(projectId, imageModel);
  let renderPrompt;
  let inputImages;
  let refIds = (current?.reference_ids || []).map(String);
  let refScores = current?.reference_scores || {};
  if (mode === 'edit') {
    const existing = current?.image_id;
    if (!existing) throw new StartFrameInputError(`No ${frame} frame to edit yet — render one first.`);
    if (typeof editPrompt !== 'string' || !editPrompt.trim()) throw new StartFrameInputError('Edit mode needs an edit prompt.');
    const base = await loadImageInput(existing);
    if (!base) throw new StartFrameInputError(`The current ${frame} frame image could not be read.`);
    const extras = [];
    for (const id of editReferenceImageIds || []) {
      const ref = await loadImageInput(id);
      if (ref) extras.push({ buffer: ref.buffer, contentType: ref.contentType });
    }
    renderPrompt = editPrompt.trim();
    inputImages = [{ buffer: base.buffer, contentType: base.contentType }, ...extras];
  } else {
    renderPrompt = stripMarkdown(typeof prompt === 'string' && prompt.trim() ? prompt : current?.prompt || '').trim();
    if (!renderPrompt) throw new StartFrameInputError(`This cut has no ${frame}-frame prompt yet.`);
    const refs = await resolveReferences({ projectId, cut, key, prompt: renderPrompt, imageModel: model });
    refIds = refs.ids;
    refScores = refs.scores;
    const continuityId = frame === 'end' && cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
    inputImages = await loadReferenceBuffers(refIds, refScores, model, await referenceRoster(projectId, beat), current?.reference_uses || {}, continuityId);
  }
  // The binding preamble: ComfyUI writes it itself (it knows the model's
  // reference token), every other provider gets it here. Edit mode passes
  // the instruction through untouched.
  const comfy = isComfyImageModelId(model);
  const dispatchPrompt = mode === 'edit' || comfy
    ? renderPrompt
    : composeStartFramePrompt(renderPrompt, inputImages);
  if (!comfy) inputImages = inputImages.map(({ buffer, contentType }) => ({ buffer, contentType }));
  const dispatchArgs = { prompt: dispatchPrompt, model, mode: mode === 'edit' ? 'edit' : 'generate', inputImages };
  if (comfyParams && isComfyImageModelId(model)) dispatchArgs.comfyParams = comfyParams;
  const result = await dispatch(dispatchArgs);
  const file = await uploadGeneratedImage(projectId, {
    buffer: result.buffer,
    contentType: result.contentType,
    prompt: renderPrompt,
    generatedBy: result.model || model,
    ownerType: 'beat',
    ownerId: beat?._id || cut.beat_id,
    filename: `cut-${cut._id}-${frame}-frame-${Date.now()}.png`,
    description: '',
  });
  const nextPrompt = mode === 'edit' ? current?.prompt || '' : renderPrompt;
  if (mode !== 'edit' && nextPrompt !== (current?.prompt || '')) {
    // A one-off prompt becomes the stored prompt: write it through the y-doc
    // fragment too so open editors show what was rendered.
    try {
      await setVideoPromptTextFieldViaGateway({ projectId, promptId: String(cut._id), field: `${key}_prompt`, text: nextPrompt });
    } catch (e) {
      logger.warn(`cut ${frame} frame: sync prompt fragment failed: ${e?.message || e}`);
    }
  }
  const updated = await setVideoPromptStartFrameViaGateway({
    projectId,
    promptId: String(cut._id),
    frame,
    startFrame: {
      image_id: file._id,
      prompt: nextPrompt,
      reference_ids: refIds,
      reference_scores: refScores,
      reference_uses: current?.reference_uses || {},
      references_planned: current?.references_planned === true,
      model,
      generated_at: new Date(),
      previous_image_id: current?.previous_image_id || null,
    },
  });
  return { image_id: file._id.toString(), reference_ids: refIds, cut: updated };
}

// Bulk render for a set of cuts. CALLER HOLDS THE BEAT LOCK. `frames` picks
// start, end or both; a cut's frames render in that order (so an end frame
// sees the fresh start frame), cuts run `concurrency` at a time. Progress
// counts FRAMES. Skips frames already rendered when skipRendered is true; an
// end frame with no prompt (a cut planned before end frames existed) is
// skipped with a warning. Never throws for one frame's error.
export async function renderStartFramesForCuts({
  projectId,
  beat,
  cutIds,
  frames = ['start'],
  imageModel = null,
  skipRendered = true,
  comfyParams = null,
  concurrency = START_FRAME_CONCURRENCY,
  onProgress = null,
  onWarning = null,
  shouldStop = null,
}) {
  const ids = (cutIds || []).map(String);
  const which = normalizeFrames(frames);
  const results = [];
  const progress = { planned: ids.length * which.length, rendered: 0, failed: 0, skipped: 0 };
  const report = () => onProgress?.({ ...progress });
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      // A cancel stops the job BETWEEN cuts: renders already at the provider
      // finish and are kept (they are paid for), nothing new is started.
      if (shouldStop?.()) return;
      const id = ids[next++];
      let cut = null;
      for (const frame of which) {
        const key = cutFrameKey(frame);
        try {
          if (!cut) cut = await getVideoPrompt(projectId, id);
          if (!cut) throw new CutNotFoundError(id);
          if (skipRendered && cut[key]?.image_id) {
            progress.skipped += 1;
            results.push({ cut_id: id, frame, image_id: String(cut[key].image_id), skipped: true });
            report();
            continue;
          }
          if (frame === 'end' && !String(cut.end_frame?.prompt || '').trim()) {
            progress.skipped += 1;
            const label = cut.title ? `"${stripMarkdown(cut.title)}"` : id;
            onWarning?.(`Cut ${label} has no end-frame prompt — write one or re-plan the scene; end frame skipped.`);
            results.push({ cut_id: id, frame, image_id: null, skipped: true });
            report();
            continue;
          }
          const r = await renderCutStartFrame({ projectId, cut, beat, frame, imageModel, comfyParams });
          progress.rendered += 1;
          results.push({ cut_id: id, frame, image_id: r.image_id });
          if (r.cut) cut = r.cut;
        } catch (e) {
          progress.failed += 1;
          const label = cut?.title ? `"${stripMarkdown(cut.title)}"` : id;
          const msg = `${frame === 'end' ? 'End' : 'Start'} frame for cut ${label} failed: ${e?.message || e}`;
          logger.warn(`cut frames: ${msg}`);
          onWarning?.(msg);
          results.push({ cut_id: id, frame, image_id: null, error: e?.message || String(e) });
        }
        report();
      }
    }
  };
  report();
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length || 1)) }, worker));
  return { ...progress, results };
}

// Delete one cut's rendered start (or end) frame for good — the current image
// AND the undo blob — and keep its still prompt and references. (Setting
// image_id: null on its own would rotate the current image into the undo slot
// instead.)
export async function clearCutStartFrame({ projectId, cut, frame = 'start' }) {
  const key = cutFrameKey(frame);
  let updated = await setVideoPromptStartFrameViaGateway({ projectId, promptId: String(cut._id), frame, startFrame: null });
  if (cut[key]) {
    updated = await setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: String(cut._id),
      frame,
      startFrame: { ...cut[key], image_id: null, previous_image_id: null, generated_at: null },
    });
  }
  return updated;
}

// Every rendered start and/or end frame of a beat (prompts, references, cuts,
// clips and scenes untouched). Refused while a job holds the beat, so a
// running render cannot write a frame back behind it. Returns { cleared } —
// the number of frames cleared.
export async function clearBeatStartFrames({ projectId, beatId, frames = CUT_FRAMES }) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  const which = normalizeFrames(frames, CUT_FRAMES);
  return withBeatLock(beat._id, async () => {
    const rows = await listVideoPrompts({ projectId, beatId: beat._id });
    let cleared = 0;
    for (let cut of rows) {
      for (const frame of which) {
        const key = cutFrameKey(frame);
        if (!cut[key]?.image_id && !cut[key]?.previous_image_id) continue;
        cut = (await clearCutStartFrame({ projectId, cut, frame })) || cut;
        cleared += 1;
      }
    }
    return { cleared };
  });
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;

export function getCutStartFrameJob(jobId) {
  return jobs.get(jobId) || null;
}

export async function findCutStartFrameJobForBeat(beatId) {
  const { latestJobForBeat } = await import('./jobLookup.js');
  return latestJobForBeat(jobs, beatId);
}

function newJob({ beatId, cutIds, frames = ['start'] }) {
  const job = {
    job_id: new ObjectId().toString(),
    beat_id: String(beatId),
    cut_ids: cutIds.map(String),
    frames: [...frames],
    status: 'queued',
    planned: cutIds.length * frames.length,
    rendered: 0,
    failed: 0,
    skipped: 0,
    results: [],
    warnings: [],
    error: null,
    cancel_requested: false,
    cancelled: false,
    started_at: new Date(),
    finished_at: null,
  };
  jobs.set(job.job_id, job);
  const t = setTimeout(() => jobs.delete(job.job_id), JOB_RETENTION_MS);
  t.unref?.();
  return job;
}

function runUnderLock(beat, job, fn) {
  withBeatLock(beat._id, async () => {
    job.status = 'running';
    try {
      const r = await fn();
      Object.assign(job, { rendered: r.rendered, failed: r.failed, skipped: r.skipped, results: r.results });
      const left = job.planned - (r.rendered + r.failed + r.skipped);
      job.cancelled = job.cancel_requested && left > 0;
      if (job.cancelled) job.warnings.push(`Cancelled — ${left} frame${left === 1 ? '' : 's'} not rendered.`);
      job.status = r.failed || job.cancelled ? 'partial' : 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e?.message || String(e);
      logger.error(`cut start frame job ${job.job_id} crashed: ${job.error}`);
    } finally {
      job.finished_at = new Date();
    }
  }).catch((e) => {
    job.status = 'error';
    job.error = e?.message || String(e);
    job.finished_at = new Date();
  });
}

// Bulk: every cut of the beat (or the given cut ids), the requested frames
// (start by default), skipping rendered frames by default.
export async function startCutStartFramesJob({ projectId, beatId, cutIds = null, frames = ['start'], skipRendered = true, imageModel = null, comfyParams = null }) {
  const which = normalizeFrames(frames);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  let ids = Array.isArray(cutIds) && cutIds.length ? cutIds.map(String) : null;
  if (!ids) {
    const rows = await listVideoPrompts({ projectId, beatId: beat._id });
    ids = rows.map((r) => String(r._id));
  }
  const job = newJob({ beatId: beat._id, cutIds: ids, frames: which });
  runUnderLock(beat, job, () =>
    renderStartFramesForCuts({
      projectId,
      beat,
      cutIds: ids,
      frames: which,
      imageModel,
      skipRendered,
      comfyParams,
      onProgress: (p) => Object.assign(job, p),
      onWarning: (w) => job.warnings.push(w),
      shouldStop: () => job.cancel_requested,
    }),
  );
  return job.job_id;
}

// Single cut, one frame: generate (optionally with a one-off prompt) or edit.
export async function startSingleCutStartFrameJob({
  projectId,
  cutId,
  frame = 'start',
  imageModel = null,
  prompt = null,
  mode = 'generate',
  editPrompt = null,
  editReferenceImageIds = [],
  comfyParams = null,
}) {
  const cut = await getVideoPrompt(projectId, cutId);
  if (!cut) throw new CutNotFoundError(cutId);
  const beat = await getBeat(projectId, String(cut.beat_id));
  if (!beat) throw new Error(`Beat not found for cut ${cutId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  if (mode === 'edit' && (typeof editPrompt !== 'string' || !editPrompt.trim())) {
    throw new StartFrameInputError('Edit mode needs an edit prompt.');
  }
  const key = cutFrameKey(frame);
  if (mode === 'edit' && !cut[key]?.image_id) {
    throw new StartFrameInputError(`No ${frame} frame to edit yet — render one first.`);
  }
  if (mode !== 'edit' && !(typeof prompt === 'string' && prompt.trim()) && !cut[key]?.prompt) {
    throw new StartFrameInputError(`This cut has no ${frame}-frame prompt yet.`);
  }
  const job = newJob({ beatId: beat._id, cutIds: [String(cut._id)], frames: [frame === 'end' ? 'end' : 'start'] });
  runUnderLock(beat, job, async () => {
    try {
      const fresh = await getVideoPrompt(projectId, cutId);
      const r = await renderCutStartFrame({ projectId, cut: fresh, beat, frame, imageModel, prompt, mode, editPrompt, editReferenceImageIds, comfyParams });
      return { rendered: 1, failed: 0, skipped: 0, results: [{ cut_id: String(cut._id), frame, image_id: r.image_id }] };
    } catch (e) {
      job.warnings.push(e?.message || String(e));
      return { rendered: 0, failed: 1, skipped: 0, results: [{ cut_id: String(cut._id), frame, image_id: null, error: e?.message || String(e) }] };
    }
  });
  return job.job_id;
}

// Ask a running job to stop after the renders already in flight. Returns the
// job, or null when there is no such job.
export function cancelCutStartFrameJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running') job.cancel_requested = true;
  return job;
}

export function _clearCutStartFrameJobsForTests() {
  jobs.clear();
}
