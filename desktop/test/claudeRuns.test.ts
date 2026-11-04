import { describe, expect, it } from 'vitest';
import { ClaudeRuns, STALE_MS, WAITING_REPEAT_MS } from '../src/shared/claudeRuns';

const MIN = 60_000;
const runs = (minutes = 3) => new ClaudeRuns(() => minutes * MIN);

describe('Claude Code runs', () => {
  it('stays quiet for a run shorter than the threshold', () => {
    const r = runs();
    expect(r.handle('start', 's1', 0)).toBeNull();
    expect(r.handle('done', 's1', 3 * MIN - 1)).toBeNull();
  });

  it('celebrates a run at or above the threshold, with its duration', () => {
    const r = runs();
    r.handle('start', 's1', 1000);
    expect(r.handle('done', 's1', 1000 + 12 * MIN + 30_000)).toEqual({ type: 'celebrate', sessionId: 's1', minutes: 12, source: 's1@1000' });
    const edge = runs();
    edge.handle('start', 's2', 0);
    expect(edge.handle('done', 's2', 3 * MIN)?.type).toBe('celebrate');
  });

  it('uses the threshold in force when the run ends', () => {
    let minutes = 10;
    const r = new ClaudeRuns(() => minutes * MIN);
    r.handle('start', 's1', 0);
    minutes = 1;
    expect(r.handle('done', 's1', 2 * MIN)?.type).toBe('celebrate');
  });

  it('says nothing for a done with no start', () => {
    expect(runs().handle('done', 'never-started', 10 * MIN)).toBeNull();
  });

  it('ignores a duplicate done', () => {
    const r = runs();
    r.handle('start', 's1', 0);
    expect(r.handle('done', 's1', 5 * MIN)?.type).toBe('celebrate');
    expect(r.handle('done', 's1', 5 * MIN + 10)).toBeNull();
  });

  it('keeps the first start when start repeats', () => {
    const r = runs();
    r.handle('start', 's1', 0);
    r.handle('start', 's1', 2 * MIN);
    expect(r.handle('done', 's1', 4 * MIN)).toMatchObject({ minutes: 4 });
  });

  it('tracks parallel sessions independently', () => {
    const r = runs();
    r.handle('start', 'a', 0);
    r.handle('start', 'b', 1 * MIN);
    expect(r.open).toBe(2);
    expect(r.handle('done', 'b', 2 * MIN)).toBeNull(); // b ran 1 minute
    expect(r.handle('done', 'a', 5 * MIN)).toMatchObject({ sessionId: 'a', minutes: 5 });
    expect(r.open).toBe(0);
  });

  it('alerts on waiting, even with no start, and collapses repeats', () => {
    const r = runs();
    expect(r.handle('waiting', 's1', 0)).toEqual({ type: 'waiting', sessionId: 's1', source: 's1@0' });
    expect(r.handle('waiting', 's1', WAITING_REPEAT_MS - 1)).toBeNull();
    expect(r.handle('waiting', 's1', WAITING_REPEAT_MS)?.type).toBe('waiting');
  });

  it('alerts on waiting for each parallel session', () => {
    const r = runs();
    expect(r.handle('waiting', 'a', 0)?.type).toBe('waiting');
    expect(r.handle('waiting', 'b', 10)?.type).toBe('waiting');
  });

  it('a waiting alert does not end the run', () => {
    const r = runs();
    r.handle('start', 's1', 0);
    r.handle('waiting', 's1', 1 * MIN);
    expect(r.handle('done', 's1', 6 * MIN)).toMatchObject({ minutes: 6 });
  });

  it('forgets runs that never finish, without an alert', () => {
    const r = runs();
    r.handle('start', 'lost', 0);
    expect(r.open).toBe(1);
    r.handle('start', 'other', STALE_MS + 1);
    expect(r.open).toBe(1);
    expect(r.handle('done', 'lost', STALE_MS + 2)).toBeNull();
  });
});
