/**
 * SMOI's animations: one PNG strip per state (assets/sprites/<state>.png), each a single row of
 * 64x64 transparent cells, with per-frame durations in milliseconds from the design.
 */
export const CELL = 64;

export type FrogState =
  | 'idle' | 'happy' | 'sleeping' | 'working' | 'thinking' | 'surprised'
  | 'annoyed' | 'celebrating' | 'listening' | 'speaking' | 'walking' | 'error'
  /** DRAFT, not yet in the design board: Claude Code is blocked waiting for permission (FR-10.04). */
  | 'attention';

export interface Animation {
  /** Milliseconds each frame is shown, in strip order. */
  frames: readonly number[];
  /** Loops, or plays once and stops on the last frame. */
  loop: boolean;
}

const repeat = (ms: number, n: number): number[] => Array.from({ length: n }, () => ms);

export const ANIMATIONS: Record<FrogState, Animation> = {
  idle: { frames: [180, 180, 220, 220, 180, 90, 180, 260, 260, 260, 260, 90], loop: true },
  happy: { frames: repeat(120, 6), loop: true },
  sleeping: { frames: repeat(260, 8), loop: true },
  working: { frames: repeat(130, 6), loop: true },
  thinking: { frames: repeat(240, 6), loop: true },
  surprised: { frames: [100, 120, 140, 120, 120, 300], loop: false },
  annoyed: { frames: [260, 200, 200, 260, 110, 260], loop: true },
  celebrating: { frames: repeat(110, 8), loop: true },
  listening: { frames: repeat(200, 6), loop: true },
  speaking: { frames: repeat(120, 6), loop: true },
  walking: { frames: [100, 90, 90, 100, 90, 90], loop: true },
  error: { frames: repeat(170, 6), loop: true },
  attention: { frames: [220, 140, 220, 140, 220, 500], loop: true },
};

export const STATES = Object.keys(ANIMATIONS) as FrogState[];

/** States whose art was drawn for SMOI rather than extracted from the design board. */
export const DRAFT_STATES: readonly FrogState[] = ['attention'];

export function totalDuration(state: FrogState): number {
  return ANIMATIONS[state].frames.reduce((a, b) => a + b, 0);
}

/**
 * Which frame to show `elapsed` ms after the animation started. A one-shot animation holds its
 * last frame once it has finished.
 */
export function frameAt(state: FrogState, elapsed: number): { index: number; finished: boolean } {
  const { frames, loop } = ANIMATIONS[state];
  const total = totalDuration(state);
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

/** The still frame shown when reduced motion is on: the first frame, a neutral pose in every strip. */
export const STILL_FRAME = 0;
