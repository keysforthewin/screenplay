// Top-level `storyboards` collection. Each storyboard belongs to a beat and
// represents a single shot/segment within that beat's storyboard. Beats may
// have many storyboards, ordered by `order`.
//
// Schema:
//   _id: ObjectId
//   beat_id: ObjectId (indexed)
//   order: number (1..N within a beat)
//   text_prompt: string (markdown)    (the ONE prompt for this row; markdown
//                                      blob bound to the y-doc fragment
//                                      `item:<id>:text_prompt`. Editable in
//                                      the SPA. The planner seeds this at
//                                      batch-generation time and the
//                                      regen pipeline reads from it.)
//   summary: string (markdown)        (one-sentence summary of this shot,
//                                      shown in the collapsed storyboard row.
//                                      Bound to y-doc fragment
//                                      `item:<id>:summary`. Can be auto-
//                                      generated from `text_prompt` via the
//                                      POST /storyboard/:id/generate-summary
//                                      endpoint.)
//   frames: Array<{                   (ordered pool of up to MAX_FRAMES images;
//     _id: ObjectId                    stable per-frame id, survives reorder/
//                                       removal — addressed by routes, y-doc
//                                       fragments and undo state)
//     image_id: ObjectId | null        (GridFS images bucket; current image)
//     prompt: string                   (markdown; editable, persisted generation
//                                       prompt, bound to y-doc fragment
//                                       `item:<id>:frame:<frameId>:prompt`)
//     previous_image_id: ObjectId|null (one-step undo target for this frame's
//                                       inline-edit flow; cleared on undo)
//     last_edit_prompt: string         (last inline-edit prompt; cleared on undo)
//     reference_ids: ObjectId[]        (GridFS images bucket; per-frame image-gen
//                                       references — distinct from the video
//                                       model's generation-time reference list)
//   }>                                 The start_frame/end_frame distinction is
//                                      no longer stored — it is chosen at video
//                                      generation time (see resolveFrameAssignment
//                                      in src/fal/videoModels.js). Legacy docs are
//                                      lazily backfilled from the retired
//                                      start_*/end_* fields (see ensureFrames).
//   audio_file_id: ObjectId | null    (GridFS attachments bucket)
//   video_upload_file_id: ObjectId | null  (GridFS attachments bucket; a clip the
//                                      user uploaded as source material for
//                                      video-to-video fal models. Distinct
//                                      from video_file_id, which is reserved
//                                      for the generated MP4 produced by fal.
//                                      Either field can be set independently;
//                                      v2v models read from this one.)
//   video_upload_duration_seconds: number | null  (probed via music-metadata
//                                      when video_upload_file_id is attached;
//                                      null until probed)
//   video_file_id: ObjectId | null    (GridFS attachments bucket; Wan 2.7
//                                      generated MP4 of this shot)
//   video_duration_seconds: number | null  (duration of the generated MP4)
//   video_generated_at: Date | null   (when the current video was rendered)
//   video_model_id: string | null     (registry / catalog id of the model used,
//                                      e.g. 'kling-3-pro' or a fal endpoint id)
//   video_model_label: string | null  (human-friendly label shown in the SPA)
//   video_fal_model: string | null    (full fal endpoint id, e.g.
//                                      'fal-ai/sora-2/image-to-video/pro')
//   video_model_lab: string | null    (e.g. 'OpenAI', snapshot at gen time)
//   video_model_family: string | null (e.g. 'Sora 2', snapshot at gen time)
//   video_model_added_at: Date | null (release date snapshot from catalog)
//   video_parameters: object | null   (clean copy of the input payload:
//                                      duration_seconds, generate_audio,
//                                      resolution, aspect_ratio,
//                                      prompt_chars, prompt_preview)
//   video_cost_usd: number | null     (computed cost at generation time)
//   audio_duration_seconds: number | null (probed via music-metadata when
//                                      audio_file_id is attached; null
//                                      until probed)
//   duration_seconds: number | null   (1..15 inclusive, clamped to shot_type cap)
//   shot_type: string | null          (one of SHOT_TYPES)
//   transition_in: string | null      (short continuity note, ≤ MAX_TRANSITION_LEN)
//   characters_in_scene: string[]     (deduped, stripped names)
//   reverse_in_post: boolean          (when true, this is a reveal shot whose
//                                      generated video should be played in
//                                      reverse during post — the start_prompt
//                                      describes the FINAL revealed state and
//                                      the end_prompt describes the INITIAL
//                                      hidden state. AI video models can't
//                                      synthesize forward reveals coherently.
//                                      Default false.)
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';

