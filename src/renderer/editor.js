'use strict';

// `video` points at the ACTIVE source's <video> element. The timeline can mix
// several source files; only one plays/draws at a time, and `setActiveEl` swaps
// this reference as playback crosses from one source to another.
let video = document.getElementById('srcVideo');
const camVideo = document.getElementById('camVideo');
const canvas = document.getElementById('preview');
// willReadFrequently forces a CPU-backed canvas. This both speeds up the pixel
// work and avoids a Chromium bug where MediaRecorder capturing a GPU-backed
// canvas emits empty (green) frames in the exported video.
const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

const playBtn = document.getElementById('playBtn');
const timeLabel = document.getElementById('timeLabel');
const timeline = document.getElementById('timeline');
const playhead = document.getElementById('playhead');

const autoZoomBtn = document.getElementById('autoZoomBtn');
const addZoomBtn = document.getElementById('addZoomBtn');
const clearZoomBtn = document.getElementById('clearZoomBtn');
const splitBtn = document.getElementById('splitBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const clipTransition = document.getElementById('clipTransition');
const zoomLevel = document.getElementById('zoomLevel');
const zoomLevelVal = document.getElementById('zoomLevelVal');
const zoomLevelLabel = document.getElementById('zoomLevelLabel');
const smoothRamp = document.getElementById('smoothRamp');
const smoothVal = document.getElementById('smoothVal');
const noiseProfile = document.getElementById('noiseProfile');
const audioStatus = document.getElementById('audioStatus');

const camControls = document.getElementById('camControls');
const camShow = document.getElementById('camShow');
const camPos = document.getElementById('camPos');
const camShape = document.getElementById('camShape');
const camSize = document.getElementById('camSize');
const camSizeVal = document.getElementById('camSizeVal');

const clickFx = document.getElementById('clickFx');
const clickStyle = document.getElementById('clickStyle');
const clickColor = document.getElementById('clickColor');
const clickSize = document.getElementById('clickSize');
const clickSizeVal = document.getElementById('clickSizeVal');
const clickSound = document.getElementById('clickSound');
const clickSoundName = document.getElementById('clickSoundName');
const clickVol = document.getElementById('clickVol');
const clickVolVal = document.getElementById('clickVolVal');

const exportFormat = document.getElementById('exportFormat');
const exportQuality = document.getElementById('exportQuality');
const exportResolution = document.getElementById('exportResolution');

const exportBtn = document.getElementById('exportBtn');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const exportStatus = document.getElementById('exportStatus');
const backBtn = document.getElementById('backBtn');
const topStatus = document.getElementById('topStatus');

let project = null;
// The recording source ({ id, cursor, camUrl, hasAudio, ... }) when the editor
// was opened from a recording, else null (studio-direct / import-only session).
// Zoom-tracking, click effects and the webcam overlay only apply to it.
let recording = null;
// All timeline media sources. Each: { id, kind:'recording'|'import', url, el,
// duration, width, height, hasAudio, name }. Clips reference these by `sourceId`.
let sources = [];
let activeSourceId = null;
let sourceSeq = 0;

let engine = null;
// A cursor-free engine for imported clips: same smooth zoom ramps, but pans to
// centre (imports have no cursor data to follow).
let plainEngine = null;
// Zoom blocks. Each carries a `sourceId` and its start/end are in that source's
// own time, so a block stays attached to its footage across reorders. Recording
// blocks pan with the cursor; import blocks zoom to centre.
let blocks = [];
let selectedBlock = null;
let defaultScale = 2.0;
let duration = 0;

// Non-linear timeline. `clips` is an ordered list of source-time ranges that
// play back-to-back in EDIT order — so reordering, splitting and deleting clips
// all just rewrite this array. The video element always holds SOURCE time; the
// timeline/playhead work in "edited time" (cumulative clip lengths).
let clips = [];
let selectedClipId = null;
let clipSeq = 0;            // id generator so selection survives reorders
let clipHistory = [];       // snapshots of `clips` for undo
let clipFuture = [];        // snapshots of `clips` for redo
let playIdx = 0;            // index of the clip currently at the playhead
let playheadEdited = 0;     // playhead position in edited time (seconds)
let drawClipIdx = 0;        // clip index the current frame belongs to

// Clip transitions. Each clip can carry an intro `transition` ({type,duration})
// describing how it enters from the previous clip — so it follows the clip on
// reorder. We render it without a second decoder: when playback leaves a clip we
// snapshot its last frame to an offscreen canvas, then composite that frozen
// "outgoing" frame over the incoming clip's first `duration` seconds.
const DEFAULT_TRANSITION_DUR = 0.5;
const TRANSITION_LABELS = {
  fade: 'تلاشٍ', crossfade: 'تلاشٍ متقاطع', slide: 'انزلاق', wipe: 'مسح', zoom: 'تكبير',
};
const transCanvas = document.createElement('canvas');
const transCtx = transCanvas.getContext('2d', { alpha: false });
let transSnapIdx = -1;      // incoming clip index the snapshot is the outgoing frame for
let rafId = null;
// Playback intent. Drives the render loop independently of any single element's
// paused state — crossing into a new source momentarily pauses the fresh element
// while its async play() resolves, and we must not let that stop the loop.
let playing = false;
// True while a clip-advance seek is in flight. A just-activated element reports a
// STALE currentTime until its seek lands; without this guard the render loop's
// clip-end test could read that stale value and skip the new clip outright.
let mediaSeeking = false;
let exporting = false;
let camReady = false;

// Cleaned-audio preview: plays the ffmpeg-denoised mic in sync with the video so
// the noise setting can be heard before exporting.
const cleanAudio = new Audio();
let cleanAudioActive = false;
let audioPreviewToken = 0;

// Webcam overlay placement as the CENTRE of the overlay, in 0..1 of the frame.
let camFx = 0.85;
let camFy = 0.85;

// Click effects
const CLICK_FX_DUR = 0.45; // seconds
let clickTimes = []; // click times in seconds
let clickAudio = new Audio('../../assets/sfx/mouse.wav');
let lastFxTime = 0;

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 255, g: 205, b: 60 };
}

const DEFAULT_BLOCK_LEN = 2.4;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = String(Math.floor(t / 60)).padStart(2, '0');
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  await Prefs.load();
  project = await window.api.getProject();
  recording = project && project.recording ? project.recording : null;

  applyEditorPrefs();
  setupPanels();

  // Zoom-tracking and the always-present engine are recording-bound; build one
  // even in studio mode (with empty cursor data) so import-only sessions render.
  rebuildEngine();

  const recHasAudio = !!(recording && recording.hasAudio);
  noiseProfile.disabled = !recHasAudio;
  if (!recHasAudio) {
    noiseProfile.value = 'off';
    noiseProfile.title = recording ? 'لم يُسجَّل أي ميكروفون' : 'لا يوجد تسجيل ميكروفون في جلسة الاستوديو';
  }

  if (recording) {
    // The recording reuses the pre-existing #srcVideo element as its source el.
    const recEl = document.getElementById('srcVideo');
    const src = {
      id: recording.id, kind: 'recording', url: recording.videoUrl, el: recEl,
      duration: 0, width: 0, height: 0, hasAudio: recHasAudio, name: 'التسجيل',
    };
    recEl.src = recording.videoUrl;
    recEl.muted = false;
    await new Promise((res) => {
      if (recEl.readyState >= 1) return res();
      recEl.addEventListener('loadedmetadata', res, { once: true });
      recEl.addEventListener('error', res, { once: true });
    });
    activeSourceId = src.id;
    video = recEl;
    src.duration = await resolveDuration();
    src.width = recEl.videoWidth || 1920;
    src.height = recEl.videoHeight || 1080;
    sources.push(src);

    duration = src.duration;
    setCanvasSize(src.width, src.height);

    if (recording.hasCam && recording.camUrl) await setupCam(recording.camUrl);

    clips = [{ id: clipSeq++, sourceId: src.id, start: 0, end: src.duration }];
    clickTimes = (recCursor().clicks || []).map((c) => c.t / 1000);

    await seekTo(0);
    autoZoom();
    drawAt(0);
  } else {
    // Studio-direct: blank timeline. Canvas gets a sensible default until the
    // first import sets the working resolution.
    clips = [];
    clickTimes = [];
    setCanvasSize(1920, 1080);
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  clipHistory = [];
  playIdx = 0;
  playheadEdited = 0;

  buildTimeline();
  updateTimeLabel();
  updateEmptyState();

  // Prepare the cleaned-audio preview in the background for the current profile.
  if (recHasAudio && noiseProfile.value !== 'off') applyAudioPreview(noiseProfile.value);
}

function setCanvasSize(w, h) {
  canvas.width = w || 1920;
  canvas.height = h || 1080;
  transCanvas.width = canvas.width;
  transCanvas.height = canvas.height;
}

