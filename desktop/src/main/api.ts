/**
 * The desktop app's only HTTP client for the SMOI backend. It runs in the main process:
 * renderers never see the JWT and never make network requests (their CSP forbids it). They call
 * these methods over IPC instead (src/main/ipc.ts).
 *
 * Every failure becomes an ApiError with a plain message the UI shows as is. The messages say what
 * went wrong and what to do; SMOI's personality never replaces them.
 *
 * No Electron imports, so it is tested in Node against a real local HTTP server
 * (test/api.test.ts).
 */
import type {
  AnswerResult, ApiErrorKind, ApiFailure, ChunkInfo, DocumentInfo, DraftItem, EmailAlert, EmailItem, GoogleOutcome,
  GooglePreview, GoogleStatus, LoginResult, Me, Proposal, Providers, ReminderCheck, StreamEvent, SyncResult, SyncSummary, Upcoming,
  CalendarEvent,
} from '../shared/apiTypes';
import type { ReminderItem, TaskItem } from '../shared/taskStore';
import { SseParser } from '../shared/sse';

export class ApiError extends Error implements ApiFailure {
  constructor(readonly kind: ApiErrorKind, message: string, readonly status?: number, readonly requestId?: string) {
    super(message);
  }

  toJSON(): ApiFailure {
    return { kind: this.kind, message: this.message, status: this.status, requestId: this.requestId };
  }
}

export interface TokenSource {
  token(): string | null;
  /** Called when the backend says the token is no longer valid. */
  expired(): void;
}

type Fetch = typeof fetch;

/** Ordinary requests give up after this long; uploads and answers have their own limits. */
const TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** The backend gives a streaming answer up to 300 s; this is a little longer. */
const STREAM_TIMEOUT_MS = 310_000;

