// src/web/cutStartFrames.js
// Pass 5 of the scene/cut planner: render each cut's START FRAME — the t=0
// still an image-to-video model opens on — from the cut's start_frame.prompt
// plus the artwork of every character in frame and the cut's set(s); and its
// END FRAME — the still a first-last-frame model lands on. Every difference
// between the two stills is animated by that model, so the end frame is built
// FROM the start frame:
//   - a held camera (end_frame.derive): an EDIT of the rendered start frame
//     with the end prompt as the change list — same set, props, seats and
//     clothing by construction;
//   - a camera that SLIDES the picture (pan, tilt, sideways truck/track,
//     crane): the start frame slid across the canvas and the revealed band
//     filled in (panEndFrame.js) — the same vantage point by construction;
//   - any other moving camera (push, pull, a track forward): a fresh still from
//     end_frame's prompt and artwork, with the rendered start frame always
//     attached as the "continuity" reference (one slot is reserved for it),
//     which owns clothing, props and layout, and is told the camera's move.
// Every function takes `frame: 'start' | 'end'`; the start frame is the default.
//
// A cut that CONTINUES the previous one (continues_previous: the same setup,
// continuous in time) does not get a start frame of its own: it opens on a
// copy of the previous cut's rendered end frame, so the two clips join without
// a jump. A bulk run renders such a chain in order, one cut after the other.
//
// Once a cut has both stills they are CHECKED as a pair (cutFrameCheck.js): a
// vision pass lists the differences the cut does not perform, and a bulk
// render repairs them (either frame, up to two rounds) before moving on. A
// single hand-made render is only checked — it is never overwritten.
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
import { WIDE_MASTER_MODELS, dispatchStillImage } from './stillImageDispatch.js';
import { composeDerivedEndPrompt, composeIntentNote, composeMovedEndPrompt, composeStartFramePrompt, composeUnderivedEndPrompt, orderReferencesByRole } from './startFramePrompt.js';
import { findCharactersInBeat, loadImageInput } from './beatPlanShared.js';
import { cutWardrobeLocks, formatLockRows } from './wardrobe.js';
import { cameraTravels } from './cutTiming.js';
import { MASTER_RESOLUTION, composeMasterMovePrompt, composeMasterPrompt, cropFromMaster, cutHasPeopleToPlace, masterAspectFor, buildShiftedCanvas, composePanEndPrompt, composePanFillPrompt, detectPanSeam, panDirectionForCut, panShiftFraction } from './panEndFrame.js';
import { blockingCount, frameCheckEnabled, frameCheckIsCurrent, reconcileCutFrames } from './cutFrameCheck.js';

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
      roster.set(String(e.image_id), { name: e.owner_name, ownerType: e.owner_type, wardrobe: !!e.wardrobe });
    }
  } catch (e) {
    logger.warn(`cut start frame: reference roster failed: ${e?.message || e}`);
  }
  return roster;
}

async function beatCharacters(projectId, beat) {
  if (!beat) return [];
  try {
    return await findCharactersInBeat(projectId, beat);
  } catch (e) {
    logger.warn(`cut start frame: beat characters failed: ${e?.message || e}`);
    return [];
  }
}

// A character reference carries identity (a wardrobe plate the clothes); a
// set reference is a look reference unless the planner said this camera
// reproduces its framing.
export function referenceRole(id, roster, uses = {}) {
  const who = roster.get(String(id));
  if (who?.ownerType === 'character') return who.wardrobe ? 'wardrobe' : 'identity';
  return uses?.[String(id)] === 'framing' ? 'framing' : 'look';
}

// The camera's move between the two stills, in a sentence for the binding.
function describeCameraMove(cut) {
  const cam = cut?.camera || {};
  const move = String(cam.movement || '').replace(/_/g, ' ');
  const travel = stripMarkdown(String(cam.travel || '')).trim();
  return travel ? `${move} — ${travel}` : move;
}

