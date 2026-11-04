/**
 * SMOI's Electron main process: the frog window, its speech bubble and menu panel, the dashboard,
 * the tray, and the inputs that choose the frog's state (inactivity, backend health, indexing,
 * answers, occasional walks). It never looks at other windows or apps.
 */
import {
  app, BrowserWindow, ipcMain, Menu, nativeImage, net, powerMonitor, safeStorage, screen, session as electronSession, Tray,
} from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FrogStateMachine, type Reaction } from '../shared/stateMachine';
import type { FrogState } from '../shared/animations';
import { windowSize } from '../shared/scaling';
import { movedFar } from '../shared/pointer';
import { FINDING, LISTENING } from '../shared/panelActions';
import type { BackendStatus, UserSettings } from '../shared/bridge';
import { mergeNotificationSettings } from '../shared/notify';
import { clampPersonality, react as personalityLine } from '../shared/personality';
import { describeProposal } from '../shared/proposal';
import { clampToWorkArea, restorePosition, walkStep, type DisplayInfo } from './placement';
import { loadSettings, mergeClaudeCode, saveSettings, type Settings } from './settings';
import { ApiClient } from './api';
import { Session } from './session';
import { Companion } from './companion';
import { Dashboard, sessionFile } from './dashboard';
import { runMeasurement } from './measure';
import { TaskService } from './tasks';
import { Notifier } from './notifier';
import { ClaudeCode } from './claudeCode';
import { GoogleService } from './google';
import { overdueTasks } from '../shared/taskStore';
import { Commands } from './commands';
import { isAccelerator, Voice } from './voice';

const DEV_SERVER = process.env.SMOI_DEV_SERVER; // set by `npm run dev`
// Checks and measurements run against a separate profile, so they never touch the user's
// settings or saved sign-in. Development builds only.
if (process.env.SMOI_TEST_USERDATA && !app.isPackaged) app.setPath('userData', process.env.SMOI_TEST_USERDATA);
const RENDERER = join(__dirname, '..', '..', 'dist');
const PRELOADS = join(__dirname, '..', 'preload');
const ICONS = join(DEV_SERVER ? join(__dirname, '..', '..', 'assets') : RENDERER, 'icons');

let settings: Settings;
let frog: BrowserWindow | null = null;
let preview: BrowserWindow | null = null;
let tray: Tray | null = null;
let companion: Companion;
let dashboard: Dashboard;
let tasks: TaskService;
let notifier: Notifier;
let google: GoogleService;
const claude = new ClaudeCode();
let voice: Voice;
/** Why the voice shortcut couldn't be registered, or null. */
let shortcutError: string | null = null;
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
  if (!app.isPackaged && process.env.SMOI_LOG_STATES) console.log(`[frog] state ${state}`);
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

