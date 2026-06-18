'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // screen-recording permission (macOS)
  screenStatus: () => ipcRenderer.invoke('screen:status'),
  ensureScreenPermission: () => ipcRenderer.invoke('screen:ensure'),
  openScreenSettings: () => ipcRenderer.invoke('screen:openSettings'),

  // sources
  listSources: () => ipcRenderer.invoke('sources:list'),

  // recording (streamed to disk chunk-by-chunk)
  startRecording: (payload) => ipcRenderer.invoke('rec:start', payload),
  sendVideoChunk: (buf) => ipcRenderer.invoke('rec:videoChunk', buf),
  sendCamChunk: (buf) => ipcRenderer.invoke('rec:camChunk', buf),
  finishRecording: (payload) => ipcRenderer.invoke('rec:finish', payload),
  abortRecording: () => ipcRenderer.invoke('rec:abort'),

  // navigation
  openEditor: () => ipcRenderer.invoke('editor:open'),
  backHome: () => ipcRenderer.invoke('editor:back-home'),

  // library
  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  openRecording: (videoPath) => ipcRenderer.invoke('recordings:open', videoPath),

  // editor
  getProject: () => ipcRenderer.invoke('project:get'),
  previewAudio: (profile) => ipcRenderer.invoke('audio:preview', profile),

  // export
  runExport: (payload) => ipcRenderer.invoke('export:run', payload),
  onExportProgress: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },

  // preferences
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // shortcuts
  getShortcut: () => ipcRenderer.invoke('shortcut:get'),
  onToggleRecord: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('shortcut:toggle-record', handler);
    return () => ipcRenderer.removeListener('shortcut:toggle-record', handler);
  },

  // misc
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
});
