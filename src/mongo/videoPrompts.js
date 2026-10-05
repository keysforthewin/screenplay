// Top-level `video_prompts` collection — the Scenes tab's CUTS. A cut is one
// clip: a name, a length, the prompt handed to the video model, and the two
// stills (start frame, end frame) the clip runs between — each with its own
// prompt and its own reference images for the image model. Cuts are grouped
// under SCENES (src/mongo/videoScenes.js) via `scene_id`; cut "2.3" is the
// third cut (`cut_index`) of the scene whose `order` is 2.
//
// Schema:
//   _id: ObjectId
//   project_id: string (24-hex)
//   beat_id: ObjectId (indexed)
//   scene_id: ObjectId
//   cut_index: number (1..N within the scene)
//   order: number (1..N within a beat: scene by scene, see
//                  recomputeCutOrderForBeat)
//   title: string (markdown; y-doc fragment `item:<id>:title`)
//   prompt: string (markdown — the video-gen prompt; `item:<id>:prompt`)
//   duration_seconds: number | null (half-second steps)
//   start_frame / end_frame: { image_id, prompt (y-doc fragment
//                  `item:<id>:start_frame_prompt` / `end_frame_prompt`),
//                  reference_ids: [ObjectId] (the images sent to the image
//                  model with this frame's prompt, in order), model,
//                  generated_at, previous_image_id (one-step undo) } | null
//   video_* fields: video_file_id, video_duration_seconds, video_generated_at,
//                   video_model_id, video_model_label, video_fal_model,
//                   video_model_lab, video_model_family, video_model_added_at,
//                   video_parameters, video_cost_usd, video_provider
//                   ('fal'|'comfy'|null), video_comfy ({ template, model_id,
//                   params, prompt_id } | null)
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('video_prompts');
const scenesCol = () => getDb().collection('video_scenes');

const HEX24 = /^[a-f0-9]{24}$/i;

// Reference images per frame.
export const MAX_REFERENCE_IMAGES = 9;
export const VIDEO_PROVIDERS = Object.freeze(['fal', 'comfy']);

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

function normalizeFileId(v) {
  if (v == null) return null;
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && HEX24.test(v)) return new ObjectId(v);
  throw new Error(`invalid file id: ${v}`);
}

function str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

function enumOrNull(v, list) {
  const s = str(v).toLowerCase();
  return list.includes(s) ? s : null;
}

// Valid 24-hex / ObjectId entries only, deduped, order kept, capped.
export function normalizeReferenceIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const oid = maybeOid(v);
    if (!oid) continue;
    const k = oid.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(oid);
    if (out.length >= MAX_REFERENCE_IMAGES) break;
  }
  return out;
}

function dateOrNull(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// null stays null; anything else becomes the full frame shape (start_frame
// and end_frame share it).
export function normalizeFrame(raw) {
  if (raw == null) return null;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    image_id: maybeOid(src.image_id),
    prompt: typeof src.prompt === 'string' ? src.prompt : '',
    reference_ids: normalizeReferenceIds(src.reference_ids),
    model: str(src.model) || null,
    generated_at: dateOrNull(src.generated_at),
    previous_image_id: maybeOid(src.previous_image_id),
  };
}

function normalizeVideoComfy(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function normalizeDuration(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`duration_seconds must be a positive number or null, got ${v}`);
  }
  // Half-second steps: a quick cut is 1.5 s, not 1 or 2.
  return Math.max(0.5, Math.round(n * 2) / 2);
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function backfill(doc) {
  if (!doc) return doc;
  return {
    _id: doc._id,
    project_id: doc.project_id,
    beat_id: doc.beat_id,
    order: doc.order,
    scene_id: maybeOid(doc.scene_id),
    cut_index: intOrNull(doc.cut_index),
    title: typeof doc.title === 'string' ? doc.title : '',
    prompt: typeof doc.prompt === 'string' ? doc.prompt : '',
    duration_seconds: numOrNull(doc.duration_seconds) > 0 ? doc.duration_seconds : null,
    start_frame: normalizeFrame(doc.start_frame),
    end_frame: normalizeFrame(doc.end_frame),
    video_file_id: doc.video_file_id ?? null,
    video_duration_seconds: numOrNull(doc.video_duration_seconds),
    video_generated_at: doc.video_generated_at ?? null,
    video_model_id: strOrNull(doc.video_model_id),
    video_model_label: strOrNull(doc.video_model_label),
    video_fal_model: strOrNull(doc.video_fal_model),
    video_model_lab: strOrNull(doc.video_model_lab),
    video_model_family: strOrNull(doc.video_model_family),
    video_model_added_at: doc.video_model_added_at ?? null,
    video_parameters:
      doc.video_parameters && typeof doc.video_parameters === 'object' && !Array.isArray(doc.video_parameters)
        ? doc.video_parameters
        : null,
    video_cost_usd: numOrNull(doc.video_cost_usd),
    video_provider: enumOrNull(doc.video_provider, VIDEO_PROVIDERS),
    video_comfy: normalizeVideoComfy(doc.video_comfy),
    created_at: doc.created_at || null,
    updated_at: doc.updated_at || null,
  };
}