// Shot framing classes the planner is allowed to pick. Each maps to a
// duration cap in SHOT_TYPE_DURATION_CAP. The list is intentionally short —
// adding entries means teaching the planner prompt about them too.
export const SHOT_TYPES = Object.freeze([
  'establishing',
  'cinematic_wide',
  'insert',
  'medium',
  'close_up',
  'reaction',
  'two_shot',
  'over_the_shoulder',
]);

const SHOT_TYPES_SET = new Set(SHOT_TYPES);

export const SHOT_TYPE_DURATION_CAP = Object.freeze({
  establishing: 15,
  cinematic_wide: 15,
  insert: 15,
  medium: 10,
  close_up: 5,
  reaction: 5,
  two_shot: 5,
  over_the_shoulder: 5,
});

export const ABSOLUTE_DURATION_CAP = 15;
export const MAX_TRANSITION_LEN = 280;

export function durationCapFor(shotType) {
  return SHOT_TYPE_DURATION_CAP[shotType] ?? ABSOLUTE_DURATION_CAP;
}

// Coerce-and-clamp. Returns null for non-finite / non-positive inputs (so
// callers can distinguish "unset" from "set to a small number"); otherwise
// rounds to an integer in [1, durationCapFor(shotType)].
export function clampDuration(seconds, shotType) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cap = durationCapFor(shotType);
  return Math.min(Math.max(1, Math.round(n)), cap);
}

function sanitizeTransition(s) {
  if (s == null) return null;
  const stripped = String(s).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!stripped) return null;
  return stripped.length > MAX_TRANSITION_LEN
    ? stripped.slice(0, MAX_TRANSITION_LEN)
    : stripped;
}

function sanitizeCharacterList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const n of list) {
    const stripped = stripMarkdown(String(n ?? '')).trim();
    if (!stripped) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stripped);
  }
  return out;
}

const col = () => getDb().collection('storyboards');

const HEX24 = /^[a-f0-9]{24}$/i;

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && HEX24.test(id)) return new ObjectId(id);
  throw new Error(`invalid id: ${id}`);
}

function maybeOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && HEX24.test(id)) return new ObjectId(id);
  return null;
}

function normalizeImageId(v) {
  if (v == null) return null;
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && HEX24.test(v)) return new ObjectId(v);
  throw new Error(`invalid image id: ${v}`);
}

// Max images allowed in a storyboard's frame pool.
export const MAX_FRAMES = 6;

// Coerce one raw frame sub-doc into the canonical shape.
function normalizeFrame(f) {
  const fid = f?._id instanceof ObjectId ? f._id : maybeOid(f?._id) || new ObjectId();
  return {
    _id: fid,
    image_id: f?.image_id ?? null,
    prompt: typeof f?.prompt === 'string' ? f.prompt : '',
    previous_image_id: f?.previous_image_id ?? null,
    last_edit_prompt: typeof f?.last_edit_prompt === 'string' ? f.last_edit_prompt : '',
    reference_ids: Array.isArray(f?.reference_ids) ? f.reference_ids : [],
  };
}

// Build a `frames` array from the retired start_*/end_* fields of a legacy doc.
// Only emits a frame for a role that actually carried content, so a pristine
// (all-null) legacy row maps to an empty pool. Order is start, then end.
function synthesizeFramesFromLegacy(doc) {
  const frames = [];
  for (const role of ['start', 'end']) {
    const imageId = doc[`${role}_frame_id`] ?? null;
    const prompt =
      typeof doc[`${role}_frame_prompt`] === 'string' ? doc[`${role}_frame_prompt`] : '';
    const refs = Array.isArray(doc[`${role}_frame_reference_ids`])
      ? doc[`${role}_frame_reference_ids`]
      : [];
    const prev = doc[`previous_${role}_frame_id`] ?? null;
    const lastEdit =
      typeof doc[`last_${role}_frame_edit_prompt`] === 'string'
        ? doc[`last_${role}_frame_edit_prompt`]
        : '';
    if (!imageId && !prompt && refs.length === 0 && !prev && !lastEdit) continue;
    frames.push({
      _id: new ObjectId(),
      image_id: imageId,
      prompt,
      previous_image_id: prev,
      last_edit_prompt: lastEdit,
      reference_ids: refs,
    });
  }
  return frames;
}

