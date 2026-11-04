import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookListener, MAX_BODY, parseHookBody, SECRET_HEADER } from '../src/main/claudeHooks';
import type { HookEvent } from '../src/shared/claudeRuns';

const SECRET = 'test-secret-not-real-0123456789';

function post(port: number, path: string, body: string, headers: Record<string, string> = {}, method = 'POST'):
  Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    // The server may close an oversized upload early; the status has already arrived by then.
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? undefined : reject(e)));
    req.end(body);
  });
}

const ok = { [SECRET_HEADER]: SECRET };
const body = (hook: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 'abc-123', hook_event_name: hook, ...extra });

describe('Claude Code hook listener', () => {
  let listener: HookListener;
  let port: number;
  let events: [HookEvent, string][];
  let rejects: string[];

  beforeEach(async () => {
    events = [];
    rejects = [];
    listener = new HookListener({ secret: SECRET, port: 0, onEvent: (e, s) => events.push([e, s]), onReject: (_s, r) => rejects.push(r) });
    port = await listener.start();
  });
  afterEach(() => listener.stop());

  it('accepts the three hooks and passes on only the event and session id', async () => {
    expect((await post(port, '/claude/start', body('UserPromptSubmit', { prompt: 'SECRET PROMPT TEXT' }), ok)).status).toBe(204);
    expect((await post(port, '/claude/waiting', body('Notification', { message: 'Claude needs permission' }), ok)).status).toBe(204);
    expect((await post(port, '/claude/done', body('Stop'), ok)).status).toBe(204);
    expect(events).toEqual([['start', 'abc-123'], ['waiting', 'abc-123'], ['done', 'abc-123']]);
  });

  it('rejects a missing or wrong secret', async () => {
    expect((await post(port, '/claude/start', body('UserPromptSubmit'))).status).toBe(401);
    expect((await post(port, '/claude/start', body('UserPromptSubmit'), { [SECRET_HEADER]: 'wrong' })).status).toBe(401);
    expect((await post(port, '/claude/start', body('UserPromptSubmit'), { [SECRET_HEADER]: SECRET + 'x' })).status).toBe(401);
    expect(events).toEqual([]);
  });

  it('rejects malformed payloads', async () => {
    const bad = ['not json', '[]', 'null', '{}', JSON.stringify({ session_id: 42 }),
      JSON.stringify({ session_id: '../../etc' }), JSON.stringify({ session_id: 'x'.repeat(129) })];
    for (const b of bad) {
      expect((await post(port, '/claude/start', b, ok)).status, b).toBe(400);
    }
    // A body from another hook sent to the wrong route.
    expect((await post(port, '/claude/done', body('UserPromptSubmit'), ok)).status).toBe(400);
    expect(events).toEqual([]);
  });

  it('rejects an oversized body', async () => {
    const big = JSON.stringify({ session_id: 'abc', prompt: 'x'.repeat(MAX_BODY) });
    expect((await post(port, '/claude/start', big, ok)).status).toBe(413);
    expect(events).toEqual([]);
  });

  it('rejects unknown routes, other methods and other hosts', async () => {
    expect((await post(port, '/claude/other', body('Stop'), ok)).status).toBe(404);
    expect((await post(port, '/claude/done', '', ok, 'GET')).status).toBe(405);
    expect((await post(port, '/claude/done', body('Stop'), { ...ok, Host: 'evil.example' })).status).toBe(421);
    expect(events).toEqual([]);
  });

  it('never puts body content in rejection reasons', async () => {
    await post(port, '/claude/start', JSON.stringify({ session_id: 'bad id!', prompt: 'SECRET PROMPT TEXT' }), ok);
    expect(rejects.length).toBe(1);
    expect(rejects.join(' ')).not.toContain('SECRET PROMPT');
  });

  it('listens on 127.0.0.1 only', () => {
    const addr = (listener as unknown as { server: { address(): { address: string } } }).server.address();
    expect(addr.address).toBe('127.0.0.1');
  });

  it('needs a secret to exist at all', () => {
    expect(() => new HookListener({ secret: '', port: 0, onEvent: () => {} })).toThrow();
  });
});

describe('parseHookBody', () => {
  it('accepts a body without hook_event_name', () => {
    expect(parseHookBody(JSON.stringify({ session_id: 'a_b-1' }), 'Stop')).toEqual({ sessionId: 'a_b-1' });
  });
});
