/**
 * Draws the DRAFT badge poses from existing art. Each is the last frame of surprised.png (wide
 * eyes, standing), unchanged, with listening.png's pink badge whose mic glyph is replaced:
 *   - attention.png: "!"   Claude Code is waiting for permission (FR-10.04)
 *   - mail.png:      an envelope   new email since the inbox was last opened
 *   - tasks.png:     a tick        tasks are overdue
 * The badge bobs up and down by up to 2 px; the frog itself stays still. Only pixels and colours
 * already in the design are used (checked in test/sprites.test.ts).
 *
 *   npx tsx scripts/draw-attention-pose.ts
 *
 * Drafts until the owner approves them (CLAUDE.md: never restyle the art without asking).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const SPRITES = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'assets', 'sprites');
const CELL = 64;
const read = (s: string) => PNG.sync.read(readFileSync(join(SPRITES, `${s}.png`)));
const surprised = read('surprised');
const listening = read('listening');
const PINK = [0xf6, 0xc8, 0xd5];
const INK = [0x51, 0x4b, 0x50];
const WHITE = [0xff, 0xff, 0xff];
const CX = 53.5;
const CY = 10;

type Px = { x: number; y: number; rgba: number[] };

/** The pink badge from listening frame 0, with its inside cleared to pink. */
function badge(): Px[] {
  const out: Px[] = [];
  for (let y = 3; y <= 17; y++)
    for (let x = 46; x <= 61; x++) {
      if (Math.hypot(x - CX, y - CY) > 8.2) continue;
      const i = (y * listening.width + x) * 4;
      if (!listening.data[i + 3]) continue;
      out.push({ x, y, rgba: [...listening.data.subarray(i, i + 4)] });
    }
  for (const p of out) if (Math.hypot(p.x - CX, p.y - CY) < 6.3) p.rgba = [...PINK, 255];
  return out;
}

/** Glyphs as rows of characters: '#' ink, 'w' white, '.' leave pink. Top-left at (x0, y0). */
function glyph(rows: string[], x0: number, y0: number): Map<string, number[]> {
  const m = new Map<string, number[]>();
  rows.forEach((row, dy) => [...row].forEach((c, dx) => {
    if (c === '#') m.set(`${x0 + dx},${y0 + dy}`, [...INK, 255]);
    if (c === 'w') m.set(`${x0 + dx},${y0 + dy}`, [...WHITE, 255]);
  }));
  return m;
}

const GLYPHS: Record<string, Map<string, number[]>> = {
  attention: glyph(['##', '##', '##', '##', '##', '##', '..', '##'], 53, 6),
  mail: glyph([
    '#######',
    '##www##',
    '#w#w#w#',
    '#ww#ww#',
    '#######',
  ], 50, 8),
  tasks: glyph([
    '......#',
    '.....##',
    '#...##.',
    '##.##..',
    '.###...',
    '..#....',
  ], 50, 7),
};

const bob = [0, -1, -2, -1, 0, 0];
for (const [name, g] of Object.entries(GLYPHS)) {
  const out = new PNG({ width: CELL * bob.length, height: CELL });
  const pixels = badge().map((p) => ({ ...p, rgba: g.get(`${p.x},${p.y}`) ?? p.rgba }));
  for (let f = 0; f < bob.length; f++) {
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) {
        const s = (y * surprised.width + 5 * CELL + x) * 4;
        surprised.data.copy(out.data, (y * out.width + f * CELL + x) * 4, s, s + 4);
      }
    for (const p of pixels) out.data.set(p.rgba, ((p.y + bob[f] + 1) * out.width + f * CELL + p.x) * 4);
  }
  writeFileSync(join(SPRITES, `${name}.png`), PNG.sync.write(out));
  console.log(`wrote assets/sprites/${name}.png`);
}
