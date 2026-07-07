'use strict';

const sourceSelect = document.getElementById('sourceSelect');
const previewStage = document.getElementById('previewStage');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const screenPreviewVideo = document.getElementById('screenPreviewVideo');
const micSelect = document.getElementById('micSelect');
const micEnabled = document.getElementById('micEnabled');
const micMeterFill = document.getElementById('micMeterFill');
const camSelect = document.getElementById('camSelect');
const camEnabled = document.getElementById('camEnabled');
const fpsSelect = document.getElementById('fpsSelect');
const qualitySelect = document.getElementById('qualitySelect');
const formatSelect = document.getElementById('formatSelect');
const perfGuideIcon = document.getElementById('perfGuideIcon');
const perfGuideTitle = document.getElementById('perfGuideTitle');
const perfGuideBody = document.getElementById('perfGuideBody');
const perfGuideMeter = document.getElementById('perfGuideMeter');
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const recBanner = document.getElementById('recBanner');
const timerEl = document.getElementById('timer');
const topStatus = document.getElementById('topStatus');
const permBanner = document.getElementById('permBanner');
const openScreenSettingsBtn = document.getElementById('openScreenSettingsBtn');

const selectAreaBtn = document.getElementById('selectAreaBtn');
const regionChip = document.getElementById('regionChip');
const regionChipText = document.getElementById('regionChipText');
const regionClear = document.getElementById('regionClear');
const regionOutline = document.getElementById('regionOutline');

const camPreviewBox = document.getElementById('camPreviewBox');
const camPreview = document.getElementById('camPreview');
const bgPicker = document.getElementById('bgPicker');
const bgFileInput = document.getElementById('bgFileInput');
const blurAmount = document.getElementById('blurAmount');
const blurAmountVal = document.getElementById('blurAmountVal');
const blurAmountWrap = document.getElementById('blurAmountWrap');
const camStatus = document.getElementById('camStatus');

const scenesEnabled = document.getElementById('scenesEnabled');
const sceneStart = document.getElementById('sceneStart');
const sceneStartWrap = document.getElementById('sceneStartWrap');
const sceneTrans = document.getElementById('sceneTrans');
const sceneTransVal = document.getElementById('sceneTransVal');
const sceneTransWrap = document.getElementById('sceneTransWrap');
const scenesHint = document.getElementById('scenesHint');

let selectedSource = null;
let mediaRecorder = null;
let camRecorder = null;
let camStopped = Promise.resolve();
// Serializes chunk writes to preserve order (Blob.arrayBuffer can otherwise
// resolve out of order and corrupt the file). Every queueChunk call chains onto
// this, so awaiting the latest `writeQueue` at stop time is enough to know every
// chunk so far has landed — no separate array of in-flight promises needed.
let writeQueue = Promise.resolve();
let writeFailed = false; // surfaced once per recording; see queueChunk's catch

// Queue a recorder chunk so chunks are written in capture order. A failed write
// is surfaced (and the recording stopped) as soon as it happens, rather than only
// being discovered later when the final chain is awaited at stop time. `kind` is
// 'video' or 'cam'.
//
// NB: chunks go over ipcRenderer.invoke, which structured-clone-COPIES each
// ArrayBuffer (report finding #32 asked whether a MessagePort could transfer
// instead). Investigated and abandoned: Electron's renderer→main MessagePort
// delivers a TRANSFERRED ArrayBuffer as null on the main side (verified in this
// Electron build), so the buffer would have to be copied over the port anyway —
// identical cost to invoke, with more moving parts in the data-loss-critical
// path. Not worth it (and the report gated it on profiling, which never flagged
// the copy as a bottleneck vs. encode cost).
function queueChunk(blob, kind) {
  const p = writeQueue.then(async () => {
    const buf = await blob.arrayBuffer();
    await (kind === 'cam' ? window.api.sendCamChunk(buf) : window.api.sendVideoChunk(buf));
  });
  writeQueue = p.catch((err) => {
    if (writeFailed) return;
    writeFailed = true;
    console.error('Chunk write failed:', err);
    topStatus.textContent = 'فشل حفظ جزء من التسجيل على القرص — يُوقَف التسجيل الآن لحماية ما أُنجز.';
    stopRecording();
  });
}

// ---------------------------------------------------------------------------
// Tuning constants — named so the choice behind each value is explainable at a
// glance instead of a bare literal scattered through the file.
// ---------------------------------------------------------------------------
const MIN_BITRATE = 1_500_000;        // floor so tiny/low-fps captures still look OK
const MAX_BITRATE = 40_000_000;       // ceiling so 4K60 stays bounded
const PREVIEW_MAX_WIDTH = 1280;       // the on-screen "what will be recorded" preview
const PREVIEW_MAX_HEIGHT = 720;       // is downscaled...
const PREVIEW_MAX_FPS = 10;           // ...and throttled — it's never the recorded file
const FPS_THROTTLE_TOLERANCE = 0.5;   // slack added to the region-crop redraw interval
const MIC_METER_FFT_SIZE = 512;
const MIC_METER_RMS_SCALE = 3;        // boosts the level bar so it doesn't read as flat
const MEDIARECORDER_TIMESLICE_MS = 250; // chunk interval, also the timer tick interval

// Recording-quality presets. Each trades CPU load against file quality:
//  - bpp: bits-per-pixel-per-frame; the encoder bitrate is derived from this
//    times the actual capture resolution × fps, so small/low-fps captures stay
//    light instead of always paying a flat bitrate.
//  - codecs: preference order. VP8 encodes far cheaper than VP9 in software
//    (Chromium has no GPU path for MediaRecorder VP9), so "performance" picks
//    VP8; "high" picks VP9 for better quality-per-bit. Both stay in the webm
//    container, so the editor and ffmpeg pipeline are unaffected.
//  - load: a rough 0..1 CPU-cost weight used only to drive the guide meter.
const QUALITY_PRESETS = {
  performance: {
    bpp: 0.05,
    codecs: ['vp8', 'vp9'],
    load: 0.34,
    icon: '🍃',
    title: 'الأداء — مناسب للأجهزة الضعيفة',
    body: 'يستخدم ضغط VP8 الأخف على المعالج ومعدّل بِت أقل، فيقلّل احتمال تقطيع أو فقدان الإطارات أثناء التسجيل. الأفضل مع الأجهزة ذات المعالج الضعيف أو الذاكرة المحدودة. الحجم أصغر والجودة جيدة لكن أقل حدّة.',
  },
  balanced: {
    bpp: 0.08,
    codecs: ['vp9', 'vp8'],
    load: 0.6,
    icon: '⚖️',
    title: 'متوازن — الخيار الافتراضي',
    body: 'توازن بين الجودة وحِمل المعالج باستخدام ضغط VP9 ومعدّل بِت متوسط. مناسب لمعظم الأجهزة الحديثة. قد يسبب بعض التقطيع على الأجهزة الضعيفة جدًا عند 60 إطار/ث.',
  },
  high: {
    bpp: 0.12,
    codecs: ['vp9'],
    load: 0.9,
    icon: '💎',
    title: 'جودة عالية — يتطلب جهازًا قويًا',
    body: 'أعلى جودة ووضوح بمعدّل بِت مرتفع وضغط VP9، لكنه يحمّل المعالج بشدة وقد يسبب تقطيعًا وفقدانًا للإطارات على الأجهزة الضعيفة. استخدمه فقط مع معالج قوي. الملفات أكبر حجمًا.',
  },
};

function currentPreset() {
  return QUALITY_PRESETS[qualitySelect.value] || QUALITY_PRESETS.balanced;
}