// `continuityId` (the end frame's own start frame) rides along last and ALWAYS:
// one slot of the cap is reserved for it, because it is the reference that
// keeps the two stills the same place and the same clothes.
// `wardrobePlates` ([{ id, label }], src/web/wardrobe.js): the in-frame
// people's wardrobe plates, attached with up to MAX_WARDROBE_PLATE_SLOTS
// reserved — unless a continuity frame rides along, which already owns the
// clothes.
export const MAX_WARDROBE_PLATE_SLOTS = 2;
async function loadReferenceBuffers(ids, scores, imageModel, roster = new Map(), uses = {}, continuityId = null, wardrobePlates = []) {
  const cap = Math.min(MAX_ATTACHED_REFERENCE_IMAGES, maxReferenceImagesFor(imageModel));
  const wanted = (ids || []).map(String);
  const plates = continuityId ? [] : (wardrobePlates || []).filter((p) => p?.id && !wanted.includes(String(p.id))).slice(0, MAX_WARDROBE_PLATE_SLOTS);
  const reserved = (continuityId ? 1 : 0) + Math.min(plates.length, Math.max(0, cap - (continuityId ? 1 : 0)));
  const ordered = orderReferenceIdsByScore({ referenceIds: ids, referenceScores: scores, maxTotal: Math.max(0, cap - reserved) });
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
  for (const p of plates) {
    if (out.length >= cap - (continuityId ? 1 : 0)) break;
    const ref = await loadImageInput(p.id);
    if (ref) out.push({ buffer: ref.buffer, contentType: ref.contentType, label: p.label || '', role: 'wardrobe' });
  }
  if (continuityId && cap > 0) {
    const ref = await loadImageInput(continuityId);
    if (ref) out.push({ buffer: ref.buffer, contentType: ref.contentType, label: 'the opening frame of this shot', role: 'continuity' });
  }
  return orderReferencesByRole(out);
}

// The end frame of a camera that slides the picture, built from the rendered
// start frame (see panEndFrame.js): fill the band of the slid start frame;
// when that comes back as two pictures with a seam — or when `method` is
// 'edit' (a rebuild after the pair check found a camera fault) — a plain "the
// camera has moved" edit of the start frame. → the dispatch result + { method }.
async function renderSlidEndFrame({ cut, startImage, direction, fraction, endPrompt, model, comfyParams, method = 'auto', guidance = '', master = null }) {
  const movement = cut.camera?.movement || 'pan';
  // The master plate (panEndFrame.js): one wider picture, both frames cropped
  // from it. `master` is the stored plate when the start frame is still its
  // crop; 'remaster' (a rebuild after a camera fault) makes a new one.
  if (WIDE_MASTER_MODELS.includes(model)) {
    try {
      const aspectRatio = masterAspectFor(direction);
      const plate = (prompt, image) => dispatch({ prompt, model, mode: 'edit', inputImages: [{ buffer: image.buffer, contentType: image.contentType }], aspectRatio, resolution: MASTER_RESOLUTION });
      let base = method === 'remaster' ? null : master;
      let newMaster = null;
      let startCrop = null;
      if (!base) {
        const made = await plate(composeMasterPrompt({ direction, movement, endPrompt }), startImage);
        base = { buffer: made.buffer, contentType: made.contentType };
        startCrop = await cropFromMaster(base.buffer, direction, 'start');
        newMaster = base;
      }
      let closing = base;
      const people = cutHasPeopleToPlace(cut);
      if (people) {
        const moved = await plate(composeMasterMovePrompt({ direction, movement, endPrompt, guidance }), base);
        closing = { buffer: moved.buffer, contentType: moved.contentType };
      }
      const end = await cropFromMaster(closing.buffer, direction, 'end');
      return {
        buffer: end.buffer,
        contentType: end.contentType,
        model,
        method: `master plate${newMaster ? '' : ' (reused)'}${people ? ', people moved' : ''}, ${Math.round(end.travel * 100)}% travel`,
        newMaster,
        startCrop,
      };
    } catch (e) {
      logger.warn(`cut end frame: master plate failed for ${cut._id} (${e?.message || e}); sliding the start frame instead`);
    }
  }
  const send = (prompt, image) => {
    const args = { prompt, model, mode: 'edit', inputImages: [{ buffer: image.buffer, contentType: image.contentType }] };
    if (comfyParams && isComfyImageModelId(model)) args.comfyParams = comfyParams;
    return dispatch(args);
  };
  if (method !== 'edit' && method !== 'remaster') {
    let canvas = null;
    try {
      canvas = await buildShiftedCanvas(startImage.buffer, direction, fraction);
    } catch (e) {
      logger.warn(`cut end frame: could not slide the start frame of ${cut._id}: ${e?.message || e}`);
    }
    if (canvas) {
      const result = await send(composePanFillPrompt({ direction, bandPercent: canvas.bandPercent, endPrompt, movement }), canvas);
      let seam = { seam: false };
      try {
        seam = await detectPanSeam(result.buffer, direction);
      } catch (e) {
        logger.warn(`cut end frame: seam check failed for ${cut._id}: ${e?.message || e}`);
      }
      if (!seam.seam) return { ...result, method: `slide ${canvas.bandPercent}%` };
      logger.info(`cut end frame: ${cut._id} band ${canvas.bandPercent}% came back with a seam (at ${seam.at}, coverage ${seam.coverage}, run ${seam.run}); editing the start frame instead`);
    }
  }
  const result = await send(composePanEndPrompt({ direction, fraction, endPrompt, travel: cut.camera?.travel || '', movement, guidance }), startImage);
  return { ...result, method: 'edit' };
}

