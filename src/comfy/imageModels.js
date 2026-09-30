// ComfyUI IMAGE model registry — the still-image twin of videoModels.js, for
// start frames rendered on the local GPU from a cut's reference artwork.
//
// Unlike the video registry this one is mostly DISCOVERED: a scan walks the
// gallery's local image templates (`search_templates` → `get_template` with
// its local_check, which also verifies the model files are installed), keeps
// the ones that take reference images, and auto-maps each runnable one from
// its slot listing and graph (imageWorkflow.js). The result is cached on disk
// next to the fetched templates, so a restart does not rescan (~1 min for
// ~150 templates). Curated entries below win over a discovered mapping of
// the same template — they carry what a slot listing cannot say (which
// switch turns on the custom canvas, how the model names its references).
//
// An image model id on the wire is `comfy:<id>`; stillImageDispatch routes
// those here, so every still-image entry point accepts them.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import { comfy } from './client.js';
import { templateFilePath } from './templates.js';
import { analyzeImageWorkflow } from './imageWorkflow.js';

export const COMFY_IMAGE_PREFIX = 'comfy:';

export function isComfyImageModelId(id) {
  return typeof id === 'string' && id.startsWith(COMFY_IMAGE_PREFIX);
}

export function comfyImageModelKey(id) {
  return isComfyImageModelId(id) ? id.slice(COMFY_IMAGE_PREFIX.length) : String(id || '');
}

export const IMAGE_PARAM_ORDER = Object.freeze(['width', 'height', 'megapixels', 'steps', 'cfg', 'seed', 'negative_prompt']);

const IMAGE_PARAM_LABELS = Object.freeze({
  width: 'Width',
  height: 'Height',
  megapixels: 'Megapixels',
  steps: 'Steps',
  cfg: 'CFG',
  seed: 'Seed',
  negative_prompt: 'Negative prompt',
});

const SEED_SPEC = Object.freeze({ type: 'int', default: null, min: 0, max: 2 ** 48, help: 'Blank = random per render.' });

// Hand-mapped entries. Addresses read off the fetched template 2026-09-30.
export const CURATED_COMFY_IMAGE_MODELS = [
  {
    id: 'qwen-image-2.1-edit',
    label: 'Qwen Image 2.1 Edit',
    family: 'Qwen Image 2.1',
    lab: 'Alibaba',
    template: 'image_qwen_image_2_1_image_edit',
    verified: true,
    description:
      'Local Qwen Image 2.1 (int8): up to 10 reference images on a 16:9 canvas, or an in-place edit of the current frame. It is an edit model and copies the composition of its references — a new camera angle comes back as the set artwork (or the character sheet) again. Good for edits and cuts framed like their artwork; use a hosted model (Nano Banana Pro) for new angles.',
    referenceToken: '<image{n}>',
    params: {
      prompt: { address: '459.prompt', type: 'string', default: '' },
      negative_prompt: { address: '459.negative_prompt', type: 'string', default: '', help: 'Unused while CFG is 1.' },
      width: { address: '459.width', type: 'int', default: 1664, min: 512, max: 2048, step: 32, multiple: 32, help: '16:9: 1344×768, 1664×928, 1920×1088.' },
      height: { address: '459.height', type: 'int', default: 928, min: 512, max: 2048, step: 32, multiple: 32 },
      steps: { address: '459.steps', type: 'int', default: 25, min: 4, max: 60, step: 1, help: 'Template default 25; the official pipeline uses 40–50.' },
      cfg: { address: '459.cfg', type: 'float', default: 1, min: 1, max: 10, step: 0.5 },
      seed: { address: '459.seed', ...SEED_SPEC },
    },
    // generate: custom_size on → the canvas is width×height, the references
    // only condition. edit: custom_size off → the canvas follows image 1 (the
    // frame being edited). `resolution` is the references' pixel budget.
    // The prompt enhancer (459.switch_1 + its reasoning pass) stays pinned off:
    // measured 2026-09-30 it took a 50 s render to 14 min on a 16 GB card and
    // pulled the result further toward the first reference.
    modes: {
      generate: {
        fixed: [
          { address: '459.switch', value: true },
          { address: '459.resolution', value: 1024 },
          { address: '459.switch_1', value: false },
          { address: '459.thinking', value: false },
        ],
      },
      edit: {
        fixed: [
          { address: '459.switch', value: false },
          { address: '459.resolution', value: 0 },
          { address: '459.switch_1', value: false },
          { address: '459.thinking', value: false },
        ],
        drop: ['width', 'height'],
      },
    },
    output: { filenamePrefix: '461.filename_prefix' },
    notes: 'Extra references beyond the two the template wires are added as LoadImage nodes on image_3…image_10.',
  },
];

