/**
 * The local listener for Claude Code hooks (FR-10.01, NFR-03.16).
 *
 *   POST http://127.0.0.1:<port>/claude/start | /claude/done | /claude/waiting
 *   X-SMOI-Hook-Secret: <SMOI_HOOK_SECRET>
 *   body: the hook's JSON input, as Claude Code writes it to the hook's stdin
 *
 * Security:
 * - Bound to 127.0.0.1 only, so nothing off this machine can reach it.
 * - The shared secret comes from the environment and is compared in constant time. Without a
 *   secret configured the listener doesn't start at all.
 * - The Host header must name the loopback address, so a web page can't reach it through DNS
 *   rebinding, and browsers can't send the custom secret header cross-origin without a CORS
 *   preflight, which this server never approves.
 * - The body is untrusted. It is capped at 64 KB, must be JSON, and only `session_id` (a short id)
 *   and `hook_event_name` (must match the route) are kept. Everything else, including prompt text,
 *   messages, paths and file contents, is discarded unread and never logged.
 *
 * Plain Node (no Electron), so test/claudeHooks.test.ts runs it on a real socket.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HookEvent } from '../shared/claudeRuns';

export const SECRET_HEADER = 'x-smoi-hook-secret';
export const MAX_BODY = 64 * 1024;
export const DEFAULT_PORT = 47821;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ROUTES: Record<string, { event: HookEvent; hookName: string }> = {
  '/claude/start': { event: 'start', hookName: 'UserPromptSubmit' },
  '/claude/done': { event: 'done', hookName: 'Stop' },
  '/claude/waiting': { event: 'waiting', hookName: 'Notification' },
};

export interface HookListenerOptions {
  secret: string;
  port: number;
  /** Called after a request passed every check. */
  onEvent: (event: HookEvent, sessionId: string) => void;
  /** Rejections, by reason only (never the body). */
  onReject?: (status: number, reason: string) => void;
}

/** Hashing first makes the comparison constant-time even when the lengths differ. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Validates a hook body. Returns the session id, or a reason it was rejected. */
export function parseHookBody(raw: string, expectedHook: string): { sessionId: string } | { error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: 'body is not JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body is not an object' };
  const { session_id: sessionId, hook_event_name: hookName } = body as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { error: 'bad session_id' };
  // Optional (older Claude Code versions may leave it out), but if present it must match the route.
  if (hookName !== undefined && hookName !== expectedHook) return { error: 'hook_event_name does not match the route' };
  return { sessionId };
}

export class HookListener {
  private server: Server | null = null;

  constructor(private readonly opts: HookListenerOptions) {
    if (!opts.secret) throw new Error('A hook secret is required');
  }

  /** Resolves with the bound port (useful when port 0 asks for a free one). */
  start(): Promise<number> {
    const server = createServer((req, res) => this.handle(req, res));
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  private reply(res: ServerResponse, status: number, reason?: string): void {
    if (reason) this.opts.onReject?.(status, reason);
    res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(status === 204 ? undefined : reason ?? '');
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const route = ROUTES[req.url ?? ''];
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return this.reply(res, 421, 'bad host');
    if (!route) return this.reply(res, 404, 'unknown route');
    if (req.method !== 'POST') return this.reply(res, 405, 'method not allowed');
    const given = req.headers[SECRET_HEADER];
    if (typeof given !== 'string' || !sameSecret(given, this.opts.secret)) return this.reply(res, 401, 'bad secret');
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > MAX_BODY) return this.reply(res, 413, 'body too large');

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        this.reply(res, 413, 'body too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const parsed = parseHookBody(Buffer.concat(chunks).toString('utf8'), route.hookName);
      if ('error' in parsed) return this.reply(res, 400, parsed.error);
      // Answer first: the hook (and so Claude Code) never waits on SMOI's own work.
      this.reply(res, 204);
      try {
        this.opts.onEvent(route.event, parsed.sessionId);
      } catch {
        // A frog problem must never surface as a hook failure.
      }
    });
    req.on('error', () => {
      done = true;
    });
  }
}
