/**
 * Voice commands (FR-03.01 to FR-03.07, NFR-01.04, NFR-04.02, NFR-04.03).
 *
 * - A global shortcut (default Ctrl+Alt+J, changeable) starts listening. If Windows won't give
 *   SMOI the shortcut, the user is told and asked to choose another.
 * - Pressing it shows the listening frog at once, then turns the microphone on. The microphone is
 *   only ever on between that press and the end of the recording, and the frog is in the
 *   listening state the whole time.
 * - Esc, or the shortcut again, cancels: the microphone is released at once (well under the
 *   required 1 second) and nothing is sent.
 * - The recording goes to the backend for speech-to-text, then the text is interpreted. Nothing
 *   happens until the user has seen what SMOI understood; commands that create something need
 *   a confirmation (handled by the caller).
 * - Only the hidden recorder page, on its own session, may use the microphone.
 */
import { BrowserWindow, globalShortcut, ipcMain, session as electronSession, type IpcMainEvent } from 'electron';
import { ApiError, type ApiClient } from './api';
import type { Proposal } from '../shared/apiTypes';

export interface VoiceDeps {
  api: ApiClient;
  preload: string;
  loadPage: (win: BrowserWindow) => void;
  lockDown: (win: BrowserWindow) => void;
  enabled: () => boolean;
  shortcut: () => string;
  signedIn: () => boolean;
  timeZone: () => string;
  /** Listening: the frog state and the design's listening line. */
  setListening: (on: boolean) => void;
  setThinking: (on: boolean) => void;
  /**
   * A plain status message. Important ones (microphone blocked, a service down) stay until
   * dismissed; the others (nothing heard) fade.
   */
  tell: (text: string, important: boolean) => void;
  /** A command was understood; the caller shows it and asks for confirmation if needed. */
  onCommand: (heard: string, proposal: Proposal) => void;
  /** The shortcut was registered (null) or refused (a message for the user). */
  onShortcutStatus: (error: string | null) => void;
}

export const VOICE_PARTITION = 'smoi-voice';
const MAX_RECORDING_MS = 30_000;

type Phase = 'idle' | 'starting' | 'listening' | 'working';

/** A shortcut in Electron's accelerator format that Windows can register. */
export function isAccelerator(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 40) return false;
  const parts = s.split('+');
  const modifiers = new Set(['Control', 'Ctrl', 'Alt', 'Shift', 'Super', 'CommandOrControl']);
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  return mods.length >= 1 && mods.every((m) => modifiers.has(m)) && new Set(mods).size === mods.length
    && /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space)$/.test(key);
}

export class Voice {
  private win: BrowserWindow | null = null;
  private phase: Phase = 'idle';
  /** Increases on every start and cancel, so a late result from a cancelled take is ignored. */
  private take = 0;
  private registered: string | null = null;

