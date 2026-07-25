'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell, session, globalShortcut, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const { startCursorTracking, stopCursorTracking, resetCursorTracking } = require('./cursor-tracker');
const { exportVideo, exportCleanAudio, probeHasAudio, killAllFfmpeg } = require('./ffmpeg-export');

// ---------------------------------------------------------------------------
// Paths / state
// ---------------------------------------------------------------------------
const RECORDINGS_DIR = path.join(app.getPath('videos'), 'SmoothScreenRecorder');
// Saved project files (.ssproj) and their persistent assets (voice-overs) live
// here so a project can be reopened long after the session that created it.
const PROJECTS_DIR = path.join(RECORDINGS_DIR, 'Projects');
const PROJECT_ASSETS_DIR = path.join(PROJECTS_DIR, 'assets');
const PROJECT_EXT = 'ssproj';

// Origin of our own renderer pages (index.html, editor.html, ...), used to scope
// the permission handler and the navigation guard below to content we actually
// ship — defense-in-depth in case a future change ever loads remote content.
const RENDERER_ORIGIN = pathToFileURL(path.join(__dirname, '..', 'renderer')).href + '/';

function isPathInside(candidate, dir) {
  const resolvedDir = path.resolve(dir);
  const resolved = path.resolve(candidate);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

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

// mainWindow is never explicitly nulled on 'closed', so a dialog() call made
// in a gap after the window closes (but before its handlers finish) could
// otherwise pass a destroyed BrowserWindow as the parent. Use this instead of
// `mainWindow` directly everywhere a native dialog needs a parent.
function dialogParent() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

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
// Absolute path of the .ssproj file backing the current session, once the user
// has saved (or opened) one — lets Save and auto-save write without re-prompting.
let currentProjectFile = null;
// Edit-state parsed from an opened .ssproj, handed to the editor once it loads.
let pendingProject = null; // { edit, sources } | null

// Timeline media sources keyed by id. The editor's clips reference these by id;
// export resolves each clip's audio back to a file here. The recording (when the
// editor was opened from one) is registered as id 'rec'; imported videos get
// ids like 'imp_1'. Reset whenever a fresh editor session is opened.
let mediaSources = {}; // id -> { path, hasAudio, kind: 'recording' | 'import' | 'voiceover' }
let importSeq = 1;
let voiceOverSeq = 1;

function resetMediaSources() {
  // Voice-overs are kept on disk (in PROJECT_ASSETS_DIR) so saved projects that
  // reference them survive across sessions; they're no longer deleted here.
  mediaSources = {};
  importSeq = 1;
  voiceOverSeq = 1;
}

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

  // Disable Chromium's whole-app zoom (pinch, Ctrl/Cmd +/-/0, and Ctrl+wheel) so
  // the recorder/editor UI never scales unexpectedly.
  const wc = mainWindow.webContents;
  wc.setVisualZoomLevelLimits(1, 1);
  wc.on('before-input-event', (e, input) => {
    if ((input.control || input.meta) && ['=', '+', '-', '0'].includes(input.key)) e.preventDefault();
  });
  wc.on('zoom-changed', () => { wc.setZoomLevel(0); });
  wc.on('did-finish-load', () => { wc.setZoomLevel(0); wc.setZoomFactor(1); });

  // Defense-in-depth: this window only ever shows our own local pages and never
  // opens links or navigates elsewhere, but with no guard here a stray/injected
  // link could pop an arbitrary external window or navigate the app shell away
  // from itself. Deny/block by default.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(RENDERER_ORIGIN)) e.preventDefault();
  });

  // If the main window closes mid-recording, tear down the always-on-top overlay
  // windows so they don't keep the app alive (blocking 'window-all-closed').
  mainWindow.on('closed', () => { hideSceneIndicator(); hideRecFrame(); });

  // Tell the renderer when the window gains/loses focus so it can pause the live
  // previews while the user is working in another app (backgroundThrottling is
  // off, so previews would otherwise keep capturing the screen in the background).
  const sendFocus = (focused) => { if (!wc.isDestroyed()) wc.send('window:focus', focused); };
  mainWindow.on('focus', () => sendFocus(true));
  mainWindow.on('blur', () => sendFocus(false));

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
function selectRegion(display, aspect) {
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

    // Pass the locked aspect (w/h) to the overlay so it can constrain the drag.
    const query = aspect ? { aspect: String(aspect) } : undefined;
    overlay.loadFile(path.join(__dirname, '..', 'renderer', 'region-overlay.html'), { query });
    overlay.focus();
  });
}

ipcMain.handle('region:select', async (_evt, { display, aspect }) => {
  if (!display || !display.bounds) return null;
  return selectRegion(display, aspect);
});

// ---------------------------------------------------------------------------
// Recording frame: a click-through outline drawn around the captured region
// while recording, so the user can see exactly what is being recorded. It is
// excluded from the screen capture itself via setContentProtection (Windows:
// WDA_EXCLUDEFROMCAPTURE, macOS: NSWindowSharingNone), and the border is drawn
// just outside the crop as a second line of defence, so it never lands in the
// saved video.
// ---------------------------------------------------------------------------
let recFrameWin = null;

