#!/usr/bin/env node
/**
 * One-shot enumeration of fal.ai video-generation endpoints.
 *
 * Usage:
 *   node scripts/list-fal-video-models.js
 *
 * Output: scripts/output/fal-video-models.csv
 *
 * Discovery/OpenAPI plumbing lives in scripts/lib/falDiscovery.js (shared
 * with build-fal-playground-catalog.js).
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

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error('FAL_KEY missing from environment (.env)');
  process.exit(1);
}

const VIDEO_CATEGORIES = new Set(['text-to-video', 'image-to-video', 'video-to-video']);
const OUT_PATH = 'scripts/output/fal-video-models.csv';
const DETAIL_DELAY_MS = 120;

async function listAllVideoModels() {
  const collected = [];
  await listAllModels(FAL_KEY, {
    onPage({ page, pages, items }) {
      for (const item of items) {
        if (VIDEO_CATEGORIES.has(item.category)) collected.push(item);
      }
      console.error(`  list page ${page}/${pages} — kept ${collected.length} video models so far`);
    },
  });
  return collected;
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function toCsv(rows) {
  const headers = [
    'endpoint_id',
    'display_name',
    'category',
    'model_lab',
    'model_family',
    'license_type',
    'deprecated',
    'description',
    'required_params',
    'optional_params',
    'output_shape',
    'price',
    'added_at',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      csvCell(r.id),
      csvCell(r.title),
      csvCell(r.category),
      csvCell(r.modelLab),
      csvCell(r.modelFamily),
      csvCell(r.licenseType),
      csvCell(r.deprecated),
      csvCell(r.description),
      csvCell(r.requiredParams),
      csvCell(r.optionalParams),
      csvCell(r.output),
      csvCell(r.price),
      csvCell(r.addedAt),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  console.error('Listing all fal.ai models, filtering for video categories...');
  const videoModels = await listAllVideoModels();
  console.error(`Got ${videoModels.length} video models. Fetching OpenAPI schemas...`);

  const rows = [];
  let i = 0;
  for (const m of videoModels) {
    i += 1;
    try {
      const spec = await fetchOpenApi(m.id, FAL_KEY);
      const io = extractIO(spec, m.id);
      rows.push({
        id: m.id,
        title: m.title,
        category: m.category,
        modelLab: m.modelLab,
        modelFamily: m.modelFamily,
        licenseType: m.licenseType,
        deprecated: m.deprecated,
        description: pickDescription(m, spec),
        requiredParams: io.requiredParams,
        optionalParams: io.optionalParams,
        output: io.output,
        price: m.pricingInfoOverride,
        addedAt: pickAddedAt(m),
      });
      console.error(`  [${i}/${videoModels.length}] ok: ${m.id}`);
    } catch (err) {
      console.error(`  [${i}/${videoModels.length}] FAIL ${m.id}: ${err.message}`);
      rows.push({
        id: m.id,
        title: m.title,
        category: m.category,
        modelLab: m.modelLab,
        modelFamily: m.modelFamily,
        licenseType: m.licenseType,
        deprecated: m.deprecated,
        description: pickDescription(m, null),
        requiredParams: { __error: err.message },
        optionalParams: {},
        output: {},
        price: m.pricingInfoOverride,
        addedAt: pickAddedAt(m),
      });
    }
    await sleep(DETAIL_DELAY_MS);
  }

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, toCsv(rows));
  console.error(`\nWrote ${rows.length} rows to ${OUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
