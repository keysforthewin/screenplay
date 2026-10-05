// Top-level `video_scenes` collection — the Scenes tab's SCENES. A scene is a
// numbered, named group of one beat's CUTS (rows of `video_prompts`, see
// videoPrompts.js). Its name is a collab y-doc fragment (`scene:<id>:title`
// in the `video_prompts:<beatId>` room).
//
// Schema:
//   _id: ObjectId
//   project_id: string (24-hex)
//   beat_id: ObjectId (indexed)
//   order: number (1..N within a beat — the scene's number)
//   title: string (markdown; collab fragment)
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('video_scenes');

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

function backfill(doc) {
  if (!doc) return doc;
  return {
    _id: doc._id,
    project_id: doc.project_id,
    beat_id: doc.beat_id,
    order: doc.order,
    title: typeof doc.title === 'string' ? doc.title : '',
    created_at: doc.created_at || null,
    updated_at: doc.updated_at || null,
  };
}

export async function listVideoScenes({ projectId, beatId } = {}) {
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

async function getVideoSceneAnyProject(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(doc);
}

// Locate by id, then verify the project — a cross-project id is not-found.
export async function getVideoScene(projectId, id) {
  const doc = await getVideoSceneAnyProject(id);
  if (!doc) return null;
  const pid = await resolveProjectId(projectId);
  if (doc.project_id !== pid) return null;
  return doc;
}

export async function createVideoScene({ id = null, projectId, beatId, order, title = '' } = {}) {
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
    _id: id ? toOid(id) : new ObjectId(),
    project_id: pid,
    beat_id: beatOid,
    order: Number(nextOrder),
    title: typeof title === 'string' ? title : String(title ?? ''),
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(`mongo: video_scene create id=${doc._id} beat=${beatOid} order=${doc.order}`);
  return backfill(doc);
}

export async function updateVideoScene(projectId, id, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('update_video_scene: `patch` must be an object.');
  }
  const existing = await getVideoScene(projectId, id);
  if (!existing) throw new Error(`Video scene not found: ${id}`);
  const set = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      // Stored exactly as the y-doc fragment renders it, so the store tick's
      // "did it change" comparison is stable.
      case 'title':
        set[k] = typeof v === 'string' ? v : String(v ?? '');
        break;
      case 'order':
        if (!Number.isFinite(Number(v))) {
          throw new Error(`update_video_scene: order must be a number, got ${v}`);
        }
        set[k] = Number(v);
        break;
      default:
        throw new Error(`update_video_scene: unknown field "${k}"`);
    }
  }
  if (Object.keys(set).length === 1) {
    throw new Error('update_video_scene: patch produced no changes');
  }
  await col().updateOne({ _id: existing._id }, { $set: set });
  logger.info(
    `mongo: video_scene update id=${existing._id} fields=[${Object.keys(set)
      .filter((k) => k !== 'updated_at')
      .join(',')}]`,
  );
  return getVideoScene(projectId, existing._id);
}

export async function deleteVideoScene(id) {
  const d = await getVideoSceneAnyProject(id);
  if (!d) throw new Error(`Video scene not found: ${id}`);
  await col().deleteOne({ _id: d._id });
  logger.info(`mongo: video_scene delete id=${d._id}`);
  return d;
}

export async function deleteVideoScenesForBeat(beatId) {
  const beatOid = toOid(beatId);
  const list = await col().find({ beat_id: beatOid }).toArray();
  if (typeof col().deleteMany === 'function') {
    await col().deleteMany({ beat_id: beatOid });
  } else {
    for (const d of list) await col().deleteOne({ _id: d._id });
  }
  return list.map(backfill);
}

export async function reorderVideoScenesForBeat(beatId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const beatOid = toOid(beatId);
  const current = await listVideoScenes({ beatId: beatOid });
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
  return listVideoScenes({ beatId: beatOid });
}
