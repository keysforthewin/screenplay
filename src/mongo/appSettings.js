// Process-wide (not per-project) settings that are plain configuration.
// One doc per settings key in `app_settings`:
//   { _id: 'models', slots: { agent: 'claude-…', writer: null,
//                             dialog: { provider: 'claude-code', model: 'opus', effort: 'high' }, … },
//     updated_at, updated_by }             — Admin → Models (src/llm/modelSlots.js)
//   { _id: 'comfy_models', models: [registry entry…], updated_at, updated_by }
//                                          — Admin → ComfyUI templates
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
