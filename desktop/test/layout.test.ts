import { describe, expect, it } from 'vitest';
import { BUBBLE_GAP, PANEL_GAP, TAIL_INSET, overlaps, placeBubble, placePanel, type Rect } from '../src/shared/layout';
import { movedFar } from '../src/shared/pointer';

const work: Rect = { x: 0, y: 0, width: 1920, height: 1032 };
const frogAt = (x: number, y: number): Rect => ({ x, y, width: 128, height: 128 });
const panel = { width: 316, height: 370 };
const bubble = { width: 280, height: 56 };
const inside = (r: Rect, w: Rect) => r.x >= w.x && r.y >= w.y && r.x + r.width <= w.x + w.width && r.y + r.height <= w.y + w.height;

describe('panel placement', () => {
  it('goes on the left of the frog with bottoms level, as in the design', () => {
    const frog = frogAt(1768, 904);
    const p = placePanel(frog, panel, work);
    expect(p.side).toBe('left');
    expect(p.x + p.width).toBe(frog.x - PANEL_GAP);
    expect(p.y + p.height).toBe(frog.y + frog.height);
  });

  it('flips to the right when the frog is near the left edge', () => {
    const frog = frogAt(40, 904);
    const p = placePanel(frog, panel, work);
    expect(p.side).toBe('right');
    expect(p.x).toBe(frog.x + frog.width + PANEL_GAP);
    expect(inside(p, work)).toBe(true);
  });

  it('stays on screen when the frog is near the top', () => {
    const p = placePanel(frogAt(900, 0), panel, work);
    expect(p.y).toBe(0);
    expect(inside(p, work)).toBe(true);
  });

  it('stays on screen when neither side has room (narrow display)', () => {
    const narrow = { x: 0, y: 0, width: 500, height: 800 };
    const p = placePanel(frogAt(186, 600), panel, narrow);
    expect(inside(p, narrow)).toBe(true);
  });

  it('works on a monitor left of the primary one (negative coordinates)', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    const p = placePanel(frogAt(-1900, 900), panel, left);
    expect(p.side).toBe('right');
    expect(inside(p, left)).toBe(true);
  });
});

describe('bubble placement', () => {
  it('goes above the frog with the tail pointing at its centre', () => {
    const frog = frogAt(900, 600);
    const b = placeBubble(frog, bubble, work);
    expect(b.tail).toBe('down');
    expect(b.y + b.height).toBe(frog.y - BUBBLE_GAP);
    expect(b.x + b.tailX).toBe(frog.x + frog.width / 2);
  });

  it.each([
    ['right edge', frogAt(1792, 904)],
    ['left edge', frogAt(0, 904)],
    ['bottom-right corner', frogAt(1792, 904)],
  ])('stays fully on screen at the %s, tail still on the frog', (_name, frog) => {
    const b = placeBubble(frog, bubble, work);
    expect(inside(b, work)).toBe(true);
    expect(b.tailX).toBeGreaterThanOrEqual(TAIL_INSET);
    expect(b.tailX).toBeLessThanOrEqual(b.width - TAIL_INSET);
    const tip = b.x + b.tailX;
    expect(tip).toBeGreaterThanOrEqual(frog.x);
    expect(tip).toBeLessThanOrEqual(frog.x + frog.width);
  });

  it('goes below the frog when it is at the top of the screen', () => {
    const frog = frogAt(900, 10);
    const b = placeBubble(frog, bubble, work);
    expect(b.tail).toBe('up');
    expect(b.y).toBe(frog.y + frog.height + BUBBLE_GAP);
    expect(inside(b, work)).toBe(true);
  });

  it('never covers the open panel', () => {
    const frog = frogAt(1768, 904);
    const p = placePanel(frog, panel, work);
    const b = placeBubble(frog, bubble, work, p);
    expect(overlaps(b, p)).toBe(false);
    expect(inside(b, work)).toBe(true);
  });

  it('never covers the panel when it flipped to the right either', () => {
    const frog = frogAt(40, 904);
    const p = placePanel(frog, panel, work);
    const b = placeBubble(frog, bubble, work, p);
    expect(overlaps(b, p)).toBe(false);
    expect(inside(b, work)).toBe(true);
  });

  it('uses whole pixels', () => {
    const b = placeBubble({ x: 100.5, y: 500.25, width: 153.6, height: 153.6 }, { width: 201, height: 57 }, work);
    for (const v of [b.x, b.y, b.tailX]) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('click or drag', () => {
  it('a press that moved less than 4px is a click', () => {
    expect(movedFar({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(false);
    expect(movedFar({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
  });
});
