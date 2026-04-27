#!/usr/bin/env node
import { connectMongo } from '../../src/mongo/client.js';
import { seedDefaults } from '../../src/seed/defaults.js';
import { config } from '../../src/config.js';

const COLLECTIONS = [
  'characters',
  'plots',
  'messages',
  'prompts',
  'images.files',
  'images.chunks',
  'character_images.files',
  'character_images.chunks',
];

async function clear() {
  const db = await connectMongo();
  let total = 0;
  for (const c of COLLECTIONS) {
    const r = await db.collection(c).deleteMany({});
    total += r.deletedCount;
  }
  await seedDefaults();
  console.log(
    `cleared ${total} docs across ${COLLECTIONS.length} collections (db=${config.mongo.db}); templates re-seeded`,
  );
}

clear()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('clear-db failed:', err.message);
    process.exit(1);
  });
