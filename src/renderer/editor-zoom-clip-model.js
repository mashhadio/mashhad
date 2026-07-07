'use strict';

// editor-zoom-clip-model.js — part of the editor.js module split (see editor.html for load order).
// Zoom-block edit buttons, and the non-linear clip/edited-time model (editedStartOf, srcTimeOf, track-lane lookups, snapshot/restore state).

// ---------------------------------------------------------------------------
// Zoom editing buttons
// ---------------------------------------------------------------------------
function autoZoom() {
  if (!recording) { topStatus.textContent = 'التكبير التلقائي يعتمد على نقرات التسجيل — أضِف تكبيرًا يدويًا بزر «＋ تكبير هنا».'; return; }
  pushHistory();
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
  pushHistory();
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
  if (!blocks.length) return;
  pushHistory();
  blocks = [];
  selectBlock(null);
  buildTimeline();
  drawAt(video.currentTime);
}

function deleteBlock(b) {
  if (exporting) return;
  const idx = blocks.indexOf(b);
  if (idx < 0) return;
  pushHistory();
  blocks.splice(idx, 1);
  if (selectedBlock === b) selectBlock(null);
  buildTimeline();
  drawAt(video.currentTime);
}

// ---------------------------------------------------------------------------
// Clip model (non-linear edited timeline)
// ---------------------------------------------------------------------------
function clipLen(c) { return c.end - c.start; }             // source-time length

// Cached prefix sums of each clip's edited-time length. editedStartOf()/
// editedDuration() used to recompute this from scratch on every call — real
// cost since editedStartOf() alone is called every animation frame during
// playback (renderLoop) and, worse, once per (block, clip) pair inside
// buildTimeline()'s zoom-marker pass (O(blocks × clips²) there). Rebuilt once
// per buildTimeline() call — the one choke point every clip mutator in this
// file already calls before anything re-reads these — so there's no per-
// mutator invalidation to keep in sync.
let clipStartCache = [];
let clipDurationCache = 0;

function rebuildClipTimeCache() {
  clipStartCache = new Array(clips.length);
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    clipStartCache[i] = acc;
    acc += clipTLen(clips[i]);
  }
  clipDurationCache = acc;
}

function editedDuration() {
  return clipStartCache.length === clips.length
    ? clipDurationCache
    : clips.reduce((a, c) => a + clipTLen(c), 0);
}

// ---------------------------------------------------------------------------
// Overlay helpers. `clipTLen` is a clip's length in EDITED (timeline) seconds,
// which for speed≠1 differs from its source length. Overlay clips carry an
// absolute `pos` (edited start); main clips are gapless so their edited start is
// `editedStartOf`. `srcTimeOf` maps an edited time inside a clip to source time.
// ---------------------------------------------------------------------------
function clipTLen(c) { return (c.end - c.start) / (c.speed || 1); }
function overlayEndPos(c) { return c.pos + clipTLen(c); }
function srcTimeOf(c, te) { return c.start + (te - c.pos) * (c.speed || 1); }

// Shared by both track kinds (see elForClip/pruneEls/pauseEls above).
function allClipsOnTracks(tracks) { return tracks.flatMap((t) => t.clips); }
function clipCoveringOnTrack(trk, te) {
  return trk.clips.find((c) => te >= c.pos && te < overlayEndPos(c)) || null;
}
function findClipOnTracks(tracks, id) {
  for (const trk of tracks) {
    const c = trk.clips.find((x) => x.id === id);
    if (c) return { trk, clip: c };
  }
  return null;
}

function allOverlayClips() { return allClipsOnTracks(overlayTracks); }
function overlayCoveringOnTrack(trk, te) { return clipCoveringOnTrack(trk, te); }
// Top-most overlay clip covering edited time `te` (search upper tracks first).
function overlayClipAt(te) {
  for (let t = overlayTracks.length - 1; t >= 0; t--) {
    const c = overlayCoveringOnTrack(overlayTracks[t], te);
    if (c) return { t, trk: overlayTracks[t], clip: c };
  }
  return null;
}
function findOverlayClip(id) { return findClipOnTracks(overlayTracks, id); }

// --- Audio-track helpers (mirror the overlay helpers) ---
function allAudioClips() { return allClipsOnTracks(audioTracks); }
function audioCoveringOnTrack(trk, te) { return clipCoveringOnTrack(trk, te); }
function findAudioClip(id) { return findClipOnTracks(audioTracks, id); }
// Dedicated hidden <audio> per audio clip (created on first use).
function audioElFor(c) {
  return elForClip(audioEls, c, (url) => {
    const el = new Audio();
    el.src = url;
    el.preload = 'auto';
    return el;
  });
}
function pruneAudioEls() {
  pruneEls(audioEls, audioTracks, (el) => { try { el.pause(); el.src = ''; } catch (_) {} });
}
function pauseAudioEls() { pauseEls(audioEls); }

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
// A thin wrapper around resolveMediaDuration: it takes a URL rather than an
// already-loading element, so it creates the <audio> and waits for metadata
// before handing off to the shared seek-past-the-end/timeout logic.
function resolveAudioDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.src = url;
    a.addEventListener('loadedmetadata', () => resolve(resolveMediaDuration(a, 2000)), { once: true });
    a.addEventListener('error', () => resolve(0), { once: true });
  });
}

// Edited start (seconds) of the clip at index `idx`.
function editedStartOf(idx) {
  if (clipStartCache.length === clips.length && idx >= 0 && idx < clipStartCache.length) {
    return clipStartCache[idx];
  }
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

// A full editable-timeline snapshot: the main track, every overlay/audio track,
// the zoom blocks, and the scene-crossfade duration — everything the undo stack
// needs to fully restore an edit. `blocks` used to be omitted here, which made
// every zoom edit (the app's headline feature) silently un-undoable.
function snapshotState() {
  return {
    clips: clips.map((c) => ({ ...c })),
    overlays: overlayTracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) })),
    audio: audioTracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) })),
    blocks: blocks.map((b) => ({ ...b })),
    sceneTransDur,
  };
}
function applyState(s) {
  clips = s.clips.map((c) => ({ ...c }));
  overlayTracks = s.overlays.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) }));
  audioTracks = (s.audio || []).map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })) }));
  blocks = (s.blocks || []).map((b) => ({ ...b }));
  if (s.sceneTransDur != null) sceneTransDur = s.sceneTransDur;
}

