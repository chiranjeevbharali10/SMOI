import { useCallback, useEffect, useRef, useState } from 'react';
import { initialAnswer, reduceAnswer } from '../../shared/answer';
import type { DocumentInfo, StreamEvent } from '../../shared/apiTypes';
import type { BackendStatus, DashboardView, SessionStatus, UserSettings } from '../../shared/bridge';
import { Brain, type Exchange } from './Brain';
import { Face } from './Face';
import { Home } from './Home';
import { Login } from './Login';
import { Settings } from './Settings';

const api = () => window.smoiDashboard;

const NAV: { view: Exclude<DashboardView, 'chat'>; label: string }[] = [
  { view: 'home', label: 'Home' },
  { view: 'brain', label: 'SMOI Brain' },
  { view: 'settings', label: 'Settings' },
];

/** The dashboard window: login, then Home, SMOI Brain and Settings. */
export function App() {
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [view, setView] = useState<Exclude<DashboardView, 'chat'>>('home');
  const [focusAsk, setFocusAsk] = useState(0);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  /** Events can arrive before ask() has returned the request id; they wait here. */
  const early = useRef(new Map<string, StreamEvent[]>());
  const known = useRef(new Set<string>());

  const navigate = useCallback((v: DashboardView) => {
    if (v === 'chat') {
      setView('brain');
      setFocusAsk((n) => n + 1);
    } else setView(v);
  }, []);

  useEffect(() => {
    void api().session().then(setSession);
    void api().backend().then(setBackend);
    void api().settings().then(setSettings);
    api().onSession(setSession);
    api().onBackend(setBackend);
    api().onSettings(setSettings);
    api().onDocuments(setDocs);
    api().onNavigate(navigate);
    api().onAnswer(({ requestId, event }) => {
      if (!known.current.has(requestId)) {
        early.current.set(requestId, [...(early.current.get(requestId) ?? []), event]);
        return;
      }
      setExchanges((xs) => xs.map((x) => (x.key === requestId ? { ...x, view: reduceAnswer(x.view, event) } : x)));
    });
  }, [navigate]);

  // Ready for input once the first screen has drawn (the NFR-01.02 measurement ends here).
  const reported = useRef(false);
  useEffect(() => {
    if (!session || reported.current) return;
    reported.current = true;
    requestAnimationFrame(() => setTimeout(() => api().ready(), 0));
  }, [session]);

  useEffect(() => {
    if (session?.signedIn) void api().documents().then((r) => r.ok && setDocs(r.value));
  }, [session?.signedIn]);

  const onAsk = async (question: string): Promise<string | null> => {
    const r = await api().ask(question);
    if (!r.ok) return r.error.message;
    const id = r.value.requestId;
    known.current.add(id);
    const waiting = early.current.get(id) ?? [];
    early.current.delete(id);
    setExchanges((xs) => [...xs, { key: id, question, view: waiting.reduce(reduceAnswer, initialAnswer) }]);
    return null;
  };

  if (!session) return null;

  const backendDown = backend && !backend.reachable && (
    <div className="banner error" role="alert">
      <Face name="shocked" />
      <span>
        <strong>Can't reach the SMOI backend</strong> at {backend.url}. Check that it's running. SMOI checks again
        every 10 seconds.
      </span>
    </div>
  );

  if (!session.signedIn) {
    return (
      <div className="app">
        {backendDown && <div style={{ padding: '16px 24px 0' }}>{backendDown}</div>}
        <Login onSignedIn={setSession} />
      </div>
    );
  }

  const indexing = docs.filter((d) => d.status === 'queued' || d.status === 'processing').length;

  return (
    <div className="app">
      <header className="topbar">
        <h1>SMOI</h1>
        <nav aria-label="Dashboard">
          {NAV.map((n) => (
            <button key={n.view} type="button" className="btn nav-btn" aria-current={view === n.view ? 'page' : undefined}
                    onClick={() => setView(n.view)}>{n.label}</button>
          ))}
        </nav>
        <div className="account">
          <span>{session.email}</span>
          <button type="button" className="btn small" onClick={() => void api().signOut().then(setSession)}>Sign out</button>
        </div>
      </header>
      <main className="main">
        {backendDown}
        {!session.persisted && (
          <div className="banner info" role="status">
            <Face name="neutral" />
            <span>Windows can't encrypt SMOI's saved sign-in on this computer, so it isn't saved. You'll need to sign in again next time.</span>
          </div>
        )}
        {indexing > 0 && (
          <div className="banner working" role="status">
            <Face name="focused" />
            <span><strong>Indexing</strong> {indexing} {indexing === 1 ? 'document' : 'documents'}. They become searchable when finished.</span>
          </div>
        )}
        {view === 'home' && backend && <Home docs={docs} backend={backend} go={navigate} />}
        {view === 'brain' && <Brain docs={docs} exchanges={exchanges} onAsk={onAsk} focusAsk={focusAsk} />}
        {view === 'settings' && settings && <Settings settings={settings} />}
      </main>
    </div>
  );
}
