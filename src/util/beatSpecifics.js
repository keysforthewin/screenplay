// beatSpecifics.js
//
// Mirror of util/specifics.js for *beats* (scenes). Same shape, scene-oriented
// fields. The web SPA renders one CollabField per entry on the beat's
// "Specifics" tab; the autofill endpoint asks Claude to fill empty entries
// from the beat's name/desc/body text + attached reference images; the
// generate endpoint substitutes filled values into a gpt-image-2 prompt to
// produce a UE5 production-grade scene reference sheet.
//
// Stored on the beat document under `beat.specifics.<name>`. Four field
// names are intentionally shared with character specifics (proportion_style,
// asymmetrical_details, label_visual_style, continuity_locks) because they
// describe rendering style / continuity which apply identically to scenes.

export const BEAT_SPECIFICS_FIELDS = [
  {
    name: 'scene_type',
    label: 'Scene Type',
    placeholder:
      'interior / exterior / mixed / set / on-location / virtual / underwater / aerial / dream sequence / other',
    multiline: false,
  },
  {
    name: 'scene_summary',
    label: 'Scene Summary',
    placeholder: 'One-paragraph scene description',
    multiline: true,
  },
  {
    name: 'environment_baseline',
    label: 'Environment Baseline',
    placeholder:
      'Overall setting, e.g. "abandoned diner at the edge of a desert highway"',
    multiline: true,
  },
  {
    name: 'time_period',
    label: 'Time / Period',
    placeholder:
      'dusk / late autumn / 1978; or "second act, after the storm"',
    multiline: false,
  },
  {
    name: 'scale_geography',
    label: 'Scale & Geography',
    placeholder:
      'e.g. "20m × 30m diner, parking lot to the south, highway running east-west"',
    multiline: true,
  },
  {
    name: 'proportion_style',
    label: 'Proportion Style',
    placeholder:
      'realistic / stylized / heroic / hyper-real / sketch / matte painting / production-render',
    multiline: false,
  },
  {
    name: 'focal_points',
    label: 'Focal Points & Staging',
    placeholder:
      'Hero objects, blocking zones, where the action takes place; primary camera angle',
    multiline: true,
  },
  {
    name: 'materials_atmosphere',
    label: 'Materials & Atmosphere',
    placeholder:
      'surfaces, textures, weather, fog, dust, lighting quality, color palette',
    multiline: true,
  },
  {
    name: 'set_dressing',
    label: 'Set Dressing / Layout',
    placeholder:
      'Furniture, signage, vegetation, vehicles, posters, scattered debris…',
    multiline: true,
  },
  {
    name: 'asymmetrical_details',
    label: 'Asymmetrical Details',
    placeholder:
      'Set details that differ between sides. e.g. "burned wall on north side, broken sign on east approach"',
    multiline: true,
  },
  {
    name: 'key_props',
    label: 'Key Props & Set Elements',
    placeholder: 'Hero props, action props, signage, devices, gear, vehicles',
    multiline: true,
  },
  {
    name: 'label_visual_style',
    label: 'Label & Visual Style',
    placeholder:
      'minimal labels / numbered callouts / blank label boxes | UE5 production render, matte painting, anime, dark fantasy, sci-fi hard surface…',
    multiline: true,
  },
  {
    name: 'continuity_locks',
    label: 'Important Continuity Locks',
    placeholder: 'Repeat non-negotiable features here',
    multiline: true,
  },
];

export const BEAT_SPECIFICS_FIELD_NAMES = BEAT_SPECIFICS_FIELDS.map((f) => f.name);

export function isBeatSpecificsFieldName(name) {
  return BEAT_SPECIFICS_FIELD_NAMES.includes(name);
}

const SCENE_PROMPT_PREAMBLE = `Create a complex UE5 production-grade scene reference sheet for the scene described below.

Use strict production continuity. The location must remain visually identical across all shots. Preserve geometry, lighting direction, materials, props, set dressing, weather, time-of-day consistency, and all asymmetrical layout details.

Use a technical 3D environment-reference layout, not a glamour shot. Include orthographic-style views, top-down floor plan, clean studio lighting in detail panels, neutral but production-relevant background, panel borders, callout lines, scale references, surface-detail panels, prop callouts, and lighting/atmosphere panels. Camera-relative left/right are stable across panels — annotate with compass directions where useful. Never mirror asymmetrical set details between views.

Separate neutral environment documentation from complex set-dressing documentation. Use a clean readable base lighting setup for geometry/material panels. Put atmosphere, weather, props, signage, and asymmetric dressing into dedicated panels.`;

const REQUIRED_VIEWS_BLOCK = `REQUIRED VIEWS:
1. Wide establishing shot
2. 3/4 perspective from primary camera angle
3. Reverse / opposite angle
4. Top-down floor plan
5. Eye-level human-scale view
6. Hero / looking-up angle
7. Detail close-ups
8. Material/surface close-ups
9. Key prop callouts
10. Lighting/atmosphere panel
11. Time-of-day or weather variant
12. Compass orientation diagram
13. Set-dressing detail panel`;

const SECTION_HEADERS = {
  scene_type: 'SCENE TYPE',
  scene_summary: 'SCENE SUMMARY',
  environment_baseline: 'ENVIRONMENT BASELINE',
  time_period: 'TIME / PERIOD',
  scale_geography: 'SCALE & GEOGRAPHY',
  proportion_style: 'PROPORTION STYLE',
  focal_points: 'FOCAL POINTS & STAGING',
  materials_atmosphere: 'MATERIALS & ATMOSPHERE',
  set_dressing: 'SET DRESSING / LAYOUT',
  asymmetrical_details: 'ASYMMETRICAL DETAILS',
  key_props: 'KEY PROPS & SET ELEMENTS',
  label_visual_style: 'LABEL & VISUAL STYLE',
  continuity_locks: 'IMPORTANT CONTINUITY LOCKS',
};

const FIELDS_BEFORE_VIEWS = [
  'scene_type',
  'scene_summary',
  'environment_baseline',
  'time_period',
  'scale_geography',
  'proportion_style',
  'focal_points',
  'materials_atmosphere',
  'set_dressing',
  'asymmetrical_details',
  'key_props',
];

const FIELDS_AFTER_VIEWS = ['label_visual_style', 'continuity_locks'];

function renderSection(name, value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  return `${SECTION_HEADERS[name]}:\n${v}`;
}

export function buildSceneSheetPrompt(specifics, { sceneName } = {}) {
  const s = specifics || {};
  const before = FIELDS_BEFORE_VIEWS.map((n) => renderSection(n, s[n])).filter(Boolean);
  const after = FIELDS_AFTER_VIEWS.map((n) => renderSection(n, s[n])).filter(Boolean);

  const parts = [SCENE_PROMPT_PREAMBLE];
  if (sceneName && String(sceneName).trim()) {
    parts.push(`SCENE NAME: ${String(sceneName).trim()}`);
  }
  if (before.length) parts.push(before.join('\n\n'));
  parts.push(REQUIRED_VIEWS_BLOCK);
  if (after.length) parts.push(after.join('\n\n'));
  return parts.join('\n\n');
}
