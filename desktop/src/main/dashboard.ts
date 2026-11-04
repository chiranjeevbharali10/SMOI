/**
 * The dashboard window and everything it asks the main process to do: sign in, list and upload
 * documents, ask SMOI Brain, read settings. The main process holds the session and makes every
 * HTTP request; the page only receives results as plain data.
 *
 * Rules enforced here:
 * - Only the dashboard's own page may call these handlers (checked per message).
 * - Uploads: the main process opens the file picker itself. No file path ever comes from a page.
 * - Deleting a document asks for confirmation in a native dialog first.
 * - Document status is polled only while something is indexing.
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ApiClient, ApiError } from './api';
import type { Session } from './session';
import type { Commands } from './commands';
import type { GoogleService, GoogleState } from './google';
import type { TaskService } from './tasks';
import type { DocumentInfo, GooglePreview, StreamEvent } from '../shared/apiTypes';
import type {
  BackendStatus, DashboardView, DraftInput, EventInput, GoogleView, PreviewOutcome, ReminderInput, Result, SessionStatus, TaskInput,
  TasksSnapshot, UserSettings,
} from '../shared/bridge';
import { describeGooglePreview, newReminder } from '../shared/proposal';
import { isTimeZone } from '../shared/recurrence';
import { sortedTasks, type Priority, type ReminderItem, type StoreState, type TaskItem } from '../shared/taskStore';

export interface DashboardDeps {
  api: ApiClient;
  session: Session;
  preload: string;
  icon: string;
  loadPage: (win: BrowserWindow) => void;
  lockDown: (win: BrowserWindow) => void;
  backend: () => BackendStatus;
  settings: () => UserSettings;
  updateSettings: (patch: Record<string, unknown>) => UserSettings;
  /** Frog conditions: a query is running, an answer is streaming, documents are indexing. */
  setCondition: (c: 'thinking' | 'speaking' | 'working', on: boolean) => void;
  /** An answer finished; SMOI reacts (a finding bubble, or a brief error for the fallback). */
  onAnswerFinished: (e: StreamEvent) => void;
  tasks: TaskService;
  commands: Commands;
  timeZone: () => string;
  /** Documents finished indexing since the last check. */
  onIndexed: (count: number) => void;
  google: GoogleService;
}

export interface OpenTiming {
  cold: boolean;
  ms: number;
}

const POLL_MS = 2000;
const MAX_QUESTION = 2000;

