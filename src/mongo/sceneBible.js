// Pure scene-bible shape + rendering. No DB access — persistence lives in
// plots.js (setBeatSceneBible). The bible is a compact structured "look book"
// for a beat: location, lighting, palette, mood, blocking, continuity anchors,
// camera language. Every storyboard shot of the beat inherits it, so per-shot
// prompts stay short and the scene's look stays unified.

// Ordered list of the editable text fields. The order here is the order they
// render in the prompt block and (later) the SPA editor.
export const SCENE_BIBLE_FIELDS = Object.freeze([
  'location',
  'time_of_day',
  'lighting_key',
  'palette',
  'mood',
  'blocking',
  'continuity_anchors',
  'camera_language',
]);

// Human labels for prompt rendering. Keyed by field.
const FIELD_LABELS = Object.freeze({
  location: 'Location',
  time_of_day: 'Time of day',
  lighting_key: 'Lighting key',
  palette: 'Palette',
  mood: 'Mood',
  blocking: 'Blocking',
  continuity_anchors: 'Continuity anchors',
  camera_language: 'Camera language',
});

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Coerce arbitrary input into the canonical bible shape. Unknown keys dropped,
// non-string field values become ''. Always returns an object with every field
// present (empty string when unset). `updated_at` is stamped by the persistence
// layer (setBeatSceneBible in plots.js), not here.
export function normalizeSceneBible(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const f of SCENE_BIBLE_FIELDS) out[f] = cleanStr(src[f]);
  return out;
}

export function isEmptySceneBible(bible) {
  if (!bible || typeof bible !== 'object') return true;
  return SCENE_BIBLE_FIELDS.every((f) => !cleanStr(bible[f]));
}

// Render the populated fields as a labeled text block for inclusion in an LLM
// prompt. Returns null when the bible has no content (so callers can omit the
// section entirely rather than emit an empty header).
export function renderSceneBibleBlock(bible) {
  if (isEmptySceneBible(bible)) return null;
  const lines = [];
  for (const f of SCENE_BIBLE_FIELDS) {
    const v = cleanStr(bible[f]);
    if (v) lines.push(`${FIELD_LABELS[f]}: ${v}`);
  }
  return lines.join('\n');
}
