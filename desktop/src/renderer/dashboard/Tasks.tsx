import { useState, type FormEvent } from 'react';
import type { TaskInput, TasksSnapshot } from '../../shared/bridge';
import { describeRepeat, formatWhen } from '../../shared/proposal';
import { nextOccurrence, WEEKDAY_BITS, type Repeat } from '../../shared/recurrence';
import type { Priority, TaskItem } from '../../shared/taskStore';
import { Face } from './Face';

const api = () => window.smoiDashboard;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "2026-11-04T17:00" (a datetime-local value, local time) to an ISO instant, or null. */
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);
/** An ISO instant to a datetime-local value in local time. */
function toLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const EMPTY: TaskInput = { title: '', description: '', priority: 'normal', category: '', dueAt: null, completed: false };
const DAYS = Object.entries(WEEKDAY_BITS) as [string, number][];

/** Tasks and reminders (FR-02). Everything here works offline; changes sync when the backend is back. */
export function Tasks({ snapshot, backendReachable }: { snapshot: TasksSnapshot; backendReachable: boolean }) {
  const [editing, setEditing] = useState<TaskInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [rTitle, setRTitle] = useState('');
  const [rWhen, setRWhen] = useState('');
  const [rRepeat, setRRepeat] = useState<Repeat>('none');
  const [rDays, setRDays] = useState(0);
  const [rError, setRError] = useState<string | null>(null);
  const now = Date.now();

  const saveTask = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await api().saveTask(editing);
    if (!r.ok) setError(r.error.message);
    else setEditing(EMPTY);
  };

  const toggle = (t: TaskItem) => void api().saveTask({
    id: t.id, title: t.title, description: t.description, priority: t.priority, category: t.category, dueAt: t.dueAt,
    completed: !t.completedAt,
  });

  const edit = (t: TaskItem) => setEditing({
    id: t.id, title: t.title, description: t.description, priority: t.priority, category: t.category, dueAt: t.dueAt,
    completed: !!t.completedAt,
  });

  const saveReminder = async (e: FormEvent) => {
    e.preventDefault();
    setRError(null);
    const r = await api().saveReminder({ title: rTitle, firstAt: fromLocal(rWhen) ?? '', repeat: rRepeat, weekdays: rDays, taskId: null });
    if (!r.ok) setRError(r.error.message);
    else {
      setRTitle('');
      setRWhen('');
      setRRepeat('none');
      setRDays(0);
    }
  };

  if (!snapshot.ready) return <p>Sign in to see your tasks.</p>;
  const open = snapshot.tasks.filter((t) => !t.completedAt);
  const done = snapshot.tasks.filter((t) => t.completedAt);
  const overdue = open.filter((t) => t.dueAt && Date.parse(t.dueAt) < now).length;

  return (
    <>
      <h2>Tasks</h2>
      {(snapshot.pending > 0 || !backendReachable) && (
        <div className="banner info" role="status">
          <Face name="neutral" />
          <span>
            {snapshot.pending > 0
              ? `${snapshot.pending} ${snapshot.pending === 1 ? 'change is' : 'changes are'} saved on this computer and not yet on the backend. `
              : ''}
            {backendReachable ? 'Sending now.' : 'They will be sent when the backend is reachable. Reminders still work.'}
          </span>
        </div>
      )}
      <div className="tasks-layout">
        <section className="card" aria-labelledby="h-task-form">
          <h3 id="h-task-form">{editing.id ? 'Edit task' : 'New task'}</h3>
          <form className="stack" onSubmit={saveTask}>
            <label className="field">Title
              <input value={editing.title} maxLength={300} required onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </label>
            <label className="field">Notes
              <textarea rows={3} maxLength={5000} value={editing.description}
                        onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <div className="row">
              <label className="field">Priority
                <select value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: e.target.value as Priority })}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="field">Category
                <input value={editing.category} maxLength={50} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
              </label>
            </div>
            <label className="field">Due
              <input type="datetime-local" value={toLocal(editing.dueAt)}
                     onChange={(e) => setEditing({ ...editing, dueAt: fromLocal(e.target.value) })} />
            </label>
            {error && <div className="banner error" role="alert"><Face name="shocked" /><span>{error}</span></div>}
            <div className="row">
              <button className="btn primary" type="submit">{editing.id ? 'Save changes' : 'Add task'}</button>
              {editing.id && <button className="btn" type="button" onClick={() => setEditing(EMPTY)}>Cancel</button>}
            </div>
          </form>

          <h3 id="h-reminder-form">New reminder</h3>
          <form className="stack" onSubmit={saveReminder} aria-labelledby="h-reminder-form">
            <label className="field">Remind me to
              <input value={rTitle} maxLength={300} required onChange={(e) => setRTitle(e.target.value)} />
            </label>
            <label className="field">When
              <input type="datetime-local" value={rWhen} required onChange={(e) => setRWhen(e.target.value)} />
            </label>
            <label className="field">Repeat
              <select value={rRepeat} onChange={(e) => setRRepeat(e.target.value as Repeat)}>
                <option value="none">Once</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
                <option value="weekdays">On chosen days</option>
              </select>
            </label>
            {rRepeat === 'weekdays' && (
              <fieldset className="days">
                <legend>Days</legend>
                {DAYS.map(([name, bit]) => (
                  <label key={name} className="check">
                    <input type="checkbox" checked={(rDays & bit) !== 0} onChange={(e) => setRDays(e.target.checked ? rDays | bit : rDays & ~bit)} />
                    {name[0].toUpperCase() + name.slice(1)}
                  </label>
                ))}
              </fieldset>
            )}
            {rError && <div className="banner error" role="alert"><Face name="shocked" /><span>{rError}</span></div>}
            <button className="btn primary" type="submit">Set reminder</button>
          </form>
        </section>

        <section className="card list-card" aria-labelledby="h-tasks">
          <h3 id="h-tasks">To do ({open.length}{overdue > 0 ? `, ${overdue} overdue` : ''})</h3>
          {open.length === 0 && <p>Nothing to do. Suspicious.</p>}
          <ul className="doc-list">
            {open.map((t) => <TaskRow key={t.id} task={t} now={now} onToggle={toggle} onEdit={edit} />)}
          </ul>

          <h3 id="h-reminders">Reminders ({snapshot.reminders.length})</h3>
          {snapshot.reminders.length === 0 && <p>No reminders.</p>}
          <ul className="doc-list" aria-labelledby="h-reminders">
            {snapshot.reminders.map((r) => {
              const next = nextOccurrence(r, now);
              return (
                <li key={r.id} className="doc">
                  <span className="doc-name">{r.title}</span>
                  <div className="doc-row">
                    <span>
                      {next ? `Next: ${formatWhen(new Date(next).toISOString(), r.timeZone ?? tz)}` : 'Done'}
                      {describeRepeat(r.repeat, r.weekdays) ? ` · ${describeRepeat(r.repeat, r.weekdays)}` : ''}
                    </span>
                    <button type="button" className="btn small" aria-label={`Delete reminder ${r.title}`}
                            onClick={() => void api().deleteReminder(r.id)}>Delete</button>
                  </div>
                  {r.syncError && <span className="hint">Not saved on the backend: {r.syncError}</span>}
                </li>
              );
            })}
          </ul>

          {done.length > 0 && (
            <details>
              <summary>Completed ({done.length})</summary>
              <ul className="doc-list">
                {done.map((t) => <TaskRow key={t.id} task={t} now={now} onToggle={toggle} onEdit={edit} />)}
              </ul>
            </details>
          )}
        </section>
      </div>
    </>
  );
}

