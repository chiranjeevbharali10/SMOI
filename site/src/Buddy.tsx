import { useEffect, useState } from 'react';
import { AVAILABLE_ROWS, effectOf, FINDING, type BubbleLine } from '@desktop/shared/panelActions';
import { DEFAULT_PERSONALITY, react } from '@desktop/shared/personality';
import { PointingBubble } from './PointingBubble';
import { Sprite } from './Sprite';
import { smoi } from './roster';

/**
 * A small SMOI in the corner that follows the visitor down the page and reacts to each scene,
 * the way it sits on a real desktop. Every line is one the app really says.
 */
const BEATS: Record<string, { pose: string; line: BubbleLine | null }> = {
  desktop: { pose: 'happy', line: effectOf('dashboard')!.bubble },
  ask: { pose: 'thinking', line: FINDING },
  remembers: { pose: 'working', line: react({ type: 'overdue', count: 3 }, DEFAULT_PERSONALITY).line },
  inbox: { pose: 'surprised', line: effectOf('inbox', AVAILABLE_ROWS, { newEmails: 1 })!.bubble },
  private: { pose: 'sleeping', line: null },
  moods: { pose: 'celebrating', line: { tone: 'nudge', text: smoi.lines[0] } },
  friends: { pose: 'idle', line: null },
  personality: { pose: 'happy', line: react({ type: 'task_saved', title: 'Buy oat milk' }, DEFAULT_PERSONALITY).line },
};
/** Scenes with a big SMOI of their own; the buddy steps aside there. */
const HIDDEN = new Set(['top', 'says', 'hello']);
const WIDTH = 300;

export function Buddy() {
  const [scene, setScene] = useState('top');
  const [talking, setTalking] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setScene(e.target.id);
    }, { rootMargin: '-45% 0px -45% 0px' });
    document.querySelectorAll('header.hero, section.scene').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    setTalking(true);
    const t = setTimeout(() => setTalking(false), 3800);
    return () => clearTimeout(t);
  }, [scene]);

  const hidden = HIDDEN.has(scene);
  const beat = BEATS[scene] ?? { pose: 'idle', line: null };
  return (
    <aside className={`buddy${hidden ? ' away' : ''}`} aria-hidden={hidden}>
      {talking && !hidden && beat.line && <PointingBubble line={beat.line} anchorX={WIDTH - 64} containerWidth={WIDTH} bottom={104} margin={0} />}
      <button type="button" className="buddy-frog" aria-label="SMOI. Back to the top" tabIndex={hidden ? -1 : 0}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <Sprite companion={smoi} pose={beat.pose} scale={2} label="" />
      </button>
    </aside>
  );
}
