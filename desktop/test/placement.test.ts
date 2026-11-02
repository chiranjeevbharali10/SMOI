import { describe, expect, it } from 'vitest';
import { clampToWorkArea, defaultPosition, restorePosition, walkStep, type DisplayInfo } from '../src/main/placement';

// A 1920x1080 display with a 48 px taskbar at the bottom, and a second display to its right.
const primary: DisplayInfo = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, scaleFactor: 1 };
const second: DisplayInfo = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1392 }, scaleFactor: 1.5 };

describe('placement', () => {
  it('starts bottom right, standing on the taskbar', () => {
    expect(defaultPosition(primary, 128)).toEqual({ x: 1920 - 128 - 24, y: 1032 - 128 });
  });

  it('restores a saved position relative to its display', () => {
    const r = restorePosition({ displayId: 2, x: 100, y: 200 }, [primary, second], primary, 128);
    expect(r).toEqual({ display: second, x: 2020, y: 200 });
  });

  it('falls back to the primary display when the saved display is gone', () => {
    const r = restorePosition({ displayId: 99, x: 100, y: 200 }, [primary], primary, 128);
    expect(r.display).toBe(primary);
    expect(r.y).toBe(1032 - 128);
  });

  it('keeps the window inside the work area', () => {
    expect(clampToWorkArea(-50, 2000, 128, primary)).toEqual({ x: 0, y: 1032 - 128 });
    expect(clampToWorkArea(1900, -10, 128, primary)).toEqual({ x: 1920 - 128, y: 0 });
  });

  it('walks and turns around at the edges', () => {
    expect(walkStep(100, 1, 2, 128, primary)).toEqual({ x: 102, direction: 1 });
    expect(walkStep(1920 - 128 - 1, 1, 2, 128, primary)).toEqual({ x: 1920 - 128, direction: -1 });
    expect(walkStep(1, -1, 2, 128, primary)).toEqual({ x: 0, direction: 1 });
  });
});
