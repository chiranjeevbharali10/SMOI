// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialAnswer, reduceAnswer } from '../src/shared/answer';
import type { AnswerResult, ChunkInfo } from '../src/shared/apiTypes';
import type { DashboardBridge } from '../src/shared/bridge';
import { AVAILABLE_ROWS, PANEL_ROWS } from '../src/shared/panelActions';
import { BubbleView } from '../src/renderer/components/BubbleView';
import { PanelView } from '../src/renderer/components/PanelView';
import { AnswerBlock } from '../src/renderer/dashboard/AnswerBlock';
import { SourceViewer } from '../src/renderer/dashboard/SourceViewer';

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

/** Retrieved content written to attack an HTML renderer: markup, an image link, a URL. */
const HOSTILE = [
  '<img src="https://evil.example/pixel.png" onerror="alert(1)">',
  '![tracker](https://evil.example/t.png)',
  '<a href="https://evil.example">click me</a>',
  '<script>alert(2)</script>',
  'Visit https://evil.example/phish now.',
].join('\n');

const source = { label: 'S1', chunkId: 'c1', documentId: 'd1', filename: 'notes.txt', chunkIndex: 1, pageStart: null, pageEnd: null, section: null };

function expectInert(container: HTMLElement) {
  expect(container.querySelectorAll('img, a, script, iframe')).toHaveLength(0);
}

