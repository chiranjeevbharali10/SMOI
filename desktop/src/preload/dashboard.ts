/**
 * The dashboard's bridge. Every call goes to the main process, which holds the session and makes
 * the HTTP requests; the page never sees the token or a file path.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DashboardBridge } from '../shared/bridge';

const on = <T>(channel: string) => (cb: (v: T) => void) => {
  ipcRenderer.on(channel, (_e, v: T) => cb(v));
};

const api: DashboardBridge = {
  session: () => ipcRenderer.invoke('session:status'),
  signIn: (email, password) => ipcRenderer.invoke('session:sign-in', email, password),
  register: (email, password) => ipcRenderer.invoke('session:register', email, password),
  signOut: () => ipcRenderer.invoke('session:sign-out'),
  onSession: on('session:changed'),
  me: () => ipcRenderer.invoke('api:me'),
  documents: () => ipcRenderer.invoke('docs:list'),
  onDocuments: on('docs:changed'),
  upload: () => ipcRenderer.invoke('docs:upload'),
  deleteDocument: (id) => ipcRenderer.invoke('docs:delete', id),
  chunks: (documentId) => ipcRenderer.invoke('docs:chunks', documentId),
  ask: (question) => ipcRenderer.invoke('brain:ask', question),
  onAnswer: on('brain:event'),
  providers: () => ipcRenderer.invoke('api:providers'),
  backend: () => ipcRenderer.invoke('backend:status'),
  onBackend: on('backend:changed'),
  settings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  onSettings: on('settings:changed'),
  onNavigate: on('dashboard:navigate'),
  tasks: () => ipcRenderer.invoke('tasks:get'),
  onTasks: on('tasks:changed'),
  saveTask: (input) => ipcRenderer.invoke('tasks:save', input),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  saveReminder: (input) => ipcRenderer.invoke('reminders:save', input),
  deleteReminder: (id) => ipcRenderer.invoke('reminders:delete', id),
  command: (text) => ipcRenderer.invoke('command:interpret', text),
  confirmCommand: (id) => ipcRenderer.invoke('command:confirm', id),
  onVoiceQuestion: on('brain:voice-question'),
  ready: () => ipcRenderer.send('dashboard:ready'),
};
contextBridge.exposeInMainWorld('smoiDashboard', api);
