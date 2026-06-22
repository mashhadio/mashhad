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

// Deep link straight to System Settings → Privacy & Security → Screen Recording.
const SCREEN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

// Unlike camera/mic, macOS has no API to *prompt* for screen recording — the
// user must enable it manually, and the grant only takes effect after a relaunch.
// 'granted' | 'denied' | 'restricted' | 'not-determined' ('granted' off macOS).
function screenAccessStatus() {
  if (!isMac) return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch (_) {
    return 'granted'; // older Electron / unknown — don't block recording
  }
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
    backgroundColor: '#090b10',
    title: 'مشهد',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep timers/rAF running when the window is occluded so the region-crop
      // draw loop doesn't freeze while the user interacts with the app behind it.
      backgroundThrottling: false,
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
// IPC: drag-to-select recording area
// ---------------------------------------------------------------------------
// Opens a transparent overlay covering the given display and resolves with the
// chosen rectangle { x, y, w, h } in DIP relative to that display's top-left, or
// null if the user cancels.
function selectRegion(display) {
  return new Promise((resolve) => {
    const b = display.bounds;
    const overlay = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'region-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Float above everything, including the macOS menu bar and full-screen apps.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (isMac) overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true });
    overlay.setBounds(b); // ensure it covers the exact display, menu bar included

    let settled = false;
    const finish = (rect) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('region:result', onResult);
      try { if (!overlay.isDestroyed()) overlay.close(); } catch (_) {}
      resolve(rect || null);
    };
    const onResult = (evt, rect) => {
      if (evt.sender === overlay.webContents) finish(rect);
    };
    ipcMain.on('region:result', onResult);
    overlay.on('closed', () => finish(null)); // covers Cmd+W / focus-loss closes

    overlay.loadFile(path.join(__dirname, '..', 'renderer', 'region-overlay.html'));
    overlay.focus();
  });
}

ipcMain.handle('region:select', async (_evt, { display }) => {
  if (!display || !display.bounds) return null;
  return selectRegion(display);
});

// ---------------------------------------------------------------------------
// IPC: screen-recording permission (macOS)
// ---------------------------------------------------------------------------
ipcMain.handle('screen:status', async () => screenAccessStatus());

ipcMain.handle('screen:openSettings', async () => {
  if (isMac) await shell.openExternal(SCREEN_SETTINGS_URL);
  return { ok: true };
});

// Returns { ok: true } when capture may proceed. When access is denied/restricted
// it shows a native dialog whose primary button opens the right Settings pane,
// and returns { ok: false } so the caller can bail instead of recording black.
ipcMain.handle('screen:ensure', async () => {
  const status = screenAccessStatus();
  // 'not-determined' is left to proceed: the first capture call makes macOS show
  // its own system prompt and add the app to the Screen Recording list.
  if (status === 'granted' || status === 'not-determined') return { ok: true, status };

  const appName = app.getName();
  const isDev = !app.isPackaged;
  const detail = isDev
    ? `افتح إعدادات النظام ← الخصوصية والأمان ← تسجيل الشاشة وفعّل «Electron»، ثم أغلق التطبيق وأعد فتحه.\n\n(أثناء التطوير يكون البرنامج العامل هو Electron، لذا يظهر الإدخال باسم «Electron» وليس «${appName}».)`
    : `افتح إعدادات النظام ← الخصوصية والأمان ← تسجيل الشاشة وفعّل «${appName}»، ثم أغلق التطبيق وأعد فتحه.`;

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['فتح إعدادات النظام', 'إلغاء'],
    defaultId: 0,
    cancelId: 1,
    title: 'يلزم إذن تسجيل الشاشة',
    message: 'هذا التطبيق غير مسموح له بتسجيل شاشتك بعد.',
    detail,
  });
  if (response === 0) {
    try { await shell.openExternal(SCREEN_SETTINGS_URL); } catch (_) {}
  }
  return { ok: false, status };
});

// ---------------------------------------------------------------------------
// IPC: capture sources
// ---------------------------------------------------------------------------
ipcMain.handle('sources:list', async (_evt, opts) => {
  const types = (opts && opts.types) || ['screen', 'window'];
  const displays = screen.getAllDisplays();
  // On macOS this throws when Screen Recording access is denied — treat it as
  // "no sources" so the renderer can surface the permission banner instead of a
  // raw IPC error.
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 200 },
    });
  } catch (err) {
    console.warn('desktopCapturer.getSources failed:', err.message);
    return [];
  }

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

ipcMain.handle('rec:start', async (_evt, { display, kind, region }) => {
  const recBaseEpoch = Date.now();
  // Cursor coordinates only map cleanly onto a full-screen (or cropped-region)
  // capture. When a region is set, clicks are normalised relative to it.
  if (kind !== 'window') {
    ensureMacCursorPermission();
    startCursorTracking(recBaseEpoch, display, region);
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
    region: region || null,
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
  if (!s) throw new Error('لا يوجد تسجيل نشط');

  await endStream(s.videoStream);
  await endStream(s.camStream);

  const hasCam = !!s.camStream;
  fs.writeFileSync(
    s.cursorPath,
    JSON.stringify({
      recBaseEpoch: s.recBaseEpoch,
      display: s.display,
      region: s.region,
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
  // Encodes spaces and special characters so paths like "/Users/John Doe/..."
  // or "C:\Users\John Doe\..." produce a valid file:// URL the renderer can load.
  return pathToFileURL(p).href;
}

// ---------------------------------------------------------------------------
// IPC: export
// ---------------------------------------------------------------------------
ipcMain.handle('export:run', async (_evt, { zoomedBuffer, options }) => {
  if (!currentProject) throw new Error('لم يُحمَّل أي مشروع');

  const tmpZoomed = path.join(os.tmpdir(), `ssr-zoomed-${Date.now()}.webm`);
  fs.writeFileSync(tmpZoomed, Buffer.from(zoomedBuffer));

  const format = options.format || 'mp4';
  const FILTERS = {
    youtube: { name: 'فيديو MP4 (يوتيوب)', extensions: ['mp4'] },
    master: { name: 'فيديو MP4 (نسخة تعديل رئيسية)', extensions: ['mp4'] },
    mp4: { name: 'فيديو MP4', extensions: ['mp4'] },
    mov: { name: 'فيديو QuickTime', extensions: ['mov'] },
    webm: { name: 'فيديو WebM', extensions: ['webm'] },
    gif: { name: 'GIF متحرك', extensions: ['gif'] },
  };
  const filter = FILTERS[format] || FILTERS.mp4;
  const defaultName = path.basename(currentProject.videoPath).replace(/\.webm$/, `.${filter.extensions[0]}`);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'تصدير الفيديو',
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
      clips: options.clips || null,
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
