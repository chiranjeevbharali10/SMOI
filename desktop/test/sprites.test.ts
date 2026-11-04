import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ANIMATIONS, CELL, DRAFT_STATES, STATES, totalDuration, type FrogState } from '../src/shared/animations';

const DESIGN_STATES = STATES.filter((s) => !DRAFT_STATES.includes(s));

const ROOT = join(__dirname, '..');

function strip(state: FrogState): PNG {
  return PNG.sync.read(readFileSync(join(ROOT, 'assets', 'sprites', `${state}.png`)));
}

/** RGBA bytes of one 64x64 cell of a strip. */
function cell(png: PNG, index: number): Buffer {
  const out = Buffer.alloc(CELL * CELL * 4);
  for (let y = 0; y < CELL; y++) {
    const from = (y * png.width + index * CELL) * 4;
    png.data.copy(out, y * CELL * 4, from, from + CELL * 4);
  }
  return out;
}

/** Every frame of a GIF, fully composited (as a viewer shows it), with its delay in ms. */
function gifFrames(state: FrogState): { rgba: Buffer; delayMs: number; width: number }[] {
  const reader = new GifReader(readFileSync(join(ROOT, 'test', 'fixtures', 'gifs', `${state}.gif`)));
  const frames = [];
  let canvas = Buffer.alloc(reader.width * reader.height * 4);
  for (let i = 0; i < reader.numFrames(); i++) {
    const info = reader.frameInfo(i);
    const before = Buffer.from(canvas);
    reader.decodeAndBlitFrameRGBA(i, canvas);
    frames.push({ rgba: Buffer.from(canvas), delayMs: info.delay * 10, width: reader.width });
    if (info.disposal === 2) {
      // Restore to background (transparent) inside the frame's rectangle.
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

describe('sprite strips', () => {
  it('has 82 frames across the 12 design states', () => {
    expect(DESIGN_STATES).toHaveLength(12);
    expect(DESIGN_STATES.reduce((n, s) => n + ANIMATIONS[s].frames.length, 0)).toBe(82);
  });

  it('draft states are one row of 64x64 cells using only colours already in the design sprites', () => {
    const palette = new Set<string>();
    for (const s of DESIGN_STATES) {
      const png = strip(s);
      for (let i = 0; i < png.data.length; i += 4) if (png.data[i + 3]) palette.add(png.data.subarray(i, i + 3).join(','));
    }
    for (const s of DRAFT_STATES) {
      const png = strip(s);
      expect(png.height).toBe(CELL);
      expect(png.width / CELL).toBe(ANIMATIONS[s].frames.length);
      const foreign = new Set<string>();
      for (let i = 0; i < png.data.length; i += 4) {
        const rgb = png.data.subarray(i, i + 3).join(',');
        if (png.data[i + 3] && !palette.has(rgb)) foreign.add(rgb);
      }
      expect([...foreign], s).toEqual([]);
    }
  });

  for (const state of DESIGN_STATES) {
    it(`${state}: one row of 64x64 cells, the expected frame count, only fully transparent or opaque pixels`, () => {
      const png = strip(state);
      expect(png.height).toBe(CELL);
      expect(png.width % CELL).toBe(0);
      expect(png.width / CELL).toBe(ANIMATIONS[state].frames.length);
      const partial = [];
      for (let i = 3; i < png.data.length; i += 4) {
        if (png.data[i] !== 0 && png.data[i] !== 255) partial.push(png.data[i]);
      }
      expect(partial).toEqual([]);
    });

    it(`${state}: frames match the GIF's order and total duration (GIF merges repeated frames)`, () => {
      const png = strip(state);
      const gif = gifFrames(state);
      expect(gif[0].width).toBe(CELL);
      const { frames } = ANIMATIONS[state];

      // Merge runs of identical strip frames, adding up their durations, as the GIF encoder did.
      const merged: { rgba: Buffer; ms: number }[] = [];
      frames.forEach((ms, i) => {
        const rgba = cell(png, i);
        const last = merged[merged.length - 1];
        if (last && samePicture(last.rgba, rgba)) last.ms += ms;
        else merged.push({ rgba, ms });
      });

      expect(gif.length).toBe(merged.length);
      gif.forEach((g, i) => {
        expect(samePicture(g.rgba, merged[i].rgba), `frame ${i} picture`).toBe(true);
        expect(g.delayMs, `frame ${i} delay`).toBe(merged[i].ms);
      });
      expect(gif.reduce((t, g) => t + g.delayMs, 0)).toBe(totalDuration(state));
    });
  }
});

describe('other extracted art', () => {
  it('has 12 faces of 48x40 and three 64x64 turnaround views', () => {
    const faces = ['neutral', 'joyful', 'sleepy', 'focused', 'pondering', 'shocked', 'grumpy', 'starry-eyed',
      'attentive', 'chatty', 'sassy', 'confused'];
    for (const face of faces) {
      const png = PNG.sync.read(readFileSync(join(ROOT, 'assets', 'expressions', `${face}.png`)));
      expect([png.width, png.height], face).toEqual([48, 40]);
    }
    for (const view of ['front', 'three-quarter', 'side']) {
      const png = PNG.sync.read(readFileSync(join(ROOT, 'assets', 'turnaround', `${view}.png`)));
      expect([png.width, png.height], view).toEqual([64, 64]);
    }
  });
});
