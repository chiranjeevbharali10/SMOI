/**
 * The speech bubble and the menu panel: two small windows placed around the frog. The frog's own
 * window never moves or resizes for them (docs/adr/0013-desktop-ui-windows-and-api.md).
 *
 * - The bubble window can never take focus (focusable: false), so a bubble never interrupts
 *   typing. Clicks pass through it, except over a pink bubble's x button.
 * - The panel window takes focus when it opens, so Esc and the arrow keys work. On close it is
 *   destroyed (not hidden), which makes Windows give focus back to the app that had it; a new
 *   hidden panel is prepared at once for the next open.
 * - Placement comes from the pure functions in src/shared/layout.ts.
 */
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { BubbleController, type Bubble } from '../shared/bubbles';
import type { PanelConfirm, PanelView } from '../shared/bridge';
import { BUBBLE_INSET, PANEL_INSET, placeBubble, placePanel, type Rect, type Size } from '../shared/layout';
import {
  AVAILABLE_ROWS, HELLO_MOOD, PANEL_ROWS, effectOf, type BubbleLine, type PanelEffect, type PanelEvent, type PanelFacts,
  type PanelRowId,
} from '../shared/panelActions';
import { panelLine, type Voice } from '../shared/voice';

export interface CompanionDeps {
  /** The frog window (its bounds are the anchor), or null while it doesn't exist. */
  frog: () => BrowserWindow | null;
  reducedMotion: () => boolean;
  loadPage: (win: BrowserWindow, page: 'bubble' | 'panel') => void;
  lockDown: (win: BrowserWindow) => void;
  /** Apply a panel effect's frog reaction and open its destination. */
  onEffect: (effect: PanelEffect) => void;
  /** Called when the panel opens or closes, or a pink bubble appears or goes (tray menu). */
  onChange: () => void;
  /** Real data the panel's lines depend on (open tasks, whether voice is on). */
  facts: () => PanelFacts;
  /** "Talk to SMOI" with voice on: turn the microphone on. */
  startVoice: () => void;
  /** The active companion: its name and palette for the panel, its voice for panel lines. */
  identity: () => { name: string; accent: string | null; voice: Voice };
}

const BUBBLE_MEASURE: Size = { width: 300 + 2 * BUBBLE_INSET + 8, height: 260 };
const PANEL_FALLBACK: Size = { width: 300, height: 360 };
/** The design's hard panel shadow: box-shadow 0 6px 0 charcoal. */
const PANEL_SHADOW = 6;