type Page = 'index' | 'preview' | 'bubble' | 'panel' | 'dashboard' | 'recorder';
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
  const { reducedMotion, walking, startOnLogin, sleepAfterMinutes, backendUrl, voiceEnabled, shortcut, personality, notifications, claudeCode } = settings;
  return {
    reducedMotion, walking, startOnLogin, sleepAfterMinutes, backendUrl, voiceEnabled, shortcut, shortcutError,
    personality, notifications, claudeCode, claudeHooks: claude.status,
  };
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Applies a settings change from the tray or the dashboard. Unknown keys and bad values are ignored. */
function updateSettings(patch: Record<string, unknown>): UserSettings {
  for (const key of ['reducedMotion', 'walking', 'startOnLogin'] as const) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  }
  const sleep = patch.sleepAfterMinutes;
  if (typeof sleep === 'number' && Number.isInteger(sleep) && sleep >= 1 && sleep <= 120) settings.sleepAfterMinutes = sleep;
  const voiceBefore = `${settings.voiceEnabled}|${settings.shortcut}`;
  if (typeof patch.voiceEnabled === 'boolean') settings.voiceEnabled = patch.voiceEnabled;
  if (isAccelerator(patch.shortcut)) settings.shortcut = patch.shortcut;
  const personality = clampPersonality(patch.personality);
  if (personality) settings.personality = personality;
  if (patch.notifications) settings.notifications = mergeNotificationSettings(settings.notifications, patch.notifications);
  if (patch.claudeCode) settings.claudeCode = mergeClaudeCode(settings.claudeCode, patch.claudeCode);
  saveSettings(settings);
  if (`${settings.voiceEnabled}|${settings.shortcut}` !== voiceBefore) voice.apply();
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
    ...(settings.voiceEnabled ? [{
      label: voice?.busy ? 'Stop listening' : 'Talk to SMOI',
      accelerator: shortcutError ? undefined : settings.shortcut,
      registerAccelerator: false,
      click: () => voice.toggle(),
    }] : []),
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
      // Back online: send what was saved while it was away, without waiting for the next sync.
      if (reachable) void tasks.sync();
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
    facts: () => ({
      openTasks: tasks.openCount ?? undefined, voice: settings.voiceEnabled,
      busyToday: google?.connected ? google.current.busyToday ?? undefined : undefined,
      newEmails: google?.connected ? google.current.unseen : undefined,
    }),
    startVoice: () => voice.start(),
  });

  // Tasks and reminders: the local copy, its sync, and the reminder scheduler.
  tasks = new TaskService({
    api,
    dataDir: app.getPath('userData'),
    onReminder: (r, missed) => notifier.notify('reminders', `${r.id}@${r.lastFiredAt ?? r.firstAt}`,
      { type: 'reminder', title: r.title, missed }),
    onOverdue: (count) => {
      if (count > 0) notifier.notify('overdue', 'overdue', { type: 'overdue', count });
      // A task can become overdue just by time passing, with no change to the store.
      if (machine.isActive('tasks') !== count > 0) machine.set('tasks', count > 0, Date.now());
    },
    onChange: (s) => {
      dashboard?.tasksChanged(s, session.status().signedIn);
      // The tasks pose lasts while something is overdue, and goes when it's done or rescheduled.
      const overdue = session.status().signedIn && overdueTasks(s, Date.now()).length > 0;
      if (machine.isActive('tasks') !== overdue) machine.set('tasks', overdue, Date.now());
    },
    // Reminders linked to a Gmail draft check that the draft still exists (FR-05.11).
    checkDraft: async (id) => {
      try {
        return await api.checkReminder(id);
      } catch {
        return null;
      }
    },
    onDraftGone: (_r, message) => {
      const line = personalityLine({ type: 'draft_reminder_cancelled', message }, settings.personality);
      if (line.line) companion.say(line.line);
    },
  });
  // Google Calendar and Gmail (Phase 8): status, Gmail sync, important-email alerts.
  google = new GoogleService({
    api, timeZone,
    signedIn: () => session.status().signedIn,
    // No email content in the alert (FR-05.04): only that important mail arrived.
    onImportant: (count) => notifier.notify('email', `email:${Date.now()}`, { type: 'important_email', count }),
    onReconnectNeeded: () => {
      const r = personalityLine({ type: 'google_reconnect' }, settings.personality);
      if (r.line) companion.say(r.line);
      machine.react('annoyed', Date.now());
    },
    onChange: (g) => {
      dashboard?.googleChanged(g);
      // The mail pose lasts while there is new mail the user hasn't looked at in the inbox.
      const mail = g.status?.status === 'connected' && g.unseen > 0;
      if (machine.isActive('mail') !== mail) machine.set('mail', mail, Date.now());
    },
  });
  notifier = new Notifier({
    settings: () => settings.notifications,
    personality: () => settings.personality,
    say: (line) => companion.say(line),
    react: (frog) => machine.react(frog as Reaction, Date.now()),
    icon: join(ICONS, 'tray-256.png'),
  });
  const commands = new Commands({
    api, tasks, timeZone,
    // The user just asked for this, so it isn't a notification: SMOI simply says it's done.
    onSaved: (event) => {
      const r = personalityLine(event, settings.personality);
      if (r.line) companion.say(r.line);
      machine.react('happy', Date.now());
    },
    openCalendar: () => dashboard.open('calendar'),
    onGoogleError: (e) => google.handle(e),
  });
  voice = new Voice({
    api,
    preload: join(PRELOADS, 'recorder.js'),
    loadPage: (win) => loadPage(win, 'recorder'),
    lockDown,
    enabled: () => settings.voiceEnabled,
    shortcut: () => settings.shortcut,
    signedIn: () => session.status().signedIn,
    timeZone,
    setListening: (on) => {
      // The listening frog (with its mic chip) shows exactly while the microphone is in use (NFR-04.02).
      machine.set('listening', on, Date.now());
      if (on && companion.bubbles.current?.text !== LISTENING.line) companion.say({ tone: 'nudge', text: LISTENING.line });
      refreshTrayMenu();
    },
    setThinking: (on) => machine.set('thinking', on, Date.now()),
    tell: (text, important) => {
      companion.say({ tone: important ? 'urgent' : 'nudge', text });
      if (important) machine.react('error', Date.now());
    },
    onCommand: (heard, proposal) => {
      // A question for SMOI Brain is read-only: ask it, showing the question as understood.
      if (proposal.intent === 'ask_brain' && proposal.question && !proposal.problem) {
        dashboard.askFromVoice(proposal.question);
        return;
      }
      // Everything else is shown first, and acted on only once confirmed (FR-03.06). Calendar and
      // email commands become Google proposals first, so the confirmation shows conflicts or the draft.
      void commands.prepare(proposal).then((outcome) => {
        companion.confirm({ heard, view: outcome.view }, (yes) => {
          if (!yes || !outcome.view.actionable) return;
          commands.confirm(outcome.id).catch((e) => {
            companion.say({ tone: 'urgent', text: e instanceof Error ? e.message : 'That command could not be run.' });
          });
        });
      });
    },
    onShortcutStatus: (error) => {
      shortcutError = error;
      dashboard?.settingsChanged(userSettings());
      refreshTrayMenu();
      if (error) companion.say({ tone: 'urgent', text: error });
    },
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
    tasks,
    commands,
    timeZone,
    google,
    onIndexed: (count) => notifier.notify('indexing', `indexed:${Date.now()}`, { type: 'indexed', count }),
    onAnswerFinished: (event) => {
      if (event.type !== 'result') return;
      const r = event.result;
      // The lavender line only when an answer with valid citations really arrived.
      if (r.outcome === 'answered' && (r.citations?.length ?? 0) > 0) companion.say(FINDING);
      // The LLM fell back to passages: a brief error reaction, not a lasting one.
      if (r.outcome === 'llm_unavailable') machine.react('error', Date.now());
    },
  });

  // Signing in loads that account's tasks; signing out puts them away.
  const followSession = () => {
    const s = session.status();
    if (s.signedIn && s.email) {
      tasks.start(s.email);
      google.start();
    } else {
      tasks.stop();
      google.stop();
      void google.refresh();
    }
  };
  session.onChange(() => followSession());
  followSession();

  // No page may use the camera, microphone, location or notifications through the browser APIs.
  // The hidden recorder has its own session with its own rule (src/main/voice.ts).
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);

  claude.start({
    enabled: () => settings.claudeCode.enabled,
    celebrateAfterMinutes: () => settings.claudeCode.celebrateAfterMinutes,
    notify: (category, source, event) => notifier.notify(category, source, event),
    onStatus: () => dashboard.settingsChanged(userSettings()),
  });

  machine.onChange((state) => pushState(state));
  wireFrogIpc();
  createFrog();
  companion.create(PRELOADS);
  buildTray();
  voice.apply();
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

  const measure = process.env.SMOI_MEASURE_DASHBOARD;
  if (measure && !app.isPackaged) void signInFromEnv(session, api).then(() => runMeasurement(dashboard, measure));
  if (process.env.SMOI_E2E_OUT && !app.isPackaged) void startDesktopCheck(session, api, process.env.SMOI_E2E_OUT);
}

