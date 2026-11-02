/**
 * Telling a click on the frog from a drag. The frog only starts moving once the cursor has moved
 * this far from where the button went down, so a click never nudges it, and a press that never
 * moved that far is a click (it opens or closes the panel).
 */
export const DRAG_THRESHOLD = 4;

export function movedFar(start: { x: number; y: number }, now: { x: number; y: number },
                         threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= threshold;
}
