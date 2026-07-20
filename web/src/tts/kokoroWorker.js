// Module worker running Kokoro-82M via kokoro-js/Transformers.js. This is the
// ONLY file allowed to import kokoro-js — keeping the heavy dependency out of
// the main SPA bundle. Loads fp32 on WebGPU when an adapter is available,
// q8 on WASM otherwise. The model is loaded once and cached for the worker's
// lifetime (network layer caches the ~310MB download across sessions).
//
// Protocol: see web/src/tts/ttsClient.js.

let ttsPromise = null;
let activeId = 0;

let TextSplitterStreamCtor = null;

async function loadModel() {
  const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
  TextSplitterStreamCtor = TextSplitterStream;
  let device = 'wasm';
  try {
    // requestAdapter() can hang indefinitely on some platforms (observed on
    // WSL Chrome) — race it against a timeout so a broken GPU stack degrades
    // to wasm instead of stalling the model load forever.
    const adapter = await Promise.race([
      Promise.resolve(globalThis.navigator?.gpu?.requestAdapter() ?? null),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (adapter) device = 'webgpu';
  } catch {
    // adapter probe failed — stay on wasm
  }
  const dtype = device === 'webgpu' ? 'fp32' : 'q8';
  const files = new Map();
  let lastPct = -1;
  return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      // Raw callbacks fire per network chunk (thousands per download) and each
      // posted message becomes a React render on the main thread — only post
      // when the whole-percent value moves.
      const pct = Math.floor((loaded / total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      postMessage({ type: 'progress', loaded, total });
    },
  });
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    if (msg.id === activeId) activeId = 0;
    return;
  }
  if (msg.type !== 'speak') return;
  activeId = msg.id;
  try {
    ttsPromise ||= loadModel();
    const tts = await ttsPromise;
    if (activeId !== msg.id) return; // stopped while loading
    // kokoro-js never close()s the splitter it creates for plain-string input,
    // so its generator withholds the final sentence and never terminates
    // (no `done`, UI stuck on Stop). Own the splitter lifecycle instead.
    const splitter = new TextSplitterStreamCtor();
    splitter.push(msg.text);
    splitter.close();
    for await (const { text, audio } of tts.stream(splitter, { voice: msg.voice })) {
      if (activeId !== msg.id) return; // stopped mid-generation
      const samples = audio.audio;
      postMessage(
        { type: 'chunk', id: msg.id, samples, sampleRate: audio.sampling_rate, text },
        [samples.buffer],
      );
    }
    if (activeId === msg.id) postMessage({ type: 'done', id: msg.id });
  } catch (err) {
    ttsPromise = null; // let a later speak retry the load
    postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
