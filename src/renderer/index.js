'use strict';

const sourceSelect = document.getElementById('sourceSelect');
const previewStage = document.getElementById('previewStage');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const screenPreviewVideo = document.getElementById('screenPreviewVideo');
const micSelect = document.getElementById('micSelect');
const micEnabled = document.getElementById('micEnabled');
const camSelect = document.getElementById('camSelect');
const camEnabled = document.getElementById('camEnabled');
const fpsSelect = document.getElementById('fpsSelect');
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const recBanner = document.getElementById('recBanner');
const timerEl = document.getElementById('timer');
const topStatus = document.getElementById('topStatus');
const permBanner = document.getElementById('permBanner');
const openScreenSettingsBtn = document.getElementById('openScreenSettingsBtn');

const camPreviewBox = document.getElementById('camPreviewBox');
const camPreview = document.getElementById('camPreview');
const blurEnabled = document.getElementById('blurEnabled');
const blurAmount = document.getElementById('blurAmount');
const blurAmountVal = document.getElementById('blurAmountVal');
const blurAmountWrap = document.getElementById('blurAmountWrap');
const camStatus = document.getElementById('camStatus');

let selectedSource = null;
let mediaRecorder = null;
let camRecorder = null;
let camStopped = Promise.resolve();
let pendingWrites = []; // in-flight chunk IPC writes
let writeQueue = Promise.resolve(); // serializes chunk writes to preserve order

// Queue a recorder chunk so chunks are written in capture order (Blob.arrayBuffer
// can otherwise resolve out of order and corrupt the file).
function queueChunk(blob, sender) {
  const p = writeQueue.then(async () => {
    const buf = await blob.arrayBuffer();
    await sender(buf);
  });
  writeQueue = p.catch(() => {});
  pendingWrites.push(p);
}
let recState = null; // { display, recBaseEpoch, hasAudio, hasCam }
let timerInt = null;
let streams = [];
let isRecording = false;
let sources = []; // current list for the active tab
let previewStream = null; // live screen-preview capture

// Live webcam preview + background-blur pipeline.
const camProcessor = new CameraProcessor(camPreview);
let camPreviewOn = false;

// ---------------------------------------------------------------------------
// Populate sources + mics
// ---------------------------------------------------------------------------
let currentKind = 'screen';

const SOURCE_HINTS = {
  screen:
    '🖥️ <b>Screen</b> — records an entire monitor (wallpaper, taskbar, every app). ' +
    'Best choice: the smooth <b>cursor-follow zoom</b> and click effects only work with full-screen recordings.',
  window:
    '🪟 <b>Window</b> — records just one app window; everything else is excluded even if it overlaps. ' +
    'Note: cursor-follow zoom and click effects are off here (zooms stay centered), since the cursor can’t be mapped inside a movable window.<br>' +
    '💡 Picking a browser records the whole window (the tab in front). To capture <b>one tab only</b>, drag it out into its own window first, then hit ↻ Refresh.',
};

// Show/hide the persistent "Screen Recording is off" banner. Returns true when
// access is denied so callers can also block the action. No-op on Windows/Linux
// (status is always 'granted' there).
async function refreshScreenPermission() {
  const status = await window.api.screenStatus();
  const denied = status === 'denied' || status === 'restricted';
  permBanner.classList.toggle('active', denied);
  return denied;
}

if (openScreenSettingsBtn) {
  openScreenSettingsBtn.addEventListener('click', () => window.api.openScreenSettings());
}

async function loadSources() {
  const hintEl = document.getElementById('sourceHint');
  if (hintEl) hintEl.innerHTML = SOURCE_HINTS[currentKind] || '';

  const prevId = selectedSource && selectedSource.id;
  // On macOS, getSources() throws "Failed to get sources" when Screen Recording
  // is denied (and returns black thumbnails we filter out when not-determined),
  // so an error or empty result both mean "no usable sources".
  try {
    sources = await window.api.listSources({ types: [currentKind] });
  } catch (err) {
    console.warn('listSources failed:', err.message);
    sources = [];
  }
  sourceSelect.innerHTML = '';

  if (!sources.length) {
    // On macOS an empty Screens list almost always means Screen Recording is
    // denied (the OS hands back black thumbnails, which we filter out above).
    const denied = currentKind === 'screen' && (await refreshScreenPermission());
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = denied
      ? 'Screen Recording permission needed — see banner above'
      : `No ${currentKind === 'screen' ? 'screens' : 'open windows'} found — try ↻ Refresh`;
    sourceSelect.appendChild(opt);
    selectedSource = null;
    recordBtn.disabled = true;
    stopScreenPreview();
    if (denied) {
      previewPlaceholder.textContent =
        'Screen Recording is turned off for this app. Enable it in System Settings, then quit and reopen.';
      previewPlaceholder.style.display = 'block';
    }
    return;
  }

  sources.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sourceSelect.appendChild(opt);
  });

  const chosen = sources.find((s) => s.id === prevId) || sources[0];
  sourceSelect.value = chosen.id;
  selectSource(chosen.id);
}

