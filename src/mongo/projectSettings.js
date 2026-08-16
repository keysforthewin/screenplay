// Per-project settings that are plain key/value configuration — not content.
// One doc per project in `project_settings`, keyed by the project_id string
// (`_id: <24-hex>`). Currently holds `model_defaults`: the generation models
// the SPA pre-selects per flow, editable on the About page's Models tab and
// auto-remembered from the image-sheet dialog's selectors.
//
// Absent doc / absent key = no default (each dialog falls back to its own
// heuristics), so no migration or lazy seeding is needed.

import { getDb } from './client.js';

// The five default slots. Image slots store an image-model id (the picker's
// `m.id`); video slots store a fal endpoint_id (the video picker selects rows
// by endpoint).
export const MODEL_DEFAULT_KEYS = Object.freeze([
  'image_with_refs', // image model for plates rendered WITH reference images
  'image_prompt_only', // image model for plates rendered from the prompt alone
  'video_start_end', // video model when the scene provides a start AND end frame
  'video_start_only', // video model when the scene provides only a start frame
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
