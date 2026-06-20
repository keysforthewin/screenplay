// Static character-sheet shot template + per-shot prompt composer.
//
// A "character sheet" is a fixed, reusable set of portrait / turnaround /
// expression shots generated for a single character. The SAME template fills
// for every character — only the subject handle, the scanned character fields,
// and the project's director's notes vary. The user-picked reference images are
// passed to the image provider separately (they lock the likeness), so the text
// prompt stays short and never names the character (image models can't resolve
// a made-up proper name — same rule the storyboard pipeline follows).
//
// `CHARACTER_SHEET_SHOTS` is the canonical superset; an adjustable shot count
// slices it. Tune the list / preamble here — it's the single source of truth,
// and the SPA's default count is bounded by CHARACTER_SHEET_SHOTS.length.

import { stripMarkdown } from '../util/markdown.js';
import { clipField, NON_VISUAL_CASTING, formatDirectorNotes } from './storyboardGenerate.js';

// Neutral, identity-locking framing shared by every shot so the set reads as a
// coherent reference sheet (plain backdrop, even light, no scene).
export const CHARACTER_SHEET_STYLE_PREAMBLE =
  'Character reference sheet image. Plain seamless neutral-grey studio backdrop, ' +
  'even soft frontal lighting, no props, no background scene, photoreal, sharp focus, ' +
  'consistent identity and wardrobe across the set.';

// The fixed shot list (name + framing fragment). Names double as the artwork
// card labels in the gallery, so keep them short and human-readable.
export const CHARACTER_SHEET_SHOTS = [
  { name: 'Front headshot — neutral', fragment: 'tight head-and-shoulders headshot, facing camera straight on, neutral relaxed expression, eyes to lens' },
  { name: '3/4 left headshot', fragment: 'head-and-shoulders headshot, face turned three-quarters to the left, neutral expression' },
  { name: '3/4 right headshot', fragment: 'head-and-shoulders headshot, face turned three-quarters to the right, neutral expression' },
  { name: 'Left profile', fragment: 'strict left-side profile of the head, ninety degrees to camera, neutral expression' },
  { name: 'Right profile', fragment: 'strict right-side profile of the head, ninety degrees to camera, neutral expression' },
  { name: 'Back of head', fragment: 'back of the head and shoulders, subject facing fully away from camera, showing hair and nape' },
  { name: 'Expression — smiling', fragment: 'front head-and-shoulders headshot, genuine warm smile' },
  { name: 'Expression — intense', fragment: 'front head-and-shoulders headshot, intense determined expression, brow slightly furrowed' },
  { name: 'Full body — front', fragment: 'full-body shot head to toe, standing front-facing in a neutral A-pose, arms slightly away from the body, full wardrobe and footwear visible' },
  { name: 'Full body — back', fragment: 'full-body shot head to toe, standing with back to camera, full rear of the wardrobe and silhouette visible' },
  { name: 'Full body — 3/4 action', fragment: 'full-body three-quarter angle, relaxed dynamic standing pose with characteristic body language' },
];

const LOOK_KEYS = ['description', 'appearance', 'look', 'background_story', 'bio'];

// Clamp a requested shot count into [1, max]; an omitted/invalid count means the
// full preset.
export function clampShotCount(n, max = CHARACTER_SHEET_SHOTS.length) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return max;
  return Math.min(max, Math.max(1, Math.round(v)));
}

// A short, NAME-FREE visual handle for the subject. Prefers the actor likeness
// (the strongest handle) unless the casting is voice-only/mocap — in which case
// the actor isn't the on-screen face, so we fall back to the character's own
// described look, then a role label, then a generic placeholder.
export function buildSubjectHandle(character) {
  const fields = character?.fields && typeof character.fields === 'object' ? character.fields : {};
  const actorClean = stripMarkdown(typeof character?.hollywood_actor === 'string' ? character.hollywood_actor : '')
    .replace(/\s+/g, ' ')
    .trim();
  const actor = actorClean && !NON_VISUAL_CASTING.test(actorClean) ? clipField(actorClean, 80) : '';
  const role = clipField(fields.role, 80);
  let look = '';
  for (const k of LOOK_KEYS) {
    const v = clipField(fields[k]);
    if (v) { look = v; break; }
  }
  if (actor) return `a person with the exact likeness of ${actor}${role ? `, the ${role}` : ''}`;
  if (look) return look;
  if (role) return `the ${role}`;
  return 'the character';
}

// Scan ALL of the character's custom fields into a compact, bounded context
// string ("key: value; key: value"). Honors "scan the contents of the character
// data (all the fields)" without letting any single long field blow up the
// prompt. Skips the field already used as the look lead to avoid duplication.
export function scanCharacterFields(character, { maxPerField = 200, maxTotal = 1500, skipKeys = [] } = {}) {
  const fields = character?.fields && typeof character.fields === 'object' ? character.fields : {};
  const skip = new Set(skipKeys);
  const parts = [];
  let total = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (skip.has(k)) continue;
    const clipped = clipField(v, maxPerField);
    if (!clipped) continue;
    const piece = `${k.replace(/_/g, ' ')}: ${clipped}`;
    if (total + piece.length + 2 > maxTotal) break;
    parts.push(piece);
    total += piece.length + 2;
  }
  return parts.join('; ');
}

// Compose the full image prompt for one shot of one character.
export function buildCharacterShotPrompt({ character, shot, directorNotes = [] }) {
  const handle = buildSubjectHandle(character);
  const details = scanCharacterFields(character);
  const notes = formatDirectorNotes(directorNotes);
  const lines = [
    CHARACTER_SHEET_STYLE_PREAMBLE,
    '',
    `Shot: ${shot.fragment}.`,
    '',
    `Subject: ${handle}.`,
  ];
  if (details) {
    lines.push('', `Character details to honor: ${details}.`);
  }
  if (notes) {
    lines.push('', "Director's notes (apply as global style/tone guidance):", notes);
  }
  return lines.join('\n');
}

// Build the full (or sliced) sheet: one { name, prompt } per shot.
export function buildCharacterSheetShots({ character, directorNotes = [], shotCount } = {}) {
  const n = clampShotCount(shotCount);
  return CHARACTER_SHEET_SHOTS.slice(0, n).map((shot) => ({
    name: shot.name,
    prompt: buildCharacterShotPrompt({ character, shot, directorNotes }),
  }));
}
