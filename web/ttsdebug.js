// Temporary WebKit-debug harness for the kokoro-js hang (not part of the SPA).
// Runs the exact same stack as web/src/tts/kokoroEngine.js but with each
// phase timed and logged to window.__log for a Playwright poller.
const out = [];
window.__log = out;
const log = (m) => {
  out.push(`${(performance.now() / 1000).toFixed(1)}s ${m}`);
  document.getElementById('out').textContent = out.join('\n');
  console.log(m);
};
window.addEventListener('error', (e) => log(`window error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`unhandled rejection: ${e.reason?.message || e.reason}`));

(async () => {
  log(`ua: ${navigator.userAgent}`);
  log(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}, gpu: ${!!navigator.gpu}`);

  try {
    log('importing phonemizer');
    const { phonemize } = await import('phonemizer');
    log('phonemizer imported; phonemizing test sentence');
    const ph = await phonemize('Hello world, this is a test.', 'en-us');
    log(`phonemize ok: ${JSON.stringify(ph).slice(0, 100)}`);
  } catch (e) {
    log(`phonemizer FAILED: ${e?.message || e}`);
  }

  try {
    log('importing kokoro-js');
    const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
    log('kokoro imported');
    if (typeof SharedArrayBuffer === 'undefined') {
      const { env } = await import('@huggingface/transformers');
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        log('pinned ort wasm numThreads=1 proxy=false');
      }
    }
    log('loading model wasm/q8');
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status !== 'progress') log(`model ${p.status}${p.file ? ': ' + p.file : ''}`);
      },
    });
    log('model ready; synthesizing');
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