// Lazily migrate a legacy doc (no `frames` array) to the frames model, persisting
// the synthesized array once so the generated per-frame `_id`s stay stable across
// reads. Mirrors getPlot/ensureBeatIds. No-op when `frames` already exists.
async function ensureFrames(doc) {
  if (!doc) return doc;
  if (Array.isArray(doc.frames)) return doc;
  const frames = synthesizeFramesFromLegacy(doc);
  await col().updateOne({ _id: doc._id }, { $set: { frames } });
  return { ...doc, frames };
}

// Locate a frame in a (backfilled) storyboard by its stable id; -1 if absent.
function frameIndexOf(sb, frameId) {
  const key = String(maybeOid(frameId) || frameId);
  return sb.frames.findIndex((f) => String(f._id) === key);
}

function frameIndexOrThrow(sb, frameId) {
  const idx = frameIndexOf(sb, frameId);
  if (idx < 0) throw new Error(`frame not found: ${frameId}`);
  return idx;
}

// Read-modify-write one frame. `fn(frame, frames, idx)` mutates a shallow clone
// of the located frame; the whole array is then persisted via $set.
async function mutateFrame(id, frameId, fn) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  const idx = frameIndexOrThrow(sb, frameId);
  const frames = sb.frames.map((f) => ({ ...f, reference_ids: [...(f.reference_ids || [])] }));
  fn(frames[idx], frames, idx);
  await col().updateOne(
    { _id: sb._id },
    { $set: { frames, updated_at: new Date() } },
  );
  return getStoryboard(sb._id);
}

function backfill(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    text_prompt: typeof doc.text_prompt === 'string' ? doc.text_prompt : '',
    summary: typeof doc.summary === 'string' ? doc.summary : '',
    frames: Array.isArray(doc.frames) ? doc.frames.map(normalizeFrame) : [],
    audio_file_id: doc.audio_file_id ?? null,
    video_upload_file_id: doc.video_upload_file_id ?? null,
    video_upload_duration_seconds:
      typeof doc.video_upload_duration_seconds === 'number' &&
      Number.isFinite(doc.video_upload_duration_seconds) &&
      doc.video_upload_duration_seconds > 0
        ? doc.video_upload_duration_seconds
        : null,
    video_file_id: doc.video_file_id ?? null,
    video_duration_seconds:
      typeof doc.video_duration_seconds === 'number' && Number.isFinite(doc.video_duration_seconds)
        ? doc.video_duration_seconds
        : null,
    video_generated_at: doc.video_generated_at ?? null,
    video_model_id:
      typeof doc.video_model_id === 'string' && doc.video_model_id
        ? doc.video_model_id
        : null,
    video_model_label:
      typeof doc.video_model_label === 'string' && doc.video_model_label
        ? doc.video_model_label
        : null,
    video_fal_model:
      typeof doc.video_fal_model === 'string' && doc.video_fal_model
        ? doc.video_fal_model
        : null,
    video_model_lab:
      typeof doc.video_model_lab === 'string' && doc.video_model_lab
        ? doc.video_model_lab
        : null,
    video_model_family:
      typeof doc.video_model_family === 'string' && doc.video_model_family
        ? doc.video_model_family
        : null,
    video_model_added_at: doc.video_model_added_at ?? null,
    video_parameters:
      doc.video_parameters && typeof doc.video_parameters === 'object'
        ? doc.video_parameters
        : null,
    prompt_critique:
      doc.prompt_critique && typeof doc.prompt_critique === 'object' && !Array.isArray(doc.prompt_critique)
        ? doc.prompt_critique
        : null,
    image_critique:
      doc.image_critique && typeof doc.image_critique === 'object' && !Array.isArray(doc.image_critique)
        ? doc.image_critique
        : null,
    video_cost_usd:
      typeof doc.video_cost_usd === 'number' && Number.isFinite(doc.video_cost_usd)
        ? doc.video_cost_usd
        : null,
    audio_duration_seconds:
      typeof doc.audio_duration_seconds === 'number' &&
      Number.isFinite(doc.audio_duration_seconds) &&
      doc.audio_duration_seconds > 0
        ? doc.audio_duration_seconds
        : null,
    duration_seconds:
      typeof doc.duration_seconds === 'number' && Number.isFinite(doc.duration_seconds)
        ? doc.duration_seconds
        : null,
    shot_type:
      typeof doc.shot_type === 'string' && SHOT_TYPES_SET.has(doc.shot_type)
        ? doc.shot_type
        : null,
    transition_in:
      typeof doc.transition_in === 'string' && doc.transition_in
        ? doc.transition_in
        : null,
    characters_in_scene: Array.isArray(doc.characters_in_scene)
      ? doc.characters_in_scene.filter((s) => typeof s === 'string')
      : [],
    reverse_in_post: Boolean(doc.reverse_in_post),
  };
}

