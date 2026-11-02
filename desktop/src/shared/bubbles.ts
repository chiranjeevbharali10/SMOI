import type { BubbleLine } from './panelActions';

/**
 * Which speech bubble is showing, and when it goes away.
 *
 * - Blue (nudge) and lavender (finding) bubbles fade on their own: 4 seconds, plus reading time
 *   for long lines (70 ms per character beyond the first 35 or so).
 * - Pink (urgent) bubbles stay until the user dismisses them with the x button.
 * - One bubble shows at a time:
 *   - a new blue or lavender bubble replaces a blue or lavender one;
 *   - while a pink one is up, new blue and lavender bubbles are dropped, since a passing remark
 *     must not cover something time-sensitive;
 *   - a new pink bubble replaces a blue or lavender one, and waits behind a pink one, so nothing
 *     time-sensitive is ever lost. Each pink bubble shows in turn as the previous is dismissed.
 *
 * Pure and clock-free (callers pass `now`), so the rules are unit-tested.
 */
export interface Bubble extends BubbleLine {
  id: number;
  /** When it fades, or null for "until dismissed". */
  expiresAt: number | null;
}

export function fadeAfterMs(text: string): number {
  return Math.max(4000, 1500 + 70 * text.length);
}

export class BubbleController {
  private shown: Bubble | null = null;
  private waiting: BubbleLine[] = [];
  private nextId = 1;
  private listeners: ((b: Bubble | null) => void)[] = [];

  get current(): Bubble | null {
    return this.shown;
  }

  /** Pink bubbles waiting behind the one showing. */
  get queued(): readonly BubbleLine[] {
    return this.waiting;
  }

  onChange(listener: (b: Bubble | null) => void): void {
    this.listeners.push(listener);
  }

  /** Asks to show a line. Returns false if it was dropped. */
  show(line: BubbleLine, now: number): boolean {
    if (this.shown?.tone === 'urgent') {
      if (line.tone !== 'urgent') return false;
      const duplicate = this.shown.text === line.text || this.waiting.some((w) => w.text === line.text);
      if (!duplicate) this.waiting.push(line);
      return !duplicate;
    }
    this.display(line, now);
    return true;
  }

  /**
   * The user pressed x. Only the bubble with this id is dismissed, so a late click can't
   * dismiss a newer bubble by accident.
   */
  dismiss(id: number, now: number): void {
    if (this.shown?.id !== id) return;
    const next = this.waiting.shift();
    if (next) this.display(next, now);
    else this.set(null);
  }

  /** Removes a fading bubble early (for example when the frog is hidden). Pink bubbles stay. */
  clearFading(): void {
    if (this.shown && this.shown.tone !== 'urgent') this.set(null);
  }

  /** Fades expired bubbles. Call on a timer. */
  tick(now: number): void {
    if (this.shown?.expiresAt != null && now >= this.shown.expiresAt) this.set(null);
  }

  private display(line: BubbleLine, now: number) {
    const expiresAt = line.tone === 'urgent' ? null : now + fadeAfterMs(line.text);
    this.set({ ...line, id: this.nextId++, expiresAt });
  }

  private set(b: Bubble | null) {
    this.shown = b;
    this.listeners.forEach((l) => l(b));
  }
}
