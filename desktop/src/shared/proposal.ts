/**
 * What SMOI shows before it acts on a command (FR-03.06), and the item it creates once the user
 * confirms. The backend only proposes; this module describes the proposal in plain words and,
 * after confirmation, turns it into an ordinary task or reminder, which goes through the same
 * store and API as one typed into the Tasks screen.
 *
 * Pure; tested in test/proposal.test.ts.
 */
import type { Proposal } from './apiTypes';
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

const NOT_YET: Record<string, string> = {
  list_events: 'Reading your calendar',
  create_event: 'Adding calendar events',
  draft_email: 'Drafting emails',
};

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