// Output-format presets for social platforms. `aspect` (w/h) locks the
// region-select box to that shape; `out` is the standard pixel resolution the
// cropped region is scaled to so the file matches what the platform expects.
// `original` keeps the legacy behaviour: free-form region, native crop size.
const FORMAT_PRESETS = {
  original: { aspect: null, out: null, label: 'الأصلية' },
  youtube:  { aspect: 16 / 9, out: { w: 1920, h: 1080 }, label: 'يوتيوب 16:9' },
  shorts:   { aspect: 9 / 16, out: { w: 1080, h: 1920 }, label: 'شورتس 9:16' },
  square:   { aspect: 1,      out: { w: 1080, h: 1080 }, label: 'مربّع 1:1' },
  portrait: { aspect: 4 / 5,  out: { w: 1080, h: 1350 }, label: 'عمودي 4:5' },
};

function currentFormat() {
  return FORMAT_PRESETS[formatSelect.value] || FORMAT_PRESETS.original;
}

// Largest rectangle of the given aspect (w/h) centered within `bounds` (DIP).
// Used when a platform format is chosen but the user hasn't drawn a region.
function fitAspectRegion(bounds, aspect) {
  let w = bounds.width;
  let h = w / aspect;
  if (h > bounds.height) { h = bounds.height; w = h * aspect; }
  return {
    x: Math.round((bounds.width - w) / 2),
    y: Math.round((bounds.height - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

// Choose a MediaRecorder mime + bitrate from the active preset and the real
// capture size, falling back across the preset's codec list to whatever the
// platform actually supports.
function pickVideoConfig(preset, fps, width, height, withAudio) {
  let mime = 'video/webm';
  for (const c of preset.codecs) {
    const candidate = withAudio
      ? `video/webm;codecs=${c},opus`
      : `video/webm;codecs=${c}`;
    if (MediaRecorder.isTypeSupported(candidate)) { mime = candidate; break; }
  }
  const pixels = Math.max(1, width * height);
  const raw = pixels * fps * preset.bpp;
  // Clamp to a sane window so tiny regions still look OK and 4K60 stays bounded.
  const bitrate = Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, raw)));
  return { mime, bitrate };
}

// Update the guide card whenever the preset or fps changes. The meter combines
// the preset's base load with an fps multiplier: doubling the frame rate roughly
// doubles the per-second encoding work, so 60fps is weighted ~1.5× here.
function renderPerfGuide() {
  const p = currentPreset();
  const fps = parseInt(fpsSelect.value, 10) || 30;
  perfGuideIcon.textContent = p.icon;
  perfGuideTitle.textContent = p.title;
  let body = p.body;
  if (fps >= 60) {
    body += ' — ملاحظة: 60 إطار/ث يرفع الحِمل على المعالج بشكل كبير؛ اختر 30 إطار/ث على الأجهزة الضعيفة.';
  }
  perfGuideBody.textContent = body;
  const load = Math.min(1, p.load * (fps >= 60 ? 1.5 : 1));
  perfGuideMeter.style.setProperty('--load', Math.round(load * 100) + '%');
  const color = load < 0.45 ? 'var(--accent)' : load < 0.75 ? '#e0b341' : '#e0594b';
  perfGuideMeter.style.setProperty('--load-color', color);
}

let recState = null; // { display, recBaseEpoch, hasAudio, hasCam }
let timerInt = null;
let streams = [];
// Recording lifecycle as a single state instead of separate isRecording/arming
// booleans: 'idle' -> 'arming' -> 'recording' -> 'stopping' -> 'idle'. A second
// start/stop/toggle call is only honoured when it's valid for the CURRENT phase,
// which closes the race where a click (or repeated hotkey) landing in the async
// gap between phases could start a second overlapping recording, or let a
// stop-then-restart tear down the wrong session (see the state-machine findings
// in the 2026-07-06 code review).
let recPhase = 'idle';
let sources = []; // current list for the active tab
let previewStream = null; // live screen-preview capture
let selectedRegion = null; // { x, y, w, h } in DIP rel. to the display, or null
let cropCtl = null; // { stop() } for the region-crop draw loop while recording

// Live webcam preview + background-blur pipeline.
const camProcessor = new CameraProcessor(camPreview);
let camPreviewOn = false;
// Release the MediaPipe segmentation instance's WASM/GPU resources before this
// page is torn down (navigating to the editor, or the app closing) rather than
// only relying on stop()/start() cycles, which intentionally leave it open.
window.addEventListener('beforeunload', () => { camProcessor.close(); });

// ---------------------------------------------------------------------------
// Populate sources + mics
// ---------------------------------------------------------------------------
let currentKind = 'screen';

const SOURCE_HINTS = {
  screen:
    '🖥️ <b>الشاشة</b> — تُسجّل شاشة كاملة (الخلفية وشريط المهام وكل التطبيقات). ' +
    'الخيار الأفضل: <b>التكبير المتتبِّع للمؤشر</b> وتأثيرات النقر تعمل فقط مع تسجيل الشاشة الكاملة.',
  window:
    '🪟 <b>نافذة</b> — تُسجّل نافذة تطبيق واحدة فقط؛ ويُستبعد كل ما عداها حتى لو تداخل معها. ' +
    'ملاحظة: التكبير المتتبِّع للمؤشر وتأثيرات النقر مُعطَّلة هنا (يبقى التكبير في المنتصف)، لأنه يتعذّر تحديد موضع المؤشر داخل نافذة متحرّكة.<br>' +
    '💡 اختيار متصفّح يُسجّل النافذة بأكملها (التبويب الظاهر). لالتقاط <b>تبويب واحد فقط</b>، اسحبه إلى نافذة مستقلة أولًا، ثم اضغط ↻ تحديث.',
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

// Clear and repopulate a <select> from a list of {id, label} entries — the
// "clear select, loop devices, append option" pattern repeated (inconsistently:
// only some call sites also restored the previous selection) across all four
// source/camera/mic/speaker dropdowns in this file.
function populateSelect(select, items) {
  const prevId = select.value;
  select.innerHTML = '';
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    select.appendChild(opt);
  });
  if (prevId && items.some((i) => i.id === prevId)) select.value = prevId;
}

async function loadSources() {
  if (currentKind === 'camera') return loadCameraSources();
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
      ? 'يلزم إذن تسجيل الشاشة — انظر الشريط أعلاه'
      : `لم يُعثر على ${currentKind === 'screen' ? 'شاشات' : 'نوافذ مفتوحة'} — جرّب ↻ تحديث`;
    sourceSelect.appendChild(opt);
    selectedSource = null;
    recordBtn.disabled = true;
    stopScreenPreview();
    if (denied) {
      previewPlaceholder.textContent =
        'تسجيل الشاشة موقَّف لهذا التطبيق. فعّله من إعدادات النظام، ثم أغلق التطبيق وأعد فتحه.';
      previewPlaceholder.style.display = 'block';
    }
    return;
  }

  populateSelect(sourceSelect, sources.map((s) => ({ id: s.id, label: s.name })));

  const chosen = sources.find((s) => s.id === prevId) || sources[0];
  sourceSelect.value = chosen.id;
  selectSource(chosen.id);
}

function selectSource(id) {
  selectedSource = sources.find((s) => s.id === id) || null;
  recordBtn.disabled = !selectedSource;
  // A region is tied to a specific display; switching sources invalidates it.
  selectedRegion = null;
  updateAreaUI();
  if (currentKind === 'camera') {
    startCameraModePreview();
  } else if (selectedSource) {
    startScreenPreview(selectedSource);
  } else {
    stopScreenPreview();
  }
}

