import { useCallback, useEffect, useRef, useState } from 'react';
import { describeSource, initialAnswer, reduceAnswer, type AnswerView } from '@desktop/shared/answer';
import type { SourceRef, StreamEvent } from '@desktop/shared/apiTypes';
import { FINDING } from '@desktop/shared/panelActions';
import recording from '../data/brain-demo.json';
import { CenteredBubble } from '../CenteredBubble';
import { Sprite } from '../Sprite';
import { Scene, useInView, useReducedMotion } from '../motion';
import { smoi } from '../roster';

/** What `site/scripts/record-demo.ts` writes: one real answer from SMOI's backend, as streamed. */
export interface Recording {
  recorded: boolean;
  script: string;
  recordedAt?: string;
  question?: string;
  provider?: string;
  model?: string;
  events?: StreamEvent[];
  /** The text of each cited passage, by chunk id, for the source previews. */
  passages?: Record<string, string>;
}

const demo = recording as Recording;

type Phase = 'idle' | 'typing' | 'thinking' | 'streaming' | 'done';

export function AskScene({ data = demo }: { data?: Recording }) {
  return (
    <Scene id="ask" tone="cream" label="Ask your files anything">
      <p className="kicker">SMOI Brain</p>
      <h2>Ask your files <mark className="hl hl-pink">anything</mark>.</h2>
      <p className="lede">
        Drop in PDFs, Word documents and notes, or point SMOI at a folder. Ask in plain words and get
        an answer that shows exactly where it came from. If your files don't say, SMOI says so.
      </p>
      {data.recorded && data.events?.length ? <Player data={data} /> : <p className="demo-caption">The recorded answer isn't in this build yet.</p>}
    </Scene>
  );
}

function Player({ data }: { data: Recording }) {
  const reduced = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>(0.4);
  const question = data.question ?? '';
  const events = data.events ?? [];
  const [phase, setPhase] = useState<Phase>('idle');
  const [typed, setTyped] = useState('');
  const [view, setView] = useState<AnswerView>(initialAnswer);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const finish = useCallback(() => {
    setTyped(question);
    setView(events.reduce(reduceAnswer, initialAnswer));
    setPhase('done');
  }, [events, question]);

  const play = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (reduced) return finish();
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    setTyped('');
    setView(initialAnswer);
    setPhase('typing');
    let t = 300;
    for (let i = 1; i <= question.length; i++) {
      const upTo = question.slice(0, i);
      at(t, () => setTyped(upTo));
      t += 38;
    }
    at(t, () => setPhase('thinking'));
    t += 1300;
    for (const e of events) {
      at(t, () => {
        setView((v) => reduceAnswer(v, e));
        if (e.type === 'delta') setPhase('streaming');
      });
      t += e.type === 'delta' ? Math.max(28, e.text.length * 14) : 120;
    }
    at(t, () => setPhase('done'));
  }, [events, finish, question, reduced]);

  useEffect(() => {
    if (seen) play();
    return () => timers.current.forEach(clearTimeout);
  }, [seen, play]);

  const pose = phase === 'thinking' || phase === 'typing' ? 'thinking'
    : phase === 'streaming' ? 'speaking'
      : phase === 'done' ? 'happy' : 'idle';
  const date = data.recordedAt ? new Date(data.recordedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  return (
    <div className="ask-demo" ref={ref}>
      <div className="ask-frog">
        <div className="ask-finding">{phase === 'done' && view.status === 'answered' && <CenteredBubble line={FINDING} />}</div>
        <Sprite companion={smoi} pose={pose} scale={3} label={`SMOI is ${pose === 'speaking' ? 'answering' : pose}`} />
      </div>
      <div className="card chat" aria-live="polite">
        <div className="chat-title">Ask SMOI Brain</div>
        <div className="chat-question" aria-label="Question">
          {typed}
          {phase === 'typing' && <span className="caret" aria-hidden="true" />}
        </div>
        {phase !== 'idle' && phase !== 'typing' && (
          <div className="chat-answer">
            <div className="chat-status">
              <img src={`./expressions/${phase === 'done' ? 'joyful' : phase === 'streaming' ? 'chatty' : 'pondering'}.png`} width={48} height={40} alt="" />
              <span>{phase === 'thinking' ? 'Searching your documents…' : phase === 'streaming' ? 'Writing…' : 'Answer'}</span>
            </div>
            {view.text && <p className="chat-text" data-testid="answer-text">{view.text}</p>}
            {view.citations.length > 0 && (
              <div className="chips">
                {view.citations.map((c) => <SourceChip key={c.label} source={c} text={data.passages?.[c.chunkId]} />)}
              </div>
            )}
          </div>
        )}
        <div className="chat-foot">
          <button type="button" className="btn btn-small" onClick={play} disabled={phase !== 'done' && phase !== 'idle'}>
            Play again
          </button>
          <span>
            A real answer from SMOI{date ? `, recorded ${date}` : ''}
            {data.model ? (data.provider === 'ollama' ? ` by a local model (${data.model})` : ` by ${data.model}`) : ''}.
          </span>
        </div>
      </div>
    </div>
  );
}

/** A citation chip. Hover, focus or tap shows the passage it points to. */
function SourceChip({ source, text }: { source: SourceRef; text?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="chip-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="chip"
        aria-expanded={open}
        // Hover already opened it on a laptop; a tap on a phone opens it. Esc, blur or leaving close it.
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
      >
        [{source.label}] {describeSource(source)}
      </button>
      {open && text && (
        <span className="chip-pop" role="tooltip">
          <strong>{describeSource(source)}</strong>
          <span>“{text.length > 360 ? `${text.slice(0, 360).trimEnd()}…` : text}”</span>
        </span>
      )}
    </span>
  );
}
