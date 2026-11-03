/**
 * Screenshots for docs/design/phase6b-comparison.md, so the bubbles and panel can sit next to the
 * design board.
 *
 *   npm run build
 *   npx electron scripts/capture-ui.mjs [output dir]
 *
 * Captures, each at the board's own size (1280x860):
 * - design-board.png: the "SMOI speech bubble and panel" board, rendered from
 *   docs/design/smoi-character-design.html exactly as stored;
 * - build-gallery.png: the app's own BubbleView and PanelView components, laid out like the board
 *   (src/renderer/gallery-main.tsx).
 * These are page renders, not desktop screenshots; scripts/desktop-check.ts takes the real
 * desktop captures.
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = resolve(DESKTOP, '..', 'docs', 'design', 'smoi-character-design.html');
const out = resolve(process.argv[2] ?? join(DESKTOP, '..', 'docs', 'design', 'phase6b'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scriptJson(html, type) {
  const start = html.indexOf(`<script type="__bundler/${type}"`);
  const open = html.indexOf('>', start) + 1;
  return JSON.parse(html.slice(open, html.indexOf('</script>', open)));
}

/** The board page, unchanged, as its own HTML file (the design file bundles six such pages). */
function boardFile(title) {
  const manifest = scriptJson(readFileSync(DESIGN, 'utf8'), 'manifest');
  for (const a of Object.values(manifest)) {
    if (a.mime !== 'text/html') continue;
    const raw = Buffer.from(a.data, 'base64');
    const html = (a.compressed ? gunzipSync(raw) : raw).toString('utf8');
    if (scriptJson(html, 'template').includes(`<title>${title}</title>`)) {
      const file = join(mkdtempSync(join(tmpdir(), 'smoi-board-')), 'board.html');
      writeFileSync(file, html);
      return file;
    }
  }
  throw new Error(`No board titled ${title}`);
}

async function capture(load, name) {
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await load(win);
  await sleep(2500); // fonts, images and the pop-in animation
  writeFileSync(join(out, name), (await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 860 })).toPNG());
  console.log(`saved ${join(out, name)}`);
  win.destroy();
}

app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  await capture((w) => w.loadFile(boardFile('SMOI speech bubble and panel')), 'design-board.png');
  await capture((w) => w.loadFile(join(DESKTOP, 'dist', 'gallery.html')), 'build-gallery.png');
  app.quit();
});