// Shared config for a transparent, click-through, always-on-top, capture-
// excluded overlay window — used by both the recording-frame outline and the
// scene indicator badge below, which used to repeat this whole options object
// verbatim. `extra` lets a caller override/add BrowserWindow options.
function createOverlayWindow(bounds, extra = {}) {
  // Pull webPreferences out of `extra` and MERGE it into the secure base rather
  // than letting the top-level spread replace it wholesale — so a caller adding
  // (say) a preload doesn't have to restate contextIsolation/nodeIntegration,
  // and a future tightening of the base default here can't be silently shadowed.
  const { webPreferences: extraWebPrefs, ...restExtra } = extra;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // never steals focus from the app being recorded/captured
    alwaysOnTop: true,
    ...restExtra,
    webPreferences: { contextIsolation: true, nodeIntegration: false, ...extraWebPrefs },
  });
  win.setIgnoreMouseEvents(true); // clicks pass straight through to apps below
  win.setContentProtection(true); // keep it out of the capture
  win.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true });
  return win;
}

function showRecFrame(display, region) {
  hideRecFrame();
  const b = display.bounds;
  const win = createOverlayWindow(b, { enableLargerThanScreen: true });
  win.setBounds(b);

  const query = {
    x: String(region.x), y: String(region.y), w: String(region.w), h: String(region.h),
  };
  win.loadFile(path.join(__dirname, '..', 'renderer', 'rec-frame.html'), { query });
  win.on('closed', () => { if (recFrameWin === win) recFrameWin = null; });
  recFrameWin = win;
}

function hideRecFrame() {
  if (recFrameWin) {
    try { if (!recFrameWin.isDestroyed()) recFrameWin.close(); } catch (_) {}
    recFrameWin = null;
  }
}

ipcMain.handle('frame:show', (_evt, { display, region } = {}) => {
  if (display && display.bounds && region) showRecFrame(display, region);
});
ipcMain.handle('frame:hide', () => hideRecFrame());

// ---------------------------------------------------------------------------
// Scenes: F1/F2/F3 switch screen / cam / both while recording. Switches are
// logged on the recBaseEpoch time axis (like the cursor log) and the editor
// composites them; a small content-protected indicator shows the current scene.
// ---------------------------------------------------------------------------
const SCENE_KEYS = { F1: 'screen', F2: 'cam', F3: 'both' };

function setScene(scene) {
  if (!recSession || !recSession.scenes) return;
  if (scene === recSession.currentScene) return; // ignore no-op repeats
  recSession.scenes.push({ t: Date.now() - recSession.recBaseEpoch, scene });
  recSession.currentScene = scene;
  updateSceneIndicator(scene);
}

function registerSceneShortcuts() {
  for (const [key, scene] of Object.entries(SCENE_KEYS)) {
    try { globalShortcut.register(key, () => setScene(scene)); } catch (_) {}
  }
}
function unregisterSceneShortcuts() {
  for (const key of Object.keys(SCENE_KEYS)) {
    try { globalShortcut.unregister(key); } catch (_) {}
  }
}

let sceneIndicatorWin = null;
function showSceneIndicator(display, scene, region) {
  hideSceneIndicator();
  const b = display.bounds;
  // Center over the captured area — the region when cropping, else the display —
  // so the badge sits inside the recorded frame.
  const area = region
    ? { x: b.x + region.x, y: b.y + region.y, w: region.w, h: region.h }
    : { x: b.x, y: b.y, w: b.width, h: b.height };
  const W = 150; const H = 40;
  const win = createOverlayWindow(
    { x: Math.round(area.x + (area.w - W) / 2), y: Math.round(area.y + 14), width: W, height: H },
    // contextIsolation/nodeIntegration come from createOverlayWindow's secure
    // base now (merged, not overwritten) — only the preload is caller-specific.
    { webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'scene-indicator-preload.js'),
    } },
  );
  win.loadFile(path.join(__dirname, '..', 'renderer', 'scene-indicator.html'), { query: { scene } });
  // Re-apply the current scene once the page's script is ready, so a switch that
  // fires before load doesn't leave the badge stale.
  win.webContents.on('did-finish-load', () => {
    if (recSession && recSession.currentScene) updateSceneIndicator(recSession.currentScene);
  });
  win.on('closed', () => { if (sceneIndicatorWin === win) sceneIndicatorWin = null; });
  sceneIndicatorWin = win;
}
function updateSceneIndicator(scene) {
  if (!sceneIndicatorWin || sceneIndicatorWin.isDestroyed()) return;
  sceneIndicatorWin.webContents.send('scene:update', scene);
}
function hideSceneIndicator() {
  if (sceneIndicatorWin) {
    try { if (!sceneIndicatorWin.isDestroyed()) sceneIndicatorWin.close(); } catch (_) {}
    sceneIndicatorWin = null;
  }
}

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

  const { response } = await dialog.showMessageBox(dialogParent(), {
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
    // If an I/O error already destroyed the stream, end()'s callback may never
    // fire and rec:finish would await forever — resolve on close/error too.
    if (stream.destroyed || stream.writableEnded) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    stream.once('close', finish);
    stream.once('error', finish);
    stream.end(finish);
  });
}

// Create a recording write stream with a PERSISTENT 'error' listener. A Node
// WritableStream that emits 'error' with no listener rethrows it as an uncaught
// exception; with no uncaughtException handler that kills the whole main process
// mid-recording (disk full, drive unplugged, permission loss) — losing the take.
// writeChunkBackpressured only attaches a transient listener while a write is
// actually backpressured, so an async flush failure at any other moment is
// unguarded. Record the error on the owning session so rec:finish can surface it,
// mirroring the export-capture guard on export:beginCapture.
function makeRecStream(filePath, session, label) {
  const stream = fs.createWriteStream(filePath);
  stream.on('error', (err) => {
    if (session) session.streamError = err;
    console.error(`[rec] ${label} stream error:`, err && err.message);
  });
  return stream;
}

