#!/usr/bin/env node
/**
 * One-shot cleanup: artworks rendered before generation recording (067f80b)
 * had their `model` field overwritten with the ROUTED fal endpoint id
 * ('flux-2-pro' → 'fal-ai/flux-2-pro/edit', 'openai' → 'gpt-image-2') by the
 * old fallback patch in generateArtworkImageInline. Those ids aren't in the
 * model picker, so the regenerate dialog silently swapped the selection to
 * the first list entry and one-click Retry 400'd on validation.
 *
 * Rewrites every stored artwork.model that matches a wired endpoint id back
 * to its shortcut id, across all three artwork hosts (characters, sets, and
 * the beats embedded in plots). `generation.endpoint` — the record of what
 * actually ran — is deliberately untouched.
 *
 * Idempotent: shortcut ids and catalog endpoint ids don't match the map, so a
 * re-run finds nothing to change.
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/normalize-artwork-models.js
 */

import { pathToFileURL } from 'node:url';
import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { wiredEndpointMap } from '../src/web/imageModelValidate.js';

function shortcutFor(model, map) {
  const v = String(model || '');
  if (v === 'gpt-image-2') return 'openai';
  return map.get(v) || null;
}

export async function normalizeArtworkModels(db) {
  const map = wiredEndpointMap();
  const summary = { artworks_updated: 0, docs_updated: 0 };

  const fixList = (artworks) => {
    let changed = false;
    for (const a of artworks || []) {
      const shortcut = shortcutFor(a?.model, map);
      if (shortcut && shortcut !== a.model) {
        a.model = shortcut;
        summary.artworks_updated += 1;
        changed = true;
      }
    }
    return changed;
  };

  for (const collection of ['characters', 'sets']) {
    const docs = await db.collection(collection).find({}).toArray();
    for (const doc of docs) {
      if (fixList(doc.artworks)) {
        await db.collection(collection).updateOne(
          { _id: doc._id },
          { $set: { artworks: doc.artworks } },
        );
        summary.docs_updated += 1;
      }
    }
  }

  const plots = await db.collection('plots').find({}).toArray();
  for (const plot of plots) {
    let changed = false;
    for (const beat of plot.beats || []) {
      if (fixList(beat.artworks)) changed = true;
    }
    if (changed) {
      await db.collection('plots').updateOne(
        { _id: plot._id },
        { $set: { beats: plot.beats } },
      );
      summary.docs_updated += 1;
    }
  }

  return summary;
}

async function main() {
  const db = await connectMongo();
  const summary = await normalizeArtworkModels(db);
  console.log(JSON.stringify(summary, null, 2));
  console.log('Done.');
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((e) => {
      console.error('Normalization failed:', e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeMongo();
    });
}
