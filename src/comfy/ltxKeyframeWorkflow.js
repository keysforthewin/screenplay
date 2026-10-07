// LTX-2.5 multi-keyframe workflow — built as an API-format graph, not from a
// gallery template.
//
// The gallery's first/last-frame template (video_ltx2_5_flf2v) is two chained
// `LTXVAddGuide` nodes — frame_idx 0 and -1, strength 0.7 — followed by
// `LTXVCropGuides`. A guide pins one picture at one frame of the clip, so
// chaining N of them at chosen frame indices conditions the clip on N
// keyframes in ONE generation: frame index is time, keyframe spacing is speed.
// `set_workflow_slot` cannot add nodes and the template's guides live inside a
// subgraph, so this module emits the flat graph itself (the same node recipe
// and constants as the template's subgraph, read off the fetched template on
// 2026-10-06; the input names were read from the live `object_info`).
//
// API format: `{ "<node id>": { class_type, inputs } }`, where a linked input
// is `["<node id>", <output index>]`. Pure: no I/O, no ComfyUI.

export const LTX_LATENT_FRAME_STEP = 8;

export const LTX_DEFAULT_FILES = Object.freeze({
  unet: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
  videoVae: 'ltx-2.5-video-vae-bf16.safetensors',
  audioVae: 'ltx-2.5-audio-vae-bf16.safetensors',
  clip: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
});

// The template's negative prompt, verbatim.
export const LTX_DEFAULT_NEGATIVE_PROMPT =
  'blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, grainy texture, poor lighting, flickering, motion blur, distorted proportions, unnatural skin tones, deformed facial features, asymmetrical face, missing facial features, extra limbs, disfigured hands, wrong hand count, artifacts around text, unreadable text on shirt or hat, incorrect lettering on cap (“PNTR”), incorrect t-shirt slogan (“JUST DO IT”), missing microphone, misplaced microphone, inconsistent perspective, camera shake, incorrect depth of field, background too sharp, background clutter, distracting reflections, harsh shadows, inconsistent lighting direction, color banding, cartoonish rendering, 3D CGI look, unrealistic materials, uncanny valley effect, incorrect ethnicity, wrong gender, exaggerated expressions, smiling, laughing, exaggerated sadness, wrong gaze direction, eyes looking at camera, mismatched lip sync, silent or muted audio, distorted voice, robotic voice, echo, background noise, off-sync audio, missing sniff sounds, incorrect dialogue, added dialogue, repetitive speech, jittery movement, awkward pauses, incorrect timing, unnatural transitions, inconsistent framing, tilted camera, missing door or shelves, missing shallow depth of field, flat lighting, inconsistent tone, cinematic oversaturation, stylized filters, or AI artifacts.';

// The distilled model's 8-step schedule (ManualSigmas in the template).
export const LTX_DISTILLED_SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';

export const LTX_DEFAULT_GUIDE_STRENGTH = 0.7;

// Context windows for a clip longer than the model's native length
// (LTXVContextWindows defaults; 145 frames ≈ 6 s at 24 fps, 40 overlap).
export const LTX_CONTEXT_WINDOW = Object.freeze({ length: 145, overlap: 40 });

// LTX renders 8k+1 frames. `seconds × fps` rounded to the nearest such count
// (min 9).
export function ltxFrameCount(seconds, fps) {
  const raw = Math.max(0, Number(seconds) || 0) * Math.max(1, Number(fps) || 24);
  const k = Math.round(raw / LTX_LATENT_FRAME_STEP);
  return Math.max(LTX_LATENT_FRAME_STEP + 1, k * LTX_LATENT_FRAME_STEP + 1);
}

// A keyframe's frame index: `at_seconds × fps` snapped DOWN to the latent
// grid (a multiple of 8) and kept strictly inside the clip — never the first
// frame (the start guide) nor the last latent slot (the end guide). Returns
// null when the clip has no interior slot.
export function snapGuideFrameIndex(atSeconds, fps, frames) {
  const step = LTX_LATENT_FRAME_STEP;
  const total = Number(frames) || 0;
  const lo = step;
  const hi = total - 1 - step;
  if (hi < lo) return null;
  const raw = Math.max(0, Number(atSeconds) || 0) * Math.max(1, Number(fps) || 24);
  let idx = Math.floor(raw / step) * step;
  if (idx < lo) idx = lo;
  if (idx > hi) idx = hi;
  return idx;
}

