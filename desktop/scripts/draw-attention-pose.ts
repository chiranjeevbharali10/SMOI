/**
 * Draws the DRAFT "attention" pose (Claude Code is waiting for permission) from existing art:
 *   - the body is the last frame of surprised.png (wide eyes, standing), unchanged;
 *   - the badge is the pink badge from listening.png, with its mic glyph replaced by a "!";
 *   - the badge bobs up and down by up to 2 px; the frog itself stays still.
 * Only pixels and colours already in the design are used (checked in test/sprites.test.ts).
 *
 *   npx tsx scripts/draw-attention-pose.ts
 *
 * Draft until the owner approves it (CLAUDE.md: never restyle the art without asking).
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

const BADGE = { x0: 46, x1: 61, y0: 3, y1: 17 };
// Badge pixels from listening frame 0; the badge sits apart from the frog except where its outline
// touches the head, so take only pink and the outline pixels inside the badge's circle.
function badgePixels(): { x: number; y: number; rgba: number[] }[] {
  const out = [];
  const cx = 53.5, cy = 10;
  for (let y = BADGE.y0; y <= BADGE.y1; y++)
    for (let x = BADGE.x0; x <= BADGE.x1; x++) {
      if (Math.hypot(x - cx, y - cy) > 8.2) continue;
      const i = (y * listening.width + x) * 4;
      if (!listening.data[i + 3]) continue;
      out.push({ x, y, rgba: [...listening.data.subarray(i, i + 4)] });
    }
  // Replace the mic glyph (inside the circle) with pink, then draw "!".
  for (const p of out) if (Math.hypot(p.x - cx, p.y - cy) < 6.3) p.rgba = [...PINK, 255];
  for (const p of out) {
    const bar = (p.x === 53 || p.x === 54) && p.y >= 6 && p.y <= 11;
    const dot = (p.x === 53 || p.x === 54) && p.y === 13;
    if (bar || dot) p.rgba = [...INK, 255];
  }
  return out;
}

const bob = [0, -1, -2, -1, 0, 0];
const out = new PNG({ width: CELL * bob.length, height: CELL });
const badge = badgePixels();
const body = 5; // surprised's last frame
for (let f = 0; f < bob.length; f++) {
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const s = (y * surprised.width + body * CELL + x) * 4;
      const d = (y * out.width + f * CELL + x) * 4;
      surprised.data.copy(out.data, d, s, s + 4);
    }
  for (const p of badge) {
    const y = p.y + bob[f] + 1;
    const d = (y * out.width + f * CELL + p.x) * 4;
    out.data.set(p.rgba, d);
  }
}
writeFileSync(join(SPRITES, 'attention.png'), PNG.sync.write(out));
console.log('wrote assets/sprites/attention.png');
