/**
 * The speech-bubble window. It never takes focus. The main process sends a bubble; this page
 * draws it hidden, measures it and reports the size; the main process places the window and
 * sends back where the tail goes; then the bubble pops in.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BubblePlaced, BubbleShow } from '../shared/bridge';
import { BUBBLE_INSET } from '../shared/layout';
import { BubbleView } from './components/BubbleView';
import './theme/tokens.css';
import './components/smoi.css';
import './window.css';

const api = window.smoiBubble;

function BubbleApp() {
  const [bubble, setBubble] = useState<BubbleShow | null>(null);
  const [placed, setPlaced] = useState<BubblePlaced | null>(null);
  const [leaving, setLeaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.onShow((b) => {
      document.documentElement.classList.toggle('reduced-motion', b.reducedMotion);
      setPlaced(null);
      setLeaving(false);
      setBubble(b);
    });
    api.onPlaced((p) => setPlaced((prev) => (prev && prev.id === p.id ? { ...p } : p)));
    api.onHide(() => setLeaving(true));
    api.ready();
  }, []);

  // Measure a new bubble once its fonts are ready, before it is shown.
  useLayoutEffect(() => {
    if (!bubble || placed?.id === bubble.id) return;
    const id = bubble.id;
    void document.fonts.ready.then(() => {
      const el = box.current?.querySelector<HTMLElement>('.smoi-bubble');
      if (!el) return;
      const r = el.getBoundingClientRect();
      api.measured(id, { width: Math.ceil(r.width), height: Math.ceil(r.height) });
    });
  }, [bubble, placed]);

  const shown = bubble && placed?.id === bubble.id;
  return (
    <>
      <div
        ref={box}
        style={{ position: 'absolute', left: BUBBLE_INSET, top: BUBBLE_INSET, visibility: shown ? 'visible' : 'hidden' }}
        // Only a pink bubble has something to click (its x). Others let clicks pass through.
        onMouseMove={() => api.setHit(bubble?.tone === 'urgent')}
        onMouseLeave={() => api.setHit(false)}
      >
        {bubble && (
          <BubbleView
            key={bubble.id}
            tone={bubble.tone}
            text={bubble.text}
            tailX={placed?.tailX}
            tail={placed?.tail}
            pop={!!shown}
            leaving={leaving}
            onDismiss={() => api.dismiss(bubble.id)}
          />
        )}
      </div>
      {/* Announced to screen readers: pink as an alert, the others politely. */}
      <div role="status" className="visually-hidden">{shown && bubble.tone !== 'urgent' && !leaving ? bubble.text : ''}</div>
      <div role="alert" className="visually-hidden">{shown && bubble.tone === 'urgent' && !leaving ? bubble.text : ''}</div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<BubbleApp />);
