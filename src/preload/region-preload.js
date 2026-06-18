'use strict';

// Tiny bridge for the region-select overlay window: it only needs to hand the
// chosen rectangle (or null on cancel) back to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionApi', {
  send: (rect) => ipcRenderer.send('region:result', rect),
});
