/**
 * The desktop check (development builds only; started by scripts/desktop-check.ts). It drives the
 * real app with real mouse and keyboard input through scripts/win-helper.ps1, against another
 * real app (the test window), and records what happened. It checks:
 *
 * - the frog doesn't move by a single pixel and stays crisp (every art pixel an even square)
 *   while the bubble and panel open and close;
 * - opening the panel takes focus from the test window; Esc closes it and the test window gets focus back;
 * - bubbles never take focus;
 * - clicks on empty space around the frog and the panel reach the app underneath;
 * - optionally: a question asked from the frog, answered, and its first cited source opened.
 */
import { app, BrowserWindow, screen } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PNG } from 'pngjs';
import { CELL, STILL_FRAME } from '../shared/animations';
import { frogSize } from '../shared/scaling';
import { BUBBLE_INSET, PANEL_INSET } from '../shared/layout';
import type { Companion } from './companion';
import type { Dashboard } from './dashboard';
import type { FrogStateMachine } from '../shared/stateMachine';
import type { Session } from './session';
import type { ApiClient } from './api';

export interface E2eContext {
  frog: () => BrowserWindow | null;
  companion: Companion;
  dashboard: Dashboard;
  machine: FrogStateMachine;
  session: Session;
  api: ApiClient;
  updateSettings: (patch: Record<string, unknown>) => unknown;
  spriteDir: string;
  /** Moves the frog to the bottom-right of a display, resized for its scale. */
  moveFrogTo: (displayId: number) => void;
}