// Recording-only helpers: cursor data exists only for the recording source.
function recCursor() { return (recording && recording.cursor) || { clicks: [], samples: [] }; }
function sourceById(id) { return sources.find((s) => s.id === id) || null; }
function activeSource() { return sourceById(activeSourceId); }
function activeIsRecording() { const s = activeSource(); return !!(s && s.kind === 'recording'); }

// Create a hidden <video> for an imported source and wait for its metadata.
function createSourceEl(url) {
  return new Promise((resolve) => {
    const el = document.createElement('video');
    el.src = url;
    el.muted = true;            // imports are silent in preview until they play
    el.playsInline = true;
    el.preload = 'auto';
    el.style.display = 'none';
    document.body.appendChild(el);
    const done = () => resolve(el);
    if (el.readyState >= 1) return done();
    el.addEventListener('loadedmetadata', done, { once: true });
    el.addEventListener('error', done, { once: true });
  });
}

// Resolve an imported element's duration (webm/mkv often report Infinity until
// seeked to the end first, same trick as resolveDuration for the recording).
function resolveElDuration(el) {
  return new Promise((resolve) => {
    if (isFinite(el.duration) && el.duration > 0) return resolve(el.duration);
    const onTime = () => {
      if (isFinite(el.duration)) {
        el.removeEventListener('durationchange', onTime);
        el.currentTime = 0;
        resolve(el.duration);
      }
    };
    el.addEventListener('durationchange', onTime);
    el.currentTime = 1e6;
    setTimeout(() => resolve(isFinite(el.duration) ? el.duration : 0), 2000);
  });
}

// Pick videos via the main process, append one clip per file to the timeline.
async function importVideos() {
  if (exporting) return;
  topStatus.textContent = 'جارٍ الاستيراد…';
  let list = [];
  try {
    list = await window.api.importVideos();
  } catch (err) {
    topStatus.textContent = 'تعذّر الاستيراد: ' + err.message;
    return;
  }
  if (!list.length) { topStatus.textContent = ''; return; }

  const firstSource = sources.length === 0; // first source ever -> sets canvas size
  const wasEmpty = clips.length === 0;       // empty timeline -> park preview on import
  pushHistory();
  let added = 0;
  for (const item of list) {
    const el = await createSourceEl(item.url);
    if (!el.videoWidth) continue; // unreadable file
    const dur = await resolveElDuration(el);
    if (!dur) continue;
    const src = {
      id: item.id, kind: 'import', url: item.url, el,
      duration: dur, width: el.videoWidth, height: el.videoHeight,
      hasAudio: !!item.hasAudio, name: item.name,
    };
    sources.push(src);
    clips.push({ id: clipSeq++, sourceId: src.id, start: 0, end: dur });
    added++;
  }

  // The first imported file (in a studio session) defines the working canvas.
  if (firstSource && !recording && sources.length) {
    setCanvasSize(sources[0].width, sources[0].height);
  }

  topStatus.textContent = added ? `أُضيف ${added} مقطع` : 'لم يُضَف أي مقطع';
  updateUndoBtn();
  updateEmptyState();
  buildTimeline();
  if (wasEmpty && clips.length) seekEdited(0);
}

// Make `id`'s element the active one: pause the others, route audio, swap the
// global `video` reference the render/seek code reads.
function setActiveEl(id) {
  if (id === activeSourceId) return;
  const s = sourceById(id);
  if (!s) return;
  try { if (video) { video.pause(); video.muted = true; } } catch (_) {}
  activeSourceId = id;
  video = s.el;
  // Recording plays through the cleaned-audio track (or its own); imports play
  // their own audio directly.
  video.muted = s.kind === 'recording' ? cleanAudioActive : false;
}

// Draw an imported frame letterboxed ("contain") into the working canvas so a
// source with a different aspect ratio isn't stretched. `scale` (>=1) zooms into
// the centre of the frame, drawn within the same letterbox rectangle.
function drawImportFrame(el, scale = 1) {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const vw = el.videoWidth, vh = el.videoHeight;
  if (!vw || !vh) return;
  const fit = Math.min(W / vw, H / vh);
  const dw = vw * fit, dh = vh * fit;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;
  const cropW = vw / scale, cropH = vh / scale;
  const sx = (vw - cropW) / 2, sy = (vh - cropH) / 2;
  ctx.drawImage(el, sx, sy, cropW, cropH, dx, dy, dw, dh);
}

// Toggle the "import to begin" overlay + export availability for an empty studio.
function updateEmptyState() {
  const empty = clips.length === 0;
  const stage = document.querySelector('.editor-stage');
  let ph = document.getElementById('stagePlaceholder');
  if (empty) {
    if (!ph && stage) {
      ph = document.createElement('div');
      ph.id = 'stagePlaceholder';
      ph.className = 'stage-placeholder';
      ph.innerHTML = '<div class="sp-emoji">🎬</div><p>أضِف فيديو لبدء التحرير</p><button class="btn-primary" id="emptyImportBtn">＋ إضافة فيديو</button>';
      stage.appendChild(ph);
      ph.querySelector('#emptyImportBtn').addEventListener('click', importVideos);
    }
  } else if (ph) {
    ph.remove();
  }
  exportBtn.disabled = empty || exporting;
  playBtn.disabled = empty;
  splitBtn.disabled = empty;
}

// Inspector sections collapse on header click; the open/closed state persists.
function setupPanels() {
  document.querySelectorAll('.editor-controls[data-panel] > .panel-title').forEach((btn) => {
    const panel = btn.closest('.editor-controls');
    const key = `panel.${panel.dataset.panel}`;
    if (Prefs.get(key, false)) panel.classList.add('collapsed');
    btn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      Prefs.set(key, collapsed);
    });
  });
}

// Apply saved preferences to the editor controls, then persist on change.
function applyEditorPrefs() {
  if (!noiseProfile.disabled) noiseProfile.value = Prefs.get('noiseProfile', noiseProfile.value);

  zoomLevel.value = Prefs.get('zoom', 2.0);
  defaultScale = parseFloat(zoomLevel.value);
  zoomLevelVal.textContent = `${defaultScale.toFixed(1)}×`;

  smoothRamp.value = Prefs.get('smooth', 0.55);
  smoothVal.textContent = `${parseFloat(smoothRamp.value).toFixed(2)}ث`;

  // Click highlight
  clickFx.checked = Prefs.get('clickFx', true);
  clickStyle.value = Prefs.get('clickStyle', 'ring');
  clickColor.value = Prefs.get('clickColor', '#ffcd3c');
  clickSize.value = Prefs.get('clickSize', 5);
  clickSizeVal.textContent = `${clickSize.value}%`;

  // Click sound
  clickSound.checked = Prefs.get('clickSound', false);
  const savedSound = Prefs.get('clickSoundName', 'mouse');
  clickSoundName.value = ['mouse', 'mouse_soft'].includes(savedSound) ? savedSound : 'mouse';
  clickAudio = new Audio(`../../assets/sfx/${clickSoundName.value}.wav`);
  clickVol.value = Prefs.get('clickVol', 70);
  clickVolVal.textContent = `${clickVol.value}%`;

  // Webcam overlay
  camShow.checked = Prefs.get('camShow', true);
  camPos.value = Prefs.get('camPos', 'br');
  const p = CAM_PRESETS[camPos.value] || CAM_PRESETS.br;
  camFx = p[0];
  camFy = p[1];
  camShape.value = Prefs.get('camShape', 'circle');
  camSize.value = Prefs.get('camSize', 24);
  camSizeVal.textContent = `${camSize.value}%`;

  // Export
  exportFormat.value = Prefs.get('exportFormat', 'youtube');
  exportQuality.value = Prefs.get('exportQuality', 'balanced');
  exportResolution.value = Prefs.get('exportResolution', 'original');

  // Persist on change.
  noiseProfile.addEventListener('change', () => {
    Prefs.set('noiseProfile', noiseProfile.value);
    applyAudioPreview(noiseProfile.value);
  });
  smoothRamp.addEventListener('input', () => Prefs.set('smooth', parseFloat(smoothRamp.value)));
  clickFx.addEventListener('change', () => Prefs.set('clickFx', clickFx.checked));
  clickStyle.addEventListener('change', () => Prefs.set('clickStyle', clickStyle.value));
  clickColor.addEventListener('input', () => Prefs.set('clickColor', clickColor.value));
  clickSize.addEventListener('input', () => Prefs.set('clickSize', parseInt(clickSize.value, 10)));
  clickSound.addEventListener('change', () => Prefs.set('clickSound', clickSound.checked));
  clickSoundName.addEventListener('change', () => Prefs.set('clickSoundName', clickSoundName.value));
  clickVol.addEventListener('input', () => Prefs.set('clickVol', parseInt(clickVol.value, 10)));
  camShow.addEventListener('change', () => Prefs.set('camShow', camShow.checked));
  camPos.addEventListener('change', () => Prefs.set('camPos', camPos.value));
  camShape.addEventListener('change', () => Prefs.set('camShape', camShape.value));
  camSize.addEventListener('input', () => Prefs.set('camSize', parseInt(camSize.value, 10)));
  exportFormat.addEventListener('change', () => Prefs.set('exportFormat', exportFormat.value));
  exportQuality.addEventListener('change', () => Prefs.set('exportQuality', exportQuality.value));
  exportResolution.addEventListener('change', () => Prefs.set('exportResolution', exportResolution.value));
}

