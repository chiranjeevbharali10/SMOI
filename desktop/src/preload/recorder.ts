/** The hidden recorder's bridge: start and cancel come in; the recording or what went wrong goes out. */
import { contextBridge, ipcRenderer } from 'electron';
import type { RecorderBridge } from '../shared/bridge';

const api: RecorderBridge = {
  onStart: (cb) => ipcRenderer.on('voice:start', (_e, v: { maxMs: number }) => cb(v)),
  onCancel: (cb) => ipcRenderer.on('voice:cancel', () => cb()),
  started: () => ipcRenderer.send('voice:started'),
  done: (audio) => ipcRenderer.send('voice:done', audio),
  nothingHeard: () => ipcRenderer.send('voice:nothing'),
  failed: (name) => ipcRenderer.send('voice:failed', name),
  ready: () => ipcRenderer.send('voice:ready'),
};
contextBridge.exposeInMainWorld('smoiRecorder', api);