// Write one chunk, honoring the stream's backpressure. If write() returns false
// we must wait before acknowledging the next chunk — but waiting on 'drain'
// ALONE can hang forever: if the stream is destroyed while we're waiting (e.g.
// discardSession() tears down an abandoned session, or the cam/export capture is
// aborted mid-flight), 'drain' never fires, this promise never settles, and the
// renderer's chunk-write chain wedges silently. destroy() DOES emit 'close'
// (and 'error' on failure), so resolve on any of the three and detach the rest.
function writeChunkBackpressured(stream, buffer) {
  if (stream.write(buffer)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.removeListener('drain', done);
      stream.removeListener('close', done);
      stream.removeListener('error', done);
      resolve();
    };
    stream.once('drain', done);
    stream.once('close', done);
    stream.once('error', done);
  });
}

// Best-effort teardown of an abandoned session: destroys its write streams and
// removes whatever partial files it had started, without touching the cursor
// tracker / scene shortcuts (the caller decides whether those still apply).
function discardSession(s) {
  try { s.videoStream.destroy(); } catch (_) {}
  try { if (s.camStream) s.camStream.destroy(); } catch (_) {}
  try { fs.unlinkSync(s.videoPath); } catch (_) {}
  try { if (s.camStream) fs.unlinkSync(s.camPath); } catch (_) {}
}

