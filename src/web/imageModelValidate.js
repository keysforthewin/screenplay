// Shared image-model validation for every image-generation entry point
// (entityRoutes, artworkJobs, imageSheetJobs, storyboard dispatch). Lives in
// its own module — NOT in imageReplaceDispatch.js — because several tests mock
// that dispatcher wholesale (same constraint as src/web/auth.js; see
// CLAUDE.md's mocked-test note).

import { config } from '../config.js';
import { isConfigured as falConfigured } from '../fal/client.js';

// The models with tuned pipelines. Anything else may still be a fal catalog
// endpoint the picker offers; those run through the generic catalog runner.
export const ALLOWED_IMAGE_MODELS = ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai', 'gemini-25-flash', 'nano-banana-2', 'flux-2-klein'];

// fal endpoint id → the wired shortcut id dispatchImageReplace knows. Both
// the generate and edit endpoint of each shortcut map to the same id;
// imageClient.js picks between them based on whether references were passed.
// Lives here (not imageModelCatalog.js, which re-exports it) so
// normalizeImageModel can use it without pulling the catalog module in —
// several tests mock imageModelCatalog with only a subset of its exports.
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

// Default model callers fall back to when a request omits `image_model`/`model`.
// Old enum values (`gemini`, `fal`) from cached SPA bundles are normalized to
// the closest current equivalent so we don't 400 on stale clients. Routed
// endpoint ids map back to their shortcut: artworks rendered before generation
// recording had `model` overwritten with the endpoint that ran (e.g.
// 'fal-ai/flux-2-pro/edit'), and Retry replays that stored value verbatim.
export const DEFAULT_IMAGE_MODEL = 'nano-banana-pro';
export function normalizeImageModel(raw) {
  const v = String(raw ?? DEFAULT_IMAGE_MODEL);
  if (v === 'gemini' || v === 'google') return 'nano-banana-pro';
  if (v === 'fal') return 'flux-pro-kontext';
  if (v === 'gpt-image-2') return 'openai';
  return wiredEndpointMap().get(v) || v;
}

// A model is valid if it is one of the tuned shortcuts OR a fal catalog image
// endpoint the picker offers. Async because the catalog lives on disk. The
// dispatchers re-check authoritatively — this exists so a bad id comes back as
// a clean 400 before any job/pending tile is created. The catalog import stays
// lazy to avoid import cycles.
export async function isValidImageModel(v) {
  if (ALLOWED_IMAGE_MODELS.includes(v)) return true;
  const { getImageModel } = await import('../fal/imageModelCatalog.js');
  return !!(await getImageModel(v));
}

export const IMAGE_MODEL_ERROR =
  `image_model must be one of: ${ALLOWED_IMAGE_MODELS.join('|')} — or a fal catalog endpoint id from GET /api/image-models`;

// Fail fast (before creating any pending tiles/jobs) when the chosen model's
// provider has no API key configured. Everything that isn't openai — the wired
// fal shortcuts AND every catalog endpoint — runs on fal.
export function assertImageModelConfigured(model) {
  if (model === 'openai') {
    if (!config.openai?.apiKey) {
      const err = new Error('OPENAI_API_KEY is not configured.');
      err.status = 400;
      throw err;
    }
    return;
  }
  if (!falConfigured()) {
    const err = new Error('FAL_KEY is not configured.');
    err.status = 400;
    throw err;
  }
}
