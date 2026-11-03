import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_NOTIFICATIONS, mergeNotificationSettings, type NotificationSettings } from '../shared/notify';
import { clampPersonality, DEFAULT_PERSONALITY, type Personality } from '../shared/personality';

/** User settings, kept as JSON in the app's user-data folder. */
export interface Settings {
  /** Where the frog was last left, relative to its display's work area, in DIPs. */
  position: { displayId: number; x: number; y: number } | null;
  /** Hold a still frame instead of animating, and never walk. */
  reducedMotion: boolean;
  /** Occasional short walks along the taskbar. */
  walking: boolean;
  startOnLogin: boolean;
  /** Minutes without keyboard or mouse input before SMOI falls asleep. */
  sleepAfterMinutes: number;
  /** Where the SMOI backend runs. */
  backendUrl: string;
  /** Voice commands. Off until the user turns them on (and the backend has speech-to-text). */
  voiceEnabled: boolean;
  /** The global voice shortcut (FR-03.01), as an Electron accelerator. */
  shortcut: string;
  personality: Personality;
  notifications: NotificationSettings;
}

const DEFAULTS: Settings = {
  position: null,
  reducedMotion: false,
  walking: true,
  startOnLogin: false,
  sleepAfterMinutes: 5,
  backendUrl: 'http://127.0.0.1:8080',
  voiceEnabled: false,
  shortcut: 'Control+Alt+J',
  personality: DEFAULT_PERSONALITY,
  notifications: DEFAULT_NOTIFICATIONS,
};

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  try {
    if (existsSync(file())) {
      const saved = JSON.parse(readFileSync(file(), 'utf8'));
      return {
        ...DEFAULTS, ...saved,
        // Nested settings are checked field by field, so an older or hand-edited file still works.
        personality: clampPersonality(saved.personality) ?? DEFAULT_PERSONALITY,
        notifications: mergeNotificationSettings(DEFAULT_NOTIFICATIONS, saved.notifications),
      };
    }
  } catch {
    // A corrupt file falls back to defaults rather than stopping the frog from appearing.
  }
  return structuredClone(DEFAULTS);
}

/** Writes to a temporary file first, so a crash mid-write can't leave a half-written file. */
export function saveSettings(settings: Settings): void {
  const tmp = file() + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file());
}
