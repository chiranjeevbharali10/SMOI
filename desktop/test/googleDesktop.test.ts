import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../src/main/api';
import { Commands } from '../src/main/commands';
import { TaskService } from '../src/main/tasks';
import type { CalendarEvent, GooglePreview, Proposal } from '../src/shared/apiTypes';
import { safeGoogleUrl } from '../src/shared/googleLinks';
import type { ReminderItem } from '../src/shared/taskStore';

const base: Proposal = { intent: 'unknown', available: true, task: null, reminder: null, question: null, problem: null };

const preview = (kind: GooglePreview['kind'], after: unknown, before: unknown = null): GooglePreview =>
  ({ id: 'act-1', kind, expiresAt: '2030-01-01T00:00:00Z', before, after, conflicts: [] });

const event = (id: string, title: string): CalendarEvent => ({
  id, title, start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z', startDate: null, endDate: null, link: '', reminderMinutes: null,
});

function setup(api: Partial<ApiClient>) {
  const saved: unknown[] = [];
  const errors: unknown[] = [];
  const commands = new Commands({
    api: api as ApiClient, tasks: {} as TaskService, timeZone: () => 'UTC',
    onSaved: (e) => saved.push(e), openCalendar: vi.fn(), onGoogleError: (e) => errors.push(e),
  });
  return { commands, saved, errors };
}