async function setupCam(url) {
  camVideo.src = url;
  camVideo.muted = true;
  await new Promise((res) => {
    if (camVideo.readyState >= 1) return res();
    camVideo.addEventListener('loadedmetadata', res, { once: true });
    camVideo.addEventListener('error', res, { once: true });
  });
  if (camVideo.videoWidth) {
    camReady = true;
    camControls.style.display = 'flex';
  }
}

function resolveDuration() {
  return new Promise((resolve) => {
    if (isFinite(video.duration) && video.duration > 0) return resolve(video.duration);
    const onTime = () => {
      if (isFinite(video.duration)) {
        video.removeEventListener('durationchange', onTime);
        video.currentTime = 0;
        resolve(video.duration);
      }
    };
    video.addEventListener('durationchange', onTime);
    video.currentTime = 1e6;
  });
}

function seekTo(t) {
  return new Promise((resolve) => {
    if (camReady) camVideo.currentTime = Math.min(t, camVideo.duration || t);
    if (cleanAudioActive) cleanAudio.currentTime = Math.min(t, cleanAudio.duration || t);
    // If we're already at the target, no 'seeked' event fires — resolve now.
    if (Math.abs(video.currentTime - t) < 0.02) { resolve(); return; }
    let settled = false;
    const done = () => { if (settled) return; settled = true; video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
    setTimeout(done, 1500); // safety fallback
  });
}

function rebuildEngine() {
  const opts = { ramp: parseFloat(smoothRamp.value), smoothing: 0.22 };
  engine = new ZoomEngine(recCursor(), blocks, opts);
  plainEngine = new ZoomEngine({ clicks: [], samples: [] }, [], opts);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function drawAt(t) {
  if (!video || !video.videoWidth) return;
  const srcBlocks = blocks.filter((b) => b.sourceId === activeSourceId);
  if (activeIsRecording()) {
    // Zoom-tracked path: pan/zoom (follows the cursor) + click effects + webcam.
    engine.setBlocks(srcBlocks);
    engine.drawFrame(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height, t);
    drawClickFx(t);
    drawCam();
  } else {
    // Imported footage: letterboxed into the canvas, zoomed to centre per block.
    plainEngine.setBlocks(srcBlocks);
    drawImportFrame(video, plainEngine.getState(t).scale);
  }
  drawTransition(t);
}

// Snapshot the canvas (the outgoing clip's last frame) so it can be composited
// over the incoming clip during its transition. Sets transSnapIdx to the
// incoming clip's index, or -1 when that clip has no transition.
function snapshotOutgoing(incomingIdx) {
  const c = clips[incomingIdx];
  if (!c || incomingIdx === 0 || !c.transition || c.transition.type === 'none') {
    transSnapIdx = -1;
    return;
  }
  transCtx.drawImage(canvas, 0, 0, transCanvas.width, transCanvas.height);
  transSnapIdx = incomingIdx;
}

// Composite the active clip's intro transition (if we're inside its window).
function drawTransition(t) {
  const idx = drawClipIdx;
  if (idx !== transSnapIdx) return;
  const c = clips[idx];
  if (!c || !c.transition || c.transition.type === 'none') return;
  // Never run longer than the incoming clip, so it can't get cut off mid-effect.
  const dur = Math.min(c.transition.duration || DEFAULT_TRANSITION_DUR, clipLen(c) * 0.9);
  const elapsed = t - c.start;
  if (elapsed < 0 || elapsed >= dur) return;
  applyTransition(c.transition.type, elapsed / dur);
}

// `img` (transCanvas) holds the frozen outgoing frame; ctx already holds the
// live incoming frame. We draw the outgoing over it, dissolving per `p` (0..1).
function applyTransition(type, p) {
  const W = canvas.width, H = canvas.height;
  const img = transCanvas;
  const sm = p * p * (3 - 2 * p); // smoothstep for motion-based transitions
  switch (type) {
    case 'crossfade':
      ctx.globalAlpha = 1 - p;
      ctx.drawImage(img, 0, 0, W, H);
      ctx.globalAlpha = 1;
      break;
    case 'fade': // dip through black
      if (p < 0.5) {
        ctx.drawImage(img, 0, 0, W, H);
        ctx.fillStyle = `rgba(0,0,0,${p * 2})`;
        ctx.fillRect(0, 0, W, H);
      } else {
        ctx.fillStyle = `rgba(0,0,0,${(1 - p) * 2})`;
        ctx.fillRect(0, 0, W, H);
      }
      break;
    case 'slide': // outgoing slides off to the left, revealing incoming
      ctx.drawImage(img, -sm * W, 0, W, H);
      break;
    case 'wipe': { // incoming is revealed left -> right
      ctx.save();
      ctx.beginPath();
      ctx.rect(sm * W, 0, W - sm * W, H);
      ctx.clip();
      ctx.drawImage(img, 0, 0, W, H);
      ctx.restore();
      break;
    }
    case 'zoom': { // outgoing scales up and fades away
      const s = 1 + sm * 0.6;
      const dw = W * s, dh = H * s;
      ctx.globalAlpha = 1 - p;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.globalAlpha = 1;
      break;
    }
  }
}

function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }

// Click effect at each recent click, placed in the zoomed view. Style, colour
// and size are user-configurable.
function drawClickFx(t) {
  if (!clickFx.checked || !(recCursor().clicks || []).length) return;
  const { r: cr, g: cg, b: cb } = hexToRgb(clickColor.value);
  const baseR = canvas.height * (parseInt(clickSize.value, 10) / 100);
  const style = clickStyle.value;

  for (const c of recCursor().clicks) {
    const tc = c.t / 1000;
    const age = t - tc;
    if (age < 0) break; // clicks are time-ordered; the rest are in the future
    if (age > CLICK_FX_DUR) continue;
    const p = age / CLICK_FX_DUR;
    const pt = engine.mapPoint(c.x, c.y, video.videoWidth, video.videoHeight, canvas.width, canvas.height, t);
    const R = baseR * pt.scale;

    if (style === 'spotlight') {
      // Dim the whole frame except a bright circle around the click.
      const a = 0.55 * (1 - p);
      const inner = R * 1.6;
      const outer = R * 4;
      const grad = ctx.createRadialGradient(pt.x, pt.y, inner, pt.x, pt.y, outer);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, `rgba(0,0,0,${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      continue;
    }

    const off = pt.x < -R || pt.x > canvas.width + R || pt.y < -R || pt.y > canvas.height + R;
    if (off) continue;

    if (style === 'pulse') {
      const rr = (0.5 + 0.5 * easeOutCubic(p)) * R;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.5 * (1 - p)})`;
      ctx.fill();
      continue;
    }

    // ring (default) and double-ring share the expanding-ring base
    const drawRing = (phase) => {
      const pe = Math.min(1, phase);
      const rr = (0.35 + 0.65 * easeOutCubic(pe)) * R;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, baseR * 0.18 * (1 - pe) * pt.scale);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.85 * (1 - pe)})`;
      ctx.stroke();
    };
    drawRing(p);
    if (style === 'double') drawRing(p - 0.3 < 0 ? 0 : p - 0.3);

    if (p < 0.35) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, R * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.4 * (1 - p / 0.35)})`;
      ctx.fill();
    }
  }
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Compute the webcam overlay rectangle in canvas pixels.
function camRect() {
  const cw = canvas.width;
  const ch = canvas.height;
  const d = (parseInt(camSize.value, 10) / 100) * ch;
  const margin = Math.round(ch * 0.03);
  let x = camFx * cw - d / 2;
  let y = camFy * ch - d / 2;
  x = clamp(x, margin, cw - d - margin);
  y = clamp(y, margin, ch - d - margin);
  return { x, y, d, margin };
}

