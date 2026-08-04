// The Kokoro synthesis engine, host-agnostic: runs inside the dedicated
// worker (kokoroWorker.js) or inline on the main thread (ttsTransport.js
// picks, for WebKit builds that expose WebGPU only outside workers). This is
// the ONLY file allowed to import kokoro-js — dynamically, so the heavy
// dependency stays out of the main SPA bundle either way.
//
// Message protocol (post() mirrors worker postMessage):
//   in:  {type:'speak', id, text, voice, forceWasm?} | {type:'stop', id} |
//        {type:'gpucheck'}
//   out: {type:'chunk'|'done'|'error'|'progress'|'status'|'gpucaps', ...}
//
// Device policy: try WebGPU whenever an adapter materializes — fp16 when the
// GPU advertises shader-f16, else fp32 — falling back to wasm/q8 when a load
// fails. A GPU attempt that HANGS (WebKit has form here) is killed by the
// client's watchdog, which then sets forceWasm on the next speak.

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export function createKokoroEngine(post) {
  let ttsPromise = null;
  let loadedWith = null; // {device, dtype} of the model that actually loaded
  let activeId = 0;
  let TextSplitterStreamCtor = null;

  const status = (text) => post({ type: 'status', text });

  async function probeAdapter() {
    try {
      // requestAdapter() can hang indefinitely on some platforms (observed on
      // WSL Chrome) — race it against a timeout so a broken GPU stack degrades
      // to wasm instead of stalling the model load forever.
      return await Promise.race([
        Promise.resolve(globalThis.navigator?.gpu?.requestAdapter() ?? null),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
    } catch {
      return null;
    }
  }

  async function candidates(forceWasm) {
    const wasm = { device: 'wasm', dtype: 'q8' };
    if (forceWasm) return [wasm];
    const adapter = await probeAdapter();
    if (!adapter) return [wasm];
    const list = [];
    if (adapter.features?.has?.('shader-f16')) list.push({ device: 'webgpu', dtype: 'fp16' });
    list.push({ device: 'webgpu', dtype: 'fp32' });
    list.push(wasm);
    return list;
  }

  async function loadModel(forceWasm) {
    status('loading TTS engine');
    const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
    TextSplitterStreamCtor = TextSplitterStream;
    // Without cross-origin isolation there is no SharedArrayBuffer, and ORT's
    // thread-count autodetection deadlocks wasm session init on iOS WebKit
    // instead of degrading. Pin the wasm backend to one thread; kokoro-js
    // imports @huggingface/transformers as a shared external, so this env
    // object is the one ORT actually reads. Must precede session creation.
    if (typeof SharedArrayBuffer === 'undefined') {
      const { env } = await import('@huggingface/transformers');
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      }
    }
    let lastErr = null;
    for (const cand of await candidates(forceWasm)) {
      status(`loading model (${cand.device}/${cand.dtype})`);
      const files = new Map();
      let lastPct = -1;
      try {
        const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: cand.dtype,
          device: cand.device,
          progress_callback: (p) => {
            if (p.status !== 'progress' || !p.total) {
              // Per-file lifecycle breadcrumbs (initiate/download/done) —
              // cached files skip 'progress' entirely, so without these a
              // session-init stall looks identical to a fetch stall.
              if (p.status && p.status !== 'progress' && p.file) status(`model ${p.status}: ${p.file}`);
              return;
            }
            files.set(p.file, { loaded: p.loaded, total: p.total });
            let loaded = 0;
            let total = 0;
            for (const f of files.values()) {
              loaded += f.loaded;
              total += f.total;
            }
            // Raw callbacks fire per network chunk (thousands per download)
            // and each posted message becomes a React render on the main
            // thread — only post when the whole-percent value moves.
            const pct = Math.floor((loaded / total) * 100);
            if (pct === lastPct) return;
            lastPct = pct;
            post({ type: 'progress', loaded, total });
          },
        });
        loadedWith = cand;
        status(`model ready (${cand.device}/${cand.dtype})`);
        return tts;
      } catch (err) {
        lastErr = err;
        status(`load failed (${cand.device}/${cand.dtype}): ${err?.message || err}`);
      }
    }
    throw lastErr || new Error('no usable TTS backend');
  }

  async function handle(msg) {
    if (msg.type === 'gpucheck') {
      post({ type: 'gpucaps', webgpu: !!globalThis.navigator?.gpu });
      return;
    }
    if (msg.type === 'stop') {
      if (msg.id === activeId) activeId = 0;
      return;
    }
    if (msg.type !== 'speak') return;
    activeId = msg.id;
    try {
      // A forceWasm retry after a GPU hang must not reuse the GPU-loaded (or
      // GPU-loading) model.
      if (msg.forceWasm && (!loadedWith || loadedWith.device !== 'wasm')) ttsPromise = null;
      ttsPromise ||= loadModel(!!msg.forceWasm);
      const tts = await ttsPromise;
      if (activeId !== msg.id) return; // stopped while loading
      status(`synthesizing (${loadedWith.device}/${loadedWith.dtype})`);
      // kokoro-js never close()s the splitter it creates for plain-string
      // input, so its generator withholds the final sentence and never
      // terminates (no `done`, UI stuck on Stop). Own the splitter lifecycle.
      const splitter = new TextSplitterStreamCtor();
      splitter.push(msg.text);
      splitter.close();
      for await (const { text, audio } of tts.stream(splitter, { voice: msg.voice })) {
        if (activeId !== msg.id) return; // stopped mid-generation
        const samples = audio.audio;
        post(
          { type: 'chunk', id: msg.id, samples, sampleRate: audio.sampling_rate, text },
          [samples.buffer],
        );
      }
      if (activeId === msg.id) post({ type: 'done', id: msg.id });
    } catch (err) {
      ttsPromise = null; // let a later speak retry the load
      loadedWith = null;
      post({ type: 'error', id: msg.id, message: err?.message || String(err) });
    }
  }

  return { handle };
}
