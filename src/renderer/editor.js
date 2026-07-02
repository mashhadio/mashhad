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
const tlOverlays = document.getElementById('tlOverlays');
const tlAudio = document.getElementById('tlAudio');
const tlRuler = document.getElementById('tlRuler');
const linkAudio = document.getElementById('linkAudio');
const addTrackBtn = document.getElementById('addTrackBtn');
const voBtn = document.getElementById('voBtn');
const importAudioBtn = document.getElementById('importAudioBtn');

const autoZoomBtn = document.getElementById('autoZoomBtn');
const addZoomBtn = document.getElementById('addZoomBtn');
const clearZoomBtn = document.getElementById('clearZoomBtn');
const splitBtn = document.getElementById('splitBtn');
const removeSilenceBtn = document.getElementById('removeSilenceBtn');
const silenceSens = document.getElementById('silenceSens');
const silenceSensVal = document.getElementById('silenceSensVal');
const silenceGap = document.getElementById('silenceGap');
const silenceGapVal = document.getElementById('silenceGapVal');
const silenceGroup = document.getElementById('silenceGroup');
const silenceStatus = document.getElementById('silenceStatus');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const clipTransition = document.getElementById('clipTransition');
const speedGroup = document.getElementById('speedGroup');
const speedRange = document.getElementById('speedRange');
const speedVal = document.getElementById('speedVal');
const sceneGroup = document.getElementById('sceneGroup');
const sceneTransRange = document.getElementById('sceneTransRange');
const sceneTransValEd = document.getElementById('sceneTransValEd');
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

// ---------------------------------------------------------------------------
// Overlay video tracks (CapCut-style layering). The main track (`clips`) plays
// as before; overlay clips are positioned in EDITED time (`pos`) within the main
// timeline, and at any instant the TOP-most overlay clip covering the playhead
// is drawn full-frame over the main video ("the top layer is what shows").
// `speed` is carried on every clip for Phase 2 (default 1); `pos`/len are in
// edited seconds. Overlay clips reference `sources` by `sourceId` like main clips.
// ---------------------------------------------------------------------------
let overlayTracks = []; // [{ id, clips: [{ id, sourceId, start, end, pos, speed }] }]
let overlayClipSeq = 0;
let overlayTrackSeq = 0;
let selectedOverlay = null; // { clipId } or null
// Each overlay clip gets its OWN hidden <video> (keyed by clip id) so it never
// fights the main `video` element or another overlay clip from the same source.
const overlayEls = new Map();

// Audio tracks (voice-over / audio clips), rendered below the main track. Not
// drawn — mixed into the export and played through per-clip <audio> elements in
// preview. Clips carry `pos`/`speed`/`gain` and `voice:true` for recorded VO.
let audioTracks = []; // [{ id, clips: [{ id, sourceId, start, end, pos, speed, gain, voice }] }]
let audioClipSeq = 0;
let audioTrackSeq = 0;
let selectedAudio = null; // { clipId } or null
const audioEls = new Map(); // clipId -> <audio>
let voState = null; // active voice-over recording: { recorder, chunks, startPos, stream, startTime }
let voArming = false; // true between the VO click and the mic stream resolving

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

// Recording "scenes" (screen / cam / both), switched live with F1/F2/F3 and
// logged in the recording. The editor composites them per source time with a
// crossfade. `sceneEvents` are { t (source seconds), scene }. Empty = no scene
// mode → the recording renders exactly as before.
let sceneEvents = [];
let sceneTransDur = 0.3;    // crossfade seconds (adjustable in the editor)
// Frozen outgoing-scene frame for the crossfade (separate from clip transitions).
const sceneTransCanvas = document.createElement('canvas');
const sceneTransCtx = sceneTransCanvas.getContext('2d', { alpha: false });
let lastDrawnScene = null;  // scene of the previous drawn frame (linear playback)
let lastSceneT = 0;         // source time of the previous scene-composed frame
let sceneXfadeFrom = null;  // outgoing scene during an active crossfade, or null
let sceneXfadeStart = 0;    // source time the crossfade began
// Playback intent. Drives the render loop independently of any single element's
// paused state — crossing into a new source momentarily pauses the fresh element
// while its async play() resolves, and we must not let that stop the loop.
let playing = false;
// True while a clip-advance seek is in flight. A just-activated element reports a
// STALE currentTime until its seek lands; without this guard the render loop's
// clip-end test could read that stale value and skip the new clip outright.
let mediaSeeking = false;
let exporting = false;
let capturing = false; // true only during the export canvas-capture pass
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

    // Scene switches (screen/cam/both), if this recording used scene mode.
    const sc = recording.scenes;
    if (sc && Array.isArray(sc.events) && sc.events.length) {
      sceneEvents = sc.events.map((e) => ({ t: e.t / 1000, scene: e.scene }));
      sceneTransDur = sc.transition != null ? sc.transition : 0.3;
    }

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
  updateSceneControl();
  linkAudio.disabled = !(recording && recording.hasAudio);
  linkAudio.closest('.tl-link').style.display = linkAudio.disabled ? 'none' : '';

  // Prepare the cleaned-audio preview in the background for the current profile.
  if (recHasAudio && noiseProfile.value !== 'off') applyAudioPreview(noiseProfile.value);
}

