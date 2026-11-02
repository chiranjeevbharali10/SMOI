/**
 * Where the menu panel and the speech bubble go, around the frog. Pure functions over plain
 * rectangles in DIPs, so they are unit-tested without Electron.
 *
 * The frog window itself never moves or resizes for them: the bubble and the panel are separate
 * windows (docs/adr/0013-desktop-ui-windows-and-api.md).
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Space between the frog and the panel. */
export const PANEL_GAP = 12;
/** Space between the frog and the bubble box; the 8px tail sits in it. */
export const BUBBLE_GAP = 10;
/** The tail stays this far from the bubble's ends, clear of its rounded corners. */
export const TAIL_INSET = 22;
/** In the design the tail sits about 40px left of the bubble's right edge. */
const TAIL_FROM_RIGHT = 40;

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
}

export interface PanelPlacement extends Rect {
  side: 'left' | 'right';
}

/**
 * The panel goes beside the frog, bottoms level, on the left as in the design. It flips to the
 * right when there isn't room on the left. If neither side has room it takes the roomier side and
 * stays inside the work area.
 */
export function placePanel(frog: Rect, panel: Size, work: Rect, gap = PANEL_GAP): PanelPlacement {
  const roomLeft = frog.x - gap - work.x;
  const roomRight = right(work) - (right(frog) + gap);
  let side: 'left' | 'right';
  if (roomLeft >= panel.width) side = 'left';
  else if (roomRight >= panel.width) side = 'right';
  else side = roomLeft >= roomRight ? 'left' : 'right';

  const wantX = side === 'left' ? frog.x - gap - panel.width : right(frog) + gap;
  const x = clamp(wantX, work.x, right(work) - panel.width);
  const y = clamp(bottom(frog) - panel.height, work.y, bottom(work) - panel.height);
  return { x: Math.round(x), y: Math.round(y), width: panel.width, height: panel.height, side };
}

export interface BubblePlacement extends Rect {
  /** The tail's centre, from the bubble's left edge. */
  tailX: number;
  /** Down: the bubble is above the frog. Up: below it (frog near the top of the screen). */
  tail: 'down' | 'up';
}

/**
 * The bubble goes above the frog with its tail pointing at the frog's centre, and always stays
 * entirely inside the work area. `avoid` is the open panel, which the bubble must not cover.
 *
 * In order of preference:
 * 1. above the frog, extending left (as in the design);
 * 2. above the frog, extending right;
 * 3. above both the frog and the panel;
 * 4. below the frog.
 * The tail moves along the bubble to keep pointing at the frog when the bubble is pushed sideways.
 */
export function placeBubble(frog: Rect, bubble: Size, work: Rect, avoid: Rect | null = null,
                            gap = BUBBLE_GAP): BubblePlacement {
  const target = frog.x + frog.width / 2;
  const fitX = (x: number) => clamp(x, work.x, right(work) - bubble.width);
  const above = frog.y - gap - bubble.height;
  const below = bottom(frog) + gap;

  const candidates: { x: number; y: number; tail: 'down' | 'up' }[] = [
    { x: fitX(target + TAIL_FROM_RIGHT - bubble.width), y: above, tail: 'down' },
    { x: fitX(target - TAIL_FROM_RIGHT), y: above, tail: 'down' },
  ];
  if (avoid) {
    candidates.push({ x: fitX(target + TAIL_FROM_RIGHT - bubble.width), y: Math.min(above, avoid.y - gap - bubble.height), tail: 'down' });
  }
  candidates.push({ x: fitX(target + TAIL_FROM_RIGHT - bubble.width), y: below, tail: 'up' });

  const fits = (c: { x: number; y: number }) => {
    const r = { x: c.x, y: c.y, width: bubble.width, height: bubble.height };
    const inside = r.y >= work.y && bottom(r) <= bottom(work);
    return inside && !(avoid && overlaps(r, avoid));
  };
  // If nothing fits (a tiny screen), keep it on screen above the frog, even over the panel.
  const chosen = candidates.find(fits)
    ?? { x: candidates[0].x, y: clamp(above, work.y, bottom(work) - bubble.height), tail: 'down' as const };

  const tailX = clamp(target - chosen.x, TAIL_INSET, bubble.width - TAIL_INSET);
  return {
    x: Math.round(chosen.x), y: Math.round(chosen.y), width: bubble.width, height: bubble.height,
    tailX: Math.round(tailX), tail: chosen.tail,
  };
}

/**
 * Transparent space around the bubble and the panel inside their windows: room for the bubble's
 * tail and pop overshoot, and for the panel's 6px shadow and focus outlines. Clicks pass through
 * this space.
 */
export const BUBBLE_INSET = 14;
export const PANEL_INSET = { x: 6, top: 6, bottom: 14 };
