/**
 * Classify a fal.ai endpoint's OpenAPI input params into the four playground
 * slots — prompt, image(s), audio, video — and detect its media output.
 *
 * Runs at catalog build time only (scripts/build-fal-playground-catalog.js);
 * the resolved param names are stored in data/fal-playground-models.json so
 * the runtime (src/fal/playgroundModels.js) never repeats these heuristics.
 *
 * Name sets are supersets of the video ones in src/fal/videoModels.js /
 * scripts/cluster-fal-video-models.js. Masks are deliberately unclassified:
 * a model *requiring* a mask is unsatisfiable in the playground (no mask
 * editor), and an optional mask is simply left unset.
 */

const PROMPT_NAMES = new Set(['prompt', 'text', 'text_prompt', 'text_input', 'instruction', 'script']);

const MASK_NAMES = new Set(['mask_url', 'mask_image_url', 'mask_video_url']);

const IMAGE_NAMES = new Set([
  // start-frame flavors
  'image_url', 'first_frame_url', 'start_image_url', 'first_image_url',
  'first_frame_image_url', 'start_frame', 'source_image_url', 'input_image_url',
  // end-frame flavors
  'end_image_url', 'last_frame_url', 'tail_image_url', 'end_frame', 'last_image_url',
  // reference / subject flavors
  'reference_image_url', 'subject_reference_image_url', 'character_image',
  'face_image_url', 'portrait_image_url', 'person_image_url', 'human_image_url',
  'garment_image_url', 'style_image_url', 'control_image_url',
  // list flavors
  'image_urls', 'ref_image_urls', 'reference_image_urls', 'input_image_urls',
  'image_references', 'style_image_urls', 'control_image_urls',
]);

const AUDIO_NAMES = new Set([
  'audio_url', 'audio_urls', 'driven_audio_url', 'audio_input',
  'voice_url', 'speech_url', 'first_audio_url', 'reference_audio_url',
  'second_audio_url', 'audio_file', 'music_url', 'song_url',
]);

const VIDEO_NAMES = new Set([
  'video_url', 'source_video_url', 'videos', 'video', 'video_urls',
  'driving_video_url', 'reference_pose_video_url', 'reference_video_urls',
  'input_video_url', 'face_video_url',
]);

function isListParam(name, summary) {
  const t = String(summary?.type || '');
  if (t.endsWith('[]')) return true;
  return /(_urls|_references|^videos)$/.test(name);
}

/**
 * requiredParams/optionalParams are extractIO() summaries:
 *   { name: { type, default?, title?, enum?, ... } }
 */
export function classifyInputs(requiredParams = {}, optionalParams = {}) {
  const result = {
    prompt: 'unused',
    prompt_param: null,
    image: { need: 'unused', params: [], required_count: 0, max: 0 },
    audio: { need: 'unused', param: null, list: false },
    video: { need: 'unused', param: null, list: false },
    defaults: {},
    unsatisfied_required: [],
  };

  const entries = [
    ...Object.entries(requiredParams).map(([name, s]) => [name, s, true]),
    ...Object.entries(optionalParams).map(([name, s]) => [name, s, false]),
  ];

  for (const [name, summary, required] of entries) {
    const lower = name.toLowerCase();

    if (PROMPT_NAMES.has(lower) && result.prompt_param == null) {
      result.prompt = required ? 'required' : 'optional';
      result.prompt_param = name;
      continue;
    }

    if (!MASK_NAMES.has(lower) && IMAGE_NAMES.has(lower)) {
      const list = isListParam(lower, summary);
      result.image.params.push({ name, list, required });
      if (required) {
        result.image.need = 'required';
        result.image.required_count += 1;
      } else if (result.image.need === 'unused') {
        result.image.need = 'optional';
      }
      if (result.image.max !== null) {
        result.image.max = list ? null : result.image.max + 1;
      }
      continue;
    }

    const slotFor = AUDIO_NAMES.has(lower) ? 'audio'
      : (!MASK_NAMES.has(lower) && VIDEO_NAMES.has(lower)) ? 'video'
      : null;
    if (slotFor) {
      const slot = result[slotFor];
      if (slot.param == null) {
        slot.need = required ? 'required' : 'optional';
        slot.param = name;
        slot.list = isListParam(lower, summary);
      } else if (required) {
        // Only one audio/video slot exists in the playground; a second
        // *required* param of the same kind can't be filled.
        result.unsatisfied_required.push(name);
      }
      continue;
    }

    if (required) {
      if (summary && summary.default !== undefined) {
        result.defaults[name] = summary.default;
      } else {
        result.unsatisfied_required.push(name);
      }
    }
  }

  return result;
}

// Output-shaping params surfaced as user controls in the playground UI
// (size/resolution/duration — the knobs that determine output dimensions and
// drive pricing). Whitelist order = display order. Enum params become
// selects; integer DURATION-ish params become bounded number inputs.
const CONTROL_NAMES = [
  'image_size', 'size', 'resolution', 'aspect_ratio',
  'duration', 'duration_seconds', 'video_duration', 'num_frames',
];
const INT_CONTROL_NAMES = new Set(['duration', 'duration_seconds', 'video_duration', 'num_frames']);

export function extractControls(requiredParams = {}, optionalParams = {}) {
  const all = { ...optionalParams, ...requiredParams };
  const controls = [];
  for (const name of CONTROL_NAMES) {
    const summary = all[name];
    if (!summary) continue;
    if (Array.isArray(summary.enum) && summary.enum.length) {
      controls.push({
        name,
        type: 'enum',
        options: summary.enum,
        default: summary.default !== undefined ? summary.default : null,
      });
    } else if (
      (summary.type === 'integer' || summary.type === 'number')
      && INT_CONTROL_NAMES.has(name)
    ) {
      controls.push({
        name,
        type: 'int',
        default: summary.default !== undefined ? summary.default : null,
        min: summary.minimum !== undefined ? summary.minimum : null,
        max: summary.maximum !== undefined ? summary.maximum : null,
      });
    }
  }
  return controls;
}

// Output props scanned in priority order. First classifiable prop wins.
const OUTPUT_CANDIDATES = [
  'video', 'videos', 'video_url',
  'image', 'images', 'image_url',
  'audio', 'audio_file', 'audio_url', 'speech', 'music',
  'output', 'media', 'file',
];

function kindFromText(s) {
  const t = String(s || '').toLowerCase();
  if (t.includes('image')) return 'image';
  if (t.includes('video')) return 'video';
  if (t.includes('audio') || t.includes('speech') || t.includes('music') || t.includes('sound')) return 'audio';
  return null;
}

/**
 * outputShape is extractIO()'s output map. Returns { kind, path } where path
 * addresses the media URL in a result payload ('video.url', 'images[0].url',
 * or a bare prop name for plain uri strings), or null when the model does not
 * output media (→ excluded from the catalog).
 */
export function detectOutput(outputShape = {}) {
  for (const name of OUTPUT_CANDIDATES) {
    const summary = outputShape[name];
    if (!summary) continue;
    // Kind precedence: resolved schema title (Image/VideoFile/AudioFile...),
    // then the prop name, then the summarized type text.
    const kind = kindFromText(summary.title) || kindFromText(name) || kindFromText(summary.type);
    if (!kind) continue;
    const type = String(summary.type || '');
    if (type === 'string') return { kind, path: name };
    if (type.endsWith('[]')) return { kind, path: `${name}[0].url` };
    return { kind, path: `${name}.url` };
  }
  return null;
}
