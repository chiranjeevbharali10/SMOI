import type { AnswerView } from '../../shared/answer';
import { describeSource } from '../../shared/answer';
import type { SourceRef } from '../../shared/apiTypes';
import { Face, type FaceName } from './Face';

/**
 * One answer. Everything that came from the model or from documents is rendered as plain text
 * (React text nodes, never HTML), so markup, image links and URLs in retrieved content show as
 * the characters they are: nothing loads, nothing is clickable.
 */
const STATUS: Record<AnswerView['status'], { face: FaceName; label: string }> = {
  waiting: { face: 'pondering', label: 'Searching your documents…' },
  streaming: { face: 'chatty', label: 'Writing. Sources are checked when the answer is finished.' },
  answered: { face: 'joyful', label: 'Answer' },
  dont_know: { face: 'confused', label: "Not in your documents" },
  withheld: { face: 'shocked', label: 'Answer withheld' },
  fallback: { face: 'shocked', label: 'No answer: the language model is unavailable' },
  incomplete: { face: 'shocked', label: 'Incomplete answer' },
  failed: { face: 'shocked', label: 'The question failed' },
};

export function AnswerBlock({ view, onOpenSource }: { view: AnswerView; onOpenSource: (s: SourceRef) => void }) {
  const status = STATUS[view.status];
  return (
    <article className="answer" aria-busy={view.status === 'waiting' || view.status === 'streaming'}>
      <div className="answer-status">
        <Face name={status.face} />
        <span>{status.label}</span>
      </div>
      {view.notice && <p className={`banner ${view.status === 'dont_know' ? 'info' : 'error'}`}>{view.notice}</p>}
      {view.text && (
        <p className="plain" data-testid="answer-text">
          {view.text}
          {view.status === 'incomplete' && <span className="incomplete-mark"> [incomplete]</span>}
        </p>
      )}
      {view.citations.length > 0 && (
        <div>
          <h3 className="visually-hidden">Sources</h3>
          <div className="sources">
            {view.citations.map((c) => (
              <button key={c.label} type="button" className="btn small" onClick={() => onOpenSource(c)}>
                [{c.label}] {describeSource(c)}
              </button>
            ))}
          </div>
        </div>
      )}
      {view.passages.length > 0 && (
        <div className="answer">
          {view.passages.map((p) => (
            <section key={p.chunkId} className="passage" aria-label={`Passage from ${describeSource(p)}`}>
              <div className="doc-row">
                <strong>{describeSource(p)}</strong>
                <button type="button" className="btn small" onClick={() => onOpenSource(p)}>Open source</button>
              </div>
              <p className="plain" data-testid="passage-text">{p.content}</p>
            </section>
          ))}
        </div>
      )}
      {view.notes.length > 0 && (
        <ul className="notes">{view.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
    </article>
  );
}
