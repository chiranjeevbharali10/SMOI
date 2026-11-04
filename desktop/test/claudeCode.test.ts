import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCode, hookPort } from '../src/main/claudeCode';
import { SECRET_HEADER } from '../src/main/claudeHooks';

const SECRET = 'test-secret-not-real-0123456789';

function send(port: number, route: string, hook: string, session: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/claude/${route}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: SECRET } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ session_id: session, hook_event_name: hook }));
  });
}

/** Starts the feature on a free port and waits until it listens. */
async function started(deps: Partial<Parameters<ClaudeCode['start']>[0]> = {}) {
  const notify = vi.fn();
  const claude = new ClaudeCode();
  const ready = new Promise<void>((resolve) => {
    claude.start({ enabled: () => true, celebrateAfterMinutes: () => 3, notify, onStatus: () => resolve(), ...deps },
      // A random high port; a clash only fails this test run.
      { SMOI_HOOK_SECRET: SECRET, SMOI_HOOK_PORT: String(40000 + Math.floor(Math.random() * 20000)) });
  });
  await ready;
  return { claude, notify, port: claude.status.port };
}

describe('Claude Code notifications, end to end through the listener', () => {
  let claude: ClaudeCode | undefined;
  afterEach(async () => {
    await claude?.stop();
    vi.useRealTimers();
  });

  it('sends a long run to the notifier as claudeDone, with its minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await started();
    claude = s.claude;
    vi.setSystemTime(0);
    await send(s.port, 'start', 'UserPromptSubmit', 'run-1');
    vi.setSystemTime(4 * 60_000);
    await send(s.port, 'done', 'Stop', 'run-1');
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenCalledWith('claudeDone', 'run-1@0', { type: 'claude_done', minutes: 4 });
  });

  it('sends waiting to the notifier as claudeWaiting, once for a repeat', async () => {
    const s = await started();
    claude = s.claude;
    await send(s.port, 'waiting', 'Notification', 'run-2');
    await send(s.port, 'waiting', 'Notification', 'run-2');
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0][0]).toBe('claudeWaiting');
    expect(s.notify.mock.calls[0][2]).toEqual({ type: 'claude_waiting' });
  });

  it('ignores events while turned off in settings', async () => {
    const s = await started({ enabled: () => false });
    claude = s.claude;
    expect(await send(s.port, 'waiting', 'Notification', 'run-3')).toBe(204);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it('does not listen without a long enough secret', () => {
    const c = new ClaudeCode();
    c.start({ enabled: () => true, celebrateAfterMinutes: () => 3, notify: vi.fn(), onStatus: vi.fn() }, { SMOI_HOOK_SECRET: 'short' });
    expect(c.status.listening).toBe(false);
    expect(c.status.problem).toMatch(/SMOI_HOOK_SECRET/);
  });

  it('uses the default port unless a valid one is set', () => {
    expect(hookPort({})).toBe(47821);
    expect(hookPort({ SMOI_HOOK_PORT: '50000' })).toBe(50000);
    expect(hookPort({ SMOI_HOOK_PORT: '80' })).toBe(47821);
    expect(hookPort({ SMOI_HOOK_PORT: 'abc' })).toBe(47821);
  });
});
