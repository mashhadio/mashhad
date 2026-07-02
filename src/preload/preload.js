'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // screen-recording permission (macOS)
  screenStatus: () => ipcRenderer.invoke('screen:status'),
  ensureScreenPermission: () => ipcRenderer.invoke('screen:ensure'),
  openScreenSettings: () => ipcRenderer.invoke('screen:openSettings'),

  // sources
  listSources: (opts) => ipcRenderer.invoke('sources:list', opts),

  // drag-to-select recording area; resolves { x, y, w, h } in DIP or null
  selectRegion: (payload) => ipcRenderer.invoke('region:select', payload),

  // click-through outline drawn around the recorded region while recording
  showRecFrame: (payload) => ipcRenderer.invoke('frame:show', payload),
  hideRecFrame: () => ipcRenderer.invoke('frame:hide'),

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

  // studio (open the editor with a blank timeline + import media)
  openStudio: () => ipcRenderer.invoke('studio:open'),
  importVideos: () => ipcRenderer.invoke('source:import'),

  // voice-over: persist a recorded mic blob and register it as an audio source
  saveVoiceOver: (buf) => ipcRenderer.invoke('voiceover:save', buf),
  importAudio: () => ipcRenderer.invoke('source:importAudio'),

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