// Place keyframes on the grid: `[{ filename, at_seconds, strength }]` →
// `{ guides: [{ filename, frame_idx, strength }], warnings }` in frame order.
// Two keyframes on one slot keep the later one (its picture is the state the
// clip should have reached); a keyframe with no interior slot is dropped.
export function placeKeyframes(keyframes, { fps, frames, defaultStrength = LTX_DEFAULT_GUIDE_STRENGTH } = {}) {
  const warnings = [];
  const bySlot = new Map();
  const list = (Array.isArray(keyframes) ? keyframes : []).filter((k) => k && k.filename);
  const sorted = list.slice().sort((a, b) => Number(a.at_seconds) - Number(b.at_seconds));
  for (const k of sorted) {
    const idx = snapGuideFrameIndex(k.at_seconds, fps, frames);
    if (idx == null) {
      warnings.push(`keyframe at ${k.at_seconds}s dropped: the clip is too short for a keyframe between its frames`);
      continue;
    }
    if (bySlot.has(idx)) {
      warnings.push(`keyframes at ${bySlot.get(idx).at_seconds}s and ${k.at_seconds}s land on the same frame ${idx}; the later one is kept`);
    }
    bySlot.set(idx, k);
  }
  const guides = [...bySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame_idx, k]) => ({
      filename: String(k.filename),
      frame_idx,
      // null / '' = the default; `Number(null)` is 0, so test for presence first.
      strength: k.strength != null && k.strength !== '' && Number.isFinite(Number(k.strength)) ? Number(k.strength) : defaultStrength,
      at_seconds: Number(k.at_seconds),
    }));
  return { guides, warnings };
}