function drawCam() {
  if (!camReady || !camShow.checked) return;
  const { x, y, d } = camRect();

  const vw = camVideo.videoWidth;
  const vh = camVideo.videoHeight;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  ctx.save();
  if (camShape.value === 'circle') {
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.clip();
  } else {
    roundRectPath(ctx, x, y, d, d, d * 0.14);
    ctx.clip();
  }
  ctx.drawImage(camVideo, sx, sy, side, side, x, y, d, d);
  ctx.restore();

  // subtle border ring + shadow line
  ctx.lineWidth = Math.max(2, d * 0.018);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  if (camShape.value === 'circle') {
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2 - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    roundRectPath(ctx, x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, d - ctx.lineWidth, d - ctx.lineWidth, d * 0.14);
    ctx.stroke();
  }
}

// When cleaned audio is active we mute the raw video track and play the cleaned
// track instead; otherwise the video plays its own (raw) audio.
function updateAudioRouting() {
  if (!video) return;
  // Recording: route through the cleaned-audio track when active (mute the raw
  // video). Imports always play their own audio.
  video.muted = activeIsRecording() ? cleanAudioActive : false;
}

// Render (via ffmpeg) and load the cleaned mic audio for the given profile, then
// route preview playback through it. profile === 'off' restores the raw audio.
async function applyAudioPreview(profile) {
  if (!recording || !recording.hasAudio) return;
  const myToken = ++audioPreviewToken;

  if (profile === 'off') {
    cleanAudioActive = false;
    cleanAudio.pause();
    updateAudioRouting();
    audioStatus.textContent = '';
    return;
  }

  audioStatus.textContent = '· جارٍ التحضير…';
  let url = null;
  try {
    url = await window.api.previewAudio(profile);
  } catch (err) {
    if (myToken !== audioPreviewToken) return;
    cleanAudioActive = false; // fall back to the raw track rather than a stale one
    cleanAudio.pause();
    updateAudioRouting();
    audioStatus.textContent = '· تعذّرت المعاينة (صوت خام)';
    return;
  }
  if (myToken !== audioPreviewToken) return; // a newer request superseded this

  if (!url) { cleanAudioActive = false; updateAudioRouting(); audioStatus.textContent = ''; return; }

  cleanAudio.src = url;
  await new Promise((res) => { cleanAudio.oncanplay = res; cleanAudio.onerror = res; });
  if (myToken !== audioPreviewToken) return;

  cleanAudioActive = true;
  cleanAudio.currentTime = video.currentTime;
  updateAudioRouting();
  if (!video.paused) cleanAudio.play().catch(() => {});
  audioStatus.textContent = '· مُنقّى ✓';
}

// Point the media at clip `idx`'s source + start frame, switching the active
// <video> element when the clip belongs to a different source. The recording's
// webcam and cleaned-audio tracks are only synced when the target is the
// recording — they don't apply to imported footage.
function gotoClipMedia(idx) {
  const c = clips[idx];
  if (!c) return;
  setActiveEl(c.sourceId);
  const isRec = activeIsRecording();
  if (camReady) {
    if (isRec) camVideo.currentTime = Math.min(c.start, camVideo.duration || c.start);
    else camVideo.pause();
  }
  if (cleanAudioActive) {
    if (isRec) cleanAudio.currentTime = c.start;
    else cleanAudio.pause();
  }
  lastFxTime = c.start; // don't fire clicks across the seam
  // If the element isn't already parked at the target, the seek is async and its
  // currentTime stays stale until 'seeked' — guard the render loop until then.
  if (Math.abs(video.currentTime - c.start) < 0.05) {
    mediaSeeking = false;
  } else {
    mediaSeeking = true;
    const el = video;
    const onSeeked = () => { el.removeEventListener('seeked', onSeeked); if (el === video) mediaSeeking = false; };
    el.addEventListener('seeked', onSeeked);
    setTimeout(() => { if (el === video) mediaSeeking = false; }, 1500); // safety
  }
  video.currentTime = c.start;
}

// Advance to the start of the next clip in edit order. Returns false when the
// playhead has run off the end of the timeline.
function advanceToNextClip() {
  if (playIdx >= clips.length - 1) return false;
  playIdx++;
  gotoClipMedia(playIdx);
  return true;
}

const SEAM = 0.03; // advance this many seconds before a clip's source end

function renderLoop() {
  // Bail only on an intentional pause. A single element being momentarily paused
  // (an 'ended' mid-timeline, or a just-activated source) must not stop us.
  if (!playing) return;
  const c = clips[playIdx];
  if (!c) { pause(); return; }
  drawClipIdx = playIdx;

  // A clip-advance seek is still settling: draw the current frame and wait, so a
  // stale currentTime can't be mistaken for reaching this clip's end.
  if (mediaSeeking) {
    drawAt(video.currentTime);
    rafId = requestAnimationFrame(renderLoop);
    return;
  }

  // Reached the end of the current clip -> move to the next in edit order.
  if (video.ended || video.currentTime >= c.end - SEAM) {
    snapshotOutgoing(playIdx + 1); // freeze this frame for the next clip's transition
    const next = clips[playIdx + 1];
    // Only keep rolling without a seek when the next clip continues the SAME
    // source contiguously (a plain split). Across sources we always switch.
    const contiguous = next && next.sourceId === c.sourceId && !video.ended && Math.abs(next.start - c.end) < 0.04;
    if (contiguous) {
      playIdx++;
    } else if (!advanceToNextClip()) {
      pause();
      playIdx = clips.length - 1;
      seekEdited(editedDuration());
      return;
    } else if (video.paused) {
      video.play().catch(() => {}); // resume the (possibly newly-active) element
    }
    rafId = requestAnimationFrame(renderLoop);
    return;
  }

  drawAt(video.currentTime);
  playheadEdited = clamp(editedStartOf(playIdx) + (video.currentTime - c.start), 0, editedDuration());
  movePlayhead(playheadEdited);
  updateTimeLabel();

  // Keep the recording-only aux tracks (webcam, cleaned mic) in step with
  // playback, and idle them while an imported clip is on screen.
  if (activeIsRecording()) {
    playClickSounds(video.currentTime);
    if (camReady && camVideo.paused) camVideo.play().catch(() => {});
    if (cleanAudioActive) {
      if (cleanAudio.paused) cleanAudio.play().catch(() => {});
      if (Math.abs(cleanAudio.currentTime - video.currentTime) > 0.18) cleanAudio.currentTime = video.currentTime;
    }
  } else {
    lastFxTime = video.currentTime; // no recorded clicks belong to imports
    if (camReady && !camVideo.paused) camVideo.pause();
    if (cleanAudioActive && !cleanAudio.paused) cleanAudio.pause();
  }
  rafId = requestAnimationFrame(renderLoop);
}

// Fire the click sound for any click crossed since the last frame (preview).
// Playback jumps around in source time across clips, so test an explicit window
// rather than assuming monotonic time.
function playClickSounds(t) {
  if (clickSound.checked) {
    const vol = parseInt(clickVol.value, 10) / 100;
    for (const tc of clickTimes) {
      if (tc > lastFxTime && tc <= t) {
        const a = clickAudio.cloneNode();
        a.volume = vol;
        a.play().catch(() => {});
      }
    }
  }
  lastFxTime = t;
}

function play() {
  if (!clips.length) return;
  if (playheadEdited >= editedDuration() - 0.05) seekEdited(0); // restart from top
  playing = true;
  lastFxTime = video.currentTime;
  updateAudioRouting();
  video.play().catch(() => {});
  const isRec = activeIsRecording();
  if (isRec && camReady) camVideo.play().catch(() => {});
  if (isRec && cleanAudioActive) { cleanAudio.currentTime = video.currentTime; cleanAudio.play().catch(() => {}); }
  playBtn.textContent = '⏸ إيقاف مؤقت';
  renderLoop();
}
function pause() {
  playing = false;
  if (video) video.pause();
  if (camReady) camVideo.pause();
  cleanAudio.pause();
  playBtn.textContent = '▶ تشغيل';
  if (rafId) cancelAnimationFrame(rafId);
}
playBtn.addEventListener('click', () => {
  if (exporting) return; // the export pass owns playback
  playing ? pause() : play();
});

function updateTimeLabel() {
  timeLabel.textContent = `${fmt(playheadEdited)} / ${fmt(editedDuration())}`;
}

