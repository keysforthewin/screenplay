// specifics.js
//
// Single source of truth for the "Specifics" tab fields on a character.
//
// These power the web-only character-sheet workflow: the SPA renders one
// CollabField per entry, the autofill endpoint asks Claude vision to fill in
// empty entries from the character's reference images, and the generate
// endpoint substitutes the filled values into the gpt-image-2 prompt.
//
// Stored on the character document under `character.specifics.<name>`. The
// agent's view of the character intentionally does NOT enumerate these (they
// live outside `fields.*`).

export const SPECIFICS_FIELDS = [
  {
    name: 'character_type',
    label: 'Character Type',
    placeholder:
      'human / humanoid / fantasy creature / robot / alien / animal-like / stylized / realistic / other',
    multiline: false,
  },
  {
    name: 'character_summary',
    label: 'Character Summary',
    placeholder: 'Short description of the character',
    multiline: true,
  },
  {
    name: 'demographic_baseline',
    label: 'Demographic Baseline',
    placeholder: 'Standing demographic profile',
    multiline: true,
  },
  {
    name: 'age',
    label: 'Age / Apparent Age',
    placeholder: 'e.g. "early 30s" or "appears 25"',
    multiline: false,
  },
  {
    name: 'height_build',
    label: 'Height & Build',
    placeholder:
      '5\'10" | athletic   (height | slim/athletic/average/muscular/heavy/stocky/creature-specific)',
    multiline: false,
  },
  {
    name: 'proportion_style',
    label: 'Proportion Style',
    placeholder:
      'realistic 7-7.5 heads / fashion 8 heads / heroic / chibi / creature-specific / stylized',
    multiline: false,
  },
  {
    name: 'face_head_design',
    label: 'Face & Head Design',
    placeholder:
      'face shape, eyes, nose, lips, jaw, expression baseline | hair color/length/texture, bangs, parting, horns, ears, helmet, hood, crest…',
    multiline: true,
  },
  {
    name: 'skin_surface',
    label: 'Skin / Surface',
    placeholder:
      'skin tone, pores, scars, tattoos, makeup, fur, scales, metal, armor surface…',
    multiline: true,
  },
  {
    name: 'outfit_armor',
    label: 'Outfit / Armor',
    placeholder: 'Describe the full outfit',
    multiline: true,
  },
  {
    name: 'asymmetrical_details',
    label: 'Asymmetrical Details',
    placeholder:
      "Always from character's perspective. e.g. \"cutouts on character's left side, scar over character's right eye\"",
    multiline: true,
  },
  {
    name: 'accessories_props',
    label: 'Accessories / Props',
    placeholder: 'jewelry, weapons, bags, devices, wings, tail…',
    multiline: true,
  },
  {
    name: 'label_visual_style',
    label: 'Label & Visual Style',
    placeholder:
      'minimal labels / numbered callouts / blank label boxes | UE5 MetaHuman, anime, dark fantasy, sci-fi hard surface…',
    multiline: true,
  },
  {
    name: 'continuity_locks',
    label: 'Important Continuity Locks',
    placeholder: 'Repeat non-negotiable features here',
    multiline: true,
  },
];

export const SPECIFICS_FIELD_NAMES = SPECIFICS_FIELDS.map((f) => f.name);

export function isCharacterSpecificsFieldName(name) {
  return SPECIFICS_FIELD_NAMES.includes(name);
}

// Character sheet prompt attribution:
//   Created by IamEmily2050. Shared with us by GlitterPixely.
//   Both are incredibly talented artists — go check out their work, it's worth a look.
const SHEET_PROMPT_PREAMBLE = `Create a complex UE5 MetaHuman style production character sheet for the character described below.

Use strict production continuity. The character must remain identical across all views. Preserve face identity, body proportions, hairstyle, outfit, accessories, markings, and all asymmetrical left/right details.

Use a technical 3D character-reference layout, not a glamour poster. Include orthographic style body views, clean studio lighting, neutral background, panel borders, callout lines, body landmark labels, surface detail panels, hands/feet reference, hair/groom reference, and costume detail panels. Left and right are always from the character's perspective. Never mirror asymmetrical details between views.

Separate neutral body documentation from complex costume documentation. Use a simple readable base outfit for body measurement panels. Put complex clothing, armor, asymmetrical garments, props, and accessories into costume panels.`;

const REQUIRED_VIEWS_BLOCK = `REQUIRED VIEWS:
1. Front view
2. 3/4 left view
3. Left profile
4. Back view
5. 3/4 right view
6. Right profile
7. Looking-up view
8. Action pose
9. Body measurement and landmark panel
10. Surface detail close-ups
11. Hands and feet close-ups
12. Hair/groom or head-detail panel
13. Costume/armor/prop detail panel`;

const SECTION_HEADERS = {
  character_type: 'CHARACTER TYPE',
  character_summary: 'CHARACTER SUMMARY',
  demographic_baseline: 'DEMOGRAPHIC BASELINE',
  age: 'AGE / APPARENT AGE',
  height_build: 'HEIGHT & BUILD',
  proportion_style: 'PROPORTION STYLE',
  face_head_design: 'FACE & HEAD DESIGN',
  skin_surface: 'SKIN / SURFACE',
  outfit_armor: 'OUTFIT / ARMOR',
  asymmetrical_details: 'ASYMMETRICAL DETAILS',
  accessories_props: 'ACCESSORIES / PROPS',
  label_visual_style: 'LABEL & VISUAL STYLE',
  continuity_locks: 'IMPORTANT CONTINUITY LOCKS',
};

// Fields that come *before* the fixed REQUIRED VIEWS block in the prompt.
const FIELDS_BEFORE_VIEWS = [
  'character_type',
  'character_summary',
  'demographic_baseline',
  'age',
  'height_build',
  'proportion_style',
  'face_head_design',
  'skin_surface',
  'outfit_armor',
  'asymmetrical_details',
  'accessories_props',
];

// Fields that come *after* the fixed REQUIRED VIEWS block.
const FIELDS_AFTER_VIEWS = ['label_visual_style', 'continuity_locks'];

function renderSection(name, value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  return `${SECTION_HEADERS[name]}:\n${v}`;
}

export function buildCharacterSheetPrompt(specifics, { characterName } = {}) {
  const s = specifics || {};
  const before = FIELDS_BEFORE_VIEWS.map((n) => renderSection(n, s[n])).filter(Boolean);
  const after = FIELDS_AFTER_VIEWS.map((n) => renderSection(n, s[n])).filter(Boolean);

  const parts = [SHEET_PROMPT_PREAMBLE];
  if (characterName && String(characterName).trim()) {
    parts.push(`CHARACTER NAME: ${String(characterName).trim()}`);
  }
  if (before.length) parts.push(before.join('\n\n'));
  parts.push(REQUIRED_VIEWS_BLOCK);
  if (after.length) parts.push(after.join('\n\n'));
  return parts.join('\n\n');
}
