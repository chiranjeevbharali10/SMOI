/**
 * The only bridge between the frog page and Electron. The page gets these few functions and
 * nothing else: no Node, no ipcRenderer, no file access (context isolation is on).
 */
import { contextBridge, ipcRenderer } from 'electron';

type StateMessage = { state: string; mirrored: boolean };
type SettingsMessage = { reducedMotion: boolean };

contextBridge.exposeInMainWorld('smoi', {
  ready: () => ipcRenderer.send('frog:ready'),
  onState: (cb: (m: StateMessage) => void) => ipcRenderer.on('frog:state', (_e, m: StateMessage) => cb(m)),
  onSettings: (cb: (m: SettingsMessage) => void) => ipcRenderer.on('frog:settings', (_e, m: SettingsMessage) => cb(m)),
  setHit: (overFrog: boolean) => ipcRenderer.send('frog:hit', overFrog),
  /** Mouse button down on the frog: a click, or a drag if the cursor then moves. */
  press: (offset: { x: number; y: number }) => ipcRenderer.send('frog:press', offset),
  release: () => ipcRenderer.send('frog:release'),
  animationFinished: (state: string) => ipcRenderer.send('frog:animation-finished', state),
});
