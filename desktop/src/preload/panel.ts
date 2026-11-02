/** The menu panel's bridge: choose a row or close; the main process decides what happens. */
import { contextBridge, ipcRenderer } from 'electron';
import type { PanelBridge, PanelView } from '../shared/bridge';

const api: PanelBridge = {
  onOpen: (cb) => ipcRenderer.on('panel:open', (_e, v: PanelView) => cb(v)),
  onUpdate: (cb) => ipcRenderer.on('panel:update', (_e, v: PanelView) => cb(v)),
  choose: (row) => ipcRenderer.send('panel:choose', row),
  close: () => ipcRenderer.send('panel:close'),
  measured: (size) => ipcRenderer.send('panel:measured', size),
  setHit: (over) => ipcRenderer.send('panel:hit', over),
  ready: () => ipcRenderer.send('panel:ready'),
};
contextBridge.exposeInMainWorld('smoiPanel', api);