// ---------------------------------------------------------------------------
// Timeline rendering (edited time: positions come from cumulative clip lengths)
// ---------------------------------------------------------------------------
function buildTimeline() {
  [...timeline.querySelectorAll('.block, .click-tick, .clip')].forEach((n) => n.remove());
  transSnapIdx = -1; // any pending transition snapshot is stale after a rebuild
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;

  // Per-source colour so clips from different files read as distinct on the track.
  const sourceColors = {};
  let colorSeq = 0;
  const COLORS = ['', 'src-b', 'src-c', 'src-d', 'src-e', 'src-f'];
  sources.forEach((s) => { sourceColors[s.id] = s.kind === 'recording' ? '' : COLORS[(1 + colorSeq++) % COLORS.length]; });

  // Clip track — the draggable, reorderable base layer.
  clips.forEach((c, ci) => {
    const hasTrans = ci > 0 && c.transition && c.transition.type !== 'none';
    const src = sourceById(c.sourceId);
    const isImport = src && src.kind === 'import';
    const el = document.createElement('div');
    el.className = 'clip' + (c.id === selectedClipId ? ' selected' : '') + (hasTrans ? ' has-trans' : '')
      + (isImport ? ' import' : '') + (sourceColors[c.sourceId] ? ' ' + sourceColors[c.sourceId] : '');
    el.dataset.cidx = ci;
    el.style.left = `${(editedStartOf(ci) / total) * w}px`;
    el.style.width = `${(clipLen(c) / total) * w}px`;
    const transLabel = hasTrans ? (TRANSITION_LABELS[c.transition.type] || c.transition.type) : '';
    const srcName = src ? src.name : '';
    el.title = (isImport ? `${srcName} · ` : '')
      + (hasTrans ? `انتقال ${transLabel} · ` : '')
      + 'اسحب لإعادة الترتيب · ✕ أو Delete للحذف';
    const badge = hasTrans ? `<span class="clip-trans" title="انتقال ${transLabel}">▶</span>` : '';
    el.innerHTML = `${badge}<span class="clip-label">${fmt(clipLen(c))}</span><button class="clip-delete" title="حذف المقطع" tabindex="-1">✕</button>`;
    el.querySelector('.clip-delete').addEventListener('mousedown', (e) => e.stopPropagation());
    el.querySelector('.clip-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteClip(c.id);
    });
    timeline.appendChild(el);
  });

  // Recorded clicks, mapped onto the edited timeline (dropped if cut out). Only
  // the recording's clips carry clicks.
  if (recording) (recCursor().clicks || []).forEach((c) => {
    const te = sourceToEdited(c.t / 1000, recording.id);
    if (te == null) return;
    const tick = document.createElement('div');
    tick.className = 'click-tick';
    tick.style.left = `${(te / total) * w}px`;
    timeline.appendChild(tick);
  });

  // Zoom blocks live in their source's time; draw one rect per clip of that
  // source they overlap so they stay attached to their footage when clips reorder.
  blocks.forEach((b, bi) => {
    clips.forEach((c, ci) => {
      if (c.sourceId !== b.sourceId) return;
      const s = Math.max(b.start, c.start);
      const e = Math.min(b.end, c.end);
      if (e <= s + 1e-3) return;
      const es = editedStartOf(ci) + (s - c.start);
      const ee = editedStartOf(ci) + (e - c.start);
      const el = document.createElement('div');
      el.className = 'block' + (b === selectedBlock ? ' selected' : '');
      el.dataset.block = bi;
      el.dataset.clip = ci;
      el.style.left = `${(es / total) * w}px`;
      el.style.width = `${Math.max(10, ((ee - es) / total) * w)}px`;
      el.title = `تكبير ${b.scale.toFixed(1)}× — اسحب للتحريك، الحواف لتغيير الحجم، نقر مزدوج أو Backspace للحذف`;
      el.innerHTML = `<div class="handle l"></div><span>${b.scale.toFixed(1)}×</span><div class="handle r"></div>`;
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); deleteBlock(b); });
      timeline.appendChild(el);
    });
  });

  updateTransitionControl();
}

function movePlayhead(te) {
  playhead.style.left = `${(te / (editedDuration() || 1)) * timeline.clientWidth}px`;
}

// Redraw once the element's async seek lands, so scrubbing across sources shows
// the correct frame rather than the pre-seek one. No-op while playing (the
// render loop already draws every frame).
function redrawAfterSeek(el, t) {
  const onSeeked = () => {
    el.removeEventListener('seeked', onSeeked);
    if (video === el && video.paused) drawAt(t);
  };
  el.addEventListener('seeked', onSeeked);
}

// Seek by EDITED time: resolve to the source frame inside the active clip,
// switching the active source element when the clip lives in a different file.
function seekEdited(te) {
  if (!clips.length) { playheadEdited = 0; movePlayhead(0); updateTimeLabel(); return; }
  mediaSeeking = false; // a manual scrub supersedes any pending clip-advance seek
  te = clamp(te, 0, Math.max(0, editedDuration() - 0.001));
  const m = editedToSource(te);
  playIdx = m.idx;
  drawClipIdx = m.idx;
  transSnapIdx = -1; // a seek isn't a play-through; never composite a frozen frame
  playheadEdited = te;
  setActiveEl(m.clip.sourceId);
  const isRec = activeIsRecording();
  if (isRec && camReady) camVideo.currentTime = Math.min(m.src, camVideo.duration || m.src);
  if (isRec && cleanAudioActive) cleanAudio.currentTime = Math.min(m.src, cleanAudio.duration || m.src);
  video.currentTime = m.src;
  lastFxTime = m.src;
  drawAt(m.src);
  redrawAfterSeek(video, m.src);
  movePlayhead(te);
  updateTimeLabel();
}

// ---------------------------------------------------------------------------
// Block selection + drag/resize · clip reorder drag
// ---------------------------------------------------------------------------
function selectBlock(b) {
  selectedBlock = b;
  if (b) {
    zoomLevel.value = b.scale;
    zoomLevelVal.textContent = `${b.scale.toFixed(1)}×`;
    zoomLevelLabel.innerHTML = `التكبير المحدد: <b id="zoomLevelVal">${b.scale.toFixed(1)}×</b>`;
  } else {
    zoomLevel.value = defaultScale;
    zoomLevelVal.textContent = `${defaultScale.toFixed(1)}×`;
    zoomLevelLabel.innerHTML = `مستوى تكبير جديد: <b id="zoomLevelVal">${defaultScale.toFixed(1)}×</b>`;
  }
  [...timeline.querySelectorAll('.block')].forEach((el) => {
    el.classList.toggle('selected', blocks[+el.dataset.block] === selectedBlock);
  });
}

let drag = null;       // zoom move/resize
let clipDrag = null;   // clip reorder

timeline.addEventListener('mousedown', (e) => {
  if (exporting) return; // don't seek/drag while the export is capturing
  const blockEl = e.target.closest('.block');
  if (blockEl) {
    const b = blocks[+blockEl.dataset.block];
    const ci = +blockEl.dataset.clip;
    const c = clips[ci];
    selectBlock(b);
    // If this block sits on a clip whose source isn't the one on screen, park the
    // playhead on it so the preview reflects edits live (no-op for active-source
    // blocks, so it doesn't disturb the common case).
    if (c && c.sourceId !== activeSourceId) {
      seekEdited(clamp(editedStartOf(ci) + (b.start - c.start) + 0.001, 0, editedDuration()));
    }
    let mode = 'move';
    if (e.target.classList.contains('l')) mode = 'l';
    else if (e.target.classList.contains('r')) mode = 'r';
    drag = { mode, block: b, clip: c, el: blockEl, startX: e.clientX, origStart: b.start, origEnd: b.end, moved: false };
    e.preventDefault();
    return;
  }

  const clipEl = e.target.closest('.clip');
  const rect = timeline.getBoundingClientRect();
  if (clipEl) {
    const ci = +clipEl.dataset.cidx;
    selectBlock(null);
    selectedClipId = clips[ci].id;
    // Toggle selection in place (don't rebuild — it would invalidate clipEl).
    [...timeline.querySelectorAll('.clip')].forEach((el) => el.classList.toggle('selected', +el.dataset.cidx === ci));
    updateTransitionControl();
    clipDrag = { idx: ci, el: clipEl, startX: e.clientX, moved: false, slot: ci };
    seekEdited(((e.clientX - rect.left) / rect.width) * editedDuration());
    e.preventDefault();
    return;
  }

  // Bare timeline (gaps) -> seek.
  selectBlock(null);
  seekEdited(((e.clientX - rect.left) / rect.width) * editedDuration());
});

window.addEventListener('mousemove', (e) => {
  if (drag) {
    const w = timeline.clientWidth;
    const total = editedDuration() || 1;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 2) drag.moved = true;
    // Within a clip, edited and source time advance 1:1, so a pixel delta maps
    // to the same number of seconds in either space.
    const dt = (dx / w) * total;
    const b = drag.block;
    const c = drag.clip;
    const minLen = 0.3;
    if (drag.mode === 'move') {
      const len = drag.origEnd - drag.origStart;
      const ns = clamp(drag.origStart + dt, c.start, c.end - len);
      b.start = ns;
      b.end = ns + len;
    } else if (drag.mode === 'l') {
      b.start = clamp(drag.origStart + dt, c.start, b.end - minLen);
    } else if (drag.mode === 'r') {
      b.end = clamp(drag.origEnd + dt, b.start + minLen, c.end);
    }
    const ci = clips.indexOf(c);
    const es = editedStartOf(ci) + (b.start - c.start);
    const ee = editedStartOf(ci) + (b.end - c.start);
    drag.el.style.left = `${(es / total) * w}px`;
    drag.el.style.width = `${Math.max(10, ((ee - es) / total) * w)}px`;
    drag.el.querySelector('span').textContent = `${b.scale.toFixed(1)}×`;
    drawAt(video.currentTime);
    return;
  }

  if (clipDrag) {
    const dx = e.clientX - clipDrag.startX;
    if (Math.abs(dx) > 3) clipDrag.moved = true;
    clipDrag.el.style.transform = `translateX(${dx}px)`;
    clipDrag.el.classList.add('dragging');
    const rect = timeline.getBoundingClientRect();
    clipDrag.slot = computeInsertIndex(e.clientX - rect.left);
    showInsertMarker(clipDrag.slot);
  }
});

