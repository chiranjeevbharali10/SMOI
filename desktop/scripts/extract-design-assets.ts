/**
 * Extracts SMOI's art from docs/design/smoi-character-design.html, unchanged.
 *
 *   npm run extract-assets
 *
 * The design file is a nested bundle:
 *   - the outer page's <script type="__bundler/manifest"> maps ids to six board pages (base64,
 *     gzipped when "compressed" is true);
 *   - each board page has its own manifest of images and fonts, and a __bundler/template (the
 *     board's HTML) whose <img src="<asset id>" alt="..."> says what each image is.
 *
 * Images are written byte for byte as stored. Nothing is redrawn or recoloured; the only
 * rasterisation is the tray icon, which the design defines as a 22x22 SVG.
 *
 * Fonts: the bundle only holds subsets (its @font-face rules carry unicode-range limits), so the
 * complete Pixelify Sans and Nunito files, with their OFL licences, are downloaded once from the
 * google/fonts repository and committed. The app never loads fonts from Google at runtime.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, '..');
const DESIGN = resolve(DESKTOP, '..', 'docs', 'design', 'smoi-character-design.html');
const ASSETS = join(DESKTOP, 'assets');
const FIXTURES = join(DESKTOP, 'test', 'fixtures', 'gifs');

type Asset = { mime: string; compressed?: boolean; data: string };
type Page = { title: string; assets: Record<string, Asset>; template: string };

function scriptJson(html: string, type: string): unknown {
  const m = html.match(new RegExp(`<script type="__bundler/${type}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) throw new Error(`No __bundler/${type} script`);
  return JSON.parse(m[1]);
}

function bytes(asset: Asset): Buffer {
  const raw = Buffer.from(asset.data, 'base64');
  return asset.compressed ? gunzipSync(raw) : raw;
}

function loadPages(): Page[] {
  const outer = readFileSync(DESIGN, 'utf8');
  const manifest = scriptJson(outer, 'manifest') as Record<string, Asset>;
  return Object.values(manifest)
    .filter((a) => a.mime === 'text/html')
    .map((a) => {
      const html = bytes(a).toString('utf8');
      const template = scriptJson(html, 'template') as string;
      const title = template.match(/<title>(.*?)<\/title>/)?.[1] ?? '';
      return { title, assets: scriptJson(html, 'manifest') as Record<string, Asset>, template };
    });
}

function page(pages: Page[], title: string): Page {
  const p = pages.find((x) => x.title === title);
  if (!p) throw new Error(`Board "${title}" not found; boards: ${pages.map((x) => x.title).join(', ')}`);
  return p;
}

/** alt text -> asset bytes, for every <img> on a board. */
function imagesByAlt(p: Page): Map<string, { mime: string; data: Buffer }> {
  const out = new Map<string, { mime: string; data: Buffer }>();
  for (const m of p.template.matchAll(/<img[^>]*src="([0-9a-f-]{36})"[^>]*alt="([^"]*)"/g)) {
    const asset = p.assets[m[1]];
    if (asset) out.set(m[2], { mime: asset.mime, data: bytes(asset) });
  }
  return out;
}

