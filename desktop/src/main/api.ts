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
  AnswerResult, ApiErrorKind, ApiFailure, ChunkInfo, DocumentInfo, LoginResult, Me, Providers, StreamEvent,
} from '../shared/apiTypes';
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
    json?: unknown; body?: FormData; auth?: boolean; timeoutMs?: number; signal?: AbortSignal; accept?: string;
  } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json' };
    if (opts.auth !== false) {
      const token = this.session.token();
      if (!token) throw new ApiError('session_expired', 'Please sign in first.');
      headers.Authorization = `Bearer ${token}`;
    }
    let body: string | FormData | undefined = opts.body;
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
    const s = res.status;
    if (s === 401) {
      this.session.expired();
      throw new ApiError('session_expired', 'Your session has expired. Please sign in again.', s, requestId);
    }
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
