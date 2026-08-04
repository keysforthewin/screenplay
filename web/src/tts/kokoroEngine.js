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
// Device policy: try WebGPU whenever an adapter materializes — fp32 only
// (upstream kokoro-js explicitly recommends fp32 on WebGPU; fp16 is known to
// produce silent/NaN audio) — falling back to wasm/q8 when a load fails or
// the first generated chunk carries no audible signal. A GPU attempt that
// HANGS (WebKit has form here) is killed by the client's watchdog, which
// then sets forceWasm on the next speak.

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// True when the chunk contains at least one finite, non-negligible sample.
// A backend that "works" but emits all-zero/NaN buffers (fp16-on-WebGPU's
// signature failure) would otherwise play convincing silence.
export function hasAudibleSignal(samples) {
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (Number.isFinite(v) && Math.abs(v) > 1e-4) return true;
  }
  return false;
}

export function createKokoroEngine(post) {
  let ttsPromise = null;
  let loadedWith = null; // {device, dtype} of the model that actually loaded
  let activeId = 0;
  let TextSplitterStreamCtor = null;
  let avoidWebGpu = false; // set after WebGPU emits silent audio

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

  async function candidates(forceWasm, forcePair) {
    // Debug override from the page URL (?tts=webgpu/q4f16 etc.) — lets us
    // trial backends/quantizations on a real device without redeploying.
    const m = /^(wasm|webgpu)\/(fp32|fp16|q8|q4|q4f16)$/.exec(forcePair || '');
    if (m) return [{ device: m[1], dtype: m[2] }];
    const wasm = { device: 'wasm', dtype: 'q8' };
    if (forceWasm || avoidWebGpu) return [wasm];
    const adapter = await probeAdapter();
    if (!adapter) return [wasm];
    return [{ device: 'webgpu', dtype: 'fp32' }, wasm];
  }

  async function loadModel(forceWasm, forcePair) {
    status(`env: ${typeof window === 'undefined' ? 'worker' : 'main-thread'}, gpu=${!!globalThis.navigator?.gpu}`);
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
    for (const cand of await candidates(forceWasm, forcePair)) {
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
      // A ?tts= override that doesn't match the loaded model forces a reload.
      if (msg.force && loadedWith && `${loadedWith.device}/${loadedWith.dtype}` !== msg.force) {
        ttsPromise = null;
      }
      // A forceWasm retry after a GPU hang must not reuse the GPU-loaded (or
      // GPU-loading) model.
      if (msg.forceWasm && (!loadedWith || loadedWith.device !== 'wasm')) ttsPromise = null;
      const needProbes = !ttsPromise; // first speak on a fresh model load
      ttsPromise ||= loadModel(!!msg.forceWasm, msg.force);
      const tts = await ttsPromise;
      if (activeId !== msg.id) return; // stopped while loading
      if (needProbes) {
        // "synthesizing" hides three sub-steps (espeak phonemization, lazy
        // voice-style fetch from HF, first inference). Time the first two
        // explicitly so a device we can't debug tells us which one stalls.
        status('probe: phonemizer');
        const t0 = Date.now();
        const { phonemize } = await import('phonemizer');
        await phonemize('Hi.', 'en-us');
        status(`probe: phonemizer ok (${Date.now() - t0}ms)`);
        if (activeId !== msg.id) return;
        status(`probe: voice fetch ${msg.voice}`);
        const t1 = Date.now();
        const res = await Promise.race([
          fetch(`https://huggingface.co/${MODEL_ID}/resolve/main/voices/${msg.voice}.bin`)
            .catch((e) => ({ error: e?.message || String(e) })),
          new Promise((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]);
        status(
          res == null
            ? 'probe: voice fetch TIMED OUT (20s)'
            : res.error
              ? `probe: voice fetch failed: ${res.error}`
              : `probe: voice fetch ${res.status} (${Date.now() - t1}ms)`,
        );
        if (activeId !== msg.id) return;
      }
      status(`synthesizing (${loadedWith.device}/${loadedWith.dtype})`);
      // kokoro-js never close()s the splitter it creates for plain-string
      // input, so its generator withholds the final sentence and never
      // terminates (no `done`, UI stuck on Stop). Own the splitter lifecycle.
      const splitter = new TextSplitterStreamCtor();
      splitter.push(msg.text);
      splitter.close();
      let firstChunk = true;
      for await (const { text, audio } of tts.stream(splitter, { voice: msg.voice })) {
        if (activeId !== msg.id) return; // stopped mid-generation
        const samples = audio.audio;
        if (firstChunk) {
          firstChunk = false;
          if (!hasAudibleSignal(samples)) {
            const e = new Error(`${loadedWith.device}/${loadedWith.dtype} produced silent audio`);
            e.silentAudio = true;
            throw e;
          }
        }
        post(
          { type: 'chunk', id: msg.id, samples, sampleRate: audio.sampling_rate, text },
          [samples.buffer],
        );
      }
      if (activeId === msg.id) post({ type: 'done', id: msg.id });
    } catch (err) {
      const wasWebGpu = loadedWith?.device === 'webgpu';
      ttsPromise = null; // let a later speak retry the load
      loadedWith = null;
      // Silent output from WebGPU: retry this same speak once on wasm rather
      // than surfacing an error the user can only fix by pressing Play again.
      if (err?.silentAudio && wasWebGpu && !avoidWebGpu && activeId === msg.id) {
        avoidWebGpu = true;
        status('webgpu produced silent audio — falling back to wasm');
        return handle(msg);
      }
      post({ type: 'error', id: msg.id, message: err?.message || String(err) });
    }
  }

  return { handle };
}