sourceSelect.addEventListener('change', () => selectSource(sourceSelect.value));

// ---------------------------------------------------------------------------
// Recording area (drag-to-select a sub-region of the screen)
// ---------------------------------------------------------------------------
function canSelectArea() {
  return !!selectedSource && (selectedSource.kind || 'screen') === 'screen';
}

// The rectangle that will actually be recorded: an explicitly drawn region, or
// — when a platform format is active with no region drawn — the largest centered
// box of that aspect. Null means "record the whole source".
function effectiveRegion() {
  if (!canSelectArea()) return null;
  if (selectedRegion) return selectedRegion;
  const fmt = currentFormat();
  if (fmt.aspect) return fitAspectRegion(selectedSource.display.bounds, fmt.aspect);
  return null;
}

function updateAreaUI() {
  const enabled = canSelectArea();
  const fmt = currentFormat();
  selectAreaBtn.disabled = !enabled;
  // Aspect crop needs a screen source; windows are recorded at their own size.
  formatSelect.disabled = !enabled;
  formatSelect.title = enabled ? '' : 'نسب المنصّات متاحة لمصادر الشاشة الكاملة فقط';
  selectAreaBtn.title = enabled
    ? (fmt.aspect ? `اسحب لتحديد منطقة بنسبة ${fmt.label}` : 'اسحب لتسجيل جزء من الشاشة فقط')
    : 'تحديد المنطقة متاح فقط لمصادر الشاشة الكاملة';

  if (selectedRegion && enabled) {
    regionChip.style.display = 'inline-flex';
    regionChipText.textContent = fmt.out
      ? `${selectedRegion.w} × ${selectedRegion.h} → ${fmt.out.w}×${fmt.out.h}`
      : `${selectedRegion.w} × ${selectedRegion.h}`;
    selectAreaBtn.textContent = '⬚ تغيير المنطقة…';
  } else {
    regionChip.style.display = 'none';
    // With a platform format and no manual region we auto-fit the whole display,
    // so tell the user what that produces rather than leaving the button bare.
    selectAreaBtn.textContent = fmt.aspect && enabled ? '⬚ تحديد منطقة (أو الشاشة كاملة)…' : '⬚ تحديد منطقة…';
  }
  updateRegionOutline();
}

// Draw the chosen region as an outline over the contained (letterboxed) preview.
function updateRegionOutline() {
  const r = effectiveRegion();
  if (!r || !canSelectArea()) {
    regionOutline.style.display = 'none';
    return;
  }
  const b = selectedSource.display.bounds;
  const sw = previewStage.clientWidth;
  const sh = previewStage.clientHeight;
  if (!sw || !sh) return;
  const dispAspect = b.width / b.height;
  const stageAspect = sw / sh;
  let vw, vh, ox, oy;
  if (dispAspect > stageAspect) {
    vw = sw; vh = sw / dispAspect; ox = 0; oy = (sh - vh) / 2;
  } else {
    vh = sh; vw = sh * dispAspect; oy = 0; ox = (sw - vw) / 2;
  }
  regionOutline.style.display = 'block';
  regionOutline.style.left = ox + (r.x / b.width) * vw + 'px';
  regionOutline.style.top = oy + (r.y / b.height) * vh + 'px';
  regionOutline.style.width = (r.w / b.width) * vw + 'px';
  regionOutline.style.height = (r.h / b.height) * vh + 'px';
}

async function pickArea() {
  if (!canSelectArea()) return;
  let rect = null;
  try {
    rect = await window.api.selectRegion({
      display: selectedSource.display,
      aspect: currentFormat().aspect, // locks the drag box when a platform is chosen
    });
  } catch (err) {
    console.warn('Area selection failed:', err.message);
  }
  if (rect && rect.w > 0 && rect.h > 0) selectedRegion = rect;
  updateAreaUI();
}

selectAreaBtn.addEventListener('click', pickArea);
regionClear.addEventListener('click', () => { selectedRegion = null; updateAreaUI(); });

// Switching the target aspect invalidates any region drawn for the old shape.
formatSelect.addEventListener('change', () => {
  Prefs.set('format', formatSelect.value);
  selectedRegion = null;
  updateAreaUI();
});
window.addEventListener('resize', updateRegionOutline);

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
          // It's only a small on-screen preview: capture downscaled and at a low
          // frame rate so a 4K / multi-monitor desktop isn't continuously
          // captured at full resolution (a real CPU/GPU drain while idle here).
          maxWidth: PREVIEW_MAX_WIDTH,
          maxHeight: PREVIEW_MAX_HEIGHT,
          maxFrameRate: PREVIEW_MAX_FPS,
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
    previewPlaceholder.textContent = 'المعاينة غير متاحة: ' + err.message;
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

// Show/hide the screen-only controls (crop, platform format, scenes, webcam
// overlay) depending on whether we're in camera-recording mode.
function updateModeUI() {
  const cam = currentKind === 'camera';
  const fmtField = document.getElementById('formatField');
  const areaField = document.getElementById('areaField');
  const scenesBox = document.getElementById('scenesBox');
  const camField = camEnabled.closest('.field');
  if (fmtField) fmtField.style.display = cam ? 'none' : '';
  if (areaField) areaField.style.display = cam ? 'none' : '';
  if (scenesBox) scenesBox.style.display = cam ? 'none' : '';
  if (camField) camField.style.display = cam ? 'none' : '';
  previewStage.classList.toggle('cam-full', cam);
  if (cam) {
    camPreviewBox.style.display = 'flex'; // background picker always available
  } else if (!camEnabled.checked) {
    // Leaving camera mode with no webcam overlay wanted: stop it and hide the panel.
    if (camPreviewOn) stopCamPreview(); else camPreviewBox.style.display = 'none';
  }
}

// Source-type tabs + refresh
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    setTabSelected(tab.dataset.kind);
    currentKind = tab.dataset.kind;
    Prefs.set('sourceKind', currentKind);
    updateModeUI();
    loadSources();
  });
});
document.getElementById('refreshSources').addEventListener('click', () => loadSources());

// Camera-recording mode: list cameras and preview the processed feed full-frame.
async function loadCameraSources() {
  const hintEl = document.getElementById('sourceHint');
  if (hintEl) hintEl.innerHTML = '🎥 <b>الكاميرا</b> — سجّل الكاميرا كفيديو رئيسي، مع خلفية اختيارية (لون/صورة/تمويه).';
  await stopScreenPreview();
  let cams = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cams = devices.filter((d) => d.kind === 'videoinput');
  } catch (_) {}
  sources = cams.map((c, i) => ({ id: c.deviceId, name: c.label || `كاميرا ${i + 1}`, kind: 'camera' }));
  sourceSelect.innerHTML = '';
  if (!sources.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'لا توجد كاميرا متاحة';
    sourceSelect.appendChild(opt);
    selectedSource = null; recordBtn.disabled = true;
    return;
  }
  populateSelect(sourceSelect, sources.map((s) => ({ id: s.id, label: s.name })));
  const prevId = selectedSource && selectedSource.id;
  const chosen = sources.find((s) => s.id === prevId) || sources[0];
  sourceSelect.value = chosen.id;
  selectSource(chosen.id);
}

