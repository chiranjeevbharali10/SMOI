/**
 * Claude Code runs, as seen through its hooks (FR-10.02 to FR-10.05).
 *
 * Claude Code calls SMOI on three hooks:
 *   - UserPromptSubmit -> start: a run begins;
 *   - Stop             -> done: the run finished, so SMOI may celebrate if it was long;
 *   - Notification (permission_prompt) -> waiting: the run is blocked until the user answers.
 *
 * Rules:
 * - Runs are keyed by session_id, so parallel sessions never interfere.
 * - A repeated start while a run is open keeps the first start time (hooks can be retried).
 * - done closes the run. A duplicate done, or a done with no start (SMOI was closed when the run
 *   began), finds no run and says nothing: SMOI can't know how long it took.
 * - waiting always alerts, but at most once per session per WAITING_REPEAT_MS, so a retried hook
 *   doesn't alert twice while a later permission prompt still does.
 * - A run with no done for STALE_MS (the session was closed, or SMOI missed the Stop) is
 *   forgotten without an alert.
 *
 * Pure and clock-free (callers pass `now`), so the rules are unit-tested in test/claudeRuns.test.ts.
 */
export type HookEvent = 'start' | 'done' | 'waiting';

export type Alert =
  | { type: 'celebrate'; sessionId: string; minutes: number; source: string }
  | { type: 'waiting'; sessionId: string; source: string };

export const WAITING_REPEAT_MS = 60_000;
export const STALE_MS = 6 * 60 * 60_000;

interface Run {
  startedAt: number | null;
  lastWaitingAlert: number | null;
  lastSeen: number;
}

export class ClaudeRuns {
  private readonly runs = new Map<string, Run>();

  /** @param celebrateAfterMs the shortest run that earns a celebration (FR-10.03) */
  constructor(private readonly celebrateAfterMs: () => number) {}

  /** Open runs, for tests and the tray. */
  get open(): number {
    return [...this.runs.values()].filter((r) => r.startedAt !== null).length;
  }

  handle(event: HookEvent, sessionId: string, now: number): Alert | null {
    this.expire(now);
    const run = this.runs.get(sessionId);
    switch (event) {
      case 'start': {
        if (run && run.startedAt !== null) {
          run.lastSeen = now;
          return null;
        }
        this.runs.set(sessionId, { startedAt: now, lastWaitingAlert: run?.lastWaitingAlert ?? null, lastSeen: now });
        return null;
      }
      case 'done': {
        if (!run || run.startedAt === null) return null;
        const startedAt = run.startedAt;
        // Keep the entry (without a start) so a waiting alert's repeat window survives the done.
        run.startedAt = null;
        run.lastSeen = now;
        const ms = now - startedAt;
        if (ms < this.celebrateAfterMs()) return null;
        return { type: 'celebrate', sessionId, minutes: Math.floor(ms / 60_000), source: `${sessionId}@${startedAt}` };
      }
      case 'waiting': {
        const r = run ?? { startedAt: null, lastWaitingAlert: null, lastSeen: now };
        this.runs.set(sessionId, r);
        r.lastSeen = now;
        if (r.lastWaitingAlert !== null && now - r.lastWaitingAlert < WAITING_REPEAT_MS) return null;
        r.lastWaitingAlert = now;
        return { type: 'waiting', sessionId, source: `${sessionId}@${now}` };
      }
    }
  }

  private expire(now: number): void {
    for (const [id, r] of this.runs) if (now - r.lastSeen > STALE_MS) this.runs.delete(id);
  }
}
