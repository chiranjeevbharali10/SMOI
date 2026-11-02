/**
 * SMOI's Electron main process: the frog window, its speech bubble and menu panel, the dashboard,
 * the tray, and the inputs that choose the frog's state (inactivity, backend health, indexing,
 * answers, occasional walks). It never looks at other windows or apps.
 */
import {
  app, BrowserWindow, ipcMain, Menu, nativeImage, net, powerMonitor, safeStorage, screen, Tray,
} from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FrogStateMachine, type Reaction } from '../shared/stateMachine';
import type { FrogState } from '../shared/animations';
import { windowSize } from '../shared/scaling';
import { movedFar } from '../shared/pointer';
import { FINDING } from '../shared/panelActions';
import type { BackendStatus, UserSettings } from '../shared/bridge';
import { clampToWorkArea, restorePosition, walkStep, type DisplayInfo } from './placement';
import { loadSettings, saveSettings, type Settings } from './settings';
import { ApiClient } from './api';
import { Session } from './session';
import { Companion } from './companion';
import { Dashboard, sessionFile } from './dashboard';
import { runMeasurement } from './measure';

const DEV_SERVER = process.env.SMOI_DEV_SERVER; // set by `npm run dev`
const RENDERER = join(__dirname, '..', '..', 'dist');
const PRELOADS = join(__dirname, '..', 'preload');
const ICONS = join(DEV_SERVER ? join(__dirname, '..', '..', 'assets') : RENDERER, 'icons');

let settings: Settings;
let frog: BrowserWindow | null = null;
let preview: BrowserWindow | null = null;
let tray: Tray | null = null;
let companion: Companion;
let dashboard: Dashboard;
const machine = new FrogStateMachine();
let backendReachable = true;
let walkDirection: 1 | -1 = 1;
let walkTimer: NodeJS.Timeout | null = null;
/** A press on the frog: a click unless the cursor moves far enough to make it a drag. */
let press: { offset: { x: number; y: number }; start: { x: number; y: number }; dragging: boolean; timer: NodeJS.Timeout } | null = null;
const timers: NodeJS.Timeout[] = [];

// ---------- helpers ----------

function displayOf(win: BrowserWindow): DisplayInfo {
  const d = screen.getDisplayMatching(win.getBounds());
  return { id: d.id, workArea: d.workArea, scaleFactor: d.scaleFactor };
}

function allDisplays(): DisplayInfo[] {
  return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, scaleFactor: d.scaleFactor }));
}

function send(channel: string, payload: unknown) {
  if (frog && !frog.isDestroyed()) frog.webContents.send(channel, payload);
}

function pushState(state: FrogState = machine.state) {
  send('frog:state', { state, mirrored: state === 'walking' && walkDirection === -1 });
}

function rememberPosition() {
  if (!frog) return;
  const d = displayOf(frog);
  const [x, y] = frog.getPosition();
  settings.position = { displayId: d.id, x: x - d.workArea.x, y: y - d.workArea.y };
  saveSettings(settings);
}

/** Resizes the window for the display it's on, keeping its bottom edge (its feet) in place. */
function fitToDisplay() {
  if (!frog) return;
  const d = displayOf(frog);
  const size = windowSize(d.scaleFactor);
  const b = frog.getBounds();
  if (b.width !== size) {
    const p = clampToWorkArea(b.x, b.y + b.height - size, size, d);
    frog.setBounds({ x: p.x, y: p.y, width: size, height: size });
  }
  companion.follow();
}

type Page = 'index' | 'preview' | 'bubble' | 'panel' | 'dashboard';
const loadPage = (win: BrowserWindow, page: Page) =>
  void (DEV_SERVER ? win.loadURL(`${DEV_SERVER}/${page}.html`) : win.loadFile(join(RENDERER, `${page}.html`)));

/**
 * No navigation and no new windows from any page. Retrieved content is shown as plain text, so
 * there should be no links to follow; this makes sure that nothing can open one anyway.
 */
function lockDown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  if (!app.isPackaged) {
    const name = win.getTitle();
    win.webContents.on('console-message', (e) => console.log(`[${name} ${e.level}] ${e.message}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[${name}] failed to load ${url}: ${code} ${desc}`));
  }
}

