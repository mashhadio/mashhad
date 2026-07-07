'use strict';

// editor-timeline-render.js — part of the editor.js module split (see editor.html for load order).
// Timeline DOM rendering: the ruler, waveform decoding + drawing, the main/overlay/audio track rows, and edited-time seeking.

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

// ---------------------------------------------------------------------------
// Audio waveforms. Each source's file is decoded once into a peak array (one
// value per PEAKS_PER_SEC-th of a second, 0..1), cached by source id. Clips draw
// the slice of their source's peaks that they cover, so the waveform tracks the
// footage across cuts, reorders and speed changes. Decoding is async; a source
// resolving triggers one rebuild so its clips repaint with the wave.
// ---------------------------------------------------------------------------
const PEAKS_PER_SEC = 120;
const waveformCache = new Map(); // sourceId -> {peaks:Float32Array} | 'pending' | 'none'

// Peak extraction is a per-sample scan over the whole decoded file — for a long
// import that's real main-thread work that used to freeze the UI for its
// duration. Offloaded to a Worker (transferring the channel data, not copying
// it back and forth) when available, with a same-tab fallback if the worker
// can't be created for any reason.
let waveformWorker = null;
let waveformWorkerBroken = false;
let waveformWorkerReqSeq = 0;
const waveformWorkerPending = new Map(); // reqId -> {resolve, reject}

function getWaveformWorker() {
  if (waveformWorker || waveformWorkerBroken) return waveformWorker;
  try {
    waveformWorker = new Worker('waveform-worker.js');
    waveformWorker.onmessage = (e) => {
      const { id, peaks, maxPeak, error } = e.data;
      const pending = waveformWorkerPending.get(id);
      if (!pending) return;
      waveformWorkerPending.delete(id);
      if (error) pending.reject(new Error(error)); else pending.resolve({ peaks, maxPeak });
    };
    waveformWorker.onerror = (e) => {
      // Fail every pending request rather than leaving them hanging forever,
      // and stop trying to use a worker that's demonstrated it can't run.
      waveformWorkerPending.forEach((p) => p.reject(e.error || new Error('Waveform worker error')));
      waveformWorkerPending.clear();
      waveformWorker = null;
      waveformWorkerBroken = true;
    };
  } catch (err) {
    console.warn('Waveform worker unavailable, falling back to main-thread peak extraction:', err.message);
    waveformWorkerBroken = true;
  }
  return waveformWorker;
}

function computePeaksInWorker(audio) {
  const worker = getWaveformWorker();
  if (!worker) return null; // caller falls back to computing on the main thread
  const id = ++waveformWorkerReqSeq;
  const channels = [];
  for (let ch = 0; ch < audio.numberOfChannels; ch++) channels.push(audio.getChannelData(ch).slice());
  return new Promise((resolve, reject) => {
    waveformWorkerPending.set(id, { resolve, reject });
    worker.postMessage({ id, channels, sampleRate: audio.sampleRate, peaksPerSec: PEAKS_PER_SEC }, channels.map((c) => c.buffer));
  });
}

function computePeaksOnMainThread(audio) {
  const totalPeaks = Math.max(1, Math.ceil(audio.duration * PEAKS_PER_SEC));
  const peaks = new Float32Array(totalPeaks);
  const per = audio.sampleRate / PEAKS_PER_SEC; // samples per peak bucket
  let maxPeak = 0;
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const b = (i / per) | 0;
      const a = data[i] < 0 ? -data[i] : data[i];
      if (a > peaks[b]) peaks[b] = a;
    }
  }
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > maxPeak) maxPeak = peaks[i];
  return { peaks, maxPeak };
}

async function ensureWaveform(src) {
  if (!src || !src.hasAudio || !src.url) return;
  if (waveformCache.has(src.id)) return;
  waveformCache.set(src.id, 'pending');
  try {
    // Reuse the same decode remove-silence uses (deduped per source), so a
    // large file is fetched/decoded at most once for both the wave and the cuts.
    const audio = await decodeSourceAudio(src);
    if (!audio) { waveformCache.set(src.id, 'none'); return; }
    let result;
    try { result = await computePeaksInWorker(audio); } catch (_) { result = null; }
    if (!result) result = computePeaksOnMainThread(audio);
    waveformCache.set(src.id, result);
  } catch {
    waveformCache.set(src.id, 'none'); // undecodable (e.g. codec) — just skip
  }
  buildTimeline(); // repaint clips of this source now that peaks exist
}

