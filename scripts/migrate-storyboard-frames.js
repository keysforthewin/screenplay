#!/usr/bin/env node
/**
 * One-shot migration: convert legacy storyboard rows from the start/end-frame
 * schema to the generic `frames[]` pool.
 *
 * Why: storyboards used to store a fixed start_frame_id / end_frame_id (plus
 * per-frame prompt / reference / undo fields). The model is now an ordered pool
 * of up to 6 frames, each `{ _id, image_id, prompt, previous_image_id,
 * last_edit_prompt, reference_ids }`. getStoryboard backfills this lazily on
 * read, but running this up front gives every row a stable `frames` array (and
 * frame `_id`s) without waiting for the first read.
 *
 * Properties:
 *   - Idempotent. Rows that already have a `frames` array are skipped.
 *   - Synthesizes a frame for the start_* fields (if any carried content) then
 *     the end_* fields — matching synthesizeFramesFromLegacy in
 *     src/mongo/storyboards.js. A pristine (all-null) legacy row maps to [].
 *   - Safe by default. Legacy fields are left in place; pass `--cleanup` to
 *     $unset them after the frames array is written.
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/migrate-storyboard-frames.js
 *   docker compose exec bot node scripts/migrate-storyboard-frames.js --cleanup
 */

import { ObjectId } from 'mongodb';
import { connectMongo, closeMongo } from '../src/mongo/client.js';

const CLEANUP = process.argv.includes('--cleanup');

const LEGACY_FIELDS = [
  'start_frame_id',
  'start_frame_prompt',
  'start_frame_reference_ids',
  'previous_start_frame_id',
  'last_start_frame_edit_prompt',
  'end_frame_id',
  'end_frame_prompt',
  'end_frame_reference_ids',
  'previous_end_frame_id',
  'last_end_frame_edit_prompt',
];

function synthesizeFrames(doc) {
  const frames = [];
  for (const role of ['start', 'end']) {
    const imageId = doc[`${role}_frame_id`] ?? null;
    const prompt =
      typeof doc[`${role}_frame_prompt`] === 'string' ? doc[`${role}_frame_prompt`] : '';
    const refs = Array.isArray(doc[`${role}_frame_reference_ids`])
      ? doc[`${role}_frame_reference_ids`]
      : [];
    const prev = doc[`previous_${role}_frame_id`] ?? null;
    const lastEdit =
      typeof doc[`last_${role}_frame_edit_prompt`] === 'string'
        ? doc[`last_${role}_frame_edit_prompt`]
        : '';
    if (!imageId && !prompt && refs.length === 0 && !prev && !lastEdit) continue;
    frames.push({
      _id: new ObjectId(),
      image_id: imageId,
      prompt,
      previous_image_id: prev,
      last_edit_prompt: lastEdit,
      reference_ids: refs,
    });
  }
  return frames;
}

async function main() {
  const db = await connectMongo();
  const col = db.collection('storyboards');

  const total = await col.countDocuments({});
  console.log(`storyboards: ${total} docs`);

  let migrated = 0;
  let skipped = 0;
  let cleaned = 0;

  const cursor = col.find({});
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const hasFrames = Array.isArray(doc.frames);
    if (!hasFrames) {
      const frames = synthesizeFrames(doc);
      await col.updateOne({ _id: doc._id }, { $set: { frames } });
      migrated++;
    } else {
      skipped++;
    }
    if (CLEANUP) {
      const unset = {};
      for (const f of LEGACY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(doc, f)) unset[f] = '';
      }
      if (Object.keys(unset).length) {
        await col.updateOne({ _id: doc._id }, { $unset: unset });
        cleaned++;
      }
    }
  }

  console.log(`Migrated ${migrated}, already had frames ${skipped}.`);
  if (CLEANUP) {
    console.log(`Stripped legacy start_*/end_* fields from ${cleaned} docs.`);
  } else {
    console.log('Legacy fields left intact. Re-run with --cleanup once verified.');
  }
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo();
  });
