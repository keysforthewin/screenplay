// Top-level `video_prompts` collection — the Prompts tab's rows. Each row is
// one self-contained Seedance-style video prompt (multi-shot, ≤ 30 s) written
// for a beat, carrying the ordered reference images the prompt names as
// @Image1..@ImageN. Beats may have many prompts, ordered by `order`. This is
// the standalone "beat → prompts → video" path that runs beside (not through)
// the storyboard pipeline.
//
// Schema:
//   _id: ObjectId
//   project_id: string (24-hex)
//   beat_id: ObjectId (indexed)
//   order: number (1..N within a beat)
//   title: string (markdown — short label, e.g. "Sarah enters the diner")
//   prompt: string (markdown — the video prompt text with @ImageN handles)
//   duration_seconds: number | null (the planner's target length; the video
//                                    dialog snaps it to the chosen model)
//   reference_images: [{ image_id: ObjectId, owner_type: 'character'|'set',
//                        owner_name: string, label: string }]
//                     ordered — index i is @Image(i+1) in the prompt and the
//                     i-th image_urls entry sent to fal
//   video_* fields: identical names/semantics to storyboards (video_file_id,
//                   video_duration_seconds, video_generated_at, video_model_id,
//                   video_model_label, video_fal_model, video_model_lab,
//                   video_model_family, video_model_added_at, video_parameters,
//                   video_cost_usd) so the SPA's StoryboardVideoPanel renders a
//                   prompt row unchanged
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('video_prompts');

const HEX24 = /^[a-f0-9]{24}$/i;

export const MAX_REFERENCE_IMAGES = 9;
export const MIN_PROMPT_DURATION = 4;
export const MAX_PROMPT_DURATION = 30;

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

const OWNER_TYPES = new Set(['character', 'set']);

// Normalize a reference_images list: valid image ids only, deduped by id,
// capped at MAX_REFERENCE_IMAGES, owner_type constrained. Throws on a
// malformed entry so a bad PATCH can't silently drop a reference.
export function normalizeReferenceImages(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('reference_images must be an array');
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') throw new Error('reference_images entry must be an object');
    const oid = maybeOid(raw.image_id);
    if (!oid) throw new Error(`reference_images entry has invalid image_id: ${raw.image_id}`);
    const key = oid.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const ownerType = OWNER_TYPES.has(raw.owner_type) ? raw.owner_type : null;
    out.push({
      image_id: oid,
      owner_type: ownerType,
      owner_name: typeof raw.owner_name === 'string' ? raw.owner_name : '',
      label: typeof raw.label === 'string' ? raw.label : '',
    });
    if (out.length >= MAX_REFERENCE_IMAGES) break;
  }
  return out;
}

function normalizeDuration(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`duration_seconds must be a positive number or null, got ${v}`);
  }
  return Math.round(n);
}

function backfill(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    title: typeof doc.title === 'string' ? doc.title : '',
    prompt: typeof doc.prompt === 'string' ? doc.prompt : '',
    duration_seconds:
      typeof doc.duration_seconds === 'number' && Number.isFinite(doc.duration_seconds) && doc.duration_seconds > 0
        ? doc.duration_seconds
        : null,
    reference_images: Array.isArray(doc.reference_images)
      ? doc.reference_images
          .filter((r) => r && r.image_id)
          .map((r) => ({
            image_id: r.image_id,
            owner_type: OWNER_TYPES.has(r.owner_type) ? r.owner_type : null,
            owner_name: typeof r.owner_name === 'string' ? r.owner_name : '',
            label: typeof r.label === 'string' ? r.label : '',
          }))
      : [],
    video_file_id: doc.video_file_id ?? null,
    video_duration_seconds:
      typeof doc.video_duration_seconds === 'number' && Number.isFinite(doc.video_duration_seconds)
        ? doc.video_duration_seconds
        : null,
    video_generated_at: doc.video_generated_at ?? null,
    video_model_id: typeof doc.video_model_id === 'string' && doc.video_model_id ? doc.video_model_id : null,
    video_model_label:
      typeof doc.video_model_label === 'string' && doc.video_model_label ? doc.video_model_label : null,
    video_fal_model: typeof doc.video_fal_model === 'string' && doc.video_fal_model ? doc.video_fal_model : null,
    video_model_lab: typeof doc.video_model_lab === 'string' && doc.video_model_lab ? doc.video_model_lab : null,
    video_model_family:
      typeof doc.video_model_family === 'string' && doc.video_model_family ? doc.video_model_family : null,
    video_model_added_at: doc.video_model_added_at ?? null,
    video_parameters:
      doc.video_parameters && typeof doc.video_parameters === 'object' && !Array.isArray(doc.video_parameters)
        ? doc.video_parameters
        : null,
    video_cost_usd:
      typeof doc.video_cost_usd === 'number' && Number.isFinite(doc.video_cost_usd) ? doc.video_cost_usd : null,
  };
}