export class Dashboard {
  private win: BrowserWindow | null = null;
  private docs: DocumentInfo[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly streams = new Map<string, AbortController>();
  private opened = 0;
  private openStart: { at: number; cold: boolean } | null = null;
  private timingListeners: ((t: OpenTiming) => void)[] = [];
  private pendingView: DashboardView = 'home';
  /** Google proposals made from this window; only these ids can be confirmed. */
  private readonly previews = new Map<string, { preview: GooglePreview; at: number }>();

  constructor(private readonly deps: DashboardDeps) {
    this.wireIpc();
    deps.session.onChange((s) => {
      this.send('session:changed', s);
      if (s.signedIn) void this.refreshDocuments();
      else this.stopPolling();
    });
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** Opens (or focuses) the dashboard on a view. */
  open(view: DashboardView = 'home'): void {
    const existing = this.window;
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      this.send('dashboard:navigate', view);
      return;
    }
    this.pendingView = view;
    this.openStart = { at: performance.now(), cold: this.opened === 0 };
    this.opened++;
    const win = new BrowserWindow({
      width: 1120, height: 760, minWidth: 820, minHeight: 560, show: false, title: 'SMOI',
      icon: this.deps.icon, backgroundColor: '#FFF1D6', autoHideMenuBar: true,
      webPreferences: { preload: this.deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.removeMenu();
    this.deps.lockDown(win);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      this.win = null;
      this.streams.forEach((c) => c.abort());
      this.streams.clear();
    });
    this.win = win;
    this.deps.loadPage(win);
  }

  close(): void {
    this.window?.close();
  }

  onOpenTiming(listener: (t: OpenTiming) => void): void {
    this.timingListeners.push(listener);
  }

  backendChanged(status: BackendStatus): void {
    this.send('backend:changed', status);
    if (status.reachable && this.deps.session.status().signedIn) void this.refreshDocuments();
  }

  settingsChanged(s: UserSettings): void {
    this.send('settings:changed', s);
  }

  googleChanged(g: GoogleState): void {
    if (this.window) this.send('google:changed', this.googleView(g));
  }

  private googleView(g: GoogleState = this.deps.google.current): GoogleView {
    return { signedIn: this.deps.session.status().signedIn, status: g.status, syncing: g.syncing, unseen: g.unseen, lastError: g.lastError };
  }

  /** Keeps a Google proposal so the page can confirm it by id, and describes it. */
  private keep(preview: GooglePreview): PreviewOutcome {
    const now = Date.now();
    for (const [id, p] of this.previews) if (now - p.at > 30 * 60_000) this.previews.delete(id);
    this.previews.set(preview.id, { preview, at: now });
    return { id: preview.id, preview, view: describeGooglePreview(preview, this.deps.timeZone()) };
  }

  /** Runs a Google call; a reconnect or other Google error also updates the shared status. */
  private google<T>(fn: () => Promise<T>): Promise<Result<T>> {
    return wrap(async () => {
      try {
        return await fn();
      } catch (e) {
        this.deps.google.handle(e);
        throw e;
      }
    });
  }

  private async disconnectGoogle(): Promise<{ disconnected: boolean; revoked: boolean }> {
    const options: Electron.MessageBoxOptions = {
      type: 'warning', buttons: ['Disconnect and delete email data', 'Disconnect, keep email data', 'Cancel'],
      defaultId: 2, cancelId: 2, noLink: true, title: 'Disconnect Google',
      message: 'Disconnect your Google account from SMOI?',
      detail: 'SMOI revokes its access at Google. You can also delete the emails SMOI stored and anything it added to '
        + 'SMOI Brain from them. Tasks you made from emails, and drafts already in Gmail, are kept.',
    };
    const w = this.window;
    const choice = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
    if (choice.response === 2) return { disconnected: false, revoked: false };
    const r = await this.deps.google.disconnect(choice.response === 0);
    return { disconnected: true, revoked: r.revoked };
  }

  tasksChanged(s: StoreState, ready: boolean): void {
    if (this.window) this.send('tasks:changed', snapshot(s, ready));
  }

  /** Asks SMOI Brain from outside the page (a spoken question); the page shows it like a typed one. */
  askFromVoice(question: string): void {
    this.open('brain');
    this.send('brain:voice-question', question);
  }

  private async confirmDelete(what: string, name: string): Promise<boolean> {
    const options: Electron.MessageBoxOptions = {
      type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      title: `Delete ${what}`, message: `Delete the ${what} "${name}"?`, detail: "This can't be undone.",
    };
    const w = this.window;
    const choice = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
    return choice.response === 0;
  }

  /** Fetches the document list, and keeps polling only while something is queued or processing. */
  async refreshDocuments(): Promise<Result<DocumentInfo[]>> {
    this.stopPolling();
    const r = await wrap(() => this.deps.api.documents());
    if (!r.ok) {
      this.deps.setCondition('working', false);
      return r;
    }
    const wasIndexing = new Set(this.docs.filter((d) => d.status === 'queued' || d.status === 'processing').map((d) => d.id));
    this.docs = r.value;
    const finished = this.docs.filter((d) => d.status === 'indexed' && wasIndexing.has(d.id)).length;
    if (finished > 0) this.deps.onIndexed(finished);
    this.send('docs:changed', this.docs);
    const indexing = this.docs.some((d) => d.status === 'queued' || d.status === 'processing');
    this.deps.setCondition('working', indexing);
    if (indexing) this.pollTimer = setTimeout(() => void this.refreshDocuments(), POLL_MS);
    return r;
  }

  private stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private send(channel: string, payload: unknown) {
    const w = this.window;
    if (w && !w.webContents.isLoading()) w.webContents.send(channel, payload);
    else if (w) w.webContents.once('did-finish-load', () => w.webContents.send(channel, payload));
  }

  private async signIn(email: string, password: string): Promise<SessionStatus> {
    const t = await this.deps.api.login(email, password);
    return this.deps.session.signIn(t.accessToken, email, t.expiresAt);
  }

  private async ask(question: string): Promise<{ requestId: string }> {
    const requestId = randomUUID();
    const controller = new AbortController();
    this.streams.set(requestId, controller);
    this.deps.setCondition('thinking', true);
    let speaking = false;
    const emit = (event: StreamEvent) => {
      if (event.type === 'delta' && !speaking) {
        speaking = true;
        this.deps.setCondition('thinking', false);
        this.deps.setCondition('speaking', true);
      }
      this.send('brain:event', { requestId, event });
      if (event.type === 'result' || event.type === 'error' || event.type === 'cut') this.deps.onAnswerFinished(event);
    };
    void this.deps.api.ask(question, emit, controller.signal)
      .catch((e) => emit({ type: 'error', message: e instanceof Error ? e.message : 'The question could not be sent.' }))
      .finally(() => {
        this.streams.delete(requestId);
        this.deps.setCondition('thinking', this.streams.size > 0);
        this.deps.setCondition('speaking', false);
      });
    return { requestId };
  }

  private async upload(): Promise<{ uploaded: DocumentInfo[]; cancelled: boolean }> {
    const w = this.window;
    const options: Electron.OpenDialogOptions = {
      title: 'Add documents to SMOI Brain',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF, Word or text', extensions: ['pdf', 'docx', 'txt'] }],
    };
    const picked = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { uploaded: [], cancelled: true };
    const uploaded: DocumentInfo[] = [];
    try {
      for (const path of picked.filePaths) {
        const name = basename(path);
        try {
          uploaded.push(await this.deps.api.upload(name, await readFile(path)));
        } catch (e) {
          if (e instanceof ApiError) throw new ApiError(e.kind, `${name}: ${e.message}`, e.status, e.requestId);
          throw new ApiError('invalid', `${name}: the file couldn't be read.`);
        }
      }
    } finally {
      void this.refreshDocuments();
    }
    return { uploaded, cancelled: false };
  }

  private async delete(id: string): Promise<{ deleted: boolean }> {
    const doc = this.docs.find((d) => d.id === id);
    const name = doc?.filename ?? 'this document';
    const options: Electron.MessageBoxOptions = {
      type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Delete document',
      message: `Delete "${name}" from SMOI Brain?`,
      detail: 'Its passages will no longer appear in any answer. This can\'t be undone.',
    };
    const w = this.window;
    const choice = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
    if (choice.response !== 0) return { deleted: false };
    await this.deps.api.deleteDocument(id);
    void this.refreshDocuments();
    return { deleted: true };
  }

  private wireIpc(): void {
    const own = (e: IpcMainInvokeEvent) => e.sender === this.window?.webContents;
    const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.handle(channel, (e, ...args) => {
        if (!own(e)) throw new Error('Not allowed');
        return fn(...args);
      });
    };
    const str = (v: unknown, max: number): string => {
      if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error('Invalid input');
      return v;
    };

    handle('session:status', () => this.deps.session.status());
    handle('session:sign-in', (email, password) => wrap(() => this.signIn(str(email, 254), str(password, 72))));
    handle('session:register', (email, password) => wrap(async () => {
      await this.deps.api.register(str(email, 254), str(password, 72));
      return this.signIn(email as string, password as string);
    }));
    handle('session:sign-out', () => this.deps.session.signOut());
    handle('api:me', () => wrap(() => this.deps.api.me()));
    handle('api:providers', () => wrap(() => this.deps.api.providers()));
    handle('docs:list', () => this.refreshDocuments());
    handle('docs:upload', () => wrap(() => this.upload()));
    handle('docs:delete', (id) => wrap(() => this.delete(str(id, 64))));
    handle('docs:chunks', (id) => wrap(() => this.deps.api.chunks(str(id, 64))));
    handle('brain:ask', (q) => wrap(() => this.ask(str(typeof q === 'string' ? q.trim() : q, MAX_QUESTION))));
    handle('tasks:get', () => snapshot(this.deps.tasks.store, this.deps.session.status().signedIn));
    handle('tasks:save', (input) => wrap(async () => {
      const t = taskInput(input, this.deps.tasks.store.tasks);
      this.deps.tasks.saveTask(t);
      return t;
    }));
    handle('tasks:delete', (id) => wrap(async () => {
      const t = this.deps.tasks.store.tasks[str(id, 64)];
      if (!t) return { deleted: false };
      if (!(await this.confirmDelete('task', t.title))) return { deleted: false };
      this.deps.tasks.removeTask(t.id);
      return { deleted: true };
    }));
    handle('reminders:save', (input) => wrap(async () => {
      const r = reminderInput(input, this.deps.timeZone(), this.deps.tasks.store.tasks);
      this.deps.tasks.saveReminder(r);
      return r;
    }));
    handle('reminders:delete', (id) => wrap(async () => {
      const r = this.deps.tasks.store.reminders[str(id, 64)];
      if (!r) return { deleted: false };
      if (!(await this.confirmDelete('reminder', r.title))) return { deleted: false };
      this.deps.tasks.removeReminder(r.id);
      return { deleted: true };
    }));
    handle('command:interpret', (t) => wrap(() => this.deps.commands.interpret(str(typeof t === 'string' ? t.trim() : t, 1000))));
    handle('command:confirm', (id) => wrap(async () => ({ saved: await this.deps.commands.confirm(str(id, 64)) })));
    // ---- Google (Phase 8) ----
    const g = this.deps.google;
    const api = this.deps.api;
    handle('google:get', () => this.googleView());
    handle('google:connect', () => this.google(() => g.connect()));
    handle('google:disconnect', () => this.google(() => this.disconnectGoogle()));
    handle('google:open', (url) => wrap(() => g.open(str(url, 2000))));
    handle('calendar:upcoming', () => this.google(() => api.upcoming(this.deps.timeZone(), 30)));
    handle('calendar:propose', (input) => this.google(async () => this.keep(await api.proposeEvent(eventInput(input)))));
    handle('calendar:propose-change', (id, input) => this.google(async () =>
      this.keep(await api.proposeEventUpdate(eventId(id), eventInput(input, true)))));
    handle('calendar:propose-delete', (id) => this.google(async () => this.keep(await api.proposeEventDelete(eventId(id)))));
    handle('google:confirm', (id) => this.google(async () => {
      const kept = this.previews.get(str(id, 64));
      if (!kept) throw new Error('That proposal has expired. Make it again.');
      const saved = await this.deps.commands.applyGoogle(kept.preview);
      this.previews.delete(kept.preview.id);
      return { saved };
    }));
    handle('email:list', () => this.google(async () => {
      g.seen();
      return api.emails();
    }));
    handle('email:sync', () => this.google(async () => {
      await g.sync();
      g.seen();
      return api.emails();
    }));
    handle('email:task', (id) => this.google(async () => {
      const t = await api.emailToTask(str(id, 64));
      void this.deps.tasks.sync();
      return { title: t.title };
    }));
    handle('email:index', (id, on) => this.google(() => api.indexEmail(str(id, 64), on === true)));
    handle('drafts:list', () => this.google(() => api.drafts()));
    handle('drafts:propose', (input, draftId) => this.google(async () =>
      this.keep(await api.proposeDraft(draftInput(input), draftId === undefined || draftId === null ? undefined : str(draftId, 64)))));

    handle('backend:status', () => this.deps.backend());
    handle('settings:get', () => this.deps.settings());
    handle('settings:update', (patch) => {
      if (!patch || typeof patch !== 'object') throw new Error('Invalid input');
      return this.deps.updateSettings(patch as Record<string, unknown>);
    });
    ipcMain.on('dashboard:ready', (e) => {
      if (e.sender !== this.window?.webContents) return;
      this.send('dashboard:navigate', this.pendingView);
      if (this.openStart) {
        const t = { cold: this.openStart.cold, ms: performance.now() - this.openStart.at };
        this.openStart = null;
        this.timingListeners.forEach((l) => l(t));
      }
    });
  }
}

/** Runs a request and returns its outcome as plain data, so errors keep their kind across IPC. */
async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.toJSON() };
    return { ok: false, error: { kind: 'server', message: e instanceof Error ? e.message : 'Something went wrong.' } };
  }
}