// Draw the [startSec, endSec] slice of `src`'s waveform into a canvas sized to
// the clip element, and prepend it so it sits behind the label. No-op (and kicks
// off decoding) until the source's peaks are ready. `trackH` is the clip's pixel
// height, passed in by the caller (read once per track) so this never reads
// layout inside the per-clip loop — reading it here would force a reflow after
// each canvas insert (O(N) layout thrash).
function attachWave(el, src, startSec, endSec, trackH) {
  const existing = el.querySelector(':scope > canvas.clip-wave');
  if (!src || !src.hasAudio) {
    if (existing) existing.remove(); // stale wave from a previous source/detach state
    return;
  }
  const wf = waveformCache.get(src.id);
  if (wf === undefined) { ensureWaveform(src); return; }
  if (wf === 'pending' || wf === 'none') return;
  const cssW = Math.max(1, Math.round(parseFloat(el.style.width) || 0));
  if (cssW < 2) return;
  const cssH = trackH || 48;

  // `el` (and its wave canvas) may be a reused element from a previous
  // buildTimeline() call — skip redrawing entirely when nothing that affects
  // the drawn pixels has changed, instead of reallocating a canvas per clip on
  // every rebuild (buildTimeline runs on every drag-end, resize, split, ...).
  const key = `${src.id}:${startSec.toFixed(3)}:${endSec.toFixed(3)}:${cssW}:${cssH}`;
  if (existing && existing.dataset.waveKey === key) return;
  const cv = existing || document.createElement('canvas');
  cv.className = 'clip-wave';
  cv.dataset.waveKey = key;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const { peaks } = wf;
  // Normalise to the source's loudest moment so quiet takes still fill the track,
  // then lift with a perceptual curve (raw amplitude looks flat for speech).
  const norm = wf.maxPeak > 0 ? wf.maxPeak : 1;
  const startP = startSec * PEAKS_PER_SEC;
  const rangeP = Math.max(1e-6, (endSec - startSec) * PEAKS_PER_SEC);
  const mid = cssH / 2;
  g.fillStyle = 'rgba(150,220,255,0.6)';
  for (let x = 0; x < cssW; x++) {
    const p0 = (startP + (x / cssW) * rangeP) | 0;
    const p1 = (startP + ((x + 1) / cssW) * rangeP) | 0;
    let peak = 0;
    for (let p = p0; p <= p1 && p < peaks.length; p++) if (peaks[p] > peak) peak = peaks[p];
    const v = Math.pow(Math.min(1, peak / norm), 0.55); // 0..1, boosted for quiet parts
    const bar = Math.max(1, v * mid); // fill the full clip height at the loudest moment
    g.fillRect(x, mid - bar, 1, bar * 2);
  }
  if (!existing) el.insertBefore(cv, el.firstChild);
}

// Persistent per-clip DOM elements for the main track, reused across
// buildTimeline() calls — see the clip-track loop in buildTimeline() below.
const clipElByCid = new Map(); // clip.id -> { el, labelEl, badgeEl }

