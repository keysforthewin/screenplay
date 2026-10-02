// src/web/cutTiming.js
// How long a cut's clip is rendered, and which part of the rendered clip the
// assembly keeps. Pure — no I/O.
//
// A cut's `duration_seconds` is the length it has in the assembled film. The
// rendered clip can be longer for two reasons:
//   - handles: a travelling camera eases into and out of its two stills, so
//     such a cut is rendered with half a second extra at each end and the
//     assembly cuts both off — the kept part is the move at speed;
//   - the model: a clip cannot be shorter than the model's minimum or finer
//     than its step (LTX renders whole seconds), so the request snaps UP and
//     the assembly trims the surplus.
// `trim_head_seconds` / `trim_tail_seconds` on the cut override the automatic
// window (null = automatic).

export const CAMERA_HANDLE_SECONDS = 0.5;
export const TRAVELLING_MOVES = Object.freeze(['pan', 'tilt', 'truck', 'track', 'crane', 'push_in', 'pull_out']);

// Below this a trim is not worth a cut (a frame or two at 24 fps).
const MIN_TRIM_SECONDS = 0.1;

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function trimValue(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function cameraTravels(cut) {
  return TRAVELLING_MOVES.includes(cut?.camera?.movement);
}

function coversDialogue(cut) {
  return Array.isArray(cut?.dialog_ids) && cut.dialog_ids.length > 0;
}

// The hand-set trims, or null when both are automatic.
function manualTrim(cut) {
  const head = trimValue(cut?.trim_head_seconds);
  const tail = trimValue(cut?.trim_tail_seconds);
  if (head == null && tail == null) return null;
  return { head: head ?? 0, tail: tail ?? 0 };
}

// Extra seconds rendered before and after the cut. A hand-set trim is its own
// handle; otherwise a travelling camera gets half a second at each end. A cut
// that covers dialogue never gets automatic handles — its audio starts at 0.
export function cutHandles(cut) {
  const manual = manualTrim(cut);
  if (manual) return manual;
  if (cameraTravels(cut) && !coversDialogue(cut)) {
    return { head: CAMERA_HANDLE_SECONDS, tail: CAMERA_HANDLE_SECONDS };
  }
  return { head: 0, tail: 0 };
}

// Snap UP to what the model can render: a model's step (whole seconds for an
// int param), then its min/max. Rounding to nearest would eat the handles.
export function snapDurationUp(seconds, spec = null) {
  let n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const step = positive(spec?.step) || (spec?.type === 'int' ? 1 : null);
  if (step) n = Math.ceil(n / step - 1e-9) * step;
  if (spec?.type === 'int') n = Math.ceil(n - 1e-9);
  const min = positive(spec?.min);
  const max = positive(spec?.max);
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return round3(n);
}

// What to ask the model for. null when the cut has no length of its own.
// `spec` is the model's duration param ({ type, min, max, step }).
export function renderSecondsForCut(cut, spec = null) {
  const cutSeconds = positive(cut?.duration_seconds);
  if (cutSeconds == null) return null;
  const { head, tail } = cutHandles(cut);
  const requested = round3(cutSeconds + head + tail);
  const seconds = snapDurationUp(requested, spec);
  const min = positive(spec?.min);
  const max = positive(spec?.max);
  let clamp = null;
  if (max != null && requested > max) clamp = 'max';
  else if (min != null && requested < min) clamp = 'min';
  return { cut_seconds: cutSeconds, head, tail, requested, seconds, clamp, min, max };
}

function fmt(n) {
  return String(round3(n));
}

// One warning line for a clamp, or null.
export function describeTiming(timing, modelLabel = 'the model') {
  if (!timing?.clamp) return null;
  if (timing.clamp === 'max') {
    return `Cut wants ${fmt(timing.requested)} s; ${modelLabel}'s maximum is ${fmt(timing.max)} s — rendered at ${fmt(timing.seconds)} s.`;
  }
  return `Cut wants ${fmt(timing.requested)} s; ${modelLabel}'s minimum is ${fmt(timing.min)} s — rendered at ${fmt(timing.seconds)} s, the assembly trims it to ${fmt(timing.cut_seconds)} s.`;
}

// How the assembly trims this cut's clip:
//   { head, tail }            — hand-set, cut that much off each end;
//   { want_seconds, anchor }  — automatic: keep want_seconds, taken from the
//                               middle of a travelling move ('centre') or the
//                               end of the clip ('tail' — the finished action
//                               and the last_frame state);
//   null                      — leave the clip whole (no length, or a cut that
//                               covers dialogue: its recording is the master).
export function trimPolicyForCut(cut) {
  const manual = manualTrim(cut);
  if (manual) return manual;
  if (coversDialogue(cut)) return null;
  const want = positive(cut?.duration_seconds);
  if (want == null) return null;
  return { want_seconds: want, anchor: cameraTravels(cut) ? 'centre' : 'tail' };
}

// The window to keep of a clip that is `clipSeconds` long: { start, duration }
// in seconds, or null when nothing (worth cutting) comes off.
export function resolveTrim(clipSeconds, policy) {
  const clip = positive(clipSeconds);
  if (clip == null || !policy) return null;
  if (policy.want_seconds == null) {
    const head = Math.min(trimValue(policy.head) ?? 0, clip);
    const tail = trimValue(policy.tail) ?? 0;
    const duration = clip - head - tail;
    if (head + tail < MIN_TRIM_SECONDS || duration < MIN_TRIM_SECONDS) return null;
    return { start: round3(head), duration: round3(duration) };
  }
  const want = positive(policy.want_seconds);
  if (want == null) return null;
  const excess = clip - want;
  if (excess < MIN_TRIM_SECONDS) return null;
  const start = policy.anchor === 'centre' ? excess / 2 : policy.anchor === 'head' ? 0 : excess;
  return { start: round3(start), duration: round3(want) };
}

// The window the assembly will keep, for display: { start, end } or null.
export function trimWindow(clipSeconds, cut) {
  const t = resolveTrim(clipSeconds, trimPolicyForCut(cut));
  return t ? { start: t.start, end: round3(t.start + t.duration) } : null;
}
