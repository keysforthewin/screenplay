// Runtime-selectable Claude models, one slot per feature family.
//
// Every Claude call in the app resolves its model through `modelFor(slot)` at
// CALL time (never captured in a module-level const), so the Admin page's
// Models panel can repoint a feature at a different model without a restart.
// Overrides live in the `app_settings` collection (src/mongo/appSettings.js),
// are loaded into this module's in-memory map at boot, and are re-applied by
// the PUT /api/admin/models handler on every save. A slot with no override
// falls back to its family's env var (ANTHROPIC_AGENT_MODEL, ANTHROPIC_MODEL
// or ANTHROPIC_ENHANCER_MODEL — see src/config.js), so a fresh database
// behaves exactly like the pre-selector build.

import { config } from '../config.js';

// family → which config.anthropic.* value backs the slot when unset.
export const MODEL_SLOTS = Object.freeze([
  {
    key: 'agent',
    label: 'Agent orchestrator',
    help: 'Runs the Discord / web-chat agent loop: reads the conversation, searches tools, decides what to do. When this differs from the writer slot the loop runs two-tier and delegates creative text to the writer.',
    family: 'agent',
  },
  {
    key: 'writer',
    label: 'Creative writing',
    help: 'The writer subagent and the creative text tools (edit, create beat / character, director notes, dialogue samples, character template). This is the model whose prose ends up in the screenplay.',
    family: 'creative',
  },
  {
    key: 'dialog',
    label: 'Dialog',
    help: 'Dialog generation, regeneration, inline edit, critique and performance direction on the Dialog tab.',
    family: 'creative',
  },
  {
    key: 'storyboard',
    label: 'Storyboard & scene planning',
    help: 'Shot planning and expansion, frame-count analysis, storyboard prompt edits, plate planners and sheet tuners, scene bible autofill and set description generation.',
    family: 'creative',
  },
  {
    key: 'critique',
    label: 'Critique & rewrite',
    help: 'Beat critique facets, the beat rewrite / normalize passes, and the storyboard critique lens.',
    family: 'creative',
  },
  {
    key: 'analysis',
    label: 'Analysis & summaries',
    help: 'Generic one-shot analysis: the analyze tools in chat and the short shot summaries.',
    family: 'creative',
  },
  {
    key: 'enhancer',
    label: 'Auxiliary passes',
    help: 'Cheap helper calls: image-prompt enhancement, vision captions, reference selection, the storyboard readiness gap pass, PDF filename inference, chat titles and ElevenLabs text annotation.',
    family: 'enhancer',
  },
]);

export const MODEL_SLOT_KEYS = Object.freeze(MODEL_SLOTS.map((s) => s.key));

// Static catalog for the Admin dropdown. The live Models API list (when the
// key can reach it) is merged on top, so a model missing here is still
// selectable — this only guarantees the common choices always render.
export const KNOWN_MODELS = Object.freeze([
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable)' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
]);

// Loose id shape — Anthropic ids are lowercase words/digits joined by '-' or
// '.', and a few deployments use ':' aliases. Membership in KNOWN_MODELS is
// NOT required so brand-new models are usable the day they ship.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._:-]{1,99}$/;

export function isValidModelId(id) {
  return typeof id === 'string' && MODEL_ID_RE.test(id);
}

const overrides = new Map();

function familyDefault(family) {
  switch (family) {
    case 'agent':
      return config.anthropic.agentModel;
    case 'enhancer':
      return config.anthropic.enhancerModel;
    default:
      return config.anthropic.model;
  }
}

function slotDef(slot) {
  const def = MODEL_SLOTS.find((s) => s.key === slot);
  if (!def) throw new Error(`unknown model slot: ${slot}`);
  return def;
}

// The env/default value a slot uses when it has no override.
export function defaultModelFor(slot) {
  return familyDefault(slotDef(slot).family);
}

// The model a feature should call RIGHT NOW.
export function modelFor(slot) {
  return overrides.get(slot) || defaultModelFor(slot);
}

// Replace the whole override map (set semantics — a slot missing from `map`,
// or mapped to null/'', reverts to its env default).
export function setModelOverrides(map = {}) {
  overrides.clear();
  for (const key of MODEL_SLOT_KEYS) {
    const v = map?.[key];
    if (isValidModelId(v)) overrides.set(key, v);
  }
}

export function getModelOverrides() {
  const out = {};
  for (const key of MODEL_SLOT_KEYS) out[key] = overrides.get(key) || null;
  return out;
}

// Full per-slot view for the Admin page.
export function describeModelSlots() {
  return MODEL_SLOTS.map((s) => ({
    key: s.key,
    label: s.label,
    help: s.help,
    family: s.family,
    default: defaultModelFor(s.key),
    override: overrides.get(s.key) || null,
    effective: modelFor(s.key),
  }));
}
