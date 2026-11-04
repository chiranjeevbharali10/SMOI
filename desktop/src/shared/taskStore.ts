/**
 * The desktop's local copy of tasks and reminders (NFR-02.01, NFR-02.05): it works with the
 * backend down, and the reminder scheduler reads it directly.
 *
 * Every local change is applied at once and queued in an outbox. When the backend is reachable,
 * the outbox is sent in order (see src/main/tasks.ts) and the server's copy is merged back in.
 * The sync rule matches the backend (docs/adr/0014):
 * - every change carries `editedAt`, the moment it was made; the newest change wins;
 * - a delete always wins; a deleted item never comes back;
 * - while an item has a change waiting in the outbox, the local version is kept, because it is
 *   newer than anything the server has seen.
 *
 * Plain data and pure functions (the caller persists the state), tested in test/taskStore.test.ts.
 */
import type { Repeat } from './recurrence';

export type Priority = 'low' | 'normal' | 'high';

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  category: string;
  dueAt: string | null;
  completedAt: string | null;
  editedAt: string;
  /** Set when the server rejected this item's last change; shown next to it. */
  syncError?: string;
}

export interface ReminderItem {
  id: string;
  taskId: string | null;
  title: string;
  firstAt: string;
  repeat: Repeat;
  weekdays: number;
  timeZone: string;
  lastFiredAt: string | null;
  editedAt: string;
  /** A Gmail draft SMOI created that this reminder is about (FR-05.10). */
  draftId?: string | null;
  syncError?: string;
}

export type Kind = 'task' | 'reminder';

/** A change waiting to be sent. A put sends the item as it is at sending time. */
export interface OutboxEntry {
  kind: Kind;
  id: string;
  op: 'put' | 'delete';
}

export interface StoreState {
  tasks: Record<string, TaskItem>;
  reminders: Record<string, ReminderItem>;
  outbox: OutboxEntry[];
  /** When the last full sync with the server finished (ISO), or null. */
  syncedAt: string | null;
}

export const emptyStore = (): StoreState => ({ tasks: {}, reminders: {}, outbox: [], syncedAt: null });

/**
 * Queues a change. One entry per item: a newer put replaces nothing (the put sends the latest
 * version anyway) and a delete replaces a pending put. The first entry keeps its place, so a task
 * is always sent before a reminder created after it.
 */
export function enqueue(outbox: OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
  const i = outbox.findIndex((e) => e.kind === entry.kind && e.id === entry.id);
  if (i < 0) return [...outbox, entry];
  if (entry.op === 'delete') return outbox.map((e, j) => (j === i ? entry : e));
  return outbox;
}

export function putTask(s: StoreState, task: TaskItem): StoreState {
  const { syncError: _dropped, ...clean } = task;
  return { ...s, tasks: { ...s.tasks, [task.id]: clean }, outbox: enqueue(s.outbox, { kind: 'task', id: task.id, op: 'put' }) };
}

export function putReminder(s: StoreState, reminder: ReminderItem): StoreState {
  const { syncError: _dropped, ...clean } = reminder;
  return {
    ...s, reminders: { ...s.reminders, [reminder.id]: clean },
    outbox: enqueue(s.outbox, { kind: 'reminder', id: reminder.id, op: 'put' }),
  };
}

/** Deletes a task and, as the server does, the reminders attached to it. */
export function deleteTask(s: StoreState, id: string): StoreState {
  const tasks = { ...s.tasks };
  delete tasks[id];
  const reminders = { ...s.reminders };
  let outbox = enqueue(s.outbox, { kind: 'task', id, op: 'delete' });
  for (const r of Object.values(s.reminders)) {
    if (r.taskId === id) {
      delete reminders[r.id];
      // The server deletes them with the task; drop any pending change to them.
      outbox = outbox.filter((e) => !(e.kind === 'reminder' && e.id === r.id));
    }
  }
  return { ...s, tasks, reminders, outbox };
}

export function deleteReminder(s: StoreState, id: string): StoreState {
  const reminders = { ...s.reminders };
  delete reminders[id];
  return { ...s, reminders, outbox: enqueue(s.outbox, { kind: 'reminder', id, op: 'delete' }) };
}

/** What the server said about one outbox entry. */
export type SendOutcome =
  | { type: 'stored'; item: TaskItem | ReminderItem }
  /** It was deleted on the server (410), or never existed there (404 on delete). */
  | { type: 'gone' }
  /** The server refused the change (400); keep the item, show why. */
  | { type: 'rejected'; message: string };

/**
 * Applies the server's answer to the first outbox entry. `sentEditedAt` is the version that was
 * sent: if the user changed the item again while it was in flight, the entry stays queued and
 * the local version is kept.
 */
