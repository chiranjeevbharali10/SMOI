/**
 * Claude Code notifications (FR-10): connects the hook listener (claudeHooks.ts) to the run
 * tracker (shared/claudeRuns.ts) and the notifier, which applies the category toggles, quiet hours
 * and cooldown (FR-08.04 to FR-08.06).
 *
 * The listener needs SMOI_HOOK_SECRET in the environment; SMOI_HOOK_PORT is optional. When the
 * feature is off in settings, the listener keeps running but events are ignored, so turning it
 * back on needs no restart.
 */
import { DEFAULT_PORT, HookListener } from './claudeHooks';
import { ClaudeRuns } from '../shared/claudeRuns';
import type { Category } from '../shared/notify';
import type { CompanionEvent } from '../shared/personality';

export interface ClaudeCodeDeps {
  enabled: () => boolean;
  celebrateAfterMinutes: () => number;
  notify: (category: Category, source: string, event: CompanionEvent) => unknown;
  onStatus: () => void;
}

export function hookPort(env: NodeJS.ProcessEnv = process.env): number {
  const p = Number(env.SMOI_HOOK_PORT);
  return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULT_PORT;
}

export class ClaudeCode {
  private listener: HookListener | null = null;
  status: { listening: boolean; port: number; problem: string | null } =
    { listening: false, port: hookPort(), problem: 'Not started yet.' };

  start(deps: ClaudeCodeDeps, env: NodeJS.ProcessEnv = process.env): void {
    const port = hookPort(env);
    const secret = env.SMOI_HOOK_SECRET ?? '';
    if (secret.length < 16) {
      this.status = { listening: false, port, problem: 'SMOI_HOOK_SECRET is not set (16 characters or more). See docs/claude-code-hooks.md.' };
      return;
    }
    const runs = new ClaudeRuns(() => deps.celebrateAfterMinutes() * 60_000);
    this.listener = new HookListener({
      secret, port,
      onEvent: (event, sessionId) => {
        if (!deps.enabled()) return;
        const alert = runs.handle(event, sessionId, Date.now());
        if (alert?.type === 'celebrate') deps.notify('claudeDone', alert.source, { type: 'claude_done', minutes: alert.minutes });
        if (alert?.type === 'waiting') deps.notify('claudeWaiting', alert.source, { type: 'claude_waiting' });
      },
      // Reasons only; bodies are never logged.
      onReject: (status, reason) => console.warn(`[claude hooks] rejected ${status}: ${reason}`),
    });
    this.listener.start().then(
      () => { this.status = { listening: true, port, problem: null }; deps.onStatus(); },
      (e: NodeJS.ErrnoException) => {
        this.status = { listening: false, port, problem: e.code === 'EADDRINUSE' ? `Port ${port} is in use. Set SMOI_HOOK_PORT to another port.` : 'The listener could not start.' };
        deps.onStatus();
      },
    );
  }

  async stop(): Promise<void> {
    await this.listener?.stop();
    this.listener = null;
  }
}