export async function listVideoPrompts({ projectId, beatId } = {}) {
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
  projectId,
  beatId,
  order,
  title = '',
  prompt = '',
  durationSeconds = null,
  referenceImages = [],
} = {}) {
  if (!beatId) throw new Error('beatId required');
  const pid = await resolveProjectId(projectId);
  const beatOid = toOid(beatId);
  let nextOrder = order;
  if (nextOrder === undefined || nextOrder === null) {
    const existing = await col()
      .find({ beat_id: beatOid }, { projection: { order: 1 } })
      .toArray();
    nextOrder = existing.length ? Math.max(...existing.map((d) => d.order || 0)) + 1 : 1;
  }
  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    project_id: pid,
    beat_id: beatOid,
    order: Number(nextOrder),
    title: String(title || ''),
    prompt: String(prompt || ''),
    duration_seconds: normalizeDuration(durationSeconds),
    reference_images: normalizeReferenceImages(referenceImages),
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
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(`mongo: video_prompt create id=${doc._id} beat=${beatOid} order=${doc.order}`);
  return backfill(doc);
}

const TEXT_FIELDS = new Set(['title', 'prompt']);
const ID_FIELDS = new Set(['video_file_id']);
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
  for (const [k, v] of Object.entries(patch)) {
    if (TEXT_FIELDS.has(k)) {
      set[k] = String(v ?? '');
    } else if (ID_FIELDS.has(k)) {
      set[k] = normalizeFileId(v);
    } else if (STRING_OR_NULL_FIELDS.has(k)) {
      set[k] = v == null ? null : String(v);
    } else if (DATE_OR_NULL_FIELDS.has(k)) {
      if (v == null) {
        set[k] = null;
      } else {
        const d = v instanceof Date ? v : new Date(v);
        set[k] = Number.isNaN(d.getTime()) ? null : d;
      }
    } else if (k === 'duration_seconds') {
      set[k] = normalizeDuration(v);
    } else if (k === 'reference_images') {
      set[k] = normalizeReferenceImages(v);
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
    } else if (k === 'order') {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`update_video_prompt: order must be a number, got ${v}`);
      }
      set[k] = Number(v);
    } else {
      throw new Error(`update_video_prompt: unknown field "${k}"`);
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

export async function reorderVideoPromptsForBeat(beatId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const beatOid = toOid(beatId);
  const current = await listVideoPrompts({ beatId: beatOid });
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
      throw new Error(`reorder: id ${key} not in this beat`);
    }
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await col().updateOne(
      { _id: toOid(orderedIds[i]) },
      { $set: { order: i + 1, updated_at: new Date() } },
    );
  }
  return listVideoPrompts({ beatId: beatOid });
}

export async function ensureIndexes() {
  await col().createIndex({ beat_id: 1, order: 1 });
  await col().createIndex({ project_id: 1, beat_id: 1 });
}
