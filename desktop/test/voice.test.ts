import { describe, expect, it } from 'vitest';
import { DEFAULT_PERSONALITY, PRESETS } from '../src/shared/personality';
import { fill, fitsVoice, panelLine, reactAs, type Voice } from '../src/shared/voice';

const smoi: Voice = { id: 'smoi', name: 'SMOI', lines: [], eventLines: {} };
const nox: Voice = { id: 'nox', name: 'NOX', lines: ["It's 2am. Bold of you.", 'b', 'c'], eventLines: {} };

describe('companion voice', () => {
  it('SMOI keeps every shared line, frog jokes included', () => {
    const r = reactAs(smoi, { type: 'claude_done', minutes: 12 }, PRESETS.classic.values);
    expect(r.line!.text).toBe('Ribbit! Claude Code finished after 12 min.');
  });

  it('another companion never gets a line that names SMOI or being a frog: it falls back to the plain line', () => {
    const r = reactAs(nox, { type: 'claude_done', minutes: 12 }, PRESETS.classic.values);
    expect(r.line!.text).toBe('Claude Code finished (12 min).');
    expect(r.frog).toBe('celebrating');
    const lily = reactAs(nox, { type: 'task_saved', title: 'Buy milk' }, PRESETS.classic.values);
    expect(lily.line!.text).not.toMatch(/lily|pond|frog/i);
    expect(lily.line!.text).toContain('Buy milk');
  });

  it('uses a companion’s own line when it has one, with the facts filled in', () => {
    const own: Voice = { ...nox, eventLines: { claude_done: 'Claude finished in {duration}. I was hanging around.' } };
    expect(reactAs(own, { type: 'claude_done', minutes: 5 }, DEFAULT_PERSONALITY).line!.text)
      .toBe('Claude finished in 5 min. I was hanging around.');
  });

  it('ignores an own line that would drop a fact', () => {
    const lossy: Voice = { ...nox, eventLines: { reminder: 'Hey, something is due.' } };
    expect(reactAs(lossy, { type: 'reminder', title: 'Call mum', missed: false }, DEFAULT_PERSONALITY).line!.text).toContain('Call mum');
    expect(fill('Due: {title} at {when}', { title: 'x' })).toBeNull();
  });

  it('keeps "no line" when the shared rules say so', () => {
    const quiet = { ...DEFAULT_PERSONALITY, strictness: 0 };
    expect(reactAs(nox, { type: 'overdue', count: 3 }, quiet).line).toBeNull();
  });

  it('says hello with a manifest line, and drops panel lines that only fit SMOI', () => {
    expect(panelLine(nox, 'hello', { tone: 'nudge', text: 'Hi. What are we avoiding today?' }, () => 0)!.text).toBe("It's 2am. Bold of you.");
    expect(panelLine(smoi, 'hello', { tone: 'nudge', text: 'Hi. What are we avoiding today?' })!.text).toBe('Hi. What are we avoiding today?');
    expect(panelLine(nox, 'tasks', { tone: 'nudge', text: 'Pond time, SMOI here.' })).toBeNull();
    expect(fitsVoice(nox, 'Fine. I will just sit here. Cutely.')).toBe(true);
  });
});
