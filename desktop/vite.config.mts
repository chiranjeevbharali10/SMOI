import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The pages ship with a strict Content-Security-Policy. The dev server needs a looser one (React
 * Fast Refresh injects an inline script and uses a websocket), so only `vite serve` relaxes it.
 */
const devCsp: Plugin = {
  name: 'smoi-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("connect-src 'self'", "connect-src 'self' ws://localhost:5173"),
};

// The renderer: the frog window (index.html) and the dev-only animation preview (preview.html).
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(import.meta.dirname, 'assets'),
  plugins: [react(), devCsp],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        frog: resolve(import.meta.dirname, 'src/renderer/index.html'),
        preview: resolve(import.meta.dirname, 'src/renderer/preview.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
  },
});
