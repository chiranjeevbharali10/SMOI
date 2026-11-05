/** The dev animation preview's bridge: the companion roster, read-only. */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('smoiPreview', {
  roster: () => ipcRenderer.invoke('preview:roster'),
});