/** Checks and measurements: sign in with a test account from the environment, if one is given. */
async function signInFromEnv(session: Session, api: ApiClient) {
  const email = process.env.SMOI_E2E_EMAIL;
  const password = process.env.SMOI_E2E_PASSWORD;
  if (!email || !password) return;
  const t = await api.login(email, password);
  session.signIn(t.accessToken, email, t.expiresAt);
}

/** scripts/desktop-check.ts */
async function startDesktopCheck(session: Session, api: ApiClient, out: string) {
  await signInFromEnv(session, api);
  await new Promise((r) => setTimeout(r, 3000));
  const { runE2e } = await import('./e2e.js');
  await runE2e({
    frog: () => frog, companion, dashboard, machine, session, api, updateSettings,
    spriteDir: join(DEV_SERVER ? join(__dirname, '..', '..', 'assets') : RENDERER, 'sprites'),
    moveFrogTo: (displayId) => {
      const d = allDisplays().find((x) => x.id === displayId);
      if (!frog || !d) return;
      const size = windowSize(d.scaleFactor);
      const p = restorePosition(null, [d], d, size);
      frog.setBounds({ x: p.x, y: p.y, width: size, height: size });
      fitToDisplay();
    },
  }, out);
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
    voice?.destroy();
    notifier?.destroy();
    google?.stop();
    void claude.stop();
    companion?.destroy();
    tray?.destroy();
  });
  // The frog window lives until quit; closing the dashboard doesn't quit SMOI.
  app.on('window-all-closed', () => {});
}
