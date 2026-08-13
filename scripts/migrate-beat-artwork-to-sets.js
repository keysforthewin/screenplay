#!/usr/bin/env node
/**
 * One-shot migration: move every beat's artwork, reference images, and
 * attachments onto Set entities (the reusable settings/locations that now own
 * all location artwork), and link each source beat to its set by name.
 *
 * Per beat with any of images[]/attachments[]/artworks[] non-empty:
 *   1. Pick a set name: first line of scene_bible.location (≤ 80 chars),
 *      else the beat name, else "Beat <order>".
 *   2. Find-or-create the set (two beats sharing "Kitchen" intentionally
 *      merge into one Kitchen set). Beat ids are appended to
 *      migrated_from_beat_ids for audit.
 *   3. Merge the beat's images/attachments/artworks onto the set (deduped by
 *      _id). main_image_id carries over only when the set has none yet.
 *   4. Restamp GridFS metadata (owner 'beat' → 'set') for ids enumerated
 *      STRICTLY from the beat arrays: images[]._id, attachments[]._id, and
 *      artwork result/previous_result ids. NOT reference_image_ids (those
 *      point at other owners' files) and NOT other beat-owned files —
 *      storyboard frame renders, per-frame uploads, and audio/video stay
 *      beat-owned. The {owner_type:'beat'} guard makes restamps idempotent
 *      and refuses to steal files already claimed elsewhere.
 *   5. Link the set name into beat.sets, then clear the beat arrays LAST —
 *      the cleared arrays are the idempotency marker. A crash mid-beat leaves
 *      its arrays intact, and the re-run repeats steps 2–4 harmlessly
 *      (find-by-name hits the same set, merges dedupe by _id, the restamp
 *      guard no-ops).
 *
 * Idempotent: a re-run sees empty beat arrays and skips every migrated beat.
 *
 * Usage (inside the bot container, BEFORE restarting onto the new code —
 * see the CLAUDE.md migration runbook):
 *   docker compose exec bot node scripts/migrate-beat-artwork-to-sets.js
 * Follow with scripts/reindex-rag.js so the new sets are searchable.
 */

import { ObjectId } from 'mongodb';
import { connectMongo, closeMongo, getDb } from '../src/mongo/client.js';
import { stripMarkdown } from '../src/util/markdown.js';

function hex(v) {
  return v?.toString ? v.toString() : String(v);
}

function pickSetName(beat) {
  const location = stripMarkdown(String(beat?.scene_bible?.location || ''))
    .split('\n')[0]
    .trim()
    .slice(0, 80)
    .trim();
  if (location) return location;
  const name = stripMarkdown(String(beat?.name || '')).trim();
  if (name) return name;
  return `Beat ${beat?.order ?? '?'}`;
}

async function findOrCreateSet(db, projectId, name, stats) {
  const lower = stripMarkdown(name).toLowerCase();
  const existing = await db
    .collection('sets')
    .findOne({ project_id: projectId, name_lower: lower });
  if (existing) {
    stats.sets_merged += 1;
    return existing;
  }
  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    project_id: projectId,
    name,
    name_lower: lower,
    description: '',
    images: [],
    main_image_id: null,
    attachments: [],
    artworks: [],
    migrated_from_beat_ids: [],
    created_at: now,
    updated_at: now,
  };
  await db.collection('sets').insertOne(doc);
  stats.sets_created += 1;
  return doc;
}

// Restamp one GridFS file's owner from this beat to the set. The owner_type
// guard keeps this idempotent and refuses files already claimed elsewhere.
async function restampFile(db, bucket, fileId, setId, stats, counter) {
  if (!fileId) return;
  const r = await db.collection(`${bucket}.files`).updateOne(
    { _id: fileId, 'metadata.owner_type': 'beat' },
    { $set: { 'metadata.owner_type': 'set', 'metadata.owner_id': setId } },
  );
  if (r?.modifiedCount) stats[counter] += 1;
}

