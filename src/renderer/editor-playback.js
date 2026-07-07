'use strict';

// editor-playback.js — part of the editor.js module split (see editor.html for load order).
// Init + the playback engine: loading a recording/studio session, per-source media element setup, the render loop, scene/zoom/click-fx compositing, and play/pause.

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
  echoLevel.disabled = !recHasAudio; // echo removal only applies to the mic track
  if (!recHasAudio) {
    noiseProfile.value = 'off';
    echoLevel.value = 'off';
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
    // The recording is a fresh MediaRecorder webm, which reports Infinity duration
    // until the seek-past-end trick resolves it. This is the CRITICAL path: unlike
    // an import (where a slow file timing out to 0 just drops one clip), a 0 here
    // makes the single clip below zero-length — an empty, unusable editor for an
    // otherwise-intact recording. So give it a generous bound (a long/4K capture on
    // a busy disk can exceed the default), not the short one imports use.
    src.duration = await resolveMediaDuration(video, REC_DURATION_TIMEOUT_MS);
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

  // If the editor was opened from a saved project, rebuild its timeline now
  // (after the recording — if any — is set up). This restores clips, blocks,
  // tracks and settings, so it must run before the audio preview reads them.
  await applyPendingProject();

  // Prepare the cleaned-audio preview in the background for the current settings.
  if (recHasAudio && (noiseProfile.value !== 'off' || echoLevel.value !== 'off')) applyAudioPreview();
}

function setCanvasSize(w, h) {
  canvas.width = w || 1920;
  canvas.height = h || 1080;
  // transCanvas/sceneTransCanvas are NOT sized here — see ensureCanvasMatchesSize.
}

// transCanvas/sceneTransCanvas each snapshot one frame for clip-transition /
// scene-crossfade compositing. Not every project uses transitions or scene
// mode, so they're sized lazily — right before the first snapshot that actually
// needs them — instead of unconditionally allocated at full canvas resolution
// whenever the canvas is (re)sized. At 4K that's ~95MB of retained backing
// store for a feature that may never fire in a given session.
function ensureCanvasMatchesSize(cv) {
  if (cv.width !== canvas.width || cv.height !== canvas.height) {
    cv.width = canvas.width;
    cv.height = canvas.height;
  }
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

// Force the browser to index a media element's real duration by seeking past
// the end and waiting for `durationchange` (webm/opus/mkv often report Infinity
// until this trick is used). `timeoutMs` bounds the worst case (the event never
// fires) so a caller can never hang forever waiting on a file that won't resolve
// a finite duration. Always removes its listener (on the timeout path too) and
// resets currentTime to 0 so the element is parked at the start afterward.
// One implementation shared by every duration-resolving call site in this file
// (recording, cam, imports, audio) instead of four near-identical copies.
function resolveMediaDuration(el, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (isFinite(el.duration) && el.duration > 0) return resolve(el.duration);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('durationchange', onDur);
      // Prefer the metadata duration. If it never resolved (still Infinity even
      // after seeking past the end), fall back to the seekable range — the seek
      // to 1e6 below clamps `seekable.end` to the media's real end, so this
      // recovers a usable duration instead of reporting 0 for an intact file.
      let d = isFinite(el.duration) ? el.duration : 0;
      if (!(d > 0)) {
        try {
          if (el.seekable && el.seekable.length) {
            const end = el.seekable.end(el.seekable.length - 1);
            if (isFinite(end) && end > 0) d = end;
          }
        } catch (_) {}
      }
      try { el.currentTime = 0; } catch (_) {}
      resolve(isFinite(d) && d > 0 ? d : 0);
    };
    const onDur = () => { if (isFinite(el.duration)) finish(); };
    el.addEventListener('durationchange', onDur);
    el.currentTime = 1e6;
    setTimeout(finish, timeoutMs);
  });
}

// Pick videos via the main process, append one clip per file to the timeline.
let importingVideos = false; // re-entrancy guard — the loop below awaits per-file
// metadata, so a second click mid-import would otherwise interleave two loops
// mutating `sources`/`clips` concurrently.
async function importVideos() {
  if (exporting || importingVideos) return;
  importingVideos = true;
  try {
    return await importVideosInner();
  } finally {
    importingVideos = false;
  }
}

