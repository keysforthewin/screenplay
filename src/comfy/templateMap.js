// Propose a registry entry (src/comfy/videoModels.js shape) for a gallery
// template from what comfy-mcp reports about it: `get_template` info (io
// inputs/outputs, tags, local_check) and `list_workflow_slots` (every
// widget address with its node type, value type and current value). No
// template JSON is parsed. Pure: no I/O, no ComfyUI.
//
// Every mapping is a heuristic the Admin page shows for confirmation, so the
// proposal carries no confidence tags — just warnings for what it could not
// place. "Top-level" means an instance_id without '/', i.e. a widget the
// template exposes on the canvas rather than one buried in a subgraph
// (subgraph-promoted widgets report the subgraph UUID as node_type, e.g. the
// LTX prompt at `340.value`, so nothing here requires a CLIPTextEncode).

import { CANONICAL_PARAM_ORDER, INPUT_NEEDS } from './videoModels.js';

const NEGATIVE_RE = /\b(ugly|blurry|worst quality|low quality|watermark|cartoon|deformed|lowres|jpeg artifacts)\b/i;
const FPS_VALUES = new Set([12, 15, 16, 24, 25, 30, 48, 50, 60]);
const SIZE_VALUES = new Set([256, 320, 384, 448, 480, 512, 576, 640, 704, 720, 768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344, 1408, 1472, 1536, 1920, 2048]);

const isTop = (s) => !String(s.instance_id || '').includes('/');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lower = (v) => String(v || '').toLowerCase();
const seedSpec = (address) => ({ address, type: 'int', default: null, min: 0, max: 2 ** 53 - 1, help: 'Blank = random per render.' });

function nameOf(s) {
  return lower(s.name || String(s.address).split('.').pop());
}

// Normalize a search_templates row into what the Admin list shows.
export function summarizeGalleryRow(row) {
  const name = String(row?.name || row?.id || '').trim();
  const tags = Array.isArray(row?.tags) ? row.tags.map(lower) : [];
  const api = tags.includes('api') || row?.is_api === true || row?.api === true || /(^|_)api(_|$)/.test(lower(name));
  const localCheck = row?.local_check && typeof row.local_check === 'object' ? row.local_check : null;
  return {
    name,
    title: String(row?.title || row?.display_name || name).trim(),
    description: String(row?.description || row?.tutorial_description || '').trim(),
    tags,
    api,
    media_type: row?.mediaType || row?.media_type || null,
    local_check: localCheck,
    runnable: localCheck && localCheck.checked ? localCheck.runnable !== false : null,
  };
}

