import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FrogState } from '@desktop/shared/animations';
import { poseName } from '@desktop/shared/companions';
import {
  AVAILABLE_ROWS, PANEL_ROWS, effectOf, HELLO_MOOD,
  type BubbleLine, type PanelFacts, type PanelRowId,
} from '@desktop/shared/panelActions';
import { PanelView, type PanelHandle } from '@desktop/renderer/components/PanelView';
import { PointingBubble } from '../PointingBubble';
import { Sprite } from '../Sprite';
import { Scene, useReducedMotion } from '../motion';
import { smoi } from '../roster';

/** Pretend facts for the demo desktop, so rows that depend on data have something to say. */
const FACTS: PanelFacts = { openTasks: 3, busyToday: true, newEmails: 1, voice: false };

const OPENS: Record<string, string> = {
  chat: 'the chat', tasks: 'your tasks', calendar: 'your calendar', inbox: 'your inbox',
  brain: 'SMOI Brain', companions: 'the companion picker', dashboard: 'the dashboard',
};

const SCALE = 2;
const SIZE = 64 * SCALE;
const TASKBAR = 44;
const SPEED = 46; // px per second
type Mode = 'walk' | 'rest' | 'menu' | 'react';

const rows = PANEL_ROWS.map((r) => ({ ...r, available: AVAILABLE_ROWS.has(r.id) }));

export function DesktopScene() {
  return (
    <Scene id="desktop" tone="paper" label="SMOI on a desktop">
      <p className="kicker">Always there, never in the way</p>
      <h2>It lives on your desktop.</h2>
      <p className="lede">
        SMOI hops along your taskbar, naps when you're away and pipes up when something matters.
        Click it to say hi.
      </p>
      <Desktop />
    </Scene>
  );
}

function Desktop() {
  const reduced = useReducedMotion();
  const screen = useRef<HTMLDivElement>(null);
  const frogButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<PanelHandle>(null);
  const [width, setWidth] = useState(900);
  const [x, setX] = useState(96);
  const [dir, setDir] = useState<1 | -1>(1);
  const [mode, setMode] = useState<Mode>('walk');
  const [pose, setPose] = useState('walking');
  const [line, setLine] = useState<BubbleLine | null>(null);
  const [mood, setMood] = useState(HELLO_MOOD);
  const [caption, setCaption] = useState<string | null>(null);
  const pos = useRef({ x: 96, dir: 1 as 1 | -1 });

  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Walking: hop along the taskbar, turn at the edges, stop for a rest now and then.
  useEffect(() => {
    if (reduced) {
      setMode((m) => (m === 'walk' ? 'rest' : m));
      return;
    }
    if (mode === 'rest') {
      setPose('idle');
      const t = setTimeout(() => setMode('walk'), 2600);
      return () => clearTimeout(t);
    }
    if (mode !== 'walk') return;
    setPose('walking');
    let raf = 0;
    let last = performance.now();
    const until = last + 3500 + Math.random() * 3000;
    const tick = (now: number) => {
      const max = Math.max(8, width - SIZE - 8);
      let nx = pos.current.x + pos.current.dir * SPEED * ((now - last) / 1000);
      last = now;
      if (nx <= 8 || nx >= max) {
        nx = Math.min(max, Math.max(8, nx));
        pos.current.dir = (pos.current.dir * -1) as 1 | -1;
        setDir(pos.current.dir);
      }
      pos.current.x = nx;
      setX(nx);
      if (now > until) setMode('rest');
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, reduced, width]);

  // A reaction shows for a few seconds, then SMOI goes back to its walk.
  useEffect(() => {
    if (mode !== 'react') return;
    const t = setTimeout(() => {
      setLine(null);
      setCaption(null);
      setMode(reduced ? 'rest' : 'walk');
    }, 4200);
    return () => clearTimeout(t);
  }, [mode, line, reduced]);

  useEffect(() => {
    if (mode === 'menu') panel.current?.focusFirst();
  }, [mode]);

  const show = (event: 'hello' | 'closed' | PanelRowId) => {
    const effect = effectOf(event, AVAILABLE_ROWS, FACTS);
    if (!effect) return;
    setPose(poseName(smoi, effect.frog as FrogState));
    setLine(effect.bubble);
    setMood(effect.mood);
    setCaption(effect.opens ? `In the app, this opens ${OPENS[effect.opens] ?? effect.opens}.` : null);
  };

  const open = () => {
    if (mode === 'menu') return close();
    show('hello');
    setCaption(null);
    setMode('menu');
  };
  const close = () => {
    show('closed');
    setMode('react');
    frogButton.current?.focus();
  };
  const choose = (row: PanelRowId) => {
    show(row);
    setMode('react');
    frogButton.current?.focus();
  };

  const frogX = Math.min(x, Math.max(8, width - SIZE - 8));
  const centre = frogX + SIZE / 2;
  // The panel goes on the roomier side, clear of the speech bubble (up to 300px wide, centred on the frog).
  const clear = 150 + 14;
  const panelLeft = centre > width / 2 ? Math.max(8, centre - clear - 300) : Math.min(width - 308, centre + clear);

  return (
    <div className="desktop-demo">
      <div className="screen" ref={screen}>
        <div className="screen-window" aria-hidden="true">
          <div className="screen-window-bar"><i /><i /><i /></div>
          <div className="screen-window-lines"><b /><b /><b /><b /></div>
        </div>
        {line && <PointingBubble line={line} anchorX={centre} containerWidth={width} bottom={TASKBAR + SIZE - 30} />}
        <button
          ref={frogButton}
          type="button"
          className="screen-frog"
          style={{ left: frogX, bottom: TASKBAR }}
          aria-label={mode === 'menu' ? 'Close SMOI menu' : 'Click SMOI to open its menu'}
          aria-expanded={mode === 'menu'}
          onClick={open}
        >
          <Sprite companion={smoi} pose={pose} scale={SCALE} mirrored={pose === 'walking' && dir < 0} label="" />
        </button>
        {mode === 'menu' && (
          <div className="scene-panel" style={{ ['--panel-left' as string]: `${panelLeft}px`, ['--panel-bottom' as string]: `${TASKBAR + 8}px` }}>
            <PanelView ref={panel} mood={mood} rows={rows} rise onChoose={choose} onClose={close} />
          </div>
        )}
        <div className="taskbar" aria-hidden="true">
          <span className="taskbar-start" />
          <span /><span /><span />
          <span className="taskbar-clock">SMOI</span>
        </div>
      </div>
      <p className="demo-caption" aria-live="polite">
        {caption ?? (mode === 'menu'
          ? 'Pick anything. Use the arrow keys, Enter, or Esc to close.'
          : 'Try it: click the frog. (Sample data, so every row has something to say.)')}
      </p>
    </div>
  );
}
