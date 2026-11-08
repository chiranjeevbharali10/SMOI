import { useState } from 'react';
import { effectOf } from '@desktop/shared/panelActions';
import { PointingBubble } from '../PointingBubble';
import { Sprite } from '../Sprite';
import { GITHUB_URL } from '../links';
import { useTimeout } from '../motion';
import { companion, smoi } from '../roster';

/** The page's two actions. There is no installer yet (Phase 9), so nothing pretends to download. */
export function CallToAction() {
  return (
    <div className="cta">
      <span className="btn btn-soon" aria-disabled="true">Coming soon for Windows</span>
      <a className="btn btn-primary" href={GITHUB_URL}>Follow on GitHub</a>
    </div>
  );
}

const STAGE = 340;
const SCALE = 4;

export function Hero() {
  const hello = effectOf('hello')!;
  const [pose, setPose] = useState<string>(hello.frog);
  const [talking, setTalking] = useState(false);
  useTimeout(() => setTalking(true), 700);
  useTimeout(() => setPose('idle'), 3200);

  return (
    <header className="hero" id="top">
      <HeroFriends />
      <div className="hero-confetti" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} />)}</div>
      <div className="hero-stage" style={{ width: STAGE }}>
        {talking && hello.bubble && (
          <PointingBubble line={hello.bubble} anchorX={STAGE / 2} containerWidth={STAGE} bottom={64 * SCALE - 34} />
        )}
        <div className="hero-frog">
          <Sprite companion={smoi} pose={pose} scale={SCALE} label="SMOI, a pastel green pixel-art frog in a lavender scarf, waving hello" />
        </div>
      </div>
      <h1 className="hero-title">Meet <span className="wordmark">SMOI</span>.</h1>
      <p className="hero-lede">A tiny frog that lives on your desktop.</p>
      <p className="hero-sub">
        It answers questions about your files, remembers what you would forget, sorts your inbox,
        and never sends a thing without you.
      </p>
      <ul className="hero-chips" aria-label="What SMOI does">
        {['Answers from your files', 'Tasks & reminders', 'Voice', 'Calendar', 'Inbox, drafts only', 'Private by default'].map((t, i) => (
          <li key={t} style={{ animationDelay: `${900 + i * 90}ms` }}>{t}</li>
        ))}
      </ul>
      <CallToAction />
      <a className="scroll-hint" href="#desktop">See it in action ↓</a>
    </header>
  );
}

/** SMOI's friends peeking in around the edges of the hero (their real idle poses). */
function HeroFriends() {
  const peek = [
    { id: 'nox', cls: 'peek-nox', pose: 'idle' },
    { id: 'wisp', cls: 'peek-wisp', pose: 'idle' },
    { id: 'numi', cls: 'peek-numi', pose: 'happy' },
    { id: 'yuzu', cls: 'peek-yuzu', pose: 'sleeping' },
  ];
  return (
    <div className="hero-friends" aria-hidden="true">
      {peek.map((p) => (
        <div key={p.id} className={`peek ${p.cls}`}>
          <Sprite companion={companion(p.id)} pose={p.pose} scale={2} label="" />
        </div>
      ))}
    </div>
  );
}
