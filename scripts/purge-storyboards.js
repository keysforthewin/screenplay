#!/usr/bin/env node
/**
 * One-shot cleanup for the retired Storyboard tab. The feature's code is gone;
 * this removes the data it left behind so nothing orphaned lingers in Mongo /
 * GridFS:
 *
 *   1. `storyboards` rows (every project).
 *   2. Their GENERATED media, only when nothing else points at it:
 *        - frame stills (frames[].image_id + the one-step undo image) that are
 *          beat-owned GridFS images, not in a beat's gallery/artwork, and not
 *          a cut's start frame;
 *        - the shot's scene audio, rendered clip and uploaded source video,
 *          unless a cut, a scene, a dialogue line or a beat MP4 references the
 *          same attachment.
 *      Reference images (frames[].reference_ids) are character/set artwork and
 *      are NEVER touched.
 *   3. The storyboard-era beat MP4 (beats.$.video_file_id) and the
 *      beats.$.video_* / readiness_report fields. The Prompts-tab beat MP4
 *      (prompts_video_*) is a different field and is kept.
 *   4. `yjs_docs` rows for the `storyboards:<beatId>` rooms.
 *
 * DRY RUN by default: prints what it would remove and changes nothing. Pass
 * --apply to delete. Idempotent — a second run finds nothing. Take a
 * mongodump first; there is no undo.
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/purge-storyboards.js           # report
 *   docker compose exec bot node scripts/purge-storyboards.js --apply   # delete
 */

import { pathToFileURL } from 'node:url';
import { ObjectId } from 'mongodb';
import { connectMongo, closeMongo } from '../src/mongo/client.js';

const sid = (v) => (v == null ? null : v.toString?.() || String(v));
const isHex = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
const oids = (set) => [...set].filter(isHex).map((s) => new ObjectId(s));

async function deleteGridFsFiles(db, bucket, ids) {
  if (!ids.length) return 0;
  const _ids = oids(new Set(ids));
  await db.collection(`${bucket}.chunks`).deleteMany({ files_id: { $in: _ids } });
  const r = await db.collection(`${bucket}.files`).deleteMany({ _id: { $in: _ids } });
  return r?.deletedCount || 0;
}

