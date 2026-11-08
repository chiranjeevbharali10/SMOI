/**
 * Renders the link-preview card (dist/og-card.png, 1200x630) from the README banner
 * (docs/readme/banner.svg), with the app's own fonts. Runs after `vite build`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(import.meta.dirname, '../..');
const fonts = join(root, 'desktop/assets/fonts');
const W = 1200;
const H = 630;
const bannerW = 1120;
const bannerH = Math.round((bannerW * 300) / 960);

const banner = readFileSync(join(root, 'docs/readme/banner.svg'), 'utf8')
  // resvg doesn't read @font-face, so point the banner's font names at the real font files instead.
  .replace(/@font-face[^}]*}/g, '')
  .replaceAll('"SmoiPixel"', '"Pixelify Sans"')
  .replaceAll('"SmoiNunito"', 'Nunito')
  .replace('width="960" height="300"', `x="${(W - bannerW) / 2}" y="${(H - bannerH) / 2}" width="${bannerW}" height="${bannerH}"`);

const card = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#FFF1D6"/>
${banner.replace(/^<\?xml[^>]*>/, '')}
</svg>`;

const png = new Resvg(card, {
  font: {
    fontFiles: [join(fonts, 'PixelifySans.ttf'), join(fonts, 'Nunito.ttf')],
    loadSystemFonts: false,
    defaultFontFamily: 'Nunito',
  },
}).render().asPng();
writeFileSync(join(import.meta.dirname, '../dist/og-card.png'), png);
console.log(`dist/og-card.png ${W}x${H}`);