async function importVideosInner() {
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
  let historyPushed = false; // only commit an undo entry once a file actually imports
  let added = 0;
  for (const item of list) {
    const el = await createSourceEl(item.url);
    if (!el.videoWidth) continue; // unreadable file
    const dur = await resolveMediaDuration(el);
    if (!dur) continue;
    if (!historyPushed) { pushHistory(); historyPushed = true; }
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
// Cover-fit ("center-crop") rectangle: scales (vw×vh) up to fully cover a
// (W×H) box, centered — shared by drawElementCover and drawCamFull below,
// which used to compute this same formula independently. (drawCam's circular
// PiP crop is a genuinely different square center-crop and isn't part of this.)
function coverFitRect(vw, vh, W, H) {
  const cover = Math.max(W / vw, H / vh);
  const dw = vw * cover, dh = vh * cover;
  return { dw, dh, dx: (W - dw) / 2, dy: (H - dh) / 2 };
}

function drawElementCover(el) {
  const W = canvas.width, H = canvas.height, vw = el.videoWidth, vh = el.videoHeight;
  if (!vw || !vh) return;
  const { dw, dh, dx, dy } = coverFitRect(vw, vh, W, H);
  ctx.drawImage(el, 0, 0, vw, vh, dx, dy, dw, dh);
}

// Shared track-lane operations, parameterized by which kind of lane (overlay
// video vs. audio) — these were previously duplicated almost verbatim between
// an overlay-specific and an audio-specific copy. The two lane KINDS still keep
// their own tracks array, selection state and DOM containers (video drawing vs.
// audio-only playback, above vs. below the main track differ enough that
// unifying those too isn't worth the risk); only the pure per-clip-element
// bookkeeping is shared here.
function elForClip(elCache, c, makeEl) {
  let el = elCache.get(c.id);
  if (!el) {
    const s = sourceById(c.sourceId);
    if (!s || !s.url) return null;
    el = makeEl(s.url);
    elCache.set(c.id, el);
  }
  return el;
}

// Drop elements whose clip no longer exists in `tracks` (called after each
// rebuild). `onDrop(el)` does the kind-specific teardown.
function pruneEls(elCache, tracks, onDrop) {
  const ids = new Set(tracks.flatMap((t) => t.clips).map((c) => c.id));
  elCache.forEach((el, id) => {
    if (!ids.has(id)) { onDrop(el); elCache.delete(id); }
  });
}

function pauseEls(elCache) { elCache.forEach((el) => { if (!el.paused) el.pause(); }); }

// The dedicated hidden <video> for an overlay clip (created on first use).
function overlayElFor(c) {
  return elForClip(overlayEls, c, (url) => {
    const el = document.createElement('video');
    el.src = url;
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  });
}

// Drop overlay elements whose clip no longer exists (called after each rebuild).
function pruneOverlayEls() {
  pruneEls(overlayEls, overlayTracks, (el) => { try { el.pause(); el.remove(); } catch (_) {} });
}

function pauseOverlayEls() { pauseEls(overlayEls); }

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
        waitForSeeked(el).then(() => {
          if (!playing && !capturing) { drawAt(video.currentTime); drawOverlays(te); }
        });
      }
    }
  });
  overlayEls.forEach((el) => { if (!active.has(el) && !el.paused) el.pause(); });
}

// Any source feeding the main timeline that carries an audio track? Governs
// whether the auto-remove-silence controls are useful (works for a recording's
// mic OR any imported clip's audio).
function timelineHasAudio() {
  return clips.some((c) => { const s = sourceById(c.sourceId); return !!(s && s.hasAudio); });
}

// Show the remove-silence controls whenever the timeline has any audio to cut.
function updateSilenceAvailability() {
  silenceGroup.style.display = timelineHasAudio() ? '' : 'none';
}

