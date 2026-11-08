import { useEffect, useState } from 'react';
import type { FrogState } from '@desktop/shared/animations';
import type { CompanionInfo } from '@desktop/shared/companions';
import { poseName } from '@desktop/shared/companions';
import { AVAILABLE_ROWS, effectOf, type BubbleLine } from '@desktop/shared/panelActions';
import { PRESETS, react, type PresetId } from '@desktop/shared/personality';
import { BubbleView } from '@desktop/renderer/components/BubbleView';
import { CenteredBubble } from '../CenteredBubble';
import { Sprite } from '../Sprite';
import { Scene, useReducedMotion } from '../motion';
import { companions, smoi } from '../roster';

/** The design's 12 expressions, and the pose that matches each one. */
const MOODS: { face: string; pose: string }[] = [
  { face: 'joyful', pose: 'happy' },
  { face: 'chatty', pose: 'speaking' },
  { face: 'pondering', pose: 'thinking' },
  { face: 'focused', pose: 'working' },
  { face: 'attentive', pose: 'listening' },
  { face: 'starry-eyed', pose: 'celebrating' },
  { face: 'shocked', pose: 'surprised' },
  { face: 'grumpy', pose: 'annoyed' },
  { face: 'sassy', pose: 'happy' },
  { face: 'confused', pose: 'error' },
  { face: 'sleepy', pose: 'sleeping' },
  { face: 'neutral', pose: 'idle' },
];

export function MoodsScene() {
  const [mood, setMood] = useState(MOODS[0]);
  return (
    <Scene id="moods" tone="cream" label="SMOI's moods">
      <p className="kicker">Twelve moods, all pixel by pixel</p>
      <h2>It has <mark className="hl hl-lavender">feelings</mark>. Lots of them.</h2>
      <p className="lede">Thinking while it reads, chatty while it answers, smug when it's right. Pick one.</p>
      <div className="moods">
        <div className="moods-stage">
          <Sprite companion={smoi} pose={mood.pose} scale={3} label={`SMOI looking ${mood.face}`} />
          <span className="moods-name">{mood.face}</span>
        </div>
        <div className="moods-grid" role="group" aria-label="Moods">
          {MOODS.map((m) => (
            <button
              key={m.face}
              type="button"
              className={`mood${m === mood ? ' on' : ''}`}
              aria-pressed={m === mood}
              onMouseEnter={() => setMood(m)}
              onFocus={() => setMood(m)}
              onClick={() => setMood(m)}
            >
              <img src={`./expressions/${m.face}.png`} width={96} height={80} alt="" />
              <span>{m.face}</span>
            </button>
          ))}
        </div>
      </div>
    </Scene>
  );
}

export function FriendsScene() {
  return (
    <Scene id="friends" tone="green" label="Companions">
      <p className="kicker">Not a frog person?</p>
      <h2>Pick your <mark className="hl hl-paper">friend</mark>.</h2>
      <p className="lede">SMOI brought company. Each one has its own look, voice and opinions about your day.</p>
      <div className="friends">
        {companions.map((c) => <FriendCard key={c.id} c={c} />)}
      </div>
    </Scene>
  );
}

function FriendCard({ c }: { c: CompanionInfo }) {
  const [hello, setHello] = useState(false);
  useEffect(() => {
    if (!hello) return;
    const t = setTimeout(() => setHello(false), 2400);
    return () => clearTimeout(t);
  }, [hello]);
  return (
    <button type="button" className="card friend" onClick={() => setHello(true)} aria-label={`${c.name}, the ${c.creature}. Say hi.`}>
      <span className="friend-head" style={c.accent ? { background: c.accent } : undefined}>
        <strong>{c.name}</strong>
        <small>{c.creature}</small>
      </span>
      <span className="friend-sprite">
        <Sprite companion={c} pose={hello ? 'happy' : 'idle'} scale={2} label="" />
      </span>
      <span className="friend-tag">{c.tagline}</span>
      {c.lines[0] && <span className="friend-line">“{c.lines[0]}”</span>}
    </button>
  );
}

const ORDER: PresetId[] = ['classic', 'gentle', 'sassy', 'quiet'];

export function PersonalityScene() {
  const [preset, setPreset] = useState<PresetId>('classic');
  const p = PRESETS[preset].values;
  const reactions = [
    react({ type: 'indexed', count: 2 }, p),
    react({ type: 'task_saved', title: 'Buy oat milk' }, p),
    react({ type: 'overdue', count: 3 }, p),
  ];
  const lines = reactions.map((r) => r.line).filter((l): l is BubbleLine => l !== null);
  return (
    <Scene id="personality" tone="paper" label="Personality">
      <p className="kicker">Make it yours</p>
      <h2>Pick its <mark className="hl hl-pink">personality</mark>.</h2>
      <p className="lede">Sweet, sassy or strictly business. Same frog, different attitude.</p>
      <div className="presets" role="radiogroup" aria-label="Personality">
        {ORDER.map((id) => (
          <button key={id} type="button" role="radio" aria-checked={id === preset}
            className={`btn btn-preset${id === preset ? ' on' : ''}`} onClick={() => setPreset(id)}>
            {PRESETS[id].label}
          </button>
        ))}
      </div>
      <div className="personality">
        <Sprite companion={smoi} pose={poseName(smoi, reactions[0].frog as FrogState)} scale={3} label="SMOI" />
        <div className="personality-lines" aria-live="polite">
          {lines.map((l) => <BubbleView key={`${preset}-${l.text}`} tone={l.tone} text={l.text} tail="none" pop />)}
        </div>
      </div>
    </Scene>
  );
}

/** Real lines: SMOI's manifest lines, and the lines the app's panel says. */
const SAYS: string[] = [
  ...smoi.lines,
  ...(['closed', 'dashboard', 'talk'] as const).map((e) => effectOf(e, AVAILABLE_ROWS, {})?.bubble?.text),
  effectOf('calendar', AVAILABLE_ROWS, { busyToday: true })?.bubble?.text,
].filter((t): t is string => !!t);

export function LinesScene() {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setI((n) => (n + 1) % SAYS.length), 3400);
    return () => clearInterval(t);
  }, [reduced]);
  return (
    <Scene id="says" tone="cream" label="Things SMOI says">
      <p className="kicker">Affectionate, slightly chaotic, occasionally sarcastic</p>
      <h2>Things SMOI <mark className="hl hl-blue">says</mark>.</h2>
      <div className="says">
        <div className="says-bubble">
          <CenteredBubble line={{ tone: 'nudge', text: SAYS[i] }} />
        </div>
        <Sprite companion={smoi} pose="speaking" scale={3} label="SMOI talking" />
        <button type="button" className="btn btn-small" onClick={() => setI((n) => (n + 1) % SAYS.length)}>Another one</button>
      </div>
    </Scene>
  );
}
