// Process-wide (not per-project) settings that are plain configuration.
// One doc per settings key in `app_settings`:
//   { _id: 'models', slots: { agent: 'claude-…', writer: null,
//                             dialog: { provider: 'claude-code', model: 'opus', effort: 'high' }, … },
//     updated_at, updated_by }             — Admin → Models (src/llm/modelSlots.js)
//   { _id: 'comfy_models', models: [registry entry…], updated_at, updated_by }
//                                          — Admin → ComfyUI templates
//   { _id: 'video_default', provider: 'comfy'|'fal', model_id, params, updated_at, updated_by }
//                                          — Admin → Video renderer (src/web/videoDefault.js)
// Absent doc / null slot = use the env default.

import { getDb } from './client.js';
import { config } from '../config.js';
import {
  MODEL_SLOT_KEYS,
  isValidModelId,
  isValidOverride,
  normalizeHarnessTarget,
  setModelOverrides,
} from '../llm/modelSlots.js';
import { registerComfyVideoModels } from '../comfy/videoModels.js';

const COL = 'app_settings';
const MODELS_ID = 'models';
const COMFY_MODELS_ID = 'comfy_models';
const VIDEO_DEFAULT_ID = 'video_default';
export const VIDEO_DEFAULT_PROVIDERS = Object.freeze(['comfy', 'fal']);
const MAX_VIDEO_MODEL_ID = 300;

function emptySlots() {
  const out = {};
  for (const k of MODEL_SLOT_KEYS) out[k] = null;
  return out;
}

function normalizeSlots(stored = {}) {
  const out = emptySlots();
  for (const k of MODEL_SLOT_KEYS) {
    const v = stored?.[k];
    if (isValidModelId(v)) out[k] = v;
    else if (isValidOverride(v)) out[k] = normalizeHarnessTarget(v);
  }
  return out;
}

// Stored overrides with every slot present (null = unset).
export async function getModelSettings() {
  const doc = await getDb().collection(COL).findOne({ _id: MODELS_ID });
  return {
    slots: normalizeSlots(doc?.slots),
    updated_at: doc?.updated_at || null,
    updated_by: doc?.updated_by || null,
  };
}

// Merge a partial update: `{ writer: 'claude-fable-5-1', dialog: null,
// agent: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' } }`.
// Harness targets are refused unless LLM_HARNESS_ENABLED is set.
// Unknown slots are rejected (a typo'd key would silently never take effect);
// a value must be a plausible model id (set) or null/'' (revert to default).
// Persists, then applies to the in-memory map so the very next Claude call
// uses it. Returns the full merged settings.
export async function setModelSettings(patch = {}, { updatedBy = null } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch must be an object');
  }
  const current = await getModelSettings();
  const next = { ...current.slots };
  for (const [key, raw] of Object.entries(patch)) {
    if (!MODEL_SLOT_KEYS.includes(key)) throw new Error(`unknown model slot: ${key}`);
    if (raw === null || raw === '' || raw === undefined) {
      next[key] = null;
      continue;
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      if (!config.llmHarness.enabled) {
        throw new Error('Coding-agent providers (Claude Code / Codex) are disabled on this server');
      }
      try {
        next[key] = normalizeHarnessTarget(raw);
      } catch (e) {
        throw new Error(`${key}: ${e.message}`);
      }
      continue;
    }
    const v = typeof raw === 'string' ? raw.trim() : raw;
    if (!isValidModelId(v)) throw new Error(`invalid model id for ${key}`);
    next[key] = v;
  }
  const now = new Date();
  await getDb().collection(COL).updateOne(
    { _id: MODELS_ID },
    { $set: { slots: next, updated_at: now, updated_by: updatedBy } },
    { upsert: true },
  );
  setModelOverrides(next);
  return { slots: next, updated_at: now, updated_by: updatedBy };
}

// Boot-time: pull the stored overrides into src/llm/modelSlots.js. Called from
// src/index.js right after connectMongo(); safe to call again any time.
export async function loadModelOverrides() {
  const { slots } = await getModelSettings();
  setModelOverrides(slots);
  return slots;
}

// ── ComfyUI models registered from the gallery (Admin) ─────────────────────

export async function getComfyModelSettings() {
  const doc = await getDb().collection(COL).findOne({ _id: COMFY_MODELS_ID });
  return {
    models: Array.isArray(doc?.models) ? doc.models : [],
    updated_at: doc?.updated_at || null,
    updated_by: doc?.updated_by || null,
  };
}

// Replace the whole registered list (callers validate entries first with
// validateRegistryEntry) and apply it in-process at once.
export async function setComfyModelSettings(models, { updatedBy = null } = {}) {
  const list = Array.isArray(models) ? models : [];
  const now = new Date();
  await getDb().collection(COL).updateOne(
    { _id: COMFY_MODELS_ID },
    { $set: { models: list, updated_at: now, updated_by: updatedBy } },
    { upsert: true },
  );
  registerComfyVideoModels(list);
  return { models: list, updated_at: now, updated_by: updatedBy };
}

// Boot-time: pull the registered ComfyUI models into the registry. Called
// from src/index.js right after loadModelOverrides().
export async function loadComfyModelOverrides() {
  const { models } = await getComfyModelSettings();
  registerComfyVideoModels(models);
  return models;
}

// ── Default video renderer (Admin → Video renderer) ────────────────────────
// The provider + model every cut video is rendered with when the caller
// names none: the Scenes-tab dialogs preselect it, the REST routes and the
// MCP `render_videos` tool fall back to it. `params` are the ComfyUI
// parameters to render with (ignored for fal). Absent doc = no default.

function emptyVideoDefault() {
  return { provider: null, model_id: null, params: {}, updated_at: null, updated_by: null };
}

export async function getVideoDefaultSettings() {
  const doc = await getDb().collection(COL).findOne({ _id: VIDEO_DEFAULT_ID });
  const out = emptyVideoDefault();
  if (!doc) return out;
  if (VIDEO_DEFAULT_PROVIDERS.includes(doc.provider) && typeof doc.model_id === 'string' && doc.model_id.trim()) {
    out.provider = doc.provider;
    out.model_id = doc.model_id.trim();
    if (doc.params && typeof doc.params === 'object' && !Array.isArray(doc.params)) out.params = { ...doc.params };
  }
  out.updated_at = doc.updated_at || null;
  out.updated_by = doc.updated_by || null;
  return out;
}

// Replace the default: `{ provider: 'comfy', model_id: 'ltx2-5-flf2v', params? }`,
// or `null` / `{ model_id: null }` to clear it. Callers check that the model
// exists for its provider (the registry lives in src/comfy/videoModels.js and
// src/fal/videoModels.js, which this module does not import).
export async function setVideoDefaultSettings(value, { updatedBy = null } = {}) {
  const now = new Date();
  let next;
  if (value == null || value.model_id == null || value.model_id === '') {
    next = { provider: null, model_id: null, params: {} };
  } else {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('value must be an object');
    if (!VIDEO_DEFAULT_PROVIDERS.includes(value.provider)) throw new Error('provider must be "comfy" or "fal"');
    const id = typeof value.model_id === 'string' ? value.model_id.trim() : '';
    if (!id || id.length > MAX_VIDEO_MODEL_ID) throw new Error('invalid model id');
    const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? { ...value.params } : {};
    next = { provider: value.provider, model_id: id, params };
  }
  await getDb().collection(COL).updateOne(
    { _id: VIDEO_DEFAULT_ID },
    { $set: { ...next, updated_at: now, updated_by: updatedBy } },
    { upsert: true },
  );
  return getVideoDefaultSettings();
}