export class ApiClient {
  constructor(
    private readonly baseUrl: () => string,
    private readonly session: TokenSource,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  // ---------- auth ----------

  async login(email: string, password: string): Promise<LoginResult> {
    const res = await this.send('POST', '/api/auth/login', { json: { email, password }, auth: false });
    if (res.status === 401) throw new ApiError('bad_credentials', "That email and password don't match an account.", 401);
    return this.json<LoginResult>(res);
  }

  async register(email: string, password: string): Promise<void> {
    const res = await this.send('POST', '/api/auth/register', { json: { email, password }, auth: false });
    if (res.status === 409) throw new ApiError('conflict', 'An account with that email already exists. Sign in instead.', 409);
    if (res.status === 400) {
      throw new ApiError('invalid', 'Use a valid email address and a password of 12 to 72 characters.', 400);
    }
    await this.json(res);
  }

  me(): Promise<Me> {
    return this.get<Me>('/api/me');
  }

  // ---------- documents ----------

  documents(): Promise<DocumentInfo[]> {
    return this.get<DocumentInfo[]>('/api/documents');
  }

  chunks(documentId: string): Promise<ChunkInfo[]> {
    return this.get<ChunkInfo[]>(`/api/documents/${encodeURIComponent(documentId)}/chunks`);
  }

  /** Uploads a file's bytes. The caller (main process) read them from a path the user picked. */
  async upload(filename: string, bytes: Uint8Array): Promise<DocumentInfo> {
    const form = new FormData();
    form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), filename);
    const res = await this.send('POST', '/api/documents', { body: form, timeoutMs: UPLOAD_TIMEOUT_MS });
    return this.json<DocumentInfo>(res);
  }

  async deleteDocument(documentId: string): Promise<void> {
    const res = await this.send('DELETE', `/api/documents/${encodeURIComponent(documentId)}`);
    await this.json(res);
  }

  providers(): Promise<Providers> {
    return this.get<Providers>('/api/settings/providers');
  }

  // ---------- tasks and reminders ----------

  /** Active tasks and reminders, plus recent deletions (with deletedAt set). */
  sync(): Promise<SyncResult> {
    return this.get<SyncResult>('/api/sync');
  }

  /** Creates or updates; answers with the row as stored (a newer one if this change lost). 410: deleted. */
  async putTask(t: TaskItem): Promise<TaskItem> {
    const { id, syncError: _e, ...body } = t;
    return this.json<TaskItem>(await this.send('PUT', `/api/tasks/${encodeURIComponent(id)}`, { json: body }));
  }

  async deleteTask(id: string): Promise<void> {
    await this.json(await this.send('DELETE', `/api/tasks/${encodeURIComponent(id)}`));
  }

  async putReminder(r: ReminderItem): Promise<ReminderItem> {
    const { id, syncError: _e, ...body } = r;
    return this.json<ReminderItem>(await this.send('PUT', `/api/reminders/${encodeURIComponent(id)}`, { json: body }));
  }

  async deleteReminder(id: string): Promise<void> {
    await this.json(await this.send('DELETE', `/api/reminders/${encodeURIComponent(id)}`));
  }

  // ---------- Google Calendar and Gmail (Phase 8) ----------

  google(): Promise<GoogleStatus> {
    return this.get<GoogleStatus>('/api/google');
  }

  async connectGoogle(): Promise<string> {
    const r = await this.json<{ authorizationUrl: string }>(await this.send('POST', '/api/google/connect'));
    return r.authorizationUrl;
  }

  async disconnectGoogle(deleteEmailData: boolean): Promise<{ revoked: boolean; emailDataDeleted: boolean }> {
    return this.json(await this.send('POST', '/api/google/disconnect', { json: { deleteEmailData } }));
  }

  upcoming(timeZone: string, days = 7): Promise<Upcoming> {
    return this.get<Upcoming>(`/api/calendar/upcoming?days=${days}&timeZone=${encodeURIComponent(timeZone)}`);
  }

  findEvents(query: string, day: string, timeZone: string): Promise<CalendarEvent[]> {
    return this.get<CalendarEvent[]>(`/api/calendar/find?q=${encodeURIComponent(query)}&day=${encodeURIComponent(day)}`
      + `&timeZone=${encodeURIComponent(timeZone)}`);
  }

  async proposeEvent(e: { title: string; start: string; end: string; reminderMinutes: number[] | null }): Promise<GooglePreview> {
    return this.json(await this.send('POST', '/api/calendar/events/propose', { json: e }));
  }

  async proposeEventUpdate(eventId: string, e: { title?: string; start?: string; end?: string; reminderMinutes?: number[] | null }): Promise<GooglePreview> {
    return this.json(await this.send('POST', `/api/calendar/events/${encodeURIComponent(eventId)}/propose-update`, { json: e }));
  }

  async proposeEventDelete(eventId: string): Promise<GooglePreview> {
    return this.json(await this.send('POST', `/api/calendar/events/${encodeURIComponent(eventId)}/propose-delete`));
  }

  async proposeDraft(d: { to: string; subject: string; body: string }, draftId?: string): Promise<GooglePreview> {
    const path = draftId ? `/api/drafts/${encodeURIComponent(draftId)}/propose` : '/api/drafts/propose';
    return this.json(await this.send('POST', path, { json: d }));
  }

  /** Applies a change the user confirmed. Repeating it is safe: the backend applies it once. */
  async confirmAction(id: string): Promise<GoogleOutcome> {
    return this.json(await this.send('POST', `/api/google/actions/${encodeURIComponent(id)}/confirm`, { timeoutMs: 60_000 }));
  }

  emails(): Promise<EmailItem[]> {
    return this.get<EmailItem[]>('/api/email?limit=100');
  }

  /** Can take a while: classification runs on the LLM. */
  async syncEmail(): Promise<SyncSummary> {
    return this.json(await this.send('POST', '/api/email/sync', { timeoutMs: 180_000 }));
  }

  /** Important emails not announced before. Each is returned once, ever. */
  async claimEmailAlerts(): Promise<EmailAlert[]> {
    return this.json(await this.send('POST', '/api/email/alerts'));
  }

  async emailToTask(id: string, title?: string, dueAt?: string | null): Promise<TaskItem> {
    return this.json(await this.send('POST', `/api/email/${encodeURIComponent(id)}/task`, { json: { title, dueAt } }));
  }

  async indexEmail(id: string, on: boolean): Promise<EmailItem> {
    return this.json(await this.send(on ? 'POST' : 'DELETE', `/api/email/${encodeURIComponent(id)}/index`));
  }

  drafts(): Promise<DraftItem[]> {
    return this.get<DraftItem[]>('/api/drafts');
  }

  /** Before a draft-linked reminder fires: is the draft still there? (FR-05.11) */
  async checkReminder(id: string): Promise<ReminderCheck> {
    return this.json(await this.send('POST', `/api/reminders/${encodeURIComponent(id)}/check`, { timeoutMs: 15_000 }));
  }

  // ---------- commands and voice ----------

  /** What a typed or spoken command means. Never acts. */
  async interpret(text: string, timeZone: string): Promise<Proposal> {
    return this.json<Proposal>(await this.send('POST', '/api/commands/interpret', { json: { text, timeZone }, timeoutMs: 120_000 }));
  }

  /** Turns a recording into text. The audio is sent once and not kept anywhere. */
  async transcribe(audio: Uint8Array, mediaType: string): Promise<string> {
    const res = await this.send('POST', '/api/voice/transcribe', {
      raw: { bytes: audio, type: mediaType }, timeoutMs: 60_000,
    });
    return (await this.json<{ text: string }>(res)).text;
  }

  // ---------- answers ----------

  /**
   * Asks SMOI Brain a question and streams the answer. Calls `onEvent` for each event and always
   * ends with exactly one `result`, `error` or `cut` event, unless the request fails before the
   * stream starts, in which case it throws an ApiError.
   */
  async ask(question: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.send('POST', '/api/query/stream', {
      json: { question }, timeoutMs: STREAM_TIMEOUT_MS, signal, accept: 'text/event-stream',
    });
    if (!res.ok) await this.json(res); // throws the right ApiError
    if (!res.body) {
      onEvent({ type: 'cut', message: 'The backend sent an empty response.' });
      return;
    }

    const parser = new SseParser();
    const decoder = new TextDecoder();
    let finished = false;
    const handle = (event: string, data: string) => {
      if (finished) return;
      const parsed = safeJson(data);
      if (event === 'sources' && Array.isArray(parsed)) onEvent({ type: 'sources', sources: parsed });
      else if (event === 'delta' && parsed && typeof parsed.text === 'string') onEvent({ type: 'delta', text: parsed.text });
      else if (event === 'result' && parsed && typeof parsed.outcome === 'string') {
        finished = true;
        onEvent({ type: 'result', result: parsed as AnswerResult });
      } else if (event === 'error') {
        finished = true;
        const status = parsed?.status;
        const detail = typeof parsed?.detail === 'string' ? parsed.detail : 'unknown error';
        onEvent({
          type: 'error',
          message: status === 503 ? `The language model became unavailable (${detail}).` : `The backend reported an error (${detail}).`,
        });
      }
    };
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parser.push(decoder.decode(value, { stream: true }))) handle(m.event, m.data);
      }
    } catch (e) {
      if (!finished) {
        finished = true;
        onEvent({ type: 'cut', message: isAbort(e) ? 'The request was cancelled or timed out.' : 'The connection to the backend was lost.' });
      }
      return;
    }
    if (!finished) onEvent({ type: 'cut', message: 'The connection ended before the answer finished.' });
  }

  // ---------- plumbing ----------

  private async get<T>(path: string): Promise<T> {
    return this.json<T>(await this.send('GET', path));
  }

  private async send(method: string, path: string, opts: {
    json?: unknown; body?: FormData; raw?: { bytes: Uint8Array; type: string }; auth?: boolean; timeoutMs?: number;
    signal?: AbortSignal; accept?: string;
  } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json' };
    if (opts.auth !== false) {
      const token = this.session.token();
      if (!token) throw new ApiError('session_expired', 'Please sign in first.');
      headers.Authorization = `Bearer ${token}`;
    }
    let body: string | FormData | Uint8Array<ArrayBuffer> | undefined = opts.body;
    if (opts.raw) {
      headers['Content-Type'] = opts.raw.type;
      body = opts.raw.bytes as Uint8Array<ArrayBuffer>;
    }
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(this.baseUrl() + path, { method, headers, body, signal });
    } catch (e) {
      if (isAbort(e) && timeout.aborted) {
        throw new ApiError('timeout', `The SMOI backend at ${this.baseUrl()} didn't answer in time. Try again.`);
      }
      if (isAbort(e)) throw new ApiError('timeout', 'The request was cancelled.');
      throw new ApiError('unreachable', `Can't reach the SMOI backend at ${this.baseUrl()}. Check that it's running.`);
    }
  }

  /** Reads a JSON body, or turns an error status into an ApiError. */
  private async json<T = unknown>(res: Response): Promise<T> {
    const requestId = res.headers.get('X-Request-Id') ?? undefined;
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const problem = safeJson(await res.text().catch(() => ''));
    const detail = typeof problem?.detail === 'string' ? problem.detail : null;
    const code = typeof problem?.code === 'string' ? problem.code : null;
    const s = res.status;
    if (code === 'google_reconnect' || code === 'google_not_connected' || code === 'google_not_configured') {
      throw new ApiError(code, detail ?? 'Google is not connected.', s, requestId);
    }
    if (s === 401) {
      this.session.expired();
      throw new ApiError('session_expired', 'Your session has expired. Please sign in again.', s, requestId);
    }
    if (s === 410) throw new ApiError('gone', 'That was deleted.', s, requestId);
    if (s === 404) throw new ApiError('not_found', "That item doesn't exist any more. It may have been deleted.", s, requestId);
    if (s === 429) {
      const wait = Number(res.headers.get('Retry-After'));
      const when = Number.isFinite(wait) && wait > 0 ? `in ${wait} second${wait === 1 ? '' : 's'}` : 'in a moment';
      throw new ApiError('rate_limited', `Too many requests. Try again ${when}.`, s, requestId);
    }
    if (s === 413) throw new ApiError('too_large', 'That file is larger than the backend accepts.', s, requestId);
    if (s === 415) throw new ApiError('unsupported', 'SMOI Brain accepts PDF, DOCX and TXT files only.', s, requestId);
    if (s === 409) throw new ApiError('conflict', detail ?? 'That conflicts with something that already exists.', s, requestId);
    if (s === 400) throw new ApiError('invalid', detail ? `The backend rejected the request: ${detail}` : 'The backend rejected the request.', s, requestId);
    if (s === 503) {
      throw new ApiError('unavailable', `A service SMOI needs is unavailable${detail ? `: ${detail}` : '.'}`, s, requestId);
    }
    throw new ApiError('server', `The SMOI backend had an error (HTTP ${s})${requestId ? `, request id ${requestId}` : ''}.`, s, requestId);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}