// The cut before this one in its scene, when this cut continues it.
export async function previousCutInScene(projectId, cut) {
  if (!cut?.scene_id) return null;
  const rows = await listVideoPrompts({ projectId, sceneId: cut.scene_id });
  const at = rows.findIndex((r) => String(r._id) === String(cut._id));
  return at > 0 ? rows[at - 1] : null;
}

// The start frame of a cut that continues the previous one: a copy of that
// cut's end frame (its own image, so each cut's undo and cleanup stay its own).
// → { image_id, cut } or null when the previous cut has no end frame yet.
async function chainStartFrame({ projectId, cut, beat, keepUndo }) {
  const before = await previousCutInScene(projectId, cut);
  const endId = before?.end_frame?.image_id ? String(before.end_frame.image_id) : null;
  const source = endId ? await loadImageInput(endId) : null;
  if (!source) return null;
  const current = cut.start_frame || null;
  const file = await uploadGeneratedImage(projectId, {
    buffer: source.buffer,
    contentType: source.contentType,
    prompt: stripMarkdown(current?.prompt || before.end_frame?.prompt || ''),
    generatedBy: 'chained',
    ownerType: 'beat',
    ownerId: beat?._id || cut.beat_id,
    filename: `cut-${cut._id}-start-frame-${Date.now()}.png`,
    description: '',
  });
  const updated = await setVideoPromptStartFrameViaGateway({
    projectId,
    promptId: String(cut._id),
    frame: 'start',
    keepUndo,
    startFrame: {
      ...(current || {}),
      image_id: file._id,
      prompt: current?.prompt || '',
      // Which end frame this is a copy of: stale once that cut's end frame changes.
      continuity_image_id: endId,
      master_image_id: null,
      model: 'chained',
      generated_at: new Date(),
      previous_image_id: current?.previous_image_id || null,
    },
  });
  logger.info(`cut start frame: ${cut._id} opens on the end frame of ${before._id}`);
  return { image_id: file._id.toString(), reference_ids: (current?.reference_ids || []).map(String), cut: updated, chained: true };
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
  keepUndo = false,
  // 'edit': build a sliding camera's end frame by the plain edit of the start
  // frame, skipping the slid canvas (a rebuild after a camera fault).
  slideMethod = 'auto',
  // Where the landmarks should end up, from the pair check (rebuilds only).
  slideGuidance = '',
  // 'from_start': a non-sliding moving camera's end frame as ONE edit of the
  // start frame instead of a fresh still (a rebuild after a blocking fault).
  endMethod = 'auto',
}) {
  // A continuing cut opens on the previous cut's end frame. A one-off prompt
  // or an edit is the user making their own frame, and is honoured.
  if (frame === 'start' && mode !== 'edit' && cut.continues_previous && !(typeof prompt === 'string' && prompt.trim())) {
    const chained = await chainStartFrame({ projectId, cut, beat, keepUndo });
    if (chained) return chained;
  }
  const key = cutFrameKey(frame);
  const current = cut[key] || null;
  const model = await resolveImageModel(projectId, imageModel);
  // The wardrobe lock for the people in this frame (src/web/wardrobe.js).
  const locks = mode === 'edit' ? [] : cutWardrobeLocks(cut, await beatCharacters(projectId, beat), beat);
  const wardrobeLocks = formatLockRows(locks);
  const wardrobePlates = locks.filter((r) => r.image_id).map((r) => ({ id: r.image_id, label: r.name }));
  let renderPrompt;
  let inputImages;
  let refIds = (current?.reference_ids || []).map(String);
  let refScores = current?.reference_scores || {};
  // What actually goes to the model, when it is not renderPrompt itself, and
  // the start-frame image this end frame is built against.
  let composedPrompt = null;
  let dispatchMode = mode === 'edit' ? 'edit' : 'generate';
  let continuityImageId = current?.continuity_image_id || null;
  const startImageId = frame === 'end' && cut.start_frame?.image_id ? String(cut.start_frame.image_id) : null;
  const derive = frame === 'end' && mode !== 'edit' && current?.derive === true;
  // A pan, tilt, sideways truck/track or crane: the end frame is the start
  // frame slid across the canvas (set below once the start image is loaded).
  let slide = null;
  // Kept through edits and repairs of the end frame; replaced by a new plate.
  let masterImageId = frame === 'end' && mode === 'edit' && current?.master_image_id ? String(current.master_image_id) : null;
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
    // An end frame edited AGAINST the current start frame (a continuity
    // repair) is built on it from now on.
    if (startImageId && (editReferenceImageIds || []).map(String).includes(startImageId)) continuityImageId = startImageId;
  } else {
    renderPrompt = stripMarkdown(typeof prompt === 'string' && prompt.trim() ? prompt : current?.prompt || '').trim();
    if (!renderPrompt) throw new StartFrameInputError(`This cut has no ${frame}-frame prompt yet.`);
    // A held camera: the end frame is the start frame, edited. Only the start
    // image goes in — character artwork would bring its own wardrobe back.
    const slideDirection = frame === 'end' && !derive ? panDirectionForCut(cut) : null;
    const fromStart = frame === 'end' && endMethod === 'from_start' && !derive && !slideDirection;
    const startImage = (derive || slideDirection || fromStart) && startImageId && maxReferenceImagesFor(model) >= 1 ? await loadImageInput(startImageId) : null;
    if (startImage && slideDirection) {
      slide = { startImage, direction: slideDirection, fraction: panShiftFraction(cut) };
      // The stored master plate is still good while the start frame is the
      // crop that was taken from it.
      const masterId = current?.master_image_id && String(current.continuity_image_id || '') === startImageId ? String(current.master_image_id) : null;
      if (masterId) slide.master = await loadImageInput(masterId);
      if (slide.master) masterImageId = masterId;
      inputImages = [];
      continuityImageId = startImageId;
    } else if (startImage) {
      inputImages = [{ buffer: startImage.buffer, contentType: startImage.contentType }];
      composedPrompt = fromStart
        ? composeMovedEndPrompt(renderPrompt, { cameraMove: describeCameraMove(cut), guidance: slideGuidance })
        : composeDerivedEndPrompt(renderPrompt);
      dispatchMode = 'edit';
      continuityImageId = startImageId;
    } else {
      const refs = await resolveReferences({ projectId, cut, key, prompt: renderPrompt, imageModel: model });
      refIds = refs.ids;
      refScores = refs.scores;
      inputImages = await loadReferenceBuffers(refIds, refScores, model, await referenceRoster(projectId, beat), current?.reference_uses || {}, startImageId, wardrobePlates);
      // The continuity frame is told how the camera got from it to this frame.
      if (frame === 'end' && cameraTravels(cut)) {
        inputImages = inputImages.map((r) => (r.role === 'continuity' ? { ...r, cameraMove: describeCameraMove(cut) } : r));
      }
      if (frame === 'end') continuityImageId = inputImages.some((r) => r.role === 'continuity') ? startImageId : null;
      // Derived, but no start frame to edit yet (or a model that takes no
      // image): the change list alone describes nothing, so it rides on the
      // start prompt.
      if (derive) composedPrompt = composeUnderivedEndPrompt(stripMarkdown(cut.start_frame?.prompt || ''), renderPrompt);
    }
  }
  // The binding preamble: ComfyUI writes it itself (it knows the model's
  // reference token), every other provider gets it here. Edit mode passes
  // the instruction through untouched.
  const comfy = isComfyImageModelId(model);
  // A fresh still is told what the cut means; an edit (a held camera's change
  // list, a repair, a hand edit) keeps the picture it is given.
  const intent = dispatchMode === 'generate' && mode !== 'edit' ? composeIntentNote(cut, { wardrobeLocks }) : '';
  const body = [composedPrompt || renderPrompt, intent].filter(Boolean).join('\n\n');
  const dispatchPrompt = dispatchMode === 'edit' || comfy
    ? body
    : composeStartFramePrompt(body, inputImages);
  if (!comfy) inputImages = inputImages.map(({ buffer, contentType }) => ({ buffer, contentType }));
  else inputImages = inputImages.map(({ cameraMove, ...r }) => r);
  const dispatchArgs = { prompt: dispatchPrompt, model, mode: dispatchMode, inputImages };
  if (comfyParams && isComfyImageModelId(model)) dispatchArgs.comfyParams = comfyParams;
  const result = slide
    ? await renderSlidEndFrame({ cut, startImage: slide.startImage, direction: slide.direction, fraction: slide.fraction, endPrompt: [renderPrompt, composeIntentNote(cut, { wardrobeLocks })].filter(Boolean).join('\n\n'), model, comfyParams, method: slideMethod, guidance: slideGuidance, master: slide.master || null })
    : await dispatch(dispatchArgs);
  if (slide) logger.info(`cut end frame: ${cut._id} built from its start frame (${slide.direction}, ${result.method})`);
  const upload = (buffer, contentType, name, text) => uploadGeneratedImage(projectId, {
    buffer,
    contentType,
    prompt: text,
    generatedBy: result.model || model,
    ownerType: 'beat',
    ownerId: beat?._id || cut.beat_id,
    filename: `cut-${cut._id}-${name}-${Date.now()}.png`,
    description: '',
  });
  if (slide && result.newMaster) {
    // A new master plate: keep it, and make the start frame its crop so the
    // two frames are the same picture (Undo on the start frame restores the
    // one it replaces).
    const plateFile = await upload(result.newMaster.buffer, result.newMaster.contentType, 'master-plate', `Master plate: ${renderPrompt}`);
    masterImageId = plateFile._id.toString();
    if (result.startCrop) {
      const startFile = await upload(result.startCrop.buffer, result.startCrop.contentType, 'start-frame', stripMarkdown(cut.start_frame?.prompt || ''));
      await setVideoPromptStartFrameViaGateway({
        projectId,
        promptId: String(cut._id),
        frame: 'start',
        startFrame: { ...cut.start_frame, image_id: startFile._id, generated_at: new Date() },
      });
      continuityImageId = startFile._id.toString();
    }
  }
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
    keepUndo,
    startFrame: {
      image_id: file._id,
      prompt: nextPrompt,
      reference_ids: refIds,
      reference_scores: refScores,
      reference_uses: current?.reference_uses || {},
      references_planned: current?.references_planned === true,
      derive: current?.derive === true,
      continuity_image_id: frame === 'end' ? continuityImageId : null,
      master_image_id: frame === 'end' ? masterImageId : null,
      model,
      generated_at: new Date(),
      previous_image_id: current?.previous_image_id || null,
    },
  });
  return { image_id: file._id.toString(), reference_ids: refIds, cut: updated };
}