export async function listStoryboards({ beatId } = {}) {
  const filter = beatId ? { beat_id: toOid(beatId) } : {};
  const docs = await col().find(filter).sort({ order: 1 }).toArray();
  const out = [];
  for (const d of docs) out.push(backfill(await ensureFrames(d)));
  return out;
}

export async function countStoryboardsByBeat() {
  const docs = await col().find({}, { projection: { beat_id: 1 } }).toArray();
  const counts = new Map();
  for (const d of docs) {
    const k = d.beat_id?.toString?.();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

export async function getStoryboard(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(await ensureFrames(doc));
}

// Find the storyboard immediately preceding `currentOrder` in the same beat,
// i.e. the highest `order` value strictly less than the given one. Returns
// null when the caller is the first shot.
export async function getPreviousStoryboardInBeat(beatId, currentOrder) {
  const beatOid = maybeOid(beatId);
  if (!beatOid) return null;
  if (!Number.isFinite(Number(currentOrder))) return null;
  const docs = await col()
    .find({ beat_id: beatOid, order: { $lt: Number(currentOrder) } })
    .sort({ order: -1 })
    .limit(1)
    .toArray();
  return docs[0] ? backfill(await ensureFrames(docs[0])) : null;
}

export async function createStoryboard({
  beatId,
  order,
  textPrompt = '',
  summary = '',
  durationSeconds = null,
  shotType = null,
  transitionIn = null,
  charactersInScene = [],
  reverseInPost = false,
} = {}) {
  if (!beatId) throw new Error('beatId required');
  const beatOid = toOid(beatId);
  let nextOrder = order;
  if (nextOrder === undefined || nextOrder === null) {
    const existing = await col()
      .find({ beat_id: beatOid }, { projection: { order: 1 } })
      .toArray();
    nextOrder = existing.length
      ? Math.max(...existing.map((d) => d.order || 0)) + 1
      : 1;
  }
  // No clamping/validation here — callers (the planner post-processor, the
  // SPA via the gateway) do that once with attached warn logs. We just trust
  // the values and persist.
  const normalizedShotType =
    shotType && SHOT_TYPES_SET.has(shotType) ? shotType : null;
  const normalizedDuration =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
      ? durationSeconds
      : null;
  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    beat_id: beatOid,
    order: Number(nextOrder),
    text_prompt: String(textPrompt || ''),
    summary: String(summary || ''),
    frames: [],
    audio_file_id: null,
    video_upload_file_id: null,
    video_upload_duration_seconds: null,
    video_file_id: null,
    video_duration_seconds: null,
    video_generated_at: null,
    video_model_id: null,
    video_model_label: null,
    video_fal_model: null,
    video_model_lab: null,
    video_model_family: null,
    video_model_added_at: null,
    video_parameters: null,
    prompt_critique: null,
    image_critique: null,
    video_cost_usd: null,
    audio_duration_seconds: null,
    duration_seconds: normalizedDuration,
    shot_type: normalizedShotType,
    transition_in: sanitizeTransition(transitionIn),
    characters_in_scene: sanitizeCharacterList(charactersInScene),
    reverse_in_post: Boolean(reverseInPost),
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(
    `mongo: storyboard create id=${doc._id} beat=${beatOid} order=${doc.order}`,
  );
  return backfill(doc);
}

const TEXT_FIELDS = new Set(['text_prompt', 'summary']);
const ID_FIELDS = new Set([
  'audio_file_id',
  'video_file_id',
  'video_upload_file_id',
]);

export async function updateStoryboard(id, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`update_storyboard: \`patch\` must be an object.`);
  }
  const existing = await getStoryboard(id);
  if (!existing) throw new Error(`Storyboard not found: ${id}`);
  const set = { updated_at: new Date() };

  // Resolve shot_type first so a same-patch duration_seconds is clamped against
  // the NEW cap, not the pre-patch one. Throws on bad shot_type — typo from
  // the SPA is a real bug, not a planner near-miss.
  let effectiveShotType = existing.shot_type;
  if (Object.prototype.hasOwnProperty.call(patch, 'shot_type')) {
    const v = patch.shot_type;
    if (v == null) {
      effectiveShotType = null;
      set.shot_type = null;
    } else if (typeof v !== 'string' || !SHOT_TYPES_SET.has(v)) {
      throw new Error(
        `update_storyboard: shot_type must be one of ${SHOT_TYPES.join('|')}, got ${v}`,
      );
    } else {
      effectiveShotType = v;
      set.shot_type = v;
    }
  }

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'shot_type') continue; // already handled above
    if (TEXT_FIELDS.has(k)) {
      set[k] = String(v ?? '');
    } else if (ID_FIELDS.has(k)) {
      set[k] = v == null ? null : normalizeImageId(v);
    } else if (k === 'order') {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`update_storyboard: order must be a number, got ${v}`);
      }
      set[k] = Number(v);
    } else if (k === 'duration_seconds') {
      if (v == null) {
        set[k] = null;
      } else if (!Number.isFinite(Number(v)) || Number(v) <= 0) {
        throw new Error(
          `update_storyboard: duration_seconds must be a positive number or null, got ${v}`,
        );
      } else {
        const clamped = clampDuration(v, effectiveShotType);
        if (Number(v) !== clamped) {
          logger.warn(
            `mongo: storyboard ${existing._id} duration ${v}s clamped to ${clamped}s for shot_type=${effectiveShotType}`,
          );
        }
        set[k] = clamped;
      }
    } else if (k === 'transition_in') {
      set[k] = sanitizeTransition(v);
    } else if (k === 'characters_in_scene') {
      if (!Array.isArray(v)) {
        throw new Error(
          `update_storyboard: characters_in_scene must be an array of strings`,
        );
      }
      set[k] = sanitizeCharacterList(v);
    } else if (
      k === 'video_duration_seconds' ||
      k === 'audio_duration_seconds' ||
      k === 'video_upload_duration_seconds'
    ) {
      if (v == null) {
        set[k] = null;
      } else if (!Number.isFinite(Number(v)) || Number(v) <= 0) {
        throw new Error(
          `update_storyboard: ${k} must be a positive number or null, got ${v}`,
        );
      } else {
        set[k] = Number(v);
      }
    } else if (k === 'video_cost_usd') {
      if (v == null) set[k] = null;
      else if (!Number.isFinite(Number(v)) || Number(v) < 0) {
        throw new Error(
          `update_storyboard: video_cost_usd must be a non-negative number or null, got ${v}`,
        );
      } else {
        set[k] = Number(v);
      }
    } else if (k === 'video_generated_at' || k === 'video_model_added_at') {
      if (v == null) set[k] = null;
      else if (v instanceof Date) set[k] = v;
      else {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) {
          throw new Error(`update_storyboard: ${k} must be a Date or null`);
        }
        set[k] = d;
      }
    } else if (
      k === 'video_model_id' ||
      k === 'video_model_label' ||
      k === 'video_fal_model' ||
      k === 'video_model_lab' ||
      k === 'video_model_family'
    ) {
      if (v == null) set[k] = null;
      else if (typeof v !== 'string') {
        throw new Error(`update_storyboard: ${k} must be a string or null`);
      } else {
        set[k] = v;
      }
    } else if (k === 'video_parameters') {
      if (v == null) {
        set[k] = null;
      } else if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`update_storyboard: video_parameters must be an object or null`);
      } else {
        set[k] = v;
      }
    } else if (k === 'prompt_critique' || k === 'image_critique') {
      if (v == null) {
        set[k] = null;
      } else if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`update_storyboard: ${k} must be an object or null`);
      } else {
        set[k] = v;
      }
    } else if (k === 'reverse_in_post') {
      set[k] = Boolean(v);
    } else {
      throw new Error(`update_storyboard: unknown field "${k}"`);
    }
  }
  if (Object.keys(set).length === 1) {
    throw new Error('update_storyboard: patch produced no changes');
  }
  await col().updateOne({ _id: existing._id }, { $set: set });
  logger.info(
    `mongo: storyboard update id=${existing._id} fields=[${Object.keys(set)
      .filter((k) => k !== 'updated_at')
      .join(',')}]`,
  );
  return getStoryboard(existing._id);
}