window.addEventListener('mouseup', () => {
  if (drag) {
    const moved = drag.moved;
    drag = null;
    if (moved) buildTimeline(); // reconcile rects that may now span clips
    return;
  }
  if (clipDrag) {
    const cd = clipDrag;
    clipDrag = null;
    cd.el.style.transform = '';
    cd.el.classList.remove('dragging');
    hideInsertMarker();
    if (cd.moved) moveClip(cd.idx, cd.slot);
    else buildTimeline();
  }
});

// Insertion slot (0..clips.length) nearest pointer x, by clip midpoints.
function computeInsertIndex(x) {
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;
  let acc = 0;
  let slot = 0;
  for (let i = 0; i < clips.length; i++) {
    const len = clipLen(clips[i]);
    const mid = ((acc + len / 2) / total) * w;
    if (x > mid) slot = i + 1;
    acc += len;
  }
  return slot;
}

function ensureInsertEl() {
  let el = timeline.querySelector('.clip-insert');
  if (!el) {
    el = document.createElement('div');
    el.className = 'clip-insert';
    timeline.appendChild(el);
  }
  return el;
}

function showInsertMarker(slot) {
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;
  let acc = 0;
  for (let i = 0; i < slot; i++) acc += clipLen(clips[i]);
  const el = ensureInsertEl();
  el.style.left = `${(acc / total) * w}px`;
  el.style.display = 'block';
}

function hideInsertMarker() {
  const el = timeline.querySelector('.clip-insert');
  if (el) el.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Zoom editing buttons
// ---------------------------------------------------------------------------
function autoZoom() {
  if (!recording) { topStatus.textContent = 'التكبير التلقائي يعتمد على نقرات التسجيل — أضِف تكبيرًا يدويًا بزر «＋ تكبير هنا».'; return; }
  // Replace only the recording's auto blocks; keep any manual import-clip zooms.
  const auto = ZoomEngine.autoBlocks(recCursor(), { scale: defaultScale, duration })
    .map((b) => ({ ...b, sourceId: recording.id }));
  blocks = blocks.filter((b) => b.sourceId !== recording.id).concat(auto);
  selectBlock(null);
  buildTimeline();
  drawAt(video.currentTime);
}

// Add a zoom block on the ACTIVE clip's source at the playhead. Works for both
// recording and imported clips (imports zoom to centre).
function addZoomHere() {
  if (!clips.length) { topStatus.textContent = 'استورد فيديو أو ابدأ تسجيلًا أولًا.'; return; }
  const src = activeSource();
  if (!src) return;
  const t = video.currentTime;
  const maxEnd = src.duration || (t + DEFAULT_BLOCK_LEN);
  const start = Math.max(0, t - 0.2);
  const end = Math.min(maxEnd, start + DEFAULT_BLOCK_LEN);
  const b = { sourceId: src.id, start, end, scale: defaultScale };
  blocks.push(b);
  buildTimeline();
  selectBlock(b);
  drawAt(video.currentTime);
}

function clearZoom() {
  blocks = [];
  selectBlock(null);
  buildTimeline();
  drawAt(video.currentTime);
}

function deleteBlock(b) {
  if (exporting) return;
  const idx = blocks.indexOf(b);
  if (idx < 0) return;
  blocks.splice(idx, 1);
  if (selectedBlock === b) selectBlock(null);
  buildTimeline();
  drawAt(video.currentTime);
}

// ---------------------------------------------------------------------------
// Clip model (non-linear edited timeline)
// ---------------------------------------------------------------------------
function clipLen(c) { return c.end - c.start; }
function editedDuration() { return clips.reduce((a, c) => a + clipLen(c), 0); }

// Edited start (seconds) of the clip at index `idx`.
function editedStartOf(idx) {
  let s = 0;
  for (let i = 0; i < idx; i++) s += clipLen(clips[i]);
  return s;
}

// Has the user changed anything from the original single full-length clip?
function isEdited() {
  return clips.length > 1 || !clips.length ||
    clips[0].start > 0.01 || clips[0].end < duration - 0.05;
}

// edited time -> { idx, clip, src }  (source time inside the active clip)
function editedToSource(te) {
  if (!clips.length) return { idx: 0, clip: { start: 0, end: 0 }, src: 0 };
  te = clamp(te, 0, editedDuration());
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const len = clipLen(clips[i]);
    if (te < acc + len || i === clips.length - 1) {
      return { idx: i, clip: clips[i], src: clips[i].start + (te - acc) };
    }
    acc += len;
  }
  return { idx: 0, clip: clips[0], src: clips[0].start };
}

// source time -> edited time, or null if that moment was cut out. `sourceId`
// restricts the match to clips from one source (recorded clicks/zoom live in the
// recording's source time and must not map onto imported clips).
function sourceToEdited(ts, sourceId) {
  let acc = 0;
  for (const c of clips) {
    if ((sourceId == null || c.sourceId === sourceId) && ts >= c.start && ts < c.end) return acc + (ts - c.start);
    acc += clipLen(c);
  }
  return null;
}

function clipIdxForSource(ts, sourceId) {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if ((sourceId == null || c.sourceId === sourceId) && ts >= c.start && ts < c.end) return i;
  }
  return 0;
}

function selectedClip() { return clips.find((c) => c.id === selectedClipId) || null; }

function selectClip(id) {
  selectedClipId = id;
  buildTimeline();
}

// Snapshot for undo, taken before every mutating edit. A fresh edit
// invalidates the redo stack.
function pushHistory() {
  clipHistory.push(clips.map((c) => ({ ...c })));
  if (clipHistory.length > 100) clipHistory.shift();
  clipFuture = [];
  updateUndoBtn();
}

function updateUndoBtn() {
  undoBtn.disabled = clipHistory.length === 0;
  redoBtn.disabled = clipFuture.length === 0;
}

// Restore the snapshot popped from `from`, pushing the current state onto `to`.
function restoreHistory(from, to) {
  if (exporting || !from.length) return;
  to.push(clips.map((c) => ({ ...c })));
  clips = from.pop();
  if (!clips.some((c) => c.id === selectedClipId)) selectedClipId = null;
  updateUndoBtn();
  updateEmptyState();
  buildTimeline();
  if (clips.length) seekEdited(clamp(playheadEdited, 0, editedDuration()));
  else { playheadEdited = 0; movePlayhead(0); updateTimeLabel(); }
}

function undo() { restoreHistory(clipHistory, clipFuture); }
function redo() { restoreHistory(clipFuture, clipHistory); }

function splitAtPlayhead() {
  if (exporting) return;
  const m = editedToSource(playheadEdited);
  const c = m.clip;
  const t = m.src;
  // Don't split on a boundary or at the very edges of a clip.
  if (t <= c.start + 0.05 || t >= c.end - 0.05) return;
  pushHistory();
  const idx = clips.indexOf(c);
  const right = { id: clipSeq++, sourceId: c.sourceId, start: t, end: c.end };
  c.end = t;
  clips.splice(idx + 1, 0, right);
  selectClip(right.id); // redraws the timeline
}