// A warning about a pair left with a blocking fault starts with this (the SPA
// shows such lines in red).
export const BLOCKING_WARNING_PREFIX = 'BLOCKING —';

export function emptyChecks() {
  // `blocked`: failed pairs that still have a blocking issue (a subset of `failed`).
  return { passed: 0, failed: 0, repaired: 0, unchecked: 0, blocked: 0 };
}

function tallyCheck(checks, r) {
  if (!checks || !r || r.reason === 'disabled') return;
  const status = r.frame_check?.status;
  if (status === 'pass') checks.passed += 1;
  else if (status === 'fail') {
    checks.failed += 1;
    if (blockingCount(r.frame_check.issues)) checks.blocked += 1;
  }
  else checks.unchecked += 1;
  if (r.repaired) checks.repaired += 1;
}

// Check (and repair) one cut's pair, turning the outcome into warnings and
// log lines. CALLER HOLDS THE BEAT LOCK. Never throws.
async function checkPair({ projectId, beat, cut, imageModel, comfyParams, repair, shouldStop, label, onWarning, onEvent }) {
  try {
    const r = await reconcileCutFrames({
      projectId, beat, cut, imageModel, comfyParams, repair, shouldStop,
      onEvent: (text) => onEvent?.(`Cut ${label}: ${text}`),
    });
    const fc = r.frame_check;
    if (fc.status === 'fail') {
      const blocking = fc.issues.filter((i) => i.severity === 'blocking');
      const notes = [...blocking, ...fc.issues.filter((i) => i.severity !== 'blocking')].map((i) => i.note).join(' ');
      onWarning?.(`${blocking.length ? `${BLOCKING_WARNING_PREFIX} ` : ''}Cut ${label}: the start and end frames still disagree${fc.rounds ? ` after ${fc.rounds} repair round${fc.rounds === 1 ? '' : 's'}` : ''} — ${notes}`);
    } else if (fc.status === 'unchecked') {
      onEvent?.(`Cut ${label}: the frames could not be checked${r.reason ? ` (${r.reason})` : ''}.`);
    } else {
      onEvent?.(`Cut ${label}: frames match${r.repaired ? ` after ${fc.rounds} repair round${fc.rounds === 1 ? '' : 's'}` : ''}.`);
    }
    return r;
  } catch (e) {
    logger.warn(`cut frames: check failed for cut ${cut?._id}: ${e?.message || e}`);
    return { cut, frame_check: { status: 'unchecked', issues: [], rounds: 0 }, repaired: false };
  }
}

