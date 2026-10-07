// cutFrames.js
//
// Rendering a cut's frames (Scenes tab): the start frame, the end frame or
// one of its keyframes — addressed by a FRAME KEY 'start' | 'end' | 'kf:<id>'
// (gateway.js#parseFrameKey). One frame = the frame's own prompt + the
// frame's own reference images, sent to the image model the user picked —
// nothing is planned, picked or checked for them:
//
//   frame.prompt + frame.reference_ids → dispatchStillImage → a beat-owned
//   image → setVideoPromptStartFrameViaGateway (the replaced image becomes
//   the one-step undo target).
//
// Each reference is bound by what it is (startFramePrompt.js): artwork of one
// of the beat's characters gives the face and build, a wardrobe plate the
// clothes, set artwork the place; the cut's own start frame, when it is among
// the END frame's references, is the opening frame of the same shot.
//
// Jobs are in-memory and per frame: one render at a time for each frame of a
// cut (start, end, each keyframe); different frames and cuts run side by side.

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { deleteImages, uploadGeneratedImage } from '../mongo/images.js';
import { getBeat } from '../mongo/plots.js';
import { getModelDefaults } from '../mongo/projectSettings.js';
import { getVideoPrompt } from '../mongo/videoPrompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { isComfyImageModelId } from '../comfy/imageModels.js';
import { loadImageInput } from './beatPlanShared.js';
import { frameLabel, getCutFrame, parseFrameKey, setVideoPromptStartFrameViaGateway } from './gateway.js';
import { maxReferenceImagesFor } from './imageModelInfo.js';
import { isTerminalJobStatus, RECENT_JOB_MS } from './jobLookup.js';
import { composeStartFramePrompt } from './startFramePrompt.js';
import { dispatchStillImage } from './stillImageDispatch.js';

export const DEFAULT_FRAME_MODEL = 'nano-banana-pro';

let dispatcherOverride = null;
export function _setCutFrameDispatcherForTests(fn) {
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

export class CutFrameBusyError extends Error {
  // `label` is frameLabel(frame, cut): "start frame", "keyframe at 4 s"…
  constructor(label, jobId) {
    super(`This cut's ${label} is already rendering.`);
    this.code = 'CUT_BUSY';
    this.status = 409;
    this.job_id = jobId;
  }
}

export class CutFrameInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_FRAME_INPUT';
    this.status = 400;
  }
}

async function resolveImageModel(projectId, imageModel) {
  if (imageModel) return imageModel;
  try {
    const d = await getModelDefaults(projectId);
    if (d?.image_with_refs) return d.image_with_refs;
  } catch (e) {
    logger.warn(`cut frame: model defaults failed: ${e?.message || e}`);
  }
  return DEFAULT_FRAME_MODEL;
}

// Who each artwork shows, by image id, from the beat's artwork catalog.
async function referenceRoster(projectId, beat) {
  const roster = new Map();
  if (!beat) return roster;
  try {
    const { buildReferenceCatalog } = await import('./referenceCatalog.js');
    for (const e of await buildReferenceCatalog(projectId, beat)) {
      roster.set(String(e.image_id), { name: e.owner_name, ownerType: e.owner_type, wardrobe: !!e.wardrobe, prop: e.prop || '' });
    }
  } catch (e) {
    logger.warn(`cut frame: reference roster failed: ${e?.message || e}`);
  }
  return roster;
}

// The frame's references, loaded and labelled, in the order the model gets
// them — which is the STORED order, unchanged: the binding preamble numbers
// them "Image 1…" in this order and the frame prompt refers to them by those
// numbers, so the Nth id in `reference_ids` is always Image N (2026-10-05;
// the renderer used to re-sort by role, and a prompt written against the
// stored list named the wrong picture). Exactly the listed images (capped at
// what the model accepts) — an empty list renders from the prompt alone.
async function loadReferences({ projectId, beat, cut, frame, model }) {
  const ids = (getCutFrame(cut, frame)?.reference_ids || []).map(String).slice(0, maxReferenceImagesFor(model));
  if (!ids.length) return [];
  const roster = await referenceRoster(projectId, beat);
  // The end frame and every keyframe may carry the cut's start frame as the
  // opening frame of the same shot.
  const startImage = frame !== 'start' && cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
  const out = [];
  for (const id of ids) {
    const ref = await loadImageInput(id);
    if (!ref) continue;
    const who = roster.get(id);
    let role = 'look';
    let label = '';
    if (id === startImage) {
      role = 'continuity';
      label = 'the opening frame of this shot';
    } else if (who?.prop) {
      role = 'prop';
      label = who.prop;
    } else if (who?.ownerType === 'character') {
      role = who.wardrobe ? 'wardrobe' : 'identity';
      label = who.name;
    } else if (who) {
      label = `the set "${who.name}"`;
    }
    out.push({ buffer: ref.buffer, contentType: ref.contentType, label, role });
  }
  return out;
}

