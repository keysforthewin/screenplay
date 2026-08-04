import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);

// Set WEB_BASE_PATH at build time when the SPA is served behind a path prefix
// (e.g. WEB_BASE_PATH=/lucas/ when reverse-proxied at https://host/lucas/).
// Must end with a trailing slash. Defaults to '/' (served at the root).
const base = process.env.WEB_BASE_PATH || '/';

// Backend address Vite proxies /api, /auth, /image, /attachment, /pdf to.
// On the host this is the local Express server; inside Docker dev it's the
// `bot` service, so we override via VITE_API_TARGET=http://bot:3000.
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  root,
  base,
  plugins: [react()],
  resolve: {
    alias: [
      // kokoro-js's espeak dependency ("phonemizer") ships a 1.3MB asm.js
      // bundle that crashes Apple WebKit's parser — every iOS browser freezes
      // evaluating it. Swap in our shim over the real-WASM espeak-ng build
      // (same engine, same output). Exact-match so only the bare id rewrites.
      { find: /^phonemizer$/, replacement: path.resolve(root, 'src/tts/phonemizerShim.js') },
    ],
  },
  // kokoroWorker.js dynamically imports kokoro-js, which forces Rollup to
  // code-split the worker bundle — the default 'iife' worker format can't
  // support that, so the TTS worker (only reachable once something imports
  // tts/controller.js, as of the beat-page Play button) needs 'es'.
  worker: {
    format: 'es',
  },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // The ttsdebug pages are a device-debugging harness for the client-side
      // TTS stack (kokoro-js hangs on some iOS builds) — shipping them lets a
      // real phone report per-phase timings at /ttsdebug.html (main thread)
      // and /ttsdebugw.html (worker). Remove once the iOS TTS saga is over.
      input: {
        main: path.resolve(root, 'index.html'),
        ttsdebug: path.resolve(root, 'ttsdebug.html'),
        ttsdebugw: path.resolve(root, 'ttsdebugw.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/auth': apiTarget,
      '/image': apiTarget,
      '/attachment': apiTarget,
      '/pdf': apiTarget,
    },
  },
});
