// Mirror of src/util/specifics.js for the SPA. Keep in sync with the backend
// schema. Used by the "Specifics" tab to render one CollabField per entry.

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
