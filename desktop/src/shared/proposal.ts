/**
 * What SMOI shows before it acts on a command (FR-03.06), and the item it creates once the user
 * confirms. The backend only proposes; this module describes the proposal in plain words and,
 * after confirmation, turns it into an ordinary task or reminder, which goes through the same
 * store and API as one typed into the Tasks screen.
 *
 * Pure; tested in test/proposal.test.ts.
 */
import type { CalendarEvent, GooglePreview, Proposal } from './apiTypes';
import { latestOccurrence, type Repeat } from './recurrence';
import type { ReminderItem, TaskItem } from './taskStore';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Tue 4 Nov, 18:00" in the given zone. */
export function formatWhen(iso: string, timeZone: string, locale = 'en-GB'): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${date.replace(/,/g, '')}, ${time}`;
}

export function describeRepeat(repeat: Repeat, weekdays: number): string | null {
  switch (repeat) {
    case 'none': return null;
    case 'daily': return 'Repeats every day';
    case 'weekly': return 'Repeats every week';
    case 'monthly': return 'Repeats every month';
    case 'weekdays': return `Repeats on ${DAY_NAMES.filter((_, i) => weekdays & (1 << i)).join(', ')}`;
  }
}

export interface ProposalView {
  /** Whether there is something to confirm. */
  actionable: boolean;
  heading: string;
  details: string[];
  confirmLabel: string | null;
}

const NOT_YET: Record<string, string> = {};

export function describeProposal(p: Proposal, timeZone: string, locale = 'en-GB'): ProposalView {
  if (p.problem) return { actionable: false, heading: p.problem, details: [], confirmLabel: null };
  if (!p.available) {
    return { actionable: false, heading: `${NOT_YET[p.intent] ?? 'That'} isn't available yet.`, details: [], confirmLabel: null };
  }
  if (p.intent === 'create_task' && p.task) {
    const details = [`“${p.task.title}”`];
    if (p.task.dueAt) details.push(`Due ${formatWhen(p.task.dueAt, timeZone, locale)}`);
    if (p.task.priority !== 'normal') details.push(`${p.task.priority === 'high' ? 'High' : 'Low'} priority`);
    return { actionable: true, heading: 'Add this task?', details, confirmLabel: 'Add task' };
  }
  if (p.intent === 'create_reminder' && p.reminder) {
    const details = [`“${p.reminder.title}”`, formatWhen(p.reminder.firstAt, timeZone, locale)];
    const repeat = describeRepeat(p.reminder.repeat, p.reminder.weekdays);
    if (repeat) details.push(repeat);
    return { actionable: true, heading: 'Set this reminder?', details, confirmLabel: 'Set reminder' };
  }
  if (p.intent === 'ask_brain' && p.question) {
    return { actionable: false, heading: 'Asking SMOI Brain', details: [`“${p.question}”`], confirmLabel: null };
  }
  return { actionable: false, heading: "I don't know how to do that yet.", details: [], confirmLabel: null };
}

/** "Tue 4 Nov, 10:00 to 11:00" (or across days, both in full). */
export function formatRange(start: string, end: string, timeZone: string, locale = 'en-GB'): string {
  const a = formatWhen(start, timeZone, locale);
  const b = formatWhen(end, timeZone, locale);
  const [dayA, timeA] = a.split(', ');
  const [dayB, timeB] = b.split(', ');
  return dayA === dayB ? `${dayA}, ${timeA} to ${timeB}` : `${a} to ${b}`;
}

function eventLine(e: { title: string; start: string | null; end: string | null; startDate?: string | null }, tz: string): string {
  if (e.start && e.end) return `“${e.title}”, ${formatRange(e.start, e.end, tz)}`;
  return `“${e.title}”, all day ${e.startDate ?? ''}`.trim();
}

function remindersLine(minutes: number[] | null | undefined): string | null {
  if (!minutes || minutes.length === 0) return null;
  const one = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  return `Reminders: ${minutes.map(one).join(', ')} before`;
}

const preview = (x: unknown) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const str = (x: unknown) => (typeof x === 'string' ? x : '');

