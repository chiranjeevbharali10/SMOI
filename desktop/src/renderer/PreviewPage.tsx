import { useEffect, useRef, useState } from 'react';
import { frameAt, totalDuration } from '../shared/animations';
import type { CompanionInfo, Pose } from '../shared/companions';
import { drawFrame, loadSprites, type SpriteSet } from './sprites';

declare global {
  interface Window {
    smoiPreview: { roster(): Promise<CompanionInfo[]> };
  }
}

/**
 * Development page: plays every pose of every companion at 2x, with each pose's timing from its
 * manifest, for checking against the GIFs in assets/companions/<id>/gifs/. Walking is also shown
 * mirrored (as when walking left). Not reachable in a packaged build.
 */
function Player({ name, pose, sprites, mirrored }: { name: string; pose: Pose; sprites: SpriteSet; mirrored: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [start, setStart] = useState(performance.now());
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const ctx = canvas.current!.getContext('2d')!;
    let raf = 0;
    const tick = () => {
      const { index } = frameAt(pose, performance.now() - start);
      setFrame(index);
      drawFrame(ctx, sprites[name], index, 2, mirrored);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [name, pose, sprites, start, mirrored]);

  return (
    <figure className="card">
      <canvas ref={canvas} width={128} height={128} data-pose={name} />
      <figcaption>
        <strong>{name}{mirrored ? ' (mirrored)' : ''}{pose.draft ? ' · draft' : ''}</strong>
        <span>{pose.frames.length} frames · {totalDuration(pose)} ms · {pose.loop ? 'loop' : 'once'}</span>
        <span>frame {frame + 1} / {pose.frames.length}</span>
        {!pose.loop && <button onClick={() => setStart(performance.now())}>Replay</button>}
      </figcaption>
    </figure>
  );
}

export function PreviewPage() {
  const [roster, setRoster] = useState<CompanionInfo[]>([]);
  const [id, setId] = useState<string | null>(new URLSearchParams(location.search).get('companion'));
  const [sprites, setSprites] = useState<SpriteSet | null>(null);
  const current = roster.find((c) => c.id === id) ?? roster[0];

  useEffect(() => {
    void window.smoiPreview.roster().then(setRoster);
  }, []);
  useEffect(() => {
    if (!current) return;
    setSprites(null);
    void loadSprites(current).then(setSprites);
  }, [current]);

  if (!current) return <main><h1>Companion preview</h1><p>No companions loaded.</p></main>;
  const poses = Object.entries(current.poses);
  return (
    <main>
      <h1>Companion preview</h1>
      <nav>
        {roster.map((c) => (
          <button key={c.id} type="button" aria-pressed={c.id === current.id} onClick={() => setId(c.id)}>{c.name}</button>
        ))}
      </nav>
      <p>
        {current.name} the {current.creature}: {poses.length} poses, {poses.reduce((n, [, p]) => n + p.frames.length, 0)} frames.
        Alerts: attention → {current.alertPoses.attention}, mail → {current.alertPoses.mail}, tasks → {current.alertPoses.tasks}.
        Walk speed {current.walkSpeed} px per step.
      </p>
      <div className="grid">
        {sprites && poses.map(([name, pose]) => <Player key={`${current.id}-${name}`} name={name} pose={pose} sprites={sprites} mirrored={false} />)}
        {sprites && <Player key={`${current.id}-walking-m`} name="walking" pose={current.poses.walking} sprites={sprites} mirrored />}
      </div>
    </main>
  );
}