export const sessionFile = (userData: string) => join(userData, 'session.bin');

function snapshot(s: StoreState, ready: boolean): TasksSnapshot {
  return {
    ready, tasks: sortedTasks(s),
    reminders: Object.values(s.reminders).sort((a, b) => a.firstAt.localeCompare(b.firstAt)),
    pending: s.outbox.length, syncedAt: s.syncedAt,
  };
}

const PRIORITIES: Priority[] = ['low', 'normal', 'high'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'weekdays'];

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new Error('Invalid date');
  return new Date(v).toISOString();
}

function text(v: unknown, max: number, required: boolean): string {
  if (typeof v !== 'string') throw new Error('Invalid input');
  const t = v.trim();
  if (required && !t) throw new Error('A title is needed.');
  if (t.length > max) throw new Error('That text is too long.');
  return t;
}

/** A task from the page, checked field by field. The page never sets edit times or completion times. */
export function taskInput(v: unknown, existing: Record<string, TaskItem>): TaskItem {
  const i = v as TaskInput;
  if (!i || typeof i !== 'object') throw new Error('Invalid input');
  if (i.id !== undefined && (typeof i.id !== 'string' || !existing[i.id])) throw new Error('That task no longer exists.');
  if (!PRIORITIES.includes(i.priority)) throw new Error('Invalid priority');
  const before = i.id ? existing[i.id] : undefined;
  const now = new Date().toISOString();
  return {
    id: before?.id ?? randomUUID(),
    title: text(i.title, 300, true),
    description: text(i.description ?? '', 5000, false),
    priority: i.priority,
    category: text(i.category ?? '', 50, false),
    dueAt: isoOrNull(i.dueAt),
    // Keep the original completion time when a completed task is edited (FR-02.06).
    completedAt: i.completed ? (before?.completedAt ?? now) : null,
    editedAt: now,
  };
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

function eventId(v: unknown): string {
  if (typeof v !== 'string' || !EVENT_ID.test(v)) throw new Error('Invalid event');
  return v;
}

/** Checks an event from the page. With `partial`, missing fields keep the event's current value. */
export function eventInput(v: unknown, partial = false): EventInput {
  const i = (v ?? {}) as Partial<EventInput>;
  if (typeof i !== 'object') throw new Error('Invalid input');
  const out: Partial<EventInput> = {};
  if (i.title !== undefined || !partial) out.title = text(i.title, 300, true);
  for (const k of ['start', 'end'] as const) {
    if (i[k] !== undefined || !partial) {
      const iso = isoOrNull(i[k]);
      if (!iso) throw new Error('Choose when the event starts and ends.');
      out[k] = iso;
    }
  }
  if (out.start && out.end && Date.parse(out.end) <= Date.parse(out.start)) throw new Error('The event must end after it starts.');
  if (i.reminderMinutes !== undefined && i.reminderMinutes !== null) {
    if (!Array.isArray(i.reminderMinutes) || i.reminderMinutes.length > 5
      || !i.reminderMinutes.every((m) => Number.isInteger(m) && m >= 0 && m <= 40320)) throw new Error('Invalid reminders');
    out.reminderMinutes = i.reminderMinutes;
  } else if (!partial) {
    out.reminderMinutes = null;
  }
  return out as EventInput;
}

const ONE_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function draftInput(v: unknown): DraftInput {
  const i = (v ?? {}) as Partial<DraftInput>;
  const to = typeof i.to === 'string' ? i.to.trim() : '';
  if (!ONE_ADDRESS.test(to) || to.length > 320) throw new Error('Enter one email address.');
  const subject = typeof i.subject === 'string' ? i.subject : '';
  if (subject.length > 998 || /[\r\n]/.test(subject)) throw new Error('The subject must be one line.');
  const body = typeof i.body === 'string' ? i.body : '';
  if (body.length > 20000) throw new Error('The message is too long.');
  return { to, subject, body };
}

export function reminderInput(v: unknown, timeZone: string, tasks: Record<string, TaskItem>): ReminderItem {
  const i = v as ReminderInput;
  if (!i || typeof i !== 'object') throw new Error('Invalid input');
  if (!REPEATS.includes(i.repeat)) throw new Error('Invalid repeat');
  const weekdays = i.repeat === 'weekdays' ? i.weekdays : 0;
  if (!Number.isInteger(weekdays) || weekdays < 0 || weekdays > 127 || (i.repeat === 'weekdays' && weekdays === 0)) {
    throw new Error('Choose at least one day.');
  }
  const firstAt = isoOrNull(i.firstAt);
  if (!firstAt) throw new Error('Choose when to be reminded.');
  if (i.repeat === 'none' && Date.parse(firstAt) <= Date.now()) throw new Error('That time has already passed.');
  if (i.taskId !== null && (typeof i.taskId !== 'string' || !tasks[i.taskId])) throw new Error('That task no longer exists.');
  const draftId = i.draftId ?? null;
  if (draftId !== null && (typeof draftId !== 'string' || !/^[0-9a-f-]{36}$/.test(draftId))) throw new Error('Invalid draft.');
  if (!isTimeZone(timeZone)) throw new Error('Unknown time zone.');
  return newReminder({
    id: randomUUID(), taskId: i.taskId, title: text(i.title, 300, true), firstAt, repeat: i.repeat, weekdays, timeZone, draftId,
  }, new Date());
}
