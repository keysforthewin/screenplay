// Shared image-model helpers for the SPA's generate/edit dialogs. Model
// choice everywhere is the catalog-backed ImageModelSelect widget (backed by
// GET /api/image-models); these helpers only handle the localStorage
// persistence of each dialog's last-used model.

export const DEFAULT_IMAGE_MODEL = 'nano-banana-pro';

// Read a persisted model choice from localStorage. Any non-empty id is kept,
// because the valid set is the live fal catalog rather than a fixed list. The
// server re-validates on submit, and ImageModelSelect falls back to the first
// eligible model if a stored id has since vanished from the catalog.
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
