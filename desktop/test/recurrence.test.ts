import { describe, expect, it } from 'vitest';
import { dueOccurrence, isTimeZone, latestOccurrence, nextOccurrence, WEEKDAY_BITS, type Schedule } from '../src/shared/recurrence';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const london = (over: Partial<Schedule>): Schedule => ({
  firstAt: '2026-11-02T09:00:00Z', repeat: 'none', weekdays: 0, timeZone: 'Europe/London', ...over,
});

describe('one-time reminders', () => {
  const s = london({ firstAt: '2026-11-05T17:30:00Z' });

  it('fires once, at its time', () => {
    expect(nextOccurrence(s, at('2026-11-05T17:00:00Z'))).toBe(at('2026-11-05T17:30:00Z'));
    expect(nextOccurrence(s, at('2026-11-05T17:30:00Z'))).toBeNull();
    expect(latestOccurrence(s, at('2026-11-05T17:29:59Z'))).toBeNull();
    expect(latestOccurrence(s, at('2026-12-01T00:00:00Z'))).toBe(at('2026-11-05T17:30:00Z'));
  });
});

describe('daily reminders', () => {
  const s = london({ repeat: 'daily' });

  it('repeat at the same local time', () => {
    expect(iso(nextOccurrence(s, at('2026-11-03T08:00:00Z')))).toBe('2026-11-03T09:00:00.000Z');
    expect(iso(nextOccurrence(s, at('2026-11-03T09:00:00Z')))).toBe('2026-11-04T09:00:00.000Z');
  });

  it('stay at 9:00 local time across the change to summer time', () => {
    // UK clocks go forward on 2027-03-28: 9:00 local is 09:00Z before and 08:00Z after.
    expect(iso(nextOccurrence(s, at('2027-03-27T10:00:00Z')))).toBe('2027-03-28T08:00:00.000Z');
  });
});

describe('weekly and monthly reminders', () => {
  it('weekly: the same weekday each week', () => {
    const s = london({ repeat: 'weekly' }); // Monday 2 Nov
    expect(iso(nextOccurrence(s, at('2026-11-03T00:00:00Z')))).toBe('2026-11-09T09:00:00.000Z');
  });

  it('monthly: the same day, or the last day of a shorter month', () => {
    const s = london({ firstAt: '2027-01-31T09:00:00Z', repeat: 'monthly' });
    expect(iso(nextOccurrence(s, at('2027-02-01T00:00:00Z')))).toBe('2027-02-28T09:00:00.000Z');
    expect(iso(nextOccurrence(s, at('2027-03-01T00:00:00Z')))).toBe('2027-03-31T08:00:00.000Z'); // BST
  });
});

describe('weekday reminders', () => {
  it('fire only on the chosen days', () => {
    const s = london({ repeat: 'weekdays', weekdays: WEEKDAY_BITS.wed | WEEKDAY_BITS.fri });
    expect(iso(nextOccurrence(s, at('2026-11-02T10:00:00Z')))).toBe('2026-11-04T09:00:00.000Z'); // Wed
    expect(iso(nextOccurrence(s, at('2026-11-04T10:00:00Z')))).toBe('2026-11-06T09:00:00.000Z'); // Fri
    expect(iso(nextOccurrence(s, at('2026-11-06T10:00:00Z')))).toBe('2026-11-11T09:00:00.000Z'); // next Wed
  });
});

describe('other time zones', () => {
  it('use that zone’s local time', () => {
    const s: Schedule = { firstAt: '2026-11-02T03:30:00Z', repeat: 'daily', weekdays: 0, timeZone: 'Asia/Kolkata' }; // 09:00 IST
    expect(iso(nextOccurrence(s, at('2026-11-05T00:00:00Z')))).toBe('2026-11-05T03:30:00.000Z');
  });

  it('knows which zones exist', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('which occurrence is due', () => {
  const s = { ...london({ repeat: 'daily' }), lastFiredAt: null as string | null };

  it('is the latest past occurrence not shown yet', () => {
    expect(iso(dueOccurrence(s, at('2026-11-03T09:00:30Z')))).toBe('2026-11-03T09:00:00.000Z');
  });

  it('is nothing once that occurrence has been shown', () => {
    expect(dueOccurrence({ ...s, lastFiredAt: '2026-11-03T09:00:00Z' }, at('2026-11-03T12:00:00Z'))).toBeNull();
  });

  it('is only the latest one after days switched off, not one per missed day', () => {
    expect(iso(dueOccurrence({ ...s, lastFiredAt: '2026-11-03T09:00:00Z' }, at('2026-11-09T12:00:00Z'))))
      .toBe('2026-11-09T09:00:00.000Z');
  });

  it('is nothing before the first occurrence', () => {
    expect(dueOccurrence(s, at('2026-11-01T00:00:00Z'))).toBeNull();
  });
});