export async function purgeStoryboards(db, { apply = false } = {}) {
  const rows = await db.collection('storyboards').find({}).toArray();
  const plots = await db.collection('plots').find({}).toArray();
  const cuts = await db.collection('video_prompts').find({}).toArray();
  const scenes = await db.collection('video_scenes').find({}).toArray();
  const dialogs = await db.collection('dialogs').find({}).toArray();

  // Everything that is still in use and must survive.
  const keepImages = new Set();
  const keepAttachments = new Set();
  for (const p of plots) {
    for (const b of p.beats || []) {
      for (const i of b.images || []) keepImages.add(sid(i._id));
      if (b.main_image_id) keepImages.add(sid(b.main_image_id));
      for (const a of b.artworks || []) {
        if (a.result_image_id) keepImages.add(sid(a.result_image_id));
        if (a.previous_image_id) keepImages.add(sid(a.previous_image_id));
      }
      for (const a of b.attachments || []) keepAttachments.add(sid(a._id));
      if (b.prompts_video_file_id) keepAttachments.add(sid(b.prompts_video_file_id));
    }
  }
  for (const c of cuts) {
    if (c.start_frame?.image_id) keepImages.add(sid(c.start_frame.image_id));
    if (c.start_frame?.previous_image_id) keepImages.add(sid(c.start_frame.previous_image_id));
    for (const r of c.reference_images || []) if (r?.image_id) keepImages.add(sid(r.image_id));
    for (const f of ['video_file_id', 'audio_file_id']) if (c[f]) keepAttachments.add(sid(c[f]));
  }
  for (const s of scenes) if (s.video_file_id) keepAttachments.add(sid(s.video_file_id));
  // Attachments listed on a character, set or director's note are theirs.
  for (const coll of ['characters', 'sets']) {
    for (const doc of await db.collection(coll).find({}).toArray()) {
      for (const a of doc.attachments || []) keepAttachments.add(sid(a._id));
    }
  }
  for (const doc of await db.collection('prompts').find({}).toArray()) {
    for (const n of doc.notes || []) for (const a of n.attachments || []) keepAttachments.add(sid(a._id));
  }
  for (const d of dialogs) if (d.audio_file_id) keepAttachments.add(sid(d.audio_file_id));

  // Candidate media from the storyboard rows.
  const frameImages = new Set();
  const attachments = new Set();
  for (const sb of rows) {
    for (const f of sb.frames || []) {
      for (const k of ['image_id', 'previous_image_id']) if (f?.[k]) frameImages.add(sid(f[k]));
    }
    for (const k of ['audio_file_id', 'video_file_id', 'video_upload_file_id']) {
      if (sb[k]) attachments.add(sid(sb[k]));
    }
  }
  // Storyboard-era beat MP4s.
  const beatVideoBeats = [];
  for (const p of plots) {
    for (const b of p.beats || []) {
      const hasLegacy =
        b.video_file_id != null ||
        b.video_duration_seconds != null ||
        b.video_generated_at != null ||
        b.readiness_report != null;
      if (b.video_file_id) attachments.add(sid(b.video_file_id));
      if (hasLegacy) beatVideoBeats.push({ plotId: p._id, beatId: b._id });
    }
  }

  // Frame stills: only beat-owned GridFS images nothing else uses.
  const imageCandidates = [...frameImages].filter((id) => isHex(id) && !keepImages.has(id));
  const imageFiles = imageCandidates.length
    ? await db.collection('images.files').find({ _id: { $in: oids(new Set(imageCandidates)) } }).toArray()
    : [];
  const imagesToDelete = imageFiles
    .filter((f) => f.metadata?.owner_type === 'beat')
    .map((f) => sid(f._id));
  const attachmentsToDelete = [...attachments].filter((id) => isHex(id) && !keepAttachments.has(id));

  const roomNames = new Set();
  for (const p of plots) for (const b of p.beats || []) roomNames.add(`storyboards:${sid(b._id)}`);
  for (const sb of rows) if (sb.beat_id) roomNames.add(`storyboards:${sid(sb.beat_id)}`);
  const yjsCount = roomNames.size
    ? await db.collection('yjs_docs').countDocuments({ _id: { $in: [...roomNames] } })
    : 0;

  const summary = {
    applied: apply,
    storyboards: rows.length,
    frame_images: imagesToDelete.length,
    frame_images_kept_in_use: frameImages.size - imagesToDelete.length,
    attachments: attachmentsToDelete.length,
    attachments_kept_in_use: attachments.size - attachmentsToDelete.length,
    beats_with_legacy_fields: beatVideoBeats.length,
    yjs_docs: yjsCount,
  };
  if (!apply) return summary;

  summary.frame_images = await deleteGridFsFiles(db, 'images', imagesToDelete);
  summary.attachments = await deleteGridFsFiles(db, 'attachments', attachmentsToDelete);
  for (const { plotId, beatId } of beatVideoBeats) {
    await db.collection('plots').updateOne(
      { _id: plotId, 'beats._id': beatId },
      {
        $unset: {
          'beats.$.video_file_id': '',
          'beats.$.video_duration_seconds': '',
          'beats.$.video_generated_at': '',
          'beats.$.readiness_report': '',
        },
      },
    );
  }
  if (roomNames.size) {
    const r = await db.collection('yjs_docs').deleteMany({ _id: { $in: [...roomNames] } });
    summary.yjs_docs = r?.deletedCount || 0;
  }
  const r = await db.collection('storyboards').deleteMany({});
  summary.storyboards = r?.deletedCount ?? rows.length;
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const apply = process.argv.includes('--apply');
  const db = await connectMongo();
  try {
    const summary = await purgeStoryboards(db, { apply });
    console.log(JSON.stringify(summary, null, 2));
    if (!apply) console.log('\nDry run — nothing was deleted. Re-run with --apply to delete.');
  } finally {
    await closeMongo();
  }
}
