import { useState } from 'react';
import { effectOf } from '@desktop/shared/panelActions';
import { PointingBubble } from '../PointingBubble';
import { Sprite } from '../Sprite';
import { GITHUB_URL } from '../links';
import { useTimeout } from '../motion';
import { smoi } from '../roster';

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
    <header className="hero">
      <div className="hero-stage" style={{ width: STAGE }}>
        {talking && hello.bubble && (
          <PointingBubble line={hello.bubble} anchorX={STAGE / 2} containerWidth={STAGE} bottom={64 * SCALE - 34} />
        )}
        <div className="hero-frog">
          <Sprite companion={smoi} pose={pose} scale={SCALE} label="SMOI, a pastel green pixel-art frog in a lavender scarf, waving hello" />
        </div>
      </div>
      <h1 className="hero-title">Meet SMOI.</h1>
      <p className="hero-lede">A tiny frog that lives on your desktop.</p>
      <p className="hero-sub">
        It answers questions about your files, remembers what you would forget, sorts your inbox,
        and never sends a thing without you.
      </p>
      <CallToAction />
      <a className="scroll-hint" href="#desktop">See it in action ↓</a>
    </header>
  );
}
