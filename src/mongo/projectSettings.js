// Per-project settings that are plain key/value configuration — not content.
// One doc per project in `project_settings`, keyed by the project_id string
// (`_id: <24-hex>`). Currently holds `model_defaults`: the generation models
// the SPA pre-selects per flow, editable on the About page's Models tab and
// auto-remembered from the image-sheet dialog's selectors.
//
// Absent doc / absent key = no default (each dialog falls back to its own
// heuristics), so no migration or lazy seeding is needed.

import { getDb } from './client.js';

// The six default slots. Image slots store an image-model id (the picker's
// `m.id`); video slots store a fal endpoint_id (the video picker selects rows
// by endpoint).
export const MODEL_DEFAULT_KEYS = Object.freeze([
  'image_with_refs', // image model for plates rendered WITH reference images
  'image_prompt_only', // image model for plates rendered from the prompt alone
  'video_start_only', // image-to-video model for a cut rendered from its start frame
  'video_direct', // reference-to-video model: prompt + reference images, no start frame (the fal dialog's pre-select)
  'lipsync', // lip-sync (avatar) video model
]);

const MAX_MODEL_ID_LENGTH = 300;

function requireProjectId(projectId) {
  if (!projectId) throw new Error('projectId required');
  return String(projectId);
}

function emptyDefaults() {
  const out = {};
  for (const k of MODEL_DEFAULT_KEYS) out[k] = null;
  return out;
}

// Full defaults object with every known key present (null = unset).
export async function getModelDefaults(projectId) {
  const pid = requireProjectId(projectId);
  const db = getDb();
  const doc = await db.collection('project_settings').findOne({ _id: pid });
  const stored = doc?.model_defaults || {};
  const out = emptyDefaults();
  for (const k of MODEL_DEFAULT_KEYS) {
    const v = stored[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

// Merge a partial update into the stored defaults. Unknown keys are rejected
// (a typo'd key would silently never pre-select anything); values must be a
// non-empty string (set) or null/'' (clear). Returns the full merged object.
export async function setModelDefaults(projectId, patch = {}) {
  const pid = requireProjectId(projectId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch must be an object');
  }
  const changes = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!MODEL_DEFAULT_KEYS.includes(key)) {
      throw new Error(`unknown model default: ${key}`);
    }
    if (raw == null || raw === '') {
      changes[key] = null;
      continue;
    }
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_MODEL_ID_LENGTH) {
      throw new Error(`invalid model id for ${key}`);
    }
    changes[key] = raw.trim();
  }
  if (Object.keys(changes).length) {
    // Read-merge-write of the whole object (no dotted paths): last write wins,
    // which is fine for a small settings blob and keeps upsert semantics
    // identical between real Mongo and the tests' fake.
    const current = await getModelDefaults(pid);
    const db = getDb();
    await db.collection('project_settings').updateOne(
      { _id: pid },
      { $set: { model_defaults: { ...current, ...changes } } },
      { upsert: true },
    );
  }
  return getModelDefaults(pid);
}

// ── ComfyUI video defaults ───────────────────────────────────────────────────
//
// The Scenes tab's ComfyUI dialog remembers the last model the project
// rendered with and the parameters used per model, under `comfy_video`
// (separate from `model_defaults`, whose keys are fal endpoint ids):
//   { model_id: string|null, params_by_model: { [model_id]: { ...params } } }

const MAX_COMFY_PARAM_KEYS = 64;
// Never remembered: they belong to ONE render. A saved length used to
// override every cut's own (every clip of a beat came out the same length),
// and a saved seed made every cut share one.
export const PER_RENDER_COMFY_PARAM_KEYS = Object.freeze(['duration_seconds', 'seed', 'prompt']);
const MAX_COMFY_PARAM_STRING = 20_000;

function emptyComfyDefaults() {
  return { model_id: null, params_by_model: {} };
}

function sanitizeComfyParams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('params must be an object');
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k.trim() || k.length > 64) continue;
    if (PER_RENDER_COMFY_PARAM_KEYS.includes(k)) continue;
    if (v === undefined) continue;
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      throw new Error(`param ${k} must be a string, number, boolean or null`);
    }
    if (typeof v === 'string' && v.length > MAX_COMFY_PARAM_STRING) {
      throw new Error(`param ${k} is too long`);
    }
    out[k] = v;
    if (++n >= MAX_COMFY_PARAM_KEYS) break;
  }
  return out;
}

export async function getComfyDefaults(projectId) {
  const pid = requireProjectId(projectId);
  const db = getDb();
  const doc = await db.collection('project_settings').findOne({ _id: pid });
  const stored = doc?.comfy_video && typeof doc.comfy_video === 'object' ? doc.comfy_video : {};
  const out = emptyComfyDefaults();
  if (typeof stored.model_id === 'string' && stored.model_id.trim()) out.model_id = stored.model_id.trim();
  if (stored.params_by_model && typeof stored.params_by_model === 'object' && !Array.isArray(stored.params_by_model)) {
    for (const [k, v] of Object.entries(stored.params_by_model)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      // Stripped on read too: docs written before the keys were dropped.
      const params = { ...v };
      for (const key of PER_RENDER_COMFY_PARAM_KEYS) delete params[key];
      out.params_by_model[k] = params;
    }
  }
  return out;
}

// Merge { model_id?, params_by_model? } into the stored defaults. model_id
// null/'' clears; params_by_model entries are merged per model (null removes
// that model's entry). Returns the full merged object.
export async function setComfyDefaults(projectId, patch = {}) {
  const pid = requireProjectId(projectId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch must be an object');
  }
  const current = await getComfyDefaults(pid);
  const next = { model_id: current.model_id, params_by_model: { ...current.params_by_model } };
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'model_id')) {
    const raw = patch.model_id;
    if (raw == null || raw === '') {
      next.model_id = null;
    } else if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_MODEL_ID_LENGTH) {
      throw new Error('invalid comfy model id');
    } else {
      next.model_id = raw.trim();
    }
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'params_by_model')) {
    const pbm = patch.params_by_model;
    if (!pbm || typeof pbm !== 'object' || Array.isArray(pbm)) throw new Error('params_by_model must be an object');
    for (const [modelId, params] of Object.entries(pbm)) {
      if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > MAX_MODEL_ID_LENGTH) {
        throw new Error('invalid comfy model id in params_by_model');
      }
      if (params == null) {
        delete next.params_by_model[modelId];
      } else {
        next.params_by_model[modelId] = sanitizeComfyParams(params);
      }
      changed = true;
    }
  }
  if (changed) {
    const db = getDb();
    await db.collection('project_settings').updateOne(
      { _id: pid },
      { $set: { comfy_video: next } },
      { upsert: true },
    );
  }
  return getComfyDefaults(pid);
}
