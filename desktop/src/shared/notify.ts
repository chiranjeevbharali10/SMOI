/**
 * Which notifications SMOI shows, and when (FR-08.04 to FR-08.06).
 *
 * - Each category can be turned off, and has a priority. High priority is critical: it ignores
 *   quiet hours and the repeat cooldown (a reminder you set should always reach you).
 * - During quiet hours, other notifications are held and shown when quiet hours end.
 * - A non-critical notification with the same category and source as one shown within the
 *   cooldown (default 30 minutes) is dropped, so SMOI doesn't repeat itself.
 * - Each is shown as a speech bubble or as a native Windows notification, as the user chooses.
 *
 * Pure (the caller passes the time and the local minute of the day); tested in test/notify.test.ts.
 */

export type Category = 'reminders' | 'overdue' | 'indexing' | 'claudeDone' | 'claudeWaiting' | 'email';
export type Level = 'low' | 'normal' | 'high';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'reminders', label: 'Reminders' },
  { id: 'overdue', label: 'Overdue tasks' },
  { id: 'indexing', label: 'Documents finished indexing' },
  { id: 'email', label: 'Important email arrived' },
  { id: 'claudeDone', label: 'Claude Code finished a long run' },
  { id: 'claudeWaiting', label: 'Claude Code is waiting for permission' },
];

export interface NotificationSettings {
  channel: 'bubble' | 'native';
  categories: Record<Category, { enabled: boolean; priority: Level }>;
  quietHours: { enabled: boolean; start: string; end: string };
  cooldownMinutes: number;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  channel: 'bubble',
  categories: {
    reminders: { enabled: true, priority: 'high' },
    overdue: { enabled: true, priority: 'normal' },
    indexing: { enabled: true, priority: 'low' },
    email: { enabled: true, priority: 'normal' },
    claudeDone: { enabled: true, priority: 'normal' },
    claudeWaiting: { enabled: true, priority: 'normal' },
  },
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  cooldownMinutes: 30,
};

export interface Notice {
  category: Category;
  /** What it is about (a reminder occurrence, "overdue"), for the cooldown. */
  source: string;
}

export type Decision = 'show' | 'hold' | 'drop';

/** "22:00" -> 1320; null if malformed. */
export function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Quiet hours may run past midnight (22:00 to 07:00). Equal start and end means none. */
export function inQuietHours(q: NotificationSettings['quietHours'], minuteOfDay: number): boolean {
  if (!q.enabled) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}

export const cooldownKey = (n: Notice) => `${n.category}:${n.source}`;

/**
 * @param lastShown when each category+source was last shown (ms), from cooldownKey
 */
export function decide(n: Notice, s: NotificationSettings, lastShown: Record<string, number>, now: number,
  minuteOfDay: number): Decision {
  const c = s.categories[n.category];
  if (!c?.enabled) return 'drop';
  if (c.priority === 'high') return 'show';
  if (inQuietHours(s.quietHours, minuteOfDay)) return 'hold';
  const last = lastShown[cooldownKey(n)];
  if (last !== undefined && now - last < s.cooldownMinutes * 60_000) return 'drop';
  return 'show';
}

/** Validates settings from the dashboard; anything malformed keeps the current value. */
export function mergeNotificationSettings(current: NotificationSettings, patch: unknown): NotificationSettings {
  const p = patch as Partial<NotificationSettings>;
  if (!p || typeof p !== 'object') return current;
  const next: NotificationSettings = structuredClone(current);
  if (p.channel === 'bubble' || p.channel === 'native') next.channel = p.channel;
  if (p.categories && typeof p.categories === 'object') {
    for (const { id } of CATEGORIES) {
      const c = (p.categories as Record<string, { enabled?: unknown; priority?: unknown }>)[id];
      if (!c) continue;
      if (typeof c.enabled === 'boolean') next.categories[id].enabled = c.enabled;
      if (c.priority === 'low' || c.priority === 'normal' || c.priority === 'high') next.categories[id].priority = c.priority;
    }
  }
  if (p.quietHours && typeof p.quietHours === 'object') {
    const q = p.quietHours;
    if (typeof q.enabled === 'boolean') next.quietHours.enabled = q.enabled;
    if (typeof q.start === 'string' && minutesOf(q.start) !== null) next.quietHours.start = q.start;
    if (typeof q.end === 'string' && minutesOf(q.end) !== null) next.quietHours.end = q.end;
  }
  const cd = p.cooldownMinutes;
  if (typeof cd === 'number' && Number.isInteger(cd) && cd >= 1 && cd <= 1440) next.cooldownMinutes = cd;
  return next;
}
