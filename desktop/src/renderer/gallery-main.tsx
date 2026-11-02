/**
 * Development page used by scripts/capture-ui.ts: the real BubbleView and PanelView components,
 * laid out like the design's "speech bubble and panel" board so screenshots can sit next to it.
 * Not part of the app's windows.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BubbleView } from './components/BubbleView';
import { PanelView } from './components/PanelView';
import { AVAILABLE_ROWS, PANEL_ROWS, effectOf } from '../shared/panelActions';
import './theme/tokens.css';
import './components/smoi.css';

const rows = PANEL_ROWS.map((r) => ({ ...r, available: AVAILABLE_ROWS.has(r.id) }));
const hello = effectOf('hello')!;

/** A bubble with its tail 40px from the right edge, as on the board (where the frog is). */
function RightTail({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [tailX, setTailX] = useState<number>();
  useLayoutEffect(() => setTailX((box.current?.firstElementChild as HTMLElement).offsetWidth - 40), []);
  return <div ref={box}><BubbleView tone="nudge" text={text} tailX={tailX} pop /></div>;
}

function Gallery() {
  return (
    <div style={{ width: 1280, height: 860, boxSizing: 'border-box', padding: '44px 64px', background: 'var(--smoi-cream)',
      color: 'var(--smoi-charcoal)', fontFamily: 'var(--smoi-font-body)', display: 'flex', gap: 48 }}>
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'flex-start' }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--smoi-font-pixel)', fontWeight: 700, fontSize: 52, lineHeight: 1 }}>Phase 6B build</h1>
        <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>The app's own components, rendered with the shared tokens.</p>
        <BubbleView tone="nudge" text="Hi. What are we avoiding today?" tail="none" />
        <div style={{ fontSize: 14, fontWeight: 700 }}>Blue: nudges. Fades after a few seconds.</div>
        <BubbleView tone="finding" text="I found something interesting for you." tail="none" />
        <div style={{ fontSize: 14, fontWeight: 700 }}>Lavender: findings. Fades after a few seconds.</div>
        <BubbleView tone="urgent" text="Psst. You've got somewhere to be." tail="none" />
        <div style={{ fontSize: 14, fontWeight: 700 }}>Pink: time-sensitive. Stays until dismissed.</div>
        <BubbleView tone="nudge" text="Go on, type it. I have no ears." tailX={22} tail="up" />
        <div style={{ fontSize: 14, fontWeight: 700 }}>Below the frog, tail moved, when the frog is near the top-left.</div>
      </div>
      <div style={{ position: 'relative', flex: 1, border: '2px solid var(--smoi-charcoal)', borderRadius: 20, background: '#A8ACE2' }}>
        <div style={{ position: 'absolute', left: 28, bottom: 24 }}>
          <PanelView mood={hello.mood} rows={rows} onChoose={() => {}} onClose={() => {}} />
        </div>
        <div style={{ position: 'absolute', right: 36, bottom: 158 }}>
          <RightTail text={hello.bubble!.text} />
        </div>
        <div aria-hidden="true" style={{ position: 'absolute', right: 28, bottom: 16, width: 64, height: 64,
          backgroundImage: 'url(./sprites/happy.png)', backgroundPosition: '0 0', imageRendering: 'pixelated',
          transform: 'scale(2)', transformOrigin: 'bottom right' }} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Gallery />);
