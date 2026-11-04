import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { DraftItem, EmailCategory, EmailItem } from '../../shared/apiTypes';
import type { GoogleView, PreviewOutcome } from '../../shared/bridge';
import { formatWhen } from '../../shared/proposal';
import { Face } from './Face';
import { GoogleGate, GoogleLink, PreviewCard } from './GoogleParts';

const api = () => window.smoiDashboard;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : '');

const CATEGORY_LABEL: Record<EmailCategory, string> = {
  important: 'Important', recruitment: 'Recruitment', academic: 'Academic', personal: 'Personal', promotional: 'Promotional',
};

/**
 * Gmail (FR-05): recent unread primary mail, sorted and summarised; drafts SMOI made. Email text is
 * untrusted, so it is shown as plain text only: React escapes it, and nothing in it is a link or a
 * button. The only links are SMOI's own "Open in Gmail" buttons, which open Google's site.
 */
export function Inbox({ google }: { google: GoogleView | null }) {
  const [emails, setEmails] = useState<EmailItem[] | null>(null);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [filter, setFilter] = useState<EmailCategory | 'all'>('all');
  const [draft, setDraft] = useState({ to: '', subject: '', body: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [remindFor, setRemindFor] = useState<{ id: string; when: string } | null>(null);
  const connected = google?.status?.status === 'connected';

  const load = useCallback(async (sync: boolean) => {
    const r = sync ? await api().syncEmail() : await api().emails();
    if (r.ok) {
      setEmails(r.value);
      setError(null);
    } else setError(r.error.message);
    const d = await api().drafts();
    if (d.ok) setDrafts(d.value);
  }, []);

  useEffect(() => {
    if (google?.signedIn && google.status && google.status.status !== 'not_configured') void load(false);
  }, [google?.signedIn, google?.status, load]);

  const shown = (emails ?? []).filter((e) => filter === 'all' || e.category === filter);

  const toTask = async (e: EmailItem) => {
    const r = await api().emailToTask(e.id);
    if (r.ok) {
      setNote(`Task added: “${r.value.title}”. It links back to the email.`);
      void load(false);
    } else setError(r.error.message);
  };

  const index = async (e: EmailItem) => {
    const r = await api().indexEmail(e.id, !e.indexed);
    if (r.ok) setEmails((xs) => (xs ?? []).map((x) => (x.id === e.id ? r.value : x)));
    else setError(r.error.message);
  };

  const proposeDraft = async (ev: FormEvent) => {
    ev.preventDefault();
    const r = await api().proposeDraft(draft, editing ?? undefined);
    if (r.ok) setPreview(r.value);
    else setError(r.error.message);
  };

  const remind = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!remindFor) return;
    const d = drafts.find((x) => x.id === remindFor.id);
    const r = await api().saveReminder({
      title: `Send the draft “${d?.subject || 'to ' + d?.to}”`, firstAt: fromLocal(remindFor.when), repeat: 'none', weekdays: 0,
      taskId: null, draftId: remindFor.id,
    });
    if (r.ok) {
      setNote(`Reminder set for ${formatWhen(r.value.firstAt, tz)}. If you send or delete the draft first, SMOI cancels it.`);
      setRemindFor(null);
    } else setError(r.error.message);
  };

  return (
    <>
      <h2>Inbox</h2>
      <GoogleGate google={google}>
        {error && <div className="banner error" role="alert"><Face name="shocked" /><span>{error}</span></div>}
        {note && <p className="answer-status" role="status"><Face name="joyful" /> {note}</p>}
        {preview && (
          <PreviewCard outcome={preview} onCancel={() => setPreview(null)} onDone={(m) => {
            setPreview(null);
            setNote(m);
            setDraft({ to: '', subject: '', body: '' });
            setEditing(null);
            void load(false);
          }} />
        )}
        <div className="tasks-layout">
          <section className="card" aria-labelledby="h-draft">
            <h3 id="h-draft">{editing ? 'Change draft' : 'New draft'}</h3>
            <form className="stack" onSubmit={proposeDraft}>
              <label className="field">To
                <input type="email" value={draft.to} maxLength={320} required onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              </label>
              <label className="field">Subject
                <input value={draft.subject} maxLength={998} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              </label>
              <label className="field">Message
                <textarea rows={6} maxLength={20000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </label>
              <div className="row">
                <button className="btn primary" type="submit" disabled={!connected}>{editing ? 'Check and update…' : 'Check and save draft…'}</button>
                {editing && <button className="btn" type="button" onClick={() => { setEditing(null); setDraft({ to: '', subject: '', body: '' }); }}>Cancel</button>}
              </div>
              <p className="hint">SMOI only saves drafts. You open them in Gmail and send them yourself.</p>
            </form>

            <h3 id="h-drafts">Drafts SMOI made ({drafts.length})</h3>
            {drafts.length === 0 && <p>None yet.</p>}
            <ul className="doc-list" aria-labelledby="h-drafts">
              {drafts.map((d) => (
                <li key={d.id} className="doc">
                  <span className="doc-name">{d.subject || '(no subject)'}</span>
                  <div className="doc-row">
                    <span>To {d.to}{d.gone ? ' · sent or deleted in Gmail' : ''}</span>
                    {!d.gone && (
                      <span className="row">
                        <GoogleLink url={d.gmailLink}>Open in Gmail</GoogleLink>
                        <button className="btn small" type="button" onClick={() => { setEditing(d.id); setDraft({ to: d.to, subject: d.subject, body: d.body }); }}>Edit</button>
                        <button className="btn small" type="button" onClick={() => setRemindFor({ id: d.id, when: '' })}>Remind me…</button>
                      </span>
                    )}
                  </div>
                  {remindFor?.id === d.id && (
                    <form className="row" onSubmit={remind}>
                      <label className="field">Remind me to send it
                        <input type="datetime-local" value={remindFor.when} required onChange={(e) => setRemindFor({ id: d.id, when: e.target.value })} />
                      </label>
                      <button className="btn primary small" type="submit">Set reminder</button>
                      <button className="btn small" type="button" onClick={() => setRemindFor(null)}>Cancel</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="card list-card" aria-labelledby="h-mail">
            <div className="row">
              <h3 id="h-mail">Unread mail</h3>
              <label className="field">Show
                <select value={filter} onChange={(e) => setFilter(e.target.value as EmailCategory | 'all')}>
                  <option value="all">All</option>
                  {(Object.keys(CATEGORY_LABEL) as EmailCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </select>
              </label>
              <button className="btn small" type="button" disabled={!connected || google?.syncing} onClick={() => void load(true)}>
                {google?.syncing ? 'Checking…' : 'Check now'}
              </button>
            </div>
            <p className="hint">Unread mail in your Primary tab from the last day, then anything new. Reading here never marks mail as read.</p>
            {emails === null && !error && <p className="answer-status"><Face name="pondering" /> Reading your mail…</p>}
            {emails?.length === 0 && <p>No unread mail. Impressive.</p>}
            <ul className="doc-list">
              {shown.map((e) => (
                <li key={e.id} className="doc">
                  <span className="doc-name">{e.subject || '(no subject)'}</span>
                  <div className="doc-row">
                    <span>{e.from} · {formatWhen(e.receivedAt, tz)}</span>
                    <span className={`status-tag ${e.category === 'important' ? 'failed' : e.category ? 'indexed' : 'queued'}`}>
                      {e.category ? CATEGORY_LABEL[e.category] : 'Sorting…'}
                    </span>
                  </div>
                  {e.summary && <p className="plain">{e.summary}</p>}
                  <div className="row">
                    <GoogleLink url={e.gmailLink}>Open in Gmail</GoogleLink>
                    <button className="btn small" type="button" disabled={!!e.taskId} onClick={() => void toTask(e)}>
                      {e.taskId ? 'Task made' : 'Make a task'}
                    </button>
                    <button className="btn small" type="button" onClick={() => void index(e)}>
                      {e.indexed ? 'Remove from SMOI Brain' : 'Add to SMOI Brain'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </GoogleGate>
    </>
  );
}
