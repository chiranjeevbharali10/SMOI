import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The pages ship with a strict Content-Security-Policy. The dev server needs a looser one (React
 * Fast Refresh injects an inline script and uses a websocket, and Vite injects CSS as inline
 * <style> tags), so only `vite serve` relaxes it. Without the style-src change, `npm run dev`
 * shows every page unstyled.
 */
const devCsp: Plugin = {
  name: 'smoi-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    .replace("connect-src 'self'", "connect-src 'self' ws://localhost:5173"),
};

// The renderer pages: the frog, its speech bubble and menu panel, the dashboard, and two dev-only
// pages (the animation preview, and the gallery used for design screenshots).
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
        bubble: resolve(import.meta.dirname, 'src/renderer/bubble.html'),
        panel: resolve(import.meta.dirname, 'src/renderer/panel.html'),
        dashboard: resolve(import.meta.dirname, 'src/renderer/dashboard.html'),
        gallery: resolve(import.meta.dirname, 'src/renderer/gallery.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
