import { describe, expect, it } from 'vitest';
import { AVAILABLE_ROWS, FINDING, PANEL_ROWS, effectOf, type PanelRowId } from '../src/shared/panelActions';

describe('panel mapping', () => {
  it('lists the six rows in the design order', () => {
    expect(PANEL_ROWS.map((r) => r.label)).toEqual([
      'Talk to SMOI', 'View tasks', 'Open calendar', 'Check inbox', 'Open SMOI Brain', 'Open dashboard',
    ]);
  });

  it('opening the panel: happy, blue hello, feeling chatty', () => {
    expect(effectOf('hello')).toEqual({
      frog: 'happy', bubble: { tone: 'nudge', text: 'Hi. What are we avoiding today?' }, mood: 'feeling chatty', opens: null,
    });
  });

  it('closing the panel: idle, blue, feeling ignored', () => {
    expect(effectOf('closed')).toEqual({
      frog: 'idle', bubble: { tone: 'nudge', text: 'Fine. I will just sit here. Cutely.' }, mood: 'feeling ignored', opens: null,
    });
  });

  it('Talk to SMOI: idle (not listening, no mic in this phase), opens text chat', () => {
    const e = effectOf('talk')!;
    expect(e.frog).toBe('idle');
    expect(e.bubble).toEqual({ tone: 'nudge', text: 'Go on, type it. I have no ears.' });
    expect(e.mood).toBe('ready to chat');
    expect(e.opens).toBe('chat');
  });

  it('Open SMOI Brain: a brief thinking reaction, no line until something is actually found', () => {
    expect(effectOf('brain')).toEqual({ frog: 'thinking', bubble: null, mood: 'thinking', opens: 'brain' });
    expect(FINDING).toEqual({ tone: 'finding', text: 'I found something interesting for you.' });
  });

  it('Open dashboard: happy, blue, proud', () => {
    expect(effectOf('dashboard')).toEqual({
      frog: 'happy', bubble: { tone: 'nudge', text: 'Welcome to my little office.' }, mood: 'proud', opens: 'dashboard',
    });
  });

  it.each(['tasks', 'calendar', 'inbox'] as PanelRowId[])('%s is not available yet: no effect, no line', (row) => {
    expect(AVAILABLE_ROWS.has(row)).toBe(false);
    expect(effectOf(row)).toBeNull();
  });

  describe('once tasks, calendar and inbox exist', () => {
    const all = new Set<PanelRowId>(PANEL_ROWS.map((r) => r.id));

    it('View tasks uses the real count', () => {
      expect(effectOf('tasks', all, { openTasks: 3 })).toEqual({
        frog: 'working', bubble: { tone: 'nudge', text: "Hey, you've got 3 things to do!" }, mood: 'locked in', opens: null,
      });
      expect(effectOf('tasks', all, { openTasks: 1 })!.bubble!.text).toBe("Hey, you've got 1 thing to do!");
    });

    it('View tasks shows no line without a real count, or with nothing to do', () => {
      expect(effectOf('tasks', all)!.bubble).toBeNull();
      expect(effectOf('tasks', all, { openTasks: 0 })!.bubble).toBeNull();
    });

    it('calendar and inbox are pink, annoyed and surprised', () => {
      expect(effectOf('calendar', all)).toEqual({
        frog: 'annoyed', bubble: { tone: 'urgent', text: 'Your calendar looks suspiciously busy today.' },
        mood: 'judging a little', opens: null,
      });
      expect(effectOf('inbox', all)).toEqual({
        frog: 'surprised', bubble: { tone: 'urgent', text: 'Psst. Someone emailed you.' }, mood: 'startled', opens: null,
      });
    });
  });
});