function TaskRow({ task: t, now, onToggle, onEdit }: {
  task: TaskItem; now: number; onToggle: (t: TaskItem) => void; onEdit: (t: TaskItem) => void;
}) {
  const late = !t.completedAt && t.dueAt && Date.parse(t.dueAt) < now;
  return (
    <li className="doc">
      <label className="check doc-name">
        <input type="checkbox" checked={!!t.completedAt} onChange={() => onToggle(t)} />
        <span className={t.completedAt ? 'done' : undefined}>{t.title}</span>
      </label>
      <div className="doc-row">
        <span>
          {late && <span className="status-tag failed">Overdue</span>}{' '}
          {t.priority !== 'normal' && <span className="status-tag queued">{t.priority === 'high' ? 'High' : 'Low'}</span>}{' '}
          {t.dueAt && `Due ${formatWhen(t.dueAt, tz)}`}
          {t.category && ` · ${t.category}`}
          {t.completedAt && ` · Done ${formatWhen(t.completedAt, tz)}`}
        </span>
        <span className="row">
          <button type="button" className="btn small" onClick={() => onEdit(t)} aria-label={`Edit ${t.title}`}>Edit</button>
          <button type="button" className="btn small" onClick={() => void api().deleteTask(t.id)} aria-label={`Delete ${t.title}`}>Delete</button>
        </span>
      </div>
      {t.description && <p className="plain hint">{t.description}</p>}
      {t.syncError && <span className="hint">Not saved on the backend: {t.syncError}</span>}
    </li>
  );
}