// ─── Discovered models (disk cache) ─────────────────────────────────────────

const state = {
  loaded: false,
  scanned_at: null,
  models: [], // auto-mapped registry entries
  unavailable: [], // [{ template, label, description, max_reference_images, reason }]
};

function cacheFile() {
  return path.resolve(path.dirname(path.resolve(config.comfy.templateDir)), 'image-models.json');
}

function loadCache() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    state.scanned_at = raw.scanned_at || null;
    state.models = Array.isArray(raw.models) ? raw.models : [];
    state.unavailable = Array.isArray(raw.unavailable) ? raw.unavailable : [];
  } catch {
    // never scanned
  }
}

export function _setComfyImageCatalogForTests({ models = [], unavailable = [], scanned_at = null } = {}) {
  state.loaded = true;
  state.models = models;
  state.unavailable = unavailable;
  state.scanned_at = scanned_at;
}

function curatedWithCaps() {
  // A curated entry's reference cap comes from the scan (the graph says how
  // many inputs there are); before the first scan fall back to its template's
  // wired count as mapped by hand.
  return CURATED_COMFY_IMAGE_MODELS.map((m) => {
    const found = state.models.find((d) => d.template === m.template);
    return { ...m, kind: 'local', maxReferenceImages: found?.maxReferenceImages ?? m.maxReferenceImages ?? 10 };
  });
}

export function listComfyImageModels() {
  loadCache();
  const curated = curatedWithCaps();
  const taken = new Set(curated.map((m) => m.template));
  return [...curated, ...state.models.filter((m) => !taken.has(m.template))];
}

export function getComfyImageModel(id) {
  const key = comfyImageModelKey(id);
  return listComfyImageModels().find((m) => m.id === key) || null;
}

// A curated model is only offered once a scan has seen its template run here.
function isInstalled(model) {
  if (!state.scanned_at) return null; // unknown until the first scan
  return state.models.some((d) => d.template === model.template);
}

export function describeComfyImageModel(m) {
  if (!m) return null;
  const params = {};
  for (const key of IMAGE_PARAM_ORDER) {
    if (!m.params?.[key]) continue;
    const { address, ...spec } = m.params[key];
    params[key] = { ...spec, label: IMAGE_PARAM_LABELS[key] || key };
  }
  return {
    id: `${COMFY_IMAGE_PREFIX}${m.id}`,
    label: m.label,
    family: m.family || null,
    lab: m.lab || null,
    template: m.template,
    description: m.description || '',
    verified: !!m.verified,
    installed: isInstalled(m),
    max_reference_images: m.maxReferenceImages || 0,
    size_follows_reference: !m.params?.width && !m.params?.megapixels,
    supports_edit: true,
    params,
    notes: m.notes || '',
  };
}

export function comfyImageCatalog() {
  loadCache();
  return {
    scanned_at: state.scanned_at,
    models: listComfyImageModels().map(describeComfyImageModel),
    unavailable: state.unavailable,
  };
}

// ─── Auto-mapping ───────────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nameOf = (s) => String(s?.name || String(s?.address || '').split('.').pop()).toLowerCase();
const topId = (s) => String(s?.instance_id ?? '').split('/')[0];