interface Step {
  name: string;
  pass: boolean | null; // null = skipped
  detail: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Helper {
  /** Moves the pointer there, lets the app see the hover, then clicks: as a person does. */
  async hoverClick(x: number, y: number) {
    await this.cmd(`move ${x} ${y}`);
    await sleep(150);
    await this.cmd(`move ${x + 1} ${y}`);
    await sleep(350);
    await this.cmd(`click ${x + 1} ${y}`);
  }

  private proc: ChildProcessWithoutNullStreams;
  private lines: string[] = [];
  private waiting: ((l: string) => void)[] = [];

  constructor(script: string) {
    this.proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
    createInterface({ input: this.proc.stdout }).on('line', (l) => {
      const w = this.waiting.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
  }

  cmd(line: string): Promise<string> {
    this.proc.stdin.write(line + '\n');
    return new Promise((resolve) => {
      const l = this.lines.shift();
      if (l !== undefined) resolve(l);
      else this.waiting.push(resolve);
    });
  }

  async fg(): Promise<bigint> {
    return BigInt(await this.cmd('fg'));
  }

  quit() {
    this.proc.stdin.write('quit\n');
  }
}

/** The panel window is replaced each time it closes, so look it up each time. */
const panelWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === 'SMOI panel')!;
const hwnd = (w: BrowserWindow) => w.getNativeWindowHandle().readBigUInt64LE(0);
const phys = (r: Electron.Rectangle) => screen.dipToScreenRect(null, r);

export async function runE2e(ctx: E2eContext, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const steps: Step[] = [];
  const record = (name: string, pass: boolean | null, detail: string) => {
    steps.push({ name, pass, detail });
    console.log(`[e2e] ${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };
  let stopTarget = () => {};
  const helper = new Helper(join(app.getAppPath(), 'scripts', 'win-helper.ps1'));
  const label = process.env.SMOI_E2E_LABEL ?? 'run';
  const sprite = PNG.sync.read(readFileSync(join(ctx.spriteDir, 'idle.png')));
  const alpha = (x: number, y: number) => sprite.data[(y * sprite.width + STILL_FRAME * CELL + x) * 4 + 3];
  const capture = async (name: string, r: Electron.Rectangle) => {
    const path = join(outDir, `${name}.png`);
    await helper.cmd(`capture ${r.x} ${r.y} ${r.width} ${r.height} ${path}`);
    return PNG.sync.read(readFileSync(path));
  };
  // An opaque art pixel near the middle of the frog, and a transparent one near a corner.
  let solid = { x: 32, y: 40 };
  for (let r = 0; r < 20 && alpha(solid.x, solid.y) !== 255; r++) solid = { x: 32, y: 40 + r };
  const empty = alpha(1, 1) === 0 ? { x: 1, y: 1 } : { x: 62, y: 1 };
  const bubbleWin = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === 'SMOI speech bubble')!;
  const waitIdle = async () => {
    for (let i = 0; i < 60 && ctx.machine.state !== 'idle'; i++) await sleep(250);
    await sleep(500);
  };

  /** Every check that doesn't need a particular display, run where the frog is now. */
  const checkHere = async (where: string, other: bigint, clickThrough: boolean) => {
    const frog = ctx.frog()!;
    const display = screen.getDisplayMatching(frog.getBounds());
    const scale = display.scaleFactor;
    const { multiple } = frogSize(scale);
    const tag = `${where}, ${Math.round(scale * 100)}%`;
    const frogDip = frog.getBounds();
    const frogPhys = phys(frogDip);
    const frogArea = { x: frogPhys.x, y: frogPhys.y, width: CELL * multiple, height: CELL * multiple };
    const artToScreen = (ax: number, ay: number) => ({
      x: frogPhys.x + ax * multiple + Math.floor(multiple / 2),
      y: frogPhys.y + ay * multiple + Math.floor(multiple / 2),
    });
    const file = `${label}-${where.replace(/\W+/g, '-')}`;
    await waitIdle();

    // Crisp: every opaque art pixel is an even square of identical device pixels.
    const before = await capture(`frog-before-${file}`, frogArea);
    let bad = 0;
    let opaque = 0;
    for (let ay = 0; ay < CELL; ay++) {
      for (let ax = 0; ax < CELL; ax++) {
        if (alpha(ax, ay) !== 255) continue;
        opaque++;
        const at = (x: number, y: number) => before.data.readUInt32BE(((ay * multiple + y) * before.width + ax * multiple + x) * 4);
        const first = at(0, 0);
        for (let y = 0; y < multiple; y++) for (let x = 0; x < multiple; x++) if (at(x, y) !== first) bad++;
      }
    }
    record(`[${tag}] Frog is crisp (${multiple}x${multiple} device pixels per art pixel)`, bad === 0,
      `${opaque} opaque art pixels checked, ${bad} device pixels differ within their square`);

    // Open the panel with a real click: it opens and takes keyboard focus.
    const fc = artToScreen(solid.x, solid.y);
    await helper.hoverClick(fc.x, fc.y);
    await sleep(900);
    const opened = ctx.companion.isPanelOpen && panelWindow().isVisible();
    record(`[${tag}] Clicking the frog opens the panel`, opened, `open=${ctx.companion.isPanelOpen}`);
    if (!opened) return fc; // the remaining checks need the panel
    record(`[${tag}] The open panel has keyboard focus`, (await helper.fg()) === hwnd(panelWindow()),
      `foreground ${await helper.fg()}, panel ${hwnd(panelWindow())}`);
    record(`[${tag}] The hello bubble is showing`, bubbleWin().isVisible(), ctx.companion.bubbles.current?.text ?? 'none');
    const pr = panelWindow().getBounds();
    const w = display.workArea;
    const on = (r: Electron.Rectangle) => r.x >= w.x && r.y >= w.y && r.x + r.width <= w.x + w.width && r.y + r.height <= w.y + w.height;
    // The visible panel and bubble, without the transparent margins of their windows.
    const panelBox = { x: pr.x + PANEL_INSET.x, y: pr.y + PANEL_INSET.top, width: pr.width - 2 * PANEL_INSET.x, height: pr.height - PANEL_INSET.top - PANEL_INSET.bottom };
    const bb = bubbleWin().getBounds();
    const bubbleBox = { x: bb.x + BUBBLE_INSET, y: bb.y + BUBBLE_INSET, width: bb.width - 2 * BUBBLE_INSET, height: bb.height - 2 * BUBBLE_INSET };
    record(`[${tag}] Panel and bubble are fully on the frog's display`, on(panelBox) && on(bubbleBox),
      `panel ${JSON.stringify(panelBox)}, bubble ${JSON.stringify(bubbleBox)}, work area ${JSON.stringify(w)}`);

    // A real desktop screenshot of the frog, bubble and panel together.
    await sleep(400);
    const rs = [frogPhys, phys(pr), phys(bubbleWin().getBounds())];
    const x = Math.min(...rs.map((r) => r.x)) - 10;
    const y = Math.min(...rs.map((r) => r.y)) - 10;
    await capture(`desktop-panel-${file}`, {
      x, y, width: Math.max(...rs.map((r) => r.x + r.width)) - x + 10, height: Math.max(...rs.map((r) => r.y + r.height)) - y + 10,
    });

    // The frog didn't move: same window bounds, same device pixels (once the happy reaction ends).
    await waitIdle();
    const during = await capture(`frog-with-panel-${file}`, frogArea);
    const differs = diffOpaque(before, during, alpha, multiple);
    record(`[${tag}] Frog doesn't shift by a pixel while the bubble and panel are open`,
      differs === 0 && sameRect(frog.getBounds(), frogDip), `${differs} device pixels of the frog changed; bounds ${JSON.stringify(frog.getBounds())}`);

    // Arrow keys, then Esc, with real key presses.
    await helper.cmd('key down');
    await sleep(200);
    const focusedRow = await panelWindow().webContents.executeJavaScript('document.activeElement && document.activeElement.textContent');
    record(`[${tag}] Arrow keys move through the rows`, /View tasks/.test(String(focusedRow)), `focused: ${String(focusedRow).trim()}`);
    await helper.cmd('key esc');
    await sleep(700);
    record(`[${tag}] Esc closes the panel`, !ctx.companion.isPanelOpen && !panelWindow().isVisible(), `open=${ctx.companion.isPanelOpen}`);
    record(`[${tag}] Closing the panel hands focus back to the other app`, (await helper.fg()) === other,
      `foreground ${await helper.fg()}, other app ${other}`);

    // Bubbles never take focus.
    ctx.companion.say({ tone: 'urgent', text: 'Desktop check: this bubble must not take focus.' });
    await sleep(900);
    record(`[${tag}] A bubble appears without taking focus`, bubbleWin().isVisible() && (await helper.fg()) === other,
      `foreground ${await helper.fg()}`);
    ctx.companion.dismissUrgent();
    await sleep(400);

    if (clickThrough) {
      // Clicks on empty space reach the app underneath, with the panel open.
      await helper.hoverClick(fc.x, fc.y);
      await sleep(900);
      let open = ctx.companion.isPanelOpen;
      const pb = phys(panelWindow().getBounds());
      await helper.hoverClick(pb.x + 2, pb.y + Math.round(pb.height / 2));
      await sleep(600);
      record(`[${tag}] With the panel open, a click on the empty edge of its window reaches the app underneath`,
        open && ctx.companion.isPanelOpen && (await helper.fg()) === other, `panel open=${open}, foreground ${await helper.fg()}`);
      const ec = artToScreen(empty.x, empty.y);
      await helper.cmd(`activate ${hwnd(panelWindow())}`);
      await sleep(300);
      open = ctx.companion.isPanelOpen;
      await helper.hoverClick(ec.x, ec.y);
      await sleep(600);
      record(`[${tag}] With the panel open, a click on a transparent pixel of the frog window reaches the app underneath`,
        open && (await helper.fg()) === other, `panel open=${open}, foreground ${await helper.fg()}`);
      if (ctx.companion.isPanelOpen) ctx.companion.closePanel('silent');
      await sleep(500);
    }
    return fc;
  };

  try {
    ctx.updateSettings({ reducedMotion: true, walking: false, sleepAfterMinutes: 60 });
    await sleep(1500);

    // "Another app": a plain maximized window in its own process, behind the frog.
    const target = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(app.getAppPath(), 'scripts', 'check-target.ps1')]);
    stopTarget = () => target.kill();
    const other = await new Promise<bigint>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The test window did not start')), 20000);
      createInterface({ input: target.stdout }).once('line', (l) => { clearTimeout(t); resolve(BigInt(l)); });
    });
    await sleep(800);
    await helper.cmd(`activate ${other}`);
    await sleep(800);
    // Wake SMOI if the machine has been idle.
    const fp = phys(ctx.frog()!.getBounds());
    await helper.cmd(`move ${fp.x - 300} ${fp.y - 300}`);
    record('The other app has focus before the test', (await helper.fg()) === other, `foreground ${await helper.fg()}, other app ${other}`);

    const fc = await checkHere('first display', other, true);

    const question = process.env.SMOI_E2E_QUESTION;
    if (question) await askFromFrog(ctx, helper, question, fc, outDir, record);

    // Across monitors: move the frog to each other display and check again there.
    const home = screen.getDisplayMatching(ctx.frog()!.getBounds());
    const others = screen.getAllDisplays().filter((d) => d.id !== home.id);
    if (others.length === 0) record('Across monitors', null, 'only one display is connected, so this was not tested');
    for (const [i, d] of others.entries()) {
      ctx.moveFrogTo(d.id);
      await sleep(1500);
      await helper.cmd(`activate ${other}`);
      await sleep(500);
      // The other app stays on the first display, so clicks on empty space there aren't checked.
      await checkHere(`display ${i + 2}`, other, false);
    }
    ctx.moveFrogTo(home.id);
    await sleep(800);
  } catch (e) {
    record('Desktop check', false, e instanceof Error ? e.message : String(e));
  } finally {
    helper.quit();
    stopTarget();
    writeFileSync(join(outDir, `results-${label}.json`), JSON.stringify({ label, steps }, null, 2));
    app.quit();
  }
}

