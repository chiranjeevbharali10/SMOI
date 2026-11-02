import { useEffect, useRef, useState } from 'react';
import { ANIMATIONS, CELL, STILL_FRAME, frameAt, totalDuration, type FrogState } from '../shared/animations';
import { frogSize } from '../shared/scaling';
import { drawFrame, loadSprites, type Sprite } from './sprites';

declare global {
  interface Window {
    smoi: {
      ready(): void;
      onState(cb: (m: { state: string; mirrored: boolean }) => void): void;
      onSettings(cb: (m: { reducedMotion: boolean }) => void): void;
      setHit(overFrog: boolean): void;
      press(offset: { x: number; y: number }): void;
      release(): void;
      animationFinished(state: string): void;
    };
  }
}

/** The OS-level "reduce motion" preference counts too, not only SMOI's own setting. */
const osReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Frog() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sprites, setSprites] = useState<Record<FrogState, Sprite> | null>(null);
  const [state, setState] = useState<{ state: FrogState; mirrored: boolean; since: number }>(
    { state: 'idle', mirrored: false, since: performance.now() });
  const [reducedMotion, setReducedMotion] = useState(osReducedMotion());
  const [dpr, setDpr] = useState(window.devicePixelRatio);
  const frameRef = useRef(0);

  useEffect(() => {
    void loadSprites().then(setSprites);
    window.smoi.onState((m) => setState({ state: m.state as FrogState, mirrored: m.mirrored, since: performance.now() }));
    window.smoi.onSettings((m) => setReducedMotion(m.reducedMotion || osReducedMotion()));
    window.smoi.ready();
  }, []);

  // Follow display-scale changes (for example after dragging to another monitor).
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [dpr]);

  const size = frogSize(dpr);

  // The animation loop.
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !sprites) return;
    const sprite = sprites[state.state];
    const { loop } = ANIMATIONS[state.state];
    let raf = 0;
    let reported = false;
    let still: ReturnType<typeof setTimeout> | undefined;

    if (reducedMotion) {
      // Hold one still frame. A one-shot state still ends on time, so the state machine moves on.
      frameRef.current = STILL_FRAME;
      drawFrame(ctx, sprite, STILL_FRAME, size.multiple, state.mirrored);
      if (!loop) still = setTimeout(() => window.smoi.animationFinished(state.state), totalDuration(state.state));
      return () => clearTimeout(still);
    }

    const render = () => {
      const { index, finished } = frameAt(state.state, performance.now() - state.since);
      if (index !== frameRef.current || !reported) {
        frameRef.current = index;
        drawFrame(ctx, sprite, index, size.multiple, state.mirrored);
      }
      if (finished && !reported) {
        reported = true;
        window.smoi.animationFinished(state.state);
      }
      raf = requestAnimationFrame(render);
    };
    frameRef.current = -1;
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [sprites, state, reducedMotion, size.multiple]);

  /** Is the art pixel under this CSS point opaque in the frame being shown? */
  const overFrog = (e: React.MouseEvent): boolean => {
    if (!sprites) return false;
    let x = Math.floor((e.nativeEvent.offsetX * dpr) / size.multiple);
    const y = Math.floor((e.nativeEvent.offsetY * dpr) / size.multiple);
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return false;
    if (state.mirrored) x = CELL - 1 - x;
    const frame = Math.max(0, frameRef.current);
    return sprites[state.state].opaque[frame][y * CELL + x] === 1;
  };

  const hit = useRef(false);
  const updateHit = (value: boolean) => {
    if (hit.current !== value) {
      hit.current = value;
      window.smoi.setHit(value);
    }
  };

  return (
    <canvas
      ref={canvas}
      width={size.devicePixels}
      height={size.devicePixels}
      style={{ width: `${size.cssPixels}px`, height: `${size.cssPixels}px` }}
      aria-label={`SMOI the frog, ${state.state}`}
      role="img"
      onMouseMove={(e) => updateHit(overFrog(e))}
      onMouseLeave={() => updateHit(false)}
      onMouseDown={(e) => {
        if (e.button === 0 && overFrog(e)) {
          window.smoi.press({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });
        }
      }}
      onMouseUp={() => window.smoi.release()}
    />
  );
}
