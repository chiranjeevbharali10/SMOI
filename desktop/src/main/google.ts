/**
 * Google Calendar and Gmail on the desktop (Phase 8): the connection status, a Gmail sync every
 * two minutes while connected, and alerts for important email.
 *
 * - Alerts carry no email content (FR-05.04): the backend hands out each important email's alert
 *   once, ever, with only an id and a time, and SMOI says "You've got an important email".
 * - When Google rejects SMOI (revoked, expired), the backend answers google_reconnect: syncing
 *   pauses, the dashboard shows a reconnect banner, and SMOI says so once (FR-05.12).
 * - Links are opened in the user's browser only if they point at Google's own sites, so a link in
 *   untrusted content can't send the user anywhere else.
 */
import { shell } from 'electron';
import { ApiError, type ApiClient } from './api';
import type { GoogleStatus } from '../shared/apiTypes';
import { safeGoogleUrl } from '../shared/googleLinks';

export const SYNC_MS = 2 * 60_000;

export interface GoogleDeps {
  api: ApiClient;
  signedIn: () => boolean;
  timeZone: () => string;
  /** Important email arrived (count of new alerts). */
  onImportant: (count: number) => void;
  /** Google stopped accepting SMOI; shown once per disconnection. */
  onReconnectNeeded: () => void;
  onChange: (s: GoogleState) => void;
}

export interface GoogleState {
  status: GoogleStatus | null;
  /** Emails synced but not yet looked at in the inbox. */
  unseen: number;
  syncing: boolean;
  lastError: string | null;
  /** Today is "suspiciously busy" (the backend's rule), or null if unknown. */
  busyToday: boolean | null;
}

export class GoogleService {
  private timer: NodeJS.Timeout | null = null;
  private state: GoogleState = { status: null, unseen: 0, syncing: false, lastError: null, busyToday: null };
  private announcedReconnect = false;

  constructor(private readonly deps: GoogleDeps) {}

  get current(): GoogleState {
    return this.state;
  }

  get connected(): boolean {
    return this.state.status?.status === 'connected';
  }

  start(): void {
    this.stop();
    void this.refresh().then(() => this.sync());
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<GoogleStatus | null> {
    if (!this.deps.signedIn()) {
      this.set({ status: null });
      return null;
    }
    try {
      const status = await this.deps.api.google();
      if (status.status === 'connected') this.announcedReconnect = false;
      if (status.status === 'reconnect_required') this.reconnectNeeded();
      this.set({ status, lastError: null });
      return status;
    } catch (e) {
      this.set({ lastError: e instanceof Error ? e.message : 'Google status unavailable.' });
      return this.state.status;
    }
  }

  /** One Gmail sync, then any new alerts. Skipped unless connected. */
  async sync(): Promise<void> {
    if (!this.deps.signedIn() || !this.connected || this.state.syncing) return;
    this.set({ syncing: true });
    try {
      const r = await this.deps.api.syncEmail();
      const alerts = await this.deps.api.claimEmailAlerts();
      this.set({ unseen: this.state.unseen + r.newMessages, lastError: null });
      if (alerts.length > 0) this.deps.onImportant(alerts.length);
      const today = await this.deps.api.upcoming(this.deps.timeZone(), 1);
      this.set({ busyToday: today.today.busy });
    } catch (e) {
      this.handle(e);
    } finally {
      this.set({ syncing: false });
    }
  }

  /** The inbox was opened: nothing is unseen any more. */
  seen(): void {
    this.set({ unseen: 0 });
  }

  /** Asks the backend for the consent URL and opens it in the browser. */
  async connect(): Promise<void> {
    const url = await this.deps.api.connectGoogle();
    if (!safeGoogleUrl(url)) throw new Error("The sign-in link didn't point at Google, so SMOI didn't open it.");
    await shell.openExternal(url);
  }

  async disconnect(deleteEmailData: boolean): Promise<{ revoked: boolean }> {
    const r = await this.deps.api.disconnectGoogle(deleteEmailData);
    this.set({ unseen: 0 });
    await this.refresh();
    return r;
  }

  /** Opens a Gmail or Calendar link from SMOI's own data, if it really is Google's. */
  async open(url: string): Promise<void> {
    if (!safeGoogleUrl(url)) throw new Error('SMOI only opens links to Gmail and Google Calendar.');
    await shell.openExternal(url);
  }

  /** Errors from any Google call: a reconnect pauses everything until the user reconnects. */
  handle(e: unknown): void {
    if (e instanceof ApiError && (e.kind === 'google_reconnect')) {
      if (this.state.status) this.set({ status: { ...this.state.status, status: 'reconnect_required' } });
      this.reconnectNeeded();
      return;
    }
    if (e instanceof ApiError && e.kind === 'google_not_connected' && this.state.status) {
      this.set({ status: { ...this.state.status, status: 'not_connected' } });
      return;
    }
    this.set({ lastError: e instanceof Error ? e.message : 'Google request failed.' });
  }

  private reconnectNeeded(): void {
    if (this.announcedReconnect) return;
    this.announcedReconnect = true;
    this.deps.onReconnectNeeded();
  }

  private set(p: Partial<GoogleState>): void {
    this.state = { ...this.state, ...p };
    this.deps.onChange(this.state);
  }
}
