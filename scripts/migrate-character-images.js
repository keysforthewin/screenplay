#!/usr/bin/env node
/**
 * One-shot migration: move character portraits from the legacy
 * `character_images` GridFS bucket into the unified `images` bucket.
 *
 * Why: `show_image` only reads the `images` bucket, so portraits stored
 * by the older `Files.attachImageToCharacter` path were unreachable from
 * the agent. After this migration, every character portrait is owned by
 * the unified bucket via metadata `{ owner_type: 'character', owner_id }`.
 *
 * Properties:
 *   - Idempotent. Re-running skips any _id already present in `images.files`.
 *   - Preserves _id values, so character docs (`images[]._id`,
 *     `main_image_id`) keep working without rewrite.
 *   - Safe by default. Source bucket is left in place; pass `--cleanup`
 *     to drop it after verifying the new bucket has every file.
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/migrate-character-images.js
 *   docker compose exec bot node scripts/migrate-character-images.js --cleanup
 */

import { ObjectId } from 'mongodb';
import { connectMongo, closeMongo } from '../src/mongo/client.js';

const CLEANUP = process.argv.includes('--cleanup');

function asObjectId(v) {
  if (!v) return null;
  if (v instanceof ObjectId) return v;
  return new ObjectId(String(v));
}

async function main() {
  const db = await connectMongo();
  const srcFiles = db.collection('character_images.files');
  const srcChunks = db.collection('character_images.chunks');
  const dstFiles = db.collection('images.files');
  const dstChunks = db.collection('images.chunks');

  const srcExists = (await db.listCollections({ name: 'character_images.files' }).toArray()).length > 0;
  if (!srcExists) {
    console.log('No character_images.files collection present. Nothing to do.');
    return;
  }

  const srcFileCount = await srcFiles.countDocuments({});
  console.log(`Source character_images.files: ${srcFileCount} docs`);

  let copied = 0;
  let skipped = 0;
  let chunksCopied = 0;

  const cursor = srcFiles.find({});
  while (await cursor.hasNext()) {
    const file = await cursor.next();

    const exists = await dstFiles.findOne({ _id: file._id }, { projection: { _id: 1 } });
    if (exists) {
      skipped++;
    } else {
      const ownerId = asObjectId(file.metadata?.character_id);
      const newFile = {
        ...file,
        metadata: {
          owner_type: 'character',
          owner_id: ownerId,
          source: 'upload',
          prompt: null,
          generated_by: null,
        },
      };
      await dstFiles.insertOne(newFile);
      copied++;
    }

    const chunkCursor = srcChunks.find({ files_id: file._id }).sort({ n: 1 });
    while (await chunkCursor.hasNext()) {
      const chunk = await chunkCursor.next();
      const chunkExists = await dstChunks.findOne({ _id: chunk._id }, { projection: { _id: 1 } });
      if (!chunkExists) {
        await dstChunks.insertOne(chunk);
        chunksCopied++;
      }
    }
  }

  console.log(`Files copied: ${copied}, already present: ${skipped}, chunks copied: ${chunksCopied}`);

  const dstCharCount = await dstFiles.countDocuments({ 'metadata.owner_type': 'character' });
  console.log(`Verification: images.files now has ${dstCharCount} character-owned files (source had ${srcFileCount})`);

  if (CLEANUP) {
    if (dstCharCount < srcFileCount) {
      console.error(`ABORT cleanup: dest count ${dstCharCount} < source count ${srcFileCount}. Inspect manually.`);
      process.exitCode = 1;
      return;
    }
    console.log('Dropping legacy character_images.files and character_images.chunks...');
    await srcFiles.drop().catch((e) => console.warn(`drop files: ${e.message}`));
    await srcChunks.drop().catch((e) => console.warn(`drop chunks: ${e.message}`));
    console.log('Cleanup done.');
  } else {
    console.log('Source bucket left intact. Re-run with --cleanup once the app is verified.');
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
