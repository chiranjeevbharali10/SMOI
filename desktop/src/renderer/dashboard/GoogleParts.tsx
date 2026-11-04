import { useState } from 'react';
import type { GoogleView, PreviewOutcome } from '../../shared/bridge';
import { Face } from './Face';

const api = () => window.smoiDashboard;

/**
 * Shown in place of the calendar or inbox until Google is connected, or after Google stopped
 * accepting SMOI (FR-05.12): local data is kept, and one button reconnects.
 */
export function GoogleGate({ google, children }: { google: GoogleView | null; children: React.ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const s = google?.status?.status;
  if (!google?.signedIn) return <p>Sign in to use Google Calendar and Gmail.</p>;
  if (s === 'connected') return <>{children}</>;
  if (s === 'not_configured') {
    return (
      <div className="banner info" role="status">
        <Face name="confused" />
        <span>Google isn't set up on this SMOI server yet. See GOOGLE_* in .env.example.</span>
      </div>
    );
  }
  const reconnect = s === 'reconnect_required';
  const connect = async () => {
    setError(null);
    const r = await api().connectGoogle();
    if (!r.ok) setError(r.error.message);
  };
  return (
    <>
      <div className={`banner ${reconnect ? 'error' : 'info'}`} role={reconnect ? 'alert' : 'status'}>
        <Face name={reconnect ? 'shocked' : 'neutral'} />
        <span>
          {reconnect
            ? 'Google stopped accepting SMOI (access was revoked or expired). Your stored emails, drafts and tasks are kept. Reconnect to carry on.'
            : 'Connect your Google account to see your calendar and sort your email. You choose what to allow on Google’s page.'}
        </span>
        <button className="btn primary small" type="button" onClick={() => void connect()}>
          {reconnect ? 'Reconnect Google' : 'Connect Google'}
        </button>
      </div>
      {error && <div className="banner error" role="alert"><Face name="shocked" /><span>{error}</span></div>}
      {reconnect && children}
    </>
  );
}

/**
 * A proposed change to Google, shown before anything happens (FR-04.04, FR-04.05, FR-05.08).
 * Confirming applies exactly this change, once.
 */
export function PreviewCard({ outcome, onDone, onCancel }: {
  outcome: PreviewOutcome;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = outcome.view;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const r = await api().confirmGoogle(outcome.id);
    setBusy(false);
    if (r.ok) onDone(r.value.saved);
    else setError(r.error.message);
  };
  return (
    <div className="passage proposal" role="group" aria-label="Confirm this change">
      <p><strong>{v.heading}</strong></p>
      {v.details.length > 0 && <ul className="notes">{v.details.map((d, i) => <li key={i} className="plain">{d}</li>)}</ul>}
      {error && <p className="answer-status"><Face name="shocked" /> {error}</p>}
      <div className="row">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void confirm()}>{v.confirmLabel}</button>
        <button className="btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <p className="hint">Nothing changes in Google until you confirm.</p>
    </div>
  );
}

/** Opens a Gmail or Calendar link in the browser; the main process only opens Google's own sites. */
export function GoogleLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <button className="btn small" type="button" onClick={() => void api().openGoogleLink(url)}>{children}</button>
  );
}
