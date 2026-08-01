// Pure filter logic for the playground model chooser. Kept out of the React
// component so vitest can exercise it directly (tests/playground-filter.test.js).
//
// Semantics: *visibility* = the model can accept everything currently
// attached (an empty form shows all models); *readiness* = every required
// slot is satisfied, gating the Generate button and the "needs …" badges.

export function modelAcceptsAttachments(model, counts, hasPrompt) {
  const slots = model?.inputs || {};
  if (hasPrompt && slots.prompt === 'unused') return false;
  if (counts.image > 0) {
    const image = slots.image || {};
    if (!image.need || image.need === 'unused') return false;
    if (image.max !== null && image.max !== undefined && counts.image > image.max) return false;
  }
  if (counts.audio > 0 && (!slots.audio || slots.audio.need === 'unused')) return false;
  if (counts.video > 0 && (!slots.video || slots.video.need === 'unused')) return false;
  return true;
}

export function modelReadiness(model, counts, hasPrompt) {
  const slots = model?.inputs || {};
  const missing = [];
  if (slots.prompt === 'required' && !hasPrompt) missing.push('prompt');
  if ((slots.image?.required_count || 0) > counts.image) missing.push('image');
  if (slots.audio?.need === 'required' && !counts.audio) missing.push('audio');
  if (slots.video?.need === 'required' && !counts.video) missing.push('video');
  return { ready: missing.length === 0, missing };
}