export function settle(s: StoreState, entry: OutboxEntry, outcome: SendOutcome, sentEditedAt: string | null): StoreState {
  const local = entry.kind === 'task' ? s.tasks[entry.id] : s.reminders[entry.id];
  const changedInFlight = entry.op === 'put' && local != null && local.editedAt !== sentEditedAt;
  const outbox = changedInFlight ? s.outbox : s.outbox.filter((e) => !(e.kind === entry.kind && e.id === entry.id));
  const next = { ...s, outbox };
  if (changedInFlight || entry.op === 'delete') return next;
  if (outcome.type === 'gone') return entry.kind === 'task' ? removeTaskOnly(next, entry.id) : removeReminderOnly(next, entry.id);
  if (outcome.type === 'rejected') {
    if (!local) return next;
    return entry.kind === 'task'
      ? { ...next, tasks: { ...next.tasks, [entry.id]: { ...(local as TaskItem), syncError: outcome.message } } }
      : { ...next, reminders: { ...next.reminders, [entry.id]: { ...(local as ReminderItem), syncError: outcome.message } } };
  }
  return entry.kind === 'task'
    ? { ...next, tasks: { ...next.tasks, [entry.id]: outcome.item as TaskItem } }
    : { ...next, reminders: { ...next.reminders, [entry.id]: outcome.item as ReminderItem } };
}

/** A row from GET /api/sync: the item, with `deletedAt` set if it was deleted. */
export type ServerTask = TaskItem & { deletedAt: string | null };
export type ServerReminder = ReminderItem & { deletedAt: string | null };

/**
 * Brings the local copy up to date with the server's. Items with a pending change keep their
 * local version. Everything else becomes what the server has; items the server doesn't list (or
 * lists as deleted) are dropped.
 */
export function mergeServer(s: StoreState, tasks: ServerTask[], reminders: ServerReminder[], syncedAt: string): StoreState {
  const pending = (kind: Kind, id: string) => s.outbox.some((e) => e.kind === kind && e.id === id);
  const merged = <T extends { id: string }, S extends T & { deletedAt: string | null }>(
    kind: Kind, local: Record<string, T>, server: S[], strip: (row: S) => T,
  ): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [id, item] of Object.entries(local)) if (pending(kind, id)) out[id] = item;
    for (const row of server) {
      if (pending(kind, row.id)) continue;
      if (!row.deletedAt) out[row.id] = strip(row);
    }
    return out;
  };
  return {
    ...s,
    tasks: merged('task', s.tasks, tasks, toTask),
    reminders: merged('reminder', s.reminders, reminders, toReminder),
    syncedAt,
  };
}

function toTask(r: ServerTask): TaskItem {
  return {
    id: r.id, title: r.title, description: r.description ?? '', priority: r.priority ?? 'normal', category: r.category ?? '',
    dueAt: r.dueAt ?? null, completedAt: r.completedAt ?? null, editedAt: r.editedAt,
  };
}

function toReminder(r: ServerReminder): ReminderItem {
  return {
    id: r.id, taskId: r.taskId ?? null, title: r.title, firstAt: r.firstAt, repeat: r.repeat ?? 'none', weekdays: r.weekdays ?? 0,
    timeZone: r.timeZone, lastFiredAt: r.lastFiredAt ?? null, editedAt: r.editedAt, draftId: r.draftId ?? null,
  };
}

function removeTaskOnly(s: StoreState, id: string): StoreState {
  const tasks = { ...s.tasks };
  delete tasks[id];
  return { ...s, tasks };
}

function removeReminderOnly(s: StoreState, id: string): StoreState {
  const reminders = { ...s.reminders };
  delete reminders[id];
  return { ...s, reminders };
}

// ---------- views ----------

export function openTasks(s: StoreState): TaskItem[] {
  return Object.values(s.tasks).filter((t) => !t.completedAt);
}

/** Open tasks whose due date has passed (FR-02.06), most overdue first. */
export function overdueTasks(s: StoreState, now: number): TaskItem[] {
  return openTasks(s)
    .filter((t) => t.dueAt !== null && Date.parse(t.dueAt) < now)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
}

/** Open tasks first, by due date (undated last); then completed ones, most recent first. */
export function sortedTasks(s: StoreState): TaskItem[] {
  const due = (t: TaskItem) => (t.dueAt ? Date.parse(t.dueAt) : Number.POSITIVE_INFINITY);
  const open = openTasks(s).sort((a, b) => due(a) - due(b) || a.title.localeCompare(b.title));
  const done = Object.values(s.tasks).filter((t) => t.completedAt)
    .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!));
  return [...open, ...done];
}

/** Checks a stored state read from disk; anything malformed starts empty rather than crashing. */
export function parseStore(json: unknown): StoreState {
  const s = json as StoreState;
  if (!s || typeof s !== 'object' || typeof s.tasks !== 'object' || typeof s.reminders !== 'object' || !Array.isArray(s.outbox)) {
    return emptyStore();
  }
  return { tasks: s.tasks ?? {}, reminders: s.reminders ?? {}, outbox: s.outbox, syncedAt: s.syncedAt ?? null };
}
