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

// Framing shared by every shot. CRITICAL: never call this a "character sheet" /
// "reference sheet" / "model sheet" in the prompt — image models are trained to
// render those as multi-panel turnaround grids with captions and annotations,
// which is exactly the failure mode we must avoid. Each shot is ONE plain
// photograph of ONE pose, enforced by CHARACTER_SHEET_OUTPUT_RULES below.
export const CHARACTER_SHEET_STYLE_PREAMBLE =
  'A single photorealistic, full-color studio photograph of ONE person in ONE pose. ' +
  'Plain seamless mid-grey studio backdrop, soft even lighting, no props, sharp focus.';

// Hard negative constraints appended to every shot prompt — the levers that keep
// the model from drifting into a multi-panel "model sheet" with labels/biography.
export const CHARACTER_SHEET_OUTPUT_RULES = [
  'STRICT OUTPUT RULES:',
  '- Produce exactly ONE image of ONE person in the single pose described above — nothing else.',
  '- This is a plain photograph, NOT a character sheet, model sheet, reference sheet, turnaround, contact sheet, grid, collage, storyboard, or multi-panel layout. Never show the person more than once, and never place multiple views, angles, or poses side by side.',
  '- Do NOT add overlay graphics or descriptive text to the image: no captions, labels, headers, titles, name tags, callouts, measurements, annotations, borders, or watermarks. It is a candid photograph, not a labeled diagram.',
  '- BUT keep any text, lettering, logos, brand names, or graphics that naturally belong on the subject — printing on their clothing, patches, or accessories they wear. Render those faithfully and legibly; never blank them out or replace them with empty patches.',
].join('\n');

