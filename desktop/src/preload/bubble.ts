/** The speech-bubble window's bridge: show, place and hide one bubble, and dismiss pink ones. */
import { contextBridge, ipcRenderer } from 'electron';
import type { BubbleBridge, BubblePlaced, BubbleShow } from '../shared/bridge';

const api: BubbleBridge = {
  onShow: (cb) => ipcRenderer.on('bubble:show', (_e, b: BubbleShow) => cb(b)),
  onPlaced: (cb) => ipcRenderer.on('bubble:placed', (_e, p: BubblePlaced) => cb(p)),
  onHide: (cb) => ipcRenderer.on('bubble:hide', () => cb()),
  measured: (id, size) => ipcRenderer.send('bubble:measured', id, size),
  dismiss: (id) => ipcRenderer.send('bubble:dismiss', id),
  setHit: (over) => ipcRenderer.send('bubble:hit', over),
  ready: () => ipcRenderer.send('bubble:ready'),
};
contextBridge.exposeInMainWorld('smoiBubble', api);
