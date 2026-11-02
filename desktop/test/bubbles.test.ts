import { describe, expect, it } from 'vitest';
import { BubbleController, fadeAfterMs } from '../src/shared/bubbles';

const blue = { tone: 'nudge' as const, text: 'Hi. What are we avoiding today?' };
const lavender = { tone: 'finding' as const, text: 'I found something interesting for you.' };
const pink = { tone: 'urgent' as const, text: "Psst. You've got somewhere to be." };
const pink2 = { tone: 'urgent' as const, text: 'Psst. Someone emailed you.' };

describe('bubble dismissal rules', () => {
  it('blue and lavender fade after a few seconds', () => {
    for (const line of [blue, lavender]) {
      const c = new BubbleController();
      c.show(line, 0);
      const ms = fadeAfterMs(line.text);
      expect(ms).toBeGreaterThanOrEqual(4000);
      c.tick(ms - 1);
      expect(c.current?.text).toBe(line.text);
      c.tick(ms);
      expect(c.current).toBeNull();
    }
  });

  it('long lines stay longer, so they can be read', () => {
    expect(fadeAfterMs('x'.repeat(100))).toBeGreaterThan(fadeAfterMs('short'));
  });

  it('pink stays until dismissed, however long', () => {
    const c = new BubbleController();
    c.show(pink, 0);
    c.tick(24 * 60 * 60 * 1000);
    expect(c.current?.text).toBe(pink.text);
    c.dismiss(c.current!.id, 1);
    expect(c.current).toBeNull();
  });

  it('a stale dismiss for an older bubble does nothing', () => {
    const c = new BubbleController();
    c.show(blue, 0);
    const old = c.current!.id;
    c.show(pink, 10);
    c.dismiss(old, 20);
    expect(c.current?.text).toBe(pink.text);
  });

  it('a new blue or lavender bubble replaces the current one and restarts the timer', () => {
    const c = new BubbleController();
    c.show(blue, 0);
    c.show(lavender, 3000);
    expect(c.current?.text).toBe(lavender.text);
    c.tick(3000 + fadeAfterMs(lavender.text) - 1);
    expect(c.current).not.toBeNull();
  });

  it('blue and lavender never cover a pink bubble', () => {
    const c = new BubbleController();
    c.show(pink, 0);
    expect(c.show(blue, 1)).toBe(false);
    expect(c.show(lavender, 2)).toBe(false);
    expect(c.current?.text).toBe(pink.text);
  });

  it('pink replaces blue, and further pink bubbles wait their turn', () => {
    const c = new BubbleController();
    c.show(blue, 0);
    c.show(pink, 1);
    expect(c.current?.text).toBe(pink.text);
    expect(c.show(pink2, 2)).toBe(true);
    expect(c.show(pink2, 3)).toBe(false); // not queued twice
    c.dismiss(c.current!.id, 4);
    expect(c.current?.text).toBe(pink2.text);
    expect(c.current?.expiresAt).toBeNull();
  });

  it('clearing fading bubbles leaves pink ones', () => {
    const c = new BubbleController();
    c.show(blue, 0);
    c.clearFading();
    expect(c.current).toBeNull();
    c.show(pink, 1);
    c.clearFading();
    expect(c.current?.text).toBe(pink.text);
  });

  it('notifies listeners on every change', () => {
    const c = new BubbleController();
    const seen: (string | null)[] = [];
    c.onChange((b) => seen.push(b?.text ?? null));
    c.show(blue, 0);
    c.tick(fadeAfterMs(blue.text));
    expect(seen).toEqual([blue.text, null]);
  });
});