// Toggle the "import to begin" overlay + export availability for an empty studio.
function updateEmptyState() {
  updateSilenceAvailability();
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

  // Auto remove-silence: applies to any audio-bearing clip (recorded or imported).
  silenceSens.value = String(Prefs.get('silenceSens', 3));
  silenceSensVal.textContent = SILENCE_SENS_LABELS[silenceSens.value] || 'متوسطة';
  silenceGap.value = String(Prefs.get('silenceGap', 0.4));
  silenceGapVal.textContent = parseFloat(silenceGap.value).toFixed(1);
  updateSilenceAvailability();

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

  // Echo/reverb removal toggle.
  echoLevel.value = Prefs.get('echoLevel', 'off');

  // Persist on change.
  noiseProfile.addEventListener('change', () => {
    Prefs.set('noiseProfile', noiseProfile.value);
    applyAudioPreview();
    markDirty();
  });
  echoLevel.addEventListener('change', () => {
    Prefs.set('echoLevel', echoLevel.value);
    applyAudioPreview();
    markDirty();
  });
  smoothRamp.addEventListener('input', () => Prefs.set('smooth', parseFloat(smoothRamp.value)));
  clickFx.addEventListener('change', () => Prefs.set('clickFx', clickFx.checked));
  clickStyle.addEventListener('change', () => Prefs.set('clickStyle', clickStyle.value));
  clickColor.addEventListener('input', () => Prefs.set('clickColor', clickColor.value));
  clickSize.addEventListener('input', () => Prefs.set('clickSize', parseInt(clickSize.value, 10)));
  clickSound.addEventListener('change', () => { Prefs.set('clickSound', clickSound.checked); markDirty(); });
  clickSoundName.addEventListener('change', () => { Prefs.set('clickSoundName', clickSoundName.value); markDirty(); });
  clickVol.addEventListener('input', () => { Prefs.set('clickVol', parseInt(clickVol.value, 10)); markDirty(); });
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
    // The webcam file (MediaRecorder webm) ships with no duration in its header,
    // so the browser can't seek it accurately — big jumps (e.g. across a cut)
    // land wrong or hang, freezing the cam mid-export. Force the same index-by-
    // seeking-to-the-end trick the main recording uses so every seek is reliable.
    // `durationchange` normally fires within ~100ms of the end-seek; 1200ms
    // bounds the worst case (event never fires) so editor load can't stall long.
    await resolveMediaDuration(camVideo, 1200);
  }
}

// The webcam is a SEPARATE MediaRecorder stream: it spans the same real interval
// as the screen recording but usually a slightly different FILE duration (each
// stream is independently variable-frame-rate). Mapping a recording source time
// straight onto the cam (camVideo.currentTime = screenTime) therefore lands at the
// wrong real moment, and the error grows with time. That reads as a slow drift on
// an uncut clip, but remove-silence's many hard cuts re-expose it as a visible
// jump at every seam — the face stops matching the voice. Scale by the duration
// ratio so the cam tracks the screen's real time. Ratio is 1 (a no-op) when the
// durations match or the cam duration isn't known yet.
function camDurRatio() {
  const rec = recording ? sourceById(recording.id) : null;
  const recDur = rec && rec.duration ? rec.duration : 0;
  const camDur = camVideo.duration;
  if (recDur > 0 && isFinite(camDur) && camDur > 0) return camDur / recDur;
  return 1;
}
// Recording source time -> cam file time, clamped to the cam's duration.
function camTimeFor(srcT) {
  const t = srcT * camDurRatio();
  const camDur = camVideo.duration;
  return isFinite(camDur) && camDur > 0 ? Math.min(t, camDur) : t;
}

// Resolve once `el`'s NEXT 'seeked' event fires, or after `timeoutMs` (if
// given) as a safety fallback in case it never does. The passive half of the
// "wait for an async seek to land" pattern — for a caller that changes
// currentTime itself and just needs to know when it lands. seekAndWait() below
// builds on this for the common "set currentTime AND wait" case. This one
// shape was previously hand-rolled independently in ~5-6 places in this file.
function waitForSeeked(el, { timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('seeked', done);
      resolve();
    };
    el.addEventListener('seeked', done);
    if (timeoutMs != null) setTimeout(done, timeoutMs);
  });
}

// Seek `el` to `time` and wait for it to land. Resolves immediately (without
// touching currentTime) if already within `epsilon` of the target, unless
// `force` (needed to "un-end" an ended element whose numeric position doesn't
// need to change, so no 'seeked' event would otherwise fire).
function seekAndWait(el, time, { timeoutMs = 1500, epsilon = 0.02, force = false } = {}) {
  if (!force && Math.abs(el.currentTime - time) < epsilon) return Promise.resolve();
  const p = waitForSeeked(el, { timeoutMs }); // listen BEFORE writing currentTime
  el.currentTime = time;
  return p;
}

