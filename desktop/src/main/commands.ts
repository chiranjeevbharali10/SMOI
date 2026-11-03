/**
 * Typed and spoken commands, after interpretation (FR-03.05, FR-03.06). The backend's proposal is
 * kept here under a random id; the page only ever gets that id back, so a page can confirm a
 * proposal SMOI made but can't invent one. Confirming turns the proposal into an ordinary task or
 * reminder in the local copy (which syncs like any other change).
 *
 * Asking SMOI Brain is read-only, so it runs without a confirmation, but the question is shown
 * first, exactly as understood.
 */
import { randomUUID } from 'node:crypto';
import type { ApiClient } from './api';
import type { TaskService } from './tasks';
import type { Proposal } from '../shared/apiTypes';
import type { CommandOutcome } from '../shared/bridge';
import { describeProposal, formatWhen, reminderFrom, taskFrom } from '../shared/proposal';
import type { CompanionEvent } from '../shared/personality';

const MAX_COMMAND = 1000;
/** Proposals not confirmed within this time are forgotten. */
const PROPOSAL_TTL_MS = 10 * 60_000;

export interface CommandDeps {
  api: ApiClient;
  tasks: TaskService;
  timeZone: () => string;
  /** Something was saved; SMOI says so in its own words. */
  onSaved: (event: CompanionEvent) => void;
}

export class Commands {
  private readonly proposals = new Map<string, { proposal: Proposal; at: number }>();

  constructor(private readonly deps: CommandDeps) {}

  /** Interprets typed text. Nothing is created. */
  async interpret(text: string): Promise<CommandOutcome> {
    const clean = text.trim().slice(0, MAX_COMMAND);
    const proposal = await this.deps.api.interpret(clean, this.deps.timeZone());
    return this.remember(proposal);
  }

  remember(proposal: Proposal): CommandOutcome {
    const now = Date.now();
    for (const [id, p] of this.proposals) if (now - p.at > PROPOSAL_TTL_MS) this.proposals.delete(id);
    const id = randomUUID();
    this.proposals.set(id, { proposal, at: now });
    return { id, proposal, view: describeProposal(proposal, this.deps.timeZone()) };
  }

  /**
   * Runs a confirmed proposal: creates the task or reminder. Returns what was saved, in plain
   * words, or throws if the id is unknown, expired or already used.
   */
  confirm(id: string): string {
    const entry = this.proposals.get(id);
    this.proposals.delete(id); // a proposal runs at most once
    if (!entry || Date.now() - entry.at > PROPOSAL_TTL_MS) {
      throw new Error('That command has expired. Say or type it again.');
    }
    return this.run(entry.proposal);
  }

  /** Creates what the proposal describes. Only create_task and create_reminder create anything. */
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
