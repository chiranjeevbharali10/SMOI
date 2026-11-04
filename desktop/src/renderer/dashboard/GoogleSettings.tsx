import { useState } from 'react';
import type { GoogleView } from '../../shared/bridge';
import { Face } from './Face';

const api = () => window.smoiDashboard;

/**
 * Settings > Google (FR-04.01, NFR-03.05, NFR-04.01, NFR-04.04): what each permission is for, and
 * connecting, reconnecting or disconnecting. Disconnecting asks, in a native dialog, whether to
 * delete the email data SMOI stored too.
 */
export function GoogleSettings({ google }: { google: GoogleView | null }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = google?.status;
  const status = s?.status;

  const connect = async () => {
    setError(null);
    setMessage(null);
    const r = await api().connectGoogle();
    if (r.ok) setMessage('Google opened in your browser. Come back here when you have finished.');
    else setError(r.error.message);
  };

  const disconnect = async () => {
    setError(null);
    const r = await api().disconnectGoogle();
    if (!r.ok) setError(r.error.message);
    else if (r.value.disconnected) {
      setMessage(r.value.revoked
        ? 'Disconnected. Google confirmed SMOI no longer has access.'
        : 'Disconnected here, but Google could not be reached to revoke access. Remove SMOI at myaccount.google.com/permissions.');
    }
  };

  return (
    <section className="card" aria-labelledby="h-google">
      <h3 id="h-google">Google Calendar and Gmail</h3>
      {status === 'not_configured' && <p>Google isn't set up on this SMOI server (GOOGLE_* in .env).</p>}
      {status === 'connected' && <p>Connected as <strong>{s?.email || 'your Google account'}</strong>.</p>}
      {status === 'reconnect_required' && (
        <div className="banner error" role="alert">
          <Face name="confused" />
          <span>Google stopped accepting SMOI. Calendar and email are paused; everything stored is kept.</span>
        </div>
      )}
      {status === 'not_connected' && <p>Not connected. SMOI reads nothing from Google until you connect.</p>}

      <h4>What SMOI asks Google for</h4>
      <ul className="notes">
        {(s?.scopes ?? []).map((x) => (
          <li key={x.scope} className="plain">
            <strong>{x.name}</strong>{s?.grantedScopes.includes(x.name) ? ' (allowed)' : ''}: {x.why}
          </li>
        ))}
      </ul>
      <p className="hint">
        Email is treated as untrusted: SMOI only sorts and summarises it, and nothing in an email can change your calendar
        or drafts. Every change to Google is shown to you first and needs your confirmation.
      </p>

      {status !== 'not_configured' && (
        <div className="row">
          {status !== 'connected' && (
            <button className="btn primary" type="button" onClick={() => void connect()}>
              {status === 'reconnect_required' ? 'Reconnect Google' : 'Connect Google'}
            </button>
          )}
          {(status === 'connected' || status === 'reconnect_required') && (
            <button className="btn" type="button" onClick={() => void disconnect()}>Disconnect…</button>
          )}
        </div>
      )}
      {message && <p className="hint" role="status">{message}</p>}
      {error && <div className="banner error" role="alert"><Face name="shocked" /><span>{error}</span></div>}
    </section>
  );
}
