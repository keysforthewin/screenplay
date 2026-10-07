// ComfyUI video model registry — the comfy twin of src/fal/videoModels.js.
//
// Each entry names a ComfyUI workflow TEMPLATE (from the built-in gallery,
// fetched through comfy-mcp) and maps our CANONICAL parameters onto the
// template's slot addresses, as `comfy workflow slots` reports them. The
// addresses were read off the fetched templates on 2026-09-30 — never guess
// one: a wrong address is silently ignored by `set_workflow_slot`.
//
// Two facts shape the maps:
//   - Subgraph widget inputs that are LINK-DRIVEN (LTX / MiniMax width and
//     height come from a ResolutionSelector node) cannot be set directly, so
//     those templates expose `aspect_ratio` + `megapixels` instead.
//   - `kind: 'api'` templates run on a partner's servers and SPEND CREDITS;
//     comfy-cli fails them closed unless the run carries consent, and our
//     routes require an explicit confirm_spend on top.
//
// `verified` marks entries whose mapping has been exercised against a live
// ComfyUI; the others were mapped from the slot list only.

export const CANONICAL_PARAM_ORDER = Object.freeze([
  'prompt',
  'negative_prompt',
  'duration_seconds',
  'aspect_ratio',
  'megapixels',
  'width',
  'height',
  'resolution',
  'fps',
  'seed',
  'steps',
  'cfg',
  'generate_audio',
  'prompt_enhance',
  'long_clip',
  'guide_strength',
]);

export const PARAM_LABELS = Object.freeze({
  prompt: 'Prompt',
  negative_prompt: 'Negative prompt',
  duration_seconds: 'Duration (s)',
  aspect_ratio: 'Aspect ratio',
  megapixels: 'Megapixels',
  width: 'Width',
  height: 'Height',
  resolution: 'Resolution',
  fps: 'Frames per second',
  seed: 'Seed',
  steps: 'Steps',
  cfg: 'CFG',
  generate_audio: 'Generate audio',
  prompt_enhance: 'Prompt enhancer',
  long_clip: 'Long clip (context windows)',
  guide_strength: 'Keyframe strength',
});

// The longest clip LTX-2.5 renders in one pass; beyond it a render needs
// context windows (`long_clip`).
export const LTX_NATIVE_MAX_SECONDS = 20;
export const LTX_LONG_CLIP_MAX_SECONDS = 60;

export const INPUT_NEEDS = Object.freeze({
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  UNUSED: 'unused',
});

const RESOLUTION_SELECTOR_ASPECTS = Object.freeze([
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
]);

const SEED_SPEC = Object.freeze({
  type: 'int',
  default: null,
  min: 0,
  max: 2 ** 48,
  help: 'Leave blank for a random seed; set one to reproduce a render.',
});

