#!/usr/bin/env node
/**
 * One-shot migration: decode JSON-style escape sequences (e.g. `—`)
 * that some models accidentally emitted as literal characters into text
 * fields. After this runs, the data contains the intended Unicode chars
 * (em dashes, smart quotes, etc.) instead of six-character escape strings.
 *
 * Scope:
 *   - characters       (name, hollywood_actor, fields.*, images[].caption,
 *                       attachments[].caption)
 *   - plots            (synopsis, notes, beats[].name/desc/body/characters[],
 *                       beats[].images[].caption, beats[].attachments[].caption)
 *   - prompts          (_id: character_template, plot_template — template
 *                       field labels/descriptions; _id: director_notes —
 *                       notes[].text and per-note image/attachment captions)
 *   - messages         (rolling transcript: text blocks and stringified
 *                       tool_use input previews)
 *
 * Defaults to a DRY RUN. It scans, reports counts, and shows a few examples
 * of strings it would change. Pass `--apply` to commit the writes.
 *
 *   docker compose exec bot node scripts/migrate-decode-escapes.js
 *   docker compose exec bot node scripts/migrate-decode-escapes.js --apply
 *
 * Idempotent: a second run finds nothing to fix.
 */

import { ObjectId } from 'mongodb';
import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { decodeEscapesInString } from '../src/agent/decodeEscapes.js';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const SAMPLE_LIMIT = 5;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  if (v instanceof ObjectId) return false;
  if (v instanceof Date) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Deep-decode a value while preserving ObjectId / Date / Buffer instances.
// Tracks (changeCount, samples) on the stats object so the caller can report.
function decodeDeep(value, stats) {
  if (typeof value === 'string') {
    const decoded = decodeEscapesInString(value);
    if (decoded !== value) {
      stats.changes++;
      if (stats.samples.length < SAMPLE_LIMIT) {
        stats.samples.push({ before: value, after: decoded });
      }
    }
    return decoded;
  }
  if (Array.isArray(value)) {
    return value.map((v) => decodeDeep(v, stats));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeDeep(v, stats);
    return out;
  }
  return value;
}

async function migrateCollection(db, collName, label) {
  const coll = db.collection(collName);
  const cursor = coll.find({});
  let scanned = 0;
  let docsChanged = 0;
  let totalStringsChanged = 0;
  const allSamples = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    scanned++;
    const stats = { changes: 0, samples: [] };
    const updated = decodeDeep(doc, stats);
    if (stats.changes === 0) continue;

    docsChanged++;
    totalStringsChanged += stats.changes;
    for (const s of stats.samples) {
      if (allSamples.length < SAMPLE_LIMIT) allSamples.push(s);
    }

    if (APPLY) {
      const { _id, ...rest } = updated;
      await coll.replaceOne({ _id: doc._id }, { _id, ...rest });
    }
  }

  console.log(
    `${label}: scanned=${scanned} docs_with_changes=${docsChanged} strings_changed=${totalStringsChanged}`,
  );
  if (allSamples.length && (VERBOSE || !APPLY)) {
    console.log(`  examples (showing up to ${SAMPLE_LIMIT}):`);
    for (const { before, after } of allSamples) {
      const b = before.length > 120 ? `${before.slice(0, 117)}…` : before;
      const a = after.length > 120 ? `${after.slice(0, 117)}…` : after;
      console.log(`    -  ${JSON.stringify(b)}`);
      console.log(`    +  ${JSON.stringify(a)}`);
    }
  }
  return { scanned, docsChanged, totalStringsChanged };
}

async function main() {
  console.log(APPLY ? 'MODE: apply (writing changes)' : 'MODE: dry run (no writes)');
  const db = await connectMongo();

  const totals = { scanned: 0, docs: 0, strings: 0 };
  for (const [coll, label] of [
    ['characters', 'characters'],
    ['plots', 'plots'],
    ['prompts', 'prompts'],
    ['messages', 'messages'],
  ]) {
    const r = await migrateCollection(db, coll, label);
    totals.scanned += r.scanned;
    totals.docs += r.docsChanged;
    totals.strings += r.totalStringsChanged;
  }

  console.log('---');
  console.log(
    `TOTAL: scanned=${totals.scanned} docs_with_changes=${totals.docs} strings_changed=${totals.strings}`,
  );
  if (!APPLY) {
    console.log('Dry run complete. Re-run with --apply to commit the changes.');
  } else {
    console.log('Migration applied.');
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
