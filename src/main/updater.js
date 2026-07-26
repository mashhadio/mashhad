'use strict';

// In-app auto-update (electron-updater). Enabled only for packaged Windows (NSIS)
// and real Linux AppImage builds — where electron-updater can actually download and
// apply an update. macOS updates go through Homebrew (we have no Apple signing, which
// electron-updater's mac path requires) and Linux .deb is apt's job, so both are
// skipped. The feed URL is the generic `publish` target in package.json (a public
// GitLab release permalink). Update state is pushed to the renderer's update banner.
const { app } = require('electron');

let autoUpdater = null; // the electron-updater singleton, once initialised

function initAutoUpdate(getWindow) {
  if (!app.isPackaged) return;                                        // nothing to replace in dev
  if (process.platform === 'darwin') return;                         // Homebrew handles macOS
  if (process.platform === 'linux' && !process.env.APPIMAGE) return; // AppImage only (not .deb)

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[update] electron-updater unavailable:', err && err.message);
    autoUpdater = null;
    return;
  }

  autoUpdater.autoDownload = true;          // fetch in the background as soon as one is found
  autoUpdater.autoInstallOnAppQuit = true;  // if the user doesn't click "restart", apply on next quit

  const send = (payload) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:status', payload);
  };

  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info && info.version }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info && info.version }));
  autoUpdater.on('error', (err) => { console.error('[update] error:', err && err.message); send({ state: 'error' }); });
  // 'update-not-available' is intentionally silent — no banner when already current.

  autoUpdater.checkForUpdates().catch((err) => console.warn('[update] check failed:', err && err.message));
}

// Quit and install a downloaded update (invoked from the renderer's "restart" button).
// No-op if the updater never initialised or nothing was downloaded.
function installUpdate() {
  if (!autoUpdater) return;
  try { autoUpdater.quitAndInstall(); } catch (err) { console.error('[update] install failed:', err && err.message); }
}

module.exports = { initAutoUpdate, installUpdate };
