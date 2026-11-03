import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/shared/apiTypes';
import { describeProposal, formatWhen, reminderFrom, taskFrom } from '../src/shared/proposal';

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

  it('calendar and email say they aren’t available yet', () => {
    expect(describeProposal({ ...base, intent: 'draft_email', available: false }, TZ).heading).toBe("Drafting emails isn't available yet.");
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
