/**
 * Animation timing, for any companion. Frame counts, per-frame durations and loop flags come from
 * each companion's manifest (assets/companions/<id>/manifest.json, read by shared/companions.ts);
 * nothing here is specific to one companion.
 */
export const CELL = 64;

/** The 12 states every companion has, in the order of the design's sprite board. */
export const CORE_STATES = [
  'idle', 'happy', 'sleeping', 'working', 'thinking', 'surprised',
  'annoyed', 'celebrating', 'listening', 'speaking', 'walking', 'error',
] as const;

export type CoreState = (typeof CORE_STATES)[number];

/**
 * What the app asks the companion to show. The core states, plus three alerts that each companion
 * maps onto one of its poses (its manifest's alert_poses):
 * - attention: Claude Code is waiting for permission (FR-10.04)
 * - mail: new email since the inbox was last opened
 * - tasks: tasks are overdue
 */
export type FrogState = CoreState | 'attention' | 'mail' | 'tasks';

export const ALERT_STATES = ['attention', 'mail', 'tasks'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export interface Animation {
  /** Milliseconds each frame is shown, in order. */
  frames: readonly number[];
  /** Loops, or plays once and stops on the last frame. */
  loop: boolean;
}

export function totalDuration(a: Animation): number {
  return a.frames.reduce((t, ms) => t + ms, 0);
}

/**
 * Which frame to show `elapsed` ms after the animation started. A one-shot animation holds its
 * last frame once it has finished.
 */
export function frameAt(a: Animation, elapsed: number): { index: number; finished: boolean } {
  const { frames, loop } = a;
  const total = totalDuration(a);
  if (!loop && elapsed >= total) {
    return { index: frames.length - 1, finished: true };
  }
  let t = loop ? ((elapsed % total) + total) % total : Math.max(0, elapsed);
  for (let i = 0; i < frames.length; i++) {
    if (t < frames[i]) return { index: i, finished: false };
    t -= frames[i];
  }
  return { index: frames.length - 1, finished: !loop };
}

/** The still frame shown when reduced motion is on: the first frame, a neutral pose in every row. */
export const STILL_FRAME = 0;