// Shared start/status/error logic for both the full-frame camera-mode preview
// and the webcam-overlay preview below — they differ only in which device id
// they read from and whether the overlay preview box is toggled.
async function startCamProcessorPreview(deviceId, { showBox = false } = {}) {
  if (showBox) camPreviewBox.style.display = 'flex';
  camPreview.style.display = 'block';
  if (!showBox) previewPlaceholder.style.display = 'none';
  camStatus.textContent = 'جارٍ تشغيل الكاميرا…';
  try {
    await camProcessor.start(deviceId);
    camPreviewOn = true;
    camStatus.textContent = '';
    if (!camProcessor.blurAvailable) {
      // Background replacement needs segmentation; offer only "none" without it.
      bgPicker.classList.add('no-seg');
      camStatus.textContent = 'استبدال الخلفية غير متاح على هذا النظام';
    }
  } catch (err) {
    camStatus.textContent = 'خطأ في الكاميرا: ' + (err.message || err);
    console.warn('Camera preview failed:', err);
  }
}

// Start (or restart) the full-frame camera preview for camera-recording mode.
async function startCameraModePreview() {
  await startCamProcessorPreview(selectedSource ? selectedSource.id : undefined);
}

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
  populateSelect(micSelect, mics.map((m, i) => ({ id: m.deviceId, label: m.label || `ميكروفون ${i + 1}` })));
  if (!mics.length) {
    micEnabled.checked = false;
    micEnabled.disabled = true;
  }

  const cams = devices.filter((d) => d.kind === 'videoinput');
  populateSelect(camSelect, cams.map((c, i) => ({ id: c.deviceId, label: c.label || `كاميرا ${i + 1}` })));
  if (!cams.length) {
    camEnabled.checked = false;
    camEnabled.disabled = true;
    camSelect.disabled = true;
  }
}

// ---------------------------------------------------------------------------
// Microphone: robust capture + live level meter
// ---------------------------------------------------------------------------
// Open a mic stream, falling back to the default device if the saved deviceId is
// stale (a changed/removed device makes `deviceId: { exact }` throw and would
// otherwise silently record no audio).
async function getMicStream() {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  const id = micSelect.value;
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, ...base }, video: false });
    } catch (err) {
      console.warn('Mic (exact device) failed, retrying with default:', err.message);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
}

let micMonitorStream = null;
let micMonitorCtx = null;
let micMonitorRAF = 0;
let micMonitorToken = 0; // guards against overlapping async starts leaking contexts
function setMicLevel(l) {
  const pct = Math.round(Math.min(1, Math.max(0, l)) * 100);
  micMeterFill.style.width = pct + '%';
  micMeterFill.style.background = l < 0.55 ? 'var(--accent)' : l < 0.82 ? '#e0b341' : '#e0594b';
}
async function startMicMonitor() {
  stopMicMonitor();
  if (micEnabled.disabled || !micEnabled.checked) return;
  const token = ++micMonitorToken;
  let stream;
  try {
    stream = await getMicStream();
  } catch (err) {
    console.warn('Mic monitor failed:', err.message);
    return;
  }
  // A newer start (or a stop) happened while we awaited — discard this one.
  if (token !== micMonitorToken) { stream.getTracks().forEach((t) => t.stop()); return; }
  micMonitorStream = stream;
  const AC = window.AudioContext || window.webkitAudioContext;
  micMonitorCtx = new AC();
  const src = micMonitorCtx.createMediaStreamSource(micMonitorStream);
  const analyser = micMonitorCtx.createAnalyser();
  analyser.fftSize = MIC_METER_FFT_SIZE;
  src.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const loop = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    setMicLevel(Math.sqrt(sum / data.length) * MIC_METER_RMS_SCALE); // scale RMS for a lively bar
    micMonitorRAF = requestAnimationFrame(loop);
  };
  loop();
}
function stopMicMonitor() {
  micMonitorToken++; // invalidate any in-flight start
  if (micMonitorRAF) cancelAnimationFrame(micMonitorRAF);
  micMonitorRAF = 0;
  if (micMonitorStream) { micMonitorStream.getTracks().forEach((t) => t.stop()); micMonitorStream = null; }
  if (micMonitorCtx) { try { micMonitorCtx.close(); } catch (_) {} micMonitorCtx = null; }
  setMicLevel(0);
}
micEnabled.addEventListener('change', () => { if (micEnabled.checked) startMicMonitor(); else stopMicMonitor(); });
// Restart on device change whenever the mic is enabled (not only if already running).
micSelect.addEventListener('change', () => { if (micEnabled.checked && !micEnabled.disabled) startMicMonitor(); });

// ---------------------------------------------------------------------------
// Camera preview + blur
// ---------------------------------------------------------------------------
async function startCamPreview() {
  if (camEnabled.disabled) return;
  await startCamProcessorPreview(currentKind === 'camera' ? (selectedSource && selectedSource.id) : camSelect.value, { showBox: true });
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

// While the window is hidden (minimized / on another desktop), stop the live
// screen/camera previews and the mic meter so the app isn't continuously
// capturing in the background — backgroundThrottling is off, so nothing else
// throttles them. Recording is never touched: it owns an independent stream and
// stops the preview itself, and this guard bails while recording.
let hiddenPause = null;
// Bumped on every pause/resume so an in-flight async pause can detect that a
// resume superseded it and abort mid-teardown (otherwise its awaited stops would
// tear down previews the resume just restarted, leaving them dark).
let previewGen = 0;
async function pausePreviewsForHide() {
  if (recPhase !== 'idle' || hiddenPause) return;
  const gen = ++previewGen;
  hiddenPause = { screen: !!previewStream, cam: camPreviewOn, camMode: currentKind === 'camera', mic: !!micMonitorRAF };
  if (previewStream) { await stopScreenPreview(); if (gen !== previewGen) return; }
  if (camPreviewOn) { await camProcessor.stop(); camPreviewOn = false; if (gen !== previewGen) return; }
  stopMicMonitor();
}
function resumePreviewsAfterHide() {
  const snap = hiddenPause;
  hiddenPause = null;
  previewGen++; // supersede any in-flight pause
  if (!snap || recPhase !== 'idle') return;
  if (snap.cam && snap.camMode) startCameraModePreview();
  else {
    if (snap.screen && selectedSource) startScreenPreview(selectedSource);
    if (snap.cam) startCamPreview();
  }
  if (snap.mic && micEnabled.checked && !micEnabled.disabled) startMicMonitor();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pausePreviewsForHide();
  else resumePreviewsAfterHide();
});
// Window-focus changes catch the common case the Page Visibility API misses: the
// recorder left open behind the app the user is actually recording.
window.api.onWindowFocus((focused) => {
  if (focused) { if (!document.hidden) resumePreviewsAfterHide(); }
  else pausePreviewsForHide();
});

// ---------------------------------------------------------------------------
// Camera background picker (none / blur / color / gradient / uploaded image)
// ---------------------------------------------------------------------------
const BG_GRADIENTS = {
  sunset: ['#ff7e5f', '#feb47b'],
  ocean: ['#2193b0', '#6dd5ed'],
  forest: ['#134e5e', '#71b280'],
};
// Build a gradient background as an offscreen canvas (usable as an image source).
function makeGradientCanvas(stops) {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d').createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, stops[0]); g.addColorStop(1, stops[1]);
  const cx = c.getContext('2d'); cx.fillStyle = g; cx.fillRect(0, 0, c.width, c.height);
  return c;
}
// Current background selection, persisted so it survives restarts.
let bgState = { mode: 'none', color: '#1e293b', grad: null, imageData: null };

function highlightBgSwatch() {
  [...bgPicker.querySelectorAll('.bg-swatch')].forEach((el) => {
    const m = el.dataset.bg;
    let on = false;
    if (m === bgState.mode) {
      if (m === 'color') on = el.dataset.color === bgState.color;
      else if (m === 'grad') on = el.dataset.grad === bgState.grad;
      else on = true; // none / blur / upload
    }
    el.classList.toggle('selected', on);
  });
}

