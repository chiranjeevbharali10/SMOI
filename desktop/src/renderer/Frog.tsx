import { useEffect, useRef, useState } from 'react';
import { CELL, STILL_FRAME, frameAt, totalDuration, type FrogState } from '../shared/animations';
import { poseName, type CompanionInfo } from '../shared/companions';
import { frogSize } from '../shared/scaling';
import { drawFrame, loadSprites, type SpriteSet } from './sprites';

declare global {
  interface Window {
    smoi: {
      ready(): void;
      onState(cb: (m: { state: string; mirrored: boolean }) => void): void;
      onSettings(cb: (m: { reducedMotion: boolean }) => void): void;
      onCompanion(cb: (c: CompanionInfo) => void): void;
      setHit(overFrog: boolean): void;
      press(offset: { x: number; y: number }): void;
      release(): void;
      animationFinished(state: string): void;
    };
  }
}

/** The OS-level "reduce motion" preference counts too, not only SMOI's own setting. */
const osReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The companion on the desktop. The main process says which companion is active and which state
 * to show; this draws it. Alerts (attention, mail, tasks) are drawn with whatever pose the
 * companion's manifest maps them to. A one-shot pose plays once and holds its last frame; the
 * state machine decides what comes next.
 */
export function Frog() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [companion, setCompanion] = useState<{ info: CompanionInfo; sprites: SpriteSet } | null>(null);
  const [state, setState] = useState<{ state: FrogState; mirrored: boolean; since: number }>(
    { state: 'idle', mirrored: false, since: performance.now() });
  const [reducedMotion, setReducedMotion] = useState(osReducedMotion());
  const [dpr, setDpr] = useState(window.devicePixelRatio);
  const frameRef = useRef(0);
  const loading = useRef(0);

  useEffect(() => {
    window.smoi.onCompanion((info) => {
      // Keep showing the current companion until the new one's sheets are loaded, so the window
      // never flashes empty. A load that finishes after a newer switch is ignored.
      const ticket = ++loading.current;
      loadSprites(info)
        .then((sprites) => {
          if (ticket === loading.current) setCompanion({ info, sprites });
        })
        .catch((e) => console.error(`[companion] ${info.id}: ${e instanceof Error ? e.message : e}`));
    });
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
  const sprite = companion ? companion.sprites[poseName(companion.info, state.state)] ?? companion.sprites.idle : null;

  // The animation loop.
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !sprite) return;
    const anim = sprite.pose;
    let raf = 0;
    let reported = false;
    let still: ReturnType<typeof setTimeout> | undefined;

    if (reducedMotion) {
      // Hold one still frame. A one-shot pose still ends on time, so the state machine moves on.
      frameRef.current = STILL_FRAME;
      drawFrame(ctx, sprite, STILL_FRAME, size.multiple, state.mirrored);
      if (!anim.loop) still = setTimeout(() => window.smoi.animationFinished(state.state), totalDuration(anim));
      return () => clearTimeout(still);
    }

    const render = () => {
      const { index, finished } = frameAt(anim, performance.now() - state.since);
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
  }, [sprite, state, reducedMotion, size.multiple]);

  /** Is the art pixel under this CSS point opaque in the frame being shown? */
  const overFrog = (e: React.MouseEvent): boolean => {
    if (!sprite) return false;
    let x = Math.floor((e.nativeEvent.offsetX * dpr) / size.multiple);
    const y = Math.floor((e.nativeEvent.offsetY * dpr) / size.multiple);
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return false;
    if (state.mirrored) x = CELL - 1 - x;
    const frame = Math.min(Math.max(0, frameRef.current), sprite.opaque.length - 1);
    return sprite.opaque[frame][y * CELL + x] === 1;
  };

  const hit = useRef(false);
  const updateHit = (value: boolean) => {
    if (hit.current !== value) {
      hit.current = value;
      window.smoi.setHit(value);
    }
  };

  const label = companion ? `${companion.info.name} the ${companion.info.creature}, ${state.state}` : 'Your companion';

  return (
    <canvas
      ref={canvas}
      width={size.devicePixels}
      height={size.devicePixels}
      style={{ width: `${size.cssPixels}px`, height: `${size.cssPixels}px` }}
      aria-label={label}
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