// Propose a registry entry from a runnable template's slot listing and graph.
// Returns null when the template has no reference input, prompt or save node.
export function autoMapImageTemplate({ name, info = null, slots = [], workflow = null } = {}) {
  const plan = analyzeImageWorkflow(workflow);
  if (!plan.maxReferenceImages || plan.outputNodeId === null) return null;
  const list = (Array.isArray(slots) ? slots : []).filter((s) => s?.address);
  const top = list.filter((s) => !String(s.instance_id ?? '').includes('/'));
  // Prefer widgets on the node the references feed (a template can hold two
  // pipelines); fall back to any top-level widget.
  const onConsumer = top.filter((s) => topId(s) === String(plan.consumerId));
  const pick = (test) => onConsumer.find(test) || top.find(test) || null;

  const isString = (s) => s.type === 'STRING';
  const negative = pick((s) => isString(s) && /negative/.test(nameOf(s)));
  const prompt =
    pick((s) => isString(s) && /^(prompt|positive(_prompt)?)$/.test(nameOf(s))) ||
    pick((s) => isString(s) && /^text(_\d+)?$/.test(nameOf(s))) ||
    pick((s) => isString(s) && s !== negative && !/filename|prefix|path|url|negative/.test(nameOf(s)) && String(s.current_value || '').length > 0);
  if (!prompt) return null;
  const prefix = list.find((s) => String(s.instance_id) === String(plan.outputNodeId) && nameOf(s) === 'filename_prefix');
  if (!prefix) return null;

  const params = { prompt: { address: prompt.address, type: 'string', default: '' } };
  if (negative) params.negative_prompt = { address: negative.address, type: 'string', default: String(negative.current_value || '') };
  const width = pick((s) => nameOf(s) === 'width' && !s.linked_from);
  const height = pick((s) => nameOf(s) === 'height' && !s.linked_from);
  if (width && height) {
    params.width = { address: width.address, type: 'int', default: num(width.current_value) ?? 1344, min: 256, max: 2048, step: 16 };
    params.height = { address: height.address, type: 'int', default: num(height.current_value) ?? 768, min: 256, max: 2048, step: 16 };
  }
  const anywhere = (test) => pick(test) || list.find((s) => topId(s) === String(plan.consumerId) && test(s)) || null;
  const steps = anywhere((s) => nameOf(s) === 'steps' && !s.linked_from);
  if (steps) params.steps = { address: steps.address, type: 'int', default: num(steps.current_value) ?? 20, min: 1, max: 100, step: 1 };
  const cfg = anywhere((s) => /^(cfg|guidance)$/.test(nameOf(s)) && !s.linked_from);
  if (cfg) params.cfg = { address: cfg.address, type: 'float', default: num(cfg.current_value) ?? 1, min: 0, max: 30, step: 0.5 };
  const seed = pick((s) => /^(noise_)?seed(_\d+)?$/.test(nameOf(s)));
  if (seed) params.seed = { address: seed.address, ...SEED_SPEC };

  const id = String(name).toLowerCase().replace(/^image[_-]/, '').replace(/_/g, '-').replace(/[^a-z0-9.-]/g, '').replace(/^-+|-+$/g, '') || 'template';
  return {
    id,
    label: String(info?.title || name).trim(),
    family: Array.isArray(info?.models) && info.models.length ? String(info.models[info.models.length - 1]) : null,
    lab: null,
    template: name,
    kind: 'local',
    verified: false,
    description: String(info?.description || '').trim(),
    maxReferenceImages: plan.maxReferenceImages,
    params,
    output: { filenamePrefix: prefix.address },
    notes: params.width ? '' : 'No canvas-size slot: the output follows the first reference image.',
  };
}

// ─── Scan ───────────────────────────────────────────────────────────────────

const GENERATIVE_TAGS = new Set(['image edit', 'text to image', 'style reference']);
const SKIP_CATEGORIES = new Set(['node basics', 'image tools']);
const SCAN_CONCURRENCY = 4;

