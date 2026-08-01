// Pure filter logic for the playground model chooser. Kept out of the React
// component so vitest can exercise it directly (tests/playground-filter.test.js).
//
// The chooser is driven by checkbox filters, not by the attachments directly:
// the page auto-checks/unchecks the input boxes as media/prompt are added or
// removed, and the user can toggle them freely. A model is VISIBLE only when
// it can run with exactly the checked inputs —
//   checked kind   → the model accepts it (need !== 'unused'),
//   unchecked kind → the model does not require it.
// Non-matching models are hidden entirely (never greyed out). Output-kind
// checkboxes narrow further by what the model produces.

export function defaultFilters() {
  return {
    prompt: false,
    image: false,
    audio: false,
    video: false,
    imageCount: 0,
    outputs: { image: true, video: true, audio: true },
  };
}

export function modelMatchesFilters(model, filters) {
  const slots = model?.inputs || {};
  if (!filters.outputs?.[model?.output?.kind]) return false;

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