export class Companion {
  readonly bubbles = new BubbleController();
  private bubbleWin!: BrowserWindow;
  private panelWin!: BrowserWindow;
  private preloadDir = '';
  private bubbleSize: Size | null = null;
  private panelSize: Size | null = null;
  private panelOpen = false;
  private mood = HELLO_MOOD;
  private hideTimer: NodeJS.Timeout | null = null;
  /** A voice command waiting for an answer, shown in the panel instead of its rows. */
  private pending: { confirm: PanelConfirm; answer: (yes: boolean) => void } | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CompanionDeps) {}

  create(preloadDir: string): void {
    this.bubbleWin = overlay(join(preloadDir, 'bubble.js'), false, BUBBLE_MEASURE);
    this.preloadDir = preloadDir;
    this.deps.lockDown(this.bubbleWin);
    this.deps.loadPage(this.bubbleWin, 'bubble');
    this.panelWin = this.makePanel();

    this.bubbles.onChange((b) => this.bubbleChanged(b));
    this.tickTimer = setInterval(() => this.bubbles.tick(Date.now()), 250);
    this.wireIpc();
  }

  destroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const w of [this.bubbleWin, this.panelWin]) if (w && !w.isDestroyed()) w.destroy();
  }

  get isPanelOpen(): boolean {
    return this.panelOpen;
  }

  get hasUrgentBubble(): boolean {
    return this.bubbles.current?.tone === 'urgent';
  }

  /** Something is on screen next to the frog (so it shouldn't wander off). */
  get busy(): boolean {
    return this.panelOpen || this.bubbles.current != null;
  }

  say(line: BubbleLine): void {
    this.bubbles.show(line, Date.now());
  }

  dismissUrgent(): void {
    const b = this.bubbles.current;
    if (b?.tone === 'urgent') this.bubbles.dismiss(b.id, Date.now());
  }

  /** Hides passing remarks, for example while the frog is hidden. Pink bubbles stay queued. */
  quiet(): void {
    this.bubbles.clearFading();
    if (this.panelOpen) this.closePanel('silent');
    this.bubbleWin.hide();
  }

  togglePanel(): void {
    if (this.panelOpen) this.closePanel('user');
    else this.openPanel();
  }

  /**
   * Shows what SMOI understood from a voice command, with buttons to go ahead or not
   * (FR-03.06). The panel takes focus, so Enter confirms and Esc cancels. Closing the panel any
   * other way counts as no.
   */
  confirm(confirm: PanelConfirm, answer: (yes: boolean) => void): void {
    this.pending?.answer(false);
    this.pending = { confirm, answer };
    if (this.panelOpen) {
      this.refresh();
      this.panelWin.webContents.send('panel:open', this.view());
      this.panelWin.focus();
      return;
    }
    this.openPanel(false);
  }

  openPanel(greet = true): void {
    const frog = this.deps.frog();
    if (!frog || this.panelOpen) return;
    this.panelOpen = true;
    this.placePanel();
    if (greet) this.apply('hello');
    this.panelWin.webContents.send('panel:open', this.view());
    this.panelWin.show(); // shown active: the panel takes keyboard focus
    this.panelWin.focus();
    this.placeBubble();
    this.deps.onChange();
  }

  /**
   * user: the user closed it (frog click, Esc, tray), so SMOI reacts.
   * navigate: a row opened something else. silent: closed for housekeeping.
   */
  closePanel(reason: 'user' | 'navigate' | 'silent'): void {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    const pending = this.pending;
    this.pending = null;
    pending?.answer(false);
    this.panelWin.setIgnoreMouseEvents(true, { forward: true });
    // Hiding a focused window leaves Windows' focus on it, invisible. Destroying it makes Windows
    // reactivate the window that was active before, which is the app the user was in (the frog
    // and bubble windows can't take focus). A fresh hidden panel is made ready for next time.
    const old = this.panelWin;
    this.panelWin = this.makePanel();
    old.destroy();
    if (reason === 'user') this.apply('closed');
    this.placeBubble();
    this.deps.onChange();
  }

  /** The frog moved (drag, walk, display change): bring the bubble and panel along. */
  follow(): void {
    if (this.panelOpen) this.placePanel();
    this.placeBubble();
  }

  /** A setting changed that the panel shows (reduced motion). */
  refresh(): void {
    this.panelWin.webContents.send('panel:update', this.view());
  }

  // ---------- internals ----------

  private makePanel(): BrowserWindow {
    const win = overlay(join(this.preloadDir, 'panel.js'), true, {
      width: PANEL_FALLBACK.width + 2 * PANEL_INSET.x, height: PANEL_FALLBACK.height + PANEL_INSET.top + PANEL_INSET.bottom,
    });
    this.deps.lockDown(win);
    this.deps.loadPage(win, 'panel');
    return win;
  }

  private apply(event: PanelEvent): void {
    const effect = effectOf(event, AVAILABLE_ROWS, this.deps.facts());
    if (!effect) return; // unavailable row: nothing happens, no line
    this.mood = effect.mood;
    this.deps.onEffect(effect);
    const line = panelLine(this.deps.identity().voice, event, effect.bubble);
    if (line) this.say(line);
    if (this.panelOpen) this.refresh();
  }

  private choose(row: PanelRowId): void {
    const facts = this.deps.facts();
    const effect = effectOf(row, AVAILABLE_ROWS, facts);
    if (!effect) return;
    this.apply(row);
    if (row === 'talk' && facts.voice) {
      this.closePanel('navigate');
      this.deps.startVoice();
    } else if (effect.opens) this.closePanel('navigate');
  }

  private answer(yes: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.closePanel('navigate');
    pending.answer(yes);
  }

  private view(): PanelView {
    const b = this.bubbles.current;
    const who = this.deps.identity();
    return {
      name: who.name,
      accent: who.accent,
      mood: this.mood,
      rows: PANEL_ROWS.map((r) => ({ ...r, available: AVAILABLE_ROWS.has(r.id) })),
      confirm: this.pending?.confirm ?? null,
      reducedMotion: this.deps.reducedMotion(),
      announce: this.panelOpen && b ? b.text : null,
    };
  }

  private anchor(): { frog: Rect; work: Rect } | null {
    const frog = this.deps.frog();
    if (!frog || frog.isDestroyed()) return null;
    const bounds = frog.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const w = display.workArea;
    // At fractional scaling (125%, 150%) Windows rounds window bounds to whole device pixels,
    // which can push a window up to 1 DIP past where it was put. Keep 1 DIP clear of the edges
    // there, so the panel and bubble never overlap the taskbar or the next monitor.
    const m = Number.isInteger(display.scaleFactor) ? 0 : 1;
    return { frog: bounds, work: { x: w.x + m, y: w.y + m, width: w.width - 2 * m, height: w.height - 2 * m } };
  }

  private panelRect(): Rect | null {
    const a = this.anchor();
    if (!a) return null;
    // Leave room for the panel's hard 6px shadow, so it doesn't spill onto the taskbar.
    const work = { ...a.work, height: a.work.height - PANEL_SHADOW };
    return placePanel(a.frog, this.panelSize ?? PANEL_FALLBACK, work);
  }

  private placePanel(): void {
    const p = this.panelRect();
    if (!p) return;
    this.panelWin.setBounds({
      x: p.x - PANEL_INSET.x, y: p.y - PANEL_INSET.top,
      width: p.width + 2 * PANEL_INSET.x, height: p.height + PANEL_INSET.top + PANEL_INSET.bottom,
    });
  }

  private placeBubble(): void {
    const b = this.bubbles.current;
    const a = this.anchor();
    if (!b || !this.bubbleSize || !a) return;
    const p = placeBubble(a.frog, this.bubbleSize, a.work, this.panelOpen ? this.panelRect() : null);
    this.bubbleWin.setBounds({
      x: p.x - BUBBLE_INSET, y: p.y - BUBBLE_INSET,
      width: p.width + 2 * BUBBLE_INSET, height: p.height + 2 * BUBBLE_INSET,
    });
    this.bubbleWin.webContents.send('bubble:placed', { id: b.id, tailX: p.tailX, tail: p.tail });
  }

  private bubbleChanged(b: Bubble | null): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.panelOpen) this.refresh(); // repeat the line in the focused panel's live region
    this.deps.onChange();
    if (!b) {
      this.bubbleWin.webContents.send('bubble:hide');
      this.bubbleWin.setIgnoreMouseEvents(true, { forward: true });
      this.hideTimer = setTimeout(() => this.bubbleWin.hide(), this.deps.reducedMotion() ? 0 : 220);
      return;
    }
    this.bubbleSize = null;
    if (!this.bubbleWin.isVisible()) {
      // Big enough to measure a bubble at its 300px maximum width.
      const a = this.anchor();
      this.bubbleWin.setBounds({ x: a?.work.x ?? 0, y: a?.work.y ?? 0, ...BUBBLE_MEASURE });
    }
    this.bubbleWin.webContents.send('bubble:show', { id: b.id, tone: b.tone, text: b.text, reducedMotion: this.deps.reducedMotion() });
  }

  private wireIpc(): void {
    const from = (win: () => BrowserWindow) => (e: IpcMainEvent) => e.sender === win().webContents;
    const isBubble = from(() => this.bubbleWin);
    const isPanel = from(() => this.panelWin);

    ipcMain.on('bubble:ready', (e) => {
      if (isBubble(e) && this.bubbles.current) this.bubbleChanged(this.bubbles.current);
    });
    ipcMain.on('bubble:measured', (e, id: unknown, size: unknown) => {
      if (!isBubble(e) || id !== this.bubbles.current?.id || !isSize(size)) return;
      this.bubbleSize = size;
      this.placeBubble();
      if (!this.bubbleWin.isVisible()) this.bubbleWin.showInactive();
    });
    ipcMain.on('bubble:dismiss', (e, id: unknown) => {
      if (isBubble(e) && typeof id === 'number') this.bubbles.dismiss(id, Date.now());
    });
    ipcMain.on('bubble:hit', (e, over: unknown) => {
      if (isBubble(e)) this.bubbleWin.setIgnoreMouseEvents(over !== true, { forward: true });
    });

    ipcMain.on('panel:ready', (e) => {
      if (isPanel(e)) this.refresh(); // draws it hidden, so it can be measured before first open
    });
    ipcMain.on('panel:measured', (e, size: unknown) => {
      if (!isPanel(e) || !isSize(size)) return;
      this.panelSize = size;
      if (this.panelOpen) this.follow();
    });
    ipcMain.on('panel:choose', (e, row: unknown) => {
      if (isPanel(e) && this.panelOpen && PANEL_ROWS.some((r) => r.id === row)) this.choose(row as PanelRowId);
    });
    ipcMain.on('panel:answer', (e, yes: unknown) => {
      if (isPanel(e) && this.panelOpen && typeof yes === 'boolean') this.answer(yes);
    });
    ipcMain.on('panel:close', (e) => {
      if (isPanel(e)) this.closePanel('user');
    });
    ipcMain.on('panel:hit', (e, over: unknown) => {
      if (isPanel(e)) this.panelWin.setIgnoreMouseEvents(over !== true, { forward: true });
    });
  }
}

function isSize(v: unknown): v is Size {
  const s = v as Size;
  return !!s && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0
    && s.width < 2000 && s.height < 2000;
}

function overlay(preload: string, focusable: boolean, size: Size): BrowserWindow {
  const win = new BrowserWindow({
    ...size,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, focusable,
    backgroundColor: '#00000000',
    title: focusable ? 'SMOI panel' : 'SMOI speech bubble',
    webPreferences: {
      preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      // These windows are hidden most of the time but must still measure and respond at once.
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  return win;
}
