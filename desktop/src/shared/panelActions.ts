/**
 * What each menu-panel action does to SMOI: the frog state, the speech bubble and the mood shown
 * in the panel header. The lines and moods come from the design's "speech bubble and panel" board,
 * with the changes the owner approved for Phase 6B (see "Talk to SMOI" and "Open SMOI Brain").
 *
 * Lines must be true. A line that states a fact (a number of tasks, a busy calendar, an email) is
 * only shown when that fact comes from real data. Until tasks, calendar and inbox exist, their
 * rows are unavailable: they read "Not available yet" and show no line at all.
 *
 * Pure data and functions, so the mapping is unit-tested (test/panelActions.test.ts).
 */

/** Blue: nudges. Lavender: findings. Pink: time-sensitive, stays until dismissed. */
export type BubbleTone = 'nudge' | 'finding' | 'urgent';

export interface BubbleLine {
  tone: BubbleTone;
  text: string;
}

export type PanelRowId = 'talk' | 'tasks' | 'calendar' | 'inbox' | 'brain' | 'dashboard';

/** Opening and closing the panel are actions too, with their own lines. */
export type PanelEvent = 'hello' | 'closed' | PanelRowId;

/** Where an action takes the user, if anywhere. */
export type Destination = 'chat' | 'brain' | 'dashboard';

/**
 * How the frog reacts:
 * - `idle`: no reaction; SMOI shows whatever is still going on (an error, indexing) or idle;
 * - otherwise a brief reaction in that state, after which SMOI returns to what's going on.
 */
export type FrogReaction = 'idle' | 'happy' | 'thinking' | 'working' | 'annoyed' | 'surprised';

export interface PanelEffect {
  frog: FrogReaction;
  bubble: BubbleLine | null;
  mood: string;
  opens: Destination | null;
}

export interface PanelRow {
  id: PanelRowId;
  label: string;
}

/** The rows in the design's order. */
export const PANEL_ROWS: readonly PanelRow[] = [
  { id: 'talk', label: 'Talk to SMOI' },
  { id: 'tasks', label: 'View tasks' },
  { id: 'calendar', label: 'Open calendar' },
  { id: 'inbox', label: 'Check inbox' },
  { id: 'brain', label: 'Open SMOI Brain' },
  { id: 'dashboard', label: 'Open dashboard' },
];

/** Shown in place of a line for rows whose feature doesn't exist yet. No phase numbers in the UI. */
export const NOT_AVAILABLE = 'Not available yet';

/** Rows that work today. Tasks, calendar and inbox are added as their features are built. */
export const AVAILABLE_ROWS: ReadonlySet<PanelRowId> = new Set<PanelRowId>(['talk', 'brain', 'dashboard']);

/** Real data some lines depend on. Absent means "not known", and the line is not shown. */
export interface PanelFacts {
  /** Open tasks (from the tasks feature). */
  openTasks?: number;
}

/** The lavender line, shown only when an answer with valid citations has actually arrived. */
export const FINDING: BubbleLine = { tone: 'finding', text: 'I found something interesting for you.' };

export const HELLO_MOOD = 'feeling chatty';

/**
 * The effect of a panel action, or null when the row isn't available: an unavailable row changes
 * nothing, shows no line and opens nothing.
 */
export function effectOf(
  event: PanelEvent,
  available: ReadonlySet<PanelRowId> = AVAILABLE_ROWS,
  facts: PanelFacts = {},
): PanelEffect | null {
  if (event !== 'hello' && event !== 'closed' && !available.has(event)) return null;
  switch (event) {
    case 'hello':
      return { frog: 'happy', bubble: nudge('Hi. What are we avoiding today?'), mood: HELLO_MOOD, opens: null };
    case 'closed':
      return { frog: 'idle', bubble: nudge('Fine. I will just sit here. Cutely.'), mood: 'feeling ignored', opens: null };
    case 'talk':
      // Phase 6B has text chat only. The design's listening state shows a pulsing microphone chip,
      // which would claim the mic is on (NFR-04.02), so SMOI stays idle here. Phase 7 switches this
      // to the design's version when the microphone really is on:
      //   listening, "Go on, I'm all ears. Figuratively. I have no ears.", mood "listening".
      return { frog: 'idle', bubble: nudge('Go on, type it. I have no ears.'), mood: 'ready to chat', opens: 'chat' };
    case 'tasks': {
      // The count must come from real data; with no count, or nothing to do, there is no line.
      const n = facts.openTasks;
      const bubble = n && n > 0 ? nudge(`Hey, you've got ${n} ${n === 1 ? 'thing' : 'things'} to do!`) : null;
      return { frog: 'working', bubble, mood: 'locked in', opens: null };
    }
    case 'calendar':
      // When the calendar exists, show this line only if today really is busy.
      return { frog: 'annoyed', bubble: urgent('Your calendar looks suspiciously busy today.'), mood: 'judging a little', opens: null };
    case 'inbox':
      // When the inbox exists, show this line only if there is a new email.
      return { frog: 'surprised', bubble: urgent('Psst. Someone emailed you.'), mood: 'startled', opens: null };
    case 'brain':
      // No line on opening: nothing has been found yet. FINDING is shown when an answer arrives.
      return { frog: 'thinking', bubble: null, mood: 'thinking', opens: 'brain' };
    case 'dashboard':
      return { frog: 'happy', bubble: nudge('Welcome to my little office.'), mood: 'proud', opens: 'dashboard' };
  }
}

function nudge(text: string): BubbleLine {
  return { tone: 'nudge', text };
}

function urgent(text: string): BubbleLine {
  return { tone: 'urgent', text };
}