function selectSource(id) {
  selectedSource = sources.find((s) => s.id === id) || null;
  recordBtn.disabled = !selectedSource;
  if (selectedSource) startScreenPreview(selectedSource);
  else stopScreenPreview();
}

sourceSelect.addEventListener('change', () => selectSource(sourceSelect.value));

// ---------------------------------------------------------------------------
// Live "what will be recorded" preview
// ---------------------------------------------------------------------------
let previewToken = 0;
async function startScreenPreview(source) {
  const myToken = ++previewToken;
  await stopScreenPreview();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxFrameRate: 15, // low fps — it's just a preview
        },
      },
    });
    if (myToken !== previewToken) { stream.getTracks().forEach((t) => t.stop()); return; }
    previewStream = stream;
    screenPreviewVideo.srcObject = previewStream;
    screenPreviewVideo.style.display = 'block';
    previewPlaceholder.style.display = 'none';
  } catch (err) {
    console.warn('Screen preview failed:', err.message);
    screenPreviewVideo.style.display = 'none';
    previewPlaceholder.textContent = 'Preview unavailable: ' + err.message;
    previewPlaceholder.style.display = 'block';
  }
}

async function stopScreenPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
  screenPreviewVideo.srcObject = null;
  screenPreviewVideo.style.display = 'none';
  previewPlaceholder.style.display = 'block';
}

function setTabSelected(kind) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('selected', t.dataset.kind === kind));
}

// Source-type tabs + refresh
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    setTabSelected(tab.dataset.kind);
    currentKind = tab.dataset.kind;
    Prefs.set('sourceKind', currentKind);
    loadSources();
  });
});
document.getElementById('refreshSources').addEventListener('click', () => loadSources());

async function loadDevices() {
  try {
    // Need a permission grab first so device labels are populated.
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (_) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch (__) {}
  }
  const devices = await navigator.mediaDevices.enumerateDevices();

  const mics = devices.filter((d) => d.kind === 'audioinput');
  micSelect.innerHTML = '';
  mics.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = m.deviceId;
    opt.textContent = m.label || `Microphone ${i + 1}`;
    micSelect.appendChild(opt);
  });
  if (!mics.length) {
    micEnabled.checked = false;
    micEnabled.disabled = true;
  }

  const cams = devices.filter((d) => d.kind === 'videoinput');
  camSelect.innerHTML = '';
  cams.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = c.deviceId;
    opt.textContent = c.label || `Camera ${i + 1}`;
    camSelect.appendChild(opt);
  });
  if (!cams.length) {
    camEnabled.checked = false;
    camEnabled.disabled = true;
    camSelect.disabled = true;
  }
}

// ---------------------------------------------------------------------------
// Camera preview + blur
// ---------------------------------------------------------------------------
async function startCamPreview() {
  if (camEnabled.disabled) return;
  camPreviewBox.style.display = 'flex';
  camPreview.style.display = 'block'; // overlay on the preview stage
  camStatus.textContent = 'Starting camera…';
  try {
    await camProcessor.start(camSelect.value);
    camPreviewOn = true;
    camStatus.textContent = '';
    if (!camProcessor.blurAvailable) {
      blurEnabled.disabled = true;
      blurEnabled.checked = false;
      blurEnabled.parentElement.title = 'Background blur unavailable on this system';
      camStatus.textContent = 'Blur unavailable';
    }
  } catch (err) {
    camStatus.textContent = 'Camera error: ' + err.message;
    console.warn('Camera preview failed:', err);
  }
}

async function stopCamPreview() {
  camPreviewOn = false;
  await camProcessor.stop();
  camPreviewBox.style.display = 'none';
  camPreview.style.display = 'none';
}

camEnabled.addEventListener('change', () => {
  if (camEnabled.checked) startCamPreview();
  else stopCamPreview();
});

camSelect.addEventListener('change', () => {
  if (camPreviewOn) startCamPreview();
});

blurEnabled.addEventListener('change', () => {
  camProcessor.setBlur(blurEnabled.checked);
  blurAmountWrap.style.display = blurEnabled.checked ? 'flex' : 'none';
});

