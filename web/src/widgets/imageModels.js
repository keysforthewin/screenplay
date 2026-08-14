// Shared image-model registry for every "edit / regenerate / generate image"
// dialog in the SPA. The server validates the same enum, so adding a model
// here without a matching server-side branch will surface a friendly 400.

export const IMAGE_MODELS = [
  { id: 'nano-banana-pro', label: 'Nano Banana Pro (Gemini 3 Pro)' },
  { id: 'flux-2-pro', label: 'Flux 2 Pro' },
  { id: 'flux-pro-kontext', label: 'Flux Pro Kontext' },
  { id: 'openai', label: 'OpenAI (gpt-image-2)' },
  { id: 'gemini-25-flash', label: 'Gemini 2.5 Flash (fast)' },
  { id: 'nano-banana-2', label: 'Nano Banana 2 (Gemini 3.1 Flash)' },
  { id: 'flux-2-klein', label: 'Flux 2 Klein (fast)' },
];

export const IMAGE_MODEL_IDS = new Set(IMAGE_MODELS.map((m) => m.id));
export const DEFAULT_IMAGE_MODEL = 'nano-banana-pro';

// Read a persisted model choice from localStorage, falling back to the default
// when the stored value is missing or no longer valid (e.g. an old `'gemini'`
// or `'fal'` from a previous build). The bad value is left in place; the next
// successful submit will overwrite it.
export function readStoredImageModel(storageKey) {
  try {
    const v = localStorage.getItem(storageKey);
    return IMAGE_MODEL_IDS.has(v) ? v : DEFAULT_IMAGE_MODEL;
  } catch {
    return DEFAULT_IMAGE_MODEL;
  }
}

// Catalog-aware variant for pickers backed by GET /api/image-models `catalog`:
// any non-empty id is kept, because the valid set is the live fal catalog
// rather than the fixed IMAGE_MODELS array above. The server re-validates on
// submit, and the picker highlights nothing if a stored id has since vanished.
export function readStoredCatalogModel(storageKey) {
  try {
    const v = localStorage.getItem(storageKey);
    return typeof v === 'string' && v.trim() ? v : DEFAULT_IMAGE_MODEL;
  } catch {
    return DEFAULT_IMAGE_MODEL;
  }
}

export function writeStoredImageModel(storageKey, value) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {}
}
