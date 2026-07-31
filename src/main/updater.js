'use strict';

// In-app update. Two modes, picked by platform:
//
//   Windows (NSIS) and Linux AppImage — full electron-updater: the new build is
//   downloaded in the background and applied when the user clicks "restart".
//
//   macOS — notify-only. electron-updater's mac path goes through Squirrel.Mac,
//   which refuses to apply an update that isn't code-signed, and we have no Apple
//   Developer certificate. So we read the same public feed ourselves and just tell
//   the user a newer version exists, offering the Homebrew upgrade command and a
//   direct .dmg link. (Delete this branch once the app is signed + notarized —
//   electron-updater then handles macOS like the other two.)
//
//   Linux .deb is skipped entirely — that's the package manager's job.
//
// The feed is the `publish` target from package.json — the public GitHub releases
// repo. Update state is pushed to the renderer's update banner.
const { app, shell, clipboard } = require('electron');
const https = require('https');

// No `--cask` needed: once mashhadio/mashhad is tapped, the bare token resolves.
const BREW_UPGRADE = 'brew upgrade mashhad';

let autoUpdater = null;    // the electron-updater singleton, once initialised
let macDownloadUrl = null; // direct .dmg link, set once a macOS update is found

// Read the release target from package.json so it has a single source of truth —
// change it there and both this updater and electron-builder follow.
function publishTarget() {
  try {
    const { publish } = require('../../package.json').build;
    return (Array.isArray(publish) ? publish[0] : publish) || null;
  } catch (err) {
    console.warn('[update] no publish target in package.json:', err && err.message);
    return null;
  }
}

// URL of one file inside a GitHub release; without `tag`, the newest published
// (non-draft, non-prerelease) one. Plain redirecting download links, not the API —
// so there's no rate limit to trip over on launch.
function assetUrl(target, file, tag) {
  if (!target) return null;
  if (target.provider === 'github') {
    return `https://github.com/${target.owner}/${target.repo}/releases/${tag ? `download/${tag}` : 'latest/download'}/${file}`;
  }
  return target.url ? `${target.url}/${file}` : null; // generic provider fallback
}

// Minimal GET that follows redirects (GitHub bounces release assets to its CDN).
// Resolves the body as text.
function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': `Mashhad/${app.getVersion()}` } }, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume(); // drain, we only want the Location
          resolve(fetchText(new URL(headers.location, url).toString(), redirects - 1));
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

// Numeric x.y.z compare; any -prerelease suffix is ignored (our releases are plain).
function isNewer(remote, local) {
  const parts = (v) => String(v).trim().replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = parts(remote);
  const b = parts(local);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// macOS: read the electron-updater channel file straight off the public feed and
// compare versions ourselves. No download — the banner points at Homebrew or the .dmg.
async function checkMacUpdate(send) {
  const target = publishTarget();
  const ymlUrl = assetUrl(target, 'latest-mac.yml');
  if (!ymlUrl) return;

  const yml = await fetchText(ymlUrl);
  const match = /^version:\s*(.+)$/m.exec(yml);
  const version = match && match[1].trim();
  if (!version || !isNewer(version, app.getVersion())) return;

  // An x64 build running under Rosetta should be offered the native arm64 one.
  const arch = process.arch === 'x64' && app.runningUnderARM64Translation ? 'arm64' : process.arch;
  macDownloadUrl = assetUrl(target, `Mashhad-${version}-${arch}.dmg`, `v${version}`);
  send({ state: 'manual', version, brew: BREW_UPGRADE });
}

function initAutoUpdate(getWindow) {
  if (!app.isPackaged) return;                                        // nothing to replace in dev
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;  // AppImage only (not .deb)

  const send = (payload) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:status', payload);
  };

  if (process.platform === 'darwin') {
    // Silent on failure: an offline launch shouldn't nag.
    checkMacUpdate(send).catch((err) => console.warn('[update] mac check failed:', err && err.message));
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[update] electron-updater unavailable:', err && err.message);
    autoUpdater = null;
    return;
  }

  autoUpdater.autoDownload = true;          // fetch in the background as soon as one is found
  autoUpdater.autoInstallOnAppQuit = true;  // if the user doesn't click "restart", apply on next quit

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

// The two macOS banner actions. The .dmg URL is built in main — the renderer never
// supplies it — so there's no way to steer openExternal at an arbitrary target.
function openDownload() {
  if (macDownloadUrl) shell.openExternal(macDownloadUrl).catch((err) => console.error('[update] open failed:', err && err.message));
}

function copyBrewCommand() {
  clipboard.writeText(BREW_UPGRADE);
}

module.exports = { initAutoUpdate, installUpdate, openDownload, copyBrewCommand };
