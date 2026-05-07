// Mirror of src/util/beatSpecifics.js for the SPA. Keep in sync with the
// backend schema. Used by the beat "Specifics" tab.

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
    placeholder: 'dusk / late autumn / 1978; or "second act, after the storm"',
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
    placeholder: 'Furniture, signage, vegetation, vehicles, posters, scattered debris…',
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
