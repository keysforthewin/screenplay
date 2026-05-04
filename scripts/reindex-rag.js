#!/usr/bin/env node
/**
 * Full RAG backfill: walk every entity in Mongo and (re)index it into Chroma.
 *
 * Flags:
 *   --since=<ISO>          Skip entities whose `rag_indexed_at` >= ISO timestamp
 *   --types=beat,character Comma list of {beat, character, director_note, message}
 *   --messages=N           Cap how many recent messages per channel to index (default config.rag.messageWindow)
 *
 * Usage:
 *   VOYAGE_API_KEY=... CHROMA_URL=http://localhost:8000 npm run reindex
 *   docker compose exec bot node scripts/reindex-rag.js --types=beat,character
 */

import { connectMongo } from '../src/mongo/client.js';
import { config } from '../src/config.js';
import { isRagEnabled, chromaHealthcheck } from '../src/rag/chromaClient.js';
import {
  indexBeat,
  indexCharacter,
  indexDirectorNote,
  indexMessage,
} from '../src/rag/indexer.js';
import { getPlot } from '../src/mongo/plots.js';
import { findAllCharacters } from '../src/mongo/characters.js';
import { getDirectorNotes } from '../src/mongo/directorNotes.js';
import { getDb } from '../src/mongo/client.js';

function parseArgs(argv) {
  const out = { types: null, since: null, messages: null };
  for (const a of argv.slice(2)) {
    const [k, v] = a.split('=');
    if (k === '--types' && v) out.types = new Set(v.split(',').map((s) => s.trim()));
    if (k === '--since' && v) out.since = new Date(v);
    if (k === '--messages' && v) out.messages = Number(v);
  }
  return out;
}

const CONCURRENCY = 4;

async function runConcurrent(items, fn) {
  let i = 0;
  let ok = 0;
  let err = 0;
  let skip = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      try {
        const result = await fn(item);
        if (result === 'skip') skip++;
        else ok++;
      } catch (e) {
        err++;
        console.error(`reindex error: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
  return { ok, err, skip };
}

function isAfter(a, b) {
  if (!(a instanceof Date)) return false;
  if (!(b instanceof Date)) return true;
  return a.getTime() >= b.getTime();
}

async function main() {
  const args = parseArgs(process.argv);
  if (!isRagEnabled()) {
    console.error('RAG is not enabled. Set VOYAGE_API_KEY and CHROMA_URL, then retry.');
    process.exit(1);
  }
  console.log(`Connecting Mongo (${config.mongo.uri}) and Chroma (${config.chroma.url})…`);
  await connectMongo();
  const ok = await chromaHealthcheck();
  if (!ok) {
    console.error(`Chroma heartbeat failed at ${config.chroma.url}.`);
    process.exit(1);
  }

  const types = args.types;
  const want = (t) => !types || types.has(t);
  const messageCap = Number(args.messages) || config.rag.messageWindow;

  if (want('beat')) {
    const plot = await getPlot();
    const beats = plot.beats || [];
    console.log(`beats: ${beats.length} candidates`);
    const stats = await runConcurrent(beats, async (b) => {
      if (args.since && isAfter(b.rag_indexed_at, args.since)) return 'skip';
      await indexBeat(b._id);
      return 'ok';
    });
    console.log(`beats: ok=${stats.ok} skipped=${stats.skip} err=${stats.err}`);
  }

  if (want('character')) {
    const chars = await findAllCharacters();
    console.log(`characters: ${chars.length} candidates`);
    const stats = await runConcurrent(chars, async (c) => {
      if (args.since && isAfter(c.rag_indexed_at, args.since)) return 'skip';
      await indexCharacter(c._id);
      return 'ok';
    });
    console.log(`characters: ok=${stats.ok} skipped=${stats.skip} err=${stats.err}`);
  }

  if (want('director_note')) {
    const doc = await getDirectorNotes();
    const notes = doc.notes || [];
    console.log(`director_notes: ${notes.length} candidates`);
    const stats = await runConcurrent(notes, async (n) => {
      await indexDirectorNote(n._id);
      return 'ok';
    });
    console.log(`director_notes: ok=${stats.ok} err=${stats.err}`);
  }

  if (want('message')) {
    const docs = await getDb().collection('messages')
      .find({ channel_id: config.discord.movieChannelId })
      .sort({ created_at: -1 })
      .limit(messageCap)
      .toArray();
    console.log(`messages: ${docs.length} candidates (cap=${messageCap})`);
    const stats = await runConcurrent(docs, async (d) => {
      await indexMessage(d);
      return 'ok';
    });
    console.log(`messages: ok=${stats.ok} err=${stats.err}`);
  }

  console.log('Reindex complete.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Reindex failed:', e.stack || e.message || e);
    process.exit(1);
  });
