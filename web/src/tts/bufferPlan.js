// Start-of-playback buffer math for streamed synthesis.
//
// Synthesis may run slower than real time, so playback must not begin until
// enough audio is banked that the generator finishes before the listener
// catches up. With R = seconds of audio produced per wall-clock second, A =
// seconds banked and Rem = seconds still to generate, generation needs Rem/R
// more wall time while playback lasts A + Rem; no underrun ⇔ Rem/R ≤ A + Rem.
// Substituting Rem = T − A (T = everything not yet played) gives
//     A ≥ T · (1 − R)
// — bank the fraction of the audio the generator can't keep up with. At R ≥ 1
// the requirement vanishes and only the small floor below applies.
//
// R comes from measured chunks, skipping the first when there are others: the
// first inference pays one-off warmup (WebGPU shader compile, wasm session
// init) and would make every estimate pessimistic. T is extrapolated from the
// measured seconds-of-audio per character.

// Trust the measured rate a little less than measured: thermal throttling and
// a busy main thread only ever make it worse.
export const RATE_SAFETY = 0.85;
// Never start on less than this (unless that's all there is): one segment's
// synthesis is indivisible, so the player needs a cushion of about a segment.
export const MIN_BUFFER_SEC = 3;
// Kokoro at speed 1 speaks ~15 chars/s; only used before the first chunk lands.
const DEFAULT_SEC_PER_CHAR = 0.065;

// chunks: [{audioSec, synthSec, chars}] in generation order (synthSec/chars may
// be missing — then the chunk doesn't contribute to the estimates).
// unplayedSec: generated audio not yet played (the bank, "A").
export function planBuffer({ chunks, totalChars, unplayedSec, done }) {
  const measured = chunks.filter((c) => c.synthSec > 0 && c.audioSec > 0);
  const rated = measured.length > 1 ? measured.slice(1) : measured;
  const audio = rated.reduce((n, c) => n + c.audioSec, 0);
  const synth = rated.reduce((n, c) => n + c.synthSec, 0);
  const rate = synth > 0 ? audio / synth : null; // null = unmeasured

  const sized = chunks.filter((c) => c.chars > 0 && c.audioSec > 0);
  const sizedChars = sized.reduce((n, c) => n + c.chars, 0);
  const secPerChar = sizedChars
    ? sized.reduce((n, c) => n + c.audioSec, 0) / sizedChars
    : DEFAULT_SEC_PER_CHAR;
  const doneChars = chunks.reduce((n, c) => n + (c.chars || 0), 0);
  const generatedSec = chunks.reduce((n, c) => n + c.audioSec, 0);
  const remainingSec = done ? 0 : Math.max(0, (totalChars || 0) - doneChars) * secPerChar;
  const totalSec = generatedSec + remainingSec;

  let neededSec = 0;
  if (!done && remainingSec > 0 && rate != null) {
    const safeRate = rate * RATE_SAFETY;
    const outstanding = unplayedSec + remainingSec; // T
    neededSec = Math.max(MIN_BUFFER_SEC, outstanding * (1 - safeRate));
    neededSec = Math.min(neededSec, outstanding);
  }
  const ready = done || remainingSec === 0 || (rate == null ? chunks.length > 0 : unplayedSec >= neededSec);
  // Wall time until the bank reaches neededSec at the measured rate.
  const waitSec = ready || !rate ? 0 : Math.max(0, neededSec - unplayedSec) / rate;
  return {
    rate,
    totalSec,
    generatedSec,
    remainingGenSec: rate ? remainingSec / rate : null,
    neededSec,
    waitSec,
    ready,
  };
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
