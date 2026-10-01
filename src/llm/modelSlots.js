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
//
// A slot can also point at a local coding-agent harness instead of the API
// (dev only — see src/llm/harness/): the override is then an object
// `{ provider: 'claude-code'|'codex', model, effort }` and modelFor() returns
// an ENCODED id `<provider>:<model|default>:<effort|default>`. Every call site
// passes that id straight to getAnthropic().messages.*, whose routing client
// (src/anthropic/client.js) sends harness ids to the adapter.

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
    label: 'Scene & cut planning',
    help: 'The Prompts-tab planner (scenes, shot table, blocks, still prompts), plate planners for image sheets, scene bible autofill and set description generation. (Slot key stays "storyboard" so saved overrides keep working.)',
    family: 'creative',
  },
  {
    key: 'critique',
    label: 'Critique & rewrite',
    help: 'Beat critique facets, and the beat rewrite / normalize passes.',
    family: 'creative',
  },
  {
    key: 'analysis',
    label: 'Analysis & summaries',
    help: 'Generic one-shot analysis: the analyze tools in chat.',
    family: 'creative',
  },
  {
    key: 'enhancer',
    label: 'Auxiliary passes',
    help: 'Cheap helper calls: image-prompt enhancement, vision captions, reference selection, PDF filename inference, chat titles and ElevenLabs text annotation.',
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

// Coding-agent providers. `efforts` are the levels each harness accepts; the
// model is free text (blank = the host's own configured default).
export const HARNESS_PROVIDERS = Object.freeze([
  {
    id: 'claude-code',
    label: 'Claude Code',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    models: ['opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  },
  {
    id: 'codex',
    label: 'Codex',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    models: [],
  },
]);
export const HARNESS_PROVIDER_IDS = Object.freeze(HARNESS_PROVIDERS.map((p) => p.id));

const HARNESS_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const HARNESS_ID_RE = /^(claude-code|codex):([a-z0-9][a-z0-9._-]{0,79}):([a-z]+)$/;

export function isHarnessModelId(id) {
  return typeof id === 'string' && HARNESS_ID_RE.test(id);
}

// `claude-code:opus:high` → { provider, model, effort } (nulls for 'default').
export function parseHarnessModel(id) {
  const m = typeof id === 'string' ? HARNESS_ID_RE.exec(id) : null;
  if (!m) return null;
  return {
    provider: m[1],
    model: m[2] === 'default' ? null : m[2],
    effort: m[3] === 'default' ? null : m[3],
  };
}

export function encodeHarnessModel({ provider, model, effort }) {
  return `${provider}:${model || 'default'}:${effort || 'default'}`;
}

// Normalize a harness override object; throws a user-facing message when bad.
export function normalizeHarnessTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('harness target must be an object');
  const def = HARNESS_PROVIDERS.find((p) => p.id === raw.provider);
  if (!def) throw new Error(`unknown provider: ${raw.provider}`);
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim().toLowerCase() : null;
  if (model && (model === 'default' || !HARNESS_MODEL_RE.test(model))) throw new Error(`invalid ${def.label} model name: ${raw.model}`);
  const effort = typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort.trim() : null;
  if (effort && !def.efforts.includes(effort)) throw new Error(`invalid ${def.label} effort: ${raw.effort}`);
  return { provider: def.id, model, effort };
}

// A stored override is a model id string (API) or a harness target object.
export function isValidOverride(v) {
  if (isValidModelId(v)) return true;
  try {
    normalizeHarnessTarget(v);
    return true;
  } catch {
    return false;
  }
}

// A harness override on a server without the harness flag (e.g. a dev
// database restored into production) is ignored: the slot uses its API default.
function encodeOverride(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return config.llmHarness.enabled ? encodeHarnessModel(v) : null;
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
  return encodeOverride(overrides.get(slot)) || defaultModelFor(slot);
}

// Replace the whole override map (set semantics — a slot missing from `map`,
// or mapped to null/'', reverts to its env default).
export function setModelOverrides(map = {}) {
  overrides.clear();
  for (const key of MODEL_SLOT_KEYS) {
    const v = map?.[key];
    if (isValidModelId(v)) overrides.set(key, v);
    else if (isValidOverride(v)) overrides.set(key, normalizeHarnessTarget(v));
  }
}

export function getModelOverrides() {
  const out = {};
  for (const key of MODEL_SLOT_KEYS) out[key] = overrides.get(key) || null;
  return out;
}

// Full per-slot view for the Admin page.
export function describeModelSlots() {
  return MODEL_SLOTS.map((s) => {
    const o = overrides.get(s.key) || null;
    const harness = o && typeof o === 'object' ? o : null;
    return {
      key: s.key,
      label: s.label,
      help: s.help,
      family: s.family,
      default: defaultModelFor(s.key),
      override: o,
      provider: harness ? harness.provider : 'api',
      harness_model: harness ? harness.model : null,
      effort: harness ? harness.effort : null,
      effective: modelFor(s.key),
    };
  });
}
