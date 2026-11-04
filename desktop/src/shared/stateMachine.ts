import type { FrogState } from './animations';

/**
 * Chooses which animation SMOI shows.
 *
 * Two kinds of input:
 * - **Conditions** last until switched off: the backend is down (error), the microphone is on
 *   (listening), an answer is streaming (speaking), the app waits for retrieval or the LLM
 *   (thinking), a background job runs (working), the user has been inactive (sleeping), a hop
 *   along the taskbar (walking).
 * - **Reactions** are brief: surprised plays once; happy, celebrating and annoyed show for a few
 *   seconds.
 *
 * The highest-priority active input wins, so an urgent state interrupts a lower one, and when it
 * ends SMOI returns to whatever is still active underneath. That is how "surprised returns to the
 * previous state" works: nothing is remembered, the machine simply recomputes.
 *
 * Pure and clock-free (callers pass `now`), so it is fully unit-tested.
 */
export const PRIORITY: Record<FrogState, number> = {
  error: 100,
  attention: 95,
  surprised: 90,
  listening: 80,
  speaking: 70,
  thinking: 60,
  annoyed: 55,
  celebrating: 50,
  happy: 45,
  working: 40,
  walking: 20,
  sleeping: 10,
  idle: 0,
};

export type Condition = 'error' | 'listening' | 'speaking' | 'thinking' | 'working' | 'sleeping' | 'walking';
/**
 * Thinking, working and error can also be brief reactions: opening SMOI Brain shows thinking for a
 * moment, and an answer that fell back to passages shows error for a moment, without either being
 * a lasting condition.
 */
export type Reaction = 'surprised' | 'happy' | 'celebrating' | 'annoyed' | 'thinking' | 'working' | 'error' | 'attention';

/** How long a timed reaction shows by default. Surprised instead ends when its animation finishes. */
export const REACTION_MS: Record<Exclude<Reaction, 'surprised'>, number> = {
  happy: 2500,
  celebrating: 3500,
  annoyed: 4000,
  thinking: 2000,
  working: 2500,
  error: 4000,
  attention: 10000,
};

interface ActiveReaction {
  state: Reaction;
  /** Absolute time it ends, or null for "when the one-shot animation finishes". */
  until: number | null;
}

export class FrogStateMachine {
  private readonly conditions = new Set<Condition>();
  private reactions: ActiveReaction[] = [];
  private listeners: ((state: FrogState) => void)[] = [];
  private current: FrogState = 'idle';

  /** The state to show now. */
  get state(): FrogState {
    return this.current;
  }

  onChange(listener: (state: FrogState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  set(condition: Condition, on: boolean, now: number): FrogState {
    if (on) this.conditions.add(condition);
    else this.conditions.delete(condition);
    return this.update(now);
  }

  isActive(condition: Condition): boolean {
    return this.conditions.has(condition);
  }

  /** Starts a brief reaction. Triggering one that is already showing restarts it. */
  react(reaction: Reaction, now: number, durationMs?: number): FrogState {
    this.reactions = this.reactions.filter((r) => r.state !== reaction);
    const until = reaction === 'surprised' ? null : now + (durationMs ?? REACTION_MS[reaction]);
    this.reactions.push({ state: reaction, until });
    return this.update(now);
  }

  /** Ends all reactions at once, for example when a panel action replaces the previous one. */
  clearReactions(now: number): FrogState {
    this.reactions = [];
    return this.update(now);
  }

  /** Called by the renderer when a one-shot animation (surprised) has played to the end. */
  animationFinished(state: FrogState, now: number): FrogState {
    this.reactions = this.reactions.filter((r) => !(r.state === state && r.until === null));
    return this.update(now);
  }

  /** Expires timed reactions. Call on a timer (for example every 250 ms). */
  tick(now: number): FrogState {
    return this.update(now);
  }

  private update(now: number): FrogState {
    this.reactions = this.reactions.filter((r) => r.until === null || r.until > now);
    const candidates: FrogState[] = ['idle', ...this.conditions, ...this.reactions.map((r) => r.state)];
    const next = candidates.reduce((best, s) => (PRIORITY[s] > PRIORITY[best] ? s : best), 'idle' as FrogState);
    if (next !== this.current) {
      this.current = next;
      this.listeners.forEach((l) => l(next));
    }
    return this.current;
  }
}
