import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);

// Set WEB_BASE_PATH at build time when the SPA is served behind a path prefix
// (e.g. WEB_BASE_PATH=/lucas/ when reverse-proxied at https://host/lucas/).
// Must end with a trailing slash. Defaults to '/' (served at the root).
const base = process.env.WEB_BASE_PATH || '/';

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
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/image': 'http://localhost:3000',
      '/attachment': 'http://localhost:3000',
      '/pdf': 'http://localhost:3000',
    },
  },
});
