// Client-side twin of src/web/cutTiming.js — only what the UI shows: how long
// a cut is rendered (its length plus a travelling camera's handles, snapped up
// to the model) and which part of the clip the assembly keeps. The server
// decides; this is for hints.

const HANDLE = 0.5;
const TRAVELLING = ['pan', 'tilt', 'truck', 'track', 'crane', 'push_in', 'pull_out'];

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const trimValue = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
const round3 = (n) => Math.round(n * 1000) / 1000;

export const cameraTravels = (cut) => TRAVELLING.includes(cut?.camera?.movement);
const coversDialogue = (cut) => Array.isArray(cut?.dialog_ids) && cut.dialog_ids.length > 0;

function manualTrim(cut) {
  const head = trimValue(cut?.trim_head_seconds);
  const tail = trimValue(cut?.trim_tail_seconds);
  return head == null && tail == null ? null : { head: head ?? 0, tail: tail ?? 0 };
}

export function cutHandles(cut) {
  return manualTrim(cut) || (cameraTravels(cut) && !coversDialogue(cut) ? { head: HANDLE, tail: HANDLE } : { head: 0, tail: 0 });
}

// { cut_seconds, handles, seconds } or null when the cut has no length.
export function renderSecondsForCut(cut, spec) {
  const cutSeconds = positive(cut?.duration_seconds);
  if (cutSeconds == null) return null;
  const { head, tail } = cutHandles(cut);
  let n = cutSeconds + head + tail;
  const step = positive(spec?.step) || (spec?.type === 'int' ? 1 : null);
  if (step) n = Math.ceil(n / step - 1e-9) * step;
  if (positive(spec?.min) != null && n < spec.min) n = spec.min;
  if (positive(spec?.max) != null && n > spec.max) n = spec.max;
  return { cut_seconds: cutSeconds, handles: round3(head + tail), seconds: round3(n) };
}

// The part of a clip of `clipSeconds` the assembly keeps: { start, end, auto }
// or null when it keeps the whole clip.
export function trimWindow(clipSeconds, cut) {
  const clip = positive(clipSeconds);
  if (clip == null) return null;
  const manual = manualTrim(cut);
  if (manual) {
    const head = Math.min(manual.head, clip);
    const duration = clip - head - manual.tail;
    if (manual.head + manual.tail < 0.1 || duration < 0.1) return null;
    return { start: round3(head), end: round3(head + duration), auto: false };
  }
  if (coversDialogue(cut)) return null;
  const want = positive(cut?.duration_seconds);
  if (want == null || clip - want < 0.1) return null;
  const start = cameraTravels(cut) ? (clip - want) / 2 : clip - want;
  return { start: round3(start), end: round3(start + want), auto: true };
}
