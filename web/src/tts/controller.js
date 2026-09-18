// Ties the synthesis client to the audio scheduler and exposes a small
// observable state machine for the UI:
//   idle → (loading) → generating → buffering → playing → idle
// 'loading' only appears on the first play in a tab (model download, or the
// read-back from the browser cache — `progressCached` says which).
// 'buffering' banks audio until bufferPlan.js says playback can run to the end
// without catching up with the generator; an underrun drops back into it.
// `paused` is orthogonal: synthesis and banking carry on underneath a pause.
// A fresh ChunkPlayer per play() keeps AudioContext scheduling state clean.
//
// Every generated chunk is also kept, so a finished read-through exists as one
// recording: replaying the same text+voice skips synthesis entirely, and
// getRecordingBlob() hands it out as a single WAV file.

import { ChunkPlayer } from './playback.js';
import { getSharedTtsClient } from './ttsClient.js';
import { planBuffer, formatDuration } from './bufferPlan.js';
import { encodeWav } from './wav.js';
import { requestPersist } from './persistStorage.js';

const IDLE = { status: 'idle', progress: null, progressCached: false, error: null, detail: null, paused: false };

// Past this much audio the recording is dropped rather than held in memory
// (float32 mono @ 24kHz ≈ 5.8MB/min).
const MAX_RECORDING_SEC = 30 * 60;

function describePlan(plan, unplayedSec, segment, segments) {
  const parts = [];
  if (segments) parts.push(`segment ${segment}/${segments}`);
  if (plan.rate != null) parts.push(`${plan.rate.toFixed(1)}× realtime`);
  parts.push(`~${formatDuration(plan.totalSec)} total`);
  if (!plan.ready) {
    parts.push(`buffered ${formatDuration(unplayedSec)} of ${formatDuration(plan.neededSec)}`);
    if (plan.waitSec) parts.push(`starts in ~${formatDuration(plan.waitSec)}`);
  } else if (plan.remainingGenSec) {
    parts.push(`${formatDuration(plan.remainingGenSec)} of synthesis left`);
  }
  return parts.join(' · ');
}

export class TtsController {
  constructor({ client, createPlayer, persist } = {}) {
    this.persist = persist || requestPersist;
    this.client = client || getSharedTtsClient();
    this.createPlayer = createPlayer || (() => new ChunkPlayer());
    this.player = null;
    this.state = { ...IDLE, canSave: false, persisted: null };
    this.recording = null; // { key, chunks: Float32Array[], sampleRate }
    this.listeners = new Set();
  }

  getState() { return this.state; }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #set(patch) {
    // Chunk-driven replans mostly restate the same state — don't wake React.
    if (Object.keys(patch).every((k) => this.state[k] === patch[k])) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  // Resolves true when playback finished naturally; false when stopped,
  // superseded by a newer play(), or errored.
  async play(text, voice) {
    this.stop();
    const trimmed = String(text || '').trim();
    if (!trimmed) return true;
    const player = (this.player = this.createPlayer());
    // Still synchronously inside the Play click here — the only moment iOS
    // lets us create/resume an audible AudioContext.
    player.unlock?.();
    // Ask the browser not to evict the cached model (see persistStorage.js).
    // The answer feeds the UI's "Keep model" prompt when it's a refusal.
    this.persist().then((persisted) => this.#set({ persisted }));

    const key = `${voice}\n${trimmed}`;
    if (this.recording?.key === key) return this.#replay(player);

    let gotChunk = false;
    let totalChars = 0;
    let segments = 0;
    let done = false;
    let audioSec = 0;
    const stats = []; // per chunk {audioSec, synthSec, chars} for planBuffer
    const kept = [];  // the recording in progress
    let sampleRate = 24000;
    player.hold?.();
    this.#set({ ...IDLE, status: 'generating', canSave: !!this.recording });

    const replan = () => {
      if (this.player !== player) return;
      const unplayedSec = player.unplayedSec?.() ?? 0;
      const plan = planBuffer({ chunks: stats, totalChars, unplayedSec, done });
      const held = player.held === true; // fake/legacy players never hold
      if (held && plan.ready) player.release();
      const playing = !held || plan.ready;
      // A non-running AudioContext means silence with a happy UI — say so.
      const cs = playing && !this.state.paused ? player.contextState?.() : null;
      const blocked = cs && cs !== 'running';
      this.#set({
        status: playing ? 'playing' : 'buffering',
        progress: null,
        detail: blocked
          ? `no sound? audio context is ${cs}`
          : stats.some((c) => c.synthSec) ? describePlan(plan, unplayedSec, stats.length, segments) : null,
      });
    };
    player.onUnderrun = replan;

