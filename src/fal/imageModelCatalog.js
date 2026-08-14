// The image half of the fal.ai model catalog.
//
// data/fal-playground-models.json already describes every non-deprecated fal
// endpoint (built by scripts/build-fal-playground-catalog.js, the same file the
// playground runs on). This module narrows it to the endpoints that can produce
// an image from the inputs our "generate image" dialogs actually have — a
// prompt plus optional reference images — and reshapes each row for the SPA
// picker: lab, category, description, reference capacity, and a display price.
//
// Two classes of model come back in one list:
//   - the hand-wired shortcuts ('nano-banana-pro', 'flux-2-pro', …), which have
//     tuned generate/edit routing in src/fal/imageClient.js. Their rows submit
//     under the SHORTCUT id so that routing still applies, and their generate +
//     edit endpoints collapse into a single entry.
//   - everything else, submitted under its raw fal endpoint id and executed
//     generically (src/fal/catalogImageGenerate.js).
//
// Keeping both in one list is what lets the picker be "the whole catalog" while
// the models we've tuned stay first and keep their fast paths.

import { config } from '../config.js';
import { loadPlaygroundCatalog } from './playgroundModels.js';
import { maxReferenceImagesFor, listImageModelInfo } from '../web/imageModelInfo.js';

const GENERATION_CATEGORIES = new Set(['text-to-image', 'image-to-image']);

// Image param entries are `{name, list, required}` objects in the current
// catalog; older rows carry bare strings. Read either.
function paramNames(params) {
  return (params || []).map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
}

// fal endpoint id → the internal shortcut id that dispatchImageReplace knows.
// Both the generate and edit endpoint of each shortcut map to the same id;
// imageClient.js picks between them based on whether references were passed.
export function wiredEndpointMap() {
  const f = config.fal || {};
  const pairs = [
    [f.nanoBananaProGenerateModel, 'nano-banana-pro'],
    [f.nanoBananaProEditModel, 'nano-banana-pro'],
    [f.flux2ProGenerateModel, 'flux-2-pro'],
    [f.flux2ProEditModel, 'flux-2-pro'],
    [f.fluxKontextModel, 'flux-pro-kontext'],
    [f.fluxKontextMultiModel, 'flux-pro-kontext'],
    [f.gemini25FlashGenerateModel, 'gemini-25-flash'],
    [f.gemini25FlashEditModel, 'gemini-25-flash'],
    [f.nanoBanana2GenerateModel, 'nano-banana-2'],
    [f.nanoBanana2EditModel, 'nano-banana-2'],
    [f.flux2KleinGenerateModel, 'flux-2-klein'],
    [f.flux2KleinEditModel, 'flux-2-klein'],
  ];
  return new Map(pairs.filter(([endpoint]) => !!endpoint));
}

// Can we drive this endpoint with {prompt, reference images} alone? The catalog
// records each row's REQUIRED param names, so this is an exact check rather
// than a guess: every required param must be one the caller can fill.
export function isPromptSatisfiable(row) {
  if (row?.output?.kind !== 'image') return false;
  if (!GENERATION_CATEGORIES.has(row?.category)) return false;
  const inputs = row?.inputs || {};
  if (inputs.audio?.need === 'required') return false;
  if (inputs.video?.need === 'required') return false;
  const takesPrompt = inputs.prompt && inputs.prompt !== 'unused';
  const takesImage = inputs.image?.need && inputs.image.need !== 'unused';
  // An endpoint that reads neither a prompt nor an image is driven entirely by
  // structured params we have no UI for.
  if (!takesPrompt && !takesImage) return false;
  const fillable = new Set(
    [inputs.prompt_param, ...paramNames(inputs.image?.params)].filter(Boolean),
  );
  return (row.inputs_required || []).every((param) => fillable.has(param));
}

// Keep four decimals of precision (a tenth of a cent matters at these prices,
// and $0.025 must not round to $0.03), trim the trailing zeros that leaves, but
// never show fewer than the conventional two decimals.
function usd(n) {
  let s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  const dot = s.indexOf('.');
  if (dot === -1) s += '.00';
  else if (s.length - dot - 1 < 2) s += '0';
  return `$${s}`;
}

// A one-line price for the picker. The catalog prices models several ways
// (per image, per megapixel, per compute unit); we surface the unit rather than
// pretending everything is per-image, because a per-MP model's real cost
// depends on the output size the endpoint chooses.
export function formatImagePrice(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const { kind } = pricing;
  if (kind === 'per_image' && Number.isFinite(pricing.perImageUsd)) {
    return `${usd(pricing.perImageUsd)} / image`;
  }
  if (kind === 'per_megapixel' && Number.isFinite(pricing.perMpUsd)) {
    return `${usd(pricing.perMpUsd)} / MP`;
  }
  if (kind === 'per_unit' && Number.isFinite(pricing.perUnitUsd)) {
    const unit = pricing.unit ? ` ${pricing.unit}` : ' unit';
    return `${usd(pricing.perUnitUsd)} /${unit}`;
  }
  if (Number.isFinite(pricing.perClipUsd)) return `${usd(pricing.perClipUsd)} / run`;
  return null;
}