const scan = { running: false, progress: null, error: null, started_at: null, finished_at: null };

export function comfyImageScanState() {
  return { ...scan };
}

function isCandidate(row) {
  const tags = (Array.isArray(row?.tags) ? row.tags : []).map((t) => String(t).toLowerCase());
  if (SKIP_CATEGORIES.has(String(row?.category_title || '').toLowerCase())) return false;
  return tags.some((t) => GENERATIVE_TAGS.has(t));
}

function shortReason(localCheck) {
  if (!localCheck?.checked) return 'Could not be checked against this ComfyUI.';
  const first = Array.isArray(localCheck.errors) ? String(localCheck.errors[0] || '') : '';
  const missing = first.match(/'([^']+)' not in \d+ known options for (\w+)/);
  if (missing) return `Model file not installed: ${missing[1]}${localCheck.error_count > 1 ? ` (+${localCheck.error_count - 1} more)` : ''}`;
  return first.replace(/\s*\(this install has:.*$/s, '').slice(0, 240) || 'Not runnable on this ComfyUI.';
}

async function runScan() {
  const listing = await comfy.searchTemplates('', { type: 'image', exclude_api: true, limit: 200 });
  const rows = (Array.isArray(listing?.rows) ? listing.rows : []).filter(isCandidate);
  const models = [];
  const unavailable = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        const got = await comfy.getTemplate(row.name);
        const info = got?.template || row;
        const check = got?.local_check || null;
        const wired = (info?.io?.inputs || []).filter((i) => i?.nodeType === 'LoadImage').length;
        if (wired) {
          if (check?.checked && check.runnable) {
            const filePath = templateFilePath(row.name);
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            if (!fs.existsSync(filePath)) await comfy.fetchTemplate(row.name, filePath);
            const workflow = JSON.parse(await fsp.readFile(filePath, 'utf8'));
            const slots = await comfy.listWorkflowSlots(filePath);
            const entry = autoMapImageTemplate({ name: row.name, info, slots: slots?.slots || slots, workflow });
            if (entry) models.push(entry);
          } else {
            unavailable.push({
              template: row.name,
              label: String(info?.title || row.title || row.name),
              description: String(info?.description || row.description || ''),
              max_reference_images: wired,
              reason: shortReason(check),
            });
          }
        }
      } catch (e) {
        logger.warn(`comfy image scan: ${row.name} failed: ${e?.message || e}`);
      }
      done += 1;
      scan.progress = `Checked ${done} of ${rows.length} templates`;
    }
  };
  scan.progress = `Checked 0 of ${rows.length} templates`;
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));
  state.loaded = true;
  state.models = models.sort(byLabel);
  state.unavailable = unavailable.sort(byLabel);
  state.scanned_at = new Date().toISOString();
  try {
    await fsp.mkdir(path.dirname(cacheFile()), { recursive: true });
    await fsp.writeFile(cacheFile(), JSON.stringify({ scanned_at: state.scanned_at, models: state.models, unavailable: state.unavailable }, null, 2));
  } catch (e) {
    logger.warn(`comfy image scan: cache write failed: ${e?.message || e}`);
  }
  logger.info(`comfy image scan: ${models.length} runnable, ${unavailable.length} not installed (of ${rows.length} candidates)`);
}

// Kick off a background scan (no-op while one runs). Returns the scan state.
export function startComfyImageScan() {
  if (scan.running) return comfyImageScanState();
  Object.assign(scan, { running: true, progress: 'Listing the template gallery…', error: null, started_at: new Date().toISOString(), finished_at: null });
  runScan()
    .catch((e) => {
      scan.error = e?.message || String(e);
      logger.warn(`comfy image scan failed: ${scan.error}`);
    })
    .finally(() => {
      scan.running = false;
      scan.finished_at = new Date().toISOString();
    });
  return comfyImageScanState();
}

export async function _runComfyImageScanForTests() {
  await runScan();
}
