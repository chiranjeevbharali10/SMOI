import { describe, expect, it } from 'vitest';
import { FrogStateMachine, REACTION_MS } from '../src/shared/stateMachine';
import { frameAt, totalDuration } from '../src/shared/animations';
import { frogSize, windowSize } from '../src/shared/scaling';

describe('FrogStateMachine', () => {
  it('is idle by default', () => {
    expect(new FrogStateMachine().state).toBe('idle');
  });

  it('shows the highest-priority active condition', () => {
    const m = new FrogStateMachine();
    m.set('working', true, 0);
    expect(m.state).toBe('working');
    m.set('thinking', true, 0);
    expect(m.state).toBe('thinking');
    m.set('error', true, 0);
    expect(m.state).toBe('error');
    m.set('error', false, 0);
    expect(m.state).toBe('thinking');
    m.set('thinking', false, 0);
    expect(m.state).toBe('working');
  });

  it('surprised plays once, then returns to the previous state', () => {
    const m = new FrogStateMachine();
    m.set('working', true, 0);
    m.react('surprised', 100);
    expect(m.state).toBe('surprised');
    m.tick(10_000); // surprised has no timer: it ends when its animation finishes
    expect(m.state).toBe('surprised');
    m.animationFinished('surprised', 10_100);
    expect(m.state).toBe('working');
  });

  it('surprised returns to idle when nothing else is active', () => {
    const m = new FrogStateMachine();
    m.react('surprised', 0);
    m.animationFinished('surprised', totalDuration('surprised'));
    expect(m.state).toBe('idle');
  });

  it('a lower-priority reaction does not interrupt a higher condition, and is gone once it expires', () => {
    const m = new FrogStateMachine();
    m.set('speaking', true, 0);
    m.react('happy', 0);
    expect(m.state).toBe('speaking');
    m.set('speaking', false, 1000);
    expect(m.state).toBe('happy'); // still within its time
    m.tick(REACTION_MS.happy + 1);
    expect(m.state).toBe('idle');
  });

  it('timed reactions expire on tick', () => {
    const m = new FrogStateMachine();
    m.set('sleeping', true, 0);
    m.react('celebrating', 0, 1000);
    expect(m.state).toBe('celebrating');
    m.tick(999);
    expect(m.state).toBe('celebrating');
    m.tick(1000);
    expect(m.state).toBe('sleeping');
  });

  it('error interrupts everything, including surprised', () => {
    const m = new FrogStateMachine();
    m.react('surprised', 0);
    m.set('error', true, 10);
    expect(m.state).toBe('error');
  });

  it('notifies listeners only on change', () => {
    const m = new FrogStateMachine();
    const seen: string[] = [];
    m.onChange((s) => seen.push(s));
    m.set('working', true, 0);
    m.set('working', true, 1);
    m.set('working', false, 2);
    expect(seen).toEqual(['working', 'idle']);
  });
});

describe('frameAt', () => {
  it('walks through frame durations and loops', () => {
    // idle: 180, 180, 220, ...
    expect(frameAt('idle', 0).index).toBe(0);
    expect(frameAt('idle', 179).index).toBe(0);
    expect(frameAt('idle', 180).index).toBe(1);
    expect(frameAt('idle', 360).index).toBe(2);
    expect(frameAt('idle', totalDuration('idle')).index).toBe(0);
  });

  it('a one-shot animation holds its last frame and reports finished', () => {
    const total = totalDuration('surprised');
    expect(frameAt('surprised', total - 1)).toEqual({ index: 5, finished: false });
    expect(frameAt('surprised', total + 5000)).toEqual({ index: 5, finished: true });
  });
});

describe('pixel-perfect scaling', () => {
  it('is 128 device pixels at 100%', () => {
    expect(frogSize(1)).toEqual({ multiple: 2, devicePixels: 128, cssPixels: 128 });
  });

  it('always covers a whole multiple of 64 device pixels at fractional scaling', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
      const size = frogSize(dpr);
      expect(size.devicePixels % 64).toBe(0);
      expect(size.cssPixels * dpr).toBeCloseTo(size.devicePixels, 9);
      expect(windowSize(dpr)).toBeGreaterThanOrEqual(size.cssPixels);
    }
    expect(frogSize(1.25).devicePixels).toBe(192);
    expect(frogSize(1.5).devicePixels).toBe(192);
  });
});

describe('Phase 6B state priority: error, then thinking or speaking, then working, then idle', () => {
  it('error beats thinking and speaking, which beat working, which beats idle', () => {
    const m = new FrogStateMachine();
    expect(m.state).toBe('idle');
    m.set('working', true, 0);
    expect(m.state).toBe('working');
    m.set('thinking', true, 0);
    expect(m.state).toBe('thinking');
    m.set('thinking', false, 0);
    m.set('speaking', true, 0);
    expect(m.state).toBe('speaking');
    m.set('error', true, 0);
    expect(m.state).toBe('error');
    m.set('error', false, 0);
    m.set('speaking', false, 0);
    expect(m.state).toBe('working');
  });

  it('thinking and error can be brief reactions that end on their own', () => {
    const m = new FrogStateMachine();
    m.react('thinking', 0);
    expect(m.state).toBe('thinking');
    m.tick(REACTION_MS.thinking);
    expect(m.state).toBe('idle');
    m.react('error', 0);
    m.tick(REACTION_MS.error - 1);
    expect(m.state).toBe('error');
    m.tick(REACTION_MS.error);
    expect(m.state).toBe('idle');
  });

  it('a thinking reaction ends, but a running query keeps SMOI thinking', () => {
    const m = new FrogStateMachine();
    m.react('thinking', 0);
    m.set('thinking', true, 100);
    m.tick(REACTION_MS.thinking);
    expect(m.state).toBe('thinking');
  });

  it('clearReactions returns to the lasting conditions', () => {
    const m = new FrogStateMachine();
    m.set('working', true, 0);
    m.react('happy', 0);
    expect(m.state).toBe('happy');
    m.clearReactions(1);
    expect(m.state).toBe('working');
  });
});

describe('waiting-for-you poses (Phase 8)', () => {
  it('mail and tasks last until cleared, mail outranks tasks, and both beat sleeping', () => {
    const m = new FrogStateMachine();
    m.set('sleeping', true, 0);
    m.set('tasks', true, 0);
    expect(m.state).toBe('tasks');
    m.set('mail', true, 0);
    expect(m.state).toBe('mail');
    m.tick(10 * 60_000);
    expect(m.state).toBe('mail');
    m.set('mail', false, 10 * 60_000);
    expect(m.state).toBe('tasks');
    m.set('tasks', false, 10 * 60_000);
    expect(m.state).toBe('sleeping');
  });

  it('an alert still interrupts them, then they come back', () => {
    const m = new FrogStateMachine();
    m.set('mail', true, 0);
    m.react('surprised', 0);
    expect(m.state).toBe('surprised');
    m.animationFinished('surprised', 900);
    expect(m.state).toBe('mail');
  });
});
