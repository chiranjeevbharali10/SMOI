import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { SourceRef } from '../../shared/apiTypes';
import type { CommandOutcome } from '../../shared/bridge';
import { AnswerBlock } from './AnswerBlock';
import type { Exchange } from './Brain';
import { Face } from './Face';
import { SourceViewer } from './SourceViewer';

const api = () => window.smoiDashboard;

type Entry =
  | { key: string; kind: 'you'; text: string }
  | { key: string; kind: 'command'; outcome: CommandOutcome; state: 'waiting' | 'done' | 'cancelled'; result?: string; error?: string }
  | { key: string; kind: 'answer'; exchangeKey: string }
  | { key: string; kind: 'error'; text: string };

interface TalkProps {
  exchanges: Exchange[];
  onAsk: (question: string) => Promise<{ key: string } | { error: string }>;
  focusAsk: number;
}

let counter = 0;
const nextKey = () => `e${++counter}`;

/**
 * "Talk to SMOI": type a command or a question (FR-03.04 to FR-03.06). SMOI shows what it
 * understood first; a task or reminder is only created when you press the button.
 */
export function Talk({ exchanges, onAsk, focusAsk }: TalkProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<SourceRef | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, [focusAsk]);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [entries, exchanges]);

  const add = (e: Entry) => setEntries((xs) => [...xs, e]);
  const patch = (key: string, p: Partial<Entry>) => setEntries((xs) => xs.map((x) => (x.key === key ? ({ ...x, ...p } as Entry) : x)));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    add({ key: nextKey(), kind: 'you', text: t });
    setText('');
    const r = await api().command(t);
    setBusy(false);
    if (!r.ok) {
      add({ key: nextKey(), kind: 'error', text: r.error.message });
      return;
    }
    const p = r.value.proposal;
    if (p.intent === 'ask_brain' && p.question && !p.problem) {
      const asked = await onAsk(p.question);
      if ('error' in asked) add({ key: nextKey(), kind: 'error', text: asked.error });
      else add({ key: nextKey(), kind: 'answer', exchangeKey: asked.key });
      return;
    }
    add({ key: nextKey(), kind: 'command', outcome: r.value, state: r.value.view.actionable ? 'waiting' : 'done' });
  };

  const confirm = async (entry: Extract<Entry, { kind: 'command' }>) => {
    const r = await api().confirmCommand(entry.outcome.id);
    if (r.ok) patch(entry.key, { state: 'done', result: r.value.saved });
    else patch(entry.key, { state: 'cancelled', error: r.error.message });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const openSource = (s: SourceRef) => {
    opener.current = document.activeElement as HTMLElement;
    setSource(s);
  };

  return (
    <>
      <h2>Talk to SMOI</h2>
      <section className="card chat talk" aria-labelledby="h-talk">
        <h3 id="h-talk" className="visually-hidden">Conversation</h3>
        <div className="messages" aria-live="polite">
          {entries.length === 0 && (
            <p>
              Ask about your documents, or tell SMOI what to remember. For example: “remind me to call mum tomorrow at 6pm”,
              “add buy oat milk to my list for Friday”, or “what does the report say about natterjack toads?”
            </p>
          )}
          {entries.map((x) => {
            if (x.kind === 'you') return <p key={x.key} className="question">{x.text}</p>;
            if (x.kind === 'error') {
              return <div key={x.key} className="banner error" role="alert"><Face name="shocked" /><span>{x.text}</span></div>;
            }
            if (x.kind === 'answer') {
              const ex = exchanges.find((e) => e.key === x.exchangeKey);
              return ex ? <AnswerBlock key={x.key} view={ex.view} onOpenSource={openSource} /> : null;
            }
            const v = x.outcome.view;
            return (
              <div key={x.key} className="passage proposal">
                <p><strong>{v.heading}</strong></p>
                {v.details.length > 0 && <ul className="notes">{v.details.map((d) => <li key={d} className="plain">{d}</li>)}</ul>}
                {x.state === 'waiting' && (
                  <div className="row">
                    <button className="btn primary" type="button" onClick={() => void confirm(x)}>{v.confirmLabel}</button>
                    <button className="btn" type="button" onClick={() => patch(x.key, { state: 'cancelled' })}>Cancel</button>
                  </div>
                )}
                {x.result && <p className="answer-status"><Face name="joyful" /> {x.result}</p>}
                {x.state === 'cancelled' && !x.error && <p className="hint">Cancelled. Nothing was created.</p>}
                {x.error && <p className="answer-status"><Face name="shocked" /> {x.error}</p>}
              </div>
            );
          })}
          {busy && <p className="answer-status"><Face name="pondering" /> Working out what you mean…</p>}
          <div ref={end} />
        </div>
        <form className="ask" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="talk">Message to SMOI</label>
          <textarea id="talk" ref={box} rows={2} maxLength={1000} value={text} aria-describedby="talk-hint"
                    onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
          <button className="btn primary" type="submit" disabled={busy || !text.trim()}>Send</button>
        </form>
        <p id="talk-hint" className="hint">Enter sends. Shift+Enter starts a new line. Nothing is created until you confirm it.</p>
      </section>
      {source && <SourceViewer source={source} onClose={() => { setSource(null); opener.current?.focus(); }} />}
    </>
  );
}
