// Ordering for the catalog-backed image model picker (ImageModelSelect.jsx).
// Kept as plain JS, apart from the component, so the ordering rules are unit
// testable — they carry the fiddly part of the picker's behaviour.

export const IMAGE_MODEL_SORTS = [
  { key: 'price-asc', label: 'Price: low → high' },
  { key: 'price-desc', label: 'Price: high → low' },
  { key: 'name', label: 'Name (A–Z)' },
];

export const DEFAULT_IMAGE_MODEL_SORT = 'price-asc';

const SORT_KEYS = new Set(IMAGE_MODEL_SORTS.map((s) => s.key));

export function isImageModelSort(key) {
  return SORT_KEYS.has(key);
}

// `price.sort_usd` is the same figure the row's label shows (see
// describeImagePrice in src/fal/imageModelCatalog.js). fal prices some models
// per image and others per megapixel, so this orders by the visible number
// rather than by an invented conversion the reader can't check.
//
// Models with no published price sink to the bottom in BOTH directions —
// flipping to "high → low" must not float the unknowns to the top, because
// "unknown" is not "expensive". Ties (and the whole unpriced tail) fall back to
// name order so the list never shuffles between renders.
export function sortImageModels(models, sort = DEFAULT_IMAGE_MODEL_SORT) {
  const byName = (a, b) => (a.display_name || '').localeCompare(b.display_name || '');
  const rows = [...(models || [])];
  if (sort === 'name') return rows.sort(byName);
  const dir = sort === 'price-desc' ? -1 : 1;
  return rows.sort((a, b) => {
    const pa = a.price?.sort_usd ?? null;
    const pb = b.price?.sort_usd ?? null;
    if (pa == null && pb == null) return byName(a, b);
    if (pa == null) return 1;
    if (pb == null) return -1;
    if (pa === pb) return byName(a, b);
    return (pa - pb) * dir;
  });
}