export function autoMapTemplate({ name, info = null, slots = [], api = false } = {}) {
  const warnings = [];
  const list = (Array.isArray(slots) ? slots : []).filter((s) => s && s.address);
  const byAddress = new Map(list.map((s) => [s.address, s]));
  const claimed = new Set();
  const claim = (s) => {
    if (!s) return null;
    claimed.add(s.address);
    return s.address;
  };
  const free = (s) => s && !claimed.has(s.address);

  // ── media inputs ─────────────────────────────────────────────────────────
  const ioInputs = Array.isArray(info?.io?.inputs) ? info.io.inputs : [];
  const ioOrder = new Map(ioInputs.map((i, idx) => [String(i.nodeId ?? i.node_id ?? i.id ?? ''), idx]));
  const loadImages = list
    .filter((s) => s.node_type === 'LoadImage' && nameOf(s) === 'image')
    .sort((a, b) => (ioOrder.get(String(a.instance_id)) ?? 999) - (ioOrder.get(String(b.instance_id)) ?? 999) || String(a.instance_id).localeCompare(String(b.instance_id), undefined, { numeric: true }));
  const loadAudios = list.filter((s) => s.node_type === 'LoadAudio' && nameOf(s) === 'audio');
  const imageSlots = [];
  // First-last-frame templates (FLF2V): one start and one end image; the
  // template's sample file names ("…_start_image.png", "…_end_image.png")
  // say which is which. Any further LoadImage is left unmapped — in the
  // gallery's FLF templates those belong to a bypassed alternative pipeline.
  const tags = (Array.isArray(info?.tags) ? info.tags : []).map((t) => lower(t));
  const flf = tags.includes('flf2v') || /flf|first[_-]?last/i.test(String(name || ''));
  if (flf && loadImages.length >= 2) {
    const valueOf = (s) => lower(s.current_value || '');
    const start = loadImages.find((s) => /start|first/.test(valueOf(s))) || loadImages[0];
    const end = loadImages.find((s) => s !== start && /end|last/.test(valueOf(s))) || loadImages.find((s) => s !== start);
    imageSlots.push({ address: claim(start), role: 'start_frame' });
    imageSlots.push({ address: claim(end), role: 'end_frame' });
    const extra = loadImages.length - 2;
    if (extra) warnings.push(`${extra} further LoadImage node(s) left unmapped (first-last-frame template) — check they are bypassed`);
  } else if (loadImages.length) {
    imageSlots.push({ address: claim(loadImages[0]), role: 'start_frame' });
    for (const s of loadImages.slice(1)) imageSlots.push({ address: claim(s), role: 'reference' });
  } else {
    warnings.push('no LoadImage node — the template takes no start frame or reference images');
  }
  const audioSlots = loadAudios.map((s) => ({ address: claim(s), role: 'dialogue' }));
  const referenceCount = imageSlots.filter((s) => s.role === 'reference').length;

  // ── output ───────────────────────────────────────────────────────────────
  const ioOutputs = Array.isArray(info?.io?.outputs) ? info.io.outputs : [];
  const outNodeId = String(ioOutputs[0]?.nodeId ?? ioOutputs[0]?.node_id ?? '');
  let saveNode = null;
  if (outNodeId) saveNode = list.find((s) => String(s.instance_id) === outNodeId && nameOf(s) === 'filename_prefix') || null;
  if (!saveNode) saveNode = list.find((s) => /^Save(Video|AnimatedWEBP|WEBM)/.test(String(s.node_type || '')) && nameOf(s) === 'filename_prefix') || null;
  if (!saveNode) saveNode = list.find((s) => nameOf(s) === 'filename_prefix') || null;
  const output = saveNode
    ? {
        filenamePrefix: claim(saveNode),
        format: (() => {
          const f = byAddress.get(`${saveNode.instance_id}.format`);
          return f ? claim(f) : null;
        })(),
      }
    : null;
  if (!output) warnings.push('no SaveVideo filename_prefix found — outputs cannot be located after a run');

  // ── text params ──────────────────────────────────────────────────────────
  const strings = list.filter((s) => s.type === 'STRING' && free(s));
  const negative = strings.find((s) => NEGATIVE_RE.test(String(s.current_value || ''))) || null;
  if (negative) claim(negative);
  const promptCandidates = strings
    .filter((s) => free(s) && s !== negative && !/filename|prefix|path|url|api_key|token/i.test(nameOf(s)))
    .map((s) => ({ s, len: String(s.current_value || '').length, top: isTop(s) }))
    .sort((a, b) => Number(b.top) - Number(a.top) || b.len - a.len);
  const prompt = promptCandidates[0]?.s || null;
  if (prompt) claim(prompt);
  else warnings.push('no STRING slot looks like the prompt');

  // ── numbers ──────────────────────────────────────────────────────────────
  const top = list.filter((s) => isTop(s) && free(s));
  const named = (re, pool = top) => pool.find((s) => re.test(nameOf(s)) && free(s)) || null;
  const params = {};
  if (prompt) params.prompt = { address: prompt.address, type: 'string', default: '' };
  if (negative) params.negative_prompt = { address: negative.address, type: 'string', default: String(negative.current_value || '') };

  const seed = named(/^(noise_)?seed$/);
  if (seed) params.seed = seedSpec(claim(seed));

  let fps = named(/^(fps|frame_rate|framerate)$/);
  if (!fps) fps = top.find((s) => s.type === 'INT' && /^value(_\d+)?$/.test(nameOf(s)) && FPS_VALUES.has(num(s.current_value)) && free(s)) || null;
  if (fps) params.fps = { address: claim(fps), type: 'int', default: num(fps.current_value) ?? 24, min: 1, max: 60, step: 1 };

  // Top-level first: a subgraph's own `duration` (e.g. LTX's TrimAudioDuration
  // at 340/332.duration) is plumbing the template exposes elsewhere.
  const DURATION_RE = /^(duration|duration_seconds|length_seconds|seconds)$/;
  let duration = named(DURATION_RE);
  if (!duration) {
    duration = top.find((s) => (s.type === 'FLOAT' || s.type === 'INT') && /^value(_\d+)?$/.test(nameOf(s)) && free(s) && num(s.current_value) != null && num(s.current_value) >= 1 && num(s.current_value) <= 30 && !SIZE_VALUES.has(num(s.current_value))) || null;
  }
  if (!duration) duration = named(DURATION_RE, list.filter(free));
  if (duration) {
    params.duration_seconds = { address: claim(duration), type: duration.type === 'INT' ? 'int' : 'float', default: num(duration.current_value) ?? 5, min: 1, max: 60, step: duration.type === 'INT' ? 1 : 0.5 };
  } else {
    warnings.push('no duration slot found — add one (a top-level number in seconds) before saving');
  }

  let width = named(/^width$/);
  let height = named(/^height$/);
  if (!width || !height) {
    const sizes = top.filter((s) => s.type === 'INT' && /^value(_\d+)?$/.test(nameOf(s)) && SIZE_VALUES.has(num(s.current_value)) && free(s));
    if (sizes.length >= 2) {
      [width, height] = sizes;
    }
  }
  if (width && height) {
    params.width = { address: claim(width), type: 'int', default: num(width.current_value) ?? 1280, min: 256, max: 2048, step: 16 };
    params.height = { address: claim(height), type: 'int', default: num(height.current_value) ?? 720, min: 256, max: 2048, step: 16 };
  }
  const aspect = list.find((s) => s.node_type === 'ResolutionSelector' && /aspect/i.test(nameOf(s)) && free(s)) || named(/^aspect(_ratio)?$/, list.filter(free));
  if (aspect) params.aspect_ratio = { address: claim(aspect), type: 'enum', default: aspect.current_value ?? null, options: Array.isArray(aspect.enum) ? aspect.enum : [] };
  const mega = list.find((s) => s.node_type === 'ResolutionSelector' && /megapixel/i.test(nameOf(s)) && free(s)) || named(/^megapixels?$/, list.filter(free));
  if (mega) params.megapixels = { address: claim(mega), type: 'float', default: num(mega.current_value) ?? 1, min: 0.1, max: 4, step: 0.1 };
  const steps = named(/^steps$/, list.filter(free));
  if (steps) params.steps = { address: claim(steps), type: 'int', default: num(steps.current_value) ?? 20, min: 1, max: 100, step: 1 };
  const cfg = named(/^(cfg|guidance|guidance_scale)$/, list.filter(free));
  if (cfg) params.cfg = { address: claim(cfg), type: 'float', default: num(cfg.current_value) ?? 5, min: 0, max: 30, step: 0.1 };
  const enhance = top.find((s) => s.type === 'BOOLEAN' && free(s)) || null;
  if (enhance) params.prompt_enhance = { address: claim(enhance), type: 'bool', default: false, help: 'Off: our prompts are already compiled.' };

  for (const k of Object.keys(params)) {
    if (!CANONICAL_PARAM_ORDER.includes(k)) delete params[k];
  }

  const id = lower(name).replace(/^video_/, '').replace(/_/g, '-').replace(/[^a-z0-9.-]/g, '').replace(/^-+|-+$/g, '') || 'template';
  const proposal = {
    id,
    label: String(info?.title || info?.display_name || name).trim(),
    family: null,
    lab: null,
    template: name,
    kind: api ? 'api' : 'local',
    spends_credits: !!api,
    available: true,
    verified: false,
    description: String(info?.description || info?.tutorial_description || '').trim(),
    inputs: {
      startFrame: imageSlots.length ? INPUT_NEEDS.REQUIRED : INPUT_NEEDS.UNUSED,
      endFrame: imageSlots.some((s) => s.role === 'end_frame') ? INPUT_NEEDS.REQUIRED : INPUT_NEEDS.UNUSED,
      referenceImages: referenceCount ? INPUT_NEEDS.OPTIONAL : INPUT_NEEDS.UNUSED,
      audio: audioSlots.length ? INPUT_NEEDS.REQUIRED : INPUT_NEEDS.UNUSED,
    },
    imageSlots,
    audioSlots,
    maxReferenceImages: referenceCount,
    params,
    output,
    fixed: [],
    constraints: {},
    notes: `Registered from the gallery template ${name}; mappings proposed by the auto-mapper and confirmed by hand.`,
  };
  return { proposal, warnings };
}