function buildTimeline() {
  rebuildClipTimeCache(); // editedStartOf()/editedDuration() read this until the next rebuild
  invalidateSrcBlocksCache(); // the set of blocks may have changed (add/remove/undo)
  pruneUnusedSourceCaches(); // drop waveform state for sources no clip references anymore
  [...timeline.querySelectorAll('.block, .click-tick')].forEach((n) => n.remove());
  transSnapIdx = -1; // any pending transition snapshot is stale after a rebuild
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;

  // Per-source colour so clips from different files read as distinct on the track.
  const sourceColors = {};
  let colorSeq = 0;
  const COLORS = ['', 'src-b', 'src-c', 'src-d', 'src-e', 'src-f'];
  sources.forEach((s) => { sourceColors[s.id] = s.kind === 'recording' ? '' : COLORS[(1 + colorSeq++) % COLORS.length]; });

  // Clip height, read once (all clips share it) so attachWave never reads layout
  // inside the loop. Clips are inset 2px top and bottom (see .timeline .clip).
  const clipH = Math.max(1, (timeline.clientHeight || 84) - 4);

  // Clip track — the draggable, reorderable base layer. Elements are reused
  // across rebuilds (keyed by clip id) instead of destroyed and recreated —
  // buildTimeline() runs on every drag-end, resize, split, import, ... (36 call
  // sites), and recreating every clip div (plus a brand-new waveform canvas
  // each time, see attachWave) made dragging/trimming visibly janky on a
  // timeline with many clips.
  const liveClipIds = new Set();
  clips.forEach((c, ci) => {
    liveClipIds.add(c.id);
    const hasTrans = ci > 0 && c.transition && c.transition.type !== 'none';
    const src = sourceById(c.sourceId);
    const isImport = src && src.kind === 'import';
    const transLabel = hasTrans ? (TRANSITION_LABELS[c.transition.type] || c.transition.type) : '';
    const srcName = src ? src.name : '';
    const spd = (c.speed || 1) !== 1 ? ` · ${(c.speed).toFixed(2)}×` : '';

    let entry = clipElByCid.get(c.id);
    if (!entry) {
      const el = document.createElement('div');
      const labelEl = document.createElement('span');
      labelEl.className = 'clip-label';
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'clip-delete';
      deleteBtn.title = 'حذف المقطع';
      deleteBtn.tabIndex = -1;
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteClip(c.id); });
      el.appendChild(labelEl);
      el.appendChild(deleteBtn);
      entry = { el, labelEl, badgeEl: null };
      clipElByCid.set(c.id, entry);
    }

    if (hasTrans) {
      if (!entry.badgeEl) {
        entry.badgeEl = document.createElement('span');
        entry.badgeEl.className = 'clip-trans';
        entry.badgeEl.textContent = '▶';
        entry.el.insertBefore(entry.badgeEl, entry.labelEl);
      }
      entry.badgeEl.title = `انتقال ${transLabel}`;
    } else if (entry.badgeEl) {
      entry.badgeEl.remove();
      entry.badgeEl = null;
    }
    entry.labelEl.textContent = `${fmt(clipTLen(c))}${spd}`;

    const el = entry.el;
    el.className = 'clip' + (c.id === selectedClipId ? ' selected' : '') + (hasTrans ? ' has-trans' : '')
      + (isImport ? ' import' : '') + (sourceColors[c.sourceId] ? ' ' + sourceColors[c.sourceId] : '');
    el.dataset.cidx = ci;
    el.style.left = `${(editedStartOf(ci) / total) * w}px`;
    el.style.width = `${(clipTLen(c) / total) * w}px`;
    el.title = (isImport ? `${srcName} · ` : '')
      + (hasTrans ? `انتقال ${transLabel} · ` : '')
      + 'اسحب لإعادة الترتيب · ✕ أو Delete للحذف';
    timeline.appendChild(el); // re-appending an already-attached node MOVES it — this is how reorders are reflected
    if (src && (src.kind !== 'recording' || !isAudioDetached())) attachWave(el, src, c.start, c.end, clipH);
    else attachWave(el, null, 0, 0, clipH); // drop a stale wave canvas (e.g. audio just detached)
  });
  // Drop elements for clips that no longer exist (deleted, split away, replaced
  // by undo/redo, ...).
  clipElByCid.forEach((entry, id) => {
    if (!liveClipIds.has(id)) { entry.el.remove(); clipElByCid.delete(id); }
  });

  // Recorded clicks, mapped onto the edited timeline (dropped if cut out). Only
  // the recording's clips carry clicks. Iterating clips (typically far fewer
  // than clicks) and binary-searching each one's click sub-range avoids calling
  // sourceToEdited() — itself O(clips) — once per click (O(clicks × clips) on a
  // long recording); `clickTimes` is chronologically sorted, so lowerBound finds
  // each clip's [start,end) sub-range in O(log clicks).
  if (recording) {
    clips.forEach((c, ci) => {
      if (c.sourceId !== recording.id) return;
      const lo = lowerBound(clickTimes, c.start);
      const hi = lowerBound(clickTimes, c.end);
      if (hi <= lo) return;
      const sp = c.speed || 1;
      const base = editedStartOf(ci);
      for (let k = lo; k < hi; k++) {
        const te = base + (clickTimes[k] - c.start) / sp;
        const tick = document.createElement('div');
        tick.className = 'click-tick';
        tick.style.left = `${(te / total) * w}px`;
        timeline.appendChild(tick);
      }
    });
  }

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
// Unlike the main clip track above, this still fully rebuilds on every call —
// audio/overlay tracks are typically far sparser (a handful of voice-over/music
// clips vs. potentially many split main-track clips), so the payoff for the
// same reuse-by-id treatment is much smaller relative to the risk of extending
// it everywhere at once.
// Shared per-clip element for both track-lane kinds — position/title/delete-
// button wiring was identical in structure between the two ~30-line copies;
// what differs (class name, icon, title suffix, whether a waveform is drawn,
// the delete callback) is passed in.
function buildTrackClipEl(c, { className, selected, titleSuffix, icon, waveHeight, onDelete, w, total }) {
  const src = sourceById(c.sourceId);
  const el = document.createElement('div');
  el.className = className + (selected ? ' selected' : '');
  el.dataset.clipId = c.id;
  el.style.left = `${(c.pos / total) * w}px`;
  el.style.width = `${Math.max(6, (clipTLen(c) / total) * w)}px`;
  el.title = (src ? src.name + ' · ' : '') + titleSuffix;
  const iconText = icon ? icon(c) : '';
  el.innerHTML = `<span class="clip-label">${iconText}${fmt(clipTLen(c))}</span><button class="clip-delete" title="حذف" tabindex="-1">✕</button>`;
  el.querySelector('.clip-delete').addEventListener('mousedown', (e) => e.stopPropagation());
  el.querySelector('.clip-delete').addEventListener('click', (e) => { e.stopPropagation(); onDelete(c.id); });
  if (waveHeight) attachWave(el, src, c.start, c.end, waveHeight);
  return el;
}