// Bulk render for a set of cuts. CALLER HOLDS THE BEAT LOCK. `frames` picks
// start, end or both; a cut's frames render in that order (so an end frame
// sees the fresh start frame), cuts run `concurrency` at a time. Progress
// counts FRAMES. Skips frames already rendered when skipRendered is true; an
// end frame with no prompt (a cut planned before end frames existed) is
// skipped with a warning. Never throws for one frame's error.
//
// `check`: once a cut has both stills, check them as a pair and (`repair`)
// fix what disagrees — cutFrameCheck.js. A pair already checked for exactly
// these two images is not checked again. `progress.checks` counts the
// verdicts; a pair that still fails is a warning, never a failed frame.
export async function renderStartFramesForCuts({
  projectId,
  beat,
  cutIds,
  frames = ['start'],
  imageModel = null,
  skipRendered = true,
  comfyParams = null,
  concurrency = START_FRAME_CONCURRENCY,
  check = false,
  repair = true,
  onProgress = null,
  onWarning = null,
  onEvent = null,
  shouldStop = null,
}) {
  const ids = (cutIds || []).map(String);
  const which = normalizeFrames(frames);
  const results = [];
  const progress = { planned: ids.length * which.length, rendered: 0, failed: 0, skipped: 0 };
  check = Boolean(check) && frameCheckEnabled();
  if (check) progress.checks = emptyChecks();
  const report = () => onProgress?.({ ...progress });
  // The unit of work is a CHAIN: a cut and the cuts after it that continue it
  // (continues_previous). A chain renders in order on one worker, because each
  // continuing cut opens on the end frame the cut before it has just made.
  const chains = [];
  {
    const rows = beat?._id ? await listVideoPrompts({ projectId, beatId: beat._id }) : [];
    const byId = new Map(rows.map((r, i) => [String(r._id), { row: r, before: rows[i - 1] || null }]));
    ids.forEach((id, i) => {
      const e = byId.get(id);
      const continues = e?.row.continues_previous && e.before && String(e.before._id) === ids[i - 1] && String(e.before.scene_id || '') === String(e.row.scene_id || '');
      if (continues && chains.length) chains[chains.length - 1].push(id);
      else chains.push([id]);
    });
  }
  let next = 0;
  const renderCut = async (id, previousEndRendered) => {
    let cut = null;
    // A start frame rendered in this run makes the cut's existing end frame
    // a picture of a different opening: it is re-rendered, never skipped.
    let startRendered = false;
    let endRendered = false;
    let renderedAny = false;
    for (const frame of which) {
      const key = cutFrameKey(frame);
      try {
        if (!cut) cut = await getVideoPrompt(projectId, id);
        if (!cut) throw new CutNotFoundError(id);
        // Likewise a continuing cut's start frame once the end frame it copies was redone.
        const stale = (frame === 'end' && startRendered) || (frame === 'start' && previousEndRendered && cut.continues_previous);
        if (skipRendered && cut[key]?.image_id && !stale) {
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
        if (frame === 'start') startRendered = true;
        else endRendered = true;
        if (frame === 'start' && cut.continues_previous && !r.chained) {
          onWarning?.(`Cut ${cut.title ? `"${stripMarkdown(cut.title)}"` : id} continues the previous cut, which has no end frame yet — its start frame was rendered on its own and may not match.`);
        }
        renderedAny = true;
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
    if (check && cut?.start_frame?.image_id && cut?.end_frame?.image_id && (renderedAny || !frameCheckIsCurrent(cut)) && !shouldStop?.()) {
      const label = cut.title ? `"${stripMarkdown(cut.title)}"` : id;
      const r = await checkPair({ projectId, beat, cut, imageModel, comfyParams, repair, shouldStop, label, onWarning, onEvent });
      tallyCheck(progress.checks, r);
      // A repair may have replaced the end frame the next cut copies.
      if (r.frame_check?.rounds) endRendered = true;
      report();
    }
    return endRendered;
  };
  const worker = async () => {
    while (next < chains.length) {
      const chain = chains[next++];
      let previousEndRendered = false;
      for (const id of chain) {
        // A cancel stops the job BETWEEN cuts: renders already at the provider
        // finish and are kept (they are paid for), nothing new is started.
        if (shouldStop?.()) return;
        previousEndRendered = await renderCut(id, previousEndRendered);
      }
    }
  };
  report();
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, chains.length || 1)) }, worker));
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
      startFrame: { ...cut[key], image_id: null, previous_image_id: null, generated_at: null, continuity_image_id: null, master_image_id: null },
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
    // { passed, failed, repaired, unchecked } once the job checks pairs.
    checks: null,
    error: null,
    cancel_requested: false,
    cancelled: false,
    started_at: new Date(),
    finished_at: null,
  };
  jobs.set(job.job_id, job);
  return job;
}

