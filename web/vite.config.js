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
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
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
