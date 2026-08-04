// Worker half of the WebKit TTS debug harness: identical sequence to
// ttsdebug.js but inside a dedicated module worker.
const log = (m) => postMessage({ log: m });

(async () => {
  log(`worker alive; SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}, gpu: ${!!globalThis.navigator?.gpu}, DecompressionStream: ${typeof DecompressionStream}`);
  try {
    log('phonemizer: importing module');
    const mod = await import('phonemizer');
    log('phonemizer: module evaluated');
    const t = Date.now();
    const ph = await mod.phonemize('Hello world, this is a test.', 'en-us');
    log(`phonemizer: first call ok (${Date.now() - t}ms): ${JSON.stringify(ph).slice(0, 80)}`);
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
    log(`kokoro FAILED: ${e?.message || e}\n${(e?.stack || '').slice(0, 400)}`);
  }
})();