export const COMFY_VIDEO_MODELS = [
  {
    id: 'ltx-2.5-i2v',
    label: 'LTX-2.5 (image to video)',
    family: 'LTX-2.5',
    lab: 'Lightricks',
    template: 'video_ltx2_5_i2v',
    kind: 'local',
    spends_credits: false,
    available: true,
    verified: true,
    description:
      'Local LTX-2.5 22B distilled: 24 fps, synchronized audio, native multishot. Fastest of the installed models.',
    inputs: { startFrame: INPUT_NEEDS.REQUIRED, referenceImages: INPUT_NEEDS.UNUSED, audio: INPUT_NEEDS.UNUSED },
    imageSlots: [{ address: '395.image', role: 'start_frame' }],
    maxReferenceImages: 0,
    params: {
      prompt: { address: '398.value', type: 'string', default: '' },
      negative_prompt: {
        address: '398/373.text',
        type: 'string',
        default: 'pc game, console game, video game, cartoon, childish, ugly',
      },
      duration_seconds: { address: '398.value_2', type: 'int', default: 5, min: 1, max: 20, step: 1 },
      aspect_ratio: {
        address: '403.aspect_ratio',
        type: 'string',
        default: '16:9 (Widescreen)',
        enum: RESOLUTION_SELECTOR_ASPECTS,
      },
      megapixels: {
        address: '403.megapixels',
        type: 'float',
        default: 0.9,
        min: 0.2,
        max: 2.0,
        step: 0.1,
        help: '0.9 = 1280×736 at 16:9; 1.0 = 1376×768; 2.0 = 1920×1088 (multiples of 32).',
      },
      fps: { address: '398.value_5', type: 'int', default: 24, min: 12, max: 60, step: 1 },
      seed: { address: '398.noise_seed', ...SEED_SPEC },
      prompt_enhance: {
        address: '398.value_1',
        type: 'bool',
        default: false,
        help: 'Keep off: our prompts are already compiled; the enhancer rewrites them and adds ~1–2 min.',
      },
    },
    output: { filenamePrefix: '75.filename_prefix', format: '75.format' },
    fixed: [],
    constraints: { resolution_multiple: 32 },
    notes: 'Width/height are driven by the ResolutionSelector node (aspect ratio + megapixels).',
  },
  {
    // A BUILDER model: no gallery template. The graph is emitted per render
    // by src/comfy/ltxKeyframeWorkflow.js (`graph` names the builder), with
    // one LTXVAddGuide per picture — the start frame, every keyframe of the
    // cut at its time, the end frame — so a clip is conditioned on N
    // keyframes in one generation. Params carry no slot addresses.
    id: 'ltx-2.5-keyframes',
    label: 'LTX-2.5 keyframes (start + keyframes + end)',
    family: 'LTX-2.5',
    lab: 'Lightricks',
    template: null,
    graph: 'ltx25-keyframes',
    kind: 'local',
    spends_credits: false,
    available: true,
    verified: true,
    description:
      "Local LTX-2.5 22B distilled, built per render: the cut's start frame, each of its keyframes at its time and the end frame pin the clip in ONE generation — keyframe spacing is the speed. Up to 20 s natively; `long_clip` adds context windows for 30 s+ (try 960×540 if it runs out of memory).",
    inputs: {
      startFrame: INPUT_NEEDS.REQUIRED,
      endFrame: INPUT_NEEDS.REQUIRED,
      keyframes: INPUT_NEEDS.OPTIONAL,
      referenceImages: INPUT_NEEDS.UNUSED,
      audio: INPUT_NEEDS.UNUSED,
    },
    imageSlots: [],
    maxReferenceImages: 0,
    params: {
      prompt: { type: 'string', default: '' },
      negative_prompt: { type: 'string', default: null, help: "Blank = the LTX-2.5 template's own negative prompt." },
      duration_seconds: {
        type: 'float',
        default: 5,
        min: 1,
        max: LTX_LONG_CLIP_MAX_SECONDS,
        step: 0.5,
        help: `Up to ${LTX_NATIVE_MAX_SECONDS} s in one pass; longer needs "long clip".`,
      },
      width: { type: 'int', default: 1280, min: 256, max: 1920, step: 32, multiple: 32 },
      height: { type: 'int', default: 720, min: 256, max: 1920, step: 32, multiple: 32 },
      fps: { type: 'int', default: 24, min: 12, max: 60, step: 1 },
      seed: { ...SEED_SPEC },
      long_clip: {
        type: 'bool',
        default: false,
        help: `Context windows: one render beyond ${LTX_NATIVE_MAX_SECONDS} s. Try 960×540 if it runs out of memory.`,
      },
      guide_strength: {
        type: 'float',
        default: 0.7,
        min: 0.1,
        max: 1,
        step: 0.05,
        help: 'How hard the start frame, the end frame and any keyframe without its own strength are held (the template uses 0.7).',
      },
    },
    output: { filenamePrefix: null },
    fixed: [],
    constraints: { resolution_multiple: 32 },
    notes: 'Builder model: the workflow is generated per render (API format) and validated against ComfyUI before it runs. Keyframes snap to the 8-frame latent grid.',
  },
  {
    id: 'ltx-2.3-ia2v',
    label: 'LTX-2.3 lip-sync (image + audio to video)',
    family: 'LTX-2.3',
    lab: 'Lightricks',
    template: 'video_ltx2_3_ia2v',
    kind: 'local',
    spends_credits: false,
    available: true,
    verified: false,
    description:
      "Local LTX-2.3 22B: the cut's start frame plus the covered dialogue lines' REAL recordings (joined) → a clip with synchronized lip movement. Render beat picks it when every covered line is recorded.",
    inputs: { startFrame: INPUT_NEEDS.REQUIRED, referenceImages: INPUT_NEEDS.UNUSED, audio: INPUT_NEEDS.REQUIRED },
    imageSlots: [{ address: '269.image', role: 'start_frame' }],
    // The LoadAudio node: the uploaded MP3 of the covered lines' recordings.
    audioSlots: [{ address: '276.audio', role: 'dialogue' }],
    maxReferenceImages: 0,
    params: {
      prompt: { address: '340.value', type: 'string', default: '' },
      negative_prompt: {
        address: '340/314.text',
        type: 'string',
        default: 'pc game, console game, video game, cartoon, childish, ugly',
      },
      duration_seconds: {
        address: '340.value_4',
        type: 'float',
        default: 5,
        min: 1,
        max: 60,
        step: 0.5,
        help: "Defaults to the joined recordings' length; the audio is trimmed to this.",
      },
      width: { address: '340.value_1', type: 'int', default: 1280, min: 256, max: 1920, step: 16, help: 'Template default 1280×720.' },
      height: { address: '340.value_2', type: 'int', default: 720, min: 256, max: 1088, step: 16 },
      fps: { address: '340.value_3', type: 'int', default: 24, min: 12, max: 60, step: 1 },
      seed: { address: '340.noise_seed', ...SEED_SPEC },
      prompt_enhance: {
        address: '340.value_5',
        type: 'bool',
        default: false,
        help: 'Keep off: our prompts are already compiled; the enhancer rewrites them.',
      },
    },
    output: { filenamePrefix: '341.filename_prefix', format: '341.format' },
    fixed: [],
    constraints: { resolution_multiple: 32 },
    notes: 'Addresses read from the fetched template 2026-09-30 (340.value_5 is the prompt-enhancer switch, on by default in the template — we ship it off). Not yet run live.',
  },
  {
    id: 'wan-2.2-14b-i2v',
    label: 'Wan 2.2 14B (image to video)',
    family: 'Wan 2.2',
    lab: 'Alibaba',
    template: 'video_wan2_2_14B_i2v',
    kind: 'local',
    spends_credits: false,
    available: true,
    verified: true,
    description:
      'Local Wan 2.2 14B i2v, 4-step Lightning LoRA path at 16 fps. Slower than LTX on a 16 GB card; the quality alternative.',
    inputs: { startFrame: INPUT_NEEDS.REQUIRED, referenceImages: INPUT_NEEDS.UNUSED, audio: INPUT_NEEDS.UNUSED },
    imageSlots: [{ address: '97.image', role: 'start_frame' }],
    maxReferenceImages: 0,
    params: {
      prompt: { address: '129.text', type: 'string', default: '' },
      negative_prompt: {
        address: '129/89.text',
        type: 'string',
        default:
          '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走',
        help: "The template's stock Wan negative (Chinese). Leave it unless you know why.",
      },
      duration_seconds: { address: '129.value_1', type: 'float', default: 5, min: 1, max: 10, step: 0.5 },
      width: { address: '129.width', type: 'int', default: 832, min: 256, max: 1280, step: 16, multiple: 16 },
      height: { address: '129.height', type: 'int', default: 480, min: 256, max: 1280, step: 16, multiple: 16 },
      fps: { address: '129/94.fps', type: 'float', default: 16, min: 8, max: 30, step: 1 },
      seed: { address: '129.noise_seed', ...SEED_SPEC },
      steps: {
        address: '129/118.value',
        type: 'int',
        default: 4,
        min: 2,
        max: 12,
        step: 1,
        help: 'Lightning LoRA steps (split between the high- and low-noise passes).',
      },
      cfg: { address: '129/122.value', type: 'float', default: 1, min: 1, max: 10, step: 0.5 },
    },
    // The two samplers split the step budget at the "switch step" primitive.
    derived: (params) => [{ address: '129/124.value', value: Math.max(1, Math.round(Number(params.steps || 4) / 2)) }],
    output: { filenamePrefix: '108.filename_prefix', format: '108.format' },
    fixed: [],
    constraints: { resolution_multiple: 16 },
    notes: 'Frame count is derived by the template from fps × duration + 1.',
  },
  {
    id: 'wan-2.2-14b-flf2v',
    label: 'Wan 2.2 14B (first → last frame)',
    family: 'Wan 2.2',
    lab: 'Alibaba',
    template: 'video_wan2_2_14B_flf2v',
    kind: 'local',
    spends_credits: false,
    available: true,
    verified: true,
    description:
      'Local Wan 2.2 14B first-last-frame: the clip travels from the cut\'s start frame to its end frame, so a moving camera lands on the place the end frame shows. Full 20-step path at 16 fps — slow.',
    inputs: { startFrame: INPUT_NEEDS.REQUIRED, endFrame: INPUT_NEEDS.REQUIRED, referenceImages: INPUT_NEEDS.UNUSED, audio: INPUT_NEEDS.UNUSED },
    imageSlots: [
      { address: '80.image', role: 'start_frame' },
      { address: '89.image', role: 'end_frame' },
    ],
    maxReferenceImages: 0,
    params: {
      prompt: { address: '90.text', type: 'string', default: '' },
      negative_prompt: {
        address: '78.text',
        type: 'string',
        default:
          '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走',
        help: "The template's stock Wan negative (Chinese). Leave it unless you know why.",
      },
      // 81.length counts FRAMES: `derived` (applied after the params, last
      // write wins) rewrites the seconds into a Wan 4n+1 frame count.
      duration_seconds: { address: '81.length', type: 'float', default: 5, min: 1, max: 10, step: 0.5 },
      width: { address: '81.width', type: 'int', default: 832, min: 256, max: 1280, step: 16, multiple: 16 },
      height: { address: '81.height', type: 'int', default: 480, min: 256, max: 1280, step: 16, multiple: 16 },
      fps: { address: '86.fps', type: 'float', default: 16, min: 8, max: 30, step: 1 },
      seed: { address: '84.noise_seed', ...SEED_SPEC },
      steps: { address: '84.steps', type: 'int', default: 20, min: 4, max: 40, step: 1, help: 'Split between the high- and low-noise passes.' },
      cfg: { address: '84.cfg', type: 'float', default: 4, min: 1, max: 10, step: 0.5 },
    },
    // Frames = fps × duration + 1 (Wan wants 4n+1); the second sampler takes
    // the same step count, cfg and the other half of the schedule.
    derived: (params) => {
      const fps = Number(params.fps || 16);
      const secs = Number(params.duration_seconds || 5);
      const frames = Math.max(5, Math.round((fps * secs) / 4) * 4 + 1);
      const steps = Math.max(2, Math.round(Number(params.steps || 20)));
      const split = Math.max(1, Math.round(steps / 2));
      return [
        { address: '81.length', value: frames },
        { address: '87.steps', value: steps },
        { address: '84.end_at_step', value: split },
        { address: '87.start_at_step', value: split },
        { address: '87.cfg', value: Number(params.cfg || 4) },
      ];
    },
    output: { filenamePrefix: '83.filename_prefix', format: '83.format' },
    fixed: [],
    constraints: { resolution_multiple: 16 },
    notes: 'Addresses read from the fetched template 2026-09-30 (the active full-step pipeline; the bypassed 4-step Lightning copy is ignored). Verified 2026-09-30: scripts/comfy-smoke.js rendered a 3 s clip from a red start still to a blue end still (6 steps, ~45 s on a 16 GB card).',
  },
  {
    id: 'minimax-h3-i2v',
    label: 'MiniMax H3 (image to video)',
    family: 'MiniMax H3',
    lab: 'MiniMax',
    template: 'video_minimax_h3_i2v',
    kind: 'local',
    spends_credits: false,
    available: true,
    verified: false,
    description:
      'Local MiniMax H3 fl2va with native stereo audio, 24 fps, 768px short edge. 4-step turbo LoRA path.',
    inputs: { startFrame: INPUT_NEEDS.REQUIRED, referenceImages: INPUT_NEEDS.UNUSED, audio: INPUT_NEEDS.UNUSED },
    imageSlots: [{ address: '114.image', role: 'start_frame' }],
    maxReferenceImages: 0,
    params: {
      prompt: { address: '105.prompt', type: 'string', default: '' },
      duration_seconds: { address: '105.value_1', type: 'float', default: 5, min: 1, max: 15, step: 0.5 },
      aspect_ratio: {
        address: '115.aspect_ratio',
        type: 'string',
        default: '16:9 (Widescreen)',
        enum: RESOLUTION_SELECTOR_ASPECTS,
      },
      megapixels: {
        address: '115.megapixels',
        type: 'float',
        default: 0.9,
        min: 0.2,
        max: 0.98,
        step: 0.1,
        help: '0.98 = 1344×768 (official 768p) at 16:9; the model caps at a 768px short edge.',
      },
      seed: { address: '105.noise_seed', ...SEED_SPEC },
      steps: { address: '105/9.steps', type: 'int', default: 4, min: 1, max: 20, step: 1 },
    },
    output: { filenamePrefix: '92.filename_prefix', format: '92.format' },
    fixed: [],
    constraints: { resolution_multiple: 32 },
    notes:
      'fps is fixed at 24: the template derives the frame count on a 17k+5 grid at 24 fps. Mapped from the slot list; not yet run live.',
  },
  {
    id: 'seedance-2.5-i2v-1080p',
    label: 'Seedance 2.5 1080p (image to video, API)',
    family: 'Seedance 2.5',
    lab: 'ByteDance',
    template: 'api_seedance2_5_i2v_1080p',
    kind: 'api',
    spends_credits: true,
    available: true,
    verified: false,
    description:
      'ByteDance Seedance 2.5 through the Comfy API node: 1080p image-to-video, up to 30 s. Spends Comfy credits.',
    inputs: { startFrame: INPUT_NEEDS.REQUIRED, referenceImages: INPUT_NEEDS.UNUSED, audio: INPUT_NEEDS.UNUSED },
    imageSlots: [{ address: '2.image', role: 'start_frame' }],
    maxReferenceImages: 0,
    params: {
      prompt: { address: '9.model.prompt', type: 'string', default: '' },
      duration_seconds: { address: '9.model.duration', type: 'int', default: 5, min: 3, max: 30, step: 1 },
      resolution: { address: '9.model.resolution', type: 'string', default: '1080p', enum: ['480p', '720p', '1080p'] },
      aspect_ratio: {
        address: '9.model.ratio',
        type: 'string',
        default: '16:9',
        enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      },
      generate_audio: {
        address: '9.model.generate_audio',
        type: 'bool',
        default: false,
        help: 'Off by default: real voices are recorded and lip-synced in post.',
      },
      seed: { address: '9.seed', ...SEED_SPEC, default: 0 },
    },
    output: { filenamePrefix: '7.filename_prefix', format: '7.format' },
    fixed: [
      { address: '9.model', value: 'Seedance 2.5' },
      { address: '9.watermark', value: false },
    ],
    constraints: {},
    notes: 'Mapped from the slot list; not yet run live.',
  },
  {
    id: 'seedance-2.0-r2v',
    label: 'Seedance 2.0 (reference to video, API)',
    family: 'Seedance 2.0',
    lab: 'ByteDance',
    template: 'api_seedance2_0_r2v',
    kind: 'api',
    spends_credits: true,
    available: true,
    verified: false,
    description:
      'ByteDance Seedance 2.0 reference-to-video through the Comfy API node. This template carries ONE reference slot, so only @Image1 binds. Spends Comfy credits.',
    inputs: { startFrame: INPUT_NEEDS.UNUSED, referenceImages: INPUT_NEEDS.REQUIRED, audio: INPUT_NEEDS.UNUSED },
    imageSlots: [{ address: '356.image', role: 'reference' }],
    maxReferenceImages: 1,
    params: {
      prompt: { address: '361.model.prompt', type: 'string', default: '' },
      duration_seconds: { address: '361.model.duration', type: 'int', default: 7, min: 4, max: 15, step: 1 },
      resolution: {
        address: '361.model.resolution',
        type: 'string',
        default: '720p',
        enum: ['480p', '720p', '1080p', '4k'],
      },
      aspect_ratio: {
        address: '361.model.ratio',
        type: 'string',
        default: '16:9',
        enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      },
      generate_audio: {
        address: '361.model.generate_audio',
        type: 'bool',
        default: false,
        help: 'Off by default: real voices are recorded and lip-synced in post.',
      },
      seed: { address: '361.seed', ...SEED_SPEC, default: 0 },
    },
    output: { filenamePrefix: '344.filename_prefix', format: '344.format' },
    fixed: [
      { address: '361.model', value: 'Seedance 2.0' },
      { address: '361.watermark', value: false },
    ],
    constraints: {},
    notes: 'One LoadImage in the template: the first reference image only. Mapped from the slot list; not yet run live.',
  },
  {
    id: 'kling-3.0',
    label: 'Kling 3.0 (image to video, API)',
    family: 'Kling 3.0',
    lab: 'Kling',
    template: 'api_kling_v3_video',
    kind: 'api',
    spends_credits: true,
    available: true,
    verified: false,
    description:
      'Kling 3.0 through the Comfy API node, driven as a single storyboard. Spends Comfy credits.',
    inputs: { startFrame: INPUT_NEEDS.OPTIONAL, referenceImages: INPUT_NEEDS.UNUSED, audio: INPUT_NEEDS.UNUSED },
    imageSlots: [{ address: '1.image', role: 'start_frame' }],
    maxReferenceImages: 0,
    params: {
      prompt: { address: '3.multi_shot.storyboard_1_prompt', type: 'string', default: '' },
      duration_seconds: { address: '3.multi_shot.storyboard_1_duration', type: 'int', default: 5, min: 1, max: 15, step: 1 },
      resolution: { address: '3.model.resolution', type: 'string', default: '1080p', enum: ['4k', '1080p', '720p'] },
      aspect_ratio: { address: '3.model.aspect_ratio', type: 'string', default: '16:9', enum: ['16:9', '9:16', '1:1'] },
      generate_audio: {
        address: '3.generate_audio',
        type: 'bool',
        default: false,
        help: 'Off by default: real voices are recorded and lip-synced in post.',
      },
      seed: { address: '3.seed', ...SEED_SPEC },
    },
    output: { filenamePrefix: '2.filename_prefix', format: '2.format' },
    fixed: [
      { address: '3.multi_shot', value: '1 storyboard' },
      { address: '3.model', value: 'kling-v3' },
    ],
    constraints: {},
    notes: "The template ships as a two-storyboard multi-shot; we pin it to one storyboard and write the cut's prompt there. Not yet run live.",
  },
];

