// Pure parameter mapping for ComfyUI video renders: canonical params →
// validated values → `set_workflow_slot` overrides for a registry model.
// No I/O; unit-tested against the fixture templates.

import { CANONICAL_PARAM_ORDER } from './videoModels.js';

function roundToMultiple(n, m) {
  if (!m || m <= 1) return n;
  return Math.max(m, Math.round(n / m) * m);
}

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  return null;
}

// Validate + coerce a raw params object against the model's param specs.
// Returns { params, warnings, errors }. Missing values fall back to the
// spec default; out-of-range numbers are clamped (with a warning); enum
// mismatches and non-numeric numbers are errors; unknown keys are ignored
// with a warning. `seed` may stay null (filled at override build).
export function validateComfyParams(model, raw = {}) {
  const params = {};
  const warnings = [];
  const errors = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const specs = model?.params || {};
  for (const key of Object.keys(specs)) {
    const spec = specs[key];
    let v = src[key];
    const provided = !(v === undefined || v === null || v === '');
    if (!provided) v = spec.default ?? null;
    if (v === null || v === undefined) {
      params[key] = null;
      continue;
    }
    switch (spec.type) {
      case 'int':
      case 'float': {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          if (provided) errors.push(`${key} must be a number (got ${JSON.stringify(v)})`);
          params[key] = spec.default ?? null;
          break;
        }
        let out = spec.type === 'int' ? Math.round(n) : n;
        if (spec.multiple) out = roundToMultiple(out, spec.multiple);
        if (typeof spec.min === 'number' && out < spec.min) {
          if (provided) warnings.push(`${key} ${out} raised to the minimum ${spec.min}`);
          out = spec.min;
        }
        if (typeof spec.max === 'number' && out > spec.max) {
          if (provided) warnings.push(`${key} ${out} lowered to the maximum ${spec.max}`);
          out = spec.max;
        }
        if (spec.multiple && out !== n && provided && out >= (spec.min ?? 0) && out <= (spec.max ?? Infinity)) {
          if (Math.round(n) !== out) warnings.push(`${key} ${n} rounded to a multiple of ${spec.multiple}: ${out}`);
        }
        params[key] = out;
        break;
      }
      case 'bool': {
        const b = coerceBool(v);
        if (b === null) {
          errors.push(`${key} must be true or false`);
          params[key] = !!spec.default;
        } else {
          params[key] = b;
        }
        break;
      }
      default: {
        const s = String(v);
        if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.includes(s)) {
          errors.push(`${key} must be one of: ${spec.enum.join(', ')}`);
          params[key] = spec.default ?? spec.enum[0];
        } else {
          params[key] = s;
        }
      }
    }
  }
  for (const key of Object.keys(src)) {
    if (!specs[key]) warnings.push(`ignored unknown parameter "${key}"`);
  }
  return { params, warnings, errors };
}

export function randomSeed() {
  // 48-bit: comfortably inside every sampler's INT range and JS's safe ints.
  return Math.floor(Math.random() * 2 ** 48);
}

