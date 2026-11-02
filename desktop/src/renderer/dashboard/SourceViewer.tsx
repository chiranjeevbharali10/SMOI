import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { describeSource } from '../../shared/answer';
import type { ChunkInfo, SourceRef } from '../../shared/apiTypes';
import { Face } from './Face';

const api = () => window.smoiDashboard;

/** Chunks shown either side of the cited one, for context. */
const CONTEXT = 2;

/**
 * Opens a cited source: the cited chunk, highlighted, with its neighbours. It shows the text SMOI
 * indexed, not the original file: the backend has no endpoint that returns the file (see
 * docs/adr/0013). All text is plain text.
 *
 * Esc or Close returns focus to the button that opened it (the caller restores it).
 */
export function SourceViewer({ source, onClose }: { source: SourceRef; onClose: () => void }) {
  const [chunks, setChunks] = useState<ChunkInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const cited = useRef<HTMLDivElement>(null);

  useEffect(() => {
    closeBtn.current?.focus();
    void api().chunks(source.documentId).then((r) => (r.ok ? setChunks(r.value) : setError(r.error.message)));
  }, [source.documentId]);

  useEffect(() => cited.current?.scrollIntoView({ block: 'center' }), [chunks]);

  const shown = chunks?.filter((c) => Math.abs(c.index - source.chunkIndex) <= CONTEXT) ?? [];
  const found = chunks ? chunks.some((c) => c.id === source.chunkId) : true;

  // Keep keyboard focus inside the dialog while it's open.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]') ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="viewer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer" role="dialog" aria-modal="true" aria-labelledby="viewer-title" ref={dialog} onKeyDown={onKeyDown}>
        <div className="viewer-head">
          <h2 id="viewer-title">[{source.label}] {describeSource(source)}</h2>
          <button ref={closeBtn} type="button" className="btn small" onClick={onClose}>Close</button>
        </div>
        <p className="hint">The text SMOI indexed from this document. The cited passage is highlighted.</p>
        {error && <p className="banner error" role="alert"><Face name="shocked" /> {error}</p>}
        {!chunks && !error && <p>Loading…</p>}
        {chunks && !found && (
          <p className="banner error" role="alert">
            This passage is no longer in SMOI Brain. The document may have been deleted or re-indexed since the answer.
          </p>
        )}
        <div className="chunks" tabIndex={0} aria-label="Passages">
          {shown.map((c) => {
            const isCited = c.id === source.chunkId;
            return (
              <div key={c.id} ref={isCited ? cited : undefined} className={`chunk${isCited ? ' cited' : ''}`}>
                <p className="chunk-meta">
                  {isCited ? 'Cited passage' : 'Nearby passage'}, chunk {c.index + 1}
                  {c.pageStart != null ? `, page ${c.pageStart}${c.pageEnd != null && c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ''}` : ''}
                  {c.section ? `, ${c.section}` : ''}
                </p>
                <p className="plain" data-testid="chunk-text">{c.content}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