let bgImageToken = 0; // guards against a slow image load overwriting a newer pick
function applyBackgroundToProcessor() {
  const m = bgState.mode;
  if (m === 'blur') camProcessor.setBackground('blur');
  else if (m === 'color') camProcessor.setBackground('color', bgState.color);
  else if (m === 'grad' && BG_GRADIENTS[bgState.grad]) camProcessor.setBackground('image', makeGradientCanvas(BG_GRADIENTS[bgState.grad]));
  else if (m === 'image' && bgState.imageData) {
    const token = ++bgImageToken;
    const img = new Image();
    img.onload = () => { if (bgState.mode === 'image' && token === bgImageToken) camProcessor.setBackground('image', img); };
    img.src = bgState.imageData;
  } else camProcessor.setBackground('none');
  blurAmountWrap.style.display = m === 'blur' ? 'flex' : 'none';
  highlightBgSwatch();
}

function setBackground(mode, opts = {}) {
  bgState.mode = mode;
  if (mode === 'color') bgState.color = opts.color;
  if (mode === 'grad') bgState.grad = opts.grad;
  if (mode === 'image' && opts.imageData) bgState.imageData = opts.imageData;
  applyBackgroundToProcessor();
  // Persist the choice but NOT the (potentially multi-MB) uploaded image data —
  // that would bloat settings.json and slow startup. Uploads last the session.
  Prefs.set('bg', { mode: mode === 'image' ? 'none' : bgState.mode, color: bgState.color, grad: bgState.grad });
}

bgPicker.addEventListener('click', (e) => {
  const sw = e.target.closest('.bg-swatch');
  if (!sw) return;
  const bg = sw.dataset.bg;
  if (bg === 'upload') { bgFileInput.click(); return; }
  if (bg === 'color') setBackground('color', { color: sw.dataset.color });
  else if (bg === 'grad') setBackground('grad', { grad: sw.dataset.grad });
  else setBackground(bg); // 'none' | 'blur'
});

bgFileInput.addEventListener('change', () => {
  const file = bgFileInput.files && bgFileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => setBackground('image', { imageData: reader.result });
  reader.readAsDataURL(file);
  bgFileInput.value = '';
});

blurAmount.addEventListener('input', () => {
  blurAmountVal.textContent = blurAmount.value;
  camProcessor.setBlurAmount(parseInt(blurAmount.value, 10));
});

// ---------------------------------------------------------------------------
// Scenes (F1/F2/F3 switching while recording)
// ---------------------------------------------------------------------------
function updateScenesUI() {
  const on = scenesEnabled.checked;
  sceneStartWrap.style.display = on ? '' : 'none';
  sceneTransWrap.style.display = on ? 'flex' : 'none';
  scenesHint.style.display = on ? '' : 'none';
  // cam/both scenes need the webcam, so scene mode forces the camera on.
  if (on && !camEnabled.disabled && !camEnabled.checked) {
    camEnabled.checked = true;
    startCamPreview();
  }
}
scenesEnabled.addEventListener('change', () => { Prefs.set('scenes', scenesEnabled.checked); updateScenesUI(); });
sceneStart.addEventListener('change', () => Prefs.set('sceneStart', sceneStart.value));
sceneTrans.addEventListener('input', () => { sceneTransVal.textContent = sceneTrans.value; Prefs.set('sceneTrans', parseFloat(sceneTrans.value)); });

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
function resetRecordingUI() {
  recPhase = 'idle';
  recBanner.classList.remove('active');
  recordBtn.style.display = '';
  recordBtn.textContent = '● بدء التسجيل';
  recordBtn.disabled = !selectedSource;
  stopBtn.disabled = false;
  stopTimer();
  startMicMonitor(); // resume the level meter after a stopped/failed recording
}

// Stop every capture track and the region-crop loop, then clear the list.
function teardownStreams() {
  if (cropCtl) { try { cropCtl.stop(); } catch (_) {} cropCtl = null; }
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  // Remove the on-screen recording outline (no-op if none is showing).
  try { window.api.hideRecFrame(); } catch (_) {}
}

// desktopCapturer can only grab a whole screen, so to "record an area" we crop
// the chosen sub-rectangle out of every captured frame and record THAT stream.
// Two implementations (report finding #33): an off-main-thread WebCodecs path
// (MediaStreamTrackProcessor → OffscreenCanvas in a Worker → MediaStreamTrackGenerator)
// and the original main-thread canvas path. The worker path is self-validating:
// if it doesn't emit a first frame quickly (API missing / unsupported / broken),
// we tear it down and fall back, so region recording can never silently break.
async function startRegionCrop(fullStream, display, region, fps, outSize) {
  const track = fullStream.getVideoTracks()[0];
  const settings = track && track.getSettings ? track.getSettings() : {};
  if (track && typeof track.clone === 'function'
      && canOffloadRegionCrop() && settings.width && settings.height) {
    const rect = computeCropRect(display, region, settings.width, settings.height, outSize);
    // Consume a CLONE in the worker: a track can't feed two MediaStreamTrackProcessors,
    // so cloning leaves the original pristine for the main-thread fallback below.
    const workTrack = track.clone();
    try {
      return await startRegionCropWorker(workTrack, rect, fps);
    } catch (err) {
      console.warn('Region-crop worker offload unavailable — using main thread:', err.message);
      try { workTrack.stop(); } catch (_) {}
      // fall through to the main-thread path
    }
  }
  return startRegionCropMainThread(fullStream, display, region, fps, outSize);
}

function canOffloadRegionCrop() {
  return typeof MediaStreamTrackProcessor !== 'undefined'
    && typeof MediaStreamTrackGenerator !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof VideoFrame !== 'undefined';
}

// Map a DIP region on `display` to even-sized crop + output pixel rects, given
// the captured frame's real pixel dimensions. Shared by both crop paths so the
// worker and canvas implementations can never drift apart.
function computeCropRect(display, region, capW, capH, outSize) {
  const b = display.bounds;
  const sx = capW / b.width;
  const sy = capH / b.height;
  const cx = Math.max(0, Math.round(region.x * sx));
  const cy = Math.max(0, Math.round(region.y * sy));
  // Keep the crop inside the frame and even-sized (friendlier for encoders).
  const cw = Math.max(2, Math.min(Math.round(region.w * sx), capW - cx)) & ~1;
  const ch = Math.max(2, Math.min(Math.round(region.h * sy), capH - cy)) & ~1;
  // Without a target size the output matches the native crop; a platform format
  // scales it to that format's standard resolution instead. Keep dims even-sized.
  const outW = outSize ? (Math.max(2, Math.round(outSize.w)) & ~1) : cw;
  const outH = outSize ? (Math.max(2, Math.round(outSize.h)) & ~1) : ch;
  return { cx, cy, cw, ch, outW, outH };
}