// Build the structured overrides for `set_workflow_slot`. `imageFilenames`
// carries the UPLOADED names ({ start_frame, end_frame, reference: [], audio }) — `audio`
// is the joined dialogue recording for models with `audioSlots`; `advanced` is
// a passthrough list of { address, value } applied last (last write wins).
// When `slotAddresses` (a Set/array of the template's known addresses) is
// supplied, advanced entries pointing nowhere are dropped with a warning.
export function buildSlotOverrides(
  model,
  { params = {}, imageFilenames = {}, advanced = [], slotAddresses = null, filenamePrefix = null } = {},
) {
  const warnings = [];
  const ordered = [];
  for (const f of model?.fixed || []) ordered.push({ address: f.address, value: f.value });
  const specs = model?.params || {};
  for (const key of CANONICAL_PARAM_ORDER) {
    const spec = specs[key];
    if (!spec?.address) continue;
    let value = params[key];
    if (key === 'seed' && (value === null || value === undefined)) value = randomSeed();
    if (value === null || value === undefined) continue;
    ordered.push({ address: spec.address, value });
  }
  if (typeof model?.derived === 'function') {
    for (const d of model.derived(params) || []) {
      if (d?.address) ordered.push({ address: d.address, value: d.value });
    }
  }
  const refs = Array.isArray(imageFilenames.reference) ? imageFilenames.reference : [];
  let refIndex = 0;
  for (const slot of model?.imageSlots || []) {
    if (slot.role === 'start_frame') {
      if (imageFilenames.start_frame) ordered.push({ address: slot.address, value: imageFilenames.start_frame });
      else warnings.push(`no start frame for slot ${slot.address}`);
    } else if (slot.role === 'end_frame') {
      if (imageFilenames.end_frame) ordered.push({ address: slot.address, value: imageFilenames.end_frame });
      else warnings.push(`no end frame for slot ${slot.address}`);
    } else if (slot.role === 'reference') {
      const name = refs[refIndex++];
      if (name) ordered.push({ address: slot.address, value: name });
      else warnings.push(`no reference image for slot ${slot.address}`);
    }
  }
  if (refs.length > refIndex) {
    warnings.push(`${refs.length - refIndex} reference image(s) beyond the template's ${refIndex} slot(s) were not sent`);
  }
  for (const slot of model?.audioSlots || []) {
    if (imageFilenames.audio) ordered.push({ address: slot.address, value: imageFilenames.audio });
    else warnings.push(`no audio for slot ${slot.address}`);
  }
  if (filenamePrefix && model?.output?.filenamePrefix) {
    ordered.push({ address: model.output.filenamePrefix, value: filenamePrefix });
  }
  const known = slotAddresses ? new Set(Array.from(slotAddresses)) : null;
  for (const a of Array.isArray(advanced) ? advanced : []) {
    if (!a || typeof a.address !== 'string' || !a.address.trim()) {
      warnings.push('advanced override without an address was ignored');
      continue;
    }
    if (a.value === undefined) {
      warnings.push(`advanced override ${a.address} has no value and was ignored`);
      continue;
    }
    if (known && !known.has(a.address)) {
      warnings.push(`advanced override ${a.address} is not a slot of this template and was ignored`);
      continue;
    }
    ordered.push({ address: a.address, value: a.value });
  }
  // Last write wins, order preserved by first appearance.
  const byAddress = new Map();
  for (const o of ordered) byAddress.set(o.address, o.value);
  const overrides = Array.from(byAddress, ([address, value]) => ({ address, value }));
  return { overrides, warnings };
}

// The prompt a cut ships to a model: the compiled block, with the reference
// binding prepended only for reference-taking models (the start frame carries
// identity everywhere else) and the clip-scope exclusions appended — only the
// ones the planner did not already write into the block, so nothing repeats.
export function assembleCutPrompt(model, cut, { promptOverride = null, stripMarkdown = (s) => s } = {}) {
  if (typeof promptOverride === 'string' && promptOverride.trim()) return promptOverride.trim();
  const parts = [];
  const takesRefs = model?.inputs?.referenceImages && model.inputs.referenceImages !== 'unused';
  const binding = stripMarkdown(String(cut?.reference_binding || '')).trim();
  if (takesRefs && binding) parts.push(binding);
  const body = stripMarkdown(String(cut?.prompt || '')).trim();
  if (body) parts.push(body);
  const exclusions = (Array.isArray(cut?.exclusions) ? cut.exclusions : [])
    .map((e) => stripMarkdown(String(e || '')).trim())
    .filter((e) => e && !body.includes(e));
  if (exclusions.length) parts.push(exclusions.join(' '));
  return parts.join('\n\n').trim();
}

// Extract the addresses from a `list_workflow_slots` result.
export function slotAddressesFromListing(listing) {
  const slots = Array.isArray(listing?.slots) ? listing.slots : Array.isArray(listing) ? listing : [];
  return new Set(slots.map((s) => s?.address).filter((a) => typeof a === 'string'));
}
