import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../src/main/api';
import type { StreamEvent } from '../src/shared/apiTypes';

/**
 * The API client against a real HTTP server on 127.0.0.1 (no fetch mocks): real status codes,
 * headers, multipart bodies and server-sent events split at awkward places.
 */
type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void | Promise<void>;
let handler: Handler;
let seen: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
let server: Server;
let base: string;
let token: string | null = 'jwt-123';
let expiredCalls = 0;

const session = { token: () => token, expired: () => { expiredCalls++; token = null; } };
const client = () => new ApiClient(() => base, session);

beforeAll(async () => {
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      void handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  seen = [];
  token = 'jwt-123';
  expiredCalls = 0;
});

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const problem = (res: ServerResponse, status: number, detail: string, headers: Record<string, string> = {}) =>
  json(res, status, { type: 'about:blank', status, detail }, headers);

const result = {
  outcome: 'answered', answer: 'Frogs are amphibians [S1].', message: null,
  citations: [{ label: 'S1', chunkId: 'c1', documentId: 'd1', filename: 'frogs.pdf', chunkIndex: 0, pageStart: 2, pageEnd: 2, section: null }],
  invalidCitations: [], refusalCategory: null, provider: 'ollama', model: 'm', mode: 'hybrid', sourcesGiven: 1,
  excludedDocuments: 0, omittedForContext: 0, truncated: false, passages: null,
};

describe('auth', () => {
  it('logs in without a token and returns the JWT', async () => {
    handler = (_req, body, res) => {
      expect(JSON.parse(body.toString())).toEqual({ email: 'a@b.c', password: 'pw' });
      json(res, 200, { accessToken: 'new', tokenType: 'Bearer', expiresAt: '2030-01-01T00:00:00Z' });
    };
    token = null;
    const r = await client().login('a@b.c', 'pw');
    expect(r.accessToken).toBe('new');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].url).toBe('/api/auth/login');
  });

  it('a wrong password gets one plain message (same for an unknown email)', async () => {
    handler = (_q, _b, res) => problem(res, 401, 'Invalid email or password');
    await expect(client().login('a@b.c', 'x')).rejects.toMatchObject({
      kind: 'bad_credentials', message: "That email and password don't match an account.",
    });
    expect(expiredCalls).toBe(0); // a failed login is not an expired session
  });

  it('register explains a taken email and the password rule', async () => {
    handler = (_q, _b, res) => problem(res, 409, 'Email already registered');
    await expect(client().register('a@b.c', 'longenoughpassword')).rejects.toMatchObject({ kind: 'conflict' });
    handler = (_q, _b, res) => problem(res, 400, 'Invalid request content.');
    await expect(client().register('a@b.c', 'short')).rejects.toMatchObject({
      kind: 'invalid', message: 'Use a valid email address and a password of 12 to 72 characters.',
    });
  });
});

describe('authenticated requests', () => {
  it('send the bearer token', async () => {
    handler = (_q, _b, res) => json(res, 200, []);
    await client().documents();
    expect(seen[0].headers.authorization).toBe('Bearer jwt-123');
  });

  it('a 401 ends the session and says to sign in again', async () => {
    handler = (_q, _b, res) => problem(res, 401, 'expired');
    await expect(client().documents()).rejects.toMatchObject({
      kind: 'session_expired', message: 'Your session has expired. Please sign in again.',
    });
    expect(expiredCalls).toBe(1);
  });

  it('without a token, nothing is sent', async () => {
    token = null;
    await expect(client().documents()).rejects.toMatchObject({ kind: 'session_expired' });
    expect(seen).toHaveLength(0);
  });

  it('429 reports the Retry-After wait', async () => {
    handler = (_q, _b, res) => problem(res, 429, 'Too many', { 'Retry-After': '7' });
    await expect(client().documents()).rejects.toMatchObject({ kind: 'rate_limited', message: 'Too many requests. Try again in 7 seconds.' });
  });

  it('500 includes the request id so it can be found in the logs', async () => {
    handler = (_q, _b, res) => problem(res, 500, 'boom', { 'X-Request-Id': 'req-42' });
    const e = await client().documents().catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe('The SMOI backend had an error (HTTP 500), request id req-42.');
  });

  it('a backend that is not running is reported plainly', async () => {
    const down = new ApiClient(() => 'http://127.0.0.1:9', session);
    await expect(down.documents()).rejects.toMatchObject({
      kind: 'unreachable', message: "Can't reach the SMOI backend at http://127.0.0.1:9. Check that it's running.",
    });
  });
});

describe('upload', () => {
  it('sends the file as multipart form data under "file"', async () => {
    handler = (_q, _b, res) => json(res, 202, { id: 'd1', filename: 'notes.txt', status: 'queued' });
    const doc = await client().upload('notes.txt', new TextEncoder().encode('hello frog'));
    expect(doc.status).toBe('queued');
    const req = seen[0];
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const text = req.body.toString();
    expect(text).toContain('name="file"; filename="notes.txt"');
    expect(text).toContain('hello frog');
  });

  it('explains unsupported and oversized files', async () => {
    handler = (_q, _b, res) => problem(res, 415, 'Unsupported');
    await expect(client().upload('a.exe', new Uint8Array([1]))).rejects.toMatchObject({ kind: 'unsupported' });
    handler = (_q, _b, res) => problem(res, 413, 'Too big');
    await expect(client().upload('a.pdf', new Uint8Array([1]))).rejects.toMatchObject({ kind: 'too_large' });
  });
});

