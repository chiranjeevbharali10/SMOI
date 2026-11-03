/**
 * When a reminder fires (FR-02.03): once, daily, weekly, monthly, or on chosen weekdays, always
 * at the same local time of day in the reminder's IANA time zone, so "every day at 9:00" stays at
 * 9:00 across daylight-saving changes.
 *
 * The rule, kept simple enough to check by hand:
 * - the first occurrence is `firstAt`; its local date is day F and its local time is T;
 * - a local date D (D >= F) is an occurrence date if:
 *     daily: always; weekly: D is a whole number of weeks after F;
 *     monthly: D's day of month is F's, or the month's last day if the month is shorter;
 *     weekdays: D's weekday is in the reminder's set;
 * - each occurrence is at local time T on its date. If T doesn't exist that day (the clocks
 *   skip it), it fires at the same wall-clock offset as just before the change.
 *
 * Time zones use the platform's Intl data, so there is no date library to explain.
 * Pure and clock-free; tested in test/recurrence.test.ts.
 */

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'weekdays';

export interface Schedule {
  /** ISO instant of the first occurrence. */
  firstAt: string;
  repeat: Repeat;
  /** For 'weekdays': bit n-1 for ISO day n (Monday = 1 ... Sunday = 64). */
  weekdays: number;
  timeZone: string;
}

const DAY_MS = 86_400_000;
/** Far enough to cross any month (monthly) or week (weekdays) gap. */
const SEARCH_DAYS = 64;

export const WEEKDAY_BITS = { mon: 1, tue: 2, wed: 4, thu: 8, fri: 16, sat: 32, sun: 64 } as const;

interface Wall {
  /** Days since 1970-01-01 of the local date. */
  day: number;
  /** Minutes since local midnight. */
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True if the platform knows this IANA time zone. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The local wall-clock time at `ms`, as milliseconds since 1970 if that wall time were UTC. */
function wallMs(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function wall(ms: number, timeZone: string): Wall {
  const w = wallMs(ms, timeZone);
  const day = Math.floor(w / DAY_MS);
  return { day, minute: Math.round((w - day * DAY_MS) / 60_000) };
}

/** The instant when the local clock in `timeZone` shows `minute` on `day`. */
export function instantOf(day: number, minute: number, timeZone: string): number {
  const target = day * DAY_MS + minute * 60_000;
  // Guess with the offset at the target, then correct once with the offset at the guess.
  let guess = target - (wallMs(target, timeZone) - target);
  guess = target - (wallMs(guess, timeZone) - guess);
  return guess;
}

/** ISO weekday (Monday = 1 ... Sunday = 7) of a day number. 1970-01-01 was a Thursday. */
function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

function civil(day: number): { y: number; m: number; d: number } {
  const date = new Date(day * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function isOccurrenceDay(s: Schedule, first: Wall, day: number): boolean {
  if (day < first.day) return false;
  switch (s.repeat) {
    case 'none':
      return day === first.day;
    case 'daily':
      return true;
    case 'weekly':
      return (day - first.day) % 7 === 0;
    case 'monthly': {
      const f = civil(first.day);
      const c = civil(day);
      return c.d === Math.min(f.d, daysInMonth(c.y, c.m));
    }
    case 'weekdays':
      return (s.weekdays & (1 << (isoWeekday(day) - 1))) !== 0;
  }
}

/** The latest occurrence at or before `now`, or null if there is none yet. */
export function latestOccurrence(s: Schedule, now: number): number | null {
  const firstMs = Date.parse(s.firstAt);
  if (!Number.isFinite(firstMs) || now < firstMs) return null;
  if (s.repeat === 'none') return firstMs;
  const first = wall(firstMs, s.timeZone);
  const today = wall(now, s.timeZone).day;
  for (let day = today; day >= Math.max(first.day, today - SEARCH_DAYS); day--) {
    if (!isOccurrenceDay(s, first, day)) continue;
    const at = instantOf(day, first.minute, s.timeZone);
    if (at <= now) return at;
  }
  return null;
}

/** The first occurrence after `now`, or null if there will be none. */
export function nextOccurrence(s: Schedule, now: number): number | null {
  const firstMs = Date.parse(s.firstAt);
  if (!Number.isFinite(firstMs)) return null;
  if (now < firstMs) return firstMs;
  if (s.repeat === 'none') return null;
  const first = wall(firstMs, s.timeZone);
  const today = wall(now, s.timeZone).day;
  for (let day = today; day <= today + SEARCH_DAYS; day++) {
    if (!isOccurrenceDay(s, first, day)) continue;
    const at = instantOf(day, first.minute, s.timeZone);
    if (at > now) return at;
  }
  return null;
}

/**
 * The occurrence that should fire now, if any: the latest one at or before `now` that is later
 * than the last one shown. Only the latest counts, so after a week switched off a daily reminder
 * fires once, not seven times.
 */
export function dueOccurrence(s: Schedule & { lastFiredAt: string | null }, now: number): number | null {
  const latest = latestOccurrence(s, now);
  if (latest === null) return null;
  const last = s.lastFiredAt ? Date.parse(s.lastFiredAt) : null;
  return last !== null && Number.isFinite(last) && latest <= last ? null : latest;
}