export async function deleteStoryboard(id) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  await col().deleteOne({ _id: sb._id });
  logger.info(`mongo: storyboard delete id=${sb._id}`);
  return sb;
}

export async function deleteStoryboardsForBeat(beatId) {
  const beatOid = toOid(beatId);
  const list = await col().find({ beat_id: beatOid }).toArray();
  if (typeof col().deleteMany === 'function') {
    await col().deleteMany({ beat_id: beatOid });
  } else {
    for (const d of list) await col().deleteOne({ _id: d._id });
  }
  return list.map(backfill);
}

// Clear every generated frame image in a beat's storyboards (the "Delete all
// images" core). Nulls image_id, previous_image_id and last_edit_prompt on every
// frame of every shot; KEEPS each frame's prompt and reference_ids. Returns the
// freed image ids (current + undo, for GridFS cleanup), all referenced ids (so
// the caller can avoid deleting a blob still used as a reference), and the
// touched storyboard ids.
export async function clearAllFrameImagesForBeat(beatId) {
  const sbs = await listStoryboards({ beatId });
  const freedImageIds = [];
  const referencedIds = [];
  const storyboardIds = [];
  for (const sb of sbs) {
    storyboardIds.push(sb._id);
    let touched = false;
    const frames = sb.frames.map((f) => {
      if (f.image_id) { freedImageIds.push(f.image_id); touched = true; }
      if (f.previous_image_id) { freedImageIds.push(f.previous_image_id); touched = true; }
      if (f.last_edit_prompt) touched = true;
      for (const r of f.reference_ids || []) if (r) referencedIds.push(r);
      return {
        ...f,
        image_id: null,
        previous_image_id: null,
        last_edit_prompt: '',
        reference_ids: [...(f.reference_ids || [])],
      };
    });
    if (touched) {
      await col().updateOne({ _id: sb._id }, { $set: { frames, updated_at: new Date() } });
    }
  }
  return { freedImageIds, referencedIds, storyboardIds };
}

