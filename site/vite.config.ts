import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { info, loadRoster } from '../desktop/src/shared/companions';

/**
 * The launch page reuses the desktop app instead of copying it:
 * - `@desktop` imports its components and shared code (bubbles, panel, sprites, personality);
 * - `publicDir` serves its assets folder as-is (sprites, expressions, fonts), so the art on the
 *   page is the app's art, byte for byte.
 * React is pinned to this package's copy, so desktop files don't pick up a second React.
 */
const here = import.meta.dirname;
const desktop = resolve(here, '../desktop');
const assets = join(desktop, 'assets');

/**
 * `virtual:smoi-roster`: every companion's manifest, validated by the desktop's own loader at
 * build time, so the page shows the same names, lines, palettes and poses as the app.
 */
function roster(): Plugin {
  const id = 'virtual:smoi-roster';
  const read = (p: string) => {
    try {
      return readFileSync(join(assets, 'companions', p));
    } catch {
      return null;
    }
  };
  return {
    name: 'smoi-roster',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(loaded) {
      if (loaded !== `\0${id}`) return null;
      const r = loadRoster({ text: (p) => read(p)?.toString('utf8') ?? null, bytes: (p) => read(p) });
      for (const e of r.errors) this.warn(`companion ${e.id}: ${e.reason}`);
      return `export default ${JSON.stringify({ defaultId: r.defaultId, companions: r.companions.map(info) })};`;
    },
  };
}

/**
 * Link previews need an absolute image URL. On Vercel, the production hostname is in
 * VERCEL_PROJECT_PRODUCTION_URL at build time; locally the relative path is kept.
 */
function absoluteOgImage(): Plugin {
  return {
    name: 'smoi-og-image',
    transformIndexHtml: (html) => {
      const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      return host ? html.replace('content="/og-card.png"', `content="https://${host}/og-card.png"`) : html;
    },
  };
}

const pin = (name: string) => resolve(here, 'node_modules', name);

export default defineConfig({
  base: '/',
  publicDir: assets,
  plugins: [react(), roster(), absoluteOgImage()],
  resolve: {
    alias: [
      { find: '@desktop', replacement: join(desktop, 'src') },
      { find: /^react$/, replacement: pin('react') },
      { find: /^react\/(.*)$/, replacement: `${pin('react')}/$1` },
      { find: /^react-dom$/, replacement: pin('react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: `${pin('react-dom')}/$1` },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 5180, fs: { allow: [here, desktop] } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
