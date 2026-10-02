// Emily's load score for scene → cut planning (docs/video-prompting-notes.md
// §1 Step 5). Pure: no I/O, no LLM. A cut is one camera setup — normally one
// story beat — and every element that competes for the generation budget adds
// load points on top of it. `S = duration ÷ (beats + load)` then says how much
// time each unit of content gets: ≥ 3 s is Safe, 2–3 is Stretch, < 2 is
// Ambitious (split, never reroll). The same table decides how long a cut with
// no recorded audio should run.
//
// Recorded audio always wins: a covered line with a real recording fixes the
// clip length, so the load formula only applies to cuts without one.

import { stripMarkdown } from '../util/markdown.js';
import { estimateSpeechSeconds } from './shotTiming.js';

export const LOAD_POINTS = Object.freeze({
  camera_move: 0.5, // a move within a cut (a cut itself is free)
  line_per_8_words: 1, // per spoken line, 1 per 8 English words, minimum 1
  acting_principal: 1, // each additional principal who acts
  held_principal: 0.5, // a second person who only holds or reacts
  contact: 1, // physical contact that must land
  location_change: 2, // a crossing between landmarks / a location change
  sound_on_action: 0.5, // a sound cue that must land on an action
});

export const LOAD_VERDICTS = Object.freeze(['safe', 'stretch', 'ambitious']);

// Seconds of screen time each (beat + load) unit should get for a Safe cut.
export const SECONDS_PER_UNIT = 3;
// Tail added after recorded audio so the cut never clips the last syllable.
export const RECORDED_TAIL_SECONDS = 0.6;

function normName(s) {
  return stripMarkdown(String(s ?? '')).trim().toLowerCase();
}

