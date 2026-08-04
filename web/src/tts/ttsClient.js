// Main-thread handle on the Kokoro synthesis engine (worker or inline — see
// ttsTransport.js). One transport (and one loaded model) per tab, shared by
// the beat-page Play button and the TOC read-through. Generation ids guard
// against stale chunks after stop(): only messages carrying the active id
// are delivered.

import { createTtsTransport } from './ttsTransport.js';

// Any worker message resets this deadline. WASM synthesis blocks the worker
// thread, so a slow-but-alive device can legitimately go quiet for a while —
// keep this generous; it exists to catch dead workers, not slow ones.
const WATCHDOG_MS = 90_000;

export class TtsClient {
  constructor(createWorker) {
    // Default transport picks worker vs main-thread placement (WebGPU
    // availability differs between the two on WebKit) behind a Worker-shaped
    // facade; tests inject a plain fake worker.
    this.createWorker = createWorker || (() => createTtsTransport());
    this.worker = null;
    this.nextId = 1;
    this.active = null; // { id, onChunk, onProgress, onStatus, resolve }
    this.lastStatus = null;
    this.watchdog = null;
    // Once a generation dies (crash or watchdog), later speaks force the
    // wasm backend — a hanging WebGPU stack would otherwise hang every retry.
    this.preferWasm = false;
  }

  #ensureWorker() {
    if (!this.worker) {
      this.worker = this.createWorker();
      this.worker.onmessage = (e) => this.#onMessage(e.data);
      // Without these, a worker that crashes (iOS OOM-kills, top-level script
      // errors) never posts anything and the UI hangs on "Generating…" forever.
      this.worker.onerror = (e) => this.#workerFailed(e?.message || 'TTS worker crashed');
      this.worker.onmessageerror = () => this.#workerFailed('TTS worker message error');
    }
    return this.worker;
  }

  #workerFailed(message) {
    clearTimeout(this.watchdog);
    this.preferWasm = true;
    // The worker is in an unknown state — discard it so the next speak()
    // starts fresh (model files re-fetch from HTTP cache, not the network).
    try { this.worker?.terminate?.(); } catch { /* already dead */ }
    this.worker = null;
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.resolve({ status: 'error', message });
  }

  // A silently dead worker (iOS OOM-kill fires no onerror) would otherwise
  // leave the UI on "Generating…" forever — turn prolonged total silence into
  // an error that names the last stage the worker reported.
  #armWatchdog() {
    clearTimeout(this.watchdog);
    if (!this.active) return;
    this.watchdog = setTimeout(() => {
      this.#workerFailed(
        `No TTS output for ${WATCHDOG_MS / 1000}s (last stage: ${this.lastStatus || 'starting'}) — ` +
          'the engine likely crashed or this device is too slow.',
      );
    }, WATCHDOG_MS);
  }

  #onMessage(msg) {
    this.#armWatchdog();
    const active = this.active;
    if (msg.type === 'status') {
      this.lastStatus = msg.text;
      active?.onStatus?.(msg.text);
      return;
    }
    if (msg.type === 'progress') {
      this.lastStatus = 'downloading model';
      active?.onProgress?.(msg.loaded, msg.total);
      return;
    }
    if (!active || msg.id !== active.id) return; // stale generation
    if (msg.type === 'chunk') {
      this.lastStatus = 'streaming audio';
      active.onChunk(msg.samples, msg.sampleRate, msg.text);
    } else if (msg.type === 'done') {
      clearTimeout(this.watchdog);
      this.active = null;
      active.resolve({ status: 'done' });
    } else if (msg.type === 'error') {
      clearTimeout(this.watchdog);
      // An error out of a GPU attempt poisons future attempts too — the
      // engine's in-load fallback ladder only covers load-time failures, not
      // mid-synthesis ones, so pin the next speak to wasm.
      if (/webgpu/.test(this.lastStatus || '')) this.preferWasm = true;
      this.active = null;
      active.resolve({ status: 'error', message: msg.message });
    }
  }

  // Resolves {status:'done'} after the worker has emitted every chunk,
  // {status:'stopped'} if superseded/stopped, {status:'error', message} on failure.
  speak({ text, voice, onChunk, onProgress, onStatus, force }) {
    this.stop(); // one generation at a time
    const id = this.nextId++;
    const worker = this.#ensureWorker();
    return new Promise((resolve) => {
      this.active = { id, onChunk, onProgress, onStatus, resolve };
      this.lastStatus = null;
      const msg = { type: 'speak', id, text, voice };
      if (force) msg.force = force; // ?tts=device/dtype debug override
      if (this.preferWasm) msg.forceWasm = true;
      worker.postMessage(msg);
      this.#armWatchdog();
    });
  }

  stop() {
    clearTimeout(this.watchdog);
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.worker?.postMessage({ type: 'stop', id: active.id });
    active.resolve({ status: 'stopped' });
  }
}

let shared = null;
export function getSharedTtsClient() {
  return (shared ||= new TtsClient());
}
