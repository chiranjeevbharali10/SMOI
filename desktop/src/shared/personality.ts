/**
 * SMOI's voice in speech bubbles (FR-08.01 to FR-08.03). The user sets humour, sarcasm,
 * friendliness and reminder strictness from 0 to 4, or picks a preset; each event then gets a line
 * in the matching style.
 *
 * Rules:
 * - Lines are written here, not generated, so SMOI's personality stays the one in the design.
 * - Every fact in a line (a title, a count, a time) is passed in from real data and appears
 *   verbatim; no style adds a claim. Errors are never routed through here: they are shown in
 *   plain words wherever they happen.
 * - Strictness decides how insistent reminders are: pink (stays until dismissed) from 2 up, blue
 *   (fades) below; and at 0, SMOI doesn't nag about overdue tasks at all.
 *
 * Pure; tested in test/personality.test.ts.
 */
import type { BubbleLine } from './panelActions';
import type { FrogReaction } from './panelActions';

export interface Personality {
  humour: number;
  sarcasm: number;
  friendliness: number;
  strictness: number;
}

export type PresetId = 'classic' | 'gentle' | 'sassy' | 'quiet';

/** Presets within the design's character: cute, a little sassy, never mean. */
export const PRESETS: Record<PresetId, { label: string; values: Personality }> = {
  classic: { label: 'Classic SMOI', values: { humour: 3, sarcasm: 2, friendliness: 3, strictness: 2 } },
  gentle: { label: 'Gentle', values: { humour: 1, sarcasm: 0, friendliness: 4, strictness: 1 } },
  sassy: { label: 'Extra sassy', values: { humour: 4, sarcasm: 4, friendliness: 2, strictness: 3 } },
  quiet: { label: 'Just the facts', values: { humour: 0, sarcasm: 0, friendliness: 1, strictness: 2 } },
};

export const DEFAULT_PERSONALITY: Personality = PRESETS.classic.values;

export type Style = 'plain' | 'warm' | 'playful' | 'cheeky';

/** Sarcasm wins over humour, humour over friendliness; all low is plain. */
export function styleOf(p: Personality): Style {
  if (p.sarcasm >= 3) return 'cheeky';
  if (p.humour >= 3) return 'playful';
  if (p.friendliness >= 3) return 'warm';
  return 'plain';
}

export function clampPersonality(v: unknown): Personality | null {
  const p = v as Personality;
  if (!p || typeof p !== 'object') return null;
  const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4;
  return ok(p.humour) && ok(p.sarcasm) && ok(p.friendliness) && ok(p.strictness)
    ? { humour: p.humour, sarcasm: p.sarcasm, friendliness: p.friendliness, strictness: p.strictness }
    : null;
}

export type CompanionEvent =
  | { type: 'reminder'; title: string; missed: boolean }
  | { type: 'overdue'; count: number }
  | { type: 'indexed'; count: number }
  | { type: 'task_saved'; title: string }
  | { type: 'reminder_saved'; title: string; when: string }
  /** No prompt text or project names: only how long the run took (FR-10, NFR-03.16). */
  | { type: 'claude_done'; minutes: number }
  | { type: 'claude_waiting' }
  /** Never the sender, subject or text: email content stays out of bubbles (FR-05.04). */
  | { type: 'important_email'; count: number }
  | { type: 'google_reconnect' }
  /** The backend's plain sentence: which draft is gone, so the reminder was cancelled (FR-05.11). */
  | { type: 'draft_reminder_cancelled'; message: string }
  /** A confirmed calendar or draft change went through; the sentence comes from shared/proposal.ts. */
  | { type: 'google_done'; text: string };

export interface Reaction {
  /** Null when the event shouldn't produce a bubble at these settings. */
  line: BubbleLine | null;
  frog: FrogReaction;
}

type Lines = Record<Style, string>;

