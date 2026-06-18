'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell, session, globalShortcut, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const { startCursorTracking, stopCursorTracking, resetCursorTracking } = require('./cursor-tracker');
const { exportVideo, exportCleanAudio, probeHasAudio } = require('./ffmpeg-export');

// ---------------------------------------------------------------------------
// Paths / state
// ---------------------------------------------------------------------------
const RECORDINGS_DIR = path.join(app.getPath('videos'), 'SmoothScreenRecorder');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const isMac = process.platform === 'darwin';

// macOS gates camera/mic/screen/accessibility at the OS level (TCC). These
// helpers proactively trigger the system prompts; they are no-ops elsewhere.
async function requestMacMediaAccess() {
  if (!isMac) return;
  try { await systemPreferences.askForMediaAccess('microphone'); } catch (_) {}
  try { await systemPreferences.askForMediaAccess('camera'); } catch (_) {}
}

function ensureMacCursorPermission() {
  // uiohook needs Accessibility / Input Monitoring on macOS. Passing true shows
  // the system prompt the first time if not yet trusted.
  if (!isMac) return;
  try {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true);
    }
  } catch (_) {}
}

let mainWindow = null;

// Global hotkey to start/stop recording (works even when unfocused).
const RECORD_SHORTCUT = 'CommandOrControl+Shift+R';

// Windows Graphics Capture's "zero-Hz" mode only emits a frame when the screen
// changes; on a static screen it reuses the last frame and spams
// "ProcessFrame failed, using existing frame" to the console. Disabling it makes
// capture run at a steady frame rate (smoother) and removes the log flood.
app.commandLine.appendSwitch('disable-features', 'AllowWgcZeroHzScreenCapturer');
// Only surface fatal native logs (hides benign capture warnings).
app.commandLine.appendSwitch('log-level', '3');

// Single-instance: focus the existing window instead of launching a second app
// (which would also fail to register the global shortcut).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// The project currently loaded in the editor.
let currentProject = null; // { videoPath, cursorPath, hasAudio, display, recBaseEpoch }

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0e0f13',
    title: 'Smooth Screen Recorder',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Surface renderer console output to the terminal (dev only).
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer]', message);
    });
  }

  loadHome();
}

function loadHome() {
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function loadEditor() {
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'editor.html'));
}

// ---------------------------------------------------------------------------
// IPC: capture sources
// ---------------------------------------------------------------------------
ipcMain.handle('sources:list', async (_evt, opts) => {
  const types = (opts && opts.types) || ['screen', 'window'];
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 320, height: 200 },
  });

  return sources
    .filter((s) => s.thumbnail && !s.thumbnail.isEmpty())
    .map((s) => {
      const isScreen = s.id.startsWith('screen');
      const display = displays.find((d) => String(d.id) === String(s.display_id)) || screen.getPrimaryDisplay();
      return {
        id: s.id,
        name: s.name,
        kind: isScreen ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
        display: {
          id: display.id,
          bounds: display.bounds,
          scaleFactor: display.scaleFactor,
        },
      };
    });
});

// ---------------------------------------------------------------------------
// IPC: recording lifecycle
// ---------------------------------------------------------------------------
// Recording is streamed to disk chunk-by-chunk so we never hold the whole video
// in memory (a long capture can be gigabytes).
let recSession = null;

function endStream(stream) {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    stream.end(resolve);
  });
}

ipcMain.handle('rec:start', async (_evt, { display, kind }) => {
  const recBaseEpoch = Date.now();
  // Cursor coordinates only map cleanly onto a full-screen capture.
  if (kind !== 'window') {
    ensureMacCursorPermission();
    startCursorTracking(recBaseEpoch, display);
  } else {
    resetCursorTracking();
  }

  ensureDir(RECORDINGS_DIR);
  const stamp = new Date(recBaseEpoch)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const videoPath = path.join(RECORDINGS_DIR, `rec-${stamp}.webm`);

  recSession = {
    videoPath,
    cursorPath: path.join(RECORDINGS_DIR, `rec-${stamp}.cursor.json`),
    camPath: videoPath.replace(/\.webm$/, '.cam.webm'),
    display,
    recBaseEpoch,
    videoStream: fs.createWriteStream(videoPath),
    camStream: null,
  };
  return { recBaseEpoch };
});

ipcMain.handle('rec:videoChunk', async (_evt, buffer) => {
  if (recSession && recSession.videoStream) recSession.videoStream.write(Buffer.from(buffer));
  return { ok: true };
});