function sortCuts(docs) {
  // Within a scene: cut_index first (nulls last), then the global order.
  return docs.slice().sort((a, b) => {
    const ai = a.cut_index == null ? Infinity : a.cut_index;
    const bi = b.cut_index == null ? Infinity : b.cut_index;
    if (ai !== bi) return ai - bi;
    return (a.order || 0) - (b.order || 0);
  });
}

export async function listVideoPrompts({ projectId, beatId, sceneId } = {}) {
  if (sceneId) {
    const docs = await col().find({ scene_id: toOid(sceneId) }).toArray();
    return sortCuts(docs.map(backfill));
  }
  if (beatId) {
    const docs = await col().find({ beat_id: toOid(beatId) }).sort({ order: 1 }).toArray();
    return docs.map(backfill);
  }
  const pid = await resolveProjectId(projectId);
  const docs = (await col().find({}).sort({ order: 1 }).toArray()).filter(
    (d) => d.project_id === pid,
  );
  return docs.map(backfill);
}

export async function listVideoPromptsForScene(sceneId) {
  return listVideoPrompts({ sceneId });
}

export async function countVideoPromptsByBeat(projectId) {
  const pid = await resolveProjectId(projectId);
  const docs = await col()
    .find({}, { projection: { beat_id: 1, project_id: 1 } })
    .toArray();
  const counts = new Map();
  for (const d of docs) {
    if (d.project_id !== pid) continue;
    const k = d.beat_id?.toString?.();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

async function getVideoPromptAnyProject(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(doc);
}

export async function getVideoPrompt(projectId, id) {
  const doc = await getVideoPromptAnyProject(id);
  if (!doc) return null;
  // Verify-after-locate: a cross-project id behaves as not-found.
  const pid = await resolveProjectId(projectId);
  if (doc.project_id !== pid) return null;
  return doc;
}

export async function createVideoPrompt({
  id = null,
  projectId,
  beatId,
  sceneId,
  order,
  cutIndex = null,
  title = '',
  prompt = '',
  durationSeconds = null,
  startFrame = null,
  endFrame = null,
} = {}) {
  if (!beatId) throw new Error('beatId required');
  const sceneOid = maybeOid(sceneId);
  if (!sceneOid) throw new Error('sceneId required');
  const pid = await resolveProjectId(projectId);
  const beatOid = toOid(beatId);
  let nextOrder = order;
  if (nextOrder === undefined || nextOrder === null) {
    const existing = await col()
      .find({ beat_id: beatOid }, { projection: { order: 1 } })
      .toArray();
    nextOrder = existing.length ? Math.max(...existing.map((d) => d.order || 0)) + 1 : 1;
  }
  let nextCutIndex = intOrNull(cutIndex);
  if (nextCutIndex == null) {
    const inScene = await col()
      .find({ scene_id: sceneOid }, { projection: { cut_index: 1 } })
      .toArray();
    nextCutIndex = inScene.length ? Math.max(...inScene.map((d) => d.cut_index || 0)) + 1 : 1;
  }
  const now = new Date();
  const doc = {
    _id: id ? toOid(id) : new ObjectId(),
    project_id: pid,
    beat_id: beatOid,
    order: Number(nextOrder),
    scene_id: sceneOid,
    cut_index: nextCutIndex,
    title: String(title || ''),
    prompt: String(prompt || ''),
    duration_seconds: normalizeDuration(durationSeconds),
    start_frame: normalizeFrame(startFrame),
    end_frame: normalizeFrame(endFrame),
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
    video_cost_usd: null,
    video_provider: null,
    video_comfy: null,
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(`mongo: video_prompt create id=${doc._id} beat=${beatOid} order=${doc.order}`);
  return backfill(doc);
}

const TEXT_FIELDS = new Set(['title', 'prompt']);
const STRING_OR_NULL_FIELDS = new Set([
  'video_model_id',
  'video_model_label',
  'video_fal_model',
  'video_model_lab',
  'video_model_family',
]);
const DATE_OR_NULL_FIELDS = new Set(['video_generated_at', 'video_model_added_at']);

export async function updateVideoPrompt(projectId, id, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('update_video_prompt: `patch` must be an object.');
  }
  const existing = await getVideoPrompt(projectId, id);
  if (!existing) throw new Error(`Video prompt not found: ${id}`);
  const set = { updated_at: new Date() };
  const framePrompts = {};
  for (const [k, v] of Object.entries(patch)) {
    if (TEXT_FIELDS.has(k)) {
      set[k] = String(v ?? '');
    } else if (k === 'video_file_id') {
      set[k] = normalizeFileId(v);
    } else if (STRING_OR_NULL_FIELDS.has(k)) {
      set[k] = v == null ? null : String(v);
    } else if (DATE_OR_NULL_FIELDS.has(k)) {
      set[k] = dateOrNull(v);
    } else if (k === 'duration_seconds') {
      set[k] = normalizeDuration(v);
    } else if (k === 'video_duration_seconds' || k === 'video_cost_usd') {
      if (v == null) {
        set[k] = null;
      } else if (!Number.isFinite(Number(v)) || Number(v) < 0) {
        throw new Error(`update_video_prompt: ${k} must be a non-negative number or null, got ${v}`);
      } else {
        set[k] = Number(v);
      }
    } else if (k === 'video_parameters') {
      set[k] = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } else if (k === 'video_provider') {
      set[k] = enumOrNull(v, VIDEO_PROVIDERS);
    } else if (k === 'video_comfy') {
      set[k] = normalizeVideoComfy(v);
    } else if (k === 'order') {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`update_video_prompt: order must be a number, got ${v}`);
      }
      set[k] = Number(v);
    } else if (k === 'cut_index') {
      if (v != null && !Number.isFinite(Number(v))) {
        throw new Error(`update_video_prompt: cut_index must be a number or null, got ${v}`);
      }
      set[k] = intOrNull(v);
    } else if (k === 'start_frame' || k === 'end_frame') {
      set[k] = normalizeFrame(v);
    } else if (k === 'start_frame_prompt' || k === 'end_frame_prompt') {
      framePrompts[k.replace(/_prompt$/, '')] = typeof v === 'string' ? v : String(v ?? '');
    } else {
      throw new Error(`update_video_prompt: unknown field "${k}"`);
    }
  }
  for (const [key, text] of Object.entries(framePrompts)) {
    // The y-doc persist path for `item:<id>:start_frame_prompt` /
    // `end_frame_prompt`. A dotted $set into a null sub-doc is a Mongo
    // error, so create the sub-doc when the row has no such frame yet.
    if (set[key] && typeof set[key] === 'object') {
      set[key].prompt = text;
    } else if (set[key] === null || !existing[key]) {
      set[key] = normalizeFrame({ prompt: text });
    } else {
      set[`${key}.prompt`] = text;
    }
  }
  if (Object.keys(set).length === 1) {
    throw new Error('update_video_prompt: patch produced no changes');
  }
  await col().updateOne({ _id: existing._id }, { $set: set });
  logger.info(
    `mongo: video_prompt update id=${existing._id} fields=[${Object.keys(set)
      .filter((k) => k !== 'updated_at')
      .join(',')}]`,
  );
  return getVideoPrompt(projectId, existing._id);
}

