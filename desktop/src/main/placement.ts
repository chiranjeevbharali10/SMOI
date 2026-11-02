/**
 * Where the frog window goes. Pure functions over plain rectangles, so they are unit-tested
 * without Electron.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  workArea: Rect;
  scaleFactor: number;
}

/** Bottom-right corner of the work area, standing on top of the taskbar. */
export function defaultPosition(display: DisplayInfo, size: number, margin = 24): { x: number; y: number } {
  const { workArea } = display;
  return { x: workArea.x + workArea.width - size - margin, y: workArea.y + workArea.height - size };
}

/** Keeps the whole window inside the work area. */
export function clampToWorkArea(x: number, y: number, size: number, display: DisplayInfo): { x: number; y: number } {
  const { workArea: w } = display;
  return {
    x: Math.round(Math.min(Math.max(x, w.x), w.x + w.width - size)),
    y: Math.round(Math.min(Math.max(y, w.y), w.y + w.height - size)),
  };
}

/**
 * Restores a saved position if its display is still connected, else the default spot on the
 * primary display. Saved positions are relative to the display, so they survive the display's
 * coordinates changing (for example another monitor added to its left).
 */
export function restorePosition(
  saved: { displayId: number; x: number; y: number } | null,
  displays: DisplayInfo[],
  primary: DisplayInfo,
  size: number,
): { display: DisplayInfo; x: number; y: number } {
  const display = saved ? displays.find((d) => d.id === saved.displayId) : undefined;
  if (display && saved) {
    const p = clampToWorkArea(display.workArea.x + saved.x, display.workArea.y + saved.y, size, display);
    return { display, ...p };
  }
  return { display: primary, ...defaultPosition(primary, size) };
}

/** The next step of a walk along the bottom of the work area; reverses at the edges. */
export function walkStep(x: number, direction: 1 | -1, step: number, size: number, display: DisplayInfo):
  { x: number; direction: 1 | -1 } {
  const min = display.workArea.x;
  const max = display.workArea.x + display.workArea.width - size;
  const next = x + direction * step;
  if (next > max) return { x: max, direction: -1 };
  if (next < min) return { x: min, direction: 1 };
  return { x: next, direction };
}