// The fixed shot list (name + framing fragment). Names double as the artwork
// card labels in the gallery, so keep them short and human-readable.
export const CHARACTER_SHEET_SHOTS = [
  // ── Headshot angles ────────────────────────────────────────────────
  { name: 'Front headshot — neutral', fragment: 'tight head-and-shoulders headshot, facing camera straight on, neutral relaxed expression, eyes to the lens' },
  { name: '3/4 left headshot', fragment: 'head-and-shoulders headshot, face turned three-quarters to the left, neutral expression, eyes to the lens' },
  { name: '3/4 right headshot', fragment: 'head-and-shoulders headshot, face turned three-quarters to the right, neutral expression, eyes to the lens' },
  { name: 'Left profile', fragment: 'strict left-side profile of the head, ninety degrees to camera, neutral expression' },
  { name: 'Right profile', fragment: 'strict right-side profile of the head, ninety degrees to camera, neutral expression' },
  { name: 'Chin-up low angle', fragment: 'head-and-shoulders headshot shot from a slightly low angle looking up at the subject, chin lifted, assured neutral expression, eyes toward the lens' },
  { name: 'Chin-down high angle', fragment: 'head-and-shoulders headshot shot from a slightly high angle looking down at the subject, chin tucked, eyes raised to the lens' },
  { name: 'Gaze off-camera', fragment: 'three-quarter head-and-shoulders headshot, head turned slightly, eyes looking off to the side away from the lens, calm candid expression' },

  // ── Expressions / emotions (front head-and-shoulders) ──────────────
  { name: 'Warm genuine smile', fragment: 'front head-and-shoulders headshot, a warm genuine smile — mouth corners lifted, cheeks raised, light creasing at the outer corners of the eyes, bright relaxed happy gaze' },
  { name: 'Big joyful laugh', fragment: 'front head-and-shoulders headshot, caught mid-laugh — mouth open in a broad laugh showing teeth, eyes squeezed nearly shut, head tipped very slightly back, pure delight' },
  { name: 'Soft subtle smile', fragment: 'front head-and-shoulders headshot, a soft closed-lip smile, gentle and content, eyes calm and kind' },
  { name: 'Intense & determined', fragment: 'front head-and-shoulders headshot, an intense determined expression — eyebrows lowered and drawn together, eyes narrowed and sharply focused on the lens, jaw set firm, lips pressed into a hard line' },
  { name: 'Fierce anger', fragment: 'front head-and-shoulders headshot, fierce anger — brows slammed down and together, hard glaring eyes, nostrils flared, upper lip tightened with teeth slightly bared, jaw clenched' },
  { name: 'Sorrowful / sad', fragment: 'front head-and-shoulders headshot, deep sadness — inner eyebrows pulled up and together, eyes heavy and glistening, mouth corners turned down, a slight tremble to the lips' },
  { name: 'Surprised / shocked', fragment: 'front head-and-shoulders headshot, genuine shock — eyebrows raised high, forehead creased, eyes wide and round, mouth dropped open' },
  { name: 'Fearful / wary', fragment: 'front head-and-shoulders headshot, fear — eyebrows raised and drawn together, eyes widened and tense, lips parted and pulled back in apprehension' },
  { name: 'Pensive / thoughtful', fragment: 'front head-and-shoulders headshot, pensive and thoughtful — eyes cast slightly aside and unfocused, brow lightly knit, lips softly pursed, lost in thought' },
  { name: 'Sly smirk', fragment: 'front head-and-shoulders headshot, a sly knowing smirk — one corner of the mouth pulled up, one eyebrow cocked, a glint of mischief in the eyes' },
  { name: 'Disgust', fragment: 'front head-and-shoulders headshot, disgust — nose wrinkled, upper lip raised, eyes narrowed in a faint squint, recoiling slightly' },
  { name: 'Confident / proud', fragment: 'front head-and-shoulders headshot, calm confidence — chin slightly raised, a faint assured half-smile, steady self-possessed gaze straight to the lens' },

  // ── Back & full body ───────────────────────────────────────────────
  { name: 'Back of head', fragment: 'back of the head and shoulders, subject facing fully away from camera, showing hair and nape' },
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

// Compose the full image prompt for one shot of one character. Structure:
// single-photo framing → the pose → the subject handle → appearance/wardrobe to
// match (explicitly flagged as NON-text) → optional style notes → the strict
// no-text / no-grid output rules, repeated last for recency.
export function buildCharacterShotPrompt({ character, shot, directorNotes = [] }) {
  const handle = buildSubjectHandle(character);
  // Keep the appearance context tight so it informs the look without reading as
  // a caption block the model might render verbatim.
  const details = scanCharacterFields(character, { maxPerField: 160, maxTotal: 700 });
  const notes = formatDirectorNotes(directorNotes);
  const lines = [
    CHARACTER_SHEET_STYLE_PREAMBLE,
    '',
    `Pose: ${shot.fragment}.`,
    '',
    `Subject: ${handle}.`,
  ];
  if (details) {
    lines.push(
      '',
      `Appearance and wardrobe to match — use these to get the look right, but NEVER render any of this as text in the image: ${details}.`,
    );
  }
  if (notes) {
    lines.push('', 'Style and tone guidance (apply to the look; do not render as text):', notes);
  }
  lines.push('', CHARACTER_SHEET_OUTPUT_RULES);
  return lines.join('\n');
}

// Select which preset shots to generate. An explicit `shotNames` list (from the
// SPA checklist) wins and is honored in canonical preset order; otherwise fall
// back to the first `shotCount` shots (an omitted count means all).
export function selectSheetShots({ shotNames, shotCount } = {}) {
  if (Array.isArray(shotNames)) {
    const wanted = new Set(shotNames.map((s) => String(s)));
    return CHARACTER_SHEET_SHOTS.filter((s) => wanted.has(s.name));
  }
  return CHARACTER_SHEET_SHOTS.slice(0, clampShotCount(shotCount));
}

// Build the selected sheet: one { name, prompt } per chosen shot.
export function buildCharacterSheetShots({ character, directorNotes = [], shotNames, shotCount } = {}) {
  return selectSheetShots({ shotNames, shotCount }).map((shot) => ({
    name: shot.name,
    prompt: buildCharacterShotPrompt({ character, shot, directorNotes }),
  }));
}