export async function deleteVideoPrompt(id) {
  const d = await getVideoPromptAnyProject(id);
  if (!d) throw new Error(`Video prompt not found: ${id}`);
  await col().deleteOne({ _id: d._id });
  logger.info(`mongo: video_prompt delete id=${d._id}`);
  return d;
}

export async function deleteVideoPromptsForBeat(beatId) {
  const beatOid = toOid(beatId);
  const list = await col().find({ beat_id: beatOid }).toArray();
  if (typeof col().deleteMany === 'function') {
    await col().deleteMany({ beat_id: beatOid });
  } else {
    for (const d of list) await col().deleteOne({ _id: d._id });
  }
  return list.map(backfill);
}

export async function deleteVideoPromptsForScene(sceneId) {
  const sceneOid = toOid(sceneId);
  const list = await col().find({ scene_id: sceneOid }).toArray();
  if (typeof col().deleteMany === 'function') {
    await col().deleteMany({ scene_id: sceneOid });
  } else {
    for (const d of list) await col().deleteOne({ _id: d._id });
  }
  return sortCuts(list.map(backfill));
}

// The beat's scenes in their stored order, as id strings. Read straight from
// the collection so this module stays import-cycle free.
async function sceneOrderForBeat(beatOid) {
  const docs = await scenesCol()
    .find({ beat_id: beatOid }, { projection: { order: 1 } })
    .toArray();
  return docs
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((d) => d._id.toString());
}

