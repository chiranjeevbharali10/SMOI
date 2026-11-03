import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/main/api';
import { TaskService } from '../src/main/tasks';
import type { ReminderItem, TaskItem } from '../src/shared/taskStore';

/**
 * The task service against a real HTTP server that can be switched off: changes made while the
 * backend is down are saved locally and sent once it's back (NFR-02.01, NFR-08.05), and reminders
 * fire from the local copy with no backend at all (NFR-02.05).
 */
let server: Server | null = null;
let port = 0;
let rows: Record<string, unknown> = {};
let requests: string[] = [];

async function startBackend() {
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      const id = req.url!.split('/').pop()!;
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'PUT') {
        rows[id] = { id, ...JSON.parse(Buffer.concat(parts).toString()), deletedAt: null };
        res.end(JSON.stringify(rows[id]));
      } else if (req.url === '/api/sync') {
        res.end(JSON.stringify({ tasks: Object.values(rows), reminders: [], serverTime: new Date().toISOString() }));
      } else {
        res.statusCode = 204;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
  port = (server!.address() as AddressInfo).port;
}

const stopBackend = () => new Promise<void>((r) => (server ? server.close(() => r()) : r()));

let dir: string;
let fired: { title: string; missed: boolean }[];
let service: TaskService;

const task = (id: string): TaskItem => ({
  id, title: `Task ${id}`, description: '', priority: 'normal', category: '', dueAt: null, completedAt: null,
  editedAt: new Date().toISOString(),
});

beforeEach(async () => {
  rows = {};
  requests = [];
  fired = [];
  port = 0;
  await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'smoi-tasks-'));
  const api = new ApiClient(() => `http://127.0.0.1:${port}`, { token: () => 'jwt', expired: () => {} });
  service = new TaskService({
    api, dataDir: dir, onChange: () => {}, onOverdue: () => {},
    onReminder: (r, missed) => fired.push({ title: r.title, missed }),
  });
});

afterEach(async () => {
  service.stop();
  await stopBackend();
});

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('offline changes', () => {
  it('are saved on disk at once and sent when the backend comes back', async () => {
    service.start('owner@example.com');
    await settle();
    await stopBackend();

    service.saveTask(task('a'));
    await settle();
    expect(service.store.outbox).toHaveLength(1);
    const file = readdirSync(join(dir, 'tasks'))[0];
    expect(JSON.parse(readFileSync(join(dir, 'tasks', file), 'utf8')).tasks.a.title).toBe('Task a');
    expect(file).not.toContain('owner'); // the email isn't in the file name

    await startBackend();
    await service.sync();
    expect(service.store.outbox).toHaveLength(0);
    expect(rows.a).toMatchObject({ title: 'Task a' });
    expect(requests).toContain('PUT /api/tasks/a');
  });

  it('survive a restart: a new service on the same folder still has them queued', async () => {
    service.start('owner@example.com');
    await settle();
    await stopBackend();
    service.saveTask(task('b'));
    await settle();
    service.stop();

    const again = new TaskService({
      api: new ApiClient(() => `http://127.0.0.1:${port}`, { token: () => 'jwt', expired: () => {} }),
      dataDir: dir, onChange: () => {}, onOverdue: () => {}, onReminder: () => {},
    });
    again.start('owner@example.com');
    expect(again.store.tasks.b.title).toBe('Task b');
    expect(again.store.outbox).toEqual([{ kind: 'task', id: 'b', op: 'put' }]);
    again.stop();
  });
});

describe('reminders', () => {
  it('fire from the local copy with the backend down, once', async () => {
    await stopBackend();
    service.start('owner@example.com');
    const now = Date.now();
    const r: ReminderItem = {
      id: 'r1', taskId: null, title: 'Feed the frog', firstAt: new Date(now - 10_000).toISOString(), repeat: 'none',
      weekdays: 0, timeZone: 'Europe/London', lastFiredAt: null, editedAt: new Date(now - 20_000).toISOString(),
    };
    service.saveReminder(r);
    service.checkReminders(now);
    service.checkReminders(now + 15_000);
    expect(fired).toEqual([{ title: 'Feed the frog', missed: false }]);
    expect(service.store.reminders.r1.lastFiredAt).toBe(r.firstAt);
  });

  it('one that came due while SMOI was off fires once, as missed', () => {
    service.start('owner@example.com');
    const now = Date.now();
    service.saveReminder({
      id: 'r2', taskId: null, title: 'Old one', firstAt: new Date(now - 3_600_000).toISOString(), repeat: 'none',
      weekdays: 0, timeZone: 'Europe/London', lastFiredAt: null, editedAt: new Date(now).toISOString(),
    });
    service.checkReminders(now);
    expect(fired).toEqual([{ title: 'Old one', missed: true }]);
  });
});