function deleteClip(id) {
  if (exporting) return;
  const c = clips.find((x) => x.id === id);
  if (!c) return;
  pushHistory();
  clips = clips.filter((x) => x.id !== id);
  if (selectedClipId === id) selectedClipId = null;
  // The leading clip can't carry an intro transition — drop one if it shifted up.
  if (clips[0] && clips[0].transition) delete clips[0].transition;
  updateEmptyState();
  buildTimeline();
  if (clips.length) seekEdited(clamp(playheadEdited, 0, editedDuration()));
  else { playheadEdited = 0; movePlayhead(0); updateTimeLabel(); ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
}

// Move the clip at index `from` so it sits at insertion slot `to` (0..length).
function moveClip(from, to) {
  if (exporting) return;
  if (to > from) to--; // removing `from` first shifts later indices left
  to = clamp(to, 0, clips.length - 1);
  if (to === from) { buildTimeline(); return; }
  pushHistory();
  const [c] = clips.splice(from, 1);
  clips.splice(to, 0, c);
  selectClip(c.id);
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

const importBtn = document.getElementById('importBtn');
importBtn.addEventListener('click', importVideos);
autoZoomBtn.addEventListener('click', autoZoom);
addZoomBtn.addEventListener('click', addZoomHere);
clearZoomBtn.addEventListener('click', clearZoom);
splitBtn.addEventListener('click', splitAtPlayhead);
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// Reflect the selected clip's intro transition in the picker.
function updateTransitionControl() {
  const c = selectedClip();
  if (!c) {
    clipTransition.disabled = true;
    clipTransition.value = 'none';
    clipTransition.title = 'اختر مقطعًا من الخط الزمني أولًا';
    return;
  }
  clipTransition.value = (c.transition && c.transition.type) || 'none';
  const isFirst = clips[0] && clips[0].id === c.id;
  clipTransition.disabled = isFirst;
  clipTransition.title = isFirst
    ? 'المقطع الأول ليس له ما ينتقل منه — حرّكه لاحقًا لإضافة انتقال'
    : 'كيف يدخل هذا المقطع من المقطع السابق';
}

clipTransition.addEventListener('change', () => {
  const c = selectedClip();
  if (!c || exporting) return;
  pushHistory();
  if (clipTransition.value === 'none') delete c.transition;
  else c.transition = { type: clipTransition.value, duration: DEFAULT_TRANSITION_DUR };
  buildTimeline();
});

// Keyboard-shortcuts reference modal (declared before the edit-shortcut handler
// below, which reads `shortcutsModal` to suspend shortcuts while it's open).
const shortcutsModal = document.getElementById('shortcutsModal');
const shortcutsBtn = document.getElementById('shortcutsBtn');
const closeShortcuts = document.getElementById('closeShortcuts');
function toggleShortcuts(open) {
  shortcutsModal.classList.toggle('open', open ?? !shortcutsModal.classList.contains('open'));
}
shortcutsBtn.addEventListener('click', () => toggleShortcuts());
closeShortcuts.addEventListener('click', () => toggleShortcuts(false));
shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) toggleShortcuts(false); });
window.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  if (e.key === 'Escape') toggleShortcuts(false);
  else if ((e.key === '?' || e.key === '؟') && !typing) toggleShortcuts(true);
});

// Keyboard: Space plays/pauses, ←/→ seek; Delete removes the selected zoom or
// clip; 'S' splits at the playhead; Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z
// (or Ctrl/Cmd+Y) redoes the last clip edit.
window.addEventListener('keydown', (e) => {
  if (exporting) return; // ignore edit shortcuts during an export
  if (shortcutsModal.classList.contains('open')) return; // modal owns the keyboard
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;

  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (!clips.length) return;
    playing ? pause() : play();
    return;
  }

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowRight' ? 1 : -1);
    seekEdited(playheadEdited + step);
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    e.shiftKey ? redo() : undo(); // Ctrl/Cmd+Shift+Z redoes
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return;
  }

  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (selectedBlock) {
      e.preventDefault();
      deleteBlock(selectedBlock);
    } else if (selectedClipId != null) {
      e.preventDefault();
      deleteClip(selectedClipId);
    }
    return;
  }

  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    splitAtPlayhead();
  }
});

zoomLevel.addEventListener('input', () => {
  const v = parseFloat(zoomLevel.value);
  const span = document.getElementById('zoomLevelVal');
  if (span) span.textContent = `${v.toFixed(1)}×`;
  if (selectedBlock) {
    selectedBlock.scale = v;
    buildTimeline();
    selectBlock(selectedBlock);
  } else {
    defaultScale = v;
    Prefs.set('zoom', v);
  }
  drawAt(video.currentTime);
});

smoothRamp.addEventListener('input', () => {
  smoothVal.textContent = `${parseFloat(smoothRamp.value).toFixed(2)}ث`;
  rebuildEngine();
  drawAt(video.currentTime);
});

// Camera control changes -> redraw
[camShow, camShape].forEach((el) => el.addEventListener('change', () => drawAt(video.currentTime)));
camSize.addEventListener('input', () => {
  camSizeVal.textContent = `${camSize.value}%`;
  drawAt(video.currentTime);
});

// Position dropdown sets a quick corner preset; the user can then fine-tune by
// dragging the webcam directly on the preview.
const CAM_PRESETS = { br: [0.85, 0.85], bl: [0.15, 0.85], tr: [0.85, 0.15], tl: [0.15, 0.15] };
camPos.addEventListener('change', () => {
  const p = CAM_PRESETS[camPos.value] || CAM_PRESETS.br;
  camFx = p[0];
  camFy = p[1];
  drawAt(video.currentTime);
});

// Drag the webcam overlay anywhere on the video.
let camDrag = null;
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}
canvas.addEventListener('mousedown', (e) => {
  if (!camReady || !camShow.checked) return;
  const p = canvasPoint(e);
  const r = camRect();
  if (p.x >= r.x && p.x <= r.x + r.d && p.y >= r.y && p.y <= r.y + r.d) {
    camDrag = { offX: p.x - (r.x + r.d / 2), offY: p.y - (r.y + r.d / 2) };
    e.preventDefault();
  }
});
window.addEventListener('mousemove', (e) => {
  if (!camDrag) return;
  const p = canvasPoint(e);
  camFx = clamp((p.x - camDrag.offX) / canvas.width, 0, 1);
  camFy = clamp((p.y - camDrag.offY) / canvas.height, 0, 1);
  drawAt(video.currentTime);
});
window.addEventListener('mouseup', () => { camDrag = null; });
canvas.addEventListener('mousemove', (e) => {
  if (!camReady || !camShow.checked) { canvas.style.cursor = 'default'; return; }
  const p = canvasPoint(e);
  const r = camRect();
  const over = p.x >= r.x && p.x <= r.x + r.d && p.y >= r.y && p.y <= r.y + r.d;
  canvas.style.cursor = over ? 'grab' : 'default';
});

[clickFx, clickStyle, clickColor].forEach((el) => el.addEventListener('change', () => drawAt(video.currentTime)));
clickSize.addEventListener('input', () => {
  clickSizeVal.textContent = `${clickSize.value}%`;
  drawAt(video.currentTime);
});
clickVol.addEventListener('input', () => { clickVolVal.textContent = `${clickVol.value}%`; });

// Jump to a click and play a short segment so the effect (and sound) is visible
// in the preview without exporting. Each press advances to the next click.
const testFxBtn = document.getElementById('testFxBtn');
testFxBtn.addEventListener('click', () => {
  if (!recording || !clickTimes.length) {
    topStatus.textContent = 'لا توجد نقرات مُسجَّلة للمعاينة.';
    return;
  }
  // Work in edited time so clicks that were cut out are skipped automatically.
  const live = clickTimes
    .map((t) => sourceToEdited(t, recording.id))
    .filter((te) => te != null)
    .sort((a, b) => a - b);
  if (!live.length) {
    topStatus.textContent = 'كل النقرات المُسجَّلة محذوفة من المونتاج.';
    return;
  }
  topStatus.textContent = '';
  const teClick = live.find((te) => te > playheadEdited + 0.05) ?? live[0];
  const stopTe = Math.min(editedDuration(), teClick + 0.7);

  pause();
  seekEdited(Math.max(0, teClick - 0.4));
  play();
  const watch = () => {
    if (!playing) return;
    if (playheadEdited >= stopTe) {
      pause();
      // Park just after the click so the ripple stays frozen on screen.
      seekEdited(Math.min(editedDuration() - 0.001, teClick + 0.12));
    } else {
      requestAnimationFrame(watch);
    }
  };
  requestAnimationFrame(watch);
});
clickSoundName.addEventListener('change', () => {
  clickAudio = new Audio(`../../assets/sfx/${clickSoundName.value}.wav`);
  // quick audition
  if (clickSound.checked) {
    const a = clickAudio.cloneNode();
    a.volume = parseInt(clickVol.value, 10) / 100;
    a.play().catch(() => {});
  }
});

