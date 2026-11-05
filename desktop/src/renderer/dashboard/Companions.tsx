import { useEffect, useRef, useState } from 'react';
import { frameAt } from '../../shared/animations';
import type { CompanionInfo } from '../../shared/companions';
import type { UserSettings } from '../../shared/bridge';
import { drawFrame, loadSprites, type SpriteSet } from '../sprites';

const api = () => window.smoiDashboard;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A companion's idle animation at 2x, nearest-neighbour, timed from its manifest. */
function IdlePreview({ c }: { c: CompanionInfo }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sprites, setSprites] = useState<SpriteSet | null>(null);
  useEffect(() => {
    let live = true;
    void loadSprites({ id: c.id, poses: { idle: c.poses.idle } }).then((s) => live && setSprites(s));
    return () => {
      live = false;
    };
  }, [c]);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !sprites) return;
    const start = performance.now();
    let raf = 0;
    let last = -1;
    const tick = () => {
      const { index } = reduced() ? { index: 0 } : frameAt(c.poses.idle, performance.now() - start);
      if (index !== last) drawFrame(ctx, sprites.idle, (last = index), 2, false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sprites, c]);
  return <canvas ref={canvas} width={128} height={128} className="companion-sprite" role="img" aria-label={`${c.name} the ${c.creature}`} />;
}

/**
 * "Choose companion": every companion in the roster with its idle animation, name, creature and
 * one-line personality. Choosing one switches at once; it's remembered for next time.
 */
export function Companions({ settings }: { settings: UserSettings }) {
  const [error, setError] = useState<string | null>(null);
  const choose = async (id: string) => {
    setError(null);
    const s = await api().updateSettings({ companion: id });
    if (s.companion !== id) setError("That companion couldn't be loaded, so nothing changed.");
  };
  return (
    <>
      <h2>Choose companion</h2>
      <p className="hint">One companion keeps you company at a time. Your tasks, settings and data stay the same whoever you pick.</p>
      {error && <div className="banner error" role="alert"><span>{error}</span></div>}
      <div className="companion-grid">
        {settings.companions.map((c) => {
          const active = c.id === settings.companion;
          return (
            <section key={c.id} className="card companion-card" aria-labelledby={`h-${c.id}`}
                     style={c.accent ? { borderTopColor: c.accent } : undefined}>
              <IdlePreview c={c} />
              <h3 id={`h-${c.id}`}>{c.name}</h3>
              <p className="hint">{c.creature}</p>
              <p>{c.personality}</p>
              <button className={`btn${active ? '' : ' primary'}`} type="button" disabled={active} aria-pressed={active}
                      onClick={() => void choose(c.id)}>
                {active ? 'With you now' : `Choose ${c.name}`}
              </button>
            </section>
          );
        })}
      </div>
    </>
  );
}
