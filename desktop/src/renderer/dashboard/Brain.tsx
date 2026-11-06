import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AnswerView } from '../../shared/answer';
import { FINAL } from '../../shared/answer';
import type { DocumentInfo, FoldersInfo, SourceRef } from '../../shared/apiTypes';
import { describeProgress } from '../../shared/folderSync';
import { AnswerBlock } from './AnswerBlock';
import { Face } from './Face';
import { SourceViewer } from './SourceViewer';

const api = () => window.smoiDashboard;

export interface Exchange {
  key: string;
  question: string;
  view: AnswerView;
}

interface BrainProps {
  docs: DocumentInfo[];
  /** Watched folders and their progress; null until loaded. */
  folders: FoldersInfo | null;
  exchanges: Exchange[];
  onAsk: (question: string) => Promise<string | null>;
  /** Increments when "Talk to SMOI" asks for the question box to be focused. */
  focusAsk: number;
}

const STATUS_TEXT: Record<DocumentInfo['status'], string> = {
  queued: 'Waiting to be indexed',
  processing: 'Indexing',
  indexed: 'Indexed',
  failed: 'Failed',
};

/** SMOI Brain: upload documents, watch them index, and ask questions with cited answers. */
export function Brain({ docs, folders, exchanges, onAsk, focusAsk }: BrainProps) {
  const [docError, setDocError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [question, setQuestion] = useState('');
  const [askError, setAskError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceRef | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const ask = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // Braces matter: an effect may return only a cleanup function, and Chromium's scrollIntoView
  // returns a Promise.
  useEffect(() => {
    ask.current?.focus();
  }, [focusAsk]);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [exchanges]);

  const running = exchanges.some((x) => !FINAL.has(x.view.status));

  const upload = async () => {
    setUploading(true);
    setDocError(null);
    const r = await api().upload();
    setUploading(false);
    if (!r.ok) setDocError(r.error.message);
  };

  const addFolder = async () => {
    setDocError(null);
    const r = await api().addFolder();
    if (!r.ok) setDocError(r.error.message);
  };

  const removeFolder = async (id: string) => {
    setDocError(null);
    const r = await api().removeFolder(id);
    if (!r.ok) setDocError(r.error.message);
  };

  const retryOcr = async () => {
    setDocError(null);
    const r = await api().retryOcr();
    if (!r.ok) setDocError(r.error.message);
  };

  const remove = async (id: string) => {
    const r = await api().deleteDocument(id);
    if (!r.ok) setDocError(r.error.message);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q || running) return;
    setAskError(null);
    const error = await onAsk(q);
    if (error) setAskError(error);
    else setQuestion('');
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
  const closeSource = () => {
    setSource(null);
    opener.current?.focus();
  };

  return (
    <>
      <h2>SMOI Brain</h2>
      <div className="brain">
        <section className="card" aria-labelledby="h-documents">
          <h3 id="h-documents">Documents</h3>
          <button className="btn primary" type="button" onClick={upload} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Add documents…'}
          </button>
          <p className="hint">PDF, Word (DOCX) or text files.</p>
          {docError && <div className="banner error" role="alert"><Face name="shocked" /><span>{docError}</span></div>}
          <h4 id="h-folders">Watched folders</h4>
          <button className="btn" type="button" onClick={addFolder}>Add folder…</button>
          <p className="hint">SMOI keeps PDF, Word and text files in these folders indexed. It only reads them.</p>
          {folders && folders.folders.length > 0 && (
            <>
              <p className="hint" aria-live="polite">{describeProgress(folders)}</p>
              {folders.needsOcr > 0 && folders.ocrEnabled && (
                <button className="btn small" type="button" onClick={retryOcr}>Read scanned PDFs with OCR</button>
              )}
              <ul className="doc-list" aria-labelledby="h-folders">
                {folders.folders.map((f) => (
                  <li key={f.id} className="doc">
                    <span className="doc-name">{f.path}</span>
                    <div className="doc-row">
                      <span>{describeProgress(f)}</span>
                      <button type="button" className="btn small" onClick={() => void removeFolder(f.id)}
                              aria-label={`Stop watching ${f.path}`}>Stop watching</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>Files</h4>
          {docs.length === 0 && <p>No documents yet.</p>}
          <ul className="doc-list" aria-label="Documents">
            {docs.map((d) => (
              <li key={d.id} className="doc">
                <span className="doc-name">{d.filename}</span>
                <div className="doc-row">
                  <span className={`status-tag ${d.status}`}>{STATUS_TEXT[d.status]}</span>
                  {d.status === 'indexed' && <span>{d.chunkCount} passages</span>}
                  <button type="button" className="btn small" onClick={() => void remove(d.id)}
                          aria-label={`Delete ${d.filename}`}>Delete</button>
                </div>
                {d.status === 'failed' && d.error && <span className="hint">Reason: {d.error}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className="card chat" aria-labelledby="h-chat">
          <h3 id="h-chat">Ask SMOI Brain</h3>
          <div className="messages" aria-live="polite">
            {exchanges.length === 0 && <p>Answers use only your documents and cite the passages they come from.</p>}
            {exchanges.map((x) => (
              <div key={x.key} className="answer">
                <p className="question">{x.question}</p>
                <AnswerBlock view={x.view} onOpenSource={openSource} />
              </div>
            ))}
            <div ref={end} />
          </div>
          {askError && <div className="banner error" role="alert"><Face name="shocked" /><span>{askError}</span></div>}
          <form className="ask" onSubmit={submit}>
            <label className="visually-hidden" htmlFor="ask">Your question</label>
            <textarea id="ask" ref={ask} rows={2} maxLength={2000} value={question}
                      aria-describedby="ask-hint"
                      onChange={(e) => setQuestion(e.target.value)} onKeyDown={onKeyDown} />
            <button className="btn primary" type="submit" disabled={running || !question.trim()}>Ask</button>
          </form>
          <p id="ask-hint" className="hint">Enter sends. Shift+Enter starts a new line.</p>
        </section>
      </div>
      {source && <SourceViewer source={source} onClose={closeSource} />}
    </>
  );
}
