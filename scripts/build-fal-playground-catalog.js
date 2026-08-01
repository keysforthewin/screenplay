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
import { parsePlaygroundPricing, pricingFromMachine, mergePricing } from './lib/playgroundPricing.js';

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

// Batch-fetch fal's machine pricing table (the billing-system truth — covers
// most models that publish no pricing markdown). This API rate-limits hard
// (~10 quick requests), so: 40 ids per call, generous spacing, and patient
// backoff on 429.
const PRICING_API = 'https://api.fal.ai/v1/models/pricing';
const PRICING_BATCH = 40;
const PRICING_DELAY_MS = 1500;

async function fetchMachinePrices(ids) {
  const byId = new Map();
  for (let i = 0; i < ids.length; i += PRICING_BATCH) {
    const chunk = ids.slice(i, i + PRICING_BATCH);
    const url = `${PRICING_API}?endpoint_id=${encodeURIComponent(chunk.join(','))}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const data = await falFetchRaw(url);
        for (const p of data.prices || []) {
          if (!byId.has(p.endpoint_id)) byId.set(p.endpoint_id, p);
        }
        break;
      } catch (err) {
        if (attempt >= 5) {
          console.error(`  pricing chunk ${i / PRICING_BATCH + 1}: giving up (${err.message})`);
          break;
        }
        const wait = /429/.test(err.message) ? 15000 * attempt : 2000;
        console.error(`  pricing chunk ${i / PRICING_BATCH + 1}: ${err.message} — retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
    console.error(`  pricing: ${Math.min(i + PRICING_BATCH, ids.length)}/${ids.length} ids checked, ${byId.size} priced`);
    await sleep(PRICING_DELAY_MS);
  }
  return byId;
}

async function falFetchRaw(url) {
  const res = await fetch(url, { headers: { Authorization: `Key ${FAL_KEY}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for pricing API`);
  return res.json();
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

  console.error(`\nFetching machine pricing for ${kept.length} models...`);
  const machinePrices = await fetchMachinePrices(kept.map((k) => k.endpoint_id));
  let machineApplied = 0;
  for (const k of kept) {
    const mp = machinePrices.get(k.endpoint_id) || null;
    const machine = pricingFromMachine(mp);
    const merged = mergePricing(k.pricing, machine);
    if (machine && merged === machine) machineApplied += 1;
    k.pricing = merged;
    k.machine_price = mp ? { unit_price: mp.unit_price, unit: mp.unit } : null;
    if (k.price_min_usd == null && Number.isFinite(mp?.unit_price)) {
      k.price_min_usd = mp.unit_price;
    }
  }
  const kindHistogram = {};
  for (const k of kept) kindHistogram[k.pricing?.kind || 'none'] = (kindHistogram[k.pricing?.kind || 'none'] || 0) + 1;
  console.error(`Machine pricing applied to ${machineApplied} models. Final pricing kinds:`);
  console.error(`  ${JSON.stringify(kindHistogram)}`);

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
