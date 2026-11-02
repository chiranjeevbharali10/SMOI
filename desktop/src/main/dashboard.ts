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
import type { DocumentInfo, StreamEvent } from '../shared/apiTypes';
import type { BackendStatus, DashboardView, Result, SessionStatus, UserSettings } from '../shared/bridge';

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

  /** Fetches the document list, and keeps polling only while something is queued or processing. */
  async refreshDocuments(): Promise<Result<DocumentInfo[]>> {
    this.stopPolling();
    const r = await wrap(() => this.deps.api.documents());
    if (!r.ok) {
      this.deps.setCondition('working', false);
      return r;
    }
    this.docs = r.value;
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