// Off-main-thread crop. Resolves with the output MediaStream ONLY after the
// worker confirms it produced a first frame — so a silently-broken pipeline
// rejects (and the caller falls back) rather than yielding a black recording.
function startRegionCropWorker(workTrack, rect, fps) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker = null;
    let processor, generator;
    try {
      processor = new MediaStreamTrackProcessor({ track: workTrack });
      generator = new MediaStreamTrackGenerator({ kind: 'video' });
      worker = new Worker('region-crop-worker.js');
    } catch (err) {
      try { if (worker) worker.terminate(); } catch (_) {}
      reject(err);
      return;
    }
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (_) {}
      reject(new Error(msg));
    };
    // If no frame flows shortly, the pipeline isn't working — fall back.
    const timer = setTimeout(() => fail('no frames from crop worker'), 2500);
    worker.onmessage = (e) => {
      if (e.data !== 'firstframe' || settled) return;
      settled = true;
      clearTimeout(timer);
      cropCtl = {
        stop() {
          try { worker.postMessage({ type: 'stop' }); } catch (_) {}
          try { worker.terminate(); } catch (_) {}
          try { workTrack.stop(); } catch (_) {}
        },
      };
      resolve(new MediaStream([generator]));
    };
    worker.onerror = (e) => fail('crop worker error: ' + (e.message || 'unknown'));
    // Transfer the stream endpoints into the worker (unusable here afterwards).
    worker.postMessage(
      { readable: processor.readable, writable: generator.writable, ...rect },
      [processor.readable, generator.writable],
    );
  });
}

// Original main-thread crop: draw the chosen sub-rectangle of a hidden <video>
// onto a canvas every frame and record the canvas stream. Fallback for when the
// worker offload above is unavailable.
async function startRegionCropMainThread(fullStream, display, region, fps, outSize) {
  const srcVideo = document.createElement('video');
  srcVideo.srcObject = fullStream;
  srcVideo.muted = true;
  srcVideo.playsInline = true;
  await srcVideo.play();
  if (!srcVideo.videoWidth) {
    await new Promise((res) => srcVideo.addEventListener('loadedmetadata', res, { once: true }));
  }

  const { cx, cy, cw, ch, outW, outH } =
    computeCropRect(display, region, srcVideo.videoWidth, srcVideo.videoHeight, outSize);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const cctx = canvas.getContext('2d', { alpha: false });

  let raf = 0;
  let stopped = false;
  // rAF fires at the monitor's refresh rate (often 60Hz). Throttle the redraw to
  // the requested fps so we don't burn CPU compositing frames the encoder will
  // never use — a real saving on low-spec machines recording at 30fps.
  const minInterval = 1000 / (fps + FPS_THROTTLE_TOLERANCE);
  let last = -Infinity;
  const draw = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(draw);
    if (now - last < minInterval) return;
    last = now;
    cctx.drawImage(srcVideo, cx, cy, cw, ch, 0, 0, outW, outH);
  };
  raf = requestAnimationFrame(draw);

  cropCtl = {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      try { srcVideo.pause(); srcVideo.srcObject = null; } catch (_) {}
    },
  };
  return canvas.captureStream(fps);
}

// Record the processed camera canvas (with its background) as the main video.
async function startCameraRecording() {
  const fps = parseInt(fpsSelect.value, 10);
  const preset = currentPreset();
  const useMic = micEnabled.checked && !micEnabled.disabled;
  let recBaseEpoch;
  try {
    // No cursor tracking / region / scenes in camera mode; main defaults display.
    ({ recBaseEpoch } = await window.api.startRecording({ display: null, kind: 'camera', region: null }));

    if (!camPreviewOn) await startCameraModePreview();
    const camStream = camProcessor.recordStream(fps);
    // Canvas stream is tracked for teardown; the raw webcam stream is owned by
    // camProcessor (stopping it here would kill its preview).
    if (camStream !== camProcessor.rawStream) streams.push(camStream);
    const tracks = [...camStream.getVideoTracks()];

    stopMicMonitor();
    let hasAudio = false;
    if (useMic) {
      try {
        const audioStream = await getMicStream();
        streams.push(audioStream);
        tracks.push(...audioStream.getAudioTracks());
        hasAudio = audioStream.getAudioTracks().length > 0;
      } catch (err) {
        console.warn('Mic capture failed:', err.message);
        topStatus.textContent = 'تعذّر التقاط الميكروفون — سيُسجَّل بلا صوت.';
      }
    }

    writeQueue = Promise.resolve();
    writeFailed = false;
    const combined = new MediaStream(tracks);
    const vs = camStream.getVideoTracks()[0]?.getSettings?.() || {};
    const { mime, bitrate } = pickVideoConfig(preset, fps, vs.width || 1280, vs.height || 720, hasAudio);
    mediaRecorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: bitrate });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) queueChunk(e.data, 'video'); };
    mediaRecorder.onstop = onRecordingStopped;
    mediaRecorder.onerror = (e) => {
      console.error('MediaRecorder error:', e.error || e);
      topStatus.textContent = 'خطأ في التسجيل — توقّف الترميز. سيُحفَظ الجزء المُسجَّل حتى الآن.';
      stopRecording();
    };
    camStopped = Promise.resolve(); // no separate cam file in camera mode
    mediaRecorder.start(MEDIARECORDER_TIMESLICE_MS);

    recState = { display: null, recBaseEpoch, hasAudio, hasCam: false };
    recPhase = 'recording';
    recBanner.classList.add('active');
    recordBtn.style.display = 'none';
    recordBtn.textContent = '● جارٍ التسجيل…';
    startTimer(recBaseEpoch);
  } catch (err) {
    console.error('Failed to start camera recording:', err);
    try { await window.api.abortRecording(); } catch (_) {}
    teardownStreams();
    mediaRecorder = null;
    topStatus.textContent = 'تعذّر بدء التسجيل: ' + (err.message || err);
    resetRecordingUI();
  }
}

