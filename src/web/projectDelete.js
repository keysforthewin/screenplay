// projectDelete.js
//
// Full cascade delete of ONE project. Everything a project owns lives in eight
// places; the order below matters:
//
//   1. collect beat + character ids (needed to derive y-doc room names)
//   2. content collections keyed on project_id
//   3. the three composite-keyed `prompts` docs
//   4. GridFS files (images + attachments) whose metadata.project_id matches
//   5. yjs_docs rows for the project's singleton + entity rooms
//   6. Chroma chunks (best-effort — never blocks the delete)
//   7. repoint any channel_state whose current_project_id is the doomed project
//   8. the `projects` doc itself, LAST
//
// Deleting the project doc last means a crash mid-cascade leaves the project
// visible and re-deletable rather than orphaning its content.
//
// `token_usage` is channel-scoped, not project-scoped, and is deliberately
// left alone — usage history outlives the project.
//
// Known limitation: a browser tab still connected to one of the deleted rooms
// can have Hocuspocus re-insert that yjs_docs row on its next ~2s store tick.
// The orphan is harmless (the project and all its Mongo docs are gone, and
// resolveRoom fails closed on a room whose entity no longer exists). y-docs
// are deleted late to narrow the window.

import { getDb } from '../mongo/client.js';
import { logger } from '../log.js';
import { getProjectById, deleteProject } from '../mongo/projects.js';
import { deleteProjectChunks } from '../rag/indexer.js';

// Content collections carrying a plain `project_id` string field.
const CONTENT_COLLECTIONS = [
  'plots',
  'characters',
  'messages',
  'storyboards',
  'dialogs',
  'edit_announcements',
  'eleven_voices',
];

const PROMPT_KEYS = ['character_template', 'plot_template', 'director_notes'];
const SINGLETON_ROOMS = ['plot', 'notes', 'library'];
const GRIDFS_BUCKETS = ['images', 'attachments'];

function hex(id) {
  return id?.toString ? id.toString() : String(id);
}

// GridFS files are removed by deleting from the .files/.chunks collections
// directly rather than through GridFSBucket#delete: one deleteMany per bucket
// beats N round-trips, and it keeps the cascade testable against the in-memory
// fake Mongo (which has no bucket support). The two-collection layout is
// stable GridFS spec, and scripts/migrate-multi-project.js already touches
// `images.files` the same way.
async function deleteBucketFiles(db, bucketName, projectId) {
  const files = await db
    .collection(`${bucketName}.files`)
    .find({ 'metadata.project_id': projectId })
    .toArray();
  if (!files.length) return 0;
  const ids = files.map((f) => f._id);
  await db.collection(`${bucketName}.chunks`).deleteMany({ files_id: { $in: ids } });
  await db.collection(`${bucketName}.files`).deleteMany({ _id: { $in: ids } });
  return ids.length;
}

export async function deleteProjectCascade(projectId) {
  const project = await getProjectById(projectId);
  if (!project) return null;
  const pid = hex(project._id);
  const db = getDb();
  const deleted = {};

  // 1. Collect entity ids BEFORE their documents are removed.
  const plot = await db.collection('plots').findOne({ project_id: pid });
  const beatIds = (plot?.beats || []).map((b) => hex(b._id)).filter(Boolean);
  const characterIds = (await db.collection('characters').find({ project_id: pid }).toArray())
    .map((c) => hex(c._id))
    .filter(Boolean);

  // 2. Content collections.
  for (const name of CONTENT_COLLECTIONS) {
    const r = await db.collection(name).deleteMany({ project_id: pid });
    deleted[name] = r?.deletedCount || 0;
  }

  // 3. Composite-keyed prompt docs.
  const promptIds = PROMPT_KEYS.map((k) => `${pid}:${k}`);
  deleted.prompts =
    (await db.collection('prompts').deleteMany({ _id: { $in: promptIds } }))?.deletedCount || 0;

  // 4. GridFS.
  for (const bucket of GRIDFS_BUCKETS) {
    deleted[bucket] = await deleteBucketFiles(db, bucket, pid);
  }

  // 5. y-docs: the three project singletons plus every entity room.
  const rooms = [
    ...SINGLETON_ROOMS.map((r) => `${r}:${pid}`),
    ...beatIds.flatMap((id) => [`beat:${id}`, `storyboards:${id}`, `dialogs:${id}`]),
    ...characterIds.map((id) => `character:${id}`),
  ];
  deleted.yjs_docs =
    (await db.collection('yjs_docs').deleteMany({ _id: { $in: rooms } }))?.deletedCount || 0;

  // 6. Chroma — best-effort, swallowed inside the indexer.
  await deleteProjectChunks(pid);

  // 7. Repoint any Discord channel that was pointed at this project. Done
  //    before the project doc is removed so getDefaultProject() can never
  //    pick the doomed project as the fallback.
  const stranded = await db
    .collection('channel_state')
    .find({ current_project_id: pid })
    .toArray();
  deleted.channel_state = 0;
  if (stranded.length) {
    const fallback = (await db.collection('projects').find({}).toArray())
      .filter((p) => hex(p._id) !== pid)
      .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))[0];
    if (fallback) {
      for (const doc of stranded) {
        await db
          .collection('channel_state')
          .updateOne(
            { _id: doc._id },
            { $set: { current_project_id: hex(fallback._id), updated_at: new Date() } },
          );
        deleted.channel_state += 1;
      }
    }
  }

  // 8. The project doc itself.
  await deleteProject(project._id);

  logger.info(
    `project delete cascade id=${pid} title="${project.title}" ${JSON.stringify(deleted)}`,
  );
  return { id: pid, title: project.title, deleted };
}

export const _internals = { deleteBucketFiles, CONTENT_COLLECTIONS, SINGLETON_ROOMS };
