// Registry of fal.ai video models exposed to the SPA's "Generate video"
// dialog. Each entry knows:
//   - which fal model id to call
//   - which storyboard inputs it consumes (required vs optional vs unused)
//   - how to assemble the input payload from already-uploaded fal URLs
//   - how to read the video URL back out of the result
//
// Adding a new model is a one-entry change: drop a record below, expose the
// id in the SPA picker, done. The orchestrator (src/web/falVideoGenerate.js)
// never branches on model id.

export const INPUT_NEEDS = Object.freeze({
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  UNUSED: 'unused',
});

// Maximum number of character "elements" we'll pass to Kling 3 Pro. The
// model's docs cap at a small number; we cap at 4 to match Kling's
// reference docs and to keep prompt size sane.
const MAX_ELEMENTS = 4;

// Cap a prompt to a model's documented hard limit. fal returns a validation
// error on long prompts; we silently truncate so a too-long text_prompt
// never blocks a render. Kling docs mention 2000 chars; we keep 1500 as a
// safety margin shared across models.
const PROMPT_HARD_CAP = 2000;
function capPrompt(s) {
  const t = String(s || '').trim();
  return t.length > PROMPT_HARD_CAP ? t.slice(0, PROMPT_HARD_CAP) : t;
}

// Map our input bundle to a "video URL" payload shape that every model in
// this registry can stitch from. The orchestrator hands every model the
// same bundle; each model picks the fields it needs.
//
// The bundle:
//   prompt:                string (markdown stripped, fal-cap applied)
//   startFrameUrl:         fal URL of storyboard.start_frame_id image
//   endFrameUrl:           fal URL of storyboard.end_frame_id image (or null)
//   characterSheetUrl:     fal URL of storyboard.character_sheet_image_id (or null)
//   characterElements:     [{ frontalUrl, referenceUrls: [] }] built from
//                          each character in characters_in_scene (capped)
//   referenceImageUrls:    fal URLs for each storyboard.reference_image_ids[]
//   audioUrl:              fal URL of storyboard.audio_file_id (or null)
//   durationSeconds:       integer 1..15
//   generateAudio:         boolean (only honored by models that support it)