describe('retrieved content is plain text', () => {
  it('an answer containing HTML and an image link shows the characters, loads nothing, links nothing', () => {
    const result: AnswerResult = {
      outcome: 'answered', answer: HOSTILE, message: null, citations: [source], invalidCitations: [], refusalCategory: null,
      provider: 'ollama', model: 'm', mode: 'hybrid', sourcesGiven: 1, excludedDocuments: 0, omittedForContext: 0,
      truncated: false, passages: null,
    };
    const view = reduceAnswer(initialAnswer, { type: 'result', result });
    render(<AnswerBlock view={view} onOpenSource={() => {}} />);
    const text = screen.getByTestId('answer-text');
    expect(text.textContent).toBe(HOSTILE);
    expectInert(text);
  });

  it('LLM-fallback passages are plain text too', () => {
    const result: AnswerResult = {
      outcome: 'llm_unavailable', answer: null, message: null, citations: null, invalidCitations: null, refusalCategory: null,
      provider: null, model: null, mode: 'hybrid', sourcesGiven: 1, excludedDocuments: 0, omittedForContext: 0,
      truncated: false, passages: [{ ...source, content: HOSTILE }],
    };
    render(<AnswerBlock view={reduceAnswer(initialAnswer, { type: 'result', result })} onOpenSource={() => {}} />);
    const text = screen.getByTestId('passage-text');
    expect(text.textContent).toBe(HOSTILE);
    expectInert(text);
  });

  it('a chunk with HTML and an image link, opened in the source viewer, is plain text', async () => {
    const chunks: ChunkInfo[] = [0, 1, 2].map((i) => ({
      id: `c${i}`, index: i, content: i === 1 ? HOSTILE : `Chunk ${i}`, pageStart: null, pageEnd: null, section: null,
      tokenCount: 10, embeddingModel: 'nomic-embed-text',
    }));
    window.smoiDashboard = { chunks: vi.fn(async () => ({ ok: true as const, value: chunks })) } as unknown as DashboardBridge;
    render(<SourceViewer source={source} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('chunk-text')).toHaveLength(3));
    const cited = screen.getAllByTestId('chunk-text')[1];
    expect(cited.textContent).toBe(HOSTILE);
    expect(cited.closest('.chunk')!.classList.contains('cited')).toBe(true);
    expectInert(document.querySelector('.chunks') as HTMLElement);
  });

  it('the source viewer closes with Esc', async () => {
    window.smoiDashboard = { chunks: vi.fn(async () => ({ ok: true as const, value: [] })) } as unknown as DashboardBridge;
    const onClose = vi.fn();
    render(<SourceViewer source={source} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('menu panel', () => {
  // Every row is available since Phase 8; two are switched off here to test how an unavailable row looks.
  const rows = PANEL_ROWS.map((r) => ({ ...r, available: r.id !== 'calendar' && r.id !== 'inbox' }));

  it('every row is available now', () => {
    expect(PANEL_ROWS.every((r) => AVAILABLE_ROWS.has(r.id))).toBe(true);
  });

  it('shows SMOI, the mood and seven rows; unavailable rows say so, with aria-disabled', () => {
    render(<PanelView mood="feeling chatty" rows={rows} onChoose={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'SMOI' })).toBeTruthy();
    expect(screen.getByText('feeling chatty')).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(7);
    for (const name of ['Open calendar', 'Check inbox']) {
      const b = screen.getByRole('button', { name: new RegExp(name) });
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.textContent).toContain('Not available yet');
      expect(b.hasAttribute('disabled')).toBe(false); // still reachable by keyboard
    }
    expect(document.body.textContent).not.toMatch(/phase/i);
  });

  it('arrow keys move through every row, including unavailable ones, and wrap', async () => {
    render(<PanelView mood="m" rows={rows} onChoose={() => {}} onClose={() => {}} />);
    const buttons = screen.getAllByRole('button');
    act(() => buttons[0].focus());
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(buttons[1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(buttons[6]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(buttons[0]);
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(buttons[6]);
  });

  it('Enter chooses an available row; an unavailable row does nothing; Esc closes', async () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(<PanelView mood="m" rows={rows} onChoose={onChoose} onClose={onClose} />);
    act(() => screen.getByRole('button', { name: /Open calendar/ }).focus());
    await userEvent.keyboard('{Enter}');
    expect(onChoose).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: 'Open SMOI Brain' }).focus());
    await userEvent.keyboard('{Enter}');
    expect(onChoose).toHaveBeenCalledWith('brain');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('repeats the current line in a live region', () => {
    render(<PanelView mood="m" rows={rows} announce="Welcome to my little office." onChoose={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('Welcome to my little office.');
  });
});

describe('speech bubble', () => {
  it('only pink bubbles have a dismiss button', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<BubbleView tone="nudge" text="Hi." />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<BubbleView tone="finding" text="Found." />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<BubbleView tone="urgent" text="Psst." onDismiss={onDismiss} />);
    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows text as plain text', () => {
    render(<BubbleView tone="nudge" text={'<b>bold?</b>'} />);
    expect(screen.getByTestId('bubble').querySelector('b')).toBeNull();
    expect(screen.getByText('<b>bold?</b>')).toBeTruthy();
  });
});

describe('panel confirm view (voice commands)', () => {
  const rows = PANEL_ROWS.map((r) => ({ ...r, available: AVAILABLE_ROWS.has(r.id) }));
  const confirm = {
    heard: 'remind me to call mum <img src=x onerror=alert(1)> at 6',
    view: { actionable: true, heading: 'Set this reminder?', details: ['“Call mum”', 'Tue 4 Nov, 18:00'], confirmLabel: 'Set reminder' },
  };

  it('shows what was heard as plain text, what will happen, and Confirm and Cancel', async () => {
    const onAnswer = vi.fn();
    render(<PanelView mood="m" rows={rows} confirm={confirm} onAnswer={onAnswer} onChoose={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/I heard:/).textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Set this reminder?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Talk to SMOI/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Set reminder' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
  });

  it('nothing to confirm: only OK', () => {
    const v = { ...confirm, view: { actionable: false, heading: "Drafting emails isn't available yet.", details: [], confirmLabel: null } };
    render(<PanelView mood="m" rows={rows} confirm={v} onAnswer={() => {}} onChoose={() => {}} onClose={() => {}} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['OK']);
  });
});

describe('menu panel for another companion', () => {
  it('shows the companion’s name and its palette accent in the header', () => {
    const rows = PANEL_ROWS.map((r) => ({ ...r, available: true }));
    render(<PanelView name="NOX" accent="#D9CDEC" mood="m" rows={rows} onChoose={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'NOX' })).toBeTruthy();
    expect(screen.getByLabelText('NOX panel')).toBeTruthy();
    expect((screen.getByRole('heading', { name: 'NOX' }).parentElement as HTMLElement).style.background).toBe('rgb(217, 205, 236)');
  });
});

describe('watched folders on the Brain screen', () => {
  const folders = {
    folders: [{ id: 'f1', path: 'C:\Users\me\Notes', total: 300, done: 142, pending: 155, failed: 3, needsOcr: 0 }],
    total: 300, done: 142, pending: 155, failed: 3, needsOcr: 0, ocrEnabled: false,
  };

  it('shows progress and asks the main process to stop watching (which confirms first)', async () => {
    const removeFolder = vi.fn(async () => ({ ok: true as const, value: { removed: true } }));
    window.smoiDashboard = { removeFolder } as unknown as DashboardBridge;
    const { Brain } = await import('../src/renderer/dashboard/Brain');
    render(<Brain docs={[]} folders={folders} exchanges={[]} onAsk={async () => null} focusAsk={0} />);

    expect(screen.getAllByText('142 of 300 indexed, 3 failed')).toHaveLength(2); // the total and the folder
    await userEvent.click(screen.getByRole('button', { name: 'Stop watching C:\Users\me\Notes' }));
    expect(removeFolder).toHaveBeenCalledWith('f1');
  });

  it('offers OCR only when files need it and OCR is on', async () => {
    const { Brain } = await import('../src/renderer/dashboard/Brain');
    const withOcr = { ...folders, needsOcr: 2, ocrEnabled: true };
    const { rerender } = render(<Brain docs={[]} folders={withOcr} exchanges={[]} onAsk={async () => null} focusAsk={0} />);
    expect(screen.getByRole('button', { name: 'Read scanned PDFs with OCR' })).toBeTruthy();
    rerender(<Brain docs={[]} folders={{ ...withOcr, ocrEnabled: false }} exchanges={[]} onAsk={async () => null} focusAsk={0} />);
    expect(screen.queryByRole('button', { name: 'Read scanned PDFs with OCR' })).toBeNull();
  });
});
