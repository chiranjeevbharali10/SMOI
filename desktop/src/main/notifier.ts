/**
 * Shows SMOI's notifications (FR-02.04, FR-08.03 to FR-08.06): asks src/shared/notify.ts whether
 * to show, hold or drop each one, picks the line from src/shared/personality.ts, and shows it as a
 * speech bubble or a native Windows notification. Held notifications (quiet hours) are shown when
 * quiet hours end, each once.
 */
import { Notification } from 'electron';
import { cooldownKey, decide, inQuietHours, type Category, type NotificationSettings } from '../shared/notify';
import { react, type CompanionEvent, type Personality } from '../shared/personality';
import type { BubbleLine, FrogReaction } from '../shared/panelActions';

export interface NotifierDeps {
  settings: () => NotificationSettings;
  personality: () => Personality;
  say: (line: BubbleLine) => void;
  react: (frog: FrogReaction) => void;
  icon: string;
}

interface Pending {
  category: Category;
  source: string;
  event: CompanionEvent;
}

const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

export class Notifier {
  private readonly lastShown: Record<string, number> = {};
  private held: Pending[] = [];
  private timer: NodeJS.Timeout;

  constructor(private readonly deps: NotifierDeps) {
    this.timer = setInterval(() => this.releaseHeld(new Date()), 60_000);
  }

  destroy(): void {
    clearInterval(this.timer);
  }

  notify(category: Category, source: string, event: CompanionEvent, now = new Date()): 'show' | 'hold' | 'drop' {
    const decision = decide({ category, source }, this.deps.settings(), this.lastShown, now.getTime(), minuteOfDay(now));
    if (decision === 'hold') {
      if (!this.held.some((h) => cooldownKey(h) === cooldownKey({ category, source }))) this.held.push({ category, source, event });
    } else if (decision === 'show') {
      this.show({ category, source, event }, now);
    }
    return decision;
  }

  private releaseHeld(now: Date): void {
    if (this.held.length === 0 || inQuietHours(this.deps.settings().quietHours, minuteOfDay(now))) return;
    const held = this.held;
    this.held = [];
    for (const h of held) this.notify(h.category, h.source, h.event, now);
  }

  private show(p: Pending, now: Date): void {
    const r = react(p.event, this.deps.personality());
    if (!r.line) return;
    this.lastShown[cooldownKey(p)] = now.getTime();
    if (this.deps.settings().channel === 'native' && Notification.isSupported()) {
      new Notification({ title: 'SMOI', body: r.line.text, icon: this.deps.icon, silent: false }).show();
    } else {
      this.deps.say(r.line);
    }
    if (r.frog !== 'idle') this.deps.react(r.frog);
  }
}