ipcMain.handle('rec:start', async (_evt, { display, kind, region, scene, transition }) => {
  if (recSession) {
    // The renderer's own state machine should prevent this, but guard here too:
    // overwriting `recSession` while one is already live would leak its write
    // stream and orphan its partial file (see the "arming race" finding).
    console.warn('rec:start called with an active recSession — discarding the stale one first');
    stopCursorTracking();
    unregisterSceneShortcuts();
    hideSceneIndicator();
    discardSession(recSession);
    recSession = null;
  }
  const recBaseEpoch = Date.now();
  // Camera mode has no display; default to the primary so project fields stay valid.
  if (!display) display = screen.getPrimaryDisplay();
  // Cursor coordinates only map cleanly onto a full-screen (or cropped-region)
  // capture — only track for screen recordings (not window or camera).
  if (kind === 'screen') {
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

  // Scene mode: `scene` is the starting scene ('screen'|'cam'|'both'); when set we
  // log switches (F1/F2/F3) on the recBaseEpoch time axis and show the indicator.
  const scenesOn = scene === 'screen' || scene === 'cam' || scene === 'both';

  recSession = {
    videoPath,
    cursorPath: path.join(RECORDINGS_DIR, `rec-${stamp}.cursor.json`),
    camPath: videoPath.replace(/\.webm$/, '.cam.webm'),
    scenesPath: path.join(RECORDINGS_DIR, `rec-${stamp}.scenes.json`),
    display,
    region: region || null,
    recBaseEpoch,
    videoStream: null,
    camStream: null,
    streamError: null,
    scenes: scenesOn ? [{ t: 0, scene }] : null,
    transition: scenesOn ? (Number(transition) || 0) : 0,
    currentScene: scenesOn ? scene : null,
  };
  recSession.videoStream = makeRecStream(videoPath, recSession, 'video');

  if (scenesOn) {
    registerSceneShortcuts();
    showSceneIndicator(display, scene, region || null);
  }
  return { recBaseEpoch };
});

ipcMain.handle('rec:videoChunk', async (_evt, buffer) => {
  if (recSession && recSession.videoStream) {
    // Honor the stream's backpressure signal: if disk I/O falls behind a
    // high-bitrate capture, wait before acknowledging the next chunk instead of
    // letting Node buffer writes in memory unboundedly.
    await writeChunkBackpressured(recSession.videoStream, Buffer.from(buffer));
  }
  return { ok: true };
});

ipcMain.handle('rec:camChunk', async (_evt, buffer) => {
  if (!recSession) return { ok: false };
  // The cam encoder can have errored and been dropped (rec:dropCam) while a
  // chunk was already in flight — don't recreate the stream we just deleted.
  if (recSession.camDropped) return { ok: false };
  if (!recSession.camStream) recSession.camStream = makeRecStream(recSession.camPath, recSession, 'cam');
  await writeChunkBackpressured(recSession.camStream, Buffer.from(buffer));
  return { ok: true };
});

// The renderer's webcam encoder failed mid-recording; abandon the (now truncated)
// cam track entirely so the finished recording is cleanly screen-only, matching
// what the user was told on screen. Screen capture is untouched and keeps writing.
ipcMain.handle('rec:dropCam', async () => {
  if (!recSession) return { ok: false };
  const s = recSession;
  s.camDropped = true;
  if (s.camStream) {
    // Any in-flight rec:camChunk awaiting backpressure resolves on 'close' (see
    // writeChunkBackpressured), so destroying here can't wedge the renderer.
    try { s.camStream.destroy(); } catch (_) {}
    s.camStream = null;
  }
  try { fs.unlinkSync(s.camPath); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('rec:finish', async (_evt, { hasAudio }) => {
  const cursorLog = stopCursorTracking();
  const s = recSession;
  recSession = null;
  if (!s) throw new Error('لا يوجد تسجيل نشط');

  await endStream(s.videoStream);
  await endStream(s.camStream);

  // Scene mode ends with recording: stop the hotkeys + indicator and persist log.
  unregisterSceneShortcuts();
  hideSceneIndicator();

  const hasCam = !!s.camStream;
  // Async write: the cursor log can be tens of thousands of samples (multi-MB for
  // a long capture), so writing it synchronously stalled the main process right at
  // record-stop. rec:finish is already async and its result is awaited.
  await fs.promises.writeFile(
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

  let scenesPath = null;
  if (s.scenes && s.scenes.length) {
    await fs.promises.writeFile(s.scenesPath, JSON.stringify({
      recBaseEpoch: s.recBaseEpoch, transition: s.transition, events: s.scenes,
    }));
    scenesPath = s.scenesPath;
  }

  currentProject = {
    videoPath: s.videoPath,
    cursorPath: s.cursorPath,
    camPath: hasCam ? s.camPath : null,
    scenesPath,
    hasAudio,
    hasCam,
    display: s.display,
    recBaseEpoch: s.recBaseEpoch,
  };
  currentProjectFile = null; // fresh recording — not tied to any saved project yet
  pendingProject = null;
  // If a write stream errored mid-capture the video/cam file is truncated; report
  // it so the renderer can warn instead of opening a silently-broken recording.
  return { ok: true, streamError: s.streamError ? String(s.streamError.message || s.streamError) : null };
});

ipcMain.handle('rec:abort', async () => {
  stopCursorTracking();
  unregisterSceneShortcuts();
  hideSceneIndicator();
  const s = recSession;
  recSession = null;
  if (s) discardSession(s);
  return { ok: true };
});

ipcMain.handle('editor:open', async () => {
  currentProjectFile = null;
  pendingProject = null;
  resetMediaSources();
  loadEditor();
  return { ok: true };
});

// Open the studio with no recording — a blank timeline the user fills by
// importing videos.
ipcMain.handle('studio:open', async () => {
  currentProject = null;
  currentProjectFile = null;
  pendingProject = null;
  resetMediaSources();
  loadEditor();
  return { ok: true };
});

// Let the user pick one or more video files to add to the timeline. Each becomes
// a registered media source; the editor creates a clip per file.
// Shared dialog -> probe -> register-source loop for source:import and
// source:importAudio, which differed only in the dialog config, the probe's
// fallback default, and whether an audio-less file is skipped entirely.
async function importSourceFiles({ title, filters, defaultHasAudio, skipIfNoAudio }) {
  const { canceled, filePaths } = await dialog.showOpenDialog(dialogParent(), {
    title,
    properties: ['openFile', 'multiSelections'],
    filters,
  });
  if (canceled || !filePaths.length) return [];

  const out = [];
  for (const p of filePaths) {
    if (!fs.existsSync(p)) continue;
    let hasAudio = defaultHasAudio;
    try { hasAudio = await probeHasAudio(p); } catch (_) {}
    if (skipIfNoAudio && !hasAudio) continue; // no audio stream — nothing to add
    const id = `imp_${importSeq++}`;
    mediaSources[id] = { path: p, hasAudio, kind: 'import' };
    out.push({ id, url: pathToFileUrl(p), name: path.basename(p), hasAudio });
  }
  return out;
}

ipcMain.handle('source:import', async () => importSourceFiles({
  title: 'إضافة فيديو',
  filters: [
    { name: 'ملفات الفيديو', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi'] },
    { name: 'كل الملفات', extensions: ['*'] },
  ],
  defaultHasAudio: false,
  skipIfNoAudio: false,
}));

// Import audio files (voice notes / music) as timeline audio sources.
ipcMain.handle('source:importAudio', async () => importSourceFiles({
  title: 'إضافة ملف صوتي',
  filters: [
    { name: 'ملفات الصوت', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'] },
    { name: 'كل الملفات', extensions: ['*'] },
  ],
  defaultHasAudio: true,
  skipIfNoAudio: true,
}));

// Save a recorded voice-over blob to a temp file and register it as an audio
// source so the export can resolve its path (like an imported clip).
ipcMain.handle('voiceover:save', async (_evt, buffer) => {
  if (!buffer) return null;
  const id = `vo_${voiceOverSeq++}`;
  // Persistent (not tmp) so a saved project can still resolve this take later.
  ensureDir(PROJECT_ASSETS_DIR);
  const p = path.join(PROJECT_ASSETS_DIR, `vo-${Date.now()}-${id}.webm`);
  await fs.promises.writeFile(p, Buffer.from(buffer));
  mediaSources[id] = { path: p, hasAudio: true, kind: 'voiceover' };
  return { id, url: pathToFileUrl(p), path: p };
});

// List previously saved recordings (newest first).
ipcMain.handle('recordings:list', async () => {
  ensureDir(RECORDINGS_DIR);
  const fsp = fs.promises;
  const allFiles = await fsp.readdir(RECORDINGS_DIR);
  const files = allFiles.filter((f) => f.endsWith('.webm') && !f.endsWith('.cam.webm'));

  const list = await Promise.all(files.map(async (f) => {
    const videoPath = path.join(RECORDINGS_DIR, f);
    const camPath = videoPath.replace(/\.webm$/, '.cam.webm');
    // stat() and the cam-existence check touch different, independent files —
    // run them concurrently so each recording costs one round-trip, not two.
    const [stat, hasCam] = await Promise.all([
      fsp.stat(videoPath),
      fsp.access(camPath).then(() => true, () => false),
    ]);
    return {
      videoPath,
      name: f,
      mtime: stat.mtimeMs,
      sizeMB: +(stat.size / (1024 * 1024)).toFixed(1),
      hasCam,
    };
  }));
  list.sort((a, b) => b.mtime - a.mtime);
  return list;
});

// Re-open a saved recording in the editor.
ipcMain.handle('recordings:open', async (_evt, videoPath) => {
  // This handler only ever legitimately opens one of OUR OWN previously-recorded
  // files (as listed by recordings:list) — confine it to RECORDINGS_DIR so a
  // renderer-supplied path can't reach an arbitrary file elsewhere on disk.
  if (typeof videoPath !== 'string' || !isPathInside(videoPath, RECORDINGS_DIR)) {
    throw new Error('Invalid recording path');
  }
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
  const scenesPath = videoPath.replace(/\.webm$/, '.scenes.json');
  currentProject = {
    videoPath, cursorPath, camPath: hasCam ? camPath : null,
    scenesPath: fs.existsSync(scenesPath) ? scenesPath : null,
    hasAudio, hasCam, display: meta.display, recBaseEpoch: meta.recBaseEpoch,
  };

  currentProjectFile = null; // opening the raw recording, not a saved project
  pendingProject = null;
  resetMediaSources();
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
  if (!currentProject) return { recording: null };
  // The cursor sidecar may be gone (e.g. a saved project whose recording folder
  // was moved). Fall back to empty tracking data so the editor still opens with
  // a graceful "missing file" notice instead of failing to initialize.
  let cursor;
  try {
    cursor = JSON.parse(fs.readFileSync(currentProject.cursorPath, 'utf8'));
  } catch (_) {
    cursor = { display: currentProject.display || screen.getPrimaryDisplay(), samples: [], clicks: [] };
  }
  // Register the recording as the timeline's first media source.
  mediaSources.rec = { path: currentProject.videoPath, hasAudio: currentProject.hasAudio, kind: 'recording' };
  // Scene switches (screen/cam/both), if this recording used scene mode.
  let scenes = null;
  if (currentProject.scenesPath) {
    try { scenes = JSON.parse(fs.readFileSync(currentProject.scenesPath, 'utf8')); } catch (_) {}
  }
  return {
    recording: {
      id: 'rec',
      videoUrl: pathToFileUrl(currentProject.videoPath),
      videoPath: currentProject.videoPath,
      camUrl: currentProject.camPath ? pathToFileUrl(currentProject.camPath) : null,
      hasAudio: currentProject.hasAudio,
      hasCam: currentProject.hasCam,
      display: currentProject.display,
      cursor,
      scenes,
    },
  };
});

function pathToFileUrl(p) {
  // Encodes spaces and special characters so paths like "/Users/John Doe/..."
  // or "C:\Users\John Doe\..." produce a valid file:// URL the renderer can load.
  return pathToFileURL(p).href;
}

// ---------------------------------------------------------------------------
// IPC: project save / open (.ssproj). A project file is a JSON snapshot of the
// editor's edit-state plus references (absolute paths) to every media file it
// uses, so the whole timeline can be rebuilt later. Media (recording, imports,
// voice-overs) is referenced in place — not copied — since those live in
// persistent folders.
// ---------------------------------------------------------------------------

// Turn the renderer's edit-state + source manifest into the object we persist.
// The recording's file paths come from currentProject (the renderer only knows
// URLs); imported/voice-over paths are resolved from mediaSources by id.
function buildProjectData({ edit, sources }) {
  const rec = currentProject
    ? {
        videoPath: currentProject.videoPath,
        cursorPath: currentProject.cursorPath,
        camPath: currentProject.camPath || null,
        scenesPath: currentProject.scenesPath || null,
        hasAudio: currentProject.hasAudio,
        hasCam: currentProject.hasCam,
        display: currentProject.display,
        recBaseEpoch: currentProject.recBaseEpoch,
      }
    : null;
  const srcOut = (sources || []).map((s) => ({
    id: s.id, kind: s.kind, name: s.name, hasAudio: !!s.hasAudio, isVideo: !!s.isVideo,
    path: (mediaSources[s.id] && mediaSources[s.id].path) || s.path || null,
  })).filter((s) => s.path);
  return { format: PROJECT_EXT, version: 1, savedAt: Date.now(), recording: rec, sources: srcOut, edit };
}

function defaultProjectName() {
  const base = currentProject
    ? path.basename(currentProject.videoPath).replace(/\.[^.]+$/, '')
    : 'مشروع';
  return `${base}.${PROJECT_EXT}`;
}

// Best-effort background cleanup, run once at startup. The single-instance lock
// means no other run holds live references, and the in-memory caches don't
// survive a restart, so anything found here is safe to remove. Fully async (and
// called fire-and-forget after the window is created) so it never blocks startup
// or the event loop. Removes: (1) voice-over assets no saved project references,
// and (2) stale temp files from earlier sessions (cleaned-audio previews, and any
// export intermediate a crash left behind).
async function cleanupStaleFiles() {
  const fsp = fs.promises;
  // (1) Orphaned voice-over assets.
  try {
    const assets = await fsp.readdir(PROJECT_ASSETS_DIR).catch(() => []);
    if (assets.length) {
      const referenced = new Set();
      const projects = await fsp.readdir(PROJECTS_DIR).catch(() => []);
      for (const f of projects) {
        if (!f.endsWith(`.${PROJECT_EXT}`)) continue;
        try {
          const data = JSON.parse(await fsp.readFile(path.join(PROJECTS_DIR, f), 'utf8'));
          for (const s of data.sources || []) if (s.path) referenced.add(path.resolve(s.path));
        } catch (_) { /* skip unreadable project files */ }
      }
      for (const f of assets) {
        const full = path.resolve(path.join(PROJECT_ASSETS_DIR, f));
        if (!referenced.has(full)) await fsp.unlink(full).catch(() => {});
      }
    }
  } catch (_) { /* best-effort */ }
  // (2) Stale ssr-* temp files from previous runs (previews / intermediates).
  try {
    const tmp = os.tmpdir();
    for (const f of await fsp.readdir(tmp).catch(() => [])) {
      if (/^ssr-(clean|zoomed|vo)-/.test(f)) await fsp.unlink(path.join(tmp, f)).catch(() => {});
    }
  } catch (_) { /* best-effort */ }
}

// Atomic write: serialize to a temp file in the same directory, then rename over
// the target. A crash/power-loss mid-write leaves the previous good file intact
// instead of a truncated (unparseable) project.
// Async so the background autosave (fires while the user edits) and manual save
// don't block the main process — the write+rename of a large edit-state used to
// stall the UI thread on every autosave. buildProjectData/JSON.stringify stay
// synchronous (fast, CPU-bound) and run eagerly, capturing the state at call time;
// only the disk I/O is moved off the hot path. Writes are chained so an autosave
// firing while the previous one is mid-flight can't interleave on the shared .tmp
// path (a race the old synchronous write couldn't hit).
let projectWriteChain = Promise.resolve();
function writeProjectFile(target, payload) {
  const json = JSON.stringify(buildProjectData(payload), null, 2);
  const run = projectWriteChain.then(async () => {
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, json);
    await fs.promises.rename(tmp, target);
  });
  projectWriteChain = run.catch(() => {}); // keep the chain alive even if this write fails
  return run;
}

// Manual save. `saveAs` (or no bound file yet) prompts for a location; otherwise
// it overwrites the current project file silently.
ipcMain.handle('project:save', async (_evt, { edit, sources, saveAs }) => {
  let target = currentProjectFile;
  if (saveAs || !target) {
    ensureDir(PROJECTS_DIR);
    const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
      title: 'حفظ المشروع',
      defaultPath: path.join(PROJECTS_DIR, defaultProjectName()),
      filters: [{ name: 'مشروع مشهد', extensions: [PROJECT_EXT] }],
    });
    if (canceled || !filePath) return { canceled: true };
    target = filePath;
  }
  try {
    await writeProjectFile(target, { edit, sources });
  } catch (err) {
    return { error: err.message };
  }
  currentProjectFile = target;
  return { path: target, name: path.basename(target) };
});

// Background auto-save. Writes only when a project file is already bound (the
// user has saved at least once, or opened a project) — never prompts.
ipcMain.handle('project:autosave', async (_evt, { edit, sources }) => {
  if (!currentProjectFile) return { skipped: true };
  try {
    await writeProjectFile(currentProjectFile, { edit, sources });
    return { path: currentProjectFile };
  } catch (err) {
    return { error: err.message };
  }
});

// Open a .ssproj: parse it, rebuild currentProject + mediaSources, stash the
// edit-state for the editor to apply on load, then swap to the editor.
ipcMain.handle('project:open', async () => {
  ensureDir(PROJECTS_DIR);
  const { canceled, filePaths } = await dialog.showOpenDialog(dialogParent(), {
    title: 'فتح مشروع',
    defaultPath: PROJECTS_DIR,
    properties: ['openFile'],
    filters: [{ name: 'مشروع مشهد', extensions: [PROJECT_EXT] }],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  return loadProjectFile(filePaths[0]);
});

function loadProjectFile(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return { error: 'تعذّر قراءة ملف المشروع' };
  }
  if (!data || data.format !== PROJECT_EXT) return { error: 'ملف مشروع غير صالح' };

  // Rebuild the recording reference (studio-only projects have none).
  const missing = [];
  if (data.recording) {
    const r = data.recording;
    if (!fs.existsSync(r.videoPath)) missing.push(path.basename(r.videoPath));
    currentProject = {
      videoPath: r.videoPath,
      cursorPath: r.cursorPath,
      camPath: r.camPath && fs.existsSync(r.camPath) ? r.camPath : null,
      scenesPath: r.scenesPath && fs.existsSync(r.scenesPath) ? r.scenesPath : null,
      hasAudio: r.hasAudio,
      hasCam: !!(r.camPath && fs.existsSync(r.camPath)),
      display: r.display,
      recBaseEpoch: r.recBaseEpoch,
    };
  } else {
    currentProject = null;
  }

  // Rebuild the media-source registry so export/preview can resolve every clip.
  resetMediaSources();
  let maxImp = 0;
  let maxVo = 0;
  for (const s of data.sources || []) {
    if (s.id === 'rec') continue; // the recording is registered by project:get
    if (!s.path || !fs.existsSync(s.path)) { missing.push(s.name || (s.path ? path.basename(s.path) : s.id)); continue; }
    mediaSources[s.id] = { path: s.path, hasAudio: !!s.hasAudio, kind: s.kind };
    const m = /^imp_(\d+)$/.exec(s.id); if (m) maxImp = Math.max(maxImp, +m[1]);
    const v = /^vo_(\d+)$/.exec(s.id); if (v) maxVo = Math.max(maxVo, +v[1]);
  }
  importSeq = maxImp + 1;
  voiceOverSeq = maxVo + 1;

  // Hand every non-recording source to the editor. Present files get a fresh
  // file:// URL; a missing file gets url:null so the editor keeps the manifest
  // entry (with its original path) unrendered — re-saving then preserves the
  // reference instead of pruning it (e.g. an external drive that was unplugged).
  const okIds = new Set(Object.keys(mediaSources));
  const sourcesForEditor = (data.sources || [])
    .filter((s) => s.id !== 'rec')
    .map((s) => ({ ...s, url: okIds.has(s.id) ? pathToFileUrl(s.path) : null }));
  pendingProject = { edit: data.edit, sources: sourcesForEditor, missing };
  currentProjectFile = file;

  loadEditor();
  return { ok: true, name: path.basename(file), missing };
}

// The editor pulls its saved edit-state here right after loading (null when the
// session wasn't opened from a project file).
ipcMain.handle('project:pending', async () => {
  const p = pendingProject;
  pendingProject = null; // consume once so a later reload starts clean
  return p;
});

// Whether the current editor session is backed by a saved file (for UI state).
ipcMain.handle('project:file', async () => {
  return { path: currentProjectFile, name: currentProjectFile ? path.basename(currentProjectFile) : null };
});

// ---------------------------------------------------------------------------
// IPC: export
// ---------------------------------------------------------------------------
// The renderer streams its canvas capture to this temp file chunk-by-chunk
// (mirroring the rec:videoChunk pattern) instead of buffering the whole capture
// in renderer memory and sending it as one giant structured-clone IPC message
// that then had to be written with a blocking fs.writeFileSync on this process.
let exportCapture = null; // { path, stream }

ipcMain.handle('export:beginCapture', async () => {
  const p = path.join(os.tmpdir(), `ssr-zoomed-${Date.now()}.webm`);
  const stream = fs.createWriteStream(p);
  const cap = { path: p, stream, error: null };
  // A WritableStream that emits 'error' with no listener rethrows it as an
  // uncaught exception, which would kill the main process (there is no
  // uncaughtException handler). Keep a persistent listener so an I/O failure —
  // e.g. the temp partition filling mid-export — is recorded and surfaced from
  // export:endCapture instead, the way the old blocking writeFileSync rejected
  // this IPC gracefully. (writeChunkBackpressured attaches its own transient
  // 'error' listener; both firing is fine.)
  stream.on('error', (err) => { cap.error = err; });
  exportCapture = cap;
  return { ok: true };
});

ipcMain.handle('export:chunk', async (_evt, buffer) => {
  if (!exportCapture) return { ok: false };
  // Same backpressure-with-safe-teardown handling as recording chunks: if the
  // capture is aborted (stream destroyed) mid-write, the await still resolves.
  await writeChunkBackpressured(exportCapture.stream, Buffer.from(buffer));
  return { ok: true };
});

ipcMain.handle('export:endCapture', async () => {
  if (!exportCapture) return null;
  const cap = exportCapture;
  exportCapture = null;
  try {
    await new Promise((resolve, reject) => {
      // If a write already failed, the file is truncated — surface it rather
      // than flushing and returning a broken path. Otherwise flush, but still
      // reject if the final flush itself errors.
      if (cap.error) { reject(cap.error); return; }
      cap.stream.once('error', reject);
      cap.stream.end(() => { cap.stream.removeListener('error', reject); resolve(); });
    });
  } catch (err) {
    // Remove the unusable temp file (abortCapture can't — exportCapture is
    // already null) and reject the IPC so the renderer shows an export failure
    // instead of feeding a truncated file to ffmpeg.
    try { cap.stream.destroy(); } catch (_) {}
    try { fs.unlinkSync(cap.path); } catch (_) {}
    throw err;
  }
  return cap.path;
});

// Best-effort cleanup when the capture itself fails (e.g. the intermediate
// MediaRecorder errored) — otherwise the open stream/temp file would leak.
ipcMain.handle('export:abortCapture', async () => {
  if (!exportCapture) return { ok: true };
  const cap = exportCapture;
  exportCapture = null;
  try { cap.stream.destroy(); } catch (_) {}
  try { fs.unlinkSync(cap.path); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('export:run', async (_evt, { zoomedVideoPath, options }) => {
  // zoomedVideoPath is round-tripped from export:beginCapture, which always
  // creates the file inside the OS temp dir. Validate it the same way
  // recordings:open / file:reveal validate their renderer-supplied paths — a
  // crafted payload must not turn the fs.unlinkSync (arbitrary-file-delete) or
  // the ffmpeg -i input (arbitrary-file-read, muxed into the revealed output)
  // below into a primitive over any file on disk.
  if (typeof zoomedVideoPath !== 'string'
      || !isPathInside(zoomedVideoPath, os.tmpdir())
      || !fs.existsSync(zoomedVideoPath)) {
    throw new Error('Invalid export capture path');
  }
  const tmpZoomed = zoomedVideoPath;

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
  const baseName = currentProject
    ? path.basename(currentProject.videoPath).replace(/\.webm$/, '')
    : 'mashhad-export';
  const defaultName = `${baseName}.${filter.extensions[0]}`;
  const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
    title: 'تصدير الفيديو',
    defaultPath: path.join(RECORDINGS_DIR, defaultName),
    filters: [filter],
  });

  if (canceled || !filePath) {
    try { fs.unlinkSync(tmpZoomed); } catch (_) {}
    return { canceled: true };
  }

  // Resolve each clip's audio back to a registered source file. Clips that
  // reference an unknown/missing source are treated as silent.
  const clips = Array.isArray(options.clips) ? options.clips : null;
  const overlayClips = Array.isArray(options.overlayClips) ? options.overlayClips : [];
  const sourceInfo = {};
  for (const id of Object.keys(mediaSources)) {
    const s = mediaSources[id];
    sourceInfo[id] = { path: s.path, hasAudio: s.hasAudio, kind: s.kind };
  }

  try {
    await exportVideo({
      zoomedVideoPath: tmpZoomed,
      clips,
      overlayClips,
      recordingAudioMuted: !!options.recordingAudioMuted,
      sources: sourceInfo,
      recordingSourceId: mediaSources.rec ? 'rec' : null,
      noiseProfile: options.noiseProfile,
      echoLevel: options.echoLevel || 'off',
      clickSound: options.clickSound,
      clickTimes: options.clickTimes || [],
      clickSoundName: options.clickSoundName || 'mouse',
      clickVolume: options.clickVolume != null ? options.clickVolume : 0.7,
      durationSec: options.durationSec || 0,
      format,
      quality: options.quality || 'balanced',
      resolution: options.resolution || 'original',
      audioSyncMs: options.audioSyncMs || 0,
      videoInputFps: options.videoInputFps || 0,
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

// Cancel a running export by killing the ffmpeg child. The renderer's export
// promise rejects with a { cancelled:true } error (see run() in ffmpeg-export),
// and the temp zoomed file is cleaned up by export:run's finally.
ipcMain.handle('export:cancel', async () => {
  killAllFfmpeg();
  return { ok: true };
});

// Render the cleaned mic audio for in-editor preview (cached per profile). A
// Map (not a plain object) so insertion order gives us LRU semantics for free.
const audioPreviewCache = new Map(); // key `${videoPath}|${profile}|echo:${level}` -> file path
// Concurrent calls for the same key (e.g. a settings toggle fired twice quickly)
// await the same in-flight render instead of each spawning their own ffmpeg
// process and racing to fill the cache slot, orphaning the loser's temp file.
const audioPreviewInFlight = new Map(); // key -> Promise<url>
const AUDIO_PREVIEW_CACHE_LIMIT = 12; // cap so a long session can't grow this unboundedly
// The key most recently handed to the renderer. Its file is bound to a live
// <audio> element in the editor, so eviction must never unlink it out from under
// the playing preview — that would silently break "hear before export".
let audioPreviewActiveKey = null;

function evictAudioPreviewCache() {
  while (audioPreviewCache.size > AUDIO_PREVIEW_CACHE_LIMIT) {
    // Oldest-first, but skip the entry the renderer currently has loaded.
    let victim = null;
    for (const key of audioPreviewCache.keys()) {
      if (key !== audioPreviewActiveKey) { victim = key; break; }
    }
    if (victim == null) break; // only the active entry is left above the limit — keep it
    const p = audioPreviewCache.get(victim);
    audioPreviewCache.delete(victim);
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

ipcMain.handle('audio:preview', async (_evt, opts) => {
  // Back-compat: a bare string is the profile; the object form adds echoLevel.
  const profile = typeof opts === 'string' ? opts : (opts && opts.profile) || 'off';
  const echoLevel = (typeof opts === 'object' && opts && opts.echoLevel) || 'off';
  // Nothing to render when neither cleanup is active.
  if (!currentProject || !currentProject.hasAudio || (profile === 'off' && echoLevel === 'off')) return null;
  const key = `${currentProject.videoPath}|${profile}|echo:${echoLevel}`;

  const cached = audioPreviewCache.get(key);
  if (cached && fs.existsSync(cached)) {
    audioPreviewCache.delete(key); // refresh LRU position
    audioPreviewCache.set(key, cached);
    audioPreviewActiveKey = key; // now bound to the renderer's <audio>
    return pathToFileUrl(cached);
  }

  if (audioPreviewInFlight.has(key)) return audioPreviewInFlight.get(key);

  const render = (async () => {
    const out = path.join(os.tmpdir(), `ssr-clean-${profile}-echo${echoLevel}-${Date.now()}.m4a`);
    await exportCleanAudio({ inputPath: currentProject.videoPath, noiseProfile: profile, echoLevel, outputPath: out });
    audioPreviewCache.set(key, out);
    evictAudioPreviewCache();
    return pathToFileUrl(out);
  })();
  audioPreviewInFlight.set(key, render);
  try {
    const url = await render;
    audioPreviewActiveKey = key; // now bound to the renderer's <audio>
    return url;
  } finally {
    audioPreviewInFlight.delete(key);
  }
});

ipcMain.handle('file:reveal', async (_evt, p) => {
  // Unlike recordings:open, legitimate callers here also reveal an arbitrary
  // export destination the user just picked via a native save dialog, so this
  // can't be confined to one directory — just check it's a real, absolute path
  // rather than passing arbitrary renderer-supplied input straight through.
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) return { ok: false };
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
  // Auto-grant only the specific media permissions our own renderer pages need,
  // and only when the request actually comes from one of our own pages — not a
  // blanket grant to anything asking (defense-in-depth; all content is local
  // today, but this stops a future change from silently widening the grant).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const allowedPermission = permission === 'media' || permission === 'audioCapture' || permission === 'display-capture';
    const fromOwnRenderer = !!(details && details.requestingUrl && details.requestingUrl.startsWith(RENDERER_ORIGIN));
    callback(allowedPermission && fromOwnRenderer);
  });

  requestMacMediaAccess();
  createWindow();
  // Deferred + async so cleanup never delays the window appearing.
  cleanupStaleFiles().catch(() => {});

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
  killAllFfmpeg(); // don't leave an export encoder orphaned after the app exits
  if (settingsWriteTimer) { clearTimeout(settingsWriteTimer); flushSettings(); }
});

app.on('window-all-closed', () => {
  stopCursorTracking();
  if (process.platform !== 'darwin') app.quit();
});
