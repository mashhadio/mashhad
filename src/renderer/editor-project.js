'use strict';

// editor-project.js — part of the editor.js module split (see editor.html for load order).
// Project files (.mashhad): serialize/save/autosave/restore edit-state, and the undo/redo history stack.

// ---------------------------------------------------------------------------
// Project files (.mashhad). A project bundles the full edit-state (everything in
// snapshotState() plus zoom blocks, scene data, settings and id counters) with a
// manifest of the media sources, so a whole timeline can be rebuilt later. The
// media files themselves are referenced in place by the main process.
// ---------------------------------------------------------------------------
// Manifest entries for sources that were in an opened project but whose files
// were missing at load. We keep them here (unrendered) so re-saving preserves
// their references instead of silently pruning them — a temporarily-unplugged
// drive must not permanently drop the clip's source.
let preservedSources = [];

function serializeProject() {
  const snap = snapshotState();
  const edit = {
    clips: snap.clips,
    overlays: snap.overlays,
    audio: snap.audio,
    blocks: blocks.map((b) => ({ ...b })),
    sceneEvents: sceneEvents.map((e) => ({ ...e })),
    sceneTransDur,
    defaultScale,
    playheadEdited,
    seqs: { clipSeq, overlayClipSeq, overlayTrackSeq, audioClipSeq, audioTrackSeq },
    settings: {
      noiseProfile: noiseProfile.value,
      echoLevel: echoLevel.value,
      clickSound: clickSound.checked,
      clickSoundName: clickSoundName.value,
      clickVol: parseInt(clickVol.value, 10),
      silenceSens: parseInt(silenceSens.value, 10),
      silenceGap: parseFloat(silenceGap.value),
    },
  };
  // The recording is rebuilt from the saved recording reference (main side), so
  // only imported/voice-over sources travel in the manifest. `isVideo` is stored
  // explicitly (falling back to width) so a source whose metadata briefly failed
  // to load isn't downgraded to audio-only on the next save.
  const live = sources
    .filter((s) => s.kind !== 'recording')
    .map((s) => ({ id: s.id, kind: s.kind, name: s.name, hasAudio: !!s.hasAudio,
      isVideo: s.isVideo != null ? s.isVideo : (s.width || 0) > 0 }));
  const liveIds = new Set(live.map((s) => s.id));
  const preserved = preservedSources
    .filter((s) => !liveIds.has(s.id))
    .map((s) => ({ id: s.id, kind: s.kind, name: s.name, hasAudio: !!s.hasAudio, isVideo: !!s.isVideo, path: s.path }));
  return { edit, sources: [...live, ...preserved] };
}

let projectSaving = false;
async function saveProject(saveAs = false) {
  if (projectSaving || exporting) return;
  projectSaving = true;
  try {
    const res = await window.api.saveProject({ ...serializeProject(), saveAs });
    if (res && res.canceled) return;
    if (res && res.path) {
      projectFileName = res.name;
      topStatus.textContent = `حُفظ المشروع: ${res.name}`;
    } else {
      topStatus.textContent = 'تعذّر حفظ المشروع' + (res && res.error ? `: ${res.error}` : '');
    }
  } catch (err) {
    topStatus.textContent = 'تعذّر حفظ المشروع: ' + (err.message || err);
  } finally {
    projectSaving = false;
  }
}

// Debounced background auto-save — only fires after a real edit (markDirty) and
// once the session is bound to a file. Persistence is tied to edits, not to
// repaints, so resizing or a waveform finishing decode never writes to disk.
let autoSaveTimer = null;
function markDirty() {
  if (!projectFileName) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(runAutoSave, 800);
}

async function runAutoSave() {
  autoSaveTimer = null;
  if (!projectFileName) return;
  try {
    const res = await window.api.autoSaveProject(serializeProject());
    // Surface a failed write — the user must not believe work is safe when it
    // isn't (the Back guard trusts a bound project file).
    if (res && res.error) topStatus.textContent = 'تعذّر الحفظ التلقائي — احفظ يدويًا';
  } catch (_) {
    topStatus.textContent = 'تعذّر الحفظ التلقائي — احفظ يدويًا';
  }
}

// Write any pending auto-save immediately (before navigating away tears down the
// renderer and drops the debounce timer). Safe to call when nothing is pending.
async function flushAutoSave() {
  if (autoSaveTimer == null) return;
  clearTimeout(autoSaveTimer);
  await runAutoSave();
}