export const VIDEO_MODELS = [
  {
    id: 'kling-3-pro',
    label: 'Kling 3 Pro',
    falModel: 'fal-ai/kling-video/v3/pro/image-to-video',
    description:
      'Image-to-video with start frame, optional end frame, character elements ' +
      '(built from characters_in_scene), and native audio synthesis from the prompt.',
    // Kling 3 Pro accepts integer-string durations 3..15.
    durations: ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
    defaultDuration: '5',
    supportsGenerateAudio: true,
    inputs: {
      startFrame: INPUT_NEEDS.REQUIRED,
      endFrame: INPUT_NEEDS.OPTIONAL,
      characterSheet: INPUT_NEEDS.UNUSED,
      characterElements: INPUT_NEEDS.OPTIONAL,
      referenceImages: INPUT_NEEDS.UNUSED,
      audio: INPUT_NEEDS.UNUSED,
    },
    buildInput(bundle) {
      const input = {
        prompt: capPrompt(bundle.prompt) || 'Cinematic shot.',
        start_image_url: bundle.startFrameUrl,
        duration: String(bundle.durationSeconds || 5),
        generate_audio: Boolean(bundle.generateAudio),
      };
      if (bundle.endFrameUrl) input.end_image_url = bundle.endFrameUrl;
      const elements = (bundle.characterElements || []).slice(0, MAX_ELEMENTS).map((el) => {
        const out = { frontal_image_url: el.frontalUrl };
        if (Array.isArray(el.referenceUrls) && el.referenceUrls.length) {
          out.reference_image_urls = el.referenceUrls;
        }
        return out;
      });
      if (elements.length) input.elements = elements;
      return input;
    },
    extractVideoUrl(data) {
      return data?.video?.url || data?.output || null;
    },
  },

  {
    id: 'veo-3-1-flf',
    label: 'Veo 3.1 (first-last-frame)',
    falModel: 'fal-ai/veo3.1/first-last-frame-to-video',
    description:
      'Best-in-class motion quality. Requires both start and end frames. ' +
      'Audio is generated from the prompt; cannot consume an input audio file.',
    durations: ['4', '6', '8'],
    defaultDuration: '8',
    supportsGenerateAudio: true,
    inputs: {
      startFrame: INPUT_NEEDS.REQUIRED,
      endFrame: INPUT_NEEDS.REQUIRED,
      characterSheet: INPUT_NEEDS.UNUSED,
      characterElements: INPUT_NEEDS.UNUSED,
      referenceImages: INPUT_NEEDS.UNUSED,
      audio: INPUT_NEEDS.UNUSED,
    },
    buildInput(bundle) {
      return {
        prompt: capPrompt(bundle.prompt) || 'Cinematic shot.',
        first_frame_url: bundle.startFrameUrl,
        last_frame_url: bundle.endFrameUrl,
        duration: `${bundle.durationSeconds || 8}s`,
        generate_audio: Boolean(bundle.generateAudio),
      };
    },
    extractVideoUrl(data) {
      return data?.video?.url || null;
    },
  },

  {
    id: 'kling-avatar-v2-pro',
    label: 'Kling AI Avatar v2 Pro (lip-sync)',
    falModel: 'fal-ai/kling-video/ai-avatar/v2/pro',
    description:
      'True lip-sync. Takes one anchor image plus an audio file and animates a ' +
      'talking head matched to the audio. Ignores end frame and character elements.',
    // Duration follows the input audio length; the API has no duration knob.
    durations: [],
    defaultDuration: null,
    supportsGenerateAudio: false,
    inputs: {
      // Anchor image: the orchestrator prefers character_sheet_image_id when
      // present (closer crop of the speaking subject), else falls back to
      // start_frame_id. We mark startFrame REQUIRED so storyboards without
      // either anchor get rejected with a clear message.
      startFrame: INPUT_NEEDS.REQUIRED,
      endFrame: INPUT_NEEDS.UNUSED,
      characterSheet: INPUT_NEEDS.OPTIONAL,
      characterElements: INPUT_NEEDS.UNUSED,
      referenceImages: INPUT_NEEDS.UNUSED,
      audio: INPUT_NEEDS.REQUIRED,
    },
    buildInput(bundle) {
      const input = {
        image_url: bundle.characterSheetUrl || bundle.startFrameUrl,
        audio_url: bundle.audioUrl,
      };
      const prompt = capPrompt(bundle.prompt);
      if (prompt) input.prompt = prompt;
      return input;
    },
    extractVideoUrl(data) {
      return data?.video?.url || null;
    },
  },
];

const MODELS_BY_ID = new Map(VIDEO_MODELS.map((m) => [m.id, m]));

export function getVideoModel(id) {
  return MODELS_BY_ID.get(String(id)) || null;
}

// Inputs the SPA dialog can use to drive UI affordances without re-deriving
// shape per model. Returns null when the id isn't registered.
export function describeVideoModel(id) {
  const m = getVideoModel(id);
  if (!m) return null;
  return {
    id: m.id,
    label: m.label,
    description: m.description,
    durations: m.durations,
    defaultDuration: m.defaultDuration,
    supportsGenerateAudio: m.supportsGenerateAudio,
    inputs: m.inputs,
  };
}

// Storyboard fields each input maps to; used by validateInputs and by the
// orchestrator when assembling the bundle.
const INPUT_TO_FIELD = Object.freeze({
  startFrame: 'start_frame_id',
  endFrame: 'end_frame_id',
  characterSheet: 'character_sheet_image_id',
  audio: 'audio_file_id',
});

// Human-readable label for missing-input errors.
const INPUT_LABEL = Object.freeze({
  startFrame: 'start frame',
  endFrame: 'end frame',
  characterSheet: 'character sheet',
  audio: 'audio',
});

// Validate that a storyboard has the inputs a chosen model requires.
// Returns an array of human-readable missing labels (empty when OK).
export function validateStoryboardInputs(model, storyboard) {
  const missing = [];
  for (const [inputKey, need] of Object.entries(model.inputs)) {
    if (need !== INPUT_NEEDS.REQUIRED) continue;
    const field = INPUT_TO_FIELD[inputKey];
    if (!field) continue; // characterElements/referenceImages have no single storyboard field
    if (!storyboard[field]) missing.push(INPUT_LABEL[inputKey] || inputKey);
  }
  return missing;
}
