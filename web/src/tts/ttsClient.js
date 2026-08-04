// Main-thread handle on the Kokoro synthesis worker. One worker (and one
// loaded model) per tab, shared by the beat-page Play button and the TOC
// read-through. Generation ids guard against stale chunks after stop():
// only messages carrying the active id are delivered.

export class TtsClient {
  constructor(createWorker) {
    this.createWorker =
      createWorker ||
      (() => new Worker(new URL('./kokoroWorker.js', import.meta.url), { type: 'module' }));
    this.worker = null;
    this.nextId = 1;
    this.active = null; // { id, onChunk, onProgress, resolve }
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
    // The worker is in an unknown state — discard it so the next speak()
    // starts fresh (model files re-fetch from HTTP cache, not the network).
    try { this.worker?.terminate?.(); } catch { /* already dead */ }
    this.worker = null;
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.resolve({ status: 'error', message });
  }

  #onMessage(msg) {
    const active = this.active;
    if (msg.type === 'progress') {
      active?.onProgress?.(msg.loaded, msg.total);
      return;
    }
    if (!active || msg.id !== active.id) return; // stale generation
    if (msg.type === 'chunk') {
      active.onChunk(msg.samples, msg.sampleRate, msg.text);
    } else if (msg.type === 'done') {
      this.active = null;
      active.resolve({ status: 'done' });
    } else if (msg.type === 'error') {
      this.active = null;
      active.resolve({ status: 'error', message: msg.message });
    }
  }

  // Resolves {status:'done'} after the worker has emitted every chunk,
  // {status:'stopped'} if superseded/stopped, {status:'error', message} on failure.
  speak({ text, voice, onChunk, onProgress }) {
    this.stop(); // one generation at a time
    const id = this.nextId++;
    const worker = this.#ensureWorker();
    return new Promise((resolve) => {
      this.active = { id, onChunk, onProgress, resolve };
      worker.postMessage({ type: 'speak', id, text, voice });
    });
  }

  stop() {
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