blurAmount.addEventListener('input', () => {
  blurAmountVal.textContent = blurAmount.value;
  camProcessor.setBlurAmount(parseInt(blurAmount.value, 10));
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
function resetRecordingUI() {
  isRecording = false;
  recBanner.classList.remove('active');
  recordBtn.textContent = '● Start Recording';
  recordBtn.disabled = !selectedSource;
  stopBtn.disabled = false;
  stopTimer();
}

async function startRecording() {
  if (!selectedSource || isRecording) return;
  recordBtn.disabled = true;

  // macOS gates screen capture: bail with a helpful dialog instead of silently
  // recording a black screen. (No-op / always ok on Windows.)
  const perm = await window.api.ensureScreenPermission();
  if (!perm.ok) {
    topStatus.textContent = 'Enable Screen Recording in System Settings, then quit and reopen the app.';
    recordBtn.disabled = !selectedSource;
    return;
  }

  const display = selectedSource.display;
  const kind = selectedSource.kind || 'screen';
  const fps = parseInt(fpsSelect.value, 10);
  const useMic = micEnabled.checked && !micEnabled.disabled;

  let recBaseEpoch;
  try {
    // Tell main to begin cursor tracking; it returns the time base.
    ({ recBaseEpoch } = await window.api.startRecording({ display, kind }));

    // Stop the live preview so we don't capture the screen twice at once
    // (that can drop frames in the actual recording).
    await stopScreenPreview();
    previewPlaceholder.textContent = '● Recording in progress…';

    // Capture the screen via the desktop source id.
    const videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedSource.id,
          minFrameRate: fps,
          maxFrameRate: fps,
        },
      },
    });
    streams.push(videoStream);

    const tracks = [...videoStream.getVideoTracks()];

    let hasAudio = false;
    if (useMic) {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micSelect.value ? { exact: micSelect.value } : undefined,
            // Real-time WebRTC noise suppression at capture; the ffmpeg RNNoise
            // pass on export removes whatever remains.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
        streams.push(audioStream);
        tracks.push(...audioStream.getAudioTracks());
        hasAudio = true;
      } catch (err) {
        console.warn('Mic capture failed:', err.message);
      }
    }

    // Optional webcam — captured from the live (optionally blurred) preview
    // canvas and streamed to its own file, composited in the editor.
    let hasCam = false;
    const useCam = camEnabled.checked && !camEnabled.disabled;
    pendingWrites = [];
    writeQueue = Promise.resolve();
    if (useCam) {
      try {
        if (!camPreviewOn) await startCamPreview();
        const camStream = camProcessor.getStream(30);
        streams.push(camStream);
        const camMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9'
          : 'video/webm;codecs=vp8';
        camRecorder = new MediaRecorder(camStream, { mimeType: camMime, videoBitsPerSecond: 6_000_000 });
        camRecorder.ondataavailable = (e) => {
          if (e.data.size) queueChunk(e.data, window.api.sendCamChunk);
        };
        hasCam = true;
      } catch (err) {
        console.warn('Webcam capture failed:', err.message);
      }
    }

    const combined = new MediaStream(tracks);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    mediaRecorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) queueChunk(e.data, window.api.sendVideoChunk);
    };
    mediaRecorder.onstop = onRecordingStopped;

    // Start cam first, then screen, as close together as possible.
    camStopped = camRecorder ? new Promise((res) => { camRecorder.onstop = res; }) : Promise.resolve();
    if (camRecorder) camRecorder.start(250);
    mediaRecorder.start(250);

    recState = { display, recBaseEpoch, hasAudio, hasCam };
    isRecording = true;

    recBanner.classList.add('active');
    recordBtn.textContent = '● Recording…';
    startTimer(recBaseEpoch);
  } catch (err) {
    // Capture failed or was cancelled — clean up so nothing is left running.
    console.error('Failed to start recording:', err);
    try { await window.api.abortRecording(); } catch (_) {}
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = [];
    mediaRecorder = null;
    camRecorder = null;
    topStatus.textContent = 'Could not start recording: ' + (err.message || err);
    resetRecordingUI();
    if (selectedSource) startScreenPreview(selectedSource); // bring the preview back
  }
}

async function onRecordingStopped() {
  stopTimer();
  topStatus.textContent = 'Saving recording…';
  try {
    if (recState.hasCam) await camStopped; // wait for the webcam recorder to flush
    await Promise.all(pendingWrites); // ensure every chunk reached disk
    pendingWrites = [];

    await window.api.finishRecording({ hasAudio: recState.hasAudio });

    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = [];

    topStatus.textContent = 'Opening editor…';
    await window.api.openEditor();
  } catch (err) {
    console.error('Failed to save recording:', err);
    try { await window.api.abortRecording(); } catch (_) {}
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = [];
    topStatus.textContent = 'Could not save recording: ' + (err.message || err);
    resetRecordingUI();
    if (selectedSource) startScreenPreview(selectedSource);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    isRecording = false;
    stopBtn.disabled = true;
    if (camRecorder && camRecorder.state !== 'inactive') camRecorder.stop();
    mediaRecorder.stop();
  }
}

