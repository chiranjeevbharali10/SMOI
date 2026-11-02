/**
 * SMOI's Electron main process: the transparent frog window, the tray menu, and the inputs that
 * choose the frog's state (inactivity, backend health, occasional walks). It never looks at other
 * windows or apps.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, powerMonitor, screen, shell, Tray } from 'electron';
import { join } from 'node:path';
import { FrogStateMachine } from '../shared/stateMachine';
import type { FrogState } from '../shared/animations';
import { windowSize } from '../shared/scaling';
import { clampToWorkArea, restorePosition, walkStep, type DisplayInfo } from './placement';
import { loadSettings, saveSettings, type Settings } from './settings';

const DEV_SERVER = process.env.SMOI_DEV_SERVER; // set by `npm run dev`
const RENDERER = join(__dirname, '..', '..', 'dist');
const ICONS = join(DEV_SERVER ? join(__dirname, '..', '..', 'assets') : RENDERER, 'icons');

let settings: Settings;
let frog: BrowserWindow | null = null;
let preview: BrowserWindow | null = null;
let tray: Tray | null = null;
const machine = new FrogStateMachine();
let walkDirection: 1 | -1 = 1;
let walkTimer: NodeJS.Timeout | null = null;
let dragTimer: NodeJS.Timeout | null = null;
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
}

const loadPage = (win: BrowserWindow, page: 'index' | 'preview') =>
  DEV_SERVER ? win.loadURL(`${DEV_SERVER}/${page}.html`) : win.loadFile(join(RENDERER, `${page}.html`));

/** No navigation or new windows from web content (NFR-03 hardening for the renderer). */
function lockDown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
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
    backgroundColor: '#00000000',
    title: 'SMOI',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  frog.setAlwaysOnTop(true, 'floating');
  lockDown(frog);
  if (!app.isPackaged) {
    // Development: show the page's console output and load failures in the terminal.
    frog.webContents.on('console-message', (e) => console.log(`[frog ${e.level}] ${e.message}`));
    frog.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[frog] failed to load ${url}: ${code} ${desc}`));
  }
  // Clicks pass through until the cursor is over an opaque pixel of the frog (see renderer).
  frog.setIgnoreMouseEvents(true, { forward: true });
  // Show as soon as the page has painted: the frog appears without waiting for the backend.
  frog.once('ready-to-show', () => frog?.showInactive());
  frog.on('closed', () => {
    frog = null;
  });
  void loadPage(frog, 'index');
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
  void loadPage(preview, 'preview');
}

// ---------- tray ----------

function buildTray() {
  const icon = nativeImage.createFromPath(join(ICONS, 'tray-16.png'));
  icon.addRepresentation({ scaleFactor: 2, dataURL: nativeImage.createFromPath(join(ICONS, 'tray-32.png')).toDataURL() });
  tray = new Tray(icon);
  tray.setToolTip('SMOI');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const toggle = (key: 'reducedMotion' | 'walking') => () => {
    settings[key] = !settings[key];
    saveSettings(settings);
    send('frog:settings', { reducedMotion: settings.reducedMotion });
    if (key === 'reducedMotion' || !settings.walking) stopWalk();
    refreshTrayMenu();
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: frog?.isVisible() ? 'Hide SMOI' : 'Show SMOI',
      click: () => {
        if (frog?.isVisible()) frog.hide();
        else frog?.showInactive();
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Reduced motion', type: 'checkbox', checked: settings.reducedMotion, click: toggle('reducedMotion') },
    { label: 'Walk along the taskbar', type: 'checkbox', checked: settings.walking,
      enabled: !settings.reducedMotion, click: toggle('walking') },
    {
      label: 'Start when I log in', type: 'checkbox', checked: settings.startOnLogin,
      click: () => {
        settings.startOnLogin = !settings.startOnLogin;
        app.setLoginItemSettings({ openAtLogin: settings.startOnLogin });
        saveSettings(settings);
        refreshTrayMenu();
      },
    },
    { label: 'Move SMOI back to the corner', click: () => {
      settings.position = null;
      saveSettings(settings);
      const p = restorePosition(null, allDisplays(), displayOf(frog!), frog!.getBounds().width);
      frog?.setPosition(p.x, p.y);
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
  };
  void check();
  timers.push(setInterval(check, 10_000));
}

/** Occasional short walks when SMOI is idle. The walking strip faces right; going left mirrors it. */
function scheduleWalk() {
  const delay = 90_000 + Math.random() * 150_000;
  timers.push(setTimeout(() => {
    if (settings.walking && !settings.reducedMotion && machine.state === 'idle' && frog?.isVisible() && !dragTimer) {
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
    if (!frog || machine.state !== 'walking' || steps++ > 40) return stopWalk();
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

// ---------- IPC from the renderer ----------

function wireIpc() {
  ipcMain.on('frog:ready', () => {
    send('frog:settings', { reducedMotion: settings.reducedMotion });
    pushState();
  });
  // Over an opaque pixel: take clicks. Over transparency: let them through to the app below.
  ipcMain.on('frog:hit', (_e, overFrog: boolean) => {
    if (!dragTimer) frog?.setIgnoreMouseEvents(!overFrog, { forward: true });
  });
  ipcMain.on('frog:drag-start', (_e, offset: { x: number; y: number }) => {
    if (!frog || dragTimer) return;
    stopWalk();
    // Follow the cursor from the main process, so a fast drag can't outrun the window.
    dragTimer = setInterval(() => {
      const c = screen.getCursorScreenPoint();
      frog?.setPosition(Math.round(c.x - offset.x), Math.round(c.y - offset.y));
    }, 16);
  });
  ipcMain.on('frog:drag-end', () => {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
    if (!frog) return;
    fitToDisplay(); // the new display may use a different scale
    const d = displayOf(frog);
    const b = frog.getBounds();
    const p = clampToWorkArea(b.x, b.y, b.width, d);
    frog.setPosition(p.x, p.y);
    rememberPosition();
  });
  ipcMain.on('frog:animation-finished', (_e, state: FrogState) => machine.animationFinished(state, Date.now()));
}

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => frog?.showInactive());
  app.whenReady().then(() => {
    settings = loadSettings();
    app.setLoginItemSettings({ openAtLogin: settings.startOnLogin });
    machine.onChange((state) => pushState(state));
    wireIpc();
    createFrog();
    buildTray();
    watchInactivity();
    watchBackend();
    scheduleWalk();
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
    // External links (from later phases) open in the browser, never inside SMOI.
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) void shell.openExternal(url);
        return { action: 'deny' };
      });
    });
  });

  // Clean shutdown: stop timers, save where the frog is, remove the tray icon.
  app.on('before-quit', () => {
    timers.forEach((t) => clearInterval(t));
    stopWalk();
    if (frog) rememberPosition();
    tray?.destroy();
  });
  app.on('window-all-closed', () => app.quit());
}