function seekTo(t) {
  if (camReady) camVideo.currentTime = camTimeFor(t);
  if (cleanAudioActive) cleanAudio.currentTime = Math.min(t, cleanAudio.duration || t);
  return seekAndWait(video, t, { timeoutMs: 1500 });
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
  const { dw, dh, dx, dy } = coverFitRect(vw, vh, W, H);
  ctx.drawImage(camVideo, 0, 0, vw, vh, dx, dy, dw, dh);
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

// blocks.filter() used to run on every drawn frame (60fps during playback),
// allocating a new array each time. The filtered SET only changes when a block
// is added/removed/replaced (or the active source changes) — not when a block's
// own start/end/scale is mutated in place (drag, zoom-level slider), since those
// don't change which blocks belong to the active source. Cache it, keyed by
// activeSourceId; invalidated from buildTimeline() whenever the set could have
// changed (every block add/remove/undo already routes through there).
let srcBlocksCache = null;
let srcBlocksCacheSourceId;
function invalidateSrcBlocksCache() { srcBlocksCache = null; }
function getActiveSrcBlocks() {
  if (srcBlocksCache && srcBlocksCacheSourceId === activeSourceId) return srcBlocksCache;
  srcBlocksCache = blocks.filter((b) => b.sourceId === activeSourceId);
  srcBlocksCacheSourceId = activeSourceId;
  return srcBlocksCache;
}

function drawAt(t) {
  if (!video || !video.videoWidth) return;
  const srcBlocks = getActiveSrcBlocks();
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
        ensureCanvasMatchesSize(sceneTransCanvas);
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
  ensureCanvasMatchesSize(transCanvas);
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

// Render (via ffmpeg) and load the cleaned mic audio for the current settings
// (noise profile + echo removal), then route preview playback through it. With
// both off, restore the raw audio.
async function applyAudioPreview() {
  if (!recording || !recording.hasAudio) return;
  const profile = noiseProfile.value;
  const echo = echoLevel.value;
  const myToken = ++audioPreviewToken;

  if (profile === 'off' && echo === 'off') {
    cleanAudioActive = false;
    cleanAudio.pause();
    updateAudioRouting();
    audioStatus.textContent = '';
    return;
  }

  audioStatus.textContent = '· جارٍ التحضير…';
  let url = null;
  try {
    url = await window.api.previewAudio({ profile, echoLevel: echo });
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
  if (isRec && camReady) camVideo.playbackRate = sp * camDurRatio();
  if (isRec && cleanAudioActive) cleanAudio.playbackRate = sp;
  if (camReady) {
    if (isRec) camVideo.currentTime = camTimeFor(c.start);
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
    waitForSeeked(el, { timeoutMs: 1500 }).then(() => { if (el === video) mediaSeeking = false; });
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
    if (camReady) camVideo.playbackRate = sp * camDurRatio();
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
// First index i in ascending-sorted `arr` with arr[i] >= value (arr.length if
// none). `clickTimes` is chronologically recorded, so this (and upperBound
// below) replace a linear scan with O(log n) lookups — used both here (called
// every rendered frame during playback) and in buildTimeline()'s click-tick
// pass, which used to call sourceToEdited() (itself O(clips)) once per click.
function lowerBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}
// First index i with arr[i] > value.
function upperBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function playClickSounds(t) {
  if (clickSound.checked && clickTimes.length && t > lastFxTime) {
    const vol = parseInt(clickVol.value, 10) / 100;
    // Clicks with lastFxTime < tc <= t — a binary-searched range instead of a
    // full scan over every click, and stateless so clip-boundary/seek jumps in
    // `t`/lastFxTime (which reset it directly, elsewhere) can't desync it.
    const start = upperBound(clickTimes, lastFxTime);
    const end = upperBound(clickTimes, t);
    for (let i = start; i < end; i++) {
      const a = clickAudio.cloneNode();
      a.volume = vol;
      a.play().catch(() => {});
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