describe('links SMOI opens', () => {
  it('only opens Google’s own sites over https', () => {
    expect(safeGoogleUrl('https://mail.google.com/mail/?authuser=a%40example.com#all/18c2')).toBe(true);
    expect(safeGoogleUrl('https://www.google.com/calendar/event?eid=abc')).toBe(true);
    expect(safeGoogleUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(safeGoogleUrl('http://mail.google.com/')).toBe(false);
    expect(safeGoogleUrl('https://mail.google.com.evil.example/')).toBe(false);
    expect(safeGoogleUrl('https://user:pw@mail.google.com/')).toBe(false);
    expect(safeGoogleUrl('javascript:alert(1)')).toBe(false);
    expect(safeGoogleUrl('file:///C:/Windows')).toBe(false);
    expect(safeGoogleUrl('not a url')).toBe(false);
  });
});

describe('calendar and email commands', () => {
  it('turn an event into a Google proposal, and apply it once on confirm', async () => {
    const proposeEvent = vi.fn(async () => preview('create_event', { title: 'Lunch', start: '2026-11-06T12:30:00Z', end: '2026-11-06T13:30:00Z' }));
    const confirmAction = vi.fn(async () => ({ id: 'act-1', kind: 'create_event' as const, status: 'applied' as const, result: {} }));
    const { commands, saved } = setup({ proposeEvent, confirmAction });

    const out = await commands.prepare({ ...base, intent: 'create_event', event: { title: 'Lunch', start: '2026-11-06T12:30:00Z', end: '2026-11-06T13:30:00Z' } });

    expect(out.view.actionable).toBe(true);
    expect(out.view.confirmLabel).toBe('Add event');
    expect(confirmAction).not.toHaveBeenCalled();
    expect(await commands.confirm(out.id)).toBe('Added to your Google Calendar.');
    expect(confirmAction).toHaveBeenCalledWith('act-1');
    expect(saved).toEqual([{ type: 'google_done', text: 'Added to your Google Calendar.' }]);
    await expect(commands.confirm(out.id)).rejects.toThrow('expired');
    expect(confirmAction).toHaveBeenCalledTimes(1);
  });

  it('find the one event to move, and refuse to guess between several', async () => {
    const proposeEventUpdate = vi.fn(async () => preview('update_event', { title: 'Dentist' }, { title: 'Dentist' }));
    const change = { query: 'dentist', day: '2026-11-04', newStart: '2026-11-04T16:00:00Z', delete: false };

    const one = setup({ findEvents: async () => [event('e1', 'Dentist')], proposeEventUpdate });
    const ok = await one.commands.prepare({ ...base, intent: 'update_event', eventChange: change });
    expect(ok.view.actionable).toBe(true);
    expect(proposeEventUpdate).toHaveBeenCalledWith('e1', { start: '2026-11-04T16:00:00Z' });

    const two = setup({ findEvents: async () => [event('e1', 'Dentist'), event('e2', 'Dentist (Sam)')], proposeEventUpdate });
    const ambiguous = await two.commands.prepare({ ...base, intent: 'update_event', eventChange: change });
    expect(ambiguous.view.actionable).toBe(false);
    expect(ambiguous.view.heading).toContain('I found 2 events');

    const none = setup({ findEvents: async () => [] });
    const missing = await none.commands.prepare({ ...base, intent: 'delete_event', eventChange: { ...change, delete: true } });
    expect(missing.view.actionable).toBe(false);
    expect(missing.view.heading).toContain("couldn't find");
  });

  it('report a Google reconnect instead of offering to confirm', async () => {
    const { commands, errors } = setup({
      proposeDraft: async () => { throw new ApiError('google_reconnect', 'Google access was revoked or has expired.', 409); },
    });
    const out = await commands.prepare({ ...base, intent: 'draft_email', email: { to: 'sam@example.com', subject: 's', body: 'b' } });
    expect(out.view.actionable).toBe(false);
    expect(out.view.heading).toContain('revoked');
    expect(errors).toHaveLength(1);
  });
});

describe('reminders linked to a draft', () => {
  let service: TaskService | null = null;
  afterEach(() => service?.stop());

  const due = (draftId: string | null): ReminderItem => ({
    id: 'r1', taskId: null, title: 'Send the report', firstAt: new Date(Date.now() - 1000).toISOString(), repeat: 'none', weekdays: 0,
    timeZone: 'UTC', lastFiredAt: null, editedAt: new Date().toISOString(), draftId,
  });

  async function fire(check: { fire: boolean; message: string | null } | null, draftId: string | null = 'd-1') {
    const fired: string[] = [];
    const gone: string[] = [];
    const api = { sync: async () => { throw new ApiError('unreachable', 'offline'); } } as unknown as ApiClient;
    service = new TaskService({
      api, dataDir: mkdtempSync(join(tmpdir(), 'smoi-draft-')), onChange: () => {}, onOverdue: () => {},
      onReminder: (r) => fired.push(r.title),
      checkDraft: async () => check,
      onDraftGone: (_r, m) => gone.push(m),
    });
    service.start('owner@example.com');
    service.saveReminder(due(draftId));
    service.checkReminders(Date.now());
    await new Promise((r) => setTimeout(r, 20));
    return { fired, gone, service };
  }

  it('are cancelled, with the reason, when the draft is gone', async () => {
    const { fired, gone, service: s } = await fire({ fire: false, message: 'Your draft “Report” was sent or deleted in Gmail, so I cancelled its reminder.' });
    expect(fired).toEqual([]);
    expect(gone[0]).toContain('cancelled');
    expect(s.store.reminders.r1).toBeUndefined();
  });

  it('fire as normal when the draft exists or Google can’t be asked', async () => {
    expect((await fire({ fire: true, message: null })).fired).toEqual(['Send the report']);
    service?.stop();
    expect((await fire(null)).fired).toEqual(['Send the report']);
  });

  it('a reminder without a draft never asks', async () => {
    const check = vi.fn();
    const api = { sync: async () => { throw new ApiError('unreachable', 'offline'); } } as unknown as ApiClient;
    const fired: string[] = [];
    service = new TaskService({
      api, dataDir: mkdtempSync(join(tmpdir(), 'smoi-draft-')), onChange: () => {}, onOverdue: () => {},
      onReminder: (r) => fired.push(r.title), checkDraft: check,
    });
    service.start('owner@example.com');
    service.saveReminder(due(null));
    service.checkReminders(Date.now());
    expect(check).not.toHaveBeenCalled();
    expect(fired).toEqual(['Send the report']);
  });
});
