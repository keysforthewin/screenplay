// Temporary WebKit/iOS-debug harness for the kokoro-js hang (not part of the
// SPA; also built into dist so real devices can run it at /ttsdebug.html).
// Runs the same stack as web/src/tts/kokoroEngine.js with each phase timed
// and logged to the page + window.__log.
const out = [];
window.__log = out;
const log = (m) => {
  out.push(`${(performance.now() / 1000).toFixed(1)}s ${m}`);
  document.getElementById('out').textContent = out.join('\n');
  console.log(m);
};
window.addEventListener('error', (e) => log(`window error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`unhandled rejection: ${e.reason?.message || e.reason}`));

// Visible liveness signal: keeps counting while the JS thread is responsive.
// If a step "hangs" but this keeps ticking → an await never resolved. If this
// freezes too → the thread is blocked (or the page was killed).
let beats = 0;
setInterval(() => {
  beats += 1;
  document.getElementById('hb').textContent = `heartbeat: ${beats}s`;
}, 1000);

(async () => {
  log(`ua: ${navigator.userAgent}`);
  log(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}, gpu: ${!!navigator.gpu}, DecompressionStream: ${typeof DecompressionStream}`);

  try {
    log('phonemizer: importing module');
    const mod = await import('phonemizer');
    log('phonemizer: module evaluated');
    const t = performance.now();
    const ph = await mod.phonemize('Hello world, this is a test.', 'en-us');
    log(`phonemizer: first call ok (${(performance.now() - t).toFixed(0)}ms): ${JSON.stringify(ph).slice(0, 80)}`);
  } catch (e) {
    log(`phonemizer FAILED: ${e?.message || e}`);
  }

  try {
    log('kokoro: importing module');
    const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
    log('kokoro: module evaluated');
    if (typeof SharedArrayBuffer === 'undefined') {
      const { env } = await import('@huggingface/transformers');
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        log('pinned ort wasm numThreads=1 proxy=false');
      }
    }
    log('kokoro: loading model wasm/q8');
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status !== 'progress') log(`model ${p.status}${p.file ? ': ' + p.file : ''}`);
      },
    });
    log('kokoro: model ready; synthesizing');
    const splitter = new TextSplitterStream();
    splitter.push('Hello world. This is a longer second sentence to synthesize for timing.');
    splitter.close();
    for await (const { text, audio } of tts.stream(splitter, { voice: 'af_heart' })) {
      log(`chunk: ${audio.audio.length} samples "${(text || '').slice(0, 40)}"`);
    }
    log('ALL DONE');
  } catch (e) {
    log(`kokoro FAILED: ${e?.message || e}\n${(e?.stack || '').slice(0, 500)}`);
  }
})();