// Retention starts when the job ENDS: a check-and-repair run on a local image
// model can outlast any fixed window counted from its start.
function scheduleJobEviction(job) {
  const t = setTimeout(() => jobs.delete(job.job_id), JOB_RETENTION_MS);
  t.unref?.();
}

function runUnderLock(beat, job, fn) {
  withBeatLock(beat._id, async () => {
    job.status = 'running';
    try {
      const r = await fn();
      Object.assign(job, { rendered: r.rendered, failed: r.failed, skipped: r.skipped, results: r.results, checks: r.checks || job.checks || null });
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
      scheduleJobEviction(job);
    }
  }).catch((e) => {
    job.status = 'error';
    job.error = e?.message || String(e);
    job.finished_at = new Date();
    scheduleJobEviction(job);
  });
}

// Bulk: every cut of the beat (or the given cut ids), the requested frames
// (start by default), skipping rendered frames by default.
// `check` (default: on whenever end frames are requested — that is when a
// pair comes into being) checks each cut's pair once it is complete and
// repairs what disagrees.
export async function startCutStartFramesJob({ projectId, beatId, cutIds = null, frames = ['start'], skipRendered = true, imageModel = null, comfyParams = null, check = null, repair = true }) {
  const which = normalizeFrames(frames);
  const doCheck = check == null ? which.includes('end') : Boolean(check);
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
      check: doCheck,
      repair,
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
      // A frame made by hand is only CHECKED against its pair — a repair
      // would overwrite what the user just made. Repair is the cut's button.
      let checks = null;
      const after = r.cut || (await getVideoPrompt(projectId, cutId));
      if (frameCheckEnabled() && after?.start_frame?.image_id && after?.end_frame?.image_id) {
        checks = emptyChecks();
        const label = after.title ? `"${stripMarkdown(after.title)}"` : String(cut._id);
        tallyCheck(checks, await checkPair({ projectId, beat, cut: after, imageModel, comfyParams, repair: false, label, onWarning: (w) => job.warnings.push(w) }));
      }
      return { rendered: 1, failed: 0, skipped: 0, checks, results: [{ cut_id: String(cut._id), frame, image_id: r.image_id }] };
    } catch (e) {
      job.warnings.push(e?.message || String(e));
      return { rendered: 0, failed: 1, skipped: 0, results: [{ cut_id: String(cut._id), frame, image_id: null, error: e?.message || String(e) }] };
    }
  });
  return job.job_id;
}

