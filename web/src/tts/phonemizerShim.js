// Drop-in replacement for the `phonemizer` npm package, aliased in via
// web/vite.config.js for browser builds only (node/vitest resolve the real
// package). Same contract — phonemize(text, lang) → string[] of eSpeak IPA
// clause lines — and the same eSpeak NG engine underneath, but as a real
// WASM build (espeak-ng npm) instead of phonemizer's 1.3MB single-function
// asm.js bundle, whose parse crashes Apple WebKit builds (iOS/macOS Safari
// and every iOS browser) before a line of it runs. See kokoro-web for prior
// art on this exact swap.
import ESpeakNg from 'espeak-ng';
import wasmUrl from 'espeak-ng/dist/espeak-ng.wasm?url';

let compiled = null;
const compile = () => (compiled ||= WebAssembly.compileStreaming(fetch(wasmUrl)));

// One espeak instance per call (the build exports no re-runnable main), with
// the module compiled once. Calls are serialized: kokoro-js phonemizes text
// sections in parallel, and each live instance owns its own wasm memory —
// unbounded concurrency would stack instances on an iPhone's memory budget.
let queue = Promise.resolve();

export function phonemize(text, language = 'en-us') {
  const run = queue.then(async () => {
    if (!String(text || '').trim()) return [];
    const module = await compile();
    const espeak = await ESpeakNg({
      instantiateWasm: (imports, cb) => {
        WebAssembly.instantiate(module, imports).then((instance) => cb(instance, module));
        return {};
      },
      arguments: ['--phonout', 'generated', '-q', '--ipa', '-v', language, String(text)],
    });
    const out = espeak.FS.readFile('generated', { encoding: 'utf8' });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  });
  queue = run.catch(() => {}); // keep the chain alive after a failed call
  return run;
}