function userSettings(): UserSettings {
  const { reducedMotion, walking, startOnLogin, sleepAfterMinutes, backendUrl } = settings;
  return { reducedMotion, walking, startOnLogin, sleepAfterMinutes, backendUrl };
}

/** Applies a settings change from the tray or the dashboard. Unknown keys and bad values are ignored. */
function updateSettings(patch: Record<string, unknown>): UserSettings {
  for (const key of ['reducedMotion', 'walking', 'startOnLogin'] as const) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  }
  const sleep = patch.sleepAfterMinutes;
  if (typeof sleep === 'number' && Number.isInteger(sleep) && sleep >= 1 && sleep <= 120) settings.sleepAfterMinutes = sleep;
  saveSettings(settings);
  app.setLoginItemSettings({ openAtLogin: settings.startOnLogin });
  if (settings.reducedMotion || !settings.walking) stopWalk();
  send('frog:settings', { reducedMotion: settings.reducedMotion });
  companion.refresh();
  dashboard.settingsChanged(userSettings());
  refreshTrayMenu();
  return userSettings();
}

// ---------- windows ----------

function createFrog() {
  const primary = screen.getPrimaryDisplay();
  const primaryInfo = { id: primary.id, workArea: primary.workArea, scaleFactor: primary.scaleFactor };
  const restored = restorePosition(settings.position, allDisplays(), primaryInfo, windowSize(primary.scaleFactor));
  const size = windowSize(restored.display.scaleFactor);

  frog = new BrowserWindow({
    x: restored.x, y: restored.y, width: size, height: size,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
    // The frog never takes focus: clicking it leaves focus with the app the user was in, and
    // closing the panel returns focus there rather than to the frog.
    focusable: false,
    backgroundColor: '#00000000',
    title: 'SMOI',
    webPreferences: {
      preload: join(PRELOADS, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  frog.setAlwaysOnTop(true, 'floating');
  lockDown(frog);
  // Clicks pass through until the cursor is over an opaque pixel of the frog (see renderer).
  frog.setIgnoreMouseEvents(true, { forward: true });
  // Show as soon as the page has painted: the frog appears without waiting for the backend.
  frog.once('ready-to-show', () => frog?.showInactive());
  frog.on('closed', () => {
    frog = null;
  });
  loadPage(frog, 'index');
}

function openPreview() {
  if (preview && !preview.isDestroyed()) {
    preview.focus();
    return;
  }
  preview = new BrowserWindow({
    width: 980, height: 820, title: 'SMOI animation preview',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lockDown(preview);
  loadPage(preview, 'preview');
}

// ---------- tray ----------

function buildTray() {
  const icon = nativeImage.createFromPath(join(ICONS, 'tray-16.png'));
  icon.addRepresentation({ scaleFactor: 2, dataURL: nativeImage.createFromPath(join(ICONS, 'tray-32.png')).toDataURL() });
  tray = new Tray(icon);
  tray.setToolTip('SMOI');
  tray.on('click', () => companion.togglePanel());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const toggle = (key: 'reducedMotion' | 'walking') => () => updateSettings({ [key]: !settings[key] });
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: frog?.isVisible() ? 'Hide SMOI' : 'Show SMOI',
      click: () => {
        if (frog?.isVisible()) {
          companion.quiet();
          frog.hide();
        } else frog?.showInactive();
        refreshTrayMenu();
      },
    },
    // Keyboard users reach the panel from here (the frog itself never takes focus).
    { label: companion.isPanelOpen ? 'Close SMOI menu' : 'Open SMOI menu', click: () => companion.togglePanel() },
    { label: 'Open dashboard', click: () => dashboard.open('home') },
    { label: "Dismiss SMOI's message", enabled: companion.hasUrgentBubble, click: () => companion.dismissUrgent() },
    { type: 'separator' },
    { label: 'Reduced motion', type: 'checkbox', checked: settings.reducedMotion, click: toggle('reducedMotion') },
    { label: 'Walk along the taskbar', type: 'checkbox', checked: settings.walking,
      enabled: !settings.reducedMotion, click: toggle('walking') },
    { label: 'Start when I log in', type: 'checkbox', checked: settings.startOnLogin,
      click: () => updateSettings({ startOnLogin: !settings.startOnLogin }) },
    { label: 'Move SMOI back to the corner', click: () => {
      settings.position = null;
      saveSettings(settings);
      const p = restorePosition(null, allDisplays(), displayOf(frog!), frog!.getBounds().width);
      frog?.setPosition(p.x, p.y);
      companion.follow();
    } },
  ];
  if (!app.isPackaged) {
    template.push({ type: 'separator' }, { label: 'Animation preview (dev)', click: openPreview });
  }
  template.push({ type: 'separator' }, { label: 'Quit SMOI', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ---------- behaviour inputs ----------

/** Sleeping after a period without keyboard or mouse input (the OS idle timer; nothing else is watched). */
function watchInactivity() {
  timers.push(setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime() >= settings.sleepAfterMinutes * 60;
    if (idle !== machine.isActive('sleeping')) machine.set('sleeping', idle, Date.now());
  }, 5000));
}

function backendStatus(): BackendStatus {
  return { reachable: backendReachable, url: settings.backendUrl };
}

/** Error while the backend is unreachable, after a grace period so a starting backend isn't an error. */
function watchBackend() {
  let failures = 0;
  const check = async () => {
    try {
      const res = await net.fetch(`${settings.backendUrl}/livez`, { signal: AbortSignal.timeout(3000) });
      failures = res.ok ? 0 : failures + 1;
    } catch {
      failures += 1;
    }
    const down = failures >= 3;
    if (down !== machine.isActive('error')) machine.set('error', down, Date.now());
    const reachable = failures === 0;
    if (reachable !== backendReachable) {
      backendReachable = reachable;
      dashboard.backendChanged(backendStatus());
    }
  };
  void check();
  timers.push(setInterval(check, 10_000));
}

/** Occasional short walks when SMOI is idle and nothing is showing next to it. */
function scheduleWalk() {
  const delay = 90_000 + Math.random() * 150_000;
  timers.push(setTimeout(() => {
    if (settings.walking && !settings.reducedMotion && machine.state === 'idle' && frog?.isVisible()
        && !press && !companion.busy) {
      startWalk();
    }
    scheduleWalk();
  }, delay));
}

function startWalk() {
  if (!frog) return;
  walkDirection = Math.random() < 0.5 ? -1 : 1;
  machine.set('walking', true, Date.now());
  let steps = 0;
  walkTimer = setInterval(() => {
    if (!frog || machine.state !== 'walking' || steps++ > 40 || companion.busy) return stopWalk();
    const d = displayOf(frog);
    const [x, y] = frog.getPosition();
    const next = walkStep(x, walkDirection, 2, frog.getBounds().width, d);
    if (next.direction !== walkDirection) {
      walkDirection = next.direction;
      pushState();
    }
    frog.setPosition(next.x, y);
  }, 50);
}

function stopWalk() {
  if (walkTimer) clearInterval(walkTimer);
  walkTimer = null;
  if (machine.isActive('walking')) {
    machine.set('walking', false, Date.now());
    rememberPosition();
  }
}

// ---------- IPC from the frog page ----------

function wireFrogIpc() {
  const isFrog = (e: Electron.IpcMainEvent) => e.sender === frog?.webContents;
  ipcMain.on('frog:ready', (e) => {
    if (!isFrog(e)) return;
    send('frog:settings', { reducedMotion: settings.reducedMotion });
    pushState();
  });
  // Over an opaque pixel: take clicks. Over transparency: let them through to the app below.
  ipcMain.on('frog:hit', (e, overFrog: unknown) => {
    if (isFrog(e) && !press) frog?.setIgnoreMouseEvents(overFrog !== true, { forward: true });
  });
  // A press becomes a drag only once the cursor has moved a few pixels; otherwise it's a click.
  ipcMain.on('frog:press', (e, offset: { x: number; y: number }) => {
    if (!isFrog(e) || !frog || press || !Number.isFinite(offset?.x) || !Number.isFinite(offset?.y)) return;
    const start = screen.getCursorScreenPoint();
    const p = {
      offset: { x: offset.x, y: offset.y }, start, dragging: false,
      // Follow the cursor from the main process, so a fast drag can't outrun the window.
      timer: setInterval(() => {
        const c = screen.getCursorScreenPoint();
        if (!p.dragging && movedFar(p.start, c)) {
          p.dragging = true;
          stopWalk();
        }
        if (p.dragging) {
          frog?.setPosition(Math.round(c.x - p.offset.x), Math.round(c.y - p.offset.y));
          companion.follow();
        }
      }, 16),
    };
    press = p;
  });
  ipcMain.on('frog:release', (e) => {
    if (!isFrog(e) || !press) return;
    clearInterval(press.timer);
    const wasDrag = press.dragging;
    press = null;
    if (!frog) return;
    if (!wasDrag) {
      companion.togglePanel();
      return;
    }
    fitToDisplay(); // the new display may use a different scale
    const d = displayOf(frog);
    const b = frog.getBounds();
    const p = clampToWorkArea(b.x, b.y, b.width, d);
    frog.setPosition(p.x, p.y);
    companion.follow();
    rememberPosition();
  });
  ipcMain.on('frog:animation-finished', (e, state: FrogState) => {
    if (isFrog(e)) machine.animationFinished(state, Date.now());
  });
}

// ---------- app lifecycle ----------

function start() {
  settings = loadSettings();
  app.setLoginItemSettings({ openAtLogin: settings.startOnLogin });

  const session = new Session(sessionFile(app.getPath('userData')), safeStorage, {
    read: (p) => (existsSync(p) ? readFileSync(p) : null),
    write: (p, d) => writeFileSync(p, d),
    remove: (p) => rmSync(p, { force: true }),
  });
  session.load();
  const api = new ApiClient(() => settings.backendUrl, session);

  companion = new Companion({
    frog: () => frog,
    reducedMotion: () => settings.reducedMotion,
    loadPage,
    lockDown,
    onEffect: (effect) => {
      const now = Date.now();
      machine.clearReactions(now);
      if (effect.frog !== 'idle') machine.react(effect.frog as Reaction, now);
      if (effect.opens) dashboard.open(effect.opens === 'dashboard' ? 'home' : effect.opens);
    },
    onChange: () => refreshTrayMenu(),
  });

  dashboard = new Dashboard({
    api,
    session,
    preload: join(PRELOADS, 'dashboard.js'),
    icon: join(ICONS, 'tray-256.png'),
    loadPage: (win) => loadPage(win, 'dashboard'),
    lockDown,
    backend: backendStatus,
    settings: userSettings,
    updateSettings,
    setCondition: (c, on) => {
      if (machine.isActive(c) !== on) machine.set(c, on, Date.now());
    },
    onAnswerFinished: (event) => {
      if (event.type !== 'result') return;
      const r = event.result;
      // The lavender line only when an answer with valid citations really arrived.
      if (r.outcome === 'answered' && (r.citations?.length ?? 0) > 0) companion.say(FINDING);
      // The LLM fell back to passages: a brief error reaction, not a lasting one.
      if (r.outcome === 'llm_unavailable') machine.react('error', Date.now());
    },
  });

  machine.onChange((state) => pushState(state));
  wireFrogIpc();
  createFrog();
  companion.create(PRELOADS);
  buildTray();
  watchInactivity();
  watchBackend();
  scheduleWalk();
  if (session.status().signedIn) void dashboard.refreshDocuments();
  timers.push(setInterval(() => machine.tick(Date.now()), 250));
  screen.on('display-metrics-changed', fitToDisplay);
  screen.on('display-removed', () => {
    // If the frog's display went away, bring it back to the primary display.
    if (frog && !allDisplays().some((d) => d.id === settings.position?.displayId)) {
      const p = restorePosition(null, allDisplays(), displayOf(frog), frog.getBounds().width);
      frog.setPosition(p.x, p.y);
      fitToDisplay();
    }
  });
  // Any web contents created later (dev tools, dialogs) get the same rule: no new windows.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  if (process.env.SMOI_MEASURE_DASHBOARD) runMeasurement(dashboard, process.env.SMOI_MEASURE_DASHBOARD);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => frog?.showInactive());
  app.whenReady().then(start);

  // Clean shutdown: stop timers, save where the frog is, remove the tray icon.
  app.on('before-quit', () => {
    timers.forEach((t) => clearInterval(t));
    stopWalk();
    if (frog) rememberPosition();
    companion?.destroy();
    tray?.destroy();
  });
  // The frog window lives until quit; closing the dashboard doesn't quit SMOI.
  app.on('window-all-closed', () => {});
}