function setCanvasSize(w, h) {
  canvas.width = w || 1920;
  canvas.height = h || 1080;
  transCanvas.width = canvas.width;
  transCanvas.height = canvas.height;
  sceneTransCanvas.width = canvas.width;
  sceneTransCanvas.height = canvas.height;
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
  // Recording plays through the cleaned-audio track (or its own), and is muted
  // when the audio is detached; imports play their own audio directly.
  video.muted = s.kind === 'recording' ? (cleanAudioActive || isAudioDetached()) : false;
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

// Draw an element covering the whole canvas (center-crop, "cover" fit) — overlay
// layers fully replace what's beneath them, matching "the top layer shows".
function drawElementCover(el) {
  const W = canvas.width, H = canvas.height, vw = el.videoWidth, vh = el.videoHeight;
  if (!vw || !vh) return;
  const cover = Math.max(W / vw, H / vh);
  const dw = vw * cover, dh = vh * cover;
  ctx.drawImage(el, 0, 0, vw, vh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// The dedicated hidden <video> for an overlay clip (created on first use).
function overlayElFor(c) {
  let el = overlayEls.get(c.id);
  if (!el) {
    const s = sourceById(c.sourceId);
    if (!s || !s.url) return null;
    el = document.createElement('video');
    el.src = s.url;
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.style.display = 'none';
    document.body.appendChild(el);
    overlayEls.set(c.id, el);
  }
  return el;
}

// Drop overlay elements whose clip no longer exists (called after each rebuild).
function pruneOverlayEls() {
  const ids = new Set(allOverlayClips().map((c) => c.id));
  overlayEls.forEach((el, id) => {
    if (!ids.has(id)) { try { el.pause(); el.remove(); } catch (_) {} overlayEls.delete(id); }
  });
}

function pauseOverlayEls() { overlayEls.forEach((el) => { if (!el.paused) el.pause(); }); }

// Composite the top-most overlay clip covering edited time `te` over the canvas.
function drawOverlays(te) {
  const hit = overlayClipAt(te);
  if (!hit) return;
  const el = overlayElFor(hit.clip);
  if (el && el.videoWidth) drawElementCover(el);
}

// Keep each overlay clip's dedicated element seeked/playing to match the
// playhead. Elements not currently covering the playhead are paused.
function updateOverlayPlayback(te) {
  const isPlaying = playing || capturing;
  const active = new Set();
  overlayTracks.forEach((trk) => {
    const c = overlayCoveringOnTrack(trk, te);
    if (!c) return;
    const s = sourceById(c.sourceId);
    const el = overlayElFor(c);
    if (!el) return;
    active.add(el);
    const want = srcTimeOf(c, te);
    el.playbackRate = c.speed || 1;
    el.muted = capturing ? true : !(s && s.hasAudio); // element audio is never captured
    if (isPlaying) {
      if (el.paused) { try { el.currentTime = want; } catch (_) {} el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - want) > 0.3) { try { el.currentTime = want; } catch (_) {} }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.05) {
        try { el.currentTime = want; } catch (_) {}
        // Redraw once the (async) overlay seek lands so a paused scrub is crisp.
        // Capture `te` so a later seek can't retarget this redraw.
        el.addEventListener('seeked', () => {
          if (!playing && !capturing) { drawAt(video.currentTime); drawOverlays(te); }
        }, { once: true });
      }
    }
  });
  overlayEls.forEach((el) => { if (!active.has(el) && !el.paused) el.pause(); });
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

  // Auto remove-silence: only meaningful for a recording with mic audio.
  silenceSens.value = String(Prefs.get('silenceSens', 3));
  silenceSensVal.textContent = SILENCE_SENS_LABELS[silenceSens.value] || 'متوسطة';
  silenceGap.value = String(Prefs.get('silenceGap', 0.4));
  silenceGapVal.textContent = parseFloat(silenceGap.value).toFixed(1);
  silenceGroup.style.display = (recording && recording.hasAudio) ? '' : 'none';

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
// Active scene at recording source time `t` (last switch at or before t).
function sceneAt(t) {
  let s = sceneEvents.length ? sceneEvents[0].scene : 'both';
  for (const e of sceneEvents) { if (e.t <= t + 1e-6) s = e.scene; else break; }
  return s;
}

// Draw the webcam covering the whole canvas (cover-fit) for the cam-only scene.
function drawCamFull() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!camReady || !camVideo.videoWidth) return;
  const W = canvas.width, H = canvas.height, vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  const cover = Math.max(W / vw, H / vh);
  const dw = vw * cover, dh = vh * cover;
  ctx.drawImage(camVideo, 0, 0, vw, vh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// Render a single scene's frame (no crossfade) to the main canvas.
function drawSceneFrame(scene, t, srcBlocks) {
  if (scene === 'cam') {
    drawCamFull();
    return;
  }
  // 'screen' and 'both' both show the zoom-tracked screen; 'both' adds cam PiP.
  engine.setBlocks(srcBlocks);
  engine.drawFrame(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height, t);
  drawClickFx(t);
  if (scene === 'both') drawCam();
}

function drawAt(t) {
  if (!video || !video.videoWidth) return;
  const srcBlocks = blocks.filter((b) => b.sourceId === activeSourceId);
  if (activeIsRecording()) {
    if (sceneEvents.length) {
      // Scene mode: compose the active scene, crossfading from the previous one.
      const scene = sceneAt(t);
      // Only crossfade on a genuine live switch — i.e. source time advancing
      // smoothly. A seek or a clip seam (reorder/split) jumps time; treat that as
      // a hard cut so we don't fire a phantom fade or freeze a stale frame.
      const jumped = lastDrawnScene === null || Math.abs(t - lastSceneT) > 0.5;
      if (jumped) sceneXfadeFrom = null;
      if (!jumped && (playing || capturing) && scene !== lastDrawnScene && sceneTransDur > 0) {
        sceneTransCtx.drawImage(canvas, 0, 0, sceneTransCanvas.width, sceneTransCanvas.height);
        sceneXfadeFrom = lastDrawnScene;
        sceneXfadeStart = t;
      }
      drawSceneFrame(scene, t, srcBlocks);
      if (sceneXfadeFrom && sceneTransDur > 0) {
        const p = (t - sceneXfadeStart) / sceneTransDur;
        if (p >= 0 && p < 1) {
          ctx.globalAlpha = 1 - p;
          ctx.drawImage(sceneTransCanvas, 0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        } else {
          sceneXfadeFrom = null;
        }
      }
      lastDrawnScene = scene;
      lastSceneT = t;
    } else {
      // No scenes: original behaviour — zoom-tracked screen + click FX + cam PiP.
      engine.setBlocks(srcBlocks);
      engine.drawFrame(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height, t);
      drawClickFx(t);
      drawCam();
    }
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
  if (!camReady) return;
  // Outside scene mode the camShow toggle gates the PiP; in scene mode the active
  // scene decides when drawCam is called, so don't also require camShow.
  if (!sceneEvents.length && !camShow.checked) return;
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
// True when the recording's mic audio has been detached onto its own audio track
// (so video cuts don't affect it). Derived from the presence of a detached clip.
function isAudioDetached() { return allAudioClips().some((c) => c.detached); }

function updateAudioRouting() {
  if (!video) return;
  // Recording: route through the cleaned-audio track when active, or stay muted
  // when the audio is detached (the audio track plays it). Imports play their own.
  video.muted = activeIsRecording() ? (cleanAudioActive || isAudioDetached()) : false;
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
  if (!video.paused && !isAudioDetached()) cleanAudio.play().catch(() => {});
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
  const sp = c.speed || 1;
  video.playbackRate = sp;
  const isRec = activeIsRecording();
  if (isRec && camReady) camVideo.playbackRate = sp;
  if (isRec && cleanAudioActive) cleanAudio.playbackRate = sp;
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
  const sp = c.speed || 1;
  if (video.playbackRate !== sp) video.playbackRate = sp; // per-clip speed

  // A clip-advance seek is still settling: draw the current frame and wait, so a
  // stale currentTime can't be mistaken for reaching this clip's end.
  if (mediaSeeking) {
    drawAt(video.currentTime);
    rafId = requestAnimationFrame(renderLoop);
    return;
  }

  // Reached the end of the current clip -> move to the next in edit order.
  // The lead is in SOURCE seconds, so scale by speed to keep the edited-time
  // lead constant (a slow clip must not lose a chunk of its tail).
  if (video.ended || video.currentTime >= c.end - SEAM * sp) {
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
  playheadEdited = clamp(editedStartOf(playIdx) + (video.currentTime - c.start) / sp, 0, editedDuration());
  updateOverlayPlayback(playheadEdited);
  drawOverlays(playheadEdited);
  updateAudioTrackPlayback(playheadEdited);
  movePlayhead(playheadEdited);
  updateTimeLabel();

  // Keep the recording-only aux tracks (webcam, cleaned mic) in step with
  // playback, and idle them while an imported clip is on screen.
  if (activeIsRecording()) {
    if (camReady) camVideo.playbackRate = sp;
    if (cleanAudioActive) cleanAudio.playbackRate = sp;
    playClickSounds(video.currentTime);
    if (camReady && camVideo.paused) camVideo.play().catch(() => {});
    // When audio is detached, the detached clip plays the mic (via its own
    // <audio>), so keep the cleaned track silent to avoid doubled audio.
    if (cleanAudioActive && !isAudioDetached()) {
      if (cleanAudio.paused) cleanAudio.play().catch(() => {});
      if (Math.abs(cleanAudio.currentTime - video.currentTime) > 0.18) cleanAudio.currentTime = video.currentTime;
    } else if (!cleanAudio.paused) {
      cleanAudio.pause();
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
  if (isRec && cleanAudioActive && !isAudioDetached()) { cleanAudio.currentTime = video.currentTime; cleanAudio.play().catch(() => {}); }
  playBtn.textContent = '⏸ إيقاف مؤقت';
  renderLoop();
}
function pause() {
  playing = false;
  if (video) video.pause();
  if (camReady) camVideo.pause();
  cleanAudio.pause();
  pauseOverlayEls();
  pauseAudioEls();
  // Stopping playback ends an in-progress voice-over (e.g. the timeline hit its
  // end) so the recorder never runs on past the timeline. stop() is synchronous
  // about state, so finishVoiceOver fires once via onstop.
  if (voState && voState.recorder && voState.recorder.state !== 'inactive') voState.recorder.stop();
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
// Draw a seconds ruler with "nice" intervals (~every 70px), fit to the timeline.
let rulerKey = '';
function buildRuler() {
  const total = editedDuration();
  const w = timeline.clientWidth;
  // Skip regeneration when neither width nor duration changed (buildTimeline runs
  // on every edit/drag; the ruler only depends on w + total).
  const key = `${Math.round(w)}_${Math.round(total * 100)}`;
  if (key === rulerKey && tlRuler.childElementCount) return;
  rulerKey = key;
  tlRuler.innerHTML = '';
  if (!total) return;
  const pps = w / (total || 1);
  const NICE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let step = NICE.find((s) => s * pps >= 70) || NICE[NICE.length - 1];
  for (let t = 0; t <= total + 1e-6; t += step) {
    const x = (t / total) * w;
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = x + 'px';
    tlRuler.appendChild(tick);
    const lbl = document.createElement('span');
    lbl.className = 'tick-label';
    lbl.style.left = x + 'px';
    lbl.textContent = fmt(t);
    tlRuler.appendChild(lbl);
  }
}

// Rebuild + reposition the playhead (used on window resize).
function relayoutTimeline() {
  buildTimeline();
  movePlayhead(playheadEdited);
}

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
    el.style.width = `${(clipTLen(c) / total) * w}px`;
    const transLabel = hasTrans ? (TRANSITION_LABELS[c.transition.type] || c.transition.type) : '';
    const srcName = src ? src.name : '';
    const spd = (c.speed || 1) !== 1 ? ` · ${(c.speed).toFixed(2)}×` : '';
    el.title = (isImport ? `${srcName} · ` : '')
      + (hasTrans ? `انتقال ${transLabel} · ` : '')
      + 'اسحب لإعادة الترتيب · ✕ أو Delete للحذف';
    const badge = hasTrans ? `<span class="clip-trans" title="انتقال ${transLabel}">▶</span>` : '';
    el.innerHTML = `${badge}<span class="clip-label">${fmt(clipTLen(c))}${spd}</span><button class="clip-delete" title="حذف المقطع" tabindex="-1">✕</button>`;
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
      const sp = c.speed || 1; // source range -> edited width shrinks with speed
      const es = editedStartOf(ci) + (s - c.start) / sp;
      const ee = editedStartOf(ci) + (e - c.start) / sp;
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

  buildOverlayRows();
  buildAudioRows();
  buildRuler();
  updateTransitionControl();
  updateSpeedControl();
  linkAudio.checked = !isAudioDetached(); // reflect detach state (covers undo/redo)
}

// Render one row per audio track (voice-over / audio clips), below the main track.
function buildAudioRows() {
  tlAudio.innerHTML = '';
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;
  audioTracks.forEach((trk, ti) => {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.dataset.atrack = ti;
    row.innerHTML = `<span class="tl-row-label">صوت ${ti + 1}</span>`
      + `<button class="tl-row-del" title="حذف مسار الصوت" tabindex="-1">✕</button>`;
    row.querySelector('.tl-row-del').addEventListener('mousedown', (e) => e.stopPropagation());
    row.querySelector('.tl-row-del').addEventListener('click', (e) => { e.stopPropagation(); deleteAudioTrack(trk.id); });
    trk.clips.forEach((c) => {
      const src = sourceById(c.sourceId);
      const el = document.createElement('div');
      el.className = 'aclip' + (selectedAudio && selectedAudio.clipId === c.id ? ' selected' : '');
      el.dataset.clipId = c.id;
      el.style.left = `${(c.pos / total) * w}px`;
      el.style.width = `${Math.max(6, (clipTLen(c) / total) * w)}px`;
      el.title = (src ? src.name + ' · ' : '') + 'اسحب للتحريك · ✕ للحذف';
      const icon = c.detached ? '🔗 ' : c.voice ? '🎙 ' : '';
      el.innerHTML = `<span class="clip-label">${icon}${fmt(clipTLen(c))}</span><button class="clip-delete" title="حذف" tabindex="-1">✕</button>`;
      el.querySelector('.clip-delete').addEventListener('mousedown', (e) => e.stopPropagation());
      el.querySelector('.clip-delete').addEventListener('click', (e) => { e.stopPropagation(); deleteAudioClip(c.id); });
      row.appendChild(el);
    });
    tlAudio.appendChild(row);
  });
  pruneAudioEls();
}

// Render one row per overlay track (top-most track first, so it sits at the top
// of the stack — matching the draw order where upper tracks cover lower ones).
function buildOverlayRows() {
  tlOverlays.innerHTML = '';
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;
  for (let ti = overlayTracks.length - 1; ti >= 0; ti--) {
    const trk = overlayTracks[ti];
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.dataset.track = ti;
    row.innerHTML = `<span class="tl-row-label">طبقة ${ti + 1}</span>`
      + `<button class="tl-row-del" title="حذف الطبقة" tabindex="-1">✕</button>`;
    row.querySelector('.tl-row-del').addEventListener('mousedown', (e) => e.stopPropagation());
    row.querySelector('.tl-row-del').addEventListener('click', (e) => { e.stopPropagation(); deleteOverlayTrack(trk.id); });
    trk.clips.forEach((c) => {
      const src = sourceById(c.sourceId);
      const el = document.createElement('div');
      el.className = 'oclip' + (selectedOverlay && selectedOverlay.clipId === c.id ? ' selected' : '');
      el.dataset.clipId = c.id;
      el.style.left = `${(c.pos / total) * w}px`;
      el.style.width = `${Math.max(6, (clipTLen(c) / total) * w)}px`;
      el.title = (src ? src.name + ' · ' : '') + 'اسحب للتحريك · لأسفل للمسار الرئيسي · ✕ للحذف';
      el.innerHTML = `<span class="clip-label">${fmt(clipTLen(c))}</span><button class="clip-delete" title="حذف" tabindex="-1">✕</button>`;
      el.querySelector('.clip-delete').addEventListener('mousedown', (e) => e.stopPropagation());
      el.querySelector('.clip-delete').addEventListener('click', (e) => { e.stopPropagation(); deleteOverlayClip(c.id); });
      row.appendChild(el);
    });
    tlOverlays.appendChild(row);
  }
  pruneOverlayEls();
}

function movePlayhead(te) {
  playhead.style.left = `${(te / (editedDuration() || 1)) * timeline.clientWidth}px`;
}

// Redraw once the element's async seek lands, so scrubbing across sources shows
// the correct frame rather than the pre-seek one. No-op while playing (the
// render loop already draws every frame).
function redrawAfterSeek(el, t, te) {
  const onSeeked = () => {
    el.removeEventListener('seeked', onSeeked);
    if (video === el && video.paused) { drawAt(t); drawOverlays(te != null ? te : playheadEdited); }
  };
  el.addEventListener('seeked', onSeeked);
}

// Seek by EDITED time: resolve to the source frame inside the active clip,
// switching the active source element when the clip lives in a different file.
function seekEdited(te) {
  if (!clips.length) { playheadEdited = 0; movePlayhead(0); updateTimeLabel(); return; }
  mediaSeeking = false; // a manual scrub supersedes any pending clip-advance seek
  lastDrawnScene = null; sceneXfadeFrom = null; // a scrub isn't a live scene switch
  te = clamp(te, 0, Math.max(0, editedDuration() - 0.001));
  const m = editedToSource(te);
  playIdx = m.idx;
  drawClipIdx = m.idx;
  transSnapIdx = -1; // a seek isn't a play-through; never composite a frozen frame
  playheadEdited = te;
  setActiveEl(m.clip.sourceId);
  const sp = m.clip.speed || 1;
  video.playbackRate = sp;
  const isRec = activeIsRecording();
  if (isRec && camReady) { camVideo.playbackRate = sp; camVideo.currentTime = Math.min(m.src, camVideo.duration || m.src); }
  if (isRec && cleanAudioActive) { cleanAudio.playbackRate = sp; cleanAudio.currentTime = Math.min(m.src, cleanAudio.duration || m.src); }
  video.currentTime = m.src;
  lastFxTime = m.src;
  drawAt(m.src);
  updateOverlayPlayback(te);
  drawOverlays(te);
  updateAudioTrackPlayback(te);
  redrawAfterSeek(video, m.src, te);
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
    selectedOverlay = null;
    selectedAudio = null;
    selectedClipId = clips[ci].id;
    // Toggle selection in place (don't rebuild — it would invalidate clipEl).
    [...timeline.querySelectorAll('.clip')].forEach((el) => el.classList.toggle('selected', +el.dataset.cidx === ci));
    [...tlOverlays.querySelectorAll('.oclip')].forEach((el) => el.classList.remove('selected'));
    updateTransitionControl();
    updateSpeedControl();
    clipDrag = { kind: 'main', idx: ci, id: clips[ci].id, el: clipEl, startX: e.clientX, startY: e.clientY, origPos: editedStartOf(ci), moved: false, slot: ci };
    seekEdited(((e.clientX - rect.left) / rect.width) * editedDuration());
    e.preventDefault();
    return;
  }

  // Bare timeline (gaps) -> deselect everything and seek.
  selectBlock(null);
  selectedOverlay = null;
  selectedAudio = null;
  selectedClipId = null;
  [...timeline.querySelectorAll('.clip'), ...tlOverlays.querySelectorAll('.oclip'), ...tlAudio.querySelectorAll('.aclip')]
    .forEach((el) => el.classList.remove('selected'));
  updateTransitionControl();
  updateSpeedControl();
  seekEdited(((e.clientX - rect.left) / rect.width) * editedDuration());
});

// Start dragging an overlay clip (move within/between overlay rows, or down to
// the main track).
tlOverlays.addEventListener('mousedown', (e) => {
  if (exporting) return;
  const oc = e.target.closest('.oclip');
  if (!oc) return;
  const id = +oc.dataset.clipId;
  const found = findOverlayClip(id);
  if (!found) return;
  selectBlock(null);
  selectOverlayClip(id);
  [...tlOverlays.querySelectorAll('.oclip')].forEach((el) => el.classList.toggle('selected', +el.dataset.clipId === id));
  [...timeline.querySelectorAll('.clip')].forEach((el) => el.classList.remove('selected'));
  updateTransitionControl();
  updateSpeedControl();
  seekEdited(clamp(found.clip.pos + 0.001, 0, editedDuration()));
  clipDrag = { kind: 'overlay', id, el: oc, startX: e.clientX, startY: e.clientY, origPos: found.clip.pos, moved: false, slot: clips.length };
  e.preventDefault();
});

// Start dragging an audio clip (reposition within / move between audio rows).
tlAudio.addEventListener('mousedown', (e) => {
  if (exporting) return;
  const ac = e.target.closest('.aclip');
  if (!ac) return;
  const id = +ac.dataset.clipId;
  const found = findAudioClip(id);
  if (!found) return;
  selectBlock(null);
  selectAudioClip(id);
  [...tlAudio.querySelectorAll('.aclip')].forEach((el) => el.classList.toggle('selected', +el.dataset.clipId === id));
  [...timeline.querySelectorAll('.clip')].forEach((el) => el.classList.remove('selected'));
  [...tlOverlays.querySelectorAll('.oclip')].forEach((el) => el.classList.remove('selected'));
  updateTransitionControl();
  updateSpeedControl();
  seekEdited(clamp(found.clip.pos + 0.001, 0, editedDuration()));
  clipDrag = { kind: 'audio', id, el: ac, startX: e.clientX, startY: e.clientY, origPos: found.clip.pos, moved: false };
  e.preventDefault();
});

// Which timeline row (main or an overlay track index) the pointer is over.
function rowUnderPointer(clientY) {
  for (const row of tlOverlays.querySelectorAll('.tl-row')) {
    const r = row.getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) return { type: 'overlay', ti: +row.dataset.track };
  }
  const tr = timeline.getBoundingClientRect();
  if (clientY <= tr.top && tlOverlays.children.length) {
    const first = tlOverlays.querySelector('.tl-row');
    if (first) return { type: 'overlay', ti: +first.dataset.track };
  }
  return { type: 'main' };
}
function timeAtClientX(clientX) {
  const r = timeline.getBoundingClientRect();
  const total = editedDuration() || 1;
  return clamp(((clientX - r.left) / r.width) * total, 0, total);
}
function highlightDropRow(row) {
  clearDropHighlight();
  if (row.type === 'main') { timeline.classList.add('drop-target'); return; }
  const el = [...tlOverlays.querySelectorAll('.tl-row')].find((r) => +r.dataset.track === row.ti);
  if (el) el.classList.add('drop-target');
}
function clearDropHighlight() {
  timeline.classList.remove('drop-target');
  tlOverlays.querySelectorAll('.tl-row').forEach((r) => r.classList.remove('drop-target'));
  tlAudio.querySelectorAll('.tl-row').forEach((r) => r.classList.remove('drop-target'));
}

// The audio track index under the pointer (clamped to the nearest row).
function audioRowUnderPointer(clientY) {
  const rows = [...tlAudio.querySelectorAll('.tl-row')];
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) return { ti: +row.dataset.atrack };
  }
  if (rows.length) {
    const firstR = rows[0].getBoundingClientRect();
    if (clientY < firstR.top) return { ti: +rows[0].dataset.atrack };
    return { ti: +rows[rows.length - 1].dataset.atrack };
  }
  return { ti: 0 };
}
function highlightDropRowAudio(arow) {
  clearDropHighlight();
  const el = [...tlAudio.querySelectorAll('.tl-row')].find((r) => +r.dataset.atrack === arow.ti);
  if (el) el.classList.add('drop-target');
}

window.addEventListener('mousemove', (e) => {
  if (drag) {
    const w = timeline.clientWidth;
    const total = editedDuration() || 1;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 2) drag.moved = true;
    const c = drag.clip;
    const sp = c.speed || 1;
    // A pixel delta is edited seconds; blocks live in SOURCE time, so scale by speed.
    const dt = (dx / w) * total * sp;
    const b = drag.block;
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
    const es = editedStartOf(ci) + (b.start - c.start) / sp;
    const ee = editedStartOf(ci) + (b.end - c.start) / sp;
    drag.el.style.left = `${(es / total) * w}px`;
    drag.el.style.width = `${Math.max(10, ((ee - es) / total) * w)}px`;
    drag.el.querySelector('span').textContent = `${b.scale.toFixed(1)}×`;
    drawAt(video.currentTime);
    drawOverlays(playheadEdited);
    return;
  }

  if (clipDrag) {
    const dx = e.clientX - clipDrag.startX;
    const dy = e.clientY - clipDrag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) clipDrag.moved = true;
    clipDrag.el.style.transform = `translate(${dx}px, ${dy}px)`;
    clipDrag.el.classList.add('dragging');
    const total = editedDuration() || 1;
    const dtTime = (dx / (timeline.clientWidth || 1)) * total;
    clipDrag.dropPos = clamp(clipDrag.origPos + dtTime, 0, total);
    if (clipDrag.kind === 'audio') {
      // Audio clips stay on audio tracks; pick the audio row under the pointer.
      const arow = audioRowUnderPointer(e.clientY);
      clipDrag.targetARow = arow;
      highlightDropRowAudio(arow);
      hideInsertMarker();
      return;
    }
    const row = rowUnderPointer(e.clientY);
    clipDrag.targetRow = row;
    highlightDropRow(row);
    // The insert marker (gapless slot) only applies when dropping on the main track.
    if (row.type === 'main') {
      const rect = timeline.getBoundingClientRect();
      clipDrag.slot = computeInsertIndex(e.clientX - rect.left);
      showInsertMarker(clipDrag.slot);
    } else {
      hideInsertMarker();
    }
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
    clearDropHighlight();
    if (!cd.moved) { buildTimeline(); return; }
    if (cd.kind === 'audio') {
      const found = findAudioClip(cd.id);
      const curTi = found ? audioTracks.indexOf(found.trk) : 0;
      const ti = cd.targetARow ? cd.targetARow.ti : curTi;
      moveAudioClip(cd.id, ti, cd.dropPos || 0);
      return;
    }
    const row = cd.targetRow || { type: cd.kind === 'overlay' ? 'overlay' : 'main' };
    if (cd.kind === 'main') {
      if (row.type === 'overlay') mainClipToOverlay(cd.idx, row.ti, cd.dropPos || 0);
      else moveClip(cd.idx, cd.slot);
    } else {
      if (row.type === 'main') {
        overlayClipToMain(cd.id, cd.slot != null ? cd.slot : clips.length);
      } else {
        const found = findOverlayClip(cd.id);
        const curTi = found ? overlayTracks.indexOf(found.trk) : -1;
        if (row.ti === curTi) moveOverlayClipPos(cd.id, cd.dropPos || 0);
        else overlayClipToTrack(cd.id, row.ti, cd.dropPos || 0);
      }
    }
  }
});

// Insertion slot (0..clips.length) nearest pointer x, by clip midpoints.
function computeInsertIndex(x) {
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;
  let acc = 0;
  let slot = 0;
  for (let i = 0; i < clips.length; i++) {
    const len = clipTLen(clips[i]);
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
  for (let i = 0; i < slot; i++) acc += clipTLen(clips[i]);
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
function clipLen(c) { return c.end - c.start; }             // source-time length
function editedDuration() { return clips.reduce((a, c) => a + clipTLen(c), 0); }

// ---------------------------------------------------------------------------
// Overlay helpers. `clipTLen` is a clip's length in EDITED (timeline) seconds,
// which for speed≠1 differs from its source length. Overlay clips carry an
// absolute `pos` (edited start); main clips are gapless so their edited start is
// `editedStartOf`. `srcTimeOf` maps an edited time inside a clip to source time.
// ---------------------------------------------------------------------------
function clipTLen(c) { return (c.end - c.start) / (c.speed || 1); }
function overlayEndPos(c) { return c.pos + clipTLen(c); }
function srcTimeOf(c, te) { return c.start + (te - c.pos) * (c.speed || 1); }
function allOverlayClips() { return overlayTracks.flatMap((t) => t.clips); }
function overlayCoveringOnTrack(trk, te) {
  return trk.clips.find((c) => te >= c.pos && te < overlayEndPos(c)) || null;
}
// Top-most overlay clip covering edited time `te` (search upper tracks first).
function overlayClipAt(te) {
  for (let t = overlayTracks.length - 1; t >= 0; t--) {
    const c = overlayCoveringOnTrack(overlayTracks[t], te);
    if (c) return { t, trk: overlayTracks[t], clip: c };
  }
  return null;
}
function findOverlayClip(id) {
  for (const trk of overlayTracks) {
    const c = trk.clips.find((x) => x.id === id);
    if (c) return { trk, clip: c };
  }
  return null;
}

// --- Audio-track helpers (mirror the overlay helpers) ---
function allAudioClips() { return audioTracks.flatMap((t) => t.clips); }
function audioCoveringOnTrack(trk, te) {
  return trk.clips.find((c) => te >= c.pos && te < overlayEndPos(c)) || null;
}
function findAudioClip(id) {
  for (const trk of audioTracks) {
    const c = trk.clips.find((x) => x.id === id);
    if (c) return { trk, clip: c };
  }
  return null;
}
// Dedicated hidden <audio> per audio clip (created on first use).
function audioElFor(c) {
  let el = audioEls.get(c.id);
  if (!el) {
    const s = sourceById(c.sourceId);
    if (!s || !s.url) return null;
    el = new Audio();
    el.src = s.url;
    el.preload = 'auto';
    audioEls.set(c.id, el);
  }
  return el;
}
function pruneAudioEls() {
  const ids = new Set(allAudioClips().map((c) => c.id));
  audioEls.forEach((el, id) => {
    if (!ids.has(id)) { try { el.pause(); el.src = ''; } catch (_) {} audioEls.delete(id); }
  });
}
function pauseAudioEls() { audioEls.forEach((el) => { if (!el.paused) el.pause(); }); }

// Keep each audio clip's <audio> playing/seeked to match the playhead (preview
// only — export rebuilds audio via ffmpeg, so this is skipped while capturing).
function updateAudioTrackPlayback(te) {
  if (capturing) return;
  const active = new Set();
  audioTracks.forEach((trk) => {
    const c = audioCoveringOnTrack(trk, te);
    if (!c) return;
    const el = audioElFor(c);
    if (!el) return;
    active.add(el);
    const want = srcTimeOf(c, te);
    el.playbackRate = c.speed || 1;
    el.volume = clamp(c.gain != null ? c.gain : 1, 0, 1);
    if (playing) {
      if (el.paused) { try { el.currentTime = want; } catch (_) {} el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - want) > 0.3) { try { el.currentTime = want; } catch (_) {} }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.05) { try { el.currentTime = want; } catch (_) {} }
    }
  });
  audioEls.forEach((el) => { if (!active.has(el) && !el.paused) el.pause(); });
}

// Resolve the duration of an audio URL (opus/webm can report Infinity first).
function resolveAudioDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.src = url;
    const done = (d) => resolve(isFinite(d) && d > 0 ? d : 0);
    a.addEventListener('loadedmetadata', () => {
      if (isFinite(a.duration) && a.duration > 0) return done(a.duration);
      const onDur = () => { if (isFinite(a.duration)) { a.removeEventListener('durationchange', onDur); done(a.duration); } };
      a.addEventListener('durationchange', onDur);
      a.currentTime = 1e6;
      setTimeout(() => done(a.duration), 2000);
    }, { once: true });
    a.addEventListener('error', () => resolve(0), { once: true });
  });
}