// Shared row header (label + delete-track button) for both track-lane kinds.
function buildTrackRowHeader({ label, delTitle, onDelete }) {
  const row = document.createElement('div');
  row.className = 'tl-row';
  row.innerHTML = `<span class="tl-row-label">${label}</span>`
    + `<button class="tl-row-del" title="${delTitle}" tabindex="-1">✕</button>`;
  row.querySelector('.tl-row-del').addEventListener('mousedown', (e) => e.stopPropagation());
  row.querySelector('.tl-row-del').addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
  return row;
}

function buildAudioRows() {
  tlAudio.innerHTML = '';
  const w = timeline.clientWidth;
  const total = editedDuration() || 1;
  audioTracks.forEach((trk, ti) => {
    const row = buildTrackRowHeader({
      label: `صوت ${ti + 1}`, delTitle: 'حذف مسار الصوت', onDelete: () => deleteAudioTrack(trk.id),
    });
    row.dataset.atrack = ti;
    trk.clips.forEach((c) => {
      const el = buildTrackClipEl(c, {
        className: 'aclip',
        selected: selectedAudio && selectedAudio.clipId === c.id,
        titleSuffix: 'اسحب للتحريك · ✕ للحذف',
        icon: (cc) => (cc.detached ? '🔗 ' : cc.voice ? '🎙 ' : ''),
        waveHeight: 28, // .tl-row is 32px tall, aclip inset 2px top/bottom
        onDelete: deleteAudioClip,
        w, total,
      });
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
    const row = buildTrackRowHeader({
      label: `طبقة ${ti + 1}`, delTitle: 'حذف الطبقة', onDelete: () => deleteOverlayTrack(trk.id),
    });
    row.dataset.track = ti;
    trk.clips.forEach((c) => {
      const el = buildTrackClipEl(c, {
        className: 'oclip',
        selected: selectedOverlay && selectedOverlay.clipId === c.id,
        titleSuffix: 'اسحب للتحريك · لأسفل للمسار الرئيسي · ✕ للحذف',
        icon: null,
        waveHeight: 0,
        onDelete: deleteOverlayClip,
        w, total,
      });
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
  waitForSeeked(el).then(() => {
    if (video === el && video.paused) { drawAt(t); drawOverlays(te != null ? te : playheadEdited); }
  });
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
  if (isRec && camReady) { camVideo.playbackRate = sp * camDurRatio(); camVideo.currentTime = camTimeFor(m.src); }
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