function countWords(text) {
  const t = stripMarkdown(String(text || '')).trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function isRecorded(line) {
  const dur = Number(line?.audio_duration_seconds);
  return Boolean(line?.audio_file_id) && Number.isFinite(dur) && dur > 0;
}

// Reaction shots and inserts count half a beat; everything else is one.
export function cutBeats(cut) {
  if (cut?.reaction === true) return 0.5;
  if (cut?.camera?.size === 'insert') return 0.5;
  return 1;
}

// The actor is the in_frame entry named by action_by; when action_by names
// nobody in frame (or is blank) the first principal in frame is the actor.
function actorIndex(cut) {
  const inFrame = Array.isArray(cut?.in_frame) ? cut.in_frame : [];
  if (!inFrame.length) return -1;
  const wanted = normName(cut?.action_by);
  if (wanted) {
    const idx = inFrame.findIndex((p) => normName(p?.character) === wanted);
    if (idx >= 0) return idx;
  }
  return 0;
}

// { beats, load, breakdown: [{ code, points, note }] }
export function cutLoadPoints(cut, { coveredDialogs = [] } = {}) {
  const breakdown = [];
  let load = 0;
  const add = (code, points, note) => {
    breakdown.push({ code, points, note });
    load += points;
  };

  const movement = String(cut?.camera?.movement || '').trim().toLowerCase();
  if (movement && movement !== 'static') {
    add('camera_move', LOAD_POINTS.camera_move, `camera ${movement}`);
  }

  const lines = Array.isArray(coveredDialogs) ? coveredDialogs : [];
  for (const line of lines) {
    const words = countWords(line?.body);
    const points = Math.max(1, Math.ceil(words / 8)) * LOAD_POINTS.line_per_8_words;
    const speaker = stripMarkdown(String(line?.character || '')).trim() || 'line';
    add('line', points, `${speaker}: ${words} word${words === 1 ? '' : 's'}`);
  }

  const inFrame = Array.isArray(cut?.in_frame) ? cut.in_frame : [];
  const actor = actorIndex(cut);
  inFrame.forEach((p, i) => {
    if (i === actor) return;
    const name = stripMarkdown(String(p?.character || '')).trim() || `principal ${i + 1}`;
    if (p?.acts === true) {
      add('acting_principal', LOAD_POINTS.acting_principal, `${name} acts`);
    } else {
      add('held_principal', LOAD_POINTS.held_principal, `${name} holds or reacts`);
    }
  });

  if (cut?.contact === true) add('contact', LOAD_POINTS.contact, 'contact that must land');
  if (cut?.crossing === true) add('location_change', LOAD_POINTS.location_change, 'crossing between landmarks');
  if (cut?.sound_on_action === true) add('sound_on_action', LOAD_POINTS.sound_on_action, 'sound cue on an action');

  return { beats: cutBeats(cut), load, breakdown };
}

// The shortest a cut that covers these lines may run: the speech (recorded
// lengths where they exist, estimates otherwise) plus the tail, rounded up to
// half a second. 0 when the cut covers no line. The planner's chosen length is
// raised to this — everything else about a cut's length is the model's call.
export function speechFloorSeconds(coveredDialogs = []) {
  const lines = Array.isArray(coveredDialogs) ? coveredDialogs.filter(Boolean) : [];
  if (!lines.length) return 0;
  const speech = Number(estimateSpeechSeconds(lines));
  if (!Number.isFinite(speech) || speech <= 0) return 0;
  return Math.ceil((speech + RECORDED_TAIL_SECONDS) * 2 - 1e-9) / 2;
}

// Integer seconds for one cut. Recorded audio wins; otherwise the load table.
export function estimateCutDuration(
  cut,
  { coveredDialogs = [], secondsPerUnit = SECONDS_PER_UNIT, min = 3, max = 15 } = {},
) {
  const lines = Array.isArray(coveredDialogs) ? coveredDialogs : [];
  let raw;
  if (lines.some(isRecorded)) {
    // estimateSpeechSeconds returns the recorded length for recorded lines and
    // the speech-rate estimate for the rest.
    raw = Math.ceil(estimateSpeechSeconds(lines) + RECORDED_TAIL_SECONDS);
  } else {
    const { beats, load } = cutLoadPoints(cut, { coveredDialogs: lines });
    raw = Math.ceil(secondsPerUnit * (beats + load));
  }
  if (!Number.isFinite(raw)) raw = min;
  return Math.min(max, Math.max(min, raw));
}

export function loadVerdict(s) {
  if (s >= 3) return 'safe';
  if (s >= 2) return 'stretch';
  return 'ambitious';
}

function dialogsForCut(coveredDialogsByCut, cut, index) {
  if (!coveredDialogsByCut) return [];
  const get = (k) =>
    typeof coveredDialogsByCut.get === 'function' ? coveredDialogsByCut.get(k) : coveredDialogsByCut[k];
  const byId = cut?._id != null ? get(String(cut._id)) : undefined;
  if (Array.isArray(byId)) return byId;
  const byIndex = get(index) ?? get(String(index));
  return Array.isArray(byIndex) ? byIndex : [];
}

// { beats, load_points, total_seconds, s, verdict } for a whole scene.
export function sceneLoad(cuts, { coveredDialogsByCut = new Map() } = {}) {
  const list = Array.isArray(cuts) ? cuts : [];
  let beats = 0;
  let loadPoints = 0;
  let totalSeconds = 0;
  list.forEach((cut, i) => {
    const coveredDialogs = dialogsForCut(coveredDialogsByCut, cut, i);
    const { beats: b, load } = cutLoadPoints(cut, { coveredDialogs });
    beats += b;
    loadPoints += load;
    const dur = Number(cut?.duration_seconds);
    totalSeconds +=
      Number.isFinite(dur) && dur > 0 ? dur : estimateCutDuration(cut, { coveredDialogs });
  });
  const denom = beats + loadPoints;
  const s = denom > 0 ? totalSeconds / denom : 0;
  return {
    beats,
    load_points: loadPoints,
    total_seconds: totalSeconds,
    s,
    verdict: loadVerdict(s),
  };
}
