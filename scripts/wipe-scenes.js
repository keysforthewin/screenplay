#!/usr/bin/env node
/**
 * One-shot wipe of every scene and cut. The planner-driven Prompts tab was
 * replaced by the hand-driven Scenes tab; this removes what the old tab left
 * behind so the new one starts empty:
 *
 *   1. `video_scenes` and `video_prompts` rows.
 *   2. Their GENERATED media, only when nothing else points at it:
 *        - frame stills (start_frame / end_frame: image_id, the one-step undo
 *          image, the old master plate) that are beat-owned GridFS images and
 *          not in a beat's gallery or artwork;
 *        - rendered clips and joined dialogue recordings on cuts, assembled
 *          scene MP4s and the assembled beat MP4 (beats.$.prompts_video_*),
 *          unless a dialogue line or an attachment list references the same
 *          file.
 *      Reference images are character/set artwork and are NEVER touched.
 *   3. The beats.$.prompts_video_* fields.
 *   4. `yjs_docs` rows for the `video_prompts:<beatId>` rooms.
 *
 * DRY RUN by default: prints what it would remove and changes nothing. Pass
 * --apply to delete. Idempotent — a second run finds nothing. Take a
 * mongodump first; there is no undo. Stop the bot (or make sure nobody has a
 * Scenes tab open) before --apply: an open page would write its rooms back.
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/wipe-scenes.js --all-projects            # report
 *   docker compose exec bot node scripts/wipe-scenes.js --project "Title"         # report, one project
 *   docker compose exec bot node scripts/wipe-scenes.js --all-projects --apply    # delete
 */

import { pathToFileURL } from 'node:url';
import { ObjectId } from 'mongodb';
import { connectMongo, closeMongo } from '../src/mongo/client.js';

const sid = (v) => (v == null ? null : v.toString?.() || String(v));
const isHex = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
const oids = (ids) => [...new Set(ids)].filter(isHex).map((s) => new ObjectId(s));

async function deleteGridFsFiles(db, bucket, ids) {
  const _ids = oids(ids);
  if (!_ids.length) return 0;
  await db.collection(`${bucket}.chunks`).deleteMany({ files_id: { $in: _ids } });
  const r = await db.collection(`${bucket}.files`).deleteMany({ _id: { $in: _ids } });
  return r?.deletedCount || 0;
}

