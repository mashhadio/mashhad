'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The main process used to push scene updates via webContents.executeJavaScript
// (a string-injection call), the only window in this app that didn't go through
// the normal preload/IPC channel. `scene` is always one of the fixed SCENE_KEYS
// values, so it was never actually attacker-reachable, but this brings it in
// line with every other window's convention.
contextBridge.exposeInMainWorld('sceneIndicatorApi', {
  onSetScene: (cb) => {
    const handler = (_e, scene) => cb(scene);
    ipcRenderer.on('scene:update', handler);
    return () => ipcRenderer.removeListener('scene:update', handler);
  },
});
