// Top-level `dialogs` collection. Each dialog item belongs to a beat and is a
// single line spoken by one character. Beats may have many dialogs, ordered by
// `order`.
//
// Schema:
//   _id: ObjectId
//   beat_id: ObjectId (indexed)
//   order: number (1..N within a beat)
//   body: string (markdown — what the character says)
//   character: string (markdown — the speaker's name)
//   audio_file_id: ObjectId | null  (GridFS attachments bucket — recorded line)
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('dialogs');

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

function normalizeFileId(v) {
  if (v == null) return null;
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && HEX24.test(v)) return new ObjectId(v);
  throw new Error(`invalid file id: ${v}`);
}

function backfill(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    body: typeof doc.body === 'string' ? doc.body : '',
    character: typeof doc.character === 'string' ? doc.character : '',
    audio_file_id: doc.audio_file_id ?? null,
  };
}

export async function listDialogs({ projectId, beatId } = {}) {
  if (beatId) {
    const docs = await col().find({ beat_id: toOid(beatId) }).sort({ order: 1 }).toArray();
    return docs.map(backfill);
  }
  const pid = await resolveProjectId(projectId);
  // Lenient toward legacy rows with no project_id stamp (pre-migration).
  const docs = (await col().find({}).sort({ order: 1 }).toArray()).filter(
    (d) => !d.project_id || d.project_id === pid,
  );
  return docs.map(backfill);
}

export async function countDialogsByBeat(projectId) {
  const pid = await resolveProjectId(projectId);
  const docs = await col()
    .find({}, { projection: { beat_id: 1, project_id: 1 } })
    .toArray();
  const counts = new Map();
  for (const d of docs) {
    if (d.project_id && d.project_id !== pid) continue;
    const k = d.beat_id?.toString?.();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

// Unverified internal loader — deleteDialog locates through this, keeping its
// single-id signature and any-project behavior.
async function getDialogAnyProject(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(doc);
}

export async function getDialog(projectId, id) {
  const doc = await getDialogAnyProject(id);
  if (!doc) return null;
  // Verify-after-locate: cross-project id ⇒ not-found; unstamped ⇒ in-project.
  const pid = await resolveProjectId(projectId);
  if (doc.project_id && doc.project_id !== pid) return null;
  return doc;
}

export async function createDialog({ projectId, beatId, order, body = '', character = '' } = {}) {
  if (!beatId) throw new Error('beatId required');
  const pid = await resolveProjectId(projectId);
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
    project_id: pid,
    beat_id: beatOid,
    order: Number(nextOrder),
    body: String(body || ''),
    character: String(character || ''),
    audio_file_id: null,
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(
    `mongo: dialog create id=${doc._id} beat=${beatOid} order=${doc.order}`,
  );
  return backfill(doc);
}

const TEXT_FIELDS = new Set(['body', 'character']);
const ID_FIELDS = new Set(['audio_file_id']);

export async function updateDialog(projectId, id, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`update_dialog: \`patch\` must be an object.`);
  }
  const existing = await getDialog(projectId, id);
  if (!existing) throw new Error(`Dialog not found: ${id}`);
  const set = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (TEXT_FIELDS.has(k)) {
      set[k] = String(v ?? '');
    } else if (ID_FIELDS.has(k)) {
      set[k] = normalizeFileId(v);
    } else if (k === 'order') {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`update_dialog: order must be a number, got ${v}`);
      }
      set[k] = Number(v);
    } else {
      throw new Error(`update_dialog: unknown field "${k}"`);
    }
  }
  if (Object.keys(set).length === 1) {
    throw new Error('update_dialog: patch produced no changes');
  }
  await col().updateOne({ _id: existing._id }, { $set: set });
  logger.info(
    `mongo: dialog update id=${existing._id} fields=[${Object.keys(set)
      .filter((k) => k !== 'updated_at')
      .join(',')}]`,
  );
  return getDialog(projectId, existing._id);
}

export async function deleteDialog(id) {
  const d = await getDialogAnyProject(id);
  if (!d) throw new Error(`Dialog not found: ${id}`);
  await col().deleteOne({ _id: d._id });
  logger.info(`mongo: dialog delete id=${d._id}`);
  return d;
}

export async function deleteDialogsForBeat(beatId) {
  const beatOid = toOid(beatId);
  const list = await col().find({ beat_id: beatOid }).toArray();
  if (typeof col().deleteMany === 'function') {
    await col().deleteMany({ beat_id: beatOid });
  } else {
    for (const d of list) await col().deleteOne({ _id: d._id });
  }
  return list.map(backfill);
}

export async function reorderDialogsForBeat(beatId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const beatOid = toOid(beatId);
  const current = await listDialogs({ beatId: beatOid });
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
  return listDialogs({ beatId: beatOid });
}

export async function ensureIndexes() {
  await col().createIndex({ beat_id: 1, order: 1 });
  await col().createIndex({ project_id: 1, beat_id: 1 });
}