const quote = (s: string) => `“${s}”`;
const things = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function react(event: CompanionEvent, p: Personality): Reaction {
  const style = styleOf(p);
  switch (event.type) {
    case 'reminder': {
      const t = quote(event.title);
      const lines: Lines = event.missed
        ? {
          plain: `Missed reminder: ${t}.`,
          warm: `You missed this one while I was away: ${t}.`,
          playful: `Oops, this went off while I was napping: ${t}.`,
          cheeky: `This went off while you weren't looking: ${t}. Just saying.`,
        }
        : {
          plain: `Reminder: ${t}.`,
          warm: `Friendly reminder: ${t}.`,
          playful: `Ding! Time for ${t}.`,
          cheeky: `Hey. ${t}. You asked me to nag you.`,
        };
      return { line: { tone: p.strictness >= 2 ? 'urgent' : 'nudge', text: lines[style] }, frog: 'surprised' };
    }
    case 'overdue': {
      if (p.strictness === 0 || event.count <= 0) return { line: null, frog: 'idle' };
      const n = things(event.count, 'task is', 'tasks are');
      const lines: Lines = {
        plain: `${n} overdue.`,
        warm: `${n} overdue. Want to look at them together?`,
        playful: `${n} overdue. They miss you.`,
        cheeky: `${n} overdue. I'm not judging. Much.`,
      };
      return { line: { tone: p.strictness >= 3 ? 'urgent' : 'nudge', text: lines[style] }, frog: p.strictness >= 3 ? 'annoyed' : 'working' };
    }
    case 'indexed': {
      const n = things(event.count, 'document is', 'documents are');
      const lines: Lines = {
        plain: `${n} indexed and ready to search.`,
        warm: `All done: ${n} indexed and ready.`,
        playful: `Munched through it: ${n} indexed and ready.`,
        cheeky: `Done reading. ${n} indexed. You're welcome.`,
      };
      return { line: { tone: 'finding', text: lines[style] }, frog: 'happy' };
    }
    case 'task_saved': {
      const t = quote(event.title);
      const lines: Lines = {
        plain: `Task added: ${t}.`,
        warm: `Got it. ${t} is on your list.`,
        playful: `${t}, added. One more lily pad on the pond.`,
        cheeky: `Added ${t}. Now you actually have to do it.`,
      };
      return { line: { tone: 'nudge', text: lines[style] }, frog: 'happy' };
    }
    case 'reminder_saved': {
      const t = quote(event.title);
      const lines: Lines = {
        plain: `Reminder set for ${event.when}: ${t}.`,
        warm: `I'll remind you ${event.when}: ${t}.`,
        playful: `Noted! ${event.when} I'll pipe up about ${t}.`,
        cheeky: `Fine, I'll remind you ${event.when}: ${t}. Try to act surprised.`,
      };
      return { line: { tone: 'nudge', text: lines[style] }, frog: 'happy' };
    }
    case 'claude_done': {
      const d = event.minutes >= 60
        ? `${Math.floor(event.minutes / 60)} h ${event.minutes % 60} min`
        : `${event.minutes} min`;
      const lines: Lines = {
        plain: `Claude Code finished (${d}).`,
        warm: `Claude Code is done after ${d}. Nice work, both of you.`,
        playful: `Ribbit! Claude Code finished after ${d}.`,
        cheeky: `Claude Code finished. ${d}. You can stop pretending to wait now.`,
      };
      return { line: { tone: 'finding', text: lines[style] }, frog: 'celebrating' };
    }
    case 'important_email': {
      const one = event.count <= 1;
      const lines: Lines = {
        plain: one ? "You've got an important email." : `You've got ${event.count} important emails.`,
        warm: one ? "An important email just arrived. Have a look when you can." : `${event.count} important emails just arrived.`,
        playful: one ? 'Ooh! An important email just landed.' : `Ooh! ${event.count} important emails just landed.`,
        cheeky: one ? 'Important email. Probably more important than whatever this is.' : `${event.count} important emails. Popular today.`,
      };
      return { line: { tone: 'urgent', text: lines[style] }, frog: 'surprised' };
    }
    case 'google_reconnect': {
      return {
        line: { tone: 'urgent', text: 'Google stopped letting me in. Reconnect it in Settings to get calendar and email back.' },
        frog: 'annoyed',
      };
    }
    case 'draft_reminder_cancelled': {
      return { line: { tone: 'nudge', text: event.message }, frog: 'happy' };
    }
    case 'google_done': {
      return { line: { tone: 'nudge', text: event.text }, frog: 'happy' };
    }
    case 'claude_waiting': {
      const lines: Lines = {
        plain: 'Claude Code is waiting for your permission.',
        warm: 'Claude Code needs your OK to keep going.',
        playful: 'Psst! Claude Code is stuck until you say yes or no.',
        cheeky: "Claude Code is just sitting there. It needs you. Shocking, I know.",
      };
      return { line: { tone: 'urgent', text: lines[style] }, frog: 'attention' };
    }
  }
}