function toModel(row, wiredId) {
  const inputs = row.inputs || {};
  const imageNeed = inputs.image?.need || 'unused';
  // Wired shortcuts use our curated cap (imageModelInfo.js), which reflects
  // what the pipeline actually drives. Catalog rows report the documented max,
  // or null when the endpoint documents none.
  const catalogMax = Number.isFinite(inputs.image?.max) ? inputs.image.max : null;
  return {
    id: wiredId || row.endpoint_id,
    endpoint_id: row.endpoint_id,
    display_name: row.display_name || row.endpoint_id,
    lab: row.model_lab || null,
    category: row.category,
    description: row.description || '',
    is_wired: !!wiredId,
    accepts_references: imageNeed !== 'unused',
    requires_references: imageNeed === 'required',
    max_references: wiredId ? maxReferenceImagesFor(wiredId) : catalogMax,
    output_path: row.output?.path || null,
    price: {
      display: formatImagePrice(row.pricing),
      kind: row.pricing?.kind || null,
      per_image_usd: Number.isFinite(row.pricing?.perImageUsd) ? row.pricing.perImageUsd : null,
      exact: !!row.pricing?.exact,
    },
  };
}

// Pure: catalog rows → picker models. Wired shortcuts sort first (they're the
// tuned paths), then everything else alphabetically by display name.
export function buildImageModelList(rows, { wiredMap = new Map() } = {}) {
  const out = [];
  const wiredEntries = new Map();
  for (const row of rows || []) {
    if (!isPromptSatisfiable(row)) continue;
    const wiredId = wiredMap.get(row.endpoint_id) || null;
    const model = toModel(row, wiredId);
    if (!wiredId) {
      out.push(model);
      continue;
    }
    // A shortcut's generate and edit endpoints are ONE picker entry. The first
    // row seen (generate) supplies the identity and copy; the pair's reference
    // capacity is the union, because the shortcut auto-routes to whichever
    // endpoint fits the call. References stay optional as long as one endpoint
    // works without them.
    const existing = wiredEntries.get(wiredId);
    if (!existing) {
      wiredEntries.set(wiredId, model);
      out.push(model);
      continue;
    }
    existing.accepts_references = existing.accepts_references || model.accepts_references;
    existing.requires_references = existing.requires_references && model.requires_references;
    if (model.max_references != null) {
      existing.max_references = Math.max(existing.max_references ?? 0, model.max_references);
    }
  }
  return sortModels(out);
}

// Tuned models first (they're the fast paths), then alphabetical.
function sortModels(models) {
  return models.sort((a, b) => {
    if (a.is_wired !== b.is_wired) return a.is_wired ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
}

// Not every wired shortcut is a fal endpoint — OpenAI's gpt-image-2 isn't in
// the fal catalog at all — and a wired model whose endpoint the scrape happened
// to miss would otherwise vanish from the picker while still working perfectly.
// Fill any gaps from the curated metadata (no price: these aren't fal-priced).
export function withWiredFallbacks(models) {
  const out = [...models];
  for (const info of listImageModelInfo()) {
    if (out.some((m) => m.id === info.id)) continue;
    out.push({
      id: info.id,
      endpoint_id: info.id,
      display_name: info.label || info.id,
      lab: info.family || null,
      category: 'text-to-image',
      description: '',
      is_wired: true,
      accepts_references: true,
      requires_references: false,
      max_references: info.maxReferenceImages ?? null,
      output_path: null,
      price: { display: null, kind: null, per_image_usd: null, exact: false },
    });
  }
  return sortModels(out);
}

export async function loadImageModelCatalog(opts = {}) {
  const catalog = await loadPlaygroundCatalog(opts);
  return {
    generated_at: catalog.generated_at ?? null,
    catalog_error: catalog.catalog_error || null,
    models: withWiredFallbacks(
      buildImageModelList(catalog.models, { wiredMap: wiredEndpointMap() }),
    ),
  };
}

// Look up one picker model by the id the SPA submits (shortcut id or raw
// endpoint id). Returns null for ids that aren't in the filtered catalog —
// callers treat that as "not a catalog model" and fall through.
export async function getImageModel(id, opts = {}) {
  if (!id) return null;
  const { models } = await loadImageModelCatalog(opts);
  return models.find((m) => m.id === String(id)) || null;
}
