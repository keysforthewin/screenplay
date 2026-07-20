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
    this.state = { status: 'idle', progress: null, error: null };
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
    let gotChunk = false;
    this.#set({ status: 'generating', progress: null, error: null });
    const result = await this.client.speak({
      text: trimmed,
      voice,
      onChunk: (samples, sampleRate) => {
        if (this.player !== player) return; // stale
        if (!gotChunk) {
          gotChunk = true;
          this.#set({ status: 'playing', progress: null });
        }
        player.enqueue(samples, sampleRate);
      },
      onProgress: (loaded, total) => {
        if (this.player === player && !gotChunk) {
          this.#set({ status: 'loading', progress: total ? loaded / total : null });
        }
      },
    });
    if (this.player !== player) return false; // stop() or newer play() won
    if (result.status !== 'done') {
      this.player = null;
      player.stop();
      if (result.status === 'error') {
        this.#set({ status: 'error', progress: null, error: result.message || 'TTS failed' });
      } else {
        this.#set({ status: 'idle', progress: null });
      }
      return false;
    }
    await player.finished(); // all chunks emitted — wait for audio to drain
    if (this.player !== player) return false; // stop() raced the drain
    this.player = null;
    this.#set({ status: 'idle', progress: null });
    return true;
  }

  stop() {
    const player = this.player;
    if (!player) return;
    this.player = null;
    this.client.stop(); // resolves the in-flight speak as 'stopped'
    player.stop();
    this.#set({ status: 'idle', progress: null, error: null });
  }
}

let shared = null;
export function getSharedController() {
  return (shared ||= new TtsController());
}