ipcMain.handle('rec:camChunk', async (_evt, buffer) => {
  if (!recSession) return { ok: false };
  if (!recSession.camStream) recSession.camStream = fs.createWriteStream(recSession.camPath);
  recSession.camStream.write(Buffer.from(buffer));
  return { ok: true };
});

ipcMain.handle('rec:finish', async (_evt, { hasAudio }) => {
  const cursorLog = stopCursorTracking();
  const s = recSession;
  recSession = null;
  if (!s) throw new Error('No active recording');

  await endStream(s.videoStream);
  await endStream(s.camStream);

  const hasCam = !!s.camStream;
  fs.writeFileSync(
    s.cursorPath,
    JSON.stringify({
      recBaseEpoch: s.recBaseEpoch,
      display: s.display,
      hasAudio,
      hasCam,
      samples: cursorLog.samples,
      clicks: cursorLog.clicks,
    })
  );

  currentProject = {
    videoPath: s.videoPath,
    cursorPath: s.cursorPath,
    camPath: hasCam ? s.camPath : null,
    hasAudio,
    hasCam,
    display: s.display,
    recBaseEpoch: s.recBaseEpoch,
  };
  return { ok: true };
});

ipcMain.handle('rec:abort', async () => {
  stopCursorTracking();
  const s = recSession;
  recSession = null;
  if (s) {
    try { s.videoStream.destroy(); } catch (_) {}
    try { if (s.camStream) s.camStream.destroy(); } catch (_) {}
    // Best-effort cleanup of the partial files.
    try { fs.unlinkSync(s.videoPath); } catch (_) {}
    try { if (s.camStream) fs.unlinkSync(s.camPath); } catch (_) {}
  }
  return { ok: true };
});

ipcMain.handle('editor:open', async () => {
  loadEditor();
  return { ok: true };
});

// List previously saved recordings (newest first).
ipcMain.handle('recordings:list', async () => {
  ensureDir(RECORDINGS_DIR);
  const files = fs
    .readdirSync(RECORDINGS_DIR)
    .filter((f) => f.endsWith('.webm') && !f.endsWith('.cam.webm'));

  const list = files.map((f) => {
    const videoPath = path.join(RECORDINGS_DIR, f);
    const stat = fs.statSync(videoPath);
    const camPath = videoPath.replace(/\.webm$/, '.cam.webm');
    return {
      videoPath,
      name: f,
      mtime: stat.mtimeMs,
      sizeMB: +(stat.size / (1024 * 1024)).toFixed(1),
      hasCam: fs.existsSync(camPath),
    };
  });
  list.sort((a, b) => b.mtime - a.mtime);
  return list;
});

// Re-open a saved recording in the editor.
ipcMain.handle('recordings:open', async (_evt, videoPath) => {
  if (!fs.existsSync(videoPath)) throw new Error('Recording not found');
  const cursorPath = videoPath.replace(/\.webm$/, '.cursor.json');
  const camPath = videoPath.replace(/\.webm$/, '.cam.webm');

  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  } catch (_) {
    meta = { display: screen.getPrimaryDisplay(), samples: [], clicks: [] };
  }

  // Older recordings may not have recorded hasAudio — probe the file.
  let hasAudio = meta.hasAudio;
  if (hasAudio === undefined) hasAudio = await probeHasAudio(videoPath);

  const hasCam = fs.existsSync(camPath);
  currentProject = { videoPath, cursorPath, camPath: hasCam ? camPath : null, hasAudio, hasCam, display: meta.display, recBaseEpoch: meta.recBaseEpoch };

  loadEditor();
  return { ok: true };
});

