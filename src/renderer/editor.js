'use strict';

const video = document.getElementById('srcVideo');
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
let engine = null;
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
  if (!project) {
    document.getElementById('content').innerHTML = '<div class="empty">No recording loaded.</div>';
    return;
  }

  noiseProfile.disabled = !project.hasAudio;
  if (!project.hasAudio) {
    noiseProfile.value = 'off';
    noiseProfile.title = 'لم يُسجَّل أي ميكروفون';
  }

  video.src = project.videoUrl;
  video.muted = false;

  await new Promise((res) => {
    if (video.readyState >= 1) return res();
    video.addEventListener('loadedmetadata', res, { once: true });
  });

  duration = await resolveDuration();
  clips = [{ id: clipSeq++, start: 0, end: duration }];
  clipHistory = [];
  playIdx = 0;
  playheadEdited = 0;

  canvas.width = video.videoWidth || 1920;
  canvas.height = video.videoHeight || 1080;
  transCanvas.width = canvas.width;
  transCanvas.height = canvas.height;

  if (project.hasCam && project.camUrl) {
    await setupCam(project.camUrl);
  }

  await seekTo(0);

  clickTimes = (project.cursor.clicks || []).map((c) => c.t / 1000);

  applyEditorPrefs();

  rebuildEngine();
  autoZoom();
  drawAt(0);
  buildTimeline();
  updateTimeLabel();

  // Prepare the cleaned-audio preview in the background for the current profile.
  if (project.hasAudio && noiseProfile.value !== 'off') applyAudioPreview(noiseProfile.value);
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
  engine = new ZoomEngine(project.cursor, blocks, {
    ramp: parseFloat(smoothRamp.value),
    smoothing: 0.22,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function drawAt(t) {
  if (!video.videoWidth) return;
  engine.setBlocks(blocks);
  engine.drawFrame(ctx, video, video.videoWidth, video.videoHeight, canvas.width, canvas.height, t);
  drawClickFx(t);
  drawCam();
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
  if (!clickFx.checked || !(project.cursor.clicks || []).length) return;
  const { r: cr, g: cg, b: cb } = hexToRgb(clickColor.value);
  const baseR = canvas.height * (parseInt(clickSize.value, 10) / 100);
  const style = clickStyle.value;

  for (const c of project.cursor.clicks) {
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
  video.muted = cleanAudioActive;
}

// Render (via ffmpeg) and load the cleaned mic audio for the given profile, then
// route preview playback through it. profile === 'off' restores the raw audio.
async function applyAudioPreview(profile) {
  if (!project || !project.hasAudio) return;
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

// Advance the source <video> to the start of the next clip in edit order.
// Returns false when the playhead has run off the end of the timeline.
function advanceToNextClip() {
  if (playIdx >= clips.length - 1) return false;
  playIdx++;
  const nc = clips[playIdx];
  if (camReady) camVideo.currentTime = Math.min(nc.start, camVideo.duration || nc.start);
  if (cleanAudioActive) cleanAudio.currentTime = nc.start;
  video.currentTime = nc.start;
  lastFxTime = nc.start; // don't fire clicks across the seam
  return true;
}

const SEAM = 0.03; // advance this many seconds before a clip's source end

function renderLoop() {
  // Keep going when the media element fires 'ended' mid-timeline (a reordered
  // clip can hit the true source end); only bail on an intentional pause.
  if (video.paused && !video.ended) return;
  const c = clips[playIdx];
  if (!c) { pause(); return; }
  drawClipIdx = playIdx;

  // Reached the end of the current clip -> move to the next in edit order.
  if (video.ended || video.currentTime >= c.end - SEAM) {
    snapshotOutgoing(playIdx + 1); // freeze this frame for the next clip's transition
    const next = clips[playIdx + 1];
    const contiguous = next && !video.ended && Math.abs(next.start - c.end) < 0.04;
    if (contiguous) {
      playIdx++; // a plain split: keep rolling through the seam without a seek
    } else if (!advanceToNextClip()) {
      pause();
      playIdx = clips.length - 1;
      seekEdited(editedDuration());
      return;
    } else if (video.paused) {
      video.play().catch(() => {}); // resume if the seek followed an 'ended'
    }
    rafId = requestAnimationFrame(renderLoop);
    return;
  }

  drawAt(video.currentTime);
  playheadEdited = clamp(editedStartOf(playIdx) + (video.currentTime - c.start), 0, editedDuration());
  movePlayhead(playheadEdited);
  updateTimeLabel();
  playClickSounds(video.currentTime);
  if (cleanAudioActive && Math.abs(cleanAudio.currentTime - video.currentTime) > 0.18) {
    cleanAudio.currentTime = video.currentTime;
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
  if (playheadEdited >= editedDuration() - 0.05) seekEdited(0); // restart from top
  lastFxTime = video.currentTime;
  updateAudioRouting();
  video.play();
  if (camReady) camVideo.play().catch(() => {});
  if (cleanAudioActive) { cleanAudio.currentTime = video.currentTime; cleanAudio.play().catch(() => {}); }
  playBtn.textContent = '⏸ إيقاف مؤقت';
  renderLoop();
}
function pause() {
  video.pause();
  if (camReady) camVideo.pause();
  cleanAudio.pause();
  playBtn.textContent = '▶ تشغيل';
  if (rafId) cancelAnimationFrame(rafId);
}
playBtn.addEventListener('click', () => {
  if (exporting) return; // the export pass owns playback
  video.paused ? play() : pause();
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

  // Clip track — the draggable, reorderable base layer.
  clips.forEach((c, ci) => {
    const hasTrans = ci > 0 && c.transition && c.transition.type !== 'none';
    const el = document.createElement('div');
    el.className = 'clip' + (c.id === selectedClipId ? ' selected' : '') + (hasTrans ? ' has-trans' : '');
    el.dataset.cidx = ci;
    el.style.left = `${(editedStartOf(ci) / total) * w}px`;
    el.style.width = `${(clipLen(c) / total) * w}px`;
    const transLabel = hasTrans ? (TRANSITION_LABELS[c.transition.type] || c.transition.type) : '';
    el.title = hasTrans
      ? `انتقال ${transLabel} · اسحب لإعادة الترتيب · ✕ أو Delete للحذف`
      : 'اسحب لإعادة الترتيب · ✕ أو Delete للحذف';
    const badge = hasTrans ? `<span class="clip-trans" title="انتقال ${transLabel}">▶</span>` : '';
    el.innerHTML = `${badge}<span class="clip-label">${fmt(clipLen(c))}</span><button class="clip-delete" title="حذف المقطع" tabindex="-1">✕</button>`;
    el.querySelector('.clip-delete').addEventListener('mousedown', (e) => e.stopPropagation());
    el.querySelector('.clip-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteClip(c.id);
    });
    timeline.appendChild(el);
  });

  // Recorded clicks, mapped onto the edited timeline (dropped if cut out).
  (project.cursor.clicks || []).forEach((c) => {
    const te = sourceToEdited(c.t / 1000);
    if (te == null) return;
    const tick = document.createElement('div');
    tick.className = 'click-tick';
    tick.style.left = `${(te / total) * w}px`;
    timeline.appendChild(tick);
  });

  // Zoom blocks live in source time; draw one rect per clip they overlap so they
  // stay visually attached to their footage no matter how clips are reordered.
  blocks.forEach((b, bi) => {
    clips.forEach((c, ci) => {
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
      el.title = `تكبير ${b.scale.toFixed(1)}× — اسحب للتحريك، الحواف لتغيير الحجم، ✕ أو Backspace للحذف`;
      el.innerHTML = `<div class="handle l"></div><span>${b.scale.toFixed(1)}×</span><button class="block-delete" title="حذف التكبير" tabindex="-1">✕</button><div class="handle r"></div>`;
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); deleteBlock(b); });
      el.querySelector('.block-delete').addEventListener('mousedown', (ev) => ev.stopPropagation());
      el.querySelector('.block-delete').addEventListener('click', (ev) => { ev.stopPropagation(); deleteBlock(b); });
      timeline.appendChild(el);
    });
  });

  updateTransitionControl();
}

function movePlayhead(te) {
  playhead.style.left = `${(te / (editedDuration() || 1)) * timeline.clientWidth}px`;
}

// Seek by EDITED time: resolve to the source frame inside the active clip.
function seekEdited(te) {
  te = clamp(te, 0, Math.max(0, editedDuration() - 0.001));
  const m = editedToSource(te);
  playIdx = m.idx;
  drawClipIdx = m.idx;
  transSnapIdx = -1; // a seek isn't a play-through; never composite a frozen frame
  playheadEdited = te;
  if (camReady) camVideo.currentTime = Math.min(m.src, camVideo.duration || m.src);
  if (cleanAudioActive) cleanAudio.currentTime = Math.min(m.src, cleanAudio.duration || m.src);
  video.currentTime = m.src;
  lastFxTime = m.src;
  drawAt(m.src);
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
    const c = clips[+blockEl.dataset.clip];
    selectBlock(b);
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
  blocks = ZoomEngine.autoBlocks(project.cursor, { scale: defaultScale, duration });
  selectBlock(null);
  buildTimeline();
  drawAt(video.currentTime);
}

function addZoomHere() {
  const t = video.currentTime;
  const start = Math.max(0, t - 0.2);
  const end = Math.min(duration, start + DEFAULT_BLOCK_LEN);
  const b = { start, end, scale: defaultScale };
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

// source time -> edited time, or null if that moment was cut out.
function sourceToEdited(ts) {
  let acc = 0;
  for (const c of clips) {
    if (ts >= c.start && ts < c.end) return acc + (ts - c.start);
    acc += clipLen(c);
  }
  return null;
}

function clipIdxForSource(ts) {
  for (let i = 0; i < clips.length; i++) if (ts >= clips[i].start && ts < clips[i].end) return i;
  return 0;
}

function selectedClip() { return clips.find((c) => c.id === selectedClipId) || null; }

function selectClip(id) {
  selectedClipId = id;
  buildTimeline();
}

// Snapshot for undo, taken before every mutating edit.
function pushHistory() {
  clipHistory.push(clips.map((c) => ({ ...c })));
  if (clipHistory.length > 100) clipHistory.shift();
  updateUndoBtn();
}

function updateUndoBtn() {
  undoBtn.disabled = clipHistory.length === 0;
}

function undo() {
  if (exporting || !clipHistory.length) return;
  clips = clipHistory.pop();
  if (!clips.some((c) => c.id === selectedClipId)) selectedClipId = null;
  updateUndoBtn();
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
}

function splitAtPlayhead() {
  if (exporting) return;
  const m = editedToSource(playheadEdited);
  const c = m.clip;
  const t = m.src;
  // Don't split on a boundary or at the very edges of a clip.
  if (t <= c.start + 0.05 || t >= c.end - 0.05) return;
  pushHistory();
  const idx = clips.indexOf(c);
  const right = { id: clipSeq++, start: t, end: c.end };
  c.end = t;
  clips.splice(idx + 1, 0, right);
  selectClip(right.id); // redraws the timeline
}

function deleteClip(id) {
  if (exporting) return;
  const c = clips.find((x) => x.id === id);
  if (!c) return;
  if (clips.length <= 1) {
    topStatus.textContent = 'لا يمكن حذف المقطع الأخير المتبقّي.';
    return;
  }
  pushHistory();
  clips = clips.filter((x) => x.id !== id);
  if (selectedClipId === id) selectedClipId = null;
  buildTimeline();
  seekEdited(clamp(playheadEdited, 0, editedDuration()));
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

autoZoomBtn.addEventListener('click', autoZoom);
addZoomBtn.addEventListener('click', addZoomHere);
clearZoomBtn.addEventListener('click', clearZoom);
splitBtn.addEventListener('click', splitAtPlayhead);
undoBtn.addEventListener('click', undo);

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
// clip; 'S' splits at the playhead; Ctrl/Cmd+Z undoes the last clip edit.
window.addEventListener('keydown', (e) => {
  if (exporting) return; // ignore edit shortcuts during an export
  if (shortcutsModal.classList.contains('open')) return; // modal owns the keyboard
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;

  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    video.paused ? play() : pause();
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
    undo();
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
  if (!clickTimes.length) {
    topStatus.textContent = 'لا توجد نقرات مُسجَّلة في هذا المقطع للمعاينة.';
    return;
  }
  topStatus.textContent = '';
  let tc = clickTimes.find((x) => x > video.currentTime + 0.05);
  if (tc === undefined) tc = clickTimes[0]; // wrap to the first click
  const start = Math.max(0, tc - 0.4);
  const stopAt = Math.min(duration || tc + 0.8, tc + 0.7);

  pause();
  seekTo(start).then(() => {
    playIdx = clipIdxForSource(start);
    const te = sourceToEdited(start);
    if (te != null) playheadEdited = te;
    lastFxTime = start;
    play();
    const watch = () => {
      if (video.paused) return;
      if (video.currentTime >= stopAt || video.ended) {
        pause();
        // Park just after the click so the ripple stays frozen on screen.
        seekTo(tc + 0.12).then(() => {
          playIdx = clipIdxForSource(tc + 0.12);
          const pe = sourceToEdited(tc + 0.12);
          if (pe != null) playheadEdited = pe;
          drawAt(video.currentTime);
          movePlayhead(playheadEdited);
          updateTimeLabel();
        });
      } else {
        requestAnimationFrame(watch);
      }
    };
    requestAnimationFrame(watch);
  });
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
  if (exporting) return;
  exporting = true;
  pause();
  exportBtn.disabled = true;
  progress.classList.add('active');
  progressFill.style.width = '0%';
  exportStatus.textContent = 'جارٍ معالجة التكبير والكاميرا…';

  // Use a much higher intermediate bitrate for the editing master so the
  // canvas-render generation doesn't soften the final.
  const interBitrate = exportFormat.value === 'master' ? 50_000_000 : 16_000_000;
  const zoomedBuffer = await renderZoomedWebm((p) => {
    progressFill.style.width = `${Math.round(p * 60)}%`;
  }, interBitrate);

  exportStatus.textContent = 'جارٍ الترميز وتنقية الصوت…';
  progressFill.style.width = '70%';

  const off = window.api.onExportProgress((line) => { exportStatus.textContent = line; });

  // Click sounds must land on the edited timeline; drop any that were cut out.
  const editedClicks = clickTimes.map(sourceToEdited).filter((t) => t != null);

  try {
    const res = await window.api.runExport({
      zoomedBuffer,
      options: {
        audioEnabled: project.hasAudio && noiseProfile.value !== 'off',
        noiseProfile: noiseProfile.value,
        clickSound: clickSound.checked,
        clickTimes: clickSound.checked ? editedClicks : [],
        clickSoundName: clickSoundName.value,
        clickVolume: parseInt(clickVol.value, 10) / 100,
        durationSec: editedDuration(),
        // Source ranges in edit order; FFmpeg cuts + reorders the mic to match.
        clips: isEdited() ? clips.map((c) => ({ start: c.start, end: c.end })) : null,
        format: exportFormat.value,
        quality: exportQuality.value,
        resolution: exportResolution.value,
      },
    });
    off();
    if (res.canceled) {
      exportStatus.textContent = 'أُلغِي التصدير.';
    } else {
      progressFill.style.width = '100%';
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
        segIdx++;
        if (segIdx >= seq.length) {
          finished = true;
          video.pause();
          if (camReady) camVideo.pause();
          setTimeout(() => rec.stop(), 200);
          return;
        }
        const target = seq[segIdx].start;
        if (camReady) camVideo.currentTime = Math.min(target, camVideo.duration || target);
        // Contiguous clips (a plain split): we're already there, keep rolling
        // without a seek — seeking to the same spot never fires 'seeked'.
        if (!video.ended && Math.abs(video.currentTime - target) < 0.04) {
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
        let settled = false;
        const onSeeked = () => {
          if (settled) return;
          settled = true;
          video.removeEventListener('seeked', onSeeked);
          skipping = false;
          lastFrame = -1;
          // If we just seeked away from the true media end, the element paused
          // on 'ended' — resume so the next clip actually plays out.
          if (video.paused) video.play().catch(() => {});
          if (rec.state === 'paused') rec.resume();
          requestAnimationFrame(step);
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = target;
        setTimeout(onSeeked, 1500); // safety if 'seeked' is missed
        return;
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
      if (camReady) camVideo.play().catch(() => {});
      requestAnimationFrame(step);
    };

    video.pause();
    video.muted = true;
    if (camReady) camVideo.currentTime = startAt;
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
backBtn.addEventListener('click', () => window.api.backHome());

init().catch((e) => {
  console.error(e);
  topStatus.textContent = 'خطأ: ' + e.message;
});
