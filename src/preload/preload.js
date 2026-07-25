'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Prevent Chromium's whole-app zoom on Ctrl/Cmd+wheel so the UI never scales.
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) e.preventDefault();
}, { passive: false, capture: true });

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
  dropCam: () => ipcRenderer.invoke('rec:dropCam'),
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
  previewAudio: (opts) => ipcRenderer.invoke('audio:preview', opts),

  // project files (.ssproj): save / auto-save / open / restore edit-state
  saveProject: (payload) => ipcRenderer.invoke('project:save', payload),
  autoSaveProject: (payload) => ipcRenderer.invoke('project:autosave', payload),
  openProject: () => ipcRenderer.invoke('project:open'),
  getPendingProject: () => ipcRenderer.invoke('project:pending'),
  getProjectFile: () => ipcRenderer.invoke('project:file'),

  // export
  beginExportCapture: () => ipcRenderer.invoke('export:beginCapture'),
  sendExportChunk: (buf) => ipcRenderer.invoke('export:chunk', buf),
  endExportCapture: () => ipcRenderer.invoke('export:endCapture'),
  abortExportCapture: () => ipcRenderer.invoke('export:abortCapture'),
  runExport: (payload) => ipcRenderer.invoke('export:run', payload),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
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

  // window focus changes (used to pause live previews in the background)
  onWindowFocus: (cb) => {
    const handler = (_e, focused) => cb(focused);
    ipcRenderer.on('window:focus', handler);
    return () => ipcRenderer.removeListener('window:focus', handler);
  },

  // misc
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
});
