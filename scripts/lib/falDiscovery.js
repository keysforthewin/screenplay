/**
 * Shared helpers for talking to fal.ai's undocumented discovery REST API and
 * summarizing the OpenAPI specs it serves per endpoint. Used by
 * scripts/list-fal-video-models.js and scripts/build-fal-playground-catalog.js.
 *
 * Endpoints (found by probing; fal does not document them):
 *   - GET https://fal.ai/api/models?page=N       (page-based, 40/page; no working category filter)
 *   - GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
 *   - pricing lives inline in the list response as `pricingInfoOverride`
 *     (a markdown string).
 */

export const API_BASE = 'https://fal.ai/api';

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function falFetch(url, falKey) {
  const res = await fetch(url, { headers: { Authorization: `Key ${falKey}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Paginate the full model listing. Returns every item unfiltered; callers
 * filter by category themselves. `onPage({ page, pages, items })` fires after
 * each page for progress logging.
 */
export async function listAllModels(falKey, { onPage } = {}) {
  const collected = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await falFetch(`${API_BASE}/models?page=${page}`, falKey);
    pages = data.pages;
    // Probe: on the first page, log the field names on the first item so we
    // can confirm which fields fal exposes. The discovery API is undocumented
    // and may change shape; printing keys keeps us honest.
    if (page === 1 && data.items?.[0]) {
      const sampleKeys = Object.keys(data.items[0]).sort();
      console.error(`  probe: /api/models item keys = ${JSON.stringify(sampleKeys)}`);
    }
    collected.push(...(data.items || []));
    onPage?.({ page, pages, items: data.items || [] });
    page += 1;
  } while (page <= pages);
  return collected;
}

export async function fetchOpenApi(endpointId, falKey) {
  const url = `${API_BASE}/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpointId)}`;
  return falFetch(url, falKey);
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
export function pickAddedAt(item) {
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

// Best plain-text description we can extract for a model. Priority order:
//   1. fal discovery item's `shortDescription` (one-sentence summary fal shows
//      on its catalog page).
//   2. fal discovery item's `description` (longer marketing blurb).
//   3. OpenAPI spec's `info.description` (sometimes the only thing populated).
// Returns a trimmed string capped at 800 chars, or null if nothing usable
// shows up. The cap keeps manifests from ballooning when fal pastes a
// multi-page README into the spec.
const DESCRIPTION_CAP = 800;
export function trimDescription(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= DESCRIPTION_CAP) return t;
  return `${t.slice(0, DESCRIPTION_CAP - 1).trimEnd()}…`;
}
export function pickDescription(item, spec) {
  return (
    trimDescription(item?.shortDescription) ||
    trimDescription(item?.description) ||
    trimDescription(spec?.info?.description) ||
    null
  );
}

export function resolveRef(spec, ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur = spec;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur == null) return null;
  }
  return cur;
}

export function summarizeProp(spec, propSchema) {
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
  // Resolved component title (e.g. `File`, `Image`, `AudioFile`, `VideoFile`)
  // — output-kind detection keys off these.
  if (typeof propSchema.title === 'string' && propSchema.title) out.title = propSchema.title;
  if (propSchema.description) out.description = propSchema.description.trim().replace(/\s+/g, ' ');
  if (propSchema.default !== undefined) out.default = propSchema.default;
  if (propSchema.minimum !== undefined) out.minimum = propSchema.minimum;
  if (propSchema.maximum !== undefined) out.maximum = propSchema.maximum;
  return out;
}

export function pickSchemaRef(refOrSchema, spec) {
  if (!refOrSchema) return null;
  if (refOrSchema.$ref) return resolveRef(spec, refOrSchema.$ref);
  return refOrSchema;
}

export function extractIO(spec, endpointId) {
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
