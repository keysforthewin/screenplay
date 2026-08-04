// Ties the synthesis client to the audio scheduler and exposes a small
// observable state machine for the UI:
//   idle → (loading) → generating → playing → idle
// 'loading' only appears on the first ever play in a tab (model download).
// A fresh ChunkPlayer per play() keeps AudioContext scheduling state clean.

import { ChunkPlayer } from './playback.js';
import { getSharedTtsClient } from './ttsClient.js';

export class TtsController {
  constructor({ client, createPlayer } = {}) {
    this.client = client || getSharedTtsClient();
    this.createPlayer = createPlayer || (() => new ChunkPlayer());
    this.player = null;
    this.state = { status: 'idle', progress: null, error: null, detail: null };
    this.listeners = new Set();
  }

  getState() { return this.state; }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #set(patch) {
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
    let gotChunk = false;
    this.#set({ status: 'generating', progress: null, error: null, detail: null });
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
      onChunk: (samples, sampleRate) => {
        if (this.player !== player) return; // stale
        player.enqueue(samples, sampleRate);
        if (!gotChunk) {
          gotChunk = true;
          // A non-running AudioContext means silence with a happy UI — say so.
          const cs = player.contextState?.();
          const blocked = cs && cs !== 'running';
          this.#set({
            status: 'playing',
            progress: null,
            detail: blocked ? `no sound? audio context is ${cs}` : null,
          });
        }
      },
      onProgress: (loaded, total) => {
        if (this.player === player && !gotChunk) {
          this.#set({ status: 'loading', progress: total ? loaded / total : null });
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
        this.#set({ status: 'error', progress: null, error: result.message || 'TTS failed', detail: null });
      } else {
        this.#set({ status: 'idle', progress: null, detail: null });
      }
      return false;
    }
    await player.finished(); // all chunks emitted — wait for audio to drain
    if (this.player !== player) return false; // stop() raced the drain
    this.player = null;
    player.stop(); // release the player on natural completion too
    this.#set({ status: 'idle', progress: null, detail: null });
    return true;
  }

  stop() {
    const player = this.player;
    if (!player) return;
    this.player = null;
    this.client.stop(); // resolves the in-flight speak as 'stopped'
    player.stop();
    this.#set({ status: 'idle', progress: null, error: null, detail: null });
  }
}

let shared = null;
export function getSharedController() {
  return (shared ||= new TtsController());
}