const byId = new Map(COMFY_VIDEO_MODELS.map((m) => [m.id, m]));

// Models registered at runtime from the ComfyUI gallery (Admin → ComfyUI
// templates; persisted in app_settings {_id:'comfy_models'} and loaded at
// boot). Static entries win on an id collision — validateRegistryEntry
// refuses those before they are stored. These two lookups are the only merge
// point: prepareCutRender, the /comfy routes and the SPA all go through them.
const registered = new Map();

export function registerComfyVideoModels(entries = []) {
  registered.clear();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e?.id || byId.has(e.id)) continue;
    registered.set(e.id, { ...e, registered: true });
  }
  return registered.size;
}

export function listRegisteredComfyVideoModels() {
  return [...registered.values()];
}

export function getComfyVideoModel(id) {
  const key = String(id || '');
  return byId.get(key) || registered.get(key) || null;
}

export function listComfyVideoModels() {
  return [...COMFY_VIDEO_MODELS, ...registered.values()];
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const PARAM_TYPES = new Set(['string', 'int', 'float', 'bool', 'enum']);
const FRAME_RULES = ['4n+1', '8n+1'];

// Check a registry entry the Admin page wants to store. `slotAddresses` is
// the template's slot listing (every address comfy-cli reported); when given,
// every address the entry uses must be in it — the same rule the fixture test
// enforces for the static entries. Returns { ok, errors, entry } with a
// normalized entry on success.
export function validateRegistryEntry(raw, slotAddresses = null) {
  const errors = [];
  const e = raw && typeof raw === 'object' ? raw : {};
  const id = String(e.id || '').trim();
  if (!ID_RE.test(id)) errors.push('id must be lowercase letters, digits, dots or dashes');
  if (byId.has(id)) errors.push(`id "${id}" collides with a built-in model`);
  const template = String(e.template || '').trim();
  if (!template) errors.push('template is required');
  if (e.graph) errors.push('builder models (graph) are built in; a registered model names a gallery template');
  const label = String(e.label || '').trim() || id;
  const kind = e.kind === 'api' ? 'api' : 'local';
  const spendsCredits = !!e.spends_credits;
  if (kind === 'api' && !spendsCredits) errors.push('an API template spends Comfy credits — spends_credits must be true');
  if (kind === 'local' && spendsCredits) errors.push('a local template does not spend credits');
  const known = slotAddresses ? new Set([...slotAddresses].map(String)) : null;
  const checkAddr = (addr, what) => {
    if (typeof addr !== 'string' || !addr.trim()) {
      errors.push(`${what}: address required`);
      return null;
    }
    if (known && !known.has(addr)) errors.push(`${what}: ${addr} is not a slot of ${template}`);
    return addr;
  };
  const params = {};
  const rawParams = e.params && typeof e.params === 'object' ? e.params : {};
  for (const [key, spec] of Object.entries(rawParams)) {
    if (!spec || typeof spec !== 'object') continue;
    if (!CANONICAL_PARAM_ORDER.includes(key)) {
      errors.push(`param ${key} is not a canonical parameter`);
      continue;
    }
    const address = checkAddr(spec.address, `param ${key}`);
    const type = PARAM_TYPES.has(spec.type) ? spec.type : key === 'prompt' || key === 'negative_prompt' ? 'string' : 'float';
    const out = { ...spec, address, type };
    if (type === 'enum' && !Array.isArray(out.options)) out.options = [];
    if (key === 'duration_seconds' && out.unit && out.unit !== 'seconds') {
      // A frame-count length slot: renders write seconds × fps as frames.
      if (out.unit !== 'frames') errors.push(`param duration_seconds: unit must be "seconds" or "frames"`);
      if (out.frame_rule != null && !FRAME_RULES.includes(out.frame_rule)) errors.push(`param duration_seconds: frame_rule must be one of ${FRAME_RULES.join(', ')}`);
    }
    params[key] = out;
  }
  if (!params.prompt) errors.push('a prompt param is required');
  if (!params.duration_seconds) errors.push('a duration_seconds param is required');
  const imageSlots = [];
  for (const s of Array.isArray(e.imageSlots) ? e.imageSlots : []) {
    const address = checkAddr(s?.address, 'image slot');
    if (address) imageSlots.push({ address, role: s.role === 'reference' || s.role === 'end_frame' ? s.role : 'start_frame' });
  }
  const audioSlots = [];
  for (const s of Array.isArray(e.audioSlots) ? e.audioSlots : []) {
    const address = checkAddr(s?.address, 'audio slot');
    if (address) audioSlots.push({ address, role: 'dialogue' });
  }
  const output = e.output && typeof e.output === 'object' ? e.output : null;
  const filenamePrefix = output ? checkAddr(output.filenamePrefix, 'output prefix') : null;
  if (!filenamePrefix) errors.push('output.filenamePrefix is required');
  const format = output?.format ? checkAddr(output.format, 'output format') : null;
  const fixed = [];
  for (const f of Array.isArray(e.fixed) ? e.fixed : []) {
    const address = checkAddr(f?.address, 'fixed value');
    if (address) fixed.push({ address, value: f.value });
  }
  const refCount = imageSlots.filter((s) => s.role === 'reference').length;
  const startCount = imageSlots.filter((s) => s.role === 'start_frame').length;
  const endCount = imageSlots.filter((s) => s.role === 'end_frame').length;
  if (startCount > 1) errors.push('only one start_frame image slot is allowed');
  if (endCount > 1) errors.push('only one end_frame image slot is allowed');
  const need = (v, fallback) => (Object.values(INPUT_NEEDS).includes(v) ? v : fallback);
  const inputs = {
    startFrame: need(e.inputs?.startFrame, startCount ? INPUT_NEEDS.REQUIRED : INPUT_NEEDS.UNUSED),
    // An unfilled LoadImage keeps the template's sample picture, so a mapped
    // end frame slot is required unless the entry says otherwise.
    endFrame: need(e.inputs?.endFrame, endCount ? INPUT_NEEDS.REQUIRED : INPUT_NEEDS.UNUSED),
    referenceImages: need(e.inputs?.referenceImages, refCount ? INPUT_NEEDS.OPTIONAL : INPUT_NEEDS.UNUSED),
    audio: need(e.inputs?.audio, audioSlots.length ? INPUT_NEEDS.REQUIRED : INPUT_NEEDS.UNUSED),
  };
  if (inputs.startFrame !== INPUT_NEEDS.UNUSED && !startCount) errors.push('inputs.startFrame is set but no start_frame image slot is mapped');
  if (inputs.endFrame !== INPUT_NEEDS.UNUSED && !endCount) errors.push('inputs.endFrame is set but no end_frame image slot is mapped');
  if (inputs.audio !== INPUT_NEEDS.UNUSED && !audioSlots.length) errors.push('inputs.audio is set but no audio slot is mapped');
  if (inputs.referenceImages !== INPUT_NEEDS.UNUSED && !refCount) errors.push('inputs.referenceImages is set but no reference image slot is mapped');
  const entry = {
    id,
    label,
    family: e.family ? String(e.family) : null,
    lab: e.lab ? String(e.lab) : null,
    template,
    kind,
    spends_credits: spendsCredits,
    available: e.available !== false,
    verified: !!e.verified,
    description: String(e.description || '').trim(),
    inputs,
    imageSlots,
    audioSlots,
    maxReferenceImages: refCount,
    params,
    output: { filenamePrefix, format },
    fixed,
    constraints: e.constraints && typeof e.constraints === 'object' ? e.constraints : {},
    notes: String(e.notes || '').trim(),
  };
  return { ok: errors.length === 0, errors, entry };
}

// Plain-data view for the SPA: functions (derived) stripped, params in
// canonical order with labels attached.
export function describeComfyVideoModel(m) {
  if (!m) return null;
  const params = {};
  for (const key of CANONICAL_PARAM_ORDER) {
    if (!m.params[key]) continue;
    const { address, ...spec } = m.params[key];
    params[key] = { ...spec, label: PARAM_LABELS[key] || key };
  }
  return {
    id: m.id,
    label: m.label,
    family: m.family,
    lab: m.lab,
    template: m.template,
    graph: m.graph || null,
    kind: m.kind,
    spends_credits: !!m.spends_credits,
    available: m.available !== false,
    verified: !!m.verified,
    description: m.description || '',
    inputs: m.inputs,
    max_reference_images: m.maxReferenceImages || 0,
    params,
    notes: m.notes || '',
    registered: !!m.registered,
  };
}
