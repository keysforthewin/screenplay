#!/usr/bin/env node
/**
 * One-shot enumeration of fal.ai video-generation endpoints.
 *
 * Usage:
 *   node scripts/list-fal-video-models.js
 *
 * Output: scripts/output/fal-video-models.csv
 *
 * fal.ai's discovery REST API is undocumented. Endpoints used here were
 * found by probing:
 *   - GET /api/models?page=N    (page-based, 40/page; no working category filter)
 *   - GET /api/openapi/queue/openapi.json?endpoint_id=<id>
 *   - pricing lives inline in the list response as `pricingInfoOverride`
 *     (a markdown string).
 */
import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error('FAL_KEY missing from environment (.env)');
  process.exit(1);
}

const API_BASE = 'https://fal.ai/api';
const VIDEO_CATEGORIES = new Set(['text-to-video', 'image-to-video', 'video-to-video']);
const OUT_PATH = 'scripts/output/fal-video-models.csv';
const DETAIL_DELAY_MS = 120;

async function falFetch(url) {
  const res = await fetch(url, { headers: { Authorization: `Key ${FAL_KEY}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function listAllVideoModels() {
  const collected = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await falFetch(`${API_BASE}/models?page=${page}`);
    pages = data.pages;
    // Probe: on the first page, log the field names on the first item so we
    // can confirm which date field fal exposes (if any). The discovery API is
    // undocumented and may change shape; printing keys keeps us honest.
    if (page === 1 && data.items?.[0]) {
      const sampleKeys = Object.keys(data.items[0]).sort();
      console.error(`  probe: /api/models item keys = ${JSON.stringify(sampleKeys)}`);
    }
    for (const item of data.items) {
      if (VIDEO_CATEGORIES.has(item.category)) collected.push(item);
    }
    console.error(`  list page ${page}/${pages} — kept ${collected.length} video models so far`);
    page += 1;
  } while (page <= pages);
  return collected;
}

// Pick the first date-like field present on a discovery item. fal's response
// shape is undocumented; we try the common ISO 8601 variants. Returns null if
// nothing usable is found.
const DATE_FIELDS = [
  'createdAt', 'created_at',
  'publishedAt', 'published_at',
  'releasedAt', 'released_at',
  'addedAt', 'added_at',
  'updatedAt', 'updated_at',
];
function pickAddedAt(item) {
  for (const f of DATE_FIELDS) {
    const v = item?.[f];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Heuristic: treat numbers > 10^12 as ms, smaller as seconds.
      return new Date(v > 1e12 ? v : v * 1000).toISOString();
    }
  }
  return null;
}

async function fetchOpenApi(endpointId) {
  const url = `${API_BASE}/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpointId)}`;
  return falFetch(url);
}

// Best plain-text description we can extract for a model. Priority order:
//   1. fal discovery item's `shortDescription` (one-sentence summary fal shows
//      on its catalog page).
//   2. fal discovery item's `description` (longer marketing blurb).
//   3. OpenAPI spec's `info.description` (sometimes the only thing populated).
// Returns a trimmed string capped at 800 chars, or null if nothing usable
// shows up. The cap keeps the manifest from ballooning when fal pastes a
// multi-page README into the spec.
const DESCRIPTION_CAP = 800;
function trimDescription(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= DESCRIPTION_CAP) return t;
  return `${t.slice(0, DESCRIPTION_CAP - 1).trimEnd()}…`;
}
function pickDescription(item, spec) {
  return (
    trimDescription(item?.shortDescription) ||
    trimDescription(item?.description) ||
    trimDescription(spec?.info?.description) ||
    null
  );
}

function resolveRef(spec, ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur = spec;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur == null) return null;
  }
  return cur;
}

function summarizeProp(spec, propSchema) {
  if (!propSchema) return { type: 'unknown' };
  // Follow a top-level $ref one hop so nested object refs render usefully.
  if (propSchema.$ref) {
    const resolved = resolveRef(spec, propSchema.$ref);
    if (resolved) propSchema = { ...resolved, ...propSchema };
  }
  const out = {};
  if (propSchema.enum) {
    out.type = 'enum';
    out.enum = propSchema.enum;
  } else if (propSchema.type === 'array') {
    const itemType = propSchema.items?.type
      || (propSchema.items?.$ref ? propSchema.items.$ref.split('/').pop() : 'any');
    out.type = `${itemType}[]`;
  } else if (propSchema.type) {
    out.type = propSchema.type;
  } else if (propSchema.anyOf || propSchema.oneOf) {
    const variants = (propSchema.anyOf || propSchema.oneOf).map(v =>
      v.$ref ? v.$ref.split('/').pop() : (v.type || 'any')
    );
    out.type = variants.join('|');
  } else {
    out.type = 'unknown';
  }
  if (propSchema.description) out.description = propSchema.description.trim().replace(/\s+/g, ' ');
  if (propSchema.default !== undefined) out.default = propSchema.default;
  if (propSchema.minimum !== undefined) out.minimum = propSchema.minimum;
  if (propSchema.maximum !== undefined) out.maximum = propSchema.maximum;
  return out;
}

function pickSchemaRef(refOrSchema, spec) {
  if (!refOrSchema) return null;
  if (refOrSchema.$ref) return resolveRef(spec, refOrSchema.$ref);
  return refOrSchema;
}

function extractIO(spec, endpointId) {
  const mainPath = `/${endpointId}`;
  const resultPath = `/${endpointId}/requests/{request_id}`;
  const inputSchema = pickSchemaRef(
    spec.paths?.[mainPath]?.post?.requestBody?.content?.['application/json']?.schema,
    spec
  );
  const outputSchema = pickSchemaRef(
    spec.paths?.[resultPath]?.get?.responses?.['200']?.content?.['application/json']?.schema,
    spec
  );
  const required = new Set(inputSchema?.required || []);
  const inputProps = inputSchema?.properties || {};
  const requiredParams = {};
  const optionalParams = {};
  for (const [name, schema] of Object.entries(inputProps)) {
    (required.has(name) ? requiredParams : optionalParams)[name] = summarizeProp(spec, schema);
  }
  const output = {};
  for (const [name, schema] of Object.entries(outputSchema?.properties || {})) {
    output[name] = summarizeProp(spec, schema);
  }
  return { requiredParams, optionalParams, output };
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.error('Listing all fal.ai models, filtering for video categories...');
  const videoModels = await listAllVideoModels();
  console.error(`Got ${videoModels.length} video models. Fetching OpenAPI schemas...`);

  const rows = [];
  let i = 0;
  for (const m of videoModels) {
    i += 1;
    try {
      const spec = await fetchOpenApi(m.id);
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
