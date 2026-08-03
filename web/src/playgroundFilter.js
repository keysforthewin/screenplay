// Pure filter logic for the playground model chooser. Kept out of the React
// component so vitest can exercise it directly (tests/playground-filter.test.js).
//
// The chooser is driven by checkbox filters, not by the attachments directly:
// the page auto-checks/unchecks the input boxes as media/prompt are added or
// removed, and the user can toggle them freely. A model is VISIBLE only when
// it can run with exactly the checked inputs —
//   checked kind   → the model accepts it (need !== 'unused'),
//   unchecked kind → the model does not require it.
// Non-matching models are hidden entirely (never greyed out). The output
// select narrows further by what the model produces (null = any kind).

export function defaultFilters() {
  return {
    prompt: false,
    image: false,
    audio: false,
    video: false,
    imageCount: 0,
    category: null,
    output: null,
  };
}

// Catalog categories are '<input>-to-<output>' slugs. Parsing one yields the
// input checkboxes and output kind that make the filters match its models —
// so picking a category in the UI can preset both. Returns null for slugs
// that don't fit the pattern ('vision', 'json', ...): those set only the
// category filter itself.
const CATEGORY_INPUTS = {
  text: { prompt: true },
  image: { image: true },
  audio: { audio: true },
  video: { video: true },
};
const CATEGORY_OUTPUTS = { image: 'image', video: 'video', audio: 'audio', speech: 'audio' };

export function categoryImplications(category) {
  const m = /^([a-z]+)-to-([a-z]+)$/.exec(String(category || ''));
  if (!m) return null;
  const inputs = CATEGORY_INPUTS[m[1]];
  const output = CATEGORY_OUTPUTS[m[2]];
  if (!inputs || !output) return null;
  return {
    inputs: { prompt: false, image: false, audio: false, video: false, ...inputs },
    output,
  };
}

export function modelMatchesFilters(model, filters) {
  const slots = model?.inputs || {};
  if (filters.output && model?.output?.kind !== filters.output) return false;
  if (filters.category && (model?.category || '') !== filters.category) return false;

  if (filters.prompt) {
    if (!slots.prompt || slots.prompt === 'unused') return false;
  } else if (slots.prompt === 'required') {
    return false;
  }

  const image = slots.image || {};
  if (filters.image) {
    if (!image.need || image.need === 'unused') return false;
    if (
      filters.imageCount > 0
      && image.max !== null && image.max !== undefined
      && filters.imageCount > image.max
    ) return false;
  } else if ((image.required_count || 0) > 0) {
    return false;
  }

  for (const kind of ['audio', 'video']) {
    const slot = slots[kind] || {};
    if (filters[kind]) {
      if (!slot.need || slot.need === 'unused') return false;
    } else if (slot.need === 'required') {
      return false;
    }
  }

  return true;
}

// Free-text search across the fields a user might remember a model by:
// id, display name, category, and the catalog description.
export function modelMatchesSearch(model, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [model?.endpoint_id, model?.display_name, model?.category, model?.description]
    .some((f) => (f || '').toLowerCase().includes(q));
}

// Readiness is about the ACTUAL attachments/prompt (not the checkboxes): it
// gates the Generate button when the user has checked a box exploratorily
// without providing the corresponding input yet.
export function modelReadiness(model, counts, hasPrompt) {
  const slots = model?.inputs || {};
  const missing = [];
  if (slots.prompt === 'required' && !hasPrompt) missing.push('prompt');
  if ((slots.image?.required_count || 0) > counts.image) missing.push('image');
  if (slots.audio?.need === 'required' && !counts.audio) missing.push('audio');
  if (slots.video?.need === 'required' && !counts.video) missing.push('video');
  return { ready: missing.length === 0, missing };
}
