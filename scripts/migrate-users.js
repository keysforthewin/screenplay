#!/usr/bin/env node
/**
 * One-shot migration for the permission system: grandfather existing sessions
 * into `users` accounts.
 *
 *   1. Group every auth_sessions row by case-insensitive username. First-seen
 *      casing (oldest created_at) becomes the display name.
 *   2. For each name with no existing users doc, create one granted ALL
 *      current projects — nobody who could already edit everything gets
 *      locked out by the deploy. Existing user docs are NEVER touched, so a
 *      re-run cannot re-widen grants an admin has since narrowed.
 *   3. Stamp user_id on that name's sessions that don't have one yet.
 *
 * Idempotent: step 2 is lookup-before-insert, step 3 filters on
 * user_id-absent. Projects created AFTER this migration start unshared.
 *
 * Deploy order: rsync new code (no restart needed — the mounted source means
 * `docker compose exec` runs new code) → run this script → add ADMIN_USERNAME
 * to .env → docker compose up -d bot && docker compose restart bot.
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/migrate-users.js
 */

import { pathToFileURL } from 'node:url';
import { ObjectId } from 'mongodb';
import { connectMongo, closeMongo } from '../src/mongo/client.js';

export async function migrateUsers(db) {
  const summary = { users_created: 0, sessions_linked: 0, users_existing: 0 };

  const projects = await db.collection('projects').find({}).toArray();
  const allProjectIds = projects.map((p) => p._id.toString());

  const sessions = await db
    .collection('auth_sessions')
    .find({})
    .sort({ created_at: 1 })
    .toArray();

  // name_lower -> { display, casings: Set<string> }, oldest session first so
  // the first-seen casing wins as the display name.
  const byName = new Map();
  for (const s of sessions) {
    const display = String(s.username || '').trim();
    if (!display) continue;
    const key = display.toLowerCase();
    if (!byName.has(key)) byName.set(key, { display, casings: new Set() });
    byName.get(key).casings.add(s.username);
  }

  for (const [nameLower, { display, casings }] of byName) {
    let user = await db.collection('users').findOne({ name_lower: nameLower });
    if (user) {
      summary.users_existing += 1;
    } else {
      user = {
        _id: new ObjectId(),
        name: display,
        name_lower: nameLower,
        project_ids: allProjectIds,
        created_at: new Date(),
        updated_at: new Date(),
        last_granted_by: 'migrate-users',
      };
      await db.collection('users').insertOne(user);
      summary.users_created += 1;
    }
    const linked = await db.collection('auth_sessions').updateMany(
      { username: { $in: Array.from(casings) }, user_id: { $exists: false } },
      { $set: { user_id: user._id } },
    );
    summary.sessions_linked += linked.modifiedCount || 0;
  }

  return summary;
}

async function main() {
  const db = await connectMongo();
  const summary = await migrateUsers(db);
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    'Done. Now add ADMIN_USERNAME=<admin login name> to .env and restart the bot ' +
      'to enable enforcement.',
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((e) => {
      console.error('Migration failed:', e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeMongo();
    });
}
