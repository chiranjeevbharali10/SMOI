import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CalendarEvent, Upcoming } from '../../shared/apiTypes';
import type { GoogleView, PreviewOutcome } from '../../shared/bridge';
import { formatRange } from '../../shared/proposal';
import { Face } from './Face';
import { GoogleGate, GoogleLink, PreviewCard } from './GoogleParts';

const api = () => window.smoiDashboard;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const fromLocal = (v: string) => (v ? new Date(v).toISOString() : '');
function toLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const REMINDERS: { label: string; minutes: number[] | null }[] = [
  { label: 'Calendar default', minutes: null },
  { label: 'None', minutes: [] },
  { label: '10 minutes before', minutes: [10] },
  { label: '30 minutes before', minutes: [30] },
  { label: '1 hour before', minutes: [60] },
  { label: '1 day before', minutes: [1440] },
];

function dayKey(e: CalendarEvent): string {
  const d = e.start ? new Date(e.start) : new Date(`${e.startDate}T12:00:00`);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(d);
}

/** Upcoming events from the primary Google Calendar (FR-04.02); every change is confirmed first (FR-04.04). */
export function Calendar({ google }: { google: GoogleView | null }) {
  const [data, setData] = useState<Upcoming | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reminder, setReminder] = useState(0);
  const [moving, setMoving] = useState<{ id: string; start: string } | null>(null);
  const connected = google?.status?.status === 'connected';

  const load = useCallback(async () => {
    const r = await api().upcoming();
    if (r.ok) {
      setData(r.value);
      setError(null);
    } else setError(r.error.message);
  }, []);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const show = (r: Awaited<ReturnType<ReturnType<typeof api>['proposeEvent']>>) => {
    setDone(null);
    if (r.ok) {
      setPreview(r.value);
      setError(null);
    } else setError(r.error.message);
  };

  const propose = async (e: FormEvent) => {
    e.preventDefault();
    show(await api().proposeEvent({ title, start: fromLocal(start), end: fromLocal(end), reminderMinutes: REMINDERS[reminder].minutes }));
  };

  const finished = (message: string) => {
    setPreview(null);
    setDone(message);
    setTitle('');
    setStart('');
    setEnd('');
    setMoving(null);
    void load();
  };

  const groups = new Map<string, CalendarEvent[]>();
  for (const e of data?.events ?? []) groups.set(dayKey(e), [...(groups.get(dayKey(e)) ?? []), e]);

  return (
    <>
      <h2>Calendar</h2>
      <GoogleGate google={google}>
        {data?.today.busy && (
          <div className="banner info" role="status">
            <Face name="confused" />
            <span>Your calendar looks suspiciously busy today: {data.today.reason}.</span>
          </div>
        )}
        {error && <div className="banner error" role="alert"><Face name="shocked" /><span>{error}</span></div>}
        {done && <p className="answer-status" role="status"><Face name="joyful" /> {done}</p>}
        {preview && <PreviewCard outcome={preview} onDone={finished} onCancel={() => setPreview(null)} />}
        <div className="tasks-layout">
          <section className="card" aria-labelledby="h-event-form">
            <h3 id="h-event-form">New event</h3>
            <form className="stack" onSubmit={propose}>
              <label className="field">Title
                <input value={title} maxLength={300} required onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field">Starts
                <input type="datetime-local" value={start} required onChange={(e) => {
                  setStart(e.target.value);
                  if (!end && e.target.value) setEnd(toLocal(new Date(Date.parse(fromLocal(e.target.value)) + 3600_000).toISOString()));
                }} />
              </label>
              <label className="field">Ends
                <input type="datetime-local" value={end} required onChange={(e) => setEnd(e.target.value)} />
              </label>
              <label className="field">Reminder
                <select value={reminder} onChange={(e) => setReminder(Number(e.target.value))}>
                  {REMINDERS.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
                </select>
              </label>
              <button className="btn primary" type="submit" disabled={!connected}>Check and add…</button>
              <p className="hint">SMOI shows any overlapping events first. Nothing is added until you confirm.</p>
            </form>
          </section>

          <section className="card list-card" aria-labelledby="h-upcoming">
            <div className="row">
              <h3 id="h-upcoming">Next 7 days</h3>
              <button className="btn small" type="button" disabled={!connected} onClick={() => void load()}>Refresh</button>
            </div>
            {connected && !data && !error && <p className="answer-status"><Face name="pondering" /> Reading your calendar…</p>}
            {data && data.events.length === 0 && <p>Nothing on. Enjoy it while it lasts.</p>}
            {[...groups.entries()].map(([day, events]) => (
              <div key={day}>
                <h4>{day}</h4>
                <ul className="doc-list">
                  {events.map((e) => (
                    <li key={e.id} className="doc">
                      <span className="doc-name">{e.title}</span>
                      <div className="doc-row">
                        <span>{e.start && e.end ? formatRange(e.start, e.end, tz) : 'All day'}</span>
                        <span className="row">
                          {e.link && <GoogleLink url={e.link}>Open</GoogleLink>}
                          {e.start && (
                            <button className="btn small" type="button" onClick={() => setMoving({ id: e.id, start: toLocal(e.start) })}>Move</button>
                          )}
                          <button className="btn small" type="button" onClick={async () => show(await api().proposeEventDelete(e.id))}>Delete…</button>
                        </span>
                      </div>
                      {moving?.id === e.id && (
                        <form className="row" onSubmit={async (ev) => {
                          ev.preventDefault();
                          show(await api().proposeEventChange(e.id, { start: fromLocal(moving.start) }));
                        }}>
                          <label className="field">New start
                            <input type="datetime-local" value={moving.start} required onChange={(x) => setMoving({ id: e.id, start: x.target.value })} />
                          </label>
                          <button className="btn primary small" type="submit">Check and move…</button>
                          <button className="btn small" type="button" onClick={() => setMoving(null)}>Cancel</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>
      </GoogleGate>
    </>
  );
}