export async function migrateBeatArtworkToSets() {
  const db = getDb();
  const stats = {
    sets_created: 0,
    sets_merged: 0,
    images_moved: 0,
    attachments_moved: 0,
    beats_cleared: 0,
    beats_skipped: 0,
  };

  const plots = await db.collection('plots').find({}).toArray();
  for (const plot of plots) {
    const projectId = plot.project_id ? String(plot.project_id) : null;
    if (!projectId) continue; // pre-multi-project doc; run migrate-multi-project.js first
    for (const beat of plot.beats || []) {
      const images = Array.isArray(beat.images) ? beat.images : [];
      const attachments = Array.isArray(beat.attachments) ? beat.attachments : [];
      const artworks = Array.isArray(beat.artworks) ? beat.artworks : [];
      if (!images.length && !attachments.length && !artworks.length) {
        stats.beats_skipped += 1;
        continue;
      }

      const name = pickSetName(beat);
      const set = await findOrCreateSet(db, projectId, name, stats);

      // Merge arrays onto the set, deduped by _id against what's there.
      const fresh = await db.collection('sets').findOne({ _id: set._id });
      const have = (arr) => new Set((arr || []).map((x) => hex(x._id)));
      const newImages = images.filter((i) => !have(fresh.images).has(hex(i._id)));
      const newAttachments = attachments.filter((a) => !have(fresh.attachments).has(hex(a._id)));
      const newArtworks = artworks.filter((a) => !have(fresh.artworks).has(hex(a._id)));
      const update = {
        $set: { updated_at: new Date() },
        $push: { migrated_from_beat_ids: beat._id },
      };
      if (newImages.length || newAttachments.length || newArtworks.length) {
        update.$set.images = [...(fresh.images || []), ...newImages];
        update.$set.attachments = [...(fresh.attachments || []), ...newAttachments];
        update.$set.artworks = [...(fresh.artworks || []), ...newArtworks];
      }
      // main_image_id: only when the set has none and the beat's main is one
      // of the ids we are moving in.
      const migratedImageIds = new Set(newImages.map((i) => hex(i._id)));
      if (
        !fresh.main_image_id &&
        beat.main_image_id &&
        migratedImageIds.has(hex(beat.main_image_id))
      ) {
        update.$set.main_image_id = beat.main_image_id;
      }
      await db.collection('sets').updateOne({ _id: set._id }, update);

      // Restamp GridFS — ids strictly from the beat arrays.
      for (const i of newImages) {
        await restampFile(db, 'images', i._id, set._id, stats, 'images_moved');
      }
      for (const a of newArtworks) {
        await restampFile(db, 'images', a.result_image_id, set._id, stats, 'images_moved');
        await restampFile(db, 'images', a.previous_result_image_id, set._id, stats, 'images_moved');
      }
      for (const a of newAttachments) {
        await restampFile(db, 'attachments', a._id, set._id, stats, 'attachments_moved');
      }

      // Link the set on the beat, then clear the beat arrays LAST (the
      // idempotency marker).
      const existingSets = Array.isArray(beat.sets) ? beat.sets : [];
      const alreadyLinked = existingSets.some(
        (s) => stripMarkdown(String(s)).toLowerCase() === set.name_lower,
      );
      await db.collection('plots').updateOne(
        { _id: plot._id, 'beats._id': beat._id },
        {
          $set: {
            'beats.$.sets': alreadyLinked ? existingSets : [...existingSets, set.name],
            'beats.$.images': [],
            'beats.$.main_image_id': null,
            'beats.$.attachments': [],
            'beats.$.artworks': [],
            'beats.$.updated_at': new Date(),
          },
        },
      );
      stats.beats_cleared += 1;
    }
  }
  return stats;
}

async function main() {
  await connectMongo();
  const stats = await migrateBeatArtworkToSets();
  console.log(
    `Done. sets created: ${stats.sets_created}, merged into existing: ${stats.sets_merged}, ` +
      `images moved: ${stats.images_moved}, attachments moved: ${stats.attachments_moved}, ` +
      `beats cleared: ${stats.beats_cleared}, beats without media: ${stats.beats_skipped}`,
  );
  console.log('Follow with: docker compose exec bot node scripts/reindex-rag.js');
}

// Only run when executed directly (the test suite imports the core).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
    .catch((e) => {
      console.error('Migration failed:', e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeMongo();
    });
}
