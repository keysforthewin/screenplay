#!/usr/bin/env node
/**
 * Compile the playground model catalog: every non-deprecated fal.ai endpoint
 * whose required inputs are satisfiable from {prompt, image(s), audio, video}
 * and whose output is media (image/video/audio).
 *
 * Usage:
 *   npm run refresh:playground-models
 *
 * Output: data/fal-playground-models.json (committed, read at runtime by
 * src/fal/playgroundModels.js).
 *
 * Unlike the video pipeline (list-fal-video-models.js → cluster script), all
 * param-name classification happens HERE, at build time — the catalog stores
 * the resolved param names per model so the runtime never guesses.
 */
import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  listAllModels,
  fetchOpenApi,
  extractIO,
  pickAddedAt,
  pickDescription,
  sleep,
} from './lib/falDiscovery.js';
import { classifyInputs, detectOutput, extractControls } from './lib/playgroundClassify.js';
import { parsePlaygroundPricing } from './lib/playgroundPricing.js';

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error('FAL_KEY missing from environment (.env)');
  process.exit(1);
}

const OUT_PATH = 'data/fal-playground-models.json';
const CONCURRENCY = 4;
const STAGGER_MS = 150;

// Cheapest dollar figure in the pricing markdown — same best-effort regex as
// scripts/cluster-fal-video-models.js (kept in sync by hand; both are build
// tools and the duplication is 6 lines).
function extractPriceMinUsd(text) {
  if (typeof text !== 'string' || !text) return null;
  const matches = [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  const valid = matches.filter(n => Number.isFinite(n) && n > 0);
  if (!valid.length) return null;
  return Math.min(...valid);
}

async function fetchSpecWithRetry(endpointId) {
  try {
    return await fetchOpenApi(endpointId, FAL_KEY);
  } catch (err) {
    await sleep(1000);
    return fetchOpenApi(endpointId, FAL_KEY);
  }
}

async function main() {
  console.error('Listing all fal.ai models (all categories)...');
  const items = await listAllModels(FAL_KEY, {
    onPage({ page, pages, items: pageItems }) {
      console.error(`  list page ${page}/${pages} (+${pageItems.length})`);
    },
  });

  const categories = new Map();
  for (const m of items) {
    categories.set(m.category ?? 'null', (categories.get(m.category ?? 'null') || 0) + 1);
  }
  console.error(`\nGot ${items.length} models. Categories seen:`);
  for (const [cat, n] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(cat).padEnd(28)} ${n}`);
  }

  const candidates = items.filter(m => !m.deprecated);
  console.error(`\nSkipping ${items.length - candidates.length} deprecated. Fetching OpenAPI for ${candidates.length} models (concurrency ${CONCURRENCY})...`);

  const kept = [];
  const excluded = [];               // { id, reason }
  const unsatisfiedHistogram = new Map(); // param name → count
  let done = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const m = candidates[cursor++];
      try {
        const spec = await fetchSpecWithRetry(m.id);
        const io = extractIO(spec, m.id);
        const inputs = classifyInputs(io.requiredParams, io.optionalParams);
        const output = detectOutput(io.output);

        if (!output) {
          excluded.push({ id: m.id, reason: 'no-media-output' });
        } else if (inputs.unsatisfied_required.length) {
          excluded.push({ id: m.id, reason: `unsatisfied: ${inputs.unsatisfied_required.join(',')}` });
          for (const p of inputs.unsatisfied_required) {
            unsatisfiedHistogram.set(p, (unsatisfiedHistogram.get(p) || 0) + 1);
          }
        } else {
          const { defaults, unsatisfied_required, ...inputSlots } = inputs;
          kept.push({
            endpoint_id: m.id,
            display_name: m.title || m.id,
            category: m.category ?? null,
            model_lab: m.modelLab ?? null,
            model_family: m.modelFamily ?? null,
            description: pickDescription(m, spec),
            output,
            inputs: inputSlots,
            controls: extractControls(io.requiredParams, io.optionalParams),
            pricing: parsePlaygroundPricing(m.pricingInfoOverride ?? null),
            defaults,
            inputs_required: Object.keys(io.requiredParams),
            inputs_optional: Object.keys(io.optionalParams),
            price_text: m.pricingInfoOverride ?? null,
            price_min_usd: extractPriceMinUsd(m.pricingInfoOverride),
            added_at: pickAddedAt(m),
          });
        }
      } catch (err) {
        excluded.push({ id: m.id, reason: `openapi-fetch: ${err.message}` });
      }
      done += 1;
      if (done % 50 === 0) console.error(`  [${done}/${candidates.length}] kept ${kept.length} so far`);
      await sleep(STAGGER_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  kept.sort((a, b) => a.endpoint_id.localeCompare(b.endpoint_id));

  const manifest = {
    generated_at: new Date().toISOString(),
    source: 'scripts/build-fal-playground-catalog.js',
    categories_seen: [...categories.keys()].filter(c => c !== 'null').sort(),
    model_count: kept.length,
    models: kept,
  };
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(manifest, null, 1) + '\n');

  console.error(`\nWrote ${kept.length} models to ${OUT_PATH} (excluded ${excluded.length}).`);
  const reasons = new Map();
  for (const e of excluded) {
    const key = e.reason.split(':')[0];
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  console.error('Exclusions by reason:');
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${r.padEnd(28)} ${n}`);
  }
  const topUnsatisfied = [...unsatisfiedHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (topUnsatisfied.length) {
    console.error('Top unclassified required params (candidates for the name sets):');
    for (const [p, n] of topUnsatisfied) console.error(`  ${p.padEnd(28)} ${n}`);
  }
  const perKind = { image: 0, video: 0, audio: 0 };
  for (const k of kept) perKind[k.output.kind] += 1;
  console.error(`Kept by output kind: image ${perKind.image}, video ${perKind.video}, audio ${perKind.audio}`);
}

main().catch(err => { console.error(err); process.exit(1); });
