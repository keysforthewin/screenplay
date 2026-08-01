// Playground model catalog + generic input/output wiring.
//
// The catalog (data/fal-playground-models.json, built by
// scripts/build-fal-playground-catalog.js) stores each model's resolved param
// names — classified once at build time — so this module does no name
// heuristics: it reads `row.inputs.*` and `row.output.path` verbatim.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CATALOG_PATH = path.join(process.cwd(), 'data', 'fal-playground-models.json');
const MISSING_CATALOG_ERROR =
  'Playground catalog missing — run: npm run refresh:playground-models';

// The manifest is ~1–2 MB; cache the parse keyed by file mtime instead of
// re-reading per request like the (much smaller) video catalog does.
let cache = null; // { path, mtimeMs, catalog }

export async function loadPlaygroundCatalog({ catalogPath = CATALOG_PATH } = {}) {
  let mtimeMs;
  try {
    mtimeMs = (await stat(catalogPath)).mtimeMs;
  } catch {
    return { catalog_error: MISSING_CATALOG_ERROR, models: [] };
  }
  if (cache && cache.path === catalogPath && cache.mtimeMs === mtimeMs) {
    return cache.catalog;
  }
  let catalog;
  try {
    const raw = JSON.parse(await readFile(catalogPath, 'utf8'));
    catalog = {
      generated_at: raw.generated_at ?? null,
      models: Array.isArray(raw.models) ? raw.models : [],
    };
  } catch (err) {
    return { catalog_error: `Playground catalog unreadable: ${err.message}`, models: [] };
  }
  cache = { path: catalogPath, mtimeMs, catalog };
  return catalog;
}

export async function getPlaygroundModel(endpointId, opts = {}) {
  const catalog = await loadPlaygroundCatalog(opts);
  return catalog.models.find((m) => m.endpoint_id === endpointId) || null;
}

/**
 * Map the playground bundle onto the model's actual param names. Every
 * unclassified optional param is left unset (API defaults apply); required
 * params that carried a schema default are sent verbatim via row.defaults.
 */
export function buildPlaygroundInput(row, { prompt, imageUrls = [], audioUrl, videoUrl, options = {} } = {}) {
  const input = { ...(row.defaults || {}) };
  const slots = row.inputs || {};

  const promptText = typeof prompt === 'string' ? prompt.trim() : '';
  if (slots.prompt_param && slots.prompt !== 'unused' && promptText) {
    input[slots.prompt_param] = promptText;
  }

  const urls = [...imageUrls];
  for (const p of slots.image?.params || []) {
    if (!urls.length) break;
    if (p.list) {
      input[p.name] = urls.splice(0, urls.length);
    } else {
      input[p.name] = urls.shift();
    }
  }

  if (audioUrl && slots.audio?.param) {
    input[slots.audio.param] = slots.audio.list ? [audioUrl] : audioUrl;
  }
  if (videoUrl && slots.video?.param) {
    input[slots.video.param] = slots.video.list ? [videoUrl] : videoUrl;
  }

  // User-selected output controls (validated upstream by
  // validateControlOptions) override any schema defaults.
  Object.assign(input, options);

  return input;
}

/**
 * Validate user-selected control values against the catalog row's `controls`
 * (extracted at build time). Returns { clean, errors } — clean holds only the
 * valid values, with int controls coerced to numbers.
 */
export function validateControlOptions(row, options = {}) {
  const controls = new Map((row.controls || []).map((c) => [c.name, c]));
  const clean = {};
  const errors = [];
  for (const [name, value] of Object.entries(options)) {
    const control = controls.get(name);
    if (!control) {
      errors.push(`${name} is not a supported option`);
      continue;
    }
    if (control.type === 'enum') {
      // HTML select values are strings; catalog enums may be numbers.
      // Match loosely and restore the option's original type.
      const match = control.options.find((o) => o === value || String(o) === String(value));
      if (match === undefined) {
        errors.push(`${name} must be one of: ${control.options.join(', ')}`);
        continue;
      }
      clean[name] = match;
    } else if (control.type === 'int') {
      const n = Number(value);
      if (!Number.isFinite(n)
        || (control.min != null && n < control.min)
        || (control.max != null && n > control.max)) {
        errors.push(`${name} must be a number between ${control.min ?? '-∞'} and ${control.max ?? '∞'}`);
        continue;
      }
      clean[name] = n;
    }
  }
  return { clean, errors };
}

export function classifyMediaKind(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return null;
}

function urlAt(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (cur == null) return null;
    cur = cur[seg];
  }
  return typeof cur === 'string' && cur ? cur : null;
}

// Fallback: depth-first walk for objects carrying a string `url`, classifying
// by a sibling content_type when present.
function walkForUrls(node, fallbackKind, found, depth = 0) {
  if (node == null || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForUrls(item, fallbackKind, found, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  if (typeof node.url === 'string' && node.url) {
    const kind = classifyMediaKind(node.content_type) || fallbackKind;
    found.push({ url: node.url, kind });
    return;
  }
  for (const value of Object.values(node)) walkForUrls(value, fallbackKind, found, depth + 1);
}

/**
 * Pull every media URL out of a fal result payload using the catalog row's
 * output path hint ('video.url', 'images[0].url', bare string prop), falling
 * back to a generic walk when the hint misses.
 */
export function extractOutputMedia(row, data) {
  const kind = row.output?.kind || null;
  const pathHint = row.output?.path || '';
  const outputs = [];

  if (pathHint) {
    const segments = pathHint.split(/[.[\]]+/).filter(Boolean);
    const arrayIdx = segments.indexOf('0');
    if (arrayIdx !== -1) {
      // e.g. images[0].url — expand the whole array.
      const arr = segments.slice(0, arrayIdx).reduce((cur, seg) => cur?.[seg], data);
      if (Array.isArray(arr)) {
        const tail = segments.slice(arrayIdx + 1);
        for (const item of arr) {
          const url = tail.length ? urlAt(item, tail) : (typeof item === 'string' ? item : null);
          if (url) outputs.push({ url, kind });
        }
      }
    } else {
      const url = urlAt(data, segments);
      if (url) outputs.push({ url, kind });
    }
  }

  if (!outputs.length) walkForUrls(data, kind, outputs);
  return outputs;
}
