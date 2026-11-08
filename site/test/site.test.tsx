// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerResult, SourceRef } from '@desktop/shared/apiTypes';
import recording from '../src/data/brain-demo.json';
import { App } from '../src/App';
import { companions } from '../src/roster';
import { AskScene, type Recording } from '../src/sections/AskScene';
import { PersonalityScene } from '../src/sections/CharacterScenes';
import { DesktopScene } from '../src/sections/DesktopScene';

let reduced = true;

beforeAll(() => {
  // jsdom has no canvas or media queries: sprites draw nothing, and motion follows `reduced`.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') && reduced,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
beforeEach(() => { reduced = true; });
afterEach(cleanup);

describe('the page', () => {
  it('tells the story in order, one heading per scene', () => {
    render(<App />);
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual([
      'Meet SMOI.',
      'It lives on your desktop.',
      'Ask your files anything.',
      "It remembers so you don't have to.",
      'Your inbox, sorted. Never sent.',
      'Your files never leave your computer.',
      'It has feelings. Lots of them.',
      'Pick your friend.',
      'Pick its personality.',
      'Things SMOI says.',
      'Say hi to SMOI.',
    ]);
  });

  it('never offers a download that does not exist yet', () => {
    render(<App />);
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    expect(screen.getAllByText('Coming soon for Windows')[0].getAttribute('aria-disabled')).toBe('true');
  });

  it('shows every companion from the desktop roster', () => {
    render(<App />);
    expect(companions.map((c) => c.id)).toEqual(['smoi', 'numi', 'nox', 'yuzu', 'wisp']);
    for (const c of companions) expect(screen.getByRole('button', { name: new RegExp(`^${c.name}, the ${c.creature}`) })).toBeTruthy();
  });
});

describe('the desktop scene', () => {
  it('opens the real panel from the frog, and says the app\'s lines', async () => {
    const user = userEvent.setup();
    render(<DesktopScene />);
    await user.click(screen.getByRole('button', { name: 'Click SMOI to open its menu' }));
    const panel = screen.getByTestId('panel');
    expect(screen.getByText('Hi. What are we avoiding today?')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: /View tasks/ }));
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(screen.getByText("Hey, you've got 3 things to do!")).toBeTruthy();
    expect(screen.getByText('In the app, this opens your tasks.')).toBeTruthy();
  });

  it('closes with Esc, and SMOI sulks', async () => {
    const user = userEvent.setup();
    render(<DesktopScene />);
    await user.click(screen.getByRole('button', { name: 'Click SMOI to open its menu' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(screen.getByText('Fine. I will just sit here. Cutely.')).toBeTruthy();
  });
});

describe('the personality scene', () => {
  it('rewords the same events with the chosen preset', async () => {
    const user = userEvent.setup();
    render(<PersonalityScene />);
    expect(screen.getByText('Munched through it: 2 documents are indexed and ready.')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Extra sassy' }));
    expect(screen.getByText("Done reading. 2 documents are indexed. You're welcome.")).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Just the facts' }));
    // Strictness only nags about overdue tasks above 0; "Just the facts" still has strictness 2.
    expect(screen.getByText('2 documents are indexed and ready to search.')).toBeTruthy();
  });
});

const source: SourceRef = {
  label: 'S1', chunkId: 'c1', documentId: 'd1', filename: 'natterjack_toad.txt',
  chunkIndex: 0, pageStart: null, pageEnd: null, section: null,
};
const fixture: Recording = {
  recorded: true,
  script: 'site/scripts/record-demo.ts',
  recordedAt: '2026-11-08T12:00:00Z',
  question: 'Where does the natterjack toad live?',
  provider: 'ollama',
  model: 'qwen3.5:2b-q4_K_M',
  events: [
    { type: 'sources', sources: [source] },
    { type: 'delta', text: 'In sandy heathland [S1].' },
    { type: 'result', result: { outcome: 'answered', answer: 'In sandy heathland [S1].', citations: [source], invalidCitations: [] } as unknown as AnswerResult },
  ],
  passages: { c1: 'The natterjack toad is found in sandy and heathland areas of Europe.' },
};

describe('the ask scene', () => {
  it('with reduced motion, shows the whole recorded answer at once', () => {
    render(<AskScene data={fixture} />);
    expect(screen.getByLabelText('Question').textContent).toBe('Where does the natterjack toad live?');
    expect(screen.getByTestId('answer-text').textContent).toBe('In sandy heathland [S1].');
    expect(screen.getByText(/recorded 8 November 2026 by a local model \(qwen3\.5:2b-q4_K_M\)/)).toBeTruthy();
  });

  it('shows the cited passage from the chip', async () => {
    const user = userEvent.setup();
    render(<AskScene data={fixture} />);
    await user.click(screen.getByRole('button', { name: '[S1] natterjack_toad.txt' }));
    expect(screen.getByRole('tooltip').textContent).toContain('sandy and heathland areas of Europe');
  });

  it('plays it back over time when motion is allowed', async () => {
    reduced = false;
    const timers = await import('vitest').then(({ vi }) => vi);
    timers.useFakeTimers();
    try {
      render(<AskScene data={fixture} />);
      expect(screen.queryByTestId('answer-text')).toBeNull();
      await act(async () => { timers.advanceTimersByTime(20_000); });
      expect(screen.getByTestId('answer-text').textContent).toBe('In sandy heathland [S1].');
    } finally {
      timers.useRealTimers();
    }
  });

  it('says so instead of faking it when nothing is recorded', () => {
    render(<AskScene data={{ recorded: false, script: 'site/scripts/record-demo.ts' }} />);
    expect(screen.getByText("The recorded answer isn't in this build yet.")).toBeTruthy();
  });
});

describe('the recording file', () => {
  it('names the script that made it, and holds an answered result if recorded', () => {
    const r = recording as Recording;
    expect(r.script).toBe('site/scripts/record-demo.ts');
    if (!r.recorded) return;
    expect(r.question).toBeTruthy();
    expect(r.recordedAt).toBeTruthy();
    const last = r.events?.at(-1);
    expect(last?.type).toBe('result');
    if (last?.type === 'result') expect(last.result.outcome).toBe('answered');
  });
});