// Render one frame of one cut and store it. Returns the updated cut.
export async function renderCutFrame({ projectId, cut, frame = 'start', imageModel = null, comfyParams = null }) {
  parseFrameKey(frame);
  const current = getCutFrame(cut, frame);
  const prompt = stripMarkdown(current?.prompt || '').trim();
  if (!prompt) throw new CutFrameInputError(`This cut's ${frameLabel(frame, cut)} has no prompt yet.`);
  const beat = await getBeat(projectId, String(cut.beat_id));
  const model = await resolveImageModel(projectId, imageModel);
  const refs = await loadReferences({ projectId, beat, cut, frame, model });
  // ComfyUI writes the binding itself (it knows the model's reference token);
  // every other provider gets it here.
  const comfy = isComfyImageModelId(model);
  const args = {
    prompt: comfy ? prompt : composeStartFramePrompt(prompt, refs),
    model,
    mode: 'generate',
    inputImages: comfy ? refs : refs.map(({ buffer, contentType }) => ({ buffer, contentType })),
  };
  if (comfy && comfyParams) args.comfyParams = comfyParams;
  const result = await dispatch(args);
  return storeCutFrameImage({
    projectId,
    cut,
    frame,
    buffer: result.buffer,
    contentType: result.contentType,
    prompt,
    model,
    generatedBy: result.model || model,
  });
}

// Store a picture as a cut's start or end frame: a beat-owned image, set on
// the frame (the replaced image becomes the one-step undo target), and — for
// the start frame — the end frame's reference to it repointed. Used by the
// renderer above and by the MCP server, whose agent brings its own pictures.
// Returns the updated cut.
export async function storeCutFrameImage({ projectId, cut, frame = 'start', buffer, contentType, prompt = null, model = null, generatedBy = null }) {
  const fk = parseFrameKey(frame);
  const current = getCutFrame(cut, frame);
  const file = await uploadGeneratedImage(projectId, {
    buffer,
    contentType,
    prompt,
    generatedBy: generatedBy || model,
    ownerType: 'beat',
    ownerId: cut.beat_id,
    filename: `cut-${cut._id}-${fk.kind === 'keyframe' ? `kf-${fk.kfId}` : frame}-frame-${Date.now()}.png`,
    description: '',
  });
  // Re-read: the prompt and the reference list are edited live while a
  // render runs, and this write must not put the old ones back.
  const fresh = await getVideoPrompt(projectId, String(cut._id));
  if (fk.kind === 'keyframe' && fresh && !getCutFrame(fresh, frame)) {
    // The keyframe was deleted while its picture rendered: never resurrect it.
    try {
      await deleteImages([String(file._id)]);
    } catch {}
    throw new CutFrameInputError('This keyframe was removed while it rendered.');
  }
  const latest = (fresh && getCutFrame(fresh, frame)) || current;
  const updated = await setVideoPromptStartFrameViaGateway({
    projectId,
    promptId: String(cut._id),
    frame,
    startFrame: {
      image_id: file._id,
      reference_ids: latest?.reference_ids || [],
      model,
      generated_at: new Date(),
      previous_image_id: latest?.previous_image_id || null,
    },
  });
  if (frame !== 'start') return updated;
  return repointStartFrameReference({ projectId, cut: updated, from: latest?.image_id || current?.image_id });
}