// Build the graph.
//   images:   { start_frame, end_frame } uploaded filenames (end optional) and
//             `keyframes` as placeKeyframes returns them
//   frames:   total frame count (ltxFrameCount)
//   longClip: insert LTXVContextWindows so the clip may exceed the native length
export function buildLtxKeyframeWorkflow({
  prompt,
  negativePrompt = LTX_DEFAULT_NEGATIVE_PROMPT,
  width = 1280,
  height = 720,
  frames = 121,
  fps = 24,
  seed = 0,
  images = {},
  guideStrength = LTX_DEFAULT_GUIDE_STRENGTH,
  longClip = false,
  files = {},
  filenamePrefix = 'video/screenplay/keyframes',
} = {}) {
  if (!String(prompt || '').trim()) throw new Error('prompt required');
  if (!images.start_frame) throw new Error('start_frame image required');
  const f = { ...LTX_DEFAULT_FILES, ...(files || {}) };
  const w = Number(width) || 1280;
  const h = Number(height) || 720;
  const n = Number(frames) || 121;
  const rate = Number(fps) || 24;

  const nodes = {};
  let next = 1;
  const add = (class_type, inputs) => {
    const id = String(next++);
    nodes[id] = { class_type, inputs };
    return id;
  };
  const link = (id, slot = 0) => [id, slot];

  // Loaders.
  const unet = add('UNETLoader', { unet_name: f.unet, weight_dtype: 'default' });
  const videoVae = add('VAELoader', { vae_name: f.videoVae });
  const audioVae = add('VAELoader', { vae_name: f.audioVae });
  const clip = add('CLIPLoader', { clip_name: f.clip, type: 'ltxv', device: 'default' });
  let model = unet;
  if (longClip) {
    model = add('LTXVContextWindows', {
      model: link(unet),
      context_length: LTX_CONTEXT_WINDOW.length,
      context_overlap: LTX_CONTEXT_WINDOW.overlap,
      context_schedule: 'standard_uniform',
      context_stride: 1,
      closed_loop: false,
      fuse_method: 'pyramid',
      freenoise: true,
      retain_first_frame: false,
      split_conds_to_windows: false,
    });
  }

  // Text.
  const pos = add('CLIPTextEncode', { text: String(prompt), clip: link(clip) });
  const neg = add('CLIPTextEncode', { text: String(negativePrompt || ''), clip: link(clip) });
  const cond = add('LTXVConditioning', { positive: link(pos), negative: link(neg), frame_rate: rate });

  // Latents.
  const videoLatent = add('EmptyLTXVLatentVideo', { width: w, height: h, length: n, batch_size: 1 });
  const audioLatent = add('LTXVEmptyLatentAudio', {
    frames_number: n,
    frame_rate: rate,
    batch_size: 1,
    audio_vae: link(audioVae),
  });

  // Guides: start (frame 0), keyframes ascending, end (-1) — the template's
  // order. Each takes positive/negative/latent from the one before.
  const guides = [{ filename: images.start_frame, frame_idx: 0, strength: guideStrength, role: 'start' }];
  for (const k of Array.isArray(images.keyframes) ? images.keyframes : []) {
    guides.push({ filename: k.filename, frame_idx: k.frame_idx, strength: k.strength ?? guideStrength, role: 'keyframe' });
  }
  if (images.end_frame) guides.push({ filename: images.end_frame, frame_idx: -1, strength: guideStrength, role: 'end' });

  let positive = link(cond, 0);
  let negative = link(cond, 1);
  let latent = link(videoLatent);
  const guideNodeIds = [];
  for (const g of guides) {
    const load = add('LoadImage', { image: String(g.filename) });
    const resized = add('ImageScale', { image: link(load), upscale_method: 'nearest-exact', width: w, height: h, crop: 'center' });
    const pre = add('LTXVPreprocess', { image: link(resized), img_compression: 18 });
    const guide = add('LTXVAddGuide', {
      positive,
      negative,
      vae: link(videoVae),
      latent,
      image: link(pre),
      frame_idx: g.frame_idx,
      strength: g.strength,
    });
    positive = link(guide, 0);
    negative = link(guide, 1);
    latent = link(guide, 2);
    guideNodeIds.push(guide);
  }

  // Sampling.
  const av = add('LTXVConcatAVLatent', { video_latent: latent, audio_latent: link(audioLatent) });
  const noise = add('RandomNoise', { noise_seed: Number(seed) || 0 });
  const guider = add('LTXVDualCFGGuider', { model: link(model), positive, negative, video_cfg: 1, audio_cfg: 1 });
  const sampler = add('SamplerEulerAncestral', { eta: 0, s_noise: 1 });
  const sigmas = add('ManualSigmas', { sigmas: LTX_DISTILLED_SIGMAS });
  const sampled = add('SamplerCustomAdvanced', {
    noise: link(noise),
    guider: link(guider),
    sampler: link(sampler),
    sigmas: link(sigmas),
    latent_image: link(av),
  });

  // Decode.
  const separated = add('LTXVSeparateAVLatent', { av_latent: link(sampled, 0) });
  const cropped = add('LTXVCropGuides', { positive, negative, latent: link(separated, 0) });
  const decoded = add('VAEDecodeTiled', {
    samples: link(cropped, 2),
    vae: link(videoVae),
    tile_size: 512,
    overlap: 64,
    temporal_size: 64,
    temporal_overlap: 16,
  });
  const audio = add('LTXVAudioVAEDecode', { samples: link(separated, 1), audio_vae: link(audioVae) });
  const video = add('CreateVideo', { images: link(decoded), fps: rate, audio: link(audio) });
  // `format` is a dynamic combo: its chosen option's sub-input `format.codec`
  // must be set too, or the node fails at execution (validate_workflow says so).
  const save = add('SaveVideo', {
    video: link(video),
    filename_prefix: String(filenamePrefix),
    format: 'auto',
    'format.codec': 'auto',
  });

  return {
    workflow: nodes,
    outputNodeId: save,
    guideNodeIds,
    guides: guides.map(({ filename, frame_idx, strength, role }) => ({ filename, frame_idx, strength, role })),
  };
}
