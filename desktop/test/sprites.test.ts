import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CELL, CORE_STATES, totalDuration } from '../src/shared/animations';
import type { Pose } from '../src/shared/companions';
import { readRoster } from '../src/main/companionRoster';

/**
 * The art as shipped: every companion's sheet against its own preview GIFs, frame by frame, with
 * the manifest's timings. Nothing is redrawn; this checks the manifests describe the sheets.
 */
const ROOT = join(__dirname, '..');
const COMPANIONS = join(ROOT, 'assets', 'companions');
const roster = readRoster(COMPANIONS, () => {});

function sheet(id: string, file: string): PNG {
  return PNG.sync.read(readFileSync(join(COMPANIONS, id, file)));
}

/** RGBA bytes of one 64x64 cell. */
function cell(png: PNG, row: number, index: number): Buffer {
  const out = Buffer.alloc(CELL * CELL * 4);
  for (let y = 0; y < CELL; y++) {
    const from = ((row * CELL + y) * png.width + index * CELL) * 4;
    png.data.copy(out, y * CELL * 4, from, from + CELL * 4);
  }
  return out;
}

/** Every frame of a GIF, fully composited (as a viewer shows it), with its delay in ms. */
function gifFrames(path: string): { rgba: Buffer; delayMs: number; width: number }[] {
  const reader = new GifReader(readFileSync(path));
  const frames = [];
  let canvas = Buffer.alloc(reader.width * reader.height * 4);
  for (let i = 0; i < reader.numFrames(); i++) {
    const info = reader.frameInfo(i);
    const before = Buffer.from(canvas);
    reader.decodeAndBlitFrameRGBA(i, canvas);
    frames.push({ rgba: Buffer.from(canvas), delayMs: info.delay * 10, width: reader.width });
    if (info.disposal === 2) {
      for (let y = info.y; y < info.y + info.height; y++) {
        canvas.fill(0, (y * reader.width + info.x) * 4, (y * reader.width + info.x + info.width) * 4);
      }
    } else if (info.disposal === 3) {
      canvas = before;
    }
  }
  return frames;
}

/** Same picture: identical opaque pixels and identical transparency. */
function samePicture(a: Buffer, b: Buffer): boolean {
  for (let i = 0; i < a.length; i += 4) {
    const aOpaque = a[i + 3] > 0;
    const bOpaque = b[i + 3] > 0;
    if (aOpaque !== bOpaque) return false;
    if (aOpaque && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2])) return false;
  }
  return true;
}

/** Merges runs of identical frames, adding up their durations, as a GIF encoder does. */
function merged(png: PNG, pose: Pose) {
  const out: { rgba: Buffer; ms: number }[] = [];
  pose.frames.forEach((ms, i) => {
    const rgba = cell(png, pose.row, i);
    const last = out[out.length - 1];
    if (last && samePicture(last.rgba, rgba)) last.ms += ms;
    else out.push({ rgba, ms });
  });
  return out;
}

describe('companion roster as shipped', () => {
  it('has the five companions, all valid, with SMOI as the default', () => {
    expect(roster.errors).toEqual([]);
    expect(roster.defaultId).toBe('smoi');
    expect(roster.companions.map((c) => c.id)).toEqual(['smoi', 'numi', 'nox', 'yuzu', 'wisp']);
  });

  it('YUZU walks slowest', () => {
    const yuzu = roster.companions.find((c) => c.id === 'yuzu')!;
    for (const c of roster.companions) if (c.id !== 'yuzu') expect(c.walkSpeed).toBeGreaterThan(yuzu.walkSpeed);
  });
});

for (const c of roster.companions) {
  describe(`${c.name} (${c.creature})`, () => {
    const png = sheet(c.id, 'spritesheet.png');

    it('has only fully transparent or fully opaque pixels', () => {
      const partial = [];
      for (let i = 3; i < png.data.length; i += 4) if (png.data[i] !== 0 && png.data[i] !== 255) partial.push(png.data[i]);
      expect(partial).toEqual([]);
    });

    for (const state of CORE_STATES) {
      it(`${state}: the sheet row matches gifs/${state}.gif in frames and timing`, () => {
        const pose = c.poses[state];
        const gif = gifFrames(join(COMPANIONS, c.id, 'gifs', `${state}.gif`));
        expect(gif[0].width).toBe(CELL);
        const ours = merged(png, pose);
        expect(gif.length).toBe(ours.length);
        gif.forEach((g, i) => {
          expect(samePicture(g.rgba, ours[i].rgba), `frame ${i} picture`).toBe(true);
          expect(g.delayMs, `frame ${i} delay`).toBe(ours[i].ms);
        });
        expect(gif.reduce((t, g) => t + g.delayMs, 0)).toBe(totalDuration(pose));
      });
    }
  });
}

describe("SMOI's draft badge poses", () => {
  const smoi = roster.companions.find((c) => c.id === 'smoi')!;

  it('are extra states, marked draft, and use only colours already in SMOI’s sheet', () => {
    const palette = new Set<string>();
    const main = sheet('smoi', 'spritesheet.png');
    for (let i = 0; i < main.data.length; i += 4) if (main.data[i + 3]) palette.add(main.data.subarray(i, i + 3).join(','));
    for (const name of ['attention', 'mail', 'tasks']) {
      const pose = smoi.poses[name];
      expect(pose.draft, name).toBe(true);
      const png = sheet('smoi', pose.sheet);
      expect(png.height).toBe(CELL);
      const foreign = new Set<string>();
      for (let i = 0; i < png.data.length; i += 4) {
        const rgb = png.data.subarray(i, i + 3).join(',');
        if (png.data[i + 3] && !palette.has(rgb)) foreign.add(rgb);
      }
      expect([...foreign], name).toEqual([]);
    }
  });

  it('SMOI’s sheet is the design art, unchanged', () => {
    // The strips extracted from the design board (scripts/extract-design-assets.ts).
    const main = sheet('smoi', 'spritesheet.png');
    for (const state of CORE_STATES) {
      const strip = PNG.sync.read(readFileSync(join(ROOT, 'assets', 'sprites', `${state}.png`)));
      const pose = smoi.poses[state];
      for (let f = 0; f < pose.frames.length; f++) {
        expect(samePicture(cell(main, pose.row, f), cell(strip, 0, f)), `${state} frame ${f}`).toBe(true);
      }
    }
  });
});
