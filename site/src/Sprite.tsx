import { useEffect, useRef } from 'react';
import { frameAt, STILL_FRAME } from '@desktop/shared/animations';
import type { CompanionInfo } from '@desktop/shared/companions';
import { drawFrame, loadSprites, type SpriteSet } from '@desktop/renderer/sprites';
import { useReducedMotion } from './motion';

const cache = new Map<string, Promise<SpriteSet>>();

/** Each companion's sheets are loaded once for the whole page. */
function spritesFor(c: CompanionInfo): Promise<SpriteSet> {
  if (!cache.has(c.id)) cache.set(c.id, loadSprites(c));
  return cache.get(c.id)!;
}

export interface SpriteProps {
  companion: CompanionInfo;
  /** A pose name from the companion's manifest (idle, happy, walking, attention...). */
  pose: string;
  /** Whole-number scale, so every art pixel stays a crisp square (as in the app). */
  scale?: number;
  mirrored?: boolean;
  /** What the companion is doing, for screen readers. Empty means decorative. */
  label: string;
  /** Called once when a pose that doesn't loop finishes. */
  onDone?: () => void;
  /** Show the first frame only. */
  still?: boolean;
}

/**
 * Plays one of a companion's poses on a canvas with the app's own sprite code
 * (desktop/src/renderer/sprites.ts) and timings (its manifest). With reduced motion, it shows a
 * still frame.
 */
export function Sprite({ companion, pose, scale = 3, mirrored = false, label, onDone, still }: SpriteProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let raf = 0;
    let alive = true;
    spritesFor(companion).then((set) => {
      const ctx = canvas.current?.getContext('2d');
      const sprite = set[pose] ?? set.idle;
      if (!alive || !ctx || !sprite) return;
      if (reduced || still) {
        drawFrame(ctx, sprite, STILL_FRAME, scale, mirrored);
        done.current?.();
        return;
      }
      const start = performance.now();
      let last = -1;
      let finished = false;
      const tick = (now: number) => {
        const f = frameAt(sprite.pose, now - start);
        if (f.index !== last) {
          drawFrame(ctx, sprite, f.index, scale, mirrored);
          last = f.index;
        }
        if (f.finished && !finished) {
          finished = true;
          done.current?.();
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }).catch(() => { /* art failed to load: the canvas stays empty, the label still describes it */ });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [companion, pose, scale, mirrored, reduced, still]);

  const size = 64 * scale;
  return (
    <canvas
      ref={canvas}
      className="sprite"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      data-pose={pose}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
