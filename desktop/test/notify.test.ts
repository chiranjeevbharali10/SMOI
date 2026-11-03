import { describe, expect, it } from 'vitest';
import {
  cooldownKey, decide, DEFAULT_NOTIFICATIONS, inQuietHours, mergeNotificationSettings, type NotificationSettings,
} from '../src/shared/notify';

const NOW = 1_000_000_000_000;
const NOON = 12 * 60;
const settings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...structuredClone(DEFAULT_NOTIFICATIONS), ...over });
const overdue = { category: 'overdue' as const, source: 'overdue' };
const reminder = { category: 'reminders' as const, source: 'r1@2026-11-03T09:00:00Z' };

describe('categories', () => {
  it('a turned-off category is dropped', () => {
    const s = settings();
    s.categories.overdue.enabled = false;
    expect(decide(overdue, s, {}, NOW, NOON)).toBe('drop');
  });
});

describe('quiet hours', () => {
  const quiet = settings({ quietHours: { enabled: true, start: '22:00', end: '07:00' } });

  it('run past midnight', () => {
    expect(inQuietHours(quiet.quietHours, 23 * 60)).toBe(true);
    expect(inQuietHours(quiet.quietHours, 6 * 60 + 59)).toBe(true);
    expect(inQuietHours(quiet.quietHours, 7 * 60)).toBe(false);
    expect(inQuietHours(quiet.quietHours, NOON)).toBe(false);
  });

  it('hold non-critical notifications', () => {
    expect(decide(overdue, quiet, {}, NOW, 23 * 60)).toBe('hold');
  });

  it('let high-priority (critical) ones through', () => {
    expect(decide(reminder, quiet, {}, NOW, 23 * 60)).toBe('show');
  });
});

describe('cooldown', () => {
  it('drops a repeat of the same category and source within the cooldown', () => {
    const shown = { [cooldownKey(overdue)]: NOW - 29 * 60_000 };
    expect(decide(overdue, settings(), shown, NOW, NOON)).toBe('drop');
  });

  it('allows it after the cooldown', () => {
    const shown = { [cooldownKey(overdue)]: NOW - 30 * 60_000 };
    expect(decide(overdue, settings(), shown, NOW, NOON)).toBe('show');
  });

  it('doesn’t apply to critical notifications', () => {
    const shown = { [cooldownKey(reminder)]: NOW - 1000 };
    expect(decide(reminder, settings(), shown, NOW, NOON)).toBe('show');
  });
});

describe('settings from the dashboard', () => {
  it('keep valid values and ignore bad ones', () => {
    const next = mergeNotificationSettings(DEFAULT_NOTIFICATIONS, {
      channel: 'native',
      categories: { overdue: { enabled: false, priority: 'urgent' } },
      quietHours: { enabled: true, start: '23:00', end: '25:00' },
      cooldownMinutes: 0,
    });
    expect(next.channel).toBe('native');
    expect(next.categories.overdue).toEqual({ enabled: false, priority: 'normal' });
    expect(next.quietHours).toEqual({ enabled: true, start: '23:00', end: '07:00' });
    expect(next.cooldownMinutes).toBe(30);
  });
});
