import { useEffect, useState } from 'react';
import type { DocumentInfo, Me, Providers } from '../../shared/apiTypes';
import type { BackendStatus, DashboardView } from '../../shared/bridge';
import { Face } from './Face';

const api = () => window.smoiDashboard;

/** The dashboard's front page: what SMOI is connected to and what it is doing. */
export function Home({ docs, backend, go }: { docs: DocumentInfo[]; backend: BackendStatus; go: (v: DashboardView) => void }) {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!backend.reachable) return;
    void api().providers().then((r) => (r.ok ? setProviders(r.value) : setError(r.error.message)));
    void api().me().then((r) => {
      if (r.ok) setMe(r.value);
    });
  }, [backend.reachable]);

  const count = (s: DocumentInfo['status'][]) => docs.filter((d) => s.includes(d.status)).length;
  const indexed = count(['indexed']);
  const indexing = count(['queued', 'processing']);
  const failed = count(['failed']);
  const where = (hosted: boolean) => (hosted ? 'hosted: content leaves this computer' : 'runs locally');

  return (
    <>
      <h2>Home</h2>
      <div className="grid">
        <section className="card" aria-labelledby="h-docs">
          <h3 id="h-docs">SMOI Brain</h3>
          <p className="stat">{indexed}</p>
          <p>{indexed === 1 ? 'document indexed' : 'documents indexed'}</p>
          {indexing > 0 && <p className="answer-status"><Face name="focused" /> Indexing {indexing} now.</p>}
          {failed > 0 && <p className="answer-status"><Face name="confused" /> {failed} failed. SMOI Brain shows why.</p>}
          <button className="btn primary" type="button" onClick={() => go('brain')}>Open SMOI Brain</button>
        </section>
        <section className="card" aria-labelledby="h-models">
          <h3 id="h-models">Models</h3>
          {error && <p>{error}</p>}
          {!providers && !error && <p>{backend.reachable ? 'Loading…' : 'Unknown while the backend is unreachable.'}</p>}
          {providers && (
            <dl className="facts">
              <dt>Answers</dt>
              <dd>{providers.llm.provider}, {providers.llm.model} ({where(providers.llm.hosted)})</dd>
              <dt>Embeddings</dt>
              <dd>{providers.embedding.model} ({where(providers.embedding.hosted)})</dd>
              <dt>Reranker</dt>
              <dd>{providers.reranker.enabled ? `${providers.reranker.model} (${where(providers.reranker.hosted)})` : 'off'}</dd>
            </dl>
          )}
        </section>
        <section className="card" aria-labelledby="h-backend">
          <h3 id="h-backend">Connection</h3>
          <dl className="facts">
            <dt>Backend</dt>
            <dd>{backend.url}</dd>
            <dt>Status</dt>
            <dd>{backend.reachable ? 'Reachable' : 'Not reachable'}</dd>
            <dt>Signed in as</dt>
            <dd>{me?.email ?? 'Unknown'}</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