ipcMain.handle('editor:back-home', async () => {
  loadHome();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: editor data
// ---------------------------------------------------------------------------
ipcMain.handle('project:get', async () => {
  if (!currentProject) return null;
  const cursor = JSON.parse(fs.readFileSync(currentProject.cursorPath, 'utf8'));
  return {
    videoUrl: pathToFileUrl(currentProject.videoPath),
    videoPath: currentProject.videoPath,
    camUrl: currentProject.camPath ? pathToFileUrl(currentProject.camPath) : null,
    hasAudio: currentProject.hasAudio,
    hasCam: currentProject.hasCam,
    display: currentProject.display,
    cursor,
  };
});

function pathToFileUrl(p) {
  // Encodes spaces and special characters so paths like "C:\Users\John Doe\..."
  // produce a valid file:// URL the renderer can load.
  return pathToFileURL(p).href;
}

// ---------------------------------------------------------------------------
// IPC: export
// ---------------------------------------------------------------------------
ipcMain.handle('export:run', async (_evt, { zoomedBuffer, options }) => {
  if (!currentProject) throw new Error('No project loaded');

  const tmpZoomed = path.join(os.tmpdir(), `ssr-zoomed-${Date.now()}.webm`);
  fs.writeFileSync(tmpZoomed, Buffer.from(zoomedBuffer));

  const format = options.format || 'mp4';
  const FILTERS = {
    youtube: { name: 'MP4 Video (YouTube)', extensions: ['mp4'] },
    master: { name: 'MP4 Video (Editing master)', extensions: ['mp4'] },
    mp4: { name: 'MP4 Video', extensions: ['mp4'] },
    mov: { name: 'QuickTime Video', extensions: ['mov'] },
    webm: { name: 'WebM Video', extensions: ['webm'] },
    gif: { name: 'Animated GIF', extensions: ['gif'] },
  };
  const filter = FILTERS[format] || FILTERS.mp4;
  const defaultName = path.basename(currentProject.videoPath).replace(/\.webm$/, `.${filter.extensions[0]}`);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export video',
    defaultPath: path.join(RECORDINGS_DIR, defaultName),
    filters: [filter],
  });

  if (canceled || !filePath) {
    fs.unlinkSync(tmpZoomed);
    return { canceled: true };
  }

  try {
    await exportVideo({
      zoomedVideoPath: tmpZoomed,
      originalPath: currentProject.videoPath,
      hasAudio: currentProject.hasAudio,
      noiseProfile: options.noiseProfile,
      clickSound: options.clickSound,
      clickTimes: options.clickTimes || [],
      clickSoundName: options.clickSoundName || 'mouse',
      clickVolume: options.clickVolume != null ? options.clickVolume : 0.7,
      durationSec: options.durationSec || 0,
      format,
      quality: options.quality || 'balanced',
      resolution: options.resolution || 'original',
      outputPath: filePath,
      onProgress: (line) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('export:progress', line);
      },
    });
  } finally {
    try { fs.unlinkSync(tmpZoomed); } catch (_) {}
  }

  return { ok: true, outputPath: filePath };
});

// Render the cleaned mic audio for in-editor preview (cached per profile).
const audioPreviewCache = {}; // key `${videoPath}|${profile}` -> file path
ipcMain.handle('audio:preview', async (_evt, profile) => {
  if (!currentProject || !currentProject.hasAudio || profile === 'off') return null;
  const key = `${currentProject.videoPath}|${profile}`;
  if (audioPreviewCache[key] && fs.existsSync(audioPreviewCache[key])) {
    return pathToFileUrl(audioPreviewCache[key]);
  }
  const out = path.join(os.tmpdir(), `ssr-clean-${profile}-${Date.now()}.m4a`);
  await exportCleanAudio({ inputPath: currentProject.videoPath, noiseProfile: profile, outputPath: out });
  audioPreviewCache[key] = out;
  return pathToFileUrl(out);
});

ipcMain.handle('file:reveal', async (_evt, p) => {
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('shortcut:get', async () => RECORD_SHORTCUT);

// ---------------------------------------------------------------------------
// IPC: persisted user preferences
// ---------------------------------------------------------------------------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
let settingsCache = null;
function readSettings() {
  if (settingsCache) return settingsCache;
  try {
    settingsCache = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (_) {
    settingsCache = {};
  }
  return settingsCache;
}
let settingsWriteTimer = null;
function flushSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settingsCache, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err.message);
  }
}
ipcMain.handle('settings:get', async () => readSettings());
ipcMain.handle('settings:set', async (_evt, patch) => {
  const s = readSettings();
  Object.assign(s, patch || {});
  settingsCache = s;
  // Debounce disk writes so dragging a slider doesn't write the file dozens of
  // times per second.
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(flushSettings, 300);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Auto-grant media (mic) permission requests from our own renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture' || permission === 'display-capture');
  });

  requestMacMediaAccess();
  createWindow();

  globalShortcut.register(RECORD_SHORTCUT, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shortcut:toggle-record');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (settingsWriteTimer) { clearTimeout(settingsWriteTimer); flushSettings(); }
});

app.on('window-all-closed', () => {
  stopCursorTracking();
  if (process.platform !== 'darwin') app.quit();
});