describe('streaming answers', () => {
  const sse = (event: string, data: unknown) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;

  async function ask(write: (res: ServerResponse) => Promise<void> | void): Promise<StreamEvent[]> {
    handler = async (_q, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      await write(res);
    };
    const events: StreamEvent[] = [];
    await client().ask('What are frogs?', (e) => events.push(e));
    return events;
  }

  it('parses sources, deltas and the result, even when split mid-line', async () => {
    const whole = sse('sources', [result.citations[0]]) + sse('delta', { text: 'Frogs are ' })
      + sse('delta', { text: 'amphibians [S1].' }) + sse('result', result);
    const events = await ask(async (res) => {
      for (let i = 0; i < whole.length; i += 7) {
        res.write(whole.slice(i, i + 7));
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    });
    expect(events.map((e) => e.type)).toEqual(['sources', 'delta', 'delta', 'result']);
    expect(events[3]).toMatchObject({ type: 'result', result: { outcome: 'answered' } });
    expect(JSON.parse(seen[0].body.toString())).toEqual({ question: 'What are frogs?' });
    expect(seen[0].headers.accept).toBe('text/event-stream');
  });

  it('reports an error event from the backend', async () => {
    const events = await ask((res) => {
      res.end(sse('delta', { text: 'Partial' }) + sse('error', { status: 503, detail: 'LLM unavailable' }));
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'The language model became unavailable (LLM unavailable).' });
  });

  it('reports a stream that stops without a result', async () => {
    const events = await ask((res) => { res.end(sse('delta', { text: 'Partial' })); });
    expect(events.at(-1)).toEqual({ type: 'cut', message: 'The connection ended before the answer finished.' });
  });

  it('reports a connection that drops mid-stream', async () => {
    const events = await ask((res) => {
      res.write(sse('delta', { text: 'Partial' }));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    expect(events[0]).toEqual({ type: 'delta', text: 'Partial' });
    expect(events.at(-1)?.type).toBe('cut');
  });

  it('a rate-limited question throws before any event', async () => {
    handler = (_q, _b, res) => problem(res, 429, 'slow down', { 'Retry-After': '1' });
    const events: StreamEvent[] = [];
    await expect(client().ask('q', (e) => events.push(e))).rejects.toMatchObject({ message: 'Too many requests. Try again in 1 second.' });
    expect(events).toEqual([]);
  });
});

describe('tasks, commands and voice', () => {
  const t = {
    id: 't1', title: 'Feed the frog', description: '', priority: 'normal' as const, category: '', dueAt: null,
    completedAt: null, editedAt: '2026-11-03T10:00:00.000Z', syncError: 'old',
  };

  it('saves a task with PUT to its own id, without the local-only fields', async () => {
    handler = (_q, body, res) => json(res, 200, { ...JSON.parse(body.toString()), id: 't1' });
    const saved = await client().putTask(t);
    expect(seen[0]).toMatchObject({ method: 'PUT', url: '/api/tasks/t1' });
    const sent = JSON.parse(seen[0].body.toString());
    expect(sent).not.toHaveProperty('id');
    expect(sent).not.toHaveProperty('syncError');
    expect(saved.title).toBe('Feed the frog');
  });

  it('reports a deleted task as gone (410)', async () => {
    handler = (_q, _b, res) => problem(res, 410, 'This was deleted.');
    await expect(client().putTask(t)).rejects.toMatchObject({ kind: 'gone' });
  });

  it('sends the command with the time zone', async () => {
    handler = (_q, _b, res) => json(res, 200, { intent: 'unknown', available: true, task: null, reminder: null, question: null, problem: null });
    await client().interpret('sing', 'Europe/London');
    expect(JSON.parse(seen[0].body.toString())).toEqual({ text: 'sing', timeZone: 'Europe/London' });
  });

  it('sends the recording as the raw body with its media type', async () => {
    handler = (_q, _b, res) => json(res, 200, { text: 'remind me' });
    const text = await client().transcribe(new Uint8Array([1, 2, 3]), 'audio/webm');
    expect(text).toBe('remind me');
    expect(seen[0].headers['content-type']).toBe('audio/webm');
    expect([...seen[0].body]).toEqual([1, 2, 3]);
  });

  it('says plainly when speech-to-text is down', async () => {
    handler = (_q, _b, res) => problem(res, 503, "Speech-to-text isn't available, so SMOI can't hear you right now. You can type instead.");
    await expect(client().transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toMatchObject({
      kind: 'unavailable', message: expect.stringContaining('You can type instead'),
    });
  });
});