window.addEventListener('resize', () => {
  if (drag || clipDrag) return; // don't detach the element being dragged
  buildTimeline();
  movePlayhead(playheadEdited);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
async function runExport() {
  if (exporting || !clips.length) return;
  exporting = true;
  pause();
  // Capture from the first clip's source.
  if (clips[0]) { setActiveEl(clips[0].sourceId); }
  exportBtn.disabled = true;
  progress.classList.add('active');

  const totalDur = editedDuration();
  // Single place to drive the bar + the percentage label so the two never drift.
  const setProgress = (pct, label) => {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = pct + '%';
    exportStatus.textContent = label ? `${label} · ${pct}٪` : `${pct}٪`;
  };
  setProgress(0, 'جارٍ التحضير');

  // Two phases share the bar: the canvas render (0–60%) then the ffmpeg encode
  // (60–99%), so the user sees steady movement through the whole export.
  const interBitrate = exportFormat.value === 'master' ? 50_000_000 : 16_000_000;
  const zoomedBuffer = await renderZoomedWebm((p) => {
    setProgress(p * 60, 'جارٍ تجهيز اللقطات');
  }, interBitrate);

  setProgress(60, 'جارٍ الترميز وتنقية الصوت');

  // ffmpeg prints `time=HH:MM:SS.ss` as it encodes; map that against the clip
  // duration to advance the bar from 60% toward 99% during the encode.
  const off = window.api.onExportProgress((line) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m && totalDur > 0) {
      const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      const frac = Math.max(0, Math.min(1, secs / totalDur));
      setProgress(60 + frac * 39, 'جارٍ الترميز والتصدير');
    }
  });

  // Click sounds must land on the edited timeline; drop any that were cut out.
  const editedClicks = recording
    ? clickTimes.map((t) => sourceToEdited(t, recording.id)).filter((t) => t != null)
    : [];

  // Pass the clip list (with source ids) whenever the timeline isn't a single,
  // untrimmed recording clip — that lone case keeps the original fast path.
  const pureUnedited = recording && !isEdited() && clips.length === 1 && clips[0].sourceId === recording.id;
  const clipsPayload = pureUnedited
    ? null
    : clips.map((c) => ({ sourceId: c.sourceId, start: c.start, end: c.end }));

  try {
    const res = await window.api.runExport({
      zoomedBuffer,
      options: {
        noiseProfile: noiseProfile.value,
        clickSound: clickSound.checked,
        clickTimes: clickSound.checked ? editedClicks : [],
        clickSoundName: clickSoundName.value,
        clickVolume: parseInt(clickVol.value, 10) / 100,
        durationSec: editedDuration(),
        clips: clipsPayload,
        format: exportFormat.value,
        quality: exportQuality.value,
        resolution: exportResolution.value,
      },
    });
    off();
    if (res.canceled) {
      exportStatus.textContent = 'أُلغِي التصدير.';
    } else {
      setProgress(100, 'تم');
      exportStatus.textContent = 'تم! حُفظ في ' + res.outputPath;
      await window.api.revealFile(res.outputPath);
    }
  } catch (err) {
    off();
    exportStatus.textContent = 'فشل التصدير: ' + err.message;
    console.error(err);
  } finally {
    progress.classList.remove('active');
    exportBtn.disabled = false;
    exporting = false;
    // The capture pass left the active element on the last clip's source; restore
    // the preview to the playhead so the active element/frame are consistent.
    if (clips.length) seekEdited(clamp(playheadEdited, 0, editedDuration()));
  }
}

function renderZoomedWebm(onProgress, bitrate = 16_000_000) {
  transSnapIdx = -1; // start the capture with no pending transition snapshot
  return new Promise((resolve, reject) => {
    // captureStream(0) = manual mode: we push exactly one frame per drawn frame
    // via requestFrame(), so no empty/duplicated frames sneak into the encoder.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm;codecs=vp8';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    const parts = [];
    let finished = false;
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = async () => {
      updateAudioRouting(); // restore preview audio routing
      resolve(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
    };
    rec.onerror = (e) => { updateAudioRouting(); reject(e.error || new Error('خطأ في المُسجِّل')); };

    const pushFrame = () => { if (track.requestFrame) track.requestFrame(); };

    const FRAME_MS = 1000 / 60; // cap capture to 60fps regardless of monitor Hz
    let lastFrame = -1;

    // Capture the clips in edit order. Between clips we seek the source video to
    // the next clip's start — which can be backwards when clips were reordered.
    const seq = clips;
    const total = editedDuration() || duration;
    const startAt = seq.length ? seq[0].start : 0;
    let segIdx = 0;
    let elapsedBefore = 0;
    let skipping = false;

    let step;
    step = (now) => {
      if (finished) return;
      if (skipping) return; // waiting on a 'seeked'; onSeeked re-arms the loop
      drawClipIdx = segIdx;

      // Reached the end of the current clip.
      if (video.ended || video.currentTime >= seq[segIdx].end - 0.02) {
        snapshotOutgoing(segIdx + 1); // freeze for the next clip's transition
        elapsedBefore += seq[segIdx].end - seq[segIdx].start;
        const prevSourceId = seq[segIdx].sourceId;
        segIdx++;
        if (segIdx >= seq.length) {
          finished = true;
          video.pause();
          if (camReady) camVideo.pause();
          setTimeout(() => rec.stop(), 200);
          return;
        }
        const nextClip = seq[segIdx];
        const target = nextClip.start;
        // Crossing into a different source file: swap the active element.
        const switching = nextClip.sourceId !== prevSourceId;
        if (switching) {
          try { video.pause(); } catch (_) {}
          setActiveEl(nextClip.sourceId);
          video.muted = true; // element audio is never captured; keep it silent
        }
        // Sync the recording-only webcam to the new clip when it's a recording
        // clip; otherwise idle it (it isn't drawn over imported footage).
        if (camReady) {
          if (activeIsRecording()) camVideo.currentTime = Math.min(target, camVideo.duration || target);
          else camVideo.pause();
        }
        // Already at the target frame (a plain split, or a fresh element at 0):
        // keep rolling without a seek — seeking to the same spot fires no event.
        if (!video.ended && Math.abs(video.currentTime - target) < 0.04) {
          if (video.paused) video.play().catch(() => {});
          lastFrame = -1;
          requestAnimationFrame(step);
          return;
        }
        // Otherwise jump to the next clip and wait for the seek to land.
        skipping = true;
        // Freeze the recorder timeline during the seek. MediaRecorder runs on
        // wall-clock, so without this the last frame would be held for the seek
        // latency — bloating the video past the (precisely-cut) audio and
        // leaving a freeze-frame at every cut.
        if (rec.state === 'recording') rec.pause();
        const el = video; // the element we're seeking (may have just switched)
        let settled = false;
        const onSeeked = () => {
          if (settled) return;
          settled = true;
          el.removeEventListener('seeked', onSeeked);
          skipping = false;
          lastFrame = -1;
          // Resume: a fresh/just-switched element is paused, and one seeked away
          // from the true media end paused itself on 'ended'.
          if (el === video && el.paused) el.play().catch(() => {});
          if (rec.state === 'paused') rec.resume();
          requestAnimationFrame(step);
        };
        el.addEventListener('seeked', onSeeked);
        el.currentTime = target;
        setTimeout(onSeeked, 1500); // safety if 'seeked' is missed
        return;
      }

      // Keep the webcam advancing during recording clips, idle during imports.
      if (camReady) {
        if (activeIsRecording()) { if (camVideo.paused) camVideo.play().catch(() => {}); }
        else if (!camVideo.paused) camVideo.pause();
      }

      // Throttle to ~60fps so a 144Hz display doesn't produce a 144fps file.
      if (lastFrame < 0 || now - lastFrame >= FRAME_MS - 1) {
        lastFrame = now;
        drawAt(video.currentTime);
        pushFrame();
        if (onProgress && total) {
          const done = elapsedBefore + (video.currentTime - seq[segIdx].start);
          onProgress(Math.min(1, done / total));
        }
      }
      requestAnimationFrame(step);
    };

    const begin = () => {
      // Draw and capture the first frame BEFORE starting, so the opening
      // keyframe has real content rather than an empty (green) buffer.
      transSnapIdx = -1; // no transition on the very first clip
      drawClipIdx = 0;
      drawAt(video.currentTime);
      rec.start();
      pushFrame();
      video.play();
      // The webcam belongs to the recording; only run it when the first clip is
      // a recording clip (the seam re-syncs it as later recording clips arrive).
      if (camReady && activeIsRecording()) camVideo.play().catch(() => {});
      requestAnimationFrame(step);
    };

    video.pause();
    video.muted = true;
    if (camReady && activeIsRecording()) camVideo.currentTime = startAt;
    // Seek to the first clip; if we're already there, start immediately.
    if (Math.abs(video.currentTime - startAt) < 0.05) {
      begin();
    } else {
      let settled = false;
      const onSeeked = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        begin();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = startAt;
      setTimeout(onSeeked, 1500);
    }
  });
}

exportBtn.addEventListener('click', runExport);
backBtn.addEventListener('click', () => {
  // Guard against discarding an import-only studio session on a stray click.
  const hasImports = sources.some((s) => s.kind === 'import');
  if (hasImports && !confirm('العودة إلى شاشة التسجيل ستترك المونتاج الحالي. متابعة؟')) return;
  window.api.backHome();
});

init().catch((e) => {
  console.error(e);
  topStatus.textContent = 'خطأ: ' + e.message;
});