async function startRecording() {
  // Only a fully idle session may start — this also blocks a second click (or
  // repeated hotkey) landing during the async "arming" window before isRecording
  // used to flip true, which used to reach window.api.startRecording twice.
  if (!selectedSource || recPhase !== 'idle') return;
  recordBtn.disabled = true;
  recPhase = 'arming'; // block preview-pause (and a second start) during setup

  // Camera mode records the processed camera canvas directly (no screen capture).
  if (currentKind === 'camera') return startCameraRecording();

  // macOS gates screen capture: bail with a helpful dialog instead of silently
  // recording a black screen. (No-op / always ok on Windows.)
  const perm = await window.api.ensureScreenPermission();
  if (!perm.ok) {
    recPhase = 'idle';
    topStatus.textContent = 'فعّل تسجيل الشاشة من إعدادات النظام، ثم أغلق التطبيق وأعد فتحه.';
    recordBtn.disabled = !selectedSource;
    return;
  }

  const display = selectedSource.display;
  const kind = selectedSource.kind || 'screen';
  const fps = parseInt(fpsSelect.value, 10);
  const preset = currentPreset();
  const useMic = micEnabled.checked && !micEnabled.disabled;
  // Region recording only applies to full-screen sources. effectiveRegion()
  // returns null for windows and, for a platform format with no manual region,
  // auto-fits the largest box of that aspect to the display.
  const fmt = currentFormat();
  const region = effectiveRegion();
  // Scale the cropped region to the platform's standard resolution (e.g.
  // 1920×1080) so the saved file matches what YouTube/LinkedIn expect.
  const outSize = region ? fmt.out : null;

  // Scene mode needs the webcam actually on (cam/both scenes would be black
  // otherwise), so require it to be enabled and available.
  const sceneMode = scenesEnabled.checked && camEnabled.checked && !camEnabled.disabled;
  const scene = sceneMode ? sceneStart.value : null;
  const transition = sceneMode ? parseFloat(sceneTrans.value) || 0 : 0;

  let recBaseEpoch;
  try {
    // Tell main to begin cursor tracking; it returns the time base.
    ({ recBaseEpoch } = await window.api.startRecording({ display, kind, region, scene, transition }));

    // Stop the live preview so we don't capture the screen twice at once
    // (that can drop frames in the actual recording).
    await stopScreenPreview();
    previewPlaceholder.textContent = '● جارٍ التسجيل…';

    // Capture the screen via the desktop source id.
    const fullStream = await navigator.mediaDevices.getUserMedia({
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
    streams.push(fullStream);
    // The OS can revoke screen-recording permission mid-session, the user can
    // close the shared window, or a display can disconnect — any of these ends
    // the captured track without MediaRecorder itself erroring, so the recording
    // would otherwise freeze silently on the last frame. (track.stop() during our
    // own teardown does NOT fire 'ended', so this only fires on a real revocation.)
    fullStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (recPhase !== 'recording') return;
      console.warn('Capture track ended unexpectedly (permission revoked / source closed)');
      topStatus.textContent = 'توقّف التقاط الشاشة (سُحب الإذن أو أُغلق المصدر) — يُحفَظ التسجيل حتى الآن.';
      stopRecording();
    }, { once: true });

    // When a sub-region is selected, record a canvas cropped to it instead of
    // the whole screen, so the saved file contains only the chosen area.
    let captureStream = fullStream;
    if (region) {
      captureStream = await startRegionCrop(fullStream, display, region, fps, outSize);
      streams.push(captureStream);
    }

    const tracks = [...captureStream.getVideoTracks()];

    // The live meter holds the mic device; release it so recording capture (with
    // its own constraints) isn't blocked by device contention.
    stopMicMonitor();

    let hasAudio = false;
    if (useMic) {
      try {
        const audioStream = await getMicStream(); // falls back to default if saved device is gone
        streams.push(audioStream);
        tracks.push(...audioStream.getAudioTracks());
        hasAudio = audioStream.getAudioTracks().length > 0;
      } catch (err) {
        console.warn('Mic capture failed:', err.message);
        topStatus.textContent = 'تعذّر التقاط الميكروفون — سيُسجَّل الفيديو بلا صوت. تحقّق من إذن الميكروفون واختيار الجهاز.';
      }
    }

    // Optional webcam — captured from the live (optionally blurred) preview
    // canvas and streamed to its own file, composited in the editor.
    let hasCam = false;
    const useCam = camEnabled.checked && !camEnabled.disabled;
    writeQueue = Promise.resolve();
    writeFailed = false;
    if (useCam) {
      try {
        if (!camPreviewOn) await startCamPreview();
        // Same fps as the screen recorder — this used to be hardcoded to 30
        // regardless of the user's selection, causing a fps mismatch between
        // the two capture modes.
        const camStream = camProcessor.recordStream(fps);
        // Only track (and thus tear down) the canvas stream. The raw webcam
        // stream is owned by camProcessor — stopping it here would kill its live
        // preview; camProcessor.stop() releases it.
        if (camStream !== camProcessor.rawStream) streams.push(camStream);
        // Webcam runs a second concurrent encoder — let it follow the same
        // preset so "performance" mode lightens this too (VP8 + lower bitrate).
        const camTrack = camStream.getVideoTracks()[0]?.getSettings?.() || {};
        const camCfg = pickVideoConfig(
          preset, fps, camTrack.width || 1280, camTrack.height || 720, false);
        camRecorder = new MediaRecorder(camStream, {
          mimeType: camCfg.mime, videoBitsPerSecond: camCfg.bitrate });
        camRecorder.ondataavailable = (e) => {
          if (e.data.size) queueChunk(e.data, 'cam');
        };
        camRecorder.onerror = (e) => {
          // The webcam encoder failed. From here on we can't produce a valid cam
          // track, and a truncated .cam.webm left on disk would be treated by the
          // editor as a COMPLETE camera track (freezing on its last frame under
          // the full-length screen). Honor the "continue without camera" message
          // literally: drop the partial cam on the main side so the finished
          // recording is cleanly screen-only, and clear hasCam here + on recState
          // (captured by value below) so onRecordingStopped doesn't wait on a cam
          // recorder that has already gone inactive.
          console.error('Webcam MediaRecorder error:', e.error || e);
          topStatus.textContent = 'خطأ في تسجيل الكاميرا — سيتابع تسجيل الشاشة بلا كاميرا.';
          hasCam = false;
          if (recState) recState.hasCam = false;
          try { if (camRecorder.state !== 'inactive') camRecorder.stop(); } catch (_) {}
          window.api.dropCam().catch(() => {});
        };
        hasCam = true;
      } catch (err) {
        console.warn('Webcam capture failed:', err.message);
      }
    }

    const combined = new MediaStream(tracks);
    // Derive bitrate from the real capture size so the encoder isn't overworked
    // on small captures. Track settings are most accurate; fall back to the
    // display's pixel bounds if the platform doesn't report them.
    const vs = captureStream.getVideoTracks()[0]?.getSettings?.() || {};
    const capW = vs.width || Math.round(display.bounds.width * (display.scaleFactor || 1));
    const capH = vs.height || Math.round(display.bounds.height * (display.scaleFactor || 1));
    const { mime, bitrate } = pickVideoConfig(preset, fps, capW, capH, hasAudio);
    mediaRecorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: bitrate });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) queueChunk(e.data, 'video');
    };
    mediaRecorder.onstop = onRecordingStopped;
    mediaRecorder.onerror = (e) => {
      // The encoder itself failed (codec error, resource exhaustion, ...) — the
      // timer/UI would otherwise keep looking like recording is still happening
      // while no more data is produced.
      //
      // Per the MediaRecorder spec the recorder is ALREADY 'inactive' by the time
      // this fires, and it queues its own 'stop' event — so mediaRecorder.onstop
      // (= onRecordingStopped) still runs and flushes whatever reached disk. That
      // means stopRecording() would be a no-op here: its `state !== 'inactive'`
      // guard is already false. Do directly the one thing its body still needs to
      // do — leave 'recording' and stop the paired cam recorder — otherwise
      // onRecordingStopped would `await camStopped` forever (camStopped only
      // resolves once camRecorder.stop() is called).
      console.error('MediaRecorder error:', e.error || e);
      topStatus.textContent = 'خطأ في التسجيل — توقّف الترميز. سيُحفَظ الجزء المُسجَّل حتى الآن.';
      if (recPhase === 'recording') {
        recPhase = 'stopping';
        stopBtn.disabled = true;
        if (camRecorder && camRecorder.state !== 'inactive') camRecorder.stop();
      }
    };

    // Start cam first, then screen, as close together as possible.
    camStopped = camRecorder ? new Promise((res) => { camRecorder.onstop = res; }) : Promise.resolve();
    if (camRecorder) camRecorder.start(MEDIARECORDER_TIMESLICE_MS);
    mediaRecorder.start(MEDIARECORDER_TIMESLICE_MS);

    recState = { display, recBaseEpoch, hasAudio, hasCam };
    recPhase = 'recording';

    recBanner.classList.add('active');
    recordBtn.style.display = 'none'; // the live indicator + stop take over while recording
    recordBtn.textContent = '● جارٍ التسجيل…';
    startTimer(recBaseEpoch);

    // Draw the click-through outline around the captured area so the user can
    // see what's being recorded. Only meaningful for region/format captures.
    if (region) {
      try { await window.api.showRecFrame({ display, region }); } catch (_) {}
    }
  } catch (err) {
    // Capture failed or was cancelled — clean up so nothing is left running.
    console.error('Failed to start recording:', err);
    try { await window.api.abortRecording(); } catch (_) {}
    teardownStreams();
    mediaRecorder = null;
    camRecorder = null;
    topStatus.textContent = 'تعذّر بدء التسجيل: ' + (err.message || err);
    resetRecordingUI();
    if (selectedSource) startScreenPreview(selectedSource); // bring the preview back
  }
}

