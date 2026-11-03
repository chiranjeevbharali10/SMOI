import { describe, expect, it } from 'vitest';
import {
  deleteReminder, deleteTask, emptyStore, enqueue, mergeServer, overdueTasks, parseStore, putReminder, putTask, settle,
  sortedTasks, type ReminderItem, type ServerTask, type TaskItem,
} from '../src/shared/taskStore';

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id, title: id, description: '', priority: 'normal', category: '', dueAt: null, completedAt: null,
  editedAt: '2026-11-03T10:00:00.000Z', ...over,
});
const reminder = (id: string, over: Partial<ReminderItem> = {}): ReminderItem => ({
  id, taskId: null, title: id, firstAt: '2026-11-04T09:00:00Z', repeat: 'none', weekdays: 0, timeZone: 'Europe/London',
  lastFiredAt: null, editedAt: '2026-11-03T10:00:00.000Z', ...over,
});
const server = (t: TaskItem, deletedAt: string | null = null): ServerTask => ({ ...t, deletedAt });

describe('the outbox', () => {
  it('holds one entry per item, in the order items were first changed', () => {
    let o = enqueue([], { kind: 'task', id: 'a', op: 'put' });
    o = enqueue(o, { kind: 'reminder', id: 'r', op: 'put' });
    o = enqueue(o, { kind: 'task', id: 'a', op: 'put' });
    expect(o).toEqual([{ kind: 'task', id: 'a', op: 'put' }, { kind: 'reminder', id: 'r', op: 'put' }]);
  });

  it('turns a pending put into a delete', () => {
    const o = enqueue([{ kind: 'task', id: 'a', op: 'put' }], { kind: 'task', id: 'a', op: 'delete' });
    expect(o).toEqual([{ kind: 'task', id: 'a', op: 'delete' }]);
  });
});

describe('local changes', () => {
  it('apply at once and wait in the outbox', () => {
    const s = putTask(emptyStore(), task('a'));
    expect(s.tasks.a.title).toBe('a');
    expect(s.outbox).toEqual([{ kind: 'task', id: 'a', op: 'put' }]);
  });

  it('deleting a task removes its reminders and their pending changes', () => {
    let s = putTask(emptyStore(), task('a'));
    s = putReminder(s, reminder('r', { taskId: 'a' }));
    s = putReminder(s, reminder('other'));
    s = deleteTask(s, 'a');
    expect(Object.keys(s.reminders)).toEqual(['other']);
    expect(s.outbox).toEqual([{ kind: 'task', id: 'a', op: 'delete' }, { kind: 'reminder', id: 'other', op: 'put' }]);
  });

  it('a new change clears an old sync error', () => {
    let s = putTask(emptyStore(), task('a'));
    s = settle(s, s.outbox[0], { type: 'rejected', message: 'bad' }, s.tasks.a.editedAt);
    expect(s.tasks.a.syncError).toBe('bad');
    s = putTask(s, { ...s.tasks.a, title: 'fixed', editedAt: '2026-11-03T11:00:00.000Z' });
    expect(s.tasks.a.syncError).toBeUndefined();
  });
});

describe('settling what the server said', () => {
  it('stores the server row and clears the entry', () => {
    let s = putTask(emptyStore(), task('a'));
    s = settle(s, s.outbox[0], { type: 'stored', item: task('a', { title: 'from server' }) }, task('a').editedAt);
    expect(s.tasks.a.title).toBe('from server');
    expect(s.outbox).toEqual([]);
  });

  it('keeps the entry when the item changed again while it was being sent', () => {
    let s = putTask(emptyStore(), task('a'));
    const sent = s.tasks.a.editedAt;
    s = putTask(s, task('a', { title: 'newer', editedAt: '2026-11-03T10:05:00.000Z' }));
    s = settle(s, s.outbox[0], { type: 'stored', item: task('a') }, sent);
    expect(s.tasks.a.title).toBe('newer');
    expect(s.outbox).toHaveLength(1);
  });

  it('drops an item the server says was deleted (a delete always wins)', () => {
    let s = putTask(emptyStore(), task('a'));
    s = settle(s, s.outbox[0], { type: 'gone' }, task('a').editedAt);
    expect(s.tasks.a).toBeUndefined();
    expect(s.outbox).toEqual([]);
  });

  it('clears a delete entry whatever the answer', () => {
    let s = deleteReminder(putReminder(emptyStore(), reminder('r')), 'r');
    s = settle(s, s.outbox[0], { type: 'gone' }, null);
    expect(s.outbox).toEqual([]);
  });
});

describe('merging the server copy', () => {
  it('takes the server version of items without pending changes', () => {
    const s = mergeServer({ ...emptyStore(), tasks: { a: task('a') } }, [server(task('a', { title: 'server' }))], [], 'now');
    expect(s.tasks.a.title).toBe('server');
    expect(s.syncedAt).toBe('now');
  });

  it('keeps the local version while a change is pending', () => {
    const local = putTask(emptyStore(), task('a', { title: 'local' }));
    expect(mergeServer(local, [server(task('a', { title: 'server' }))], [], 'now').tasks.a.title).toBe('local');
  });

  it('drops items deleted on the server, or no longer listed', () => {
    const s = { ...emptyStore(), tasks: { a: task('a'), b: task('b') } };
    const merged = mergeServer(s, [server(task('a'), '2026-11-03T12:00:00Z')], [], 'now');
    expect(merged.tasks).toEqual({});
  });

  it('keeps items created offline that the server hasn’t seen yet', () => {
    const s = putTask(emptyStore(), task('new'));
    expect(Object.keys(mergeServer(s, [], [], 'now').tasks)).toEqual(['new']);
  });
});

describe('views', () => {
  const s = {
    ...emptyStore(),
    tasks: {
      late: task('late', { dueAt: '2026-11-01T09:00:00Z' }),
      later: task('later', { dueAt: '2026-11-02T09:00:00Z' }),
      future: task('future', { dueAt: '2026-12-01T09:00:00Z' }),
      undated: task('undated'),
      done: task('done', { dueAt: '2026-10-01T09:00:00Z', completedAt: '2026-10-02T09:00:00Z' }),
    },
  };

  it('lists overdue open tasks, most overdue first', () => {
    expect(overdueTasks(s, Date.parse('2026-11-03T00:00:00Z')).map((t) => t.id)).toEqual(['late', 'later']);
  });

  it('sorts open tasks by due date, undated last, then completed', () => {
    expect(sortedTasks(s).map((t) => t.id)).toEqual(['late', 'later', 'future', 'undated', 'done']);
  });
});

describe('reading the saved file', () => {
  it('starts empty if the file is malformed', () => {
    expect(parseStore(null)).toEqual(emptyStore());
    expect(parseStore({ tasks: 'x' })).toEqual(emptyStore());
  });
});