// Append a new image to the frame pool. Rejects once MAX_FRAMES is reached.
// Returns { storyboard, frameId } so callers can address the new frame.
export async function addFrame(
  id,
  { imageId = null, prompt = '', referenceIds = [] } = {},
) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  if (sb.frames.length >= MAX_FRAMES) {
    throw new Error(
      `Cannot add frame: storyboard already has the maximum of ${MAX_FRAMES} frames.`,
    );
  }
  const frame = {
    _id: new ObjectId(),
    image_id: imageId == null ? null : normalizeImageId(imageId),
    prompt: String(prompt || ''),
    previous_image_id: null,
    last_edit_prompt: '',
    reference_ids: (Array.isArray(referenceIds) ? referenceIds : [])
      .map(normalizeImageId)
      .filter(Boolean),
  };
  const frames = [...sb.frames, frame];
  await col().updateOne(
    { _id: sb._id },
    { $set: { frames, updated_at: new Date() } },
  );
  logger.info(`mongo: storyboard add frame id=${sb._id} frame=${frame._id}`);
  return { storyboard: await getStoryboard(sb._id), frameId: frame._id };
}

// Drop a frame from the pool. Returns the displaced internal undo image (if any)
// as an orphan for GridFS cleanup; the current image is left untouched since it
// may be a shared artwork/library/character image.
export async function removeFrame(id, frameId) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  const idx = frameIndexOrThrow(sb, frameId);
  const frame = sb.frames[idx];
  const orphanedImageIds = [frame.previous_image_id].filter(Boolean);
  const frames = sb.frames.filter((_, i) => i !== idx);
  await col().updateOne(
    { _id: sb._id },
    { $set: { frames, updated_at: new Date() } },
  );
  logger.info(`mongo: storyboard remove frame id=${sb._id} frame=${frameId}`);
  return { storyboard: await getStoryboard(sb._id), orphanedImageIds };
}