// Edited start (seconds) of the clip at index `idx`.
function editedStartOf(idx) {
  let s = 0;
  for (let i = 0; i < idx; i++) s += clipTLen(clips[i]);
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
    const len = clipTLen(clips[i]);
    if (te < acc + len || i === clips.length - 1) {
      // Edited offset within the clip maps to source time scaled by speed.
      return { idx: i, clip: clips[i], src: clips[i].start + (te - acc) * (clips[i].speed || 1) };
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
    if ((sourceId == null || c.sourceId === sourceId) && ts >= c.start && ts < c.end) return acc + (ts - c.start) / (c.speed || 1);
    acc += clipTLen(c);
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

// A full editable-timeline snapshot: the main track plus every overlay track.
function snapshotState() {
  return {
    clips: clips.map((c) => ({ ...c })),
    overlays: overlayTracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) })),
    audio: audioTracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) })),
  };
}
function applyState(s) {
  clips = s.clips.map((c) => ({ ...c }));
  overlayTracks = s.overlays.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) }));
  audioTracks = (s.audio || []).map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) }));
}

// Snapshot for undo, taken before every mutating edit. A fresh edit
// invalidates the redo stack.
function pushHistory() {
  clipHistory.push(snapshotState());
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
  to.push(snapshotState());
  applyState(from.pop());
  if (!clips.some((c) => c.id === selectedClipId)) selectedClipId = null;
  if (selectedOverlay && !findOverlayClip(selectedOverlay.clipId)) selectedOverlay = null;
  if (selectedAudio && !findAudioClip(selectedAudio.clipId)) selectedAudio = null;
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
  const right = { id: clipSeq++, sourceId: c.sourceId, start: t, end: c.end, speed: c.speed || 1 };
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

// ---------------------------------------------------------------------------
// Overlay track / clip operations
// ---------------------------------------------------------------------------
function addOverlayTrack() {
  if (exporting) return;
  pushHistory();
  overlayTracks.push({ id: overlayTrackSeq++, clips: [] });
  buildTimeline();
}

function deleteOverlayTrack(id) {
  if (exporting) return;
  const idx = overlayTracks.findIndex((t) => t.id === id);
  if (idx < 0) return;
  pushHistory();
  overlayTracks.splice(idx, 1);
  if (selectedOverlay && !findOverlayClip(selectedOverlay.clipId)) selectedOverlay = null;
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration())); // redraw without the removed layer
}