    // Debug override: append ?tts=webgpu/fp32 (or wasm/q4, webgpu/q4f16, …)
    // to the page URL to pin the synthesis backend for this tab.
    let force;
    try {
      force = new URLSearchParams(globalThis.location?.search || '').get('tts') || undefined;
    } catch { force = undefined; }
    const result = await this.client.speak({
      text: trimmed,
      voice,
      force,
      onPlan: (p) => {
        totalChars = p.totalChars;
        segments = p.segments;
      },
      onChunk: (samples, rate, _text, meta = {}) => {
        if (this.player !== player) return; // stale
        gotChunk = true;
        sampleRate = rate;
        const sec = samples.length / rate;
        audioSec += sec;
        stats.push({ audioSec: sec, synthSec: (meta.synthMs || 0) / 1000, chars: meta.chars || 0 });
        if (audioSec <= MAX_RECORDING_SEC) kept.push(samples);
        player.enqueue(samples, rate);
        replan();
      },
      onProgress: (loaded, total, cached) => {
        if (this.player === player && !gotChunk) {
          this.#set({ status: 'loading', progress: total ? loaded / total : null, progressCached: !!cached });
        }
      },
      onStatus: (text) => {
        if (this.player === player && !gotChunk) this.#set({ detail: text });
      },
    });
    if (this.player !== player) return false; // stop() or newer play() won
    if (result.status !== 'done') {
      this.player = null;
      player.stop();
      if (result.status === 'error') {
        this.#set({ ...IDLE, status: 'error', error: result.message || 'TTS failed' });
      } else {
        this.#set({ ...IDLE });
      }
      return false;
    }
    done = true;
    if (kept.length && audioSec <= MAX_RECORDING_SEC) {
      this.recording = { key, chunks: kept, sampleRate };
      this.#set({ canSave: true });
    }
    return this.#drain(player, replan);
  }

  // Same text + voice as the finished recording: no synthesis, no buffering.
  #replay(player) {
    const { chunks, sampleRate } = this.recording;
    for (const samples of chunks) player.enqueue(samples, sampleRate);
    this.#set({ ...IDLE, status: 'playing', detail: 'replaying saved audio', canSave: true });
    return this.#drain(player);
  }

  async #drain(player, replan) {
    const drained = player.finished(); // releases anything still banked
    replan?.();
    await drained; // all chunks emitted — wait for audio to play out
    if (this.player !== player) return false; // stop() raced the drain
    this.player = null;
    player.stop(); // release the player on natural completion too
    this.#set({ ...IDLE });
    return true;
  }

  // Pause/resume may land at any moment — mid-download, while buffering,
  // mid-sentence. Synthesis keeps going underneath; only the audio clock stops.
  pause() {
    if (!this.player || this.state.paused) return;
    this.player.pause?.();
    this.#set({ paused: true });
  }

  resume() {
    if (!this.player || !this.state.paused) return;
    this.player.resume?.();
    this.#set({ paused: false });
  }

  // Result of an explicit "Keep model" click (persistStorage.js#pinStorage).
  setPersisted(persisted) { this.#set({ persisted: !!persisted }); }

  // The last finished read-through as one WAV file, or null.
  getRecordingBlob() {
    return this.recording ? encodeWav(this.recording.chunks, this.recording.sampleRate) : null;
  }

  stop() {
    const player = this.player;
    if (!player) return;
    this.player = null;
    this.client.stop(); // resolves the in-flight speak as 'stopped'
    player.stop();
    this.#set({ ...IDLE });
  }
}

let shared = null;
export function getSharedController() {
  return (shared ||= new TtsController());
}
