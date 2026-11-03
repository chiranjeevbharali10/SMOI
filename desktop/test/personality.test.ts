import { describe, expect, it } from 'vitest';
import { clampPersonality, PRESETS, react, styleOf, type Personality } from '../src/shared/personality';

const p = (over: Partial<Personality> = {}): Personality => ({ humour: 0, sarcasm: 0, friendliness: 0, strictness: 2, ...over });

describe('style', () => {
  it('follows the sliders: sarcasm, then humour, then friendliness', () => {
    expect(styleOf(p())).toBe('plain');
    expect(styleOf(p({ friendliness: 3 }))).toBe('warm');
    expect(styleOf(p({ friendliness: 4, humour: 3 }))).toBe('playful');
    expect(styleOf(p({ humour: 4, sarcasm: 3 }))).toBe('cheeky');
  });
});

describe('lines keep the facts in every style', () => {
  const all: Personality[] = [
    ...Object.values(PRESETS).map((x) => x.values),
    p(), p({ friendliness: 4 }), p({ humour: 4 }), p({ sarcasm: 4 }),
  ];

  it.each(all)('%o', (personality) => {
    expect(react({ type: 'reminder', title: 'Call mum', missed: false }, personality).line?.text).toContain('“Call mum”');
    expect(react({ type: 'task_saved', title: 'Buy milk' }, personality).line?.text).toContain('“Buy milk”');
    expect(react({ type: 'reminder_saved', title: 'Stretch', when: 'Tue 4 Nov, 15:00' }, personality).line?.text)
      .toContain('Tue 4 Nov, 15:00');
    expect(react({ type: 'indexed', count: 3 }, personality).line?.text).toContain('3 documents are indexed');
    if (personality.strictness > 0) {
      expect(react({ type: 'overdue', count: 1 }, personality).line?.text).toContain('1 task is overdue');
    }
  });

  it('says a reminder was missed when it was', () => {
    expect(react({ type: 'reminder', title: 'x', missed: true }, p()).line?.text).toBe('Missed reminder: “x”.');
  });
});

describe('strictness', () => {
  it('makes reminders stay until dismissed from 2 up', () => {
    expect(react({ type: 'reminder', title: 'x', missed: false }, p({ strictness: 2 })).line?.tone).toBe('urgent');
    expect(react({ type: 'reminder', title: 'x', missed: false }, p({ strictness: 1 })).line?.tone).toBe('nudge');
  });

  it('at 0, SMOI doesn’t nag about overdue tasks', () => {
    expect(react({ type: 'overdue', count: 5 }, p({ strictness: 0 })).line).toBeNull();
  });

  it('never claims overdue tasks when there are none', () => {
    expect(react({ type: 'overdue', count: 0 }, p({ strictness: 4 })).line).toBeNull();
  });
});

describe('validation', () => {
  it('accepts whole numbers from 0 to 4 only', () => {
    expect(clampPersonality({ humour: 1, sarcasm: 2, friendliness: 3, strictness: 4 })).not.toBeNull();
    expect(clampPersonality({ humour: 5, sarcasm: 2, friendliness: 3, strictness: 4 })).toBeNull();
    expect(clampPersonality({ humour: 1.5, sarcasm: 2, friendliness: 3, strictness: 4 })).toBeNull();
    expect(clampPersonality('loud')).toBeNull();
  });
});