function deleteOverlayClip(id) {
  if (exporting) return;
  const found = findOverlayClip(id);
  if (!found) return;
  pushHistory();
  found.trk.clips = found.trk.clips.filter((c) => c.id !== id);
  if (selectedOverlay && selectedOverlay.clipId === id) selectedOverlay = null;
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

function selectOverlayClip(id) {
  const found = findOverlayClip(id);
  selectedOverlay = found ? { clipId: id } : null;
  if (found) { selectedClipId = null; selectedAudio = null; selectBlock(null); }
}

// Move a MAIN clip (by index) onto overlay track `ti` at edited position `pos`.
function mainClipToOverlay(mainIdx, ti, pos) {
  if (exporting || !clips[mainIdx] || !overlayTracks[ti]) return;
  // The main track drives playback, so keep at least one clip on it.
  if (clips.length <= 1) { topStatus.textContent = 'أبقِ مقطعًا واحدًا على الأقل في المسار الرئيسي'; buildTimeline(); return; }
  pushHistory();
  const [c] = clips.splice(mainIdx, 1);
  const oc = { id: overlayClipSeq++, sourceId: c.sourceId, start: c.start, end: c.end, pos: Math.max(0, pos), speed: c.speed || 1 };
  overlayTracks[ti].clips.push(oc);
  if (selectedClipId === c.id) selectedClipId = null;
  selectOverlayClip(oc.id);
  updateEmptyState();
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// Move an overlay clip to another overlay track `ti` keeping its position.
function overlayClipToTrack(id, ti, pos) {
  const found = findOverlayClip(id);
  if (exporting || !found || !overlayTracks[ti]) return;
  if (overlayTracks[ti] === found.trk) { moveOverlayClipPos(id, pos); return; } // same track = reposition
  pushHistory();
  found.trk.clips = found.trk.clips.filter((c) => c.id !== id);
  found.clip.pos = Math.max(0, pos);
  overlayTracks[ti].clips.push(found.clip);
  selectOverlayClip(id);
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// Move an overlay clip down into the main (gapless) track at insertion slot.
function overlayClipToMain(id, slot) {
  const found = findOverlayClip(id);
  if (exporting || !found) return;
  pushHistory();
  found.trk.clips = found.trk.clips.filter((c) => c.id !== id);
  const c = found.clip;
  const mc = { id: clipSeq++, sourceId: c.sourceId, start: c.start, end: c.end, speed: c.speed || 1 };
  slot = clamp(slot, 0, clips.length);
  clips.splice(slot, 0, mc);
  selectedOverlay = null;
  selectClip(mc.id);
  updateEmptyState();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// Just reposition an overlay clip within its own track.
function moveOverlayClipPos(id, pos) {
  const found = findOverlayClip(id);
  if (exporting || !found) return;
  pushHistory();
  found.clip.pos = Math.max(0, pos);
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// ---------------------------------------------------------------------------
// Audio-track operations
// ---------------------------------------------------------------------------
function addAudioTrack() {
  if (exporting) return;
  pushHistory();
  audioTracks.push({ id: audioTrackSeq++, clips: [] });
  buildTimeline();
}
function deleteAudioTrack(id) {
  if (exporting) return;
  const idx = audioTracks.findIndex((t) => t.id === id);
  if (idx < 0) return;
  pushHistory();
  audioTracks.splice(idx, 1);
  if (selectedAudio && !findAudioClip(selectedAudio.clipId)) selectedAudio = null;
  buildTimeline();
}
function deleteAudioClip(id) {
  if (exporting) return;
  const found = findAudioClip(id);
  if (!found) return;
  pushHistory();
  found.trk.clips = found.trk.clips.filter((c) => c.id !== id);
  if (selectedAudio && selectedAudio.clipId === id) selectedAudio = null;
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}
function selectAudioClip(id) {
  const found = findAudioClip(id);
  selectedAudio = found ? { clipId: id } : null;
  if (found) { selectedClipId = null; selectedOverlay = null; selectBlock(null); }
}
// Move an audio clip to audio track index `ti` at edited position `pos`.
function moveAudioClip(id, ti, pos) {
  const found = findAudioClip(id);
  if (exporting || !found || !audioTracks[ti]) return;
  pushHistory();
  if (audioTracks[ti] !== found.trk) {
    found.trk.clips = found.trk.clips.filter((c) => c.id !== id);
    audioTracks[ti].clips.push(found.clip);
  }
  found.clip.pos = Math.max(0, pos);
  selectAudioClip(id);
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// Detach the recording's mic audio onto its own audio track so video edits no
// longer cut it (the "unlink audio" state). The video's own audio is muted.
function detachAudio() {
  if (exporting || !recording || !recording.hasAudio || isAudioDetached()) return;
  const rec = sourceById(recording.id);
  const dur = rec ? rec.duration : 0;
  if (!dur) return;
  pushHistory();
  // Use a dedicated track so the full-length detached clip never overlaps an
  // existing voice-over / imported audio clip.
  const trk = { id: audioTrackSeq++, clips: [] };
  trk.clips.push({ id: audioClipSeq++, sourceId: recording.id, start: 0, end: dur, pos: 0, speed: 1, gain: 1, voice: true, detached: true });
  audioTracks.push(trk);
  buildTimeline();
  updateAudioRouting(); // mute the recording video now, even mid-playback
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// Re-link: remove the detached audio clip(s); the video's own audio is used again.
function reattachAudio() {
  if (exporting || !isAudioDetached()) return;
  pushHistory();
  audioTracks.forEach((t) => { t.clips = t.clips.filter((c) => !c.detached); });
  buildTimeline();
  updateAudioRouting(); // unmute the recording video again, even mid-playback
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// ---------------------------------------------------------------------------
// Voice-over: record the mic while the timeline plays, then drop the clip onto
// an audio track at the position where recording started.
// ---------------------------------------------------------------------------
async function toggleVoiceOver() {
  if (exporting) return;
  if (voState) { stopVoiceOver(); return; }
  if (voArming) return; // ignore repeat clicks while the mic stream is resolving
  voArming = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
  } catch (err) {
    voArming = false;
    topStatus.textContent = 'تعذّر الوصول إلى الميكروفون: ' + (err.message || err);
    return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => finishVoiceOver(chunks, stream);
  voState = { recorder, chunks, startPos: playheadEdited, stream, startTime: Date.now() };
  voArming = false;
  voBtn.classList.add('recording');
  voBtn.textContent = '⏹ إيقاف';
  topStatus.textContent = '● جارٍ تسجيل التعليق…';
  recorder.start();
  if (!playing) play(); // roll the timeline so the user can narrate over it
}

function stopVoiceOver() {
  if (!voState) return;
  if (voState.recorder.state !== 'inactive') voState.recorder.stop();
  if (playing) pause();
}

// Import audio files (voice notes / music) as clips on an audio track, placed
// from the playhead and stacked back-to-back.
async function importAudioFiles() {
  if (exporting) return;
  topStatus.textContent = 'جارٍ الاستيراد…';
  let list = [];
  try {
    list = await window.api.importAudio();
  } catch (err) {
    topStatus.textContent = 'تعذّر الاستيراد: ' + (err.message || err);
    return;
  }
  if (!list.length) { topStatus.textContent = ''; return; }

  // Resolve durations first so we don't push a history entry for nothing.
  const resolved = [];
  for (const item of list) {
    const dur = await resolveAudioDuration(item.url);
    if (dur) resolved.push({ item, dur });
  }
  if (!resolved.length) { topStatus.textContent = 'تعذّر قراءة الملف الصوتي'; return; }

  pushHistory();
  if (!audioTracks.length) audioTracks.push({ id: audioTrackSeq++, clips: [] });
  const trk = audioTracks[audioTracks.length - 1];
  let pos = playheadEdited;
  let lastId = null;
  for (const { item, dur } of resolved) {
    sources.push({ id: item.id, kind: 'import', url: item.url, el: null, duration: dur, width: 0, height: 0, hasAudio: true, name: item.name });
    const clip = { id: audioClipSeq++, sourceId: item.id, start: 0, end: dur, pos: Math.max(0, pos), speed: 1, gain: 1, voice: false };
    trk.clips.push(clip);
    pos += dur;
    lastId = clip.id;
  }
  selectAudioClip(lastId);
  topStatus.textContent = `أُضيف ${resolved.length} مقطع صوتي`;
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

async function finishVoiceOver(chunks, stream) {
  try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  const startPos = voState ? voState.startPos : 0;
  const startTime = voState ? voState.startTime : 0;
  voState = null;
  voBtn.classList.remove('recording');
  voBtn.textContent = '🎙 تعليق';
  const blob = new Blob(chunks, { type: 'audio/webm' });
  if (!blob.size) { topStatus.textContent = 'لم يُسجَّل صوت'; return; }
  topStatus.textContent = 'جارٍ حفظ التعليق…';
  let res;
  try {
    res = await window.api.saveVoiceOver(await blob.arrayBuffer());
  } catch (err) {
    topStatus.textContent = 'تعذّر حفظ التعليق: ' + (err.message || err);
    return;
  }
  if (!res || !res.id) { topStatus.textContent = 'تعذّر حفظ التعليق'; return; }
  // MediaRecorder webm/opus often reports Infinity duration; fall back to the
  // measured wall-clock recording length so a valid take is never dropped.
  let dur = await resolveAudioDuration(res.url);
  if ((!dur || !isFinite(dur)) && startTime) dur = (Date.now() - startTime) / 1000;
  if (!dur) { topStatus.textContent = 'التعليق فارغ'; return; }
  sources.push({ id: res.id, kind: 'voiceover', url: res.url, el: null, duration: dur, width: 0, height: 0, hasAudio: true, name: 'تعليق صوتي' });
  pushHistory();
  if (!audioTracks.length) audioTracks.push({ id: audioTrackSeq++, clips: [] });
  const clip = { id: audioClipSeq++, sourceId: res.id, start: 0, end: dur, pos: Math.max(0, startPos), speed: 1, gain: 1, voice: true };
  audioTracks[audioTracks.length - 1].clips.push(clip);
  selectAudioClip(clip.id);
  topStatus.textContent = 'أُضيف التعليق الصوتي';
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

// ---------------------------------------------------------------------------
// Per-clip speed (main or overlay). The selected clip's `speed` scales its
// timeline length (shorter as it speeds up) and its playback rate.
// ---------------------------------------------------------------------------
function currentSpeedClip() {
  if (selectedAudio) { const f = findAudioClip(selectedAudio.clipId); return f ? f.clip : null; }
  if (selectedOverlay) { const f = findOverlayClip(selectedOverlay.clipId); return f ? f.clip : null; }
  return selectedClip();
}

function updateSpeedControl() {
  const c = currentSpeedClip();
  if (!c) { speedGroup.style.display = 'none'; return; }
  speedGroup.style.display = '';
  const sp = c.speed || 1;
  speedRange.value = String(sp);
  speedVal.textContent = `${sp.toFixed(2)}×`;
}

function setSpeed(v) {
  const c = currentSpeedClip();
  if (!c || exporting) return;
  const sp = clamp(parseFloat(v) || 1, 0.25, 4);
  if (Math.abs(sp - (c.speed || 1)) < 1e-4) return;
  pushHistory();
  c.speed = sp;
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
  updateSpeedControl();
}
// Live label while dragging; commit (one history entry) on release.
speedRange.addEventListener('input', () => { speedVal.textContent = `${parseFloat(speedRange.value).toFixed(2)}×`; });
speedRange.addEventListener('change', () => setSpeed(speedRange.value));

// Scene-transition control: only relevant for recordings made with scene mode.
function updateSceneControl() {
  sceneGroup.style.display = sceneEvents.length ? '' : 'none';
  sceneTransRange.value = String(sceneTransDur);
  sceneTransValEd.textContent = sceneTransDur.toFixed(2);
}
sceneTransRange.addEventListener('input', () => {
  sceneTransDur = parseFloat(sceneTransRange.value) || 0;
  sceneTransValEd.textContent = sceneTransDur.toFixed(2);
  if (!playing) seekEdited(playheadEdited); // re-render at the current position
});

// ---------------------------------------------------------------------------
// Auto remove-silence (jump cuts): keep only the spans where the mic has speech.
// ---------------------------------------------------------------------------
let recAudioBuffer = null; // decoded recording audio, cached across runs
let recAudioFailed = false; // remember a decode failure so we don't re-fetch a big file
async function getRecordingAudioBuffer() {
  if (recAudioBuffer) return recAudioBuffer;
  if (recAudioFailed || !recording || !recording.videoUrl) return null;
  const arr = await (await fetch(recording.videoUrl)).arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  try { recAudioBuffer = await actx.decodeAudioData(arr); }
  catch (err) { recAudioFailed = true; throw err; }
  finally { try { actx.close(); } catch (_) {} }
  return recAudioBuffer;
}

// Speech spans [ [start,end], ... ] in source seconds. Windows below an
// amplitude threshold are "silence"; only silence gaps ≥ minSilence are cut, and
// each kept span is padded so cuts don't clip word starts/ends.
function detectSpeechRanges(buf, thresholdRatio, minSilence, pad) {
  const sr = buf.sampleRate;
  const a = buf.getChannelData(0);
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const n = a.length;
  const win = Math.max(1, Math.round(sr * 0.02)); // 20 ms
  const nWin = Math.ceil(n / win);
  const rms = new Float32Array(nWin);
  let peak = 0;
  for (let w = 0; w < nWin; w++) {
    const s = w * win, e = Math.min(n, s + win);
    let sum = 0;
    for (let i = s; i < e; i++) { const v = b ? (a[i] + b[i]) * 0.5 : a[i]; sum += v * v; }
    const r = Math.sqrt(sum / Math.max(1, e - s));
    rms[w] = r; if (r > peak) peak = r;
  }
  const thresh = Math.max(peak * thresholdRatio, 0.004);
  const winDur = win / sr;
  const raw = [];
  for (let i = 0; i < nWin;) {
    if (rms[i] >= thresh) { let j = i; while (j < nWin && rms[j] >= thresh) j++; raw.push([i * winDur, j * winDur]); i = j; }
    else i++;
  }
  if (!raw.length) return [];
  const merged = [];
  let [cs, ce] = raw[0];
  for (let k = 1; k < raw.length; k++) {
    const [s, e] = raw[k];
    if (s - ce < minSilence) ce = e; else { merged.push([cs, ce]); [cs, ce] = [s, e]; }
  }
  merged.push([cs, ce]);
  const dur = buf.duration;
  const out = [];
  for (const [s, e] of merged) {
    const ps = Math.max(0, s - pad), pe = Math.min(dur, e + pad);
    if (out.length && ps <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], pe);
    else out.push([ps, pe]);
  }
  return out;
}

const SILENCE_RATIOS = { 1: 0.02, 2: 0.04, 3: 0.06, 4: 0.10, 5: 0.15 };

async function removeSilences() {
  if (exporting || !recording || !recording.hasAudio) return;
  // With audio detached, cutting only the video would desync the audio clip.
  if (isAudioDetached()) { silenceStatus.textContent = 'أعد ربط الصوت أولًا (🔗)'; return; }
  removeSilenceBtn.disabled = true;
  silenceStatus.textContent = 'جارٍ التحليل…';
  let buf;
  try { buf = await getRecordingAudioBuffer(); }
  catch (_) { silenceStatus.textContent = 'تعذّر تحليل الصوت'; removeSilenceBtn.disabled = false; return; }
  removeSilenceBtn.disabled = false;
  if (!buf) { silenceStatus.textContent = 'لا يوجد صوت للتحليل'; return; }

  const ratio = SILENCE_RATIOS[parseInt(silenceSens.value, 10)] || 0.06;
  const minSilence = parseFloat(silenceGap.value) || 0.4;
  const speech = detectSpeechRanges(buf, ratio, minSilence, 0.12);
  if (!speech.length) { silenceStatus.textContent = 'لم يُعثر على كلام'; return; }

  if (playing) pause(); // don't let the render loop index a stale clip mid-rebuild

  // Keep only speech sub-ranges of recording clips; leave imports/other tracks.
  const before = editedDuration();
  const newClips = [];
  let recClipsIn = 0;
  let recClipsKept = 0;
  for (const c of clips) {
    const src = sourceById(c.sourceId);
    if (src && src.kind === 'recording') {
      recClipsIn++;
      let first = true;
      for (const [s, e] of speech) {
        const a2 = Math.max(s, c.start), b2 = Math.min(e, c.end);
        if (b2 - a2 > 0.05) {
          const nc = { id: clipSeq++, sourceId: c.sourceId, start: a2, end: b2, speed: c.speed || 1 };
          if (first && c.transition) nc.transition = { ...c.transition }; // keep the clip's intro transition
          newClips.push(nc);
          recClipsKept++;
          first = false;
        }
      }
    } else newClips.push({ ...c });
  }
  // Don't silently wipe the footage if detection removed every recording clip.
  if (recClipsIn > 0 && recClipsKept === 0) { silenceStatus.textContent = 'الحساسية عالية جدًا — لم يبقَ شيء'; return; }
  if (!newClips.length) { silenceStatus.textContent = 'لا شيء لإبقائه'; return; }

  pushHistory();
  clips = newClips;
  selectedClipId = null;
  playIdx = 0; // clips array replaced; reset the play index the render loop reads
  updateEmptyState();
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
  const removed = Math.max(0, before - editedDuration());
  silenceStatus.textContent = removed > 0.05 ? `أُزيل ${fmt(removed)} من الصمت` : 'لا صمت يُذكر';
}

const importBtn = document.getElementById('importBtn');
importBtn.addEventListener('click', importVideos);
autoZoomBtn.addEventListener('click', autoZoom);
addZoomBtn.addEventListener('click', addZoomHere);
clearZoomBtn.addEventListener('click', clearZoom);
splitBtn.addEventListener('click', splitAtPlayhead);
removeSilenceBtn.addEventListener('click', removeSilences);
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
addTrackBtn.addEventListener('click', addOverlayTrack);
voBtn.addEventListener('click', toggleVoiceOver);
importAudioBtn.addEventListener('click', importAudioFiles);

// Reflow the fit-to-width timeline when the window resizes.
window.addEventListener('resize', () => { if (clips.length) relayoutTimeline(); });

// Link/unlink the recording's audio from its video (detach onto an audio track).
linkAudio.addEventListener('change', () => {
  if (!recording || !recording.hasAudio) { linkAudio.checked = true; return; }
  if (linkAudio.checked) reattachAudio(); else detachAudio();
});

const SILENCE_SENS_LABELS = { 1: 'منخفضة جدًا', 2: 'منخفضة', 3: 'متوسطة', 4: 'عالية', 5: 'عالية جدًا' };
silenceSens.addEventListener('input', () => {
  silenceSensVal.textContent = SILENCE_SENS_LABELS[silenceSens.value] || 'متوسطة';
  Prefs.set('silenceSens', parseInt(silenceSens.value, 10));
});
silenceGap.addEventListener('input', () => {
  silenceGapVal.textContent = parseFloat(silenceGap.value).toFixed(1);
  Prefs.set('silenceGap', parseFloat(silenceGap.value));
});

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
    } else if (selectedAudio) {
      e.preventDefault();
      deleteAudioClip(selectedAudio.clipId);
    } else if (selectedOverlay) {
      e.preventDefault();
      deleteOverlayClip(selectedOverlay.clipId);
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
// The PiP is draggable when it can be shown: in scene mode the active scene
// controls visibility (so bypass camShow, matching drawCam); otherwise camShow.
function camPipInteractive() { return camReady && (sceneEvents.length > 0 || camShow.checked); }
canvas.addEventListener('mousedown', (e) => {
  if (!camPipInteractive()) return;
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
  if (!camPipInteractive()) { canvas.style.cursor = 'default'; return; }
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

  // Overlay video clips and audio-track clips both contribute audio, mixed in at
  // their timeline `pos`. Voice-over clips carry `voice` so ffmpeg can denoise them.
  const overlayPayload = [...allOverlayClips(), ...allAudioClips()].map((c) => ({
    sourceId: c.sourceId, start: c.start, end: c.end, pos: c.pos, speed: c.speed || 1,
    gain: c.gain != null ? c.gain : 1, voice: !!c.voice,
  }));

  // Pass the clip list (with source ids) whenever the timeline isn't a single,
  // untrimmed recording clip — that lone case keeps the original fast path.
  const pureUnedited = recording && !isEdited() && clips.length === 1
    && clips[0].sourceId === recording.id && (clips[0].speed || 1) === 1 && !overlayPayload.length;
  const clipsPayload = pureUnedited
    ? null
    : clips.map((c) => ({ sourceId: c.sourceId, start: c.start, end: c.end, speed: c.speed || 1 }));

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
        overlayClips: overlayPayload,
        // When detached, the mic audio comes from the audio-track clip above, so
        // the recording video clips must not also contribute it.
        recordingAudioMuted: isAudioDetached(),
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
  capturing = true;  // overlay elements play muted alongside during capture
  lastDrawnScene = null; sceneXfadeFrom = null; // fresh scene-crossfade state
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
      capturing = false;
      pauseOverlayEls();
      updateAudioRouting(); // restore preview audio routing
      resolve(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
    };
    rec.onerror = (e) => { capturing = false; pauseOverlayEls(); updateAudioRouting(); reject(e.error || new Error('خطأ في المُسجِّل')); };

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
      const segSp = seq[segIdx].speed || 1;
      if (video.playbackRate !== segSp) video.playbackRate = segSp; // per-clip speed

      // Reached the end of the current clip (source-second lead scaled by speed).
      if (video.ended || video.currentTime >= seq[segIdx].end - 0.02 * segSp) {
        snapshotOutgoing(segIdx + 1); // freeze for the next clip's transition
        elapsedBefore += clipTLen(seq[segIdx]); // timeline length (speed-scaled)
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
        if (activeIsRecording()) { camVideo.playbackRate = segSp; if (camVideo.paused) camVideo.play().catch(() => {}); }
        else if (!camVideo.paused) camVideo.pause();
      }

      // Throttle to ~60fps so a 144Hz display doesn't produce a 144fps file.
      if (lastFrame < 0 || now - lastFrame >= FRAME_MS - 1) {
        lastFrame = now;
        const teNow = elapsedBefore + (video.currentTime - seq[segIdx].start) / segSp;
        drawAt(video.currentTime);
        updateOverlayPlayback(teNow); // drive overlay elements (muted) alongside
        drawOverlays(teNow);          // composite the top overlay layer
        pushFrame();
        if (onProgress && total) onProgress(Math.min(1, teNow / total));
      }
      requestAnimationFrame(step);
    };

    const begin = () => {
      // Draw and capture the first frame BEFORE starting, so the opening
      // keyframe has real content rather than an empty (green) buffer.
      transSnapIdx = -1; // no transition on the very first clip
      drawClipIdx = 0;
      drawAt(video.currentTime);
      updateOverlayPlayback(0);
      drawOverlays(0);
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