// Toggle used by the global keyboard shortcut.
function toggleRecord() {
  if (isRecording) {
    stopRecording();
    return;
  }
  // Auto-pick the first source if none chosen yet, so the hotkey works.
  if (!selectedSource && sources.length) selectSource(sources[0].id);
  if (selectedSource) startRecording();
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
function startTimer(base) {
  timerInt = setInterval(() => {
    const sec = Math.floor((Date.now() - base) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 250);
}
function stopTimer() {
  if (timerInt) clearInterval(timerInt);
  timerInt = null;
}

// ---------------------------------------------------------------------------
recordBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// Global start/stop hotkey (fires even when the app isn't focused).
if (window.api.onToggleRecord) {
  window.api.onToggleRecord(() => toggleRecord());
}
if (window.api.getShortcut) {
  window.api.getShortcut().then((label) => {
    const hint = document.getElementById('hotkeyHint');
    if (hint && label) hint.textContent = label.replace('CommandOrControl', 'Ctrl');
  });
}

// ---------------------------------------------------------------------------
// Library of past recordings
// ---------------------------------------------------------------------------
async function loadLibrary() {
  const librarySection = document.getElementById('librarySection');
  const library = document.getElementById('library');
  let items = [];
  try {
    items = await window.api.listRecordings();
  } catch (_) {}

  if (!items.length) {
    librarySection.style.display = 'none';
    return;
  }
  librarySection.style.display = 'block';
  library.innerHTML = '';

  items.forEach((it) => {
    const when = new Date(it.mtime).toLocaleString();
    const el = document.createElement('div');
    el.className = 'rec-item';
    el.innerHTML = `
      <div class="rec-info">
        <div class="rec-name">${it.name}</div>
        <div class="rec-meta">${when} · ${it.sizeMB} MB</div>
      </div>
      ${it.hasCam ? '<span class="badge">webcam</span>' : ''}
      <button class="btn-ghost reveal">Show file</button>
      <button class="btn-primary edit">Edit</button>`;
    el.querySelector('.edit').addEventListener('click', async () => {
      topStatus.textContent = 'Opening editor…';
      await window.api.openRecording(it.videoPath);
    });
    el.querySelector('.reveal').addEventListener('click', () => window.api.revealFile(it.videoPath));
    library.appendChild(el);
  });
}

// Apply saved preferences to the home-screen controls and persist on change.
function applyHomePrefs() {
  fpsSelect.value = String(Prefs.get('fps', fpsSelect.value));
  if (!micEnabled.disabled) micEnabled.checked = Prefs.get('micEnabled', true);

  const md = Prefs.get('micDevice');
  if (md && [...micSelect.options].some((o) => o.value === md)) micSelect.value = md;
  const cd = Prefs.get('camDevice');
  if (cd && [...camSelect.options].some((o) => o.value === cd)) camSelect.value = cd;

  blurAmount.value = Prefs.get('blurAmount', 12);
  blurAmountVal.textContent = blurAmount.value;
  camProcessor.setBlurAmount(parseInt(blurAmount.value, 10));

  blurEnabled.checked = Prefs.get('blur', false);
  camProcessor.setBlur(blurEnabled.checked);
  blurAmountWrap.style.display = blurEnabled.checked ? 'flex' : 'none';

  if (!camEnabled.disabled) camEnabled.checked = Prefs.get('camEnabled', false);
  if (camEnabled.checked) startCamPreview();

  // Persist on change (these add to existing handlers).
  fpsSelect.addEventListener('change', () => Prefs.set('fps', fpsSelect.value));
  micEnabled.addEventListener('change', () => Prefs.set('micEnabled', micEnabled.checked));
  micSelect.addEventListener('change', () => Prefs.set('micDevice', micSelect.value));
  camEnabled.addEventListener('change', () => Prefs.set('camEnabled', camEnabled.checked));
  camSelect.addEventListener('change', () => Prefs.set('camDevice', camSelect.value));
  blurEnabled.addEventListener('change', () => Prefs.set('blur', blurEnabled.checked));
  blurAmount.addEventListener('input', () => Prefs.set('blurAmount', parseInt(blurAmount.value, 10)));
}

(async function init() {
  await Prefs.load();
  currentKind = Prefs.get('sourceKind', 'screen');
  setTabSelected(currentKind);

  // Surface a missing Screen Recording grant as soon as the app opens: show the
  // persistent banner and, if denied, pop the native "Open System Settings"
  // dialog once. (No-op on Windows/Linux.)
  if (await refreshScreenPermission()) {
    window.api.ensureScreenPermission();
  }

  await loadSources();
  await loadDevices();
  await camProcessor.init(); // preload the blur model (no-op if unavailable)
  applyHomePrefs();
  await loadLibrary();
})();
