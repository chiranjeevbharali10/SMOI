/**
 * Typed and spoken commands, after interpretation (FR-03.05, FR-03.06, FR-04.03, FR-04.04, FR-05.08).
 * The backend's proposal is kept here under a random id; the page only ever gets that id back, so
 * a page can confirm a proposal SMOI made but can't invent one.
 *
 * - Tasks and reminders: confirming creates them in the local copy (which syncs like any change).
 * - Calendar and email: the proposal is turned into a Google proposal first (an event with its
 *   conflicts, a change with before and after, a draft), which the backend stores. Confirming
 *   applies exactly that, once, even if the confirm is repeated.
 * - Asking SMOI Brain is read-only, so it runs without a confirmation, but the question is shown
 *   first, exactly as understood.
 */
import { randomUUID } from 'node:crypto';
import { ApiError, type ApiClient } from './api';
import type { TaskService } from './tasks';
import type { GooglePreview, Proposal } from '../shared/apiTypes';
import type { CommandOutcome } from '../shared/bridge';
import { describeGooglePreview, describeProposal, formatWhen, googleDone, reminderFrom, taskFrom, type ProposalView } from '../shared/proposal';
import type { CompanionEvent } from '../shared/personality';

const MAX_COMMAND = 1000;
/** Proposals not confirmed within this time are forgotten. */
const PROPOSAL_TTL_MS = 10 * 60_000;
const GOOGLE_INTENTS = new Set(['create_event', 'update_event', 'delete_event', 'draft_email']);

export interface CommandDeps {
  api: ApiClient;
  tasks: TaskService;
  timeZone: () => string;
  /** Something was saved; SMOI says so in its own words. */
  onSaved: (event: CompanionEvent) => void;
  /** "What's on my calendar": open the calendar screen. */
  openCalendar: () => void;
  /** A Google call failed (for the reconnect banner). */
  onGoogleError: (e: unknown) => void;
}

interface Entry {
  proposal: Proposal;
  preview: GooglePreview | null;
  at: number;
}

export class Commands {
  private readonly proposals = new Map<string, Entry>();

  constructor(private readonly deps: CommandDeps) {}

  /** Interprets typed text. Nothing is created. */
  async interpret(text: string): Promise<CommandOutcome> {
    const clean = text.trim().slice(0, MAX_COMMAND);
    const proposal = await this.deps.api.interpret(clean, this.deps.timeZone());
    return this.prepare(proposal);
  }

  /**
   * Keeps the proposal under a new id and describes it. Calendar and email proposals are first
   * sent to the backend as Google proposals, so the user sees conflicts and before/after.
   */
  async prepare(proposal: Proposal): Promise<CommandOutcome> {
    const now = Date.now();
    for (const [id, p] of this.proposals) if (now - p.at > PROPOSAL_TTL_MS) this.proposals.delete(id);
    const id = randomUUID();
    const tz = this.deps.timeZone();
    if (proposal.intent === 'list_events' && proposal.available && !proposal.problem) {
      this.deps.openCalendar();
      return { id, proposal, view: { actionable: false, heading: 'Here is your calendar.', details: [], confirmLabel: null } };
    }
    if (GOOGLE_INTENTS.has(proposal.intent) && proposal.available && !proposal.problem) {
      let preview: GooglePreview | null = null;
      let view: ProposalView;
      try {
        const r = await this.googlePreview(proposal);
        preview = r.preview;
        view = r.view ?? describeGooglePreview(r.preview!, tz);
      } catch (e) {
        this.deps.onGoogleError(e);
        view = { actionable: false, heading: e instanceof Error ? e.message : 'Google is unavailable.', details: [], confirmLabel: null };
      }
      if (preview) this.proposals.set(id, { proposal, preview, at: now });
      return { id, proposal, view };
    }
    this.proposals.set(id, { proposal, preview: null, at: now });
    return { id, proposal, view: describeProposal(proposal, tz) };
  }

  private async googlePreview(p: Proposal): Promise<{ preview: GooglePreview | null; view?: ProposalView }> {
    const api = this.deps.api;
    if (p.intent === 'create_event' && p.event) {
      return { preview: await api.proposeEvent({ ...p.event, reminderMinutes: null }) };
    }
    if (p.intent === 'draft_email' && p.email) {
      return { preview: await api.proposeDraft(p.email) };
    }
    if ((p.intent === 'update_event' || p.intent === 'delete_event') && p.eventChange) {
      const c = p.eventChange;
      const found = (await api.findEvents(c.query, c.day, this.deps.timeZone())).filter((e) => e.start !== null);
      const tz = this.deps.timeZone();
      if (found.length === 0) {
        return { preview: null, view: { actionable: false, heading: `I couldn't find “${c.query}” on ${formatDay(c.day)}.`, details: [], confirmLabel: null } };
      }
      if (found.length > 1) {
        return {
          preview: null,
          view: {
            actionable: false, heading: `I found ${found.length} events like “${c.query}”. Change the one you mean in the calendar.`,
            details: found.slice(0, 5).map((e) => `${e.title}, ${formatWhen(e.start!, tz)}`), confirmLabel: null,
          },
        };
      }
      const event = found[0];
      if (c.delete) return { preview: await api.proposeEventDelete(event.id) };
      return { preview: await api.proposeEventUpdate(event.id, { start: c.newStart ?? undefined }) };
    }
    return { preview: null, view: { actionable: false, heading: "I couldn't tell what to change.", details: [], confirmLabel: null } };
  }

  /**
   * Runs a confirmed proposal. Returns what was done, in plain words, or throws if the id is
   * unknown, expired or already used.
   */
  async confirm(id: string): Promise<string> {
    const entry = this.proposals.get(id);
    this.proposals.delete(id); // a proposal runs at most once from here
    if (!entry || Date.now() - entry.at > PROPOSAL_TTL_MS) {
      throw new Error('That command has expired. Say or type it again.');
    }
    if (entry.preview) return this.applyGoogle(entry.preview);
    return this.run(entry.proposal);
  }

  /** Applies a Google proposal the user confirmed (also used by the calendar and inbox screens). */
  async applyGoogle(preview: GooglePreview): Promise<string> {
    try {
      const outcome = await this.deps.api.confirmAction(preview.id);
      if (outcome.status !== 'applied') {
        const problem = outcome.result && typeof outcome.result.problem === 'string' ? outcome.result.problem : null;
        throw new Error(problem ?? 'That change could not be applied.');
      }
      const done = googleDone(preview.kind);
      this.deps.onSaved({ type: 'google_done', text: done.message });
      return done.message;
    } catch (e) {
      if (e instanceof ApiError) this.deps.onGoogleError(e);
      throw e;
    }
  }

  /** Creates what a task or reminder proposal describes. */
  run(proposal: Proposal): string {
    const now = new Date();
    const task = taskFrom(proposal, randomUUID(), now);
    if (task) {
      this.deps.tasks.saveTask(task);
      this.deps.onSaved({ type: 'task_saved', title: task.title });
      return `Task added: “${task.title}”.`;
    }
    const tz = this.deps.timeZone();
    const reminder = reminderFrom(proposal, randomUUID(), now, tz);
    if (reminder) {
      this.deps.tasks.saveReminder(reminder);
      const when = formatWhen(reminder.firstAt, tz);
      this.deps.onSaved({ type: 'reminder_saved', title: reminder.title, when });
      return `Reminder set for ${when}: “${reminder.title}”.`;
    }
    throw new Error('There was nothing to do for that command.');
  }
}

function formatDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d).replace(/,/g, '');
}
