import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/shared/apiTypes';
import { describeGooglePreview, describeProposal, formatWhen, reminderFrom, taskFrom } from '../src/shared/proposal';

const base: Proposal = { intent: 'unknown', available: true, task: null, reminder: null, question: null, problem: null };
const TZ = 'Europe/London';
const NOW = new Date('2026-11-03T12:00:00Z');

describe('describing a proposal before acting', () => {
  it('a task, with its due date and priority', () => {
    const v = describeProposal({ ...base, intent: 'create_task', task: { title: 'Buy oat milk', dueAt: '2026-11-06T09:00:00Z', priority: 'high' } }, TZ);
    expect(v).toEqual({ actionable: true, heading: 'Add this task?', details: ['“Buy oat milk”', 'Due Fri 6 Nov, 09:00', 'High priority'], confirmLabel: 'Add task' });
  });

  it('a recurring reminder, with its days', () => {
    const v = describeProposal({ ...base, intent: 'create_reminder', reminder: { title: 'Stretch', firstAt: '2026-11-04T15:00:00Z', repeat: 'weekdays', weekdays: 1 | 4 } }, TZ);
    expect(v.details).toEqual(['“Stretch”', 'Wed 4 Nov, 15:00', 'Repeats on Mon, Wed']);
    expect(v.actionable).toBe(true);
  });

  it('a problem is shown as is, with nothing to confirm', () => {
    const v = describeProposal({ ...base, intent: 'create_reminder', problem: 'That time has already passed.' }, TZ);
    expect(v).toEqual({ actionable: false, heading: 'That time has already passed.', details: [], confirmLabel: null });
  });

  it('an intent the backend marks unavailable says so', () => {
    expect(describeProposal({ ...base, intent: 'draft_email', available: false }, TZ).heading).toBe("That isn't available yet.");
  });

  it('describes a new event with its conflicts before anything changes', () => {
    const v = describeGooglePreview({
      id: 'a1', kind: 'create_event', expiresAt: '2026-11-04T10:00:00Z', before: null,
      after: { title: 'Lunch', start: '2026-11-06T12:30:00Z', end: '2026-11-06T13:30:00Z', reminderMinutes: [10] },
      conflicts: [{ id: 'e1', title: 'Standup', start: '2026-11-06T13:00:00Z', end: '2026-11-06T13:15:00Z', startDate: null, endDate: null,
        link: '', reminderMinutes: null }],
    }, 'UTC');
    expect(v.actionable).toBe(true);
    expect(v.heading).toContain('overlaps');
    expect(v.details).toEqual(['“Lunch”, Fri 6 Nov, 12:30 to 13:30', 'Reminders: 10 min before', 'Overlaps “Standup”, Fri 6 Nov, 13:00 to 13:15']);
    expect(v.confirmLabel).toBe('Add event');
  });

  it('shows before and after for a change, and says drafts are sent by the user', () => {
    const change = describeGooglePreview({
      id: 'a2', kind: 'update_event', expiresAt: '', conflicts: [],
      before: { title: 'Dentist', start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z' },
      after: { title: 'Dentist', start: '2026-11-04T16:00:00Z', end: '2026-11-04T17:00:00Z' },
    }, 'UTC');
    expect(change.details[0]).toBe('Now: “Dentist”, Wed 4 Nov, 09:00 to 10:00');
    expect(change.details[1]).toBe('New: “Dentist”, Wed 4 Nov, 16:00 to 17:00');
    const draft = describeGooglePreview({
      id: 'a3', kind: 'create_draft', expiresAt: '', conflicts: [], before: null,
      after: { to: 'sam@example.com', subject: 'Late', body: 'Ten minutes.' },
    }, 'UTC');
    expect(draft.heading).toContain('You send it yourself');
    expect(draft.details).toEqual(['To: sam@example.com', 'Subject: Late', 'Ten minutes.']);
  });

  it('anything else says SMOI can’t do it', () => {
    expect(describeProposal(base, TZ).heading).toBe("I don't know how to do that yet.");
  });

  it('formats times in the reminder’s zone', () => {
    expect(formatWhen('2026-11-04T03:30:00Z', 'Asia/Kolkata')).toBe('Wed 4 Nov, 09:00');
  });
});

describe('creating the item after confirmation', () => {
  it('a task', () => {
    const t = taskFrom({ ...base, intent: 'create_task', task: { title: 'x', dueAt: null, priority: 'normal' } }, 'id1', NOW);
    expect(t).toMatchObject({ id: 'id1', title: 'x', completedAt: null, editedAt: NOW.toISOString() });
  });

  it('a daily reminder made after today’s time doesn’t fire at once', () => {
    const r = reminderFrom({ ...base, intent: 'create_reminder', reminder: { title: 'x', firstAt: '2026-11-03T09:00:00Z', repeat: 'daily', weekdays: 0 } }, 'r1', NOW, TZ);
    expect(r?.lastFiredAt).toBe('2026-11-03T09:00:00.000Z');
  });

  it('nothing for a proposal with a problem', () => {
    expect(taskFrom({ ...base, intent: 'create_task', task: { title: 'x', dueAt: null, priority: 'normal' }, problem: 'no' }, 'i', NOW)).toBeNull();
  });
});