  constructor(private readonly deps: VoiceDeps) {
    const voice = electronSession.fromPartition(VOICE_PARTITION);
    const isRecorder = (wc: Electron.WebContents | null) => !!wc && wc === this.win?.webContents;
    voice.setPermissionRequestHandler((wc, permission, callback, details) => {
      const audioOnly = 'mediaTypes' in details && (details.mediaTypes ?? []).every((t) => t === 'audio');
      const ok = permission === 'media' && audioOnly && isRecorder(wc) && this.phase === 'starting';
      if (!ok) console.warn('[voice] denied permission request', JSON.stringify({ permission, details, recorder: isRecorder(wc), phase: this.phase }));
      callback(ok);
    });
    voice.setPermissionCheckHandler((wc, permission, origin, details) => {
      const ok = permission === 'media' && isRecorder(wc);
      if (!ok) console.warn('[voice] denied permission check', JSON.stringify({ permission, origin, details, recorder: isRecorder(wc) }));
      return ok;
    });
    this.wireIpc();
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  /** Registers the shortcut from settings (again), and prepares the recorder if voice is on. */
  apply(): void {
    if (this.registered) globalShortcut.unregister(this.registered);
    this.registered = null;
    if (!this.deps.enabled()) {
      this.cancel();
      this.win?.destroy();
      this.win = null;
      this.deps.onShortcutStatus(null);
      return;
    }
    this.ensureRecorder();
    const accel = this.deps.shortcut();
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => this.toggle());
    } catch {
      ok = false;
    }
    if (ok) this.registered = accel;
    this.deps.onShortcutStatus(ok ? null
      : `Windows didn't let SMOI use ${accel.replace(/Control/g, 'Ctrl')}. Another app may be using it. Choose a different shortcut.`);
  }

  destroy(): void {
    this.cancel();
    globalShortcut.unregisterAll();
    this.win?.destroy();
  }

  /** The shortcut, or "Talk to SMOI" with voice on: start, or cancel if already going. */
  toggle(): void {
    if (this.phase === 'idle') this.start();
    else this.cancel();
  }

  start(): void {
    if (this.phase !== 'idle' || !this.deps.enabled()) return;
    if (!this.deps.signedIn()) {
      this.deps.tell('Sign in to SMOI first (open the dashboard), then try again.', true);
      return;
    }
    const win = this.ensureRecorder();
    this.take++;
    this.phase = 'starting';
    this.deps.setListening(true); // shown at once (NFR-01.04), before the microphone is on
    globalShortcut.register('Escape', () => this.cancel());
    win.webContents.send('voice:start', { maxMs: MAX_RECORDING_MS });
  }

  /** Esc or the shortcut again: stop, release the microphone, send nothing. */
  cancel(): void {
    if (this.phase === 'idle') return;
    this.take++;
    this.win?.webContents.send('voice:cancel');
    this.finish();
  }

  private finish(): void {
    this.phase = 'idle';
    globalShortcut.unregister('Escape');
    this.deps.setListening(false);
    this.deps.setThinking(false);
  }

  private ensureRecorder(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      show: false, width: 200, height: 100, skipTaskbar: true, focusable: false, title: 'SMOI recorder',
      webPreferences: {
        preload: this.deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
        partition: VOICE_PARTITION, backgroundThrottling: false,
      },
    });
    this.deps.lockDown(win);
    this.deps.loadPage(win);
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    this.win = win;
    return win;
  }

  private async handle(audio: Uint8Array): Promise<void> {
    const take = this.take;
    this.phase = 'working';
    this.deps.setListening(false);
    this.deps.setThinking(true);
    try {
      const heard = (await this.deps.api.transcribe(audio, 'audio/webm')).trim();
      if (take !== this.take) return;
      if (!heard) {
        this.deps.tell("I didn't catch any words. Try again a little closer to the microphone.", false);
        return;
      }
      const proposal = await this.deps.api.interpret(heard, this.deps.timeZone());
      if (take !== this.take) return;
      this.deps.onCommand(heard, proposal);
    } catch (e) {
      if (take === this.take) this.deps.tell(e instanceof ApiError ? e.message : 'Something went wrong with that command.', true);
    } finally {
      if (take === this.take) this.finish();
    }
  }

  private wireIpc(): void {
    const own = (e: IpcMainEvent) => !!this.win && e.sender === this.win.webContents;
    ipcMain.on('voice:ready', () => {});
    ipcMain.on('voice:started', (e) => {
      if (own(e) && this.phase === 'starting') this.phase = 'listening';
    });
    ipcMain.on('voice:done', (e, audio: unknown) => {
      if (!own(e) || this.phase !== 'listening') return;
      if (!(audio instanceof Uint8Array) || audio.length === 0 || audio.length > 4 * 1024 * 1024) {
        this.finish();
        return;
      }
      void this.handle(audio);
    });
    ipcMain.on('voice:nothing', (e) => {
      if (!own(e) || this.phase !== 'listening') return;
      this.finish();
      this.deps.tell("I didn't hear anything, so I stopped listening.", false);
    });
    ipcMain.on('voice:failed', (e, name: unknown) => {
      if (!own(e)) return;
      this.finish();
      this.deps.tell(name === 'NotAllowedError'
        ? 'Windows blocked the microphone. Allow it in Settings > Privacy & security > Microphone ("Let desktop apps access your microphone").'
        : name === 'NotFoundError' ? 'No microphone was found. Plug one in and try again.'
          : "The microphone couldn't be started.", true);
    });
  }
}