/**
 * Describes a change to Google that waits for confirmation (FR-04.04, FR-04.05, FR-05.08): the
 * event or draft as it would be, as it is now for a change, and any overlapping events.
 */
export function describeGooglePreview(p: GooglePreview, timeZone: string): ProposalView {
  const after = preview(p.after);
  const before = preview(p.before);
  const conflicts = (p.conflicts ?? []).map((c: CalendarEvent) => `Overlaps ${eventLine(c, timeZone)}`);
  switch (p.kind) {
    case 'create_event': {
      const details = [eventLine({ title: str(after.title), start: str(after.start), end: str(after.end) }, timeZone)];
      const r = remindersLine(after.reminderMinutes as number[] | null);
      if (r) details.push(r);
      return { actionable: true, heading: conflicts.length ? 'Add this event? It overlaps other events.' : 'Add this event to Google Calendar?',
        details: [...details, ...conflicts], confirmLabel: 'Add event' };
    }
    case 'update_event':
      return {
        actionable: true, heading: conflicts.length ? 'Change this event? The new time overlaps other events.' : 'Change this event?',
        details: [
          `Now: ${eventLine({ title: str(before.title), start: str(before.start) || null, end: str(before.end) || null }, timeZone)}`,
          `New: ${eventLine({ title: str(after.title), start: str(after.start), end: str(after.end) }, timeZone)}`,
          ...conflicts,
        ],
        confirmLabel: 'Change event',
      };
    case 'delete_event':
      return {
        actionable: true, heading: 'Delete this event from Google Calendar?',
        details: [eventLine({ title: str(before.title), start: str(before.start) || null, end: str(before.end) || null,
          startDate: str(before.startDate) || null }, timeZone)],
        confirmLabel: 'Delete event',
      };
    case 'create_draft':
    case 'update_draft': {
      const body = str(after.body);
      return {
        actionable: true,
        heading: p.kind === 'create_draft' ? 'Create this draft in Gmail? You send it yourself.' : 'Update this draft in Gmail?',
        details: [`To: ${str(after.to)}`, `Subject: ${str(after.subject) || '(no subject)'}`,
          body.length > 300 ? `${body.slice(0, 300)}…` : body],
        confirmLabel: p.kind === 'create_draft' ? 'Create draft' : 'Update draft',
      };
    }
  }
}

/** What SMOI says once a confirmed change went through. */
export function googleDone(kind: GooglePreview['kind']): { message: string } {
  switch (kind) {
    case 'create_event': return { message: 'Added to your Google Calendar.' };
    case 'update_event': return { message: 'Event changed in your Google Calendar.' };
    case 'delete_event': return { message: 'Event deleted from your Google Calendar.' };
    case 'create_draft': return { message: 'Draft saved in Gmail. Open it there to check and send it.' };
    case 'update_draft': return { message: 'Draft updated in Gmail.' };
  }
}

/** The task to create once the user confirms. */
export function taskFrom(p: Proposal, id: string, now: Date): TaskItem | null {
  if (p.intent !== 'create_task' || !p.task || p.problem) return null;
  return {
    id, title: p.task.title, description: '', priority: p.task.priority, category: '', dueAt: p.task.dueAt,
    completedAt: null, editedAt: now.toISOString(),
  };
}

/**
 * The reminder to create once the user confirms. Occurrences already in the past count as
 * shown, so "every day at 9" created at noon doesn't fire at once for this morning.
 */
export function reminderFrom(p: Proposal, id: string, now: Date, timeZone: string): ReminderItem | null {
  if (p.intent !== 'create_reminder' || !p.reminder || p.problem) return null;
  return newReminder({ id, title: p.reminder.title, firstAt: p.reminder.firstAt, repeat: p.reminder.repeat,
    weekdays: p.reminder.weekdays, timeZone, taskId: null }, now);
}

export function newReminder(r: Omit<ReminderItem, 'lastFiredAt' | 'editedAt'>, now: Date): ReminderItem {
  const past = latestOccurrence(r, now.getTime());
  return { ...r, lastFiredAt: past === null ? null : new Date(past).toISOString(), editedAt: now.toISOString() };
}