// `projectId`: a 24-hex project id, or null for every project.
export async function wipeScenes(db, { projectId = null, apply = false } = {}) {
  const scope = projectId ? { project_id: projectId } : {};
  const cuts = await db.collection('video_prompts').find(scope).toArray();
  const scenes = await db.collection('video_scenes').find(scope).toArray();
  const allPlots = await db.collection('plots').find({}).toArray();
  const plots = projectId ? allPlots.filter((p) => p.project_id === projectId) : allPlots;

  // Everything that is still in use and must survive.
  const keepImages = new Set();
  const keepAttachments = new Set();
  for (const p of allPlots) {
    for (const b of p.beats || []) {
      for (const i of b.images || []) keepImages.add(sid(i._id));
      if (b.main_image_id) keepImages.add(sid(b.main_image_id));
      for (const a of b.artworks || []) {
        if (a.result_image_id) keepImages.add(sid(a.result_image_id));
        if (a.previous_image_id) keepImages.add(sid(a.previous_image_id));
      }
      for (const a of b.attachments || []) keepAttachments.add(sid(a._id));
    }
  }
  for (const coll of ['characters', 'sets']) {
    for (const doc of await db.collection(coll).find({}).toArray()) {
      for (const a of doc.attachments || []) keepAttachments.add(sid(a._id));
    }
  }
  for (const doc of await db.collection('prompts').find({}).toArray()) {
    for (const n of doc.notes || []) for (const a of n.attachments || []) keepAttachments.add(sid(a._id));
  }
  for (const d of await db.collection('dialogs').find({}).toArray()) {
    if (d.audio_file_id) keepAttachments.add(sid(d.audio_file_id));
  }

  // Candidate media.
  const frameImages = new Set();
  const attachments = new Set();
  for (const c of cuts) {
    for (const f of [c.start_frame, c.end_frame]) {
      for (const k of ['image_id', 'previous_image_id', 'master_image_id']) if (f?.[k]) frameImages.add(sid(f[k]));
    }
    for (const k of ['video_file_id', 'audio_file_id']) if (c[k]) attachments.add(sid(c[k]));
  }
  for (const s of scenes) if (s.video_file_id) attachments.add(sid(s.video_file_id));
  const beatsWithVideo = [];
  const roomNames = new Set();
  for (const p of plots) {
    for (const b of p.beats || []) {
      roomNames.add(`video_prompts:${sid(b._id)}`);
      const has =
        b.prompts_video_file_id !== undefined ||
        b.prompts_video_duration_seconds !== undefined ||
        b.prompts_video_generated_at !== undefined;
      if (b.prompts_video_file_id) attachments.add(sid(b.prompts_video_file_id));
      if (has) beatsWithVideo.push({ plotId: p._id, beatId: b._id });
    }
  }
  for (const c of cuts) if (c.beat_id) roomNames.add(`video_prompts:${sid(c.beat_id)}`);
  for (const s of scenes) if (s.beat_id) roomNames.add(`video_prompts:${sid(s.beat_id)}`);

  // Frame stills: only beat-owned GridFS images nothing else uses.
  const imageCandidates = [...frameImages].filter((id) => isHex(id) && !keepImages.has(id));
  const imageFiles = imageCandidates.length
    ? await db.collection('images.files').find({ _id: { $in: oids(imageCandidates) } }).toArray()
    : [];
  const imagesToDelete = imageFiles.filter((f) => f.metadata?.owner_type === 'beat').map((f) => sid(f._id));
  const attachmentsToDelete = [...attachments].filter((id) => isHex(id) && !keepAttachments.has(id));
  const yjsCount = roomNames.size
    ? await db.collection('yjs_docs').countDocuments({ _id: { $in: [...roomNames] } })
    : 0;

  const summary = {
    applied: apply,
    project_id: projectId || 'all',
    scenes: scenes.length,
    cuts: cuts.length,
    frame_images: imagesToDelete.length,
    frame_images_kept_in_use: frameImages.size - imagesToDelete.length,
    attachments: attachmentsToDelete.length,
    attachments_kept_in_use: attachments.size - attachmentsToDelete.length,
    beats_with_assembled_video_fields: beatsWithVideo.length,
    yjs_docs: yjsCount,
  };
  if (!apply) return summary;

  summary.frame_images = await deleteGridFsFiles(db, 'images', imagesToDelete);
  summary.attachments = await deleteGridFsFiles(db, 'attachments', attachmentsToDelete);
  for (const { plotId, beatId } of beatsWithVideo) {
    await db.collection('plots').updateOne(
      { _id: plotId, 'beats._id': beatId },
      {
        $unset: {
          'beats.$.prompts_video_file_id': '',
          'beats.$.prompts_video_duration_seconds': '',
          'beats.$.prompts_video_generated_at': '',
        },
      },
    );
  }
  if (roomNames.size) {
    const r = await db.collection('yjs_docs').deleteMany({ _id: { $in: [...roomNames] } });
    summary.yjs_docs = r?.deletedCount || 0;
  }
  summary.cuts = (await db.collection('video_prompts').deleteMany(scope))?.deletedCount ?? cuts.length;
  summary.scenes = (await db.collection('video_scenes').deleteMany(scope))?.deletedCount ?? scenes.length;
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const all = args.includes('--all-projects');
  const at = args.indexOf('--project');
  const title = at >= 0 ? args[at + 1] : null;
  if (all === Boolean(title)) {
    console.error('Usage: wipe-scenes.js (--project "Title" | --all-projects) [--apply]');
    process.exit(1);
  }
  const db = await connectMongo();
  try {
    let projectId = null;
    if (title) {
      const project = await db.collection('projects').findOne({ title_lower: title.trim().toLowerCase() });
      if (!project) {
        console.error(`Unknown project: ${title}`);
        process.exitCode = 1;
      } else {
        projectId = project._id.toString();
      }
    }
    if (all || projectId) {
      const summary = await wipeScenes(db, { projectId, apply });
      console.log(JSON.stringify(summary, null, 2));
      if (!apply) console.log('\nDry run — nothing was deleted. Re-run with --apply to delete.');
    }
  } finally {
    await closeMongo();
  }
}
