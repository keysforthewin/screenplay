// Top-level `storyboards` collection. Each storyboard belongs to a beat and
// represents a single shot/segment within that beat's storyboard. Beats may
// have many storyboards, ordered by `order`.
//
// Schema:
//   _id: ObjectId
//   beat_id: ObjectId (indexed)
//   order: number (1..N within a beat)
//   text_prompt: string (markdown)
//   start_frame_id: ObjectId | null   (GridFS images bucket)
//   end_frame_id: ObjectId | null     (GridFS images bucket)
//   character_sheet_image_id: ObjectId | null (GridFS images bucket)
//   reference_image_ids: ObjectId[]   (GridFS images bucket)
//   audio_file_id: ObjectId | null    (GridFS attachments bucket)
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';

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

function backfill(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    text_prompt: typeof doc.text_prompt === 'string' ? doc.text_prompt : '',
    start_frame_id: doc.start_frame_id ?? null,
    end_frame_id: doc.end_frame_id ?? null,
    character_sheet_image_id: doc.character_sheet_image_id ?? null,
    reference_image_ids: Array.isArray(doc.reference_image_ids)
      ? doc.reference_image_ids
      : [],
    audio_file_id: doc.audio_file_id ?? null,
  };
}

export async function listStoryboards({ beatId } = {}) {
  const filter = beatId ? { beat_id: toOid(beatId) } : {};
  const docs = await col().find(filter).sort({ order: 1 }).toArray();
  return docs.map(backfill);
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
  return backfill(doc);
}

export async function createStoryboard({ beatId, order, textPrompt = '' } = {}) {
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
  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    beat_id: beatOid,
    order: Number(nextOrder),
    text_prompt: String(textPrompt || ''),
    start_frame_id: null,
    end_frame_id: null,
    character_sheet_image_id: null,
    reference_image_ids: [],
    audio_file_id: null,
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(
    `mongo: storyboard create id=${doc._id} beat=${beatOid} order=${doc.order}`,
  );
  return backfill(doc);
}

const TEXT_FIELDS = new Set(['text_prompt']);
const ID_FIELDS = new Set([
  'start_frame_id',
  'end_frame_id',
  'character_sheet_image_id',
  'audio_file_id',
]);

export async function updateStoryboard(id, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`update_storyboard: \`patch\` must be an object.`);
  }
  const existing = await getStoryboard(id);
  if (!existing) throw new Error(`Storyboard not found: ${id}`);
  const set = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (TEXT_FIELDS.has(k)) {
      set[k] = String(v ?? '');
    } else if (ID_FIELDS.has(k)) {
      set[k] = v == null ? null : normalizeImageId(v);
    } else if (k === 'order') {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`update_storyboard: order must be a number, got ${v}`);
      }
      set[k] = Number(v);
    } else if (k === 'reference_image_ids') {
      if (!Array.isArray(v)) {
        throw new Error(`update_storyboard: reference_image_ids must be an array`);
      }
      set[k] = v.map(normalizeImageId);
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

export async function pushReferenceImage(id, imageId) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  const oid = normalizeImageId(imageId);
  if ((sb.reference_image_ids || []).some((x) => x.equals?.(oid) || String(x) === String(oid))) {
    return sb;
  }
  const next = [...(sb.reference_image_ids || []), oid];
  await col().updateOne(
    { _id: sb._id },
    { $set: { reference_image_ids: next, updated_at: new Date() } },
  );
  return getStoryboard(sb._id);
}

export async function pullReferenceImage(id, imageId) {
  const sb = await getStoryboard(id);
  if (!sb) throw new Error(`Storyboard not found: ${id}`);
  const oid = normalizeImageId(imageId);
  const next = (sb.reference_image_ids || []).filter(
    (x) => !(x.equals?.(oid) || String(x) === String(oid)),
  );
  await col().updateOne(
    { _id: sb._id },
    { $set: { reference_image_ids: next, updated_at: new Date() } },
  );
  return getStoryboard(sb._id);
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