// Reorder the frame pool. `orderedFrameIds` must be exactly the existing ids.
export async function reorderFrames(id, orderedFrameIds) {
  if (!Array.isArray(orderedFrameIds)) {
    throw new Error('reorderFrames: orderedFrameIds must be an array');
  }
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  if (orderedFrameIds.length !== sb.frames.length) {
    throw new Error(
      `reorderFrames: expected ${sb.frames.length} ids, got ${orderedFrameIds.length}`,
    );
  }
  const byId = new Map(sb.frames.map((f) => [String(f._id), f]));
  const seen = new Set();
  const frames = [];
  for (const raw of orderedFrameIds) {
    const key = String(maybeOid(raw) || raw);
    if (seen.has(key)) throw new Error(`reorderFrames: duplicate id ${key}`);
    seen.add(key);
    const f = byId.get(key);
    if (!f) throw new Error(`reorderFrames: id ${key} not in this storyboard`);
    frames.push(f);
  }
  await col().updateOne(
    { _id: sb._id },
    { $set: { frames, updated_at: new Date() } },
  );
  return getStoryboard(sb._id);
}

// Install (or clear) a frame's current image directly — no rotation/undo.
export async function setFrameImage(id, frameId, imageId) {
  const oid = imageId == null ? null : normalizeImageId(imageId);
  return mutateFrame(id, frameId, (frame) => {
    frame.image_id = oid;
  });
}

// Rotate a frame image after an in-line edit: current becomes previous, new
// becomes current, and the prior `previous_image_id` is reported as an orphan
// for GridFS cleanup. Mirrors `setArtworkResult({rotateToPrevious})`.
export async function rotateFrameImageEdit({ id, frameId, newImageId, editPrompt }) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  const idx = frameIndexOrThrow(sb, frameId);
  const frame = sb.frames[idx];
  const current = frame.image_id || null;
  if (!current) {
    throw new Error(`rotateFrameImageEdit: frame has no current image to rotate`);
  }
  const orphanedImageId = frame.previous_image_id || null;
  const next = normalizeImageId(newImageId);
  const updated = await mutateFrame(id, frameId, (f) => {
    f.image_id = next;
    f.previous_image_id = current;
    f.last_edit_prompt = typeof editPrompt === 'string' ? editPrompt : '';
  });
  logger.info(
    `mongo: storyboard rotate frame id=${sb._id} frame=${frameId} new=${next} prev=${current}${
      orphanedImageId ? ` orphan=${orphanedImageId}` : ''
    }`,
  );
  return { storyboard: updated, orphanedImageId };
}

// Swap previous_image_id → image_id. The image that was current is reported as
// an orphan for GridFS cleanup (no redo, per spec).
export async function undoFrameImageEdit({ id, frameId }) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  const idx = frameIndexOrThrow(sb, frameId);
  const frame = sb.frames[idx];
  const previous = frame.previous_image_id || null;
  if (!previous) {
    const err = new Error('Nothing to undo — no previous image stored.');
    err.status = 400;
    throw err;
  }
  const orphanedImageId = frame.image_id || null;
  const updated = await mutateFrame(id, frameId, (f) => {
    f.image_id = previous;
    f.previous_image_id = null;
    f.last_edit_prompt = '';
  });
  logger.info(
    `mongo: storyboard undo frame id=${sb._id} frame=${frameId} restored=${previous}${
      orphanedImageId ? ` orphan=${orphanedImageId}` : ''
    }`,
  );
  return { storyboard: updated, orphanedImageId };
}

// Persist a frame's generation prompt (the Mongo-fallback path; the live SPA
// edits it as a collaborative y-doc fragment — see roomRegistry.js).
export async function setFramePrompt(id, frameId, prompt) {
  return mutateFrame(id, frameId, (frame) => {
    frame.prompt = String(prompt ?? '');
  });
}