// Check one cut's two rendered stills as a pair and, with `repair`, fix what
// disagrees (cutFrameCheck.js). Lives in this registry so the job GET, the
// cancel route and the page's reattach work unchanged.
export async function startCutFrameCheckJob({ projectId, cutId, repair = false, imageModel = null, comfyParams = null }) {
  const cut = await getVideoPrompt(projectId, cutId);
  if (!cut) throw new CutNotFoundError(cutId);
  const beat = await getBeat(projectId, String(cut.beat_id));
  if (!beat) throw new Error(`Beat not found for cut ${cutId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  if (!frameCheckEnabled()) throw new StartFrameInputError('Frame checking is switched off on this server (CUT_FRAME_CHECK=off).');
  if (!cut.start_frame?.image_id || !cut.end_frame?.image_id) {
    throw new StartFrameInputError('Render both the start frame and the end frame first.');
  }
  const job = newJob({ beatId: beat._id, cutIds: [String(cut._id)], frames: [] });
  job.kind = repair ? 'repair' : 'check';
  job.checks = emptyChecks();
  runUnderLock(beat, job, async () => {
    const fresh = (await getVideoPrompt(projectId, cutId)) || cut;
    const label = fresh.title ? `"${stripMarkdown(fresh.title)}"` : String(cut._id);
    const checks = emptyChecks();
    tallyCheck(checks, await checkPair({
      projectId, beat, cut: fresh, imageModel, comfyParams, repair, label,
      shouldStop: () => job.cancel_requested,
      onWarning: (w) => job.warnings.push(w),
    }));
    return { rendered: 0, failed: 0, skipped: 0, checks, results: [] };
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
