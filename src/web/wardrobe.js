// The wardrobe lock — the one source of a character's clothes for every
// picture of them (artwork proposals, cut start/end frames, image sheets).
//
// Text authority: the character template's `wardrobe` field, overridable
// per beat in `beat.wardrobe_overrides[<character _id hex>]`. Image
// authority: `character.wardrobe_image_id`, the canonical wardrobe plate.
// Pure helpers; the callers decide where the words and the plate go.
import { stripMarkdown } from '../util/markdown.js';

export const WARDROBE_FIELD = 'wardrobe';
export const WARDROBE_TEXT_MAX = 300;

// A line this module writes into a prompt — stripped and re-inserted on
// rebinding so a stored prompt always carries the CURRENT lock.
export const WARDROBE_LINE_RE = /^Wardrobe \(locked/;

function clean(raw, max = WARDROBE_TEXT_MAX) {
  const s = stripMarkdown(typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function characterKey(character) {
  const id = character?._id;
  return id ? String(id) : '';
}

// The beat's override for this character, if any.
export function wardrobeOverride(character, beat) {
  const map = beat?.wardrobe_overrides;
  if (!map || typeof map !== 'object') return '';
  const key = characterKey(character);
  return key ? clean(map[key]) : '';
}

// The locked wardrobe words: the beat override, else the character field.
export function wardrobeText(character, beat = null) {
  const override = wardrobeOverride(character, beat);
  if (override) return override;
  return clean(character?.fields?.[WARDROBE_FIELD]);
}

// `Wardrobe (locked — reproduce exactly): …` or '' when nothing is locked.
export function wardrobeLine(character, beat = null) {
  const text = wardrobeText(character, beat);
  return text ? `Wardrobe (locked — reproduce exactly): ${text}` : '';
}

// The plate's GridFS id as a 24-hex string, or ''.
export function wardrobeImageId(character) {
  const id = character?.wardrobe_image_id;
  const s = id ? String(id) : '';
  return /^[a-f0-9]{24}$/i.test(s) ? s : '';
}

// One row per character of a roster: { id, name, text, image_id }.
export function lockedWardrobeFor(characters, beat = null) {
  const out = [];
  for (const c of Array.isArray(characters) ? characters : []) {
    if (!c) continue;
    const name = stripMarkdown(c.name || '').trim();
    out.push({
      id: characterKey(c),
      name: name || 'Unnamed',
      text: wardrobeText(c, beat),
      image_id: wardrobeImageId(c),
    });
  }
  return out;
}

// `Wardrobe lock — <name>: <text>` lines for the rows that have text;
// appended under a still prompt (never stored in it).
export function formatLockRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.text)
    .map((r) => `Wardrobe lock — ${r.name}: ${r.text}`)
    .join('\n');
}

export function formatWardrobeLocks(characters, beat = null) {
  return formatLockRows(lockedWardrobeFor(characters, beat));
}
