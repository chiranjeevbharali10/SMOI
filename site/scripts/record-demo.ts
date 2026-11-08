/**
 * Records the real answer that the launch page's "Ask your files anything" scene plays back.
 *
 * It talks to a running SMOI backend over HTTP, like the desktop app does:
 *   1. registers a throwaway account;
 *   2. uploads the frog documents from the evaluation corpus (eval/corpus/docs/frogs, CC BY-SA,
 *      see eval/corpus/SOURCES.md) and waits until they are indexed;
 *   3. asks the question through POST /api/query/stream and keeps every event as it arrived,
 *      parsed with the desktop's own SSE parser;
 *   4. saves the text of the cited passages for the page's source previews;
 *   5. deletes the uploaded documents.
 *
 * Nothing is edited by hand: the page replays exactly what the backend sent.
 *
 *   docker compose up        # from the repo root, with the default local model
 *   cd site && npm run record-demo [-- --api http://localhost:8080] [-- --question "..."]
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SseParser } from '../../desktop/src/shared/sse';
import type { AnswerResult, StreamEvent } from '../../desktop/src/shared/apiTypes';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const API = flag('api', 'http://localhost:8080').replace(/\/$/, '');
const QUESTION = flag('question', 'Where does the natterjack toad live?');
const root = resolve(import.meta.dirname, '../..');
const corpus = join(root, 'eval/corpus/docs/frogs');
const out = join(root, 'site/src/data/brain-demo.json');

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function main() {
  // A throwaway account with a random password that is never printed or saved.
  const email = `record-demo-${randomBytes(4).toString('hex')}@smoi.local`;
  const password = randomBytes(18).toString('base64url');
  await call('/api/auth/register', json({ email, password }));
  const { accessToken: token } = await call<{ accessToken: string }>('/api/auth/login', json({ email, password }));

  const ids: string[] = [];
  try {
    for (const name of readdirSync(corpus)) {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(join(corpus, name))]), name);
      const doc = await call<{ id: string }>('/api/documents', { method: 'POST', body: form, token });
      ids.push(doc.id);
    }
    console.log(`Uploaded ${ids.length} documents; waiting for indexing…`);
    for (let waited = 0; ; waited += 2) {
      const docs = await call<{ id: string; status: string; error?: string }[]>('/api/documents', { token });
      const mine = docs.filter((d) => ids.includes(d.id));
      const failed = mine.filter((d) => d.status === 'failed');
      if (failed.length) throw new Error(`Indexing failed: ${failed.map((d) => d.error).join('; ')}`);
      if (mine.every((d) => d.status === 'indexed')) break;
      if (waited > 600) throw new Error('Indexing took longer than 10 minutes');
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log(`Asking: ${QUESTION}`);
    const res = await fetch(`${API}/api/query/stream`, {
      ...json({ question: QUESTION, mode: 'hybrid' }),
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.body) throw new Error(`query/stream: HTTP ${res.status}`);
    const events: StreamEvent[] = [];
    const parser = new SseParser();
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      for (const m of parser.push(decoder.decode(chunk as Uint8Array, { stream: true }))) {
        const data = JSON.parse(m.data);
        if (m.event === 'sources') events.push({ type: 'sources', sources: data });
        else if (m.event === 'delta') events.push({ type: 'delta', text: data.text });
        else if (m.event === 'result') events.push({ type: 'result', result: data as AnswerResult });
        else if (m.event === 'error') throw new Error(`The backend sent an error: ${m.data}`);
      }
    }
    const result = events.find((e): e is Extract<StreamEvent, { type: 'result' }> => e.type === 'result')?.result;
    if (!result) throw new Error('The stream ended without a result');
    if (result.outcome !== 'answered') throw new Error(`Outcome was ${result.outcome}, not answered; not saving it`);

    const passages: Record<string, string> = {};
    for (const c of result.citations ?? []) {
      const chunks = await call<{ id: string; content: string }[]>(`/api/documents/${c.documentId}/chunks`, { token });
      const found = chunks.find((x) => x.id === c.chunkId);
      if (found) passages[c.chunkId] = found.content;
    }

    writeFileSync(out, `${JSON.stringify({
      recorded: true,
      script: 'site/scripts/record-demo.ts',
      recordedAt: new Date().toISOString(),
      question: QUESTION,
      provider: result.provider,
      model: result.model,
      events,
      passages,
    }, null, 2)}\n`);
    console.log(`Saved ${events.length} events and ${Object.keys(passages).length} passages to ${out}`);
  } finally {
    for (const id of ids) await call(`/api/documents/${id}`, { method: 'DELETE', token }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