export async function pushFrameReferenceImage(id, frameId, imageId) {
  const oid = normalizeImageId(imageId);
  return mutateFrame(id, frameId, (frame) => {
    if ((frame.reference_ids || []).some((x) => String(x) === String(oid))) return;
    frame.reference_ids = [...(frame.reference_ids || []), oid];
  });
}

export async function pullFrameReferenceImage(id, frameId, imageId) {
  const oid = normalizeImageId(imageId);
  return mutateFrame(id, frameId, (frame) => {
    frame.reference_ids = (frame.reference_ids || []).filter(
      (x) => String(x) !== String(oid),
    );
  });
}

// Append many image ids to a frame's reference list, deduping vs. existing.
// Used by the AI generation pipeline and the auto-suggest endpoint so a single
// Mongo write + a single broadcast covers many ids at once.
export async function pushFrameReferenceImages(id, frameId, imageIds) {
  return mutateFrame(id, frameId, (frame) => {
    const existing = frame.reference_ids || [];
    const seen = new Set(existing.map((x) => String(x)));
    const additions = [];
    for (const raw of imageIds || []) {
      let oid;
      try {
        oid = normalizeImageId(raw);
      } catch {
        continue;
      }
      if (!oid) continue;
      const key = String(oid);
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(oid);
    }
    frame.reference_ids = [...existing, ...additions];
  });
}

// Replace a frame's reference list with exactly the given ids (deduped,
// preserving caller order). Used by the multi-select picker's Apply button.
export async function setFrameReferenceImages(id, frameId, imageIds) {
  return mutateFrame(id, frameId, (frame) => {
    const seen = new Set();
    const next = [];
    for (const raw of imageIds || []) {
      let oid;
      try {
        oid = normalizeImageId(raw);
      } catch {
        continue;
      }
      if (!oid) continue;
      const key = String(oid);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(oid);
    }
    frame.reference_ids = next;
  });
}

// Remove every reference to `imageId` from all storyboards owned by `beatId` —
// clears any frame's current/previous image that matches, and pulls the id out
// of each frame's reference list. Used by the References tab's delete flow so the
// freed GridFS bytes don't leave dangling pointers. Returns rows modified.
export async function cleanupBeatImageReferences(beatId, imageId) {
  const beatOid = toOid(beatId);
  const imgOid = normalizeImageId(imageId);
  if (!imgOid) return 0;
  const sbs = await listStoryboards({ beatId: beatOid });
  let touched = 0;
  for (const sb of sbs) {
    let changed = false;
    const frames = sb.frames.map((f) => {
      const nf = { ...f, reference_ids: [...(f.reference_ids || [])] };
      if (nf.image_id && imgOid.equals(nf.image_id)) {
        nf.image_id = null;
        changed = true;
      }
      if (nf.previous_image_id && imgOid.equals(nf.previous_image_id)) {
        nf.previous_image_id = null;
        changed = true;
      }
      const filtered = nf.reference_ids.filter((x) => !imgOid.equals(x));
      if (filtered.length !== nf.reference_ids.length) {
        nf.reference_ids = filtered;
        changed = true;
      }
      return nf;
    });
    if (!changed) continue;
    await col().updateOne(
      { _id: sb._id },
      { $set: { frames, updated_at: new Date() } },
    );
    touched += 1;
  }
  return touched;
}

export async function reorderStoryboardsForBeat(beatId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const beatOid = toOid(beatId);
  const current = await listStoryboards({ beatId: beatOid });
  if (current.length !== orderedIds.length) {
    throw new Error(
      `reorder: orderedIds length ${orderedIds.length} != current ${current.length}`,
    );
  }
  const seen = new Set();
  for (const rawId of orderedIds) {
    const oid = toOid(rawId);
    const key = oid.toString();
    if (seen.has(key)) throw new Error(`reorder: duplicate id ${key}`);
    seen.add(key);
    if (!current.some((c) => c._id.equals?.(oid) || String(c._id) === key)) {
      throw new Error(`reorder: id ${key} not in this beat`);
    }
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await col().updateOne(
      { _id: toOid(orderedIds[i]) },
      { $set: { order: i + 1, updated_at: new Date() } },
    );
  }
  return listStoryboards({ beatId: beatOid });
}

export async function ensureIndexes() {
  await col().createIndex({ beat_id: 1, order: 1 });
}
