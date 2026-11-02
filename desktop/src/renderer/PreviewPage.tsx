import { useEffect, useRef, useState } from 'react';
import { ANIMATIONS, STATES, frameAt, totalDuration, type FrogState } from '../shared/animations';
import { drawFrame, loadSprites, type Sprite } from './sprites';

/**
 * Development page: plays all 12 states (82 frames) at 2x, plus each raw strip, for comparing
 * against the sprite board in docs/design/smoi-character-design.html. Not reachable in a
 * packaged build.
 */
function Player({ state, sprite }: { state: FrogState; sprite: Sprite }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [start, setStart] = useState(performance.now());
  const [frame, setFrame] = useState(0);
  const multiple = 2;

  useEffect(() => {
    const ctx = canvas.current!.getContext('2d')!;
    let raf = 0;
    const tick = () => {
      const { index } = frameAt(state, performance.now() - start);
      setFrame(index);
      drawFrame(ctx, sprite, index, multiple, false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, sprite, start]);

  const { frames, loop } = ANIMATIONS[state];
  return (
    <figure className="card">
      <canvas ref={canvas} width={128} height={128} />
      <figcaption>
        <strong>{state}</strong>
        <span>{frames.length} frames · {totalDuration(state)} ms · {loop ? 'loop' : 'once'}</span>
        <span>frame {frame + 1} / {frames.length}</span>
        {!loop && <button onClick={() => setStart(performance.now())}>Replay</button>}
      </figcaption>
      <img className="strip" src={`./sprites/${state}.png`} alt={`${state} frames`} />
    </figure>
  );
}

export function PreviewPage() {
  const [sprites, setSprites] = useState<Record<FrogState, Sprite> | null>(null);
  useEffect(() => {
    void loadSprites().then(setSprites);
  }, []);
  const total = STATES.reduce((n, s) => n + ANIMATIONS[s].frames.length, 0);
  return (
    <main>
      <h1>SMOI animation preview</h1>
      <p>{STATES.length} states, {total} frames. Compare with the sprite board in the design file.</p>
      <div className="grid">
        {sprites && STATES.map((s) => <Player key={s} state={s} sprite={sprites[s]} />)}
      </div>
    </main>
  );
}