// Recompute the global `order` of every cut in a beat: scene by scene (in
// `sceneOrder`, then any scene missing from that list in order of first
// appearance), each scene's cuts by cut_index (ties by current order,
// renumbered 1..N), then any row without a scene in its current order with
// cut_index left null. Only rows whose numbers change are written.
export async function recomputeCutOrderForBeat(beatId, sceneOrder) {
  const beatOid = toOid(beatId);
  const rows = await listVideoPrompts({ beatId: beatOid });
  const listed = Array.isArray(sceneOrder)
    ? sceneOrder.map((s) => String(s?.toString?.() ?? s))
    : await sceneOrderForBeat(beatOid);
  const byScene = new Map();
  const unsorted = [];
  for (const r of rows) {
    const sid = r.scene_id ? r.scene_id.toString() : null;
    if (!sid) {
      unsorted.push(r);
      continue;
    }
    if (!byScene.has(sid)) byScene.set(sid, []);
    byScene.get(sid).push(r);
  }
  const sceneIds = [...listed.filter((sid) => byScene.has(sid))];
  for (const sid of byScene.keys()) if (!sceneIds.includes(sid)) sceneIds.push(sid);
  let order = 0;
  const writes = [];
  for (const sid of sceneIds) {
    const cuts = sortCuts(byScene.get(sid));
    for (let i = 0; i < cuts.length; i++) {
      order += 1;
      const c = cuts[i];
      if (c.order !== order || c.cut_index !== i + 1) {
        writes.push({ _id: c._id, order, cut_index: i + 1 });
      }
    }
  }
  for (const r of unsorted) {
    order += 1;
    if (r.order !== order || r.cut_index != null) {
      writes.push({ _id: r._id, order, cut_index: null });
    }
  }
  for (const w of writes) {
    await col().updateOne(
      { _id: w._id },
      { $set: { order: w.order, cut_index: w.cut_index, updated_at: new Date() } },
    );
  }
  return listVideoPrompts({ beatId: beatOid });
}

// Renumber cut_index within one scene from an explicit full ordering, then
// recompute the beat's global order. Returns the scene's cuts.
export async function reorderCutsInScene(sceneId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const sceneOid = toOid(sceneId);
  const current = await listVideoPrompts({ sceneId: sceneOid });
  if (current.length !== orderedIds.length) {
    throw new Error(`reorder: orderedIds length ${orderedIds.length} != current ${current.length}`);
  }
  const seen = new Set();
  for (const rawId of orderedIds) {
    const oid = toOid(rawId);
    const key = oid.toString();
    if (seen.has(key)) throw new Error(`reorder: duplicate id ${key}`);
    seen.add(key);
    if (!current.some((c) => String(c._id) === key)) {
      throw new Error(`reorder: id ${key} not in this scene`);
    }
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await col().updateOne(
      { _id: toOid(orderedIds[i]) },
      { $set: { cut_index: i + 1, updated_at: new Date() } },
    );
  }
  const beatOid = current[0]?.beat_id;
  if (beatOid) await recomputeCutOrderForBeat(beatOid);
  return listVideoPrompts({ sceneId: sceneOid });
}
