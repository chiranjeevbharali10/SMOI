/**
 * Tasks and reminders in the main process: the signed-in user's local copy, its sync with the
 * backend, and the reminder scheduler (FR-02, NFR-02.01, NFR-02.05, NFR-08.05).
 *
 * - The copy is a JSON file per account in the app's data folder, written to a temporary file
 *   first so a crash can't leave half a file. Every change is saved before anything is sent, so
 *   losing the network never loses a change.
 * - The outbox is sent in order whenever the backend is reachable, then the server's copy is
 *   merged back in (src/shared/taskStore.ts has the rules).
 * - Reminders fire from this copy every 15 seconds, so they work with the backend or the
 *   internet down. A reminder that came due while SMOI wasn't running fires once, as "missed".
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, type ApiClient } from './api';
import { dueOccurrence } from '../shared/recurrence';
import {
  deleteReminder, deleteTask, emptyStore, mergeServer, openTasks, overdueTasks, parseStore, putReminder, putTask, settle,
  type OutboxEntry, type ReminderItem, type SendOutcome, type StoreState, type TaskItem,
} from '../shared/taskStore';

export interface TaskServiceDeps {
  api: ApiClient;
  dataDir: string;
  /** A reminder came due (missed: it was due while SMOI wasn't running). */
  onReminder: (r: ReminderItem, missed: boolean) => void;
  /** Checked every few minutes; the notifier decides whether to say anything. */
  onOverdue: (count: number) => void;
  /** The store changed (dashboard list, panel count). */
  onChange: (s: StoreState) => void;
}

const SCHEDULER_MS = 15_000;
const SYNC_MS = 60_000;
const OVERDUE_MS = 5 * 60_000;
/** A due occurrence older than this when it fires counts as missed. */
const MISSED_AFTER_MS = 2 * 60_000;

/** Errors that mean "try again later", not "the server refused this change". */
const RETRY_KINDS = new Set(['unreachable', 'timeout', 'unavailable', 'server', 'rate_limited', 'session_expired']);

export class TaskService {
  private state: StoreState = emptyStore();
  private file: string | null = null;
  private flushing = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: TaskServiceDeps) {}

  get store(): StoreState {
    return this.state;
  }

  get openCount(): number | null {
    return this.file ? openTasks(this.state).length : null;
  }

  /** Loads the account's copy and starts syncing and the scheduler. */
  start(account: string): void {
    this.stop();
    const dir = join(this.deps.dataDir, 'tasks');
    mkdirSync(dir, { recursive: true });
    // One file per account, named by a hash so the email isn't in the file name.
    this.file = join(dir, `${createHash('sha256').update(account.toLowerCase()).digest('hex').slice(0, 32)}.json`);
    try {
      this.state = existsSync(this.file) ? parseStore(JSON.parse(readFileSync(this.file, 'utf8'))) : emptyStore();
    } catch {
      this.state = emptyStore();
    }
    this.deps.onChange(this.state);
    this.timers.push(setInterval(() => this.checkReminders(Date.now()), SCHEDULER_MS));
    this.timers.push(setInterval(() => void this.sync(), SYNC_MS));
    this.timers.push(setInterval(() => this.deps.onOverdue(overdueTasks(this.state, Date.now()).length), OVERDUE_MS));
    this.checkReminders(Date.now());
    void this.sync();
  }

  /** Signed out: stop, and drop the copy from memory. The file stays for the next sign-in. */
  stop(): void {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.file = null;
    this.state = emptyStore();
    this.deps.onChange(this.state);
  }

  // ---------- changes from the dashboard and from confirmed commands ----------

  saveTask(task: TaskItem): void {
    this.update(putTask(this.state, task));
  }

  removeTask(id: string): void {
    this.update(deleteTask(this.state, id));
  }

  saveReminder(reminder: ReminderItem): void {
    this.update(putReminder(this.state, reminder));
  }

  removeReminder(id: string): void {
    this.update(deleteReminder(this.state, id));
  }

  // ---------- sync ----------

  /** Sends the outbox, then merges the server's copy. Safe to call at any time. */
  async sync(): Promise<void> {
    if (!this.file || this.flushing) return;
    this.flushing = true;
    try {
      const sent = await this.flush();
      if (!sent) return;
      const remote = await this.deps.api.sync();
      // Items changed while the request was in flight are in the outbox, so the merge keeps them.
      this.update(mergeServer(this.state, remote.tasks, remote.reminders, remote.serverTime), false);
    } catch {
      // Offline or signed out: everything stays queued; the next sync tries again.
    } finally {
      this.flushing = false;
    }
  }

  /** Returns false if it had to stop early (offline); the rest stays queued. */
  private async flush(): Promise<boolean> {
    while (this.file && this.state.outbox.length > 0) {
      const entry = this.state.outbox[0];
      const local = entry.kind === 'task' ? this.state.tasks[entry.id] : this.state.reminders[entry.id];
      const sentEditedAt = local?.editedAt ?? null;
      let outcome: SendOutcome;
      try {
        outcome = await this.send(entry, local);
      } catch (e) {
        if (e instanceof ApiError && RETRY_KINDS.has(e.kind)) return false;
        if (e instanceof ApiError && (e.kind === 'gone' || e.kind === 'not_found')) outcome = { type: 'gone' };
        else outcome = { type: 'rejected', message: e instanceof Error ? e.message : 'The backend refused this change.' };
      }
      if (!this.file) return false; // signed out meanwhile
      this.update(settle(this.state, entry, outcome, sentEditedAt), false);
    }
    return true;
  }

  private async send(entry: OutboxEntry, local: TaskItem | ReminderItem | undefined): Promise<SendOutcome> {
    const api = this.deps.api;
    if (entry.op === 'delete') {
      if (entry.kind === 'task') await api.deleteTask(entry.id);
      else await api.deleteReminder(entry.id);
      return { type: 'gone' };
    }
    if (!local) return { type: 'gone' }; // deleted locally after it was queued
    const item = entry.kind === 'task' ? await api.putTask(local as TaskItem) : await api.putReminder(local as ReminderItem);
    return { type: 'stored', item };
  }

  // ---------- reminders ----------

  /** Fires each reminder whose latest occurrence hasn't been shown yet. */
  checkReminders(now: number): void {
    if (!this.file) return;
    for (const r of Object.values(this.state.reminders)) {
      const due = dueOccurrence(r, now);
      if (due === null) continue;
      // Record it first, so a crash while showing it can't make it fire twice.
      this.saveReminder({ ...r, lastFiredAt: new Date(due).toISOString(), editedAt: new Date(now).toISOString() });
      this.deps.onReminder(r, now - due > MISSED_AFTER_MS);
    }
  }

  // ---------- plumbing ----------

  private update(next: StoreState, kick = true): void {
    this.state = next;
    this.save();
    this.deps.onChange(this.state);
    if (kick) void this.sync();
  }

  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}