async function askFromFrog(ctx: E2eContext, helper: Helper, question: string, fc: { x: number; y: number }, outDir: string,
                           record: (n: string, p: boolean | null, d: string) => void) {
  await helper.hoverClick(fc.x, fc.y);
  await sleep(900);
  await helper.cmd('key enter'); // "Talk to SMOI", the first row, has focus
  let dash: BrowserWindow | null = null;
  for (let i = 0; i < 40 && !dash; i++) {
    await sleep(250);
    dash = ctx.dashboard.window;
  }
  if (!dash) return record('Talk to SMOI opens the chat', false, 'no dashboard window');
  await sleep(1500);
  const active = await dash.webContents.executeJavaScript('document.activeElement && document.activeElement.id');
  record('Talk to SMOI opens the chat with the question box focused (2 interactions)', active === 'ask' && (await helper.fg()) === hwnd(dash),
    `focused element: ${active}`);
  await helper.cmd(`type ${question}`);
  await helper.cmd('key enter');
  const started = Date.now();
  let status = '';
  for (;;) {
    await sleep(1000);
    status = await dash.webContents.executeJavaScript(`(() => {
      const a = [...document.querySelectorAll('article.answer')].pop();
      return a && a.getAttribute('aria-busy') === 'false' ? a.querySelector('.answer-status').textContent : '';
    })()`);
    if (status || Date.now() - started > 300_000) break;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  record('The question is answered', status === 'Answer', `status "${status || 'none'}" after ${seconds} s`);
  await writePng(dash, join(outDir, 'dashboard-answer.png'));
  const rect = await dash.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.sources button');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent };
  })()`);
  if (!rect) return record('Open a cited source', false, 'the answer has no citations');
  const content = dash.getContentBounds();
  const p = screen.dipToScreenPoint({ x: content.x + rect.x, y: content.y + rect.y });
  await helper.hoverClick(Math.round(p.x), Math.round(p.y));
  await sleep(2000);
  const cited = await dash.webContents.executeJavaScript(
    `(() => { const c = document.querySelector('[role=dialog] .chunk.cited .plain'); return c ? c.textContent.slice(0, 120) : ''; })()`);
  record('Clicking a citation opens the cited passage', cited.length > 0, `${rect.text} -> "${cited}…"`);
  await writePng(dash, join(outDir, 'dashboard-source.png'));
}

async function writePng(win: BrowserWindow, path: string) {
  writeFileSync(path, (await win.webContents.capturePage()).toPNG());
}

function sameRect(a: Electron.Rectangle, b: Electron.Rectangle) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Device pixels that differ between two captures, counting only the frog's opaque art pixels. */
function diffOpaque(a: PNG, b: PNG, alpha: (x: number, y: number) => number, multiple: number): number {
  let n = 0;
  for (let ay = 0; ay < CELL; ay++) {
    for (let ax = 0; ax < CELL; ax++) {
      if (alpha(ax, ay) !== 255) continue;
      for (let y = 0; y < multiple; y++) {
        for (let x = 0; x < multiple; x++) {
          const i = ((ay * multiple + y) * a.width + ax * multiple + x) * 4;
          if (a.data.readUInt32BE(i) !== b.data.readUInt32BE(i)) n++;
        }
      }
    }
  }
  return n;
}