function write(path: string, data: Buffer | string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function pngSize(data: Buffer): [number, number] {
  const png = PNG.sync.read(data);
  return [png.width, png.height];
}

export const STATES = ['idle', 'happy', 'sleeping', 'working', 'thinking', 'surprised', 'annoyed',
  'celebrating', 'listening', 'speaking', 'walking', 'error'] as const;

function extractSprites(pages: Page[]) {
  const images = imagesByAlt(page(pages, 'SMOI sprite sheet'));
  for (const state of STATES) {
    const label = state[0].toUpperCase() + state.slice(1);
    const strip = images.get(`${label} frames`);
    const gif = images.get(`${label} animation`);
    if (!strip || strip.mime !== 'image/png') throw new Error(`Missing PNG strip for ${state}`);
    if (!gif || gif.mime !== 'image/gif') throw new Error(`Missing GIF for ${state}`);
    write(join(ASSETS, 'sprites', `${state}.png`), strip.data);
    // GIFs are for checking frame order only (they merge duplicate frames), so they live with the tests.
    write(join(FIXTURES, `${state}.gif`), gif.data);
    const [w, h] = pngSize(strip.data);
    console.log(`sprite  ${state.padEnd(12)} ${w}x${h} (${w / 64} frames)`);
  }
}

function extractExpressions(pages: Page[]) {
  const images = imagesByAlt(page(pages, 'SMOI expressions'));
  for (const [alt, img] of images) {
    // "Joyful face with arched eyes" -> joyful
    const name = alt.split(' ')[0].toLowerCase();
    const [w, h] = pngSize(img.data);
    if (w !== 48 || h !== 40) throw new Error(`Expression ${alt} is ${w}x${h}, expected 48x40`);
    write(join(ASSETS, 'expressions', `${name}.png`), img.data);
    console.log(`face    ${name}`);
  }
}

function extractTurnaround(pages: Page[]) {
  const images = imagesByAlt(page(pages, 'SMOI turnaround'));
  const names: Record<string, string> = {
    'SMOI from the front': 'front', 'SMOI in three-quarter view': 'three-quarter', 'SMOI from the side': 'side',
  };
  for (const [alt, name] of Object.entries(names)) {
    const img = images.get(alt);
    if (!img) throw new Error(`Missing turnaround image "${alt}"`);
    const [w, h] = pngSize(img.data);
    if (w !== 64 || h !== 64) throw new Error(`Turnaround ${name} is ${w}x${h}, expected 64x64`);
    write(join(ASSETS, 'turnaround', `${name}.png`), img.data);
    console.log(`view    ${name}`);
  }
}

async function extractTrayIcon(pages: Page[]) {
  const board = page(pages, 'SMOI on a Windows desktop');
  const svg = board.template.match(/<svg[^>]*width="22"[^>]*height="22"[^>]*>[\s\S]*?<\/svg>/)?.[0];
  if (!svg) throw new Error('No 22x22 tray SVG on the desktop board');
  // The bundler renamed viewBox; restore it and add the namespace so the SVG stands alone.
  const clean = svg
    .replace(/sc-camel-view-box=/g, 'viewBox=')
    .replace(/\s(role|aria-label)="[^"]*"/g, '')
    .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  write(join(ASSETS, 'icons', 'tray.svg'), clean + '\n');
  // Windows uses 16 px at 100% and up to 32 px at 200%; installers and the taskbar want up to 256.
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs: Buffer[] = [];
  for (const size of sizes) {
    const png = new Resvg(clean, { fitTo: { mode: 'width', value: size } }).render().asPng();
    write(join(ASSETS, 'icons', `tray-${size}.png`), png);
    pngs.push(png);
  }
  const ico = await pngToIco(sizes.filter((s) => [16, 24, 32, 48, 64, 256].includes(s))
    .map((s) => pngs[sizes.indexOf(s)]));
  write(join(ASSETS, 'icons', 'smoi.ico'), ico);
  console.log(`icon    tray.svg, ${sizes.length} PNG sizes, smoi.ico`);
}

const FONTS = [
  { family: 'Pixelify Sans', dir: 'pixelifysans', file: 'PixelifySans[wght].ttf', out: 'PixelifySans.ttf' },
  { family: 'Nunito', dir: 'nunito', file: 'Nunito[wght].ttf', out: 'Nunito.ttf' },
];

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fonts(pages: Page[]) {
  // Coverage check: list the unicode ranges the bundled faces were cut to.
  const seen = new Set<string>();
  for (const p of pages) {
    for (const rule of p.template.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const family = rule[1].match(/font-family:\s*'([^']+)'/)?.[1];
      const range = rule[1].match(/unicode-range:\s*([^;]+);/)?.[1];
      if (family && FONTS.some((f) => f.family === family) && range && !seen.has(family + range)) {
        seen.add(family + range);
        console.log(`font    bundled ${family} subset: ${range.slice(0, 60)}${range.length > 60 ? '…' : ''}`);
      }
    }
  }
  const base = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
  for (const f of FONTS) {
    const target = join(ASSETS, 'fonts', f.out);
    if (!existsSync(target)) {
      write(target, await fetchBytes(`${base}/${f.dir}/${encodeURIComponent(f.file)}`));
      write(join(ASSETS, 'fonts', `${f.out.replace('.ttf', '')}-OFL.txt`), await fetchBytes(`${base}/${f.dir}/OFL.txt`));
    }
    const sha = createHash('sha256').update(readFileSync(target)).digest('hex').slice(0, 16);
    console.log(`font    ${f.family}: complete file ${f.out} (sha256 ${sha}…), OFL licence alongside`);
  }
}

async function main() {
  const pages = loadPages();
  console.log(`Boards: ${pages.map((p) => p.title).join(' | ')}`);
  extractSprites(pages);
  extractExpressions(pages);
  extractTurnaround(pages);
  await extractTrayIcon(pages);
  await fonts(pages);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
