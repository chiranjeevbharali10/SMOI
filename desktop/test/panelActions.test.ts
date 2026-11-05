import { describe, expect, it } from 'vitest';
import { AVAILABLE_ROWS, FINDING, PANEL_ROWS, effectOf, type PanelRowId } from '../src/shared/panelActions';

describe('panel mapping', () => {
  it('lists the design’s six rows, plus Choose companion before the dashboard', () => {
    expect(PANEL_ROWS.map((r) => r.label)).toEqual([
      'Talk to SMOI', 'View tasks', 'Open calendar', 'Check inbox', 'Open SMOI Brain', 'Choose companion', 'Open dashboard',
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

  it("Talk to SMOI with voice off: idle (SMOI can't hear), opens text chat", () => {
    const e = effectOf('talk')!;
    expect(e.frog).toBe('idle');
    expect(e.bubble).toEqual({ tone: 'nudge', text: 'Go on, type it. I have no ears.' });
    expect(e.mood).toBe('ready to chat');
    expect(e.opens).toBe('chat');
  });

  it("Talk to SMOI with voice on: the design's listening line and mood; the mic sets the listening frog", () => {
    expect(effectOf('talk', AVAILABLE_ROWS, { voice: true })).toEqual({
      frog: 'idle', bubble: { tone: 'nudge', text: "Go on, I'm all ears. Figuratively. I have no ears." }, mood: 'listening', opens: null,
    });
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

  it('View tasks is available, uses the real count and opens the tasks screen', () => {
    expect(AVAILABLE_ROWS.has('tasks')).toBe(true);
    expect(effectOf('tasks', AVAILABLE_ROWS, { openTasks: 3 })).toEqual({
      frog: 'working', bubble: { tone: 'nudge', text: "Hey, you've got 3 things to do!" }, mood: 'locked in', opens: 'tasks',
    });
    expect(effectOf('tasks', AVAILABLE_ROWS, { openTasks: 1 })!.bubble!.text).toBe("Hey, you've got 1 thing to do!");
  });

  it('View tasks shows no line without a real count, or with nothing to do', () => {
    expect(effectOf('tasks')!.bubble).toBeNull();
    expect(effectOf('tasks', AVAILABLE_ROWS, { openTasks: 0 })!.bubble).toBeNull();
  });

  describe('calendar and inbox (Phase 8)', () => {
    it('are available and open their screens', () => {
      expect(AVAILABLE_ROWS.has('calendar')).toBe(true);
      expect(AVAILABLE_ROWS.has('inbox')).toBe(true);
      expect(effectOf('calendar')!.opens).toBe('calendar');
      expect(effectOf('inbox')!.opens).toBe('inbox');
    });

    it('say the busy line only when today really is busy', () => {
      expect(effectOf('calendar', AVAILABLE_ROWS, { busyToday: true })).toEqual({
        frog: 'annoyed', bubble: { tone: 'urgent', text: 'Your calendar looks suspiciously busy today.' },
        mood: 'judging a little', opens: 'calendar',
      });
      expect(effectOf('calendar', AVAILABLE_ROWS, { busyToday: false })!.bubble).toBeNull();
      expect(effectOf('calendar')!.bubble).toBeNull();
    });

    it('say the email line only when new mail arrived, and never what it is', () => {
      expect(effectOf('inbox', AVAILABLE_ROWS, { newEmails: 2 })).toEqual({
        frog: 'surprised', bubble: { tone: 'urgent', text: 'Psst. Someone emailed you.' }, mood: 'startled', opens: 'inbox',
      });
      expect(effectOf('inbox', AVAILABLE_ROWS, { newEmails: 0 })!.bubble).toBeNull();
      expect(effectOf('inbox')!.bubble).toBeNull();
    });
  });
});
