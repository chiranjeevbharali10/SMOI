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
  folders: () => ipcRenderer.invoke('folders:list'),
  onFolders: on('folders:changed'),
  addFolder: () => ipcRenderer.invoke('folders:add'),
  removeFolder: (id) => ipcRenderer.invoke('folders:remove', id),
  retryOcr: () => ipcRenderer.invoke('folders:retry-ocr'),
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
  google: () => ipcRenderer.invoke('google:get'),
  onGoogle: on('google:changed'),
  connectGoogle: () => ipcRenderer.invoke('google:connect'),
  disconnectGoogle: () => ipcRenderer.invoke('google:disconnect'),
  openGoogleLink: (url) => ipcRenderer.invoke('google:open', url),
  upcoming: () => ipcRenderer.invoke('calendar:upcoming'),
  proposeEvent: (input) => ipcRenderer.invoke('calendar:propose', input),
  proposeEventChange: (id, input) => ipcRenderer.invoke('calendar:propose-change', id, input),
  proposeEventDelete: (id) => ipcRenderer.invoke('calendar:propose-delete', id),
  confirmGoogle: (id) => ipcRenderer.invoke('google:confirm', id),
  emails: () => ipcRenderer.invoke('email:list'),
  syncEmail: () => ipcRenderer.invoke('email:sync'),
  emailToTask: (id) => ipcRenderer.invoke('email:task', id),
  indexEmail: (id, on) => ipcRenderer.invoke('email:index', id, on),
  drafts: () => ipcRenderer.invoke('drafts:list'),
  proposeDraft: (input, draftId) => ipcRenderer.invoke('drafts:propose', input, draftId),
  ready: () => ipcRenderer.send('dashboard:ready'),
};
contextBridge.exposeInMainWorld('smoiDashboard', api);