// Rebuild the timeline from a project's edit-state after the editor has loaded.
// The recording (if any) is already set up by init(); here we recreate the
// imported/voice-over sources and restore every track, block and setting.
async function applyPendingProject() {
  let pend = null;
  try { pend = await window.api.getPendingProject(); } catch (_) {}
  // Remember the bound file either way, so auto-save works for opened projects.
  try { const f = await window.api.getProjectFile(); projectFileName = f && f.name; } catch (_) {}
  if (!pend || !pend.edit) return;
  const { edit, sources: manifest } = pend;
  preservedSources = [];

  for (const s of (manifest || [])) {
    if (s.id === 'rec' || sourceById(s.id)) continue;
    // No usable URL means the file was missing at load — keep the manifest entry
    // so a later re-save preserves the reference rather than dropping it.
    if (!s.url) { preservedSources.push(s); continue; }
    if (s.isVideo) {
      const el = await createSourceEl(s.url);
      const dur = el.videoWidth ? await resolveMediaDuration(el) : 0;
      sources.push({ id: s.id, kind: s.kind, url: s.url, el, duration: dur, isVideo: true,
        width: el.videoWidth || 0, height: el.videoHeight || 0, hasAudio: !!s.hasAudio, name: s.name });
    } else {
      const dur = await resolveAudioDuration(s.url);
      sources.push({ id: s.id, kind: s.kind, url: s.url, el: null, duration: dur || 0, isVideo: false,
        width: 0, height: 0, hasAudio: !!s.hasAudio, name: s.name });
    }
  }

  applyState({ clips: edit.clips || [], overlays: edit.overlays || [], audio: edit.audio || [] });
  blocks = (edit.blocks || []).map((b) => ({ ...b }));
  // Same orphaned-camera guard as a fresh recording load (see editor-playback):
  // a scene timeline that never shows the camera would suppress the webcam PiP
  // and leave a recorded camera track unusable, so fall back to the PiP path.
  if (Array.isArray(edit.sceneEvents) && edit.sceneEvents.length) {
    const camOrphaned =
      recording && recording.hasCam &&
      !edit.sceneEvents.some((e) => e.scene === 'cam' || e.scene === 'both');
    if (!camOrphaned) sceneEvents = edit.sceneEvents.map((e) => ({ ...e }));
  }
  if (edit.sceneTransDur != null) sceneTransDur = edit.sceneTransDur;
  if (edit.defaultScale != null) {
    defaultScale = edit.defaultScale;
    zoomLevel.value = String(defaultScale);
    if (zoomLevelVal) zoomLevelVal.textContent = `${defaultScale.toFixed(1)}×`;
  }

  // Advance id counters past everything restored so new clips never collide.
  // (reduce, not Math.max(...spread), so a huge restored timeline can't overflow
  // the call stack.)
  const sq = edit.seqs || {};
  const nextId = (arr, base) => arr.reduce((m, x) => Math.max(m, (x.id || 0) + 1), base || 0);
  clipSeq = nextId(clips, sq.clipSeq);
  overlayClipSeq = nextId(overlayTracks.flatMap((t) => t.clips), sq.overlayClipSeq);
  overlayTrackSeq = nextId(overlayTracks, sq.overlayTrackSeq);
  audioClipSeq = nextId(audioTracks.flatMap((t) => t.clips), sq.audioClipSeq);
  audioTrackSeq = nextId(audioTracks, sq.audioTrackSeq);

  applyProjectSettings(edit.settings || {});

  // Studio-only projects: size the canvas from the first video source.
  if (!recording) {
    const v = sources.find((s) => (s.width || 0) > 0);
    if (v) setCanvasSize(v.width, v.height);
  }

  clipHistory = [];
  clipFuture = [];
  updateUndoBtn();
  updateEmptyState();
  updateSceneControl();
  buildTimeline();
  if (clips.length) seekEdited(clamp(edit.playheadEdited || 0, 0, editedDuration()));

  if (pend.missing && pend.missing.length) {
    topStatus.textContent = `فُتح المشروع — تعذّر العثور على ${pend.missing.length} ملف: ${pend.missing.join('، ')}`;
  } else if (projectFileName) {
    topStatus.textContent = `فُتح المشروع: ${projectFileName}`;
  }
}

function applyProjectSettings(s) {
  if (!s) return;
  if (s.noiseProfile != null && !noiseProfile.disabled) noiseProfile.value = s.noiseProfile;
  if (s.echoLevel != null && !echoLevel.disabled) echoLevel.value = s.echoLevel;
  if (s.clickSound != null) clickSound.checked = !!s.clickSound;
  if (s.clickSoundName != null && ['mouse', 'mouse_soft'].includes(s.clickSoundName)) {
    clickSoundName.value = s.clickSoundName;
    clickAudio = new Audio(`../../assets/sfx/${clickSoundName.value}.wav`);
  }
  if (s.clickVol != null) { clickVol.value = String(s.clickVol); clickVolVal.textContent = `${s.clickVol}%`; }
  if (s.silenceSens != null) { silenceSens.value = String(s.silenceSens); silenceSensVal.textContent = SILENCE_SENS_LABELS[silenceSens.value] || 'متوسطة'; }
  if (s.silenceGap != null) { silenceGap.value = String(s.silenceGap); silenceGapVal.textContent = parseFloat(silenceGap.value).toFixed(1); }
}

// Snapshot for undo, taken before every mutating edit. A fresh edit
// invalidates the redo stack. Pass a pre-captured `snapshot` for gestures (block
// drag, the zoom-level slider) that mutate an object live for visual feedback —
// by the time the gesture ends the "before" state is already gone, so the caller
// must capture it itself before the first mutation and commit it here once.
function pushHistory(snapshot) {
  clipHistory.push(snapshot || snapshotState());
  if (clipHistory.length > 100) clipHistory.shift();
  clipFuture = [];
  updateUndoBtn();
  markDirty(); // a mutating edit is about to happen -> persist it
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
  // applyState() rebuilds `blocks` as fresh objects, so any previously selected
  // block is now a stale reference — clear it (also refreshes the zoom-level UI).
  selectBlock(null);
  updateSceneControl(); // sceneTransDur may have changed too
  updateUndoBtn();
  updateEmptyState();
  buildTimeline();
  markDirty(); // undo/redo changes the document too
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
  invalidateClipTimeCache(); // clip times changed in place — force a duration rebuild
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
