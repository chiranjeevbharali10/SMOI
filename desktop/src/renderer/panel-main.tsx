/**
 * The menu-panel window. It takes keyboard focus when it opens (so Esc and the arrow keys work)
 * and the main process hides it when it closes, which hands focus back to the app underneath.
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PanelView as PanelData } from '../shared/bridge';
import { PANEL_INSET } from '../shared/layout';
import { PanelView, type PanelHandle } from './components/PanelView';
import './theme/tokens.css';
import './components/smoi.css';
import './window.css';

const api = window.smoiPanel;

function PanelApp() {
  const [view, setView] = useState<PanelData | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const panel = useRef<PanelHandle>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.onOpen((v) => {
      setView(v);
      setOpenCount((n) => n + 1);
    });
    api.onUpdate((v) => setView(v));
    api.ready();
  }, []);

  useEffect(() => {
    if (view) document.documentElement.classList.toggle('reduced-motion', view.reducedMotion);
  }, [view]);

  // On each open: focus the first row.
  useEffect(() => {
    if (openCount > 0) panel.current?.focusFirst();
  }, [openCount]);

  // Report the panel's size once it has drawn (its fonts affect the header height).
  useEffect(() => {
    if (!view) return;
    void document.fonts.ready.then(() => {
      const el = box.current?.querySelector<HTMLElement>('.smoi-panel');
      if (!el) return;
      const r = el.getBoundingClientRect();
      api.measured({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
    });
  }, [view !== null, view?.confirm]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={box}
      style={{ position: 'absolute', left: PANEL_INSET.x, top: PANEL_INSET.top }}
      onMouseMove={() => api.setHit(true)}
      onMouseLeave={() => api.setHit(false)}
    >
      {view && (
        <PanelView
          key={openCount}
          ref={panel}
          mood={view.mood}
          rows={view.rows}
          confirm={view.confirm}
          onAnswer={(yes) => api.answer(yes)}
          rise={openCount > 0}
          announce={view.announce}
          onChoose={(row) => api.choose(row)}
          onClose={() => api.close()}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<PanelApp />);