// The end frame and the keyframes may list the cut's start frame as a
// reference. When the start frame's image changes (a new render, an undo),
// every such list follows it, so none points at a replaced picture.
export async function repointStartFrameReference({ projectId, cut, from }) {
  const to = cut?.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
  const old = from ? String(from) : null;
  if (!old || !to || old === to) return cut;
  let updated = cut;
  const targets = [
    ['end', cut?.end_frame],
    ...(cut?.keyframes || []).map((kf) => [`kf:${kf.id}`, kf]),
  ];
  for (const [frame, sub] of targets) {
    if (!sub) continue;
    const ids = (sub.reference_ids || []).map(String);
    if (!ids.includes(old)) continue;
    updated = await setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: String(cut._id),
      frame,
      startFrame: { ...sub, reference_ids: ids.map((id) => (id === old ? to : id)) },
    });
  }
  return updated;
}

// Delete a frame's rendered image for good — the current image AND the undo
// blob — and keep its prompt and references (a keyframe keeps its entry).
export async function clearCutFrame({ projectId, cut, frame = 'start' }) {
  const fk = parseFrameKey(frame);
  const kept = getCutFrame(cut, frame);
  let updated = await setVideoPromptStartFrameViaGateway({ projectId, promptId: String(cut._id), frame, startFrame: null });
  if (kept && fk.kind !== 'keyframe') {
    updated = await setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: String(cut._id),
      frame,
      startFrame: { prompt: kept.prompt, reference_ids: kept.reference_ids },
    });
  }
  return updated;
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;

export function _resetCutFrameJobsForTests() {
  jobs.clear();
}

export function getCutFrameJob(jobId) {
  return jobs.get(jobId) || null;
}

export function serializeCutFrameJob(job) {
  if (!job) return null;
  const { job_id, beat_id, cut_id, frame, status, error, started_at, finished_at } = job;
  return { job_id, beat_id, cut_id, frame, status, error, started_at, finished_at };
}

// The running render of one frame of one cut, if any.
export function activeCutFrameJob(cutId, frame) {
  return activeJobFor(cutId, parseFrameKey(frame).key);
}

function activeJobFor(cutId, frame) {
  for (const job of jobs.values()) {
    if (job.cut_id === String(cutId) && job.frame === frame && !isTerminalJobStatus(job.status)) return job;
  }
  return null;
}

// A beat's frame jobs for a page that has just opened: every running one,
// and the ones that failed in the last few minutes (so the error is seen).
export function listCutFrameJobsForBeat(beatId) {
  const now = Date.now();
  return [...jobs.values()]
    .filter((j) => j.beat_id === String(beatId))
    .filter((j) => !isTerminalJobStatus(j.status) || (j.status === 'error' && now - new Date(j.finished_at).getTime() < RECENT_JOB_MS))
    .map(serializeCutFrameJob);
}

// Start rendering one frame of one cut. Resolves to the job id at once; the
// render runs in the background and ends `done` or `error`.
export async function startCutFrameJob({ projectId, cutId, frame = 'start', imageModel = null, comfyParams = null }) {
  const fk = parseFrameKey(frame);
  const which = fk.key;
  const cut = await getVideoPrompt(projectId, cutId);
  if (!cut) throw new CutNotFoundError(cutId);
  const sub = getCutFrame(cut, which);
  if (fk.kind === 'keyframe' && !sub) throw new CutFrameInputError(`Keyframe not found: ${fk.kfId}`);
  if (!stripMarkdown(sub?.prompt || '').trim()) {
    throw new CutFrameInputError(`This cut's ${frameLabel(which, cut)} has no prompt yet.`);
  }
  const running = activeJobFor(cut._id, which);
  if (running) throw new CutFrameBusyError(frameLabel(which, cut), running.job_id);
  const job = {
    job_id: new ObjectId().toString(),
    beat_id: String(cut.beat_id),
    cut_id: String(cut._id),
    frame: which,
    status: 'running',
    error: null,
    started_at: new Date(),
    finished_at: null,
  };
  jobs.set(job.job_id, job);
  (async () => {
    try {
      const fresh = (await getVideoPrompt(projectId, cutId)) || cut;
      await renderCutFrame({ projectId, cut: fresh, frame: which, imageModel, comfyParams });
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e?.message || String(e);
      logger.warn(`cut frame job ${job.job_id} (${which}, cut ${job.cut_id}) failed: ${job.error}`);
    } finally {
      job.finished_at = new Date();
      const t = setTimeout(() => jobs.delete(job.job_id), JOB_RETENTION_MS);
      t.unref?.();
    }
  })();
  return job.job_id;
}
