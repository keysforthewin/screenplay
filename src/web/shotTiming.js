// Deterministic speech-length estimation for dialogue lines. Pure: no I/O,
// no LLM. Adapted from PenShot's dialogue estimator (speech-rate baseline +
// punctuation pauses + emotional slowdown). A line's recorded audio duration
// wins when present; otherwise words / rate, slowed for emotional delivery
// cues, plus punctuation pauses and a breath per line.

import { stripMarkdown } from '../util/markdown.js';
import { stripAudioTags } from '../eleven/dialogTags.js';

export const WORDS_PER_SECOND = 2.5;
export const BREATH_PER_LINE_SECONDS = 0.5;
export const SENTENCE_PAUSE_SECONDS = 0.35; // per . ? ! …
export const COMMA_PAUSE_SECONDS = 0.15;
export const EMOTIONAL_SLOWDOWN = 1.2;

// Delivery cues in a line's direction note that slow the read. Kept short and
// literal: the direction is free text written by an LLM or a human.
const EMOTIONAL_CUES = /\b(whisper|whispers|whispered|choke|choked|choking|sob|sobs|sobbing|cry|cries|crying|tearful|tears|trembl|halting|haltingly|broken|breaks|quiet|quietly|slow|slowly|hesitat|pause|pauses|grief|grieving|weary|exhausted|barely)\b/i;

function countWords(text) {
  const t = stripMarkdown(String(text || '')).trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function countSentencePauses(text) {
  const t = String(text || '');
  const m = t.match(/[.?!…]+/g);
  return m ? m.length : 0;
}

function countCommaPauses(text) {
  const t = String(text || '');
  const m = t.match(/[,;:—–-]+/g);
  return m ? m.length : 0;
}

// Estimated spoken seconds for ONE line. Recorded audio wins when present.
export function estimateLineSeconds(line) {
  if (!line) return 0;
  const rec = Number(line.audio_duration_seconds);
  if (Number.isFinite(rec) && rec > 0) return rec;
  // ElevenLabs audio tags ([whispering], [long pause]…) direct the delivery;
  // they are not spoken words.
  const body = stripAudioTags(line.body);
  const words = countWords(body);
  if (!words) return 0;
  let s = words / WORDS_PER_SECOND;
  if (EMOTIONAL_CUES.test(String(line.direction || ''))) s *= EMOTIONAL_SLOWDOWN;
  s += countSentencePauses(body) * SENTENCE_PAUSE_SECONDS;
  s += countCommaPauses(body) * COMMA_PAUSE_SECONDS;
  s += BREATH_PER_LINE_SECONDS;
  return s;
}

// Total spoken seconds for a list of lines (no clamping, no head/tail).
export function estimateSpeechSeconds(lines) {
  if (!Array.isArray(lines) || !lines.length) return 0;
  return lines.reduce((acc, l) => acc + estimateLineSeconds(l), 0);
}

export function allLinesRecorded(lines) {
  return (
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every((l) => Number.isFinite(Number(l?.audio_duration_seconds)) && Number(l.audio_duration_seconds) > 0)
  );
}
