// Top-level `video_scenes` collection — the Prompts tab's SCENES. A scene is a
// continuous stretch of one beat in one location and time (a slugline unit);
// it groups the beat's CUTS (rows of `video_prompts`, see videoPrompts.js) and
// carries the planning state every cut of the scene inherits: the ten-field
// director's read, the one-sentence intention, the scope firewall buckets,
// the floor plan (a collab y-doc fragment, `scene:<id>:floor_plan` in the
// `video_prompts:<beatId>` room) and the load score.
//
// Schema:
//   _id: ObjectId
//   project_id: string (24-hex)
//   beat_id: ObjectId (indexed)
//   order: number (1..N within a beat)
//   title: string
//   slug: string                       ("INT. DINER — NIGHT")
//   set_names: [string]                (exact beat set names)
//   character_names: [string]
//   text_span: { starts_with, ends_with }   (verbatim anchors into the beat body)
//   directors_read: { <DIRECTORS_READ_FIELDS> }
//   intention: string
//   scope: { already_happened: [], this_scene_only: [], reserved_for_later: [],
//            do_not_show_yet: [] }
//   floor_plan: string (markdown; collab fragment)
//   dialog_ids: [ObjectId]             (the beat's dialogue lines inside this scene)
//   load: { beats, load_points, total_seconds, s, verdict } | nulls
//   video_file_id: string | null      (the scene's assembled MP4, attachments bucket;
//   video_duration_seconds, video_generated_at   src/web/cutAssemble.js)
//   created_at, updated_at: Date

import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('video_scenes');

const HEX24 = /^[a-f0-9]{24}$/i;

export const DIRECTORS_READ_FIELDS = Object.freeze([
  'dramatic_function',
  'turn',
  'pov',
  'power_shift',
  'hidden_want',
  'obstacle_tactic',
  'subtext',
  'suppressed_behavior',
  'non_transferable_detail',
  'stock_solution_refused',
]);

export const SCOPE_BUCKETS = Object.freeze([
  'already_happened',
  'this_scene_only',
  'reserved_for_later',
  'do_not_show_yet',
]);

export const LOAD_VERDICTS = Object.freeze(['safe', 'stretch', 'ambitious']);

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

function str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

function stringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(str).filter(Boolean);
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positiveOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Every director's-read key present, trimmed strings. Unknown keys dropped.
export function normalizeDirectorsRead(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const f of DIRECTORS_READ_FIELDS) out[f] = str(src[f]);
  return out;
}

// Every scope bucket present as a string array.
export function normalizeScope(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const b of SCOPE_BUCKETS) out[b] = stringList(src[b]);
  return out;
}

export function normalizeTextSpan(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { starts_with: str(src.starts_with), ends_with: str(src.ends_with) };
}

export function normalizeLoad(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const verdict = str(src.verdict).toLowerCase();
  return {
    beats: numOrNull(src.beats),
    load_points: numOrNull(src.load_points),
    total_seconds: numOrNull(src.total_seconds),
    s: numOrNull(src.s),
    verdict: LOAD_VERDICTS.includes(verdict) ? verdict : null,
  };
}

function normalizeDialogIds(raw) {
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
  }
  return out;
}

function backfill(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    title: str(doc.title),
    slug: str(doc.slug),
    set_names: stringList(doc.set_names),
    character_names: stringList(doc.character_names),
    text_span: normalizeTextSpan(doc.text_span),
    directors_read: normalizeDirectorsRead(doc.directors_read),
    intention: str(doc.intention),
    scope: normalizeScope(doc.scope),
    floor_plan: typeof doc.floor_plan === 'string' ? doc.floor_plan : '',
    dialog_ids: normalizeDialogIds(doc.dialog_ids),
    load: normalizeLoad(doc.load),
    video_file_id: doc.video_file_id ? String(doc.video_file_id) : null,
    video_duration_seconds: positiveOrNull(doc.video_duration_seconds),
    video_generated_at: doc.video_generated_at || null,
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

export async function createVideoScene({
  projectId,
  beatId,
  order,
  title = '',
  slug = '',
  setNames = [],
  characterNames = [],
  textSpan = null,
  directorsRead = null,
  intention = '',
  scope = null,
  floorPlan = '',
  dialogIds = [],
  load = null,
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
    title: str(title),
    slug: str(slug),
    set_names: stringList(setNames),
    character_names: stringList(characterNames),
    text_span: normalizeTextSpan(textSpan),
    directors_read: normalizeDirectorsRead(directorsRead),
    intention: str(intention),
    scope: normalizeScope(scope),
    floor_plan: typeof floorPlan === 'string' ? floorPlan : '',
    dialog_ids: normalizeDialogIds(dialogIds),
    load: normalizeLoad(load),
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
      case 'title':
      case 'slug':
      case 'intention':
        set[k] = str(v);
        break;
      case 'floor_plan':
        set[k] = typeof v === 'string' ? v : String(v ?? '');
        break;
      case 'set_names':
      case 'character_names':
        set[k] = stringList(v);
        break;
      case 'text_span':
        set[k] = normalizeTextSpan(v);
        break;
      case 'directors_read':
        set[k] = normalizeDirectorsRead(v);
        break;
      case 'scope':
        set[k] = normalizeScope(v);
        break;
      case 'dialog_ids':
        set[k] = normalizeDialogIds(v);
        break;
      case 'load':
        set[k] = normalizeLoad(v);
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

// Point a scene at its assembled MP4 (src/web/cutAssemble.js), or clear it
// with fileId=null. The gateway wrapper (setVideoSceneVideoViaGateway) owns the
// broadcast and the old-file cleanup; this is the bare write.
export async function setVideoSceneVideo(id, { fileId = null, durationSeconds = null } = {}) {
  const d = await getVideoSceneAnyProject(id);
  if (!d) throw new Error(`Video scene not found: ${id}`);
  const dur = Number(durationSeconds);
  await col().updateOne(
    { _id: d._id },
    {
      $set: {
        video_file_id: fileId == null ? null : String(fileId),
        video_duration_seconds: fileId != null && Number.isFinite(dur) && dur > 0 ? dur : null,
        video_generated_at: fileId == null ? null : new Date(),
        updated_at: new Date(),
      },
    },
  );
  logger.info(`mongo: video_scene video set id=${d._id} cleared=${fileId == null}`);
  return getVideoSceneAnyProject(d._id);
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

export async function countVideoScenesByBeat(projectId) {
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

export async function ensureIndexes() {
  await col().createIndex({ project_id: 1, beat_id: 1 });
  await col().createIndex({ beat_id: 1, order: 1 });
}