async function onRecordingStopped() {
  stopTimer();
  topStatus.textContent = 'جارٍ حفظ التسجيل…';
  try {
    if (recState.hasCam) await camStopped; // wait for the webcam recorder to flush
    await writeQueue; // the chunk-write chain — awaiting the tail waits for all of it

    await window.api.finishRecording({ hasAudio: recState.hasAudio });

    teardownStreams();

    topStatus.textContent = 'جارٍ فتح المحرر…';
    await window.api.openEditor();
  } catch (err) {
    console.error('Failed to save recording:', err);
    try { await window.api.abortRecording(); } catch (_) {}
    teardownStreams();
    topStatus.textContent = 'تعذّر حفظ التسجيل: ' + (err.message || err);
    resetRecordingUI();
    if (selectedSource) startScreenPreview(selectedSource);
  }
}

function stopRecording() {
  // Only a live recording can be stopped. Moving to 'stopping' synchronously
  // (rather than clearing a lone isRecording flag) means a hotkey/click landing
  // in the async gap before onRecordingStopped's flush completes is ignored
  // instead of racing a new recording against this one's teardown.
  if (recPhase === 'recording' && mediaRecorder && mediaRecorder.state !== 'inactive') {
    recPhase = 'stopping';
    stopBtn.disabled = true;
    if (camRecorder && camRecorder.state !== 'inactive') camRecorder.stop();
    mediaRecorder.stop();
  }
}

// Toggle used by the global keyboard shortcut.
function toggleRecord() {
  if (recPhase === 'recording') {
    stopRecording();
    return;
  }
  if (recPhase !== 'idle') return; // arming/stopping — ignore a repeat press
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
  }, MEDIARECORDER_TIMESLICE_MS);
}
function stopTimer() {
  if (timerInt) clearInterval(timerInt);
  timerInt = null;
}

// ---------------------------------------------------------------------------
recordBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// Keyboard-shortcuts reference modal.
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

// Open the studio with a blank timeline to import and edit existing videos.
const openStudioBtn = document.getElementById('openStudioBtn');
if (openStudioBtn) {
  openStudioBtn.addEventListener('click', async () => {
    topStatus.textContent = 'جارٍ فتح الاستوديو…';
    await window.api.openStudio();
  });
}

// Open a saved .ssproj project — the main process swaps to the editor and
// restores the timeline. Reports missing media if any referenced file moved.
const openProjectBtn = document.getElementById('openProjectBtn');
if (openProjectBtn) {
  openProjectBtn.addEventListener('click', async () => {
    topStatus.textContent = 'جارٍ فتح المشروع…';
    try {
      const res = await window.api.openProject();
      if (res && res.canceled) { topStatus.textContent = ''; return; }
      if (res && res.error) { topStatus.textContent = res.error; return; }
    } catch (err) {
      topStatus.textContent = 'تعذّر فتح المشروع: ' + (err.message || err);
    }
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
    const when = new Date(it.mtime).toLocaleString('ar');
    const el = document.createElement('div');
    el.className = 'rec-item';

    // Built with textContent (not innerHTML) so a filename containing
    // `<`/`>`/`"` can't inject markup into the library view.
    const info = document.createElement('div');
    info.className = 'rec-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'rec-name';
    nameEl.textContent = it.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'rec-meta';
    metaEl.textContent = `${when} · ${it.sizeMB} م.ب`;
    info.append(nameEl, metaEl);
    el.appendChild(info);

    if (it.hasCam) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'كاميرا';
      el.appendChild(badge);
    }

    const revealBtn = document.createElement('button');
    revealBtn.className = 'btn-ghost reveal';
    revealBtn.textContent = 'عرض الملف';
    revealBtn.addEventListener('click', () => window.api.revealFile(it.videoPath));

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-primary edit';
    editBtn.textContent = 'تعديل';
    editBtn.addEventListener('click', async () => {
      topStatus.textContent = 'جارٍ فتح المحرر…';
      await window.api.openRecording(it.videoPath);
    });

    el.append(revealBtn, editBtn);
    library.appendChild(el);
  });
}

// Apply saved preferences to the home-screen controls and persist on change.
function applyHomePrefs() {
  fpsSelect.value = String(Prefs.get('fps', fpsSelect.value));
  qualitySelect.value = Prefs.get('quality', qualitySelect.value);
  formatSelect.value = Prefs.get('format', formatSelect.value);
  updateAreaUI(); // reflect the restored format in the region preview
  renderPerfGuide();
  if (!micEnabled.disabled) micEnabled.checked = Prefs.get('micEnabled', true);

  const md = Prefs.get('micDevice');
  if (md && [...micSelect.options].some((o) => o.value === md)) micSelect.value = md;
  const cd = Prefs.get('camDevice');
  if (cd && [...camSelect.options].some((o) => o.value === cd)) camSelect.value = cd;

  blurAmount.value = Prefs.get('blurAmount', 12);
  blurAmountVal.textContent = blurAmount.value;
  camProcessor.setBlurAmount(parseInt(blurAmount.value, 10));

  // Restore the saved camera background; migrate the old boolean blur pref.
  const savedBg = Prefs.get('bg', null);
  if (savedBg && savedBg.mode) bgState = Object.assign(bgState, savedBg);
  else if (Prefs.get('blur', false)) bgState.mode = 'blur';
  applyBackgroundToProcessor();

  if (!camEnabled.disabled) camEnabled.checked = Prefs.get('camEnabled', false);
  // In camera mode the camera is already the main preview; don't also start the overlay.
  if (currentKind !== 'camera' && camEnabled.checked) startCamPreview();

  scenesEnabled.checked = Prefs.get('scenes', false);
  sceneStart.value = Prefs.get('sceneStart', 'both');
  sceneTrans.value = String(Prefs.get('sceneTrans', 0.3));
  sceneTransVal.textContent = sceneTrans.value;
  updateScenesUI();

  // Persist on change (these add to existing handlers).
  fpsSelect.addEventListener('change', () => { Prefs.set('fps', fpsSelect.value); renderPerfGuide(); });
  qualitySelect.addEventListener('change', () => { Prefs.set('quality', qualitySelect.value); renderPerfGuide(); });
  micEnabled.addEventListener('change', () => Prefs.set('micEnabled', micEnabled.checked));
  micSelect.addEventListener('change', () => Prefs.set('micDevice', micSelect.value));
  camEnabled.addEventListener('change', () => Prefs.set('camEnabled', camEnabled.checked));
  camSelect.addEventListener('change', () => Prefs.set('camDevice', camSelect.value));
  blurAmount.addEventListener('input', () => Prefs.set('blurAmount', parseInt(blurAmount.value, 10)));
}

(async function init() {
  await Prefs.load();
  currentKind = Prefs.get('sourceKind', 'screen');
  setTabSelected(currentKind);
  updateModeUI();

  // Surface a missing Screen Recording grant as soon as the app opens: show the
  // persistent banner and, if denied, pop the native "Open System Settings"
  // dialog once. (No-op on Windows/Linux.)
  if (await refreshScreenPermission()) {
    window.api.ensureScreenPermission();
  }

  // Devices + segmentation model must be ready BEFORE loading sources, so camera
  // mode has real device labels and background replacement works on first paint.
  await loadDevices();
  await camProcessor.init(); // preload the blur/segmentation model (no-op if unavailable)
  await loadSources();
  applyHomePrefs();
  startMicMonitor(); // show the live mic level so the user can confirm input
  await loadLibrary();
})();
