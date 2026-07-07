'use strict';

// editor-controls.js — part of the editor.js module split (see editor.html for load order).
// Per-clip speed control, scene-transition control, audio decoding + auto remove-silence, and the remaining inspector/keyboard-shortcut UI wiring.

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
  markDirty();
});

// ---------------------------------------------------------------------------
// Audio decoding, shared by the waveform (ensureWaveform) and auto remove-
// silence (removeSilences) below. A one-hour 48kHz stereo recording decodes to
// roughly 1.3GB of float32 PCM — this used to be cached in a module-level
// variable for the rest of the session with no eviction. Neither consumer needs
// the raw PCM for longer than it takes to derive a small summary from it
// (a peaks array, or a list of speech ranges), so it's decoded on demand and
// left to be garbage-collected once its caller is done with it. `inFlight` only
// dedupes genuinely-concurrent requests for the same source (e.g. the waveform
// and a remove-silence pass both wanting it around the same time) — it's
// cleared as soon as they all settle, so nothing outlives its actual consumers.
// ---------------------------------------------------------------------------
const audioDecodeInFlight = new Map(); // sourceId -> Promise<AudioBuffer>
const audioDecodeFailed = new Set();   // sources that failed to decode (skip retry this session)
let sharedDecodeCtx = null;

// A SHORT-LIVED single-slot cache. Decoding a long recording is a multi-second
// stall, and the common workflow — run "remove silence", judge the cut, nudge a
// slider, run it again — would otherwise re-decode from scratch every retry.
// This retains just the most-recently-decoded buffer, and only until a short
// idle timeout elapses, so we get instant retries WITHOUT the old behavior of
// pinning ~1.3GB of PCM for the whole session (which is why the per-source cache
// was removed in the first place). One slot: switching sources drops the prior.
let audioDecodeCache = null;        // { id, buffer } | null
let audioDecodeCacheTimer = null;
const AUDIO_DECODE_CACHE_TTL_MS = 60000;

function retainDecodedAudio(id, buffer) {
  audioDecodeCache = { id, buffer };
  if (audioDecodeCacheTimer) clearTimeout(audioDecodeCacheTimer);
  audioDecodeCacheTimer = setTimeout(() => {
    audioDecodeCache = null;
    audioDecodeCacheTimer = null;
  }, AUDIO_DECODE_CACHE_TTL_MS);
}

async function decodeSourceAudio(src) {
  if (!src || !src.hasAudio || !src.url) return null;
  if (audioDecodeFailed.has(src.id)) return null;
  if (audioDecodeCache && audioDecodeCache.id === src.id) {
    retainDecodedAudio(src.id, audioDecodeCache.buffer); // refresh TTL on reuse
    return audioDecodeCache.buffer;
  }
  if (audioDecodeInFlight.has(src.id)) return audioDecodeInFlight.get(src.id);

  const promise = (async () => {
    const arr = await (await fetch(src.url)).arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    sharedDecodeCtx = sharedDecodeCtx || new AC();
    try {
      return await sharedDecodeCtx.decodeAudioData(arr);
    } catch (err) {
      audioDecodeFailed.add(src.id);
      throw err;
    }
  })();
  audioDecodeInFlight.set(src.id, promise);
  try {
    const buffer = await promise;
    retainDecodedAudio(src.id, buffer); // keep briefly for retune retries
    return buffer;
  } finally {
    audioDecodeInFlight.delete(src.id);
  }
}

// True if any clip anywhere (main track, an overlay track, or an audio track)
// still references this source.
function sourceStillReferenced(sourceId) {
  return clips.some((c) => c.sourceId === sourceId)
    || allOverlayClips().some((c) => c.sourceId === sourceId)
    || allAudioClips().some((c) => c.sourceId === sourceId);
}

// Drop cached waveform state for sources no longer referenced by any clip, so a
// long editing session that imports and removes many sources doesn't
// accumulate their cached peaks indefinitely. Called from buildTimeline() so it
// runs after every structural edit without having to instrument each mutator.
function pruneUnusedSourceCaches() {
  waveformCache.forEach((_v, id) => { if (!sourceStillReferenced(id)) waveformCache.delete(id); });
}

// Speech spans [ [start,end], ... ] in source seconds. Windows below an energy
// threshold are "silence"; only silence gaps ≥ minSilence are cut, and each kept
// span is padded so cuts don't clip word starts/ends.
//
// The threshold is derived from the DISTRIBUTION of frame energies (a robust
// noise-floor → speech-level span), not the single loudest frame. A peak-relative
// threshold is fooled by one loud transient — a cough, mouse click, plosive,
// keyboard clack — which inflates the peak and pushes the threshold above normal
// speech, so quiet tails and soft consonants get cut as "silence". Percentiles
// ignore that outlier. A second, lower "stay in speech" threshold (hysteresis)
// keeps word onsets/tails and brief mid-word dips from being chopped. Isolated
// sub-100 ms blips are dropped as noise (so the gap around them is cut), and each
// kept span gets a larger trailing than leading pad so a word's quiet release
// isn't clipped.
function detectSpeechRanges(buf, thresholdRatio, minSilence, pad) {
  const sr = buf.sampleRate;
  const a = buf.getChannelData(0);
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const n = a.length;
  const win = Math.max(1, Math.round(sr * 0.02)); // 20 ms
  const nWin = Math.ceil(n / win);
  if (!nWin) return [];
  const rms = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const s = w * win, e = Math.min(n, s + win);
    let sum = 0;
    for (let i = s; i < e; i++) { const v = b ? (a[i] + b[i]) * 0.5 : a[i]; sum += v * v; }
    rms[w] = Math.sqrt(sum / Math.max(1, e - s));
  }

  // Robust reference levels from the sorted frame energies.
  const sorted = Float32Array.from(rms).sort();
  const pct = (p) => sorted[Math.min(nWin - 1, Math.max(0, Math.round(p * (nWin - 1))))];
  const noise = pct(0.15);      // room tone / silence floor
  const speechLvl = pct(0.90);  // typical speech energy
  const span = Math.max(speechLvl - noise, 1e-5);

  // thresholdRatio (0.02..0.15 from the sensitivity slider) sets how far up the
  // noise→speech span the ENTER threshold sits: higher = more aggressive = cuts
  // more. The STAY threshold sits lower (hysteresis) so tails aren't clipped.
  const frac = Math.min(0.6, 0.15 + thresholdRatio * 2.5); // ~0.20..0.53
  const hi = Math.max(noise + span * frac, noise * 1.8, 0.003);
  const lo = Math.max(noise + span * frac * 0.4, noise * 1.2); // lower = holds quiet tails

  const winDur = win / sr;
  // Hysteresis scan: open a span when energy crosses `hi`, keep it open until
  // energy falls below the lower `lo`, so quiet tails/onsets and brief dips
  // inside a word stay part of the speech span.
  const raw = [];
  let inSpeech = false, spanStart = 0;
  for (let i = 0; i < nWin; i++) {
    if (!inSpeech) {
      if (rms[i] >= hi) { inSpeech = true; spanStart = i; }
    } else if (rms[i] < lo) {
      raw.push([spanStart * winDur, i * winDur]);
      inSpeech = false;
    }
  }
  if (inSpeech) raw.push([spanStart * winDur, nWin * winDur]);
  if (!raw.length) return [];
  const merged = [];
  let [cs, ce] = raw[0];
  for (let k = 1; k < raw.length; k++) {
    const [s, e] = raw[k];
    if (s - ce < minSilence) ce = e; else { merged.push([cs, ce]); [cs, ce] = [s, e]; }
  }
  merged.push([cs, ce]);

  // Drop isolated blips shorter than MIN_SPEECH: a sub-100 ms island surrounded by
  // silence is a click/tap/lip-smack, not speech, so treating it as noise lets the
  // gap around it actually be cut. Spans within minSilence of real speech were
  // already bridged into it by the merge above, so genuine short words survive.
  const MIN_SPEECH = 0.10;
  const speechy = merged.filter(([s, e]) => e - s >= MIN_SPEECH);
  if (!speechy.length) return [];

  // Pad each kept span before cutting. Asymmetric on purpose: a larger TRAILING
  // hangover than leading pad, because a word's quiet decay falls below the
  // threshold before the sound is really over, so a symmetric pad clips the last
  // word. Extra tail padding covers that release. Both are capped against
  // minSilence so lead+tail can't exceed the gap being cut (which would overlap
  // the two padded spans and leave the silence uncut) at aggressive slider values.
  const dur = buf.duration;
  const leadPad = Math.min(pad, minSilence * 0.35);
  const tailPad = Math.min(pad + 0.13, minSilence * 0.5);
  const out = [];
  for (const [s, e] of speechy) {
    const ps = Math.max(0, s - leadPad), pe = Math.min(dur, e + tailPad);
    if (out.length && ps <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], pe);
    else out.push([ps, pe]);
  }
  return out;
}

const SILENCE_RATIOS = { 1: 0.02, 2: 0.04, 3: 0.06, 4: 0.10, 5: 0.15 };

async function removeSilences() {
  if (exporting) return;
  // Every source on the main track that carries audio — recorded or imported.
  const audioSrcIds = [...new Set(clips.map((c) => c.sourceId))]
    .filter((id) => { const s = sourceById(id); return !!(s && s.hasAudio); });
  if (!audioSrcIds.length) { silenceStatus.textContent = 'لا يوجد صوت للتحليل'; return; }
  // With the recording's audio detached, cutting its (muted) video clips would
  // desync the separate audio-track clip. Only block when the recording is one
  // of the sources being cut — imports have no detach concept.
  const recInvolved = audioSrcIds.some((id) => { const s = sourceById(id); return s && s.kind === 'recording'; });
  if (recInvolved && isAudioDetached()) { silenceStatus.textContent = 'أعد ربط صوت التسجيل أولًا (🔗)'; return; }

  // Kept disabled for the FULL operation (decode through the clips rebuild), not
  // just the decode — otherwise a timeline edit made in the gap between the two
  // could be silently overwritten or produce an inconsistent result.
  removeSilenceBtn.disabled = true;
  try {
    silenceStatus.textContent = 'جارٍ التحليل…';
    const ratio = SILENCE_RATIOS[parseInt(silenceSens.value, 10)] || 0.06;
    const minSilence = parseFloat(silenceGap.value) || 0.4;

    // Decode + detect speech spans once per source (each in its own source-time frame).
    const speechBySource = new Map(); // sourceId -> [[start,end], ...]
    let decodedAny = false;
    for (const id of audioSrcIds) {
      let ranges = null;
      try {
        const buf = await decodeSourceAudio(sourceById(id));
        if (buf) { decodedAny = true; ranges = detectSpeechRanges(buf, ratio, minSilence, 0.12); }
      } catch (_) { ranges = null; }
      if (ranges) speechBySource.set(id, ranges);
    }
    if (!decodedAny) { silenceStatus.textContent = 'تعذّر تحليل الصوت'; return; }
    // No source had any speech above the threshold: don't wipe the footage, warn.
    if (![...speechBySource.values()].some((r) => r.length)) {
      silenceStatus.textContent = 'لم يُعثر على كلام'; return;
    }

    if (playing) pause(); // don't let the render loop index a stale clip mid-rebuild

    // Keep only speech sub-ranges of audio-bearing clips; leave silent clips and
    // any clip whose source failed to decode untouched.
    const before = editedDuration();
    const newClips = [];
    let cutIn = 0;    // clips we analysed (source had detected speech)
    let cutKept = 0;  // resulting kept sub-clips
    for (const c of clips) {
      const speech = speechBySource.get(c.sourceId);
      // No entry, or a source with zero detected speech -> keep the clip untouched
      // (never delete a whole clip just because it has no speech at all).
      if (!speech || !speech.length) { newClips.push({ ...c }); continue; }
      cutIn++;
      let first = true;
      for (const [s, e] of speech) {
        const a2 = Math.max(s, c.start), b2 = Math.min(e, c.end);
        if (b2 - a2 > 0.05) {
          const nc = { ...c, id: clipSeq++, start: a2, end: b2 };
          if (!first) delete nc.transition; // intro transition only on the first kept piece
          newClips.push(nc);
          cutKept++;
          first = false;
        }
      }
    }
    // Don't silently wipe footage if detection removed every audio clip.
    if (cutIn > 0 && cutKept === 0) { silenceStatus.textContent = 'الحساسية عالية جدًا — لم يبقَ شيء'; return; }
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
  } finally {
    removeSilenceBtn.disabled = false;
  }
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

// Reflow the fit-to-width timeline when the window resizes. (There used to be a
// second, near-identical resize handler further down that did the same
// buildTimeline()+movePlayhead() rebuild a second time on every resize — merged
// into this one.)
window.addEventListener('resize', () => {
  if (!clips.length || drag || clipDrag) return; // don't detach the element being dragged
  relayoutTimeline();
});

// Link/unlink the recording's audio from its video (detach onto an audio track).
linkAudio.addEventListener('change', () => {
  if (!recording || !recording.hasAudio) { linkAudio.checked = true; return; }
  if (linkAudio.checked) reattachAudio(); else detachAudio();
});

const SILENCE_SENS_LABELS = { 1: 'منخفضة جدًا', 2: 'منخفضة', 3: 'متوسطة', 4: 'عالية', 5: 'عالية جدًا' };
silenceSens.addEventListener('input', () => {
  silenceSensVal.textContent = SILENCE_SENS_LABELS[silenceSens.value] || 'متوسطة';
  Prefs.set('silenceSens', parseInt(silenceSens.value, 10));
  markDirty();
});
silenceGap.addEventListener('input', () => {
  silenceGapVal.textContent = parseFloat(silenceGap.value).toFixed(1);
  Prefs.set('silenceGap', parseFloat(silenceGap.value));
  markDirty();
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

// One keydown handler for both the modal Escape/"?" toggle and all editing
// shortcuts (Space play/pause; ←/→ seek; Delete removes the selected zoom or
// clip; 'S' splits at the playhead; Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z (or
// Ctrl/Cmd+Y) redoes) — these used to be two separate `keydown` registrations.
window.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  if (e.key === 'Escape') { toggleShortcuts(false); return; }
  if ((e.key === '?' || e.key === '؟') && !typing) { toggleShortcuts(true); return; }

  if (exporting) return; // ignore edit shortcuts during an export
  if (shortcutsModal.classList.contains('open')) return; // modal owns the keyboard
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

  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveProject(e.shiftKey); // Ctrl+Shift+S = Save As
    return;
  }

  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    splitAtPlayhead();
  }
});

// `selectedBlock.scale` mutates live on every 'input' tick for visual feedback,
// so (like the block drag above) the pre-edit state is captured once, on the
// first tick of the gesture, and committed as a single history entry on 'change'
// (release) — not on every tick, which would flood the undo stack.
let zoomLevelPreSnapshot = null;
zoomLevel.addEventListener('input', () => {
  const v = parseFloat(zoomLevel.value);
  const span = document.getElementById('zoomLevelVal');
  if (span) span.textContent = `${v.toFixed(1)}×`;
  if (selectedBlock) {
    if (zoomLevelPreSnapshot === null) zoomLevelPreSnapshot = snapshotState();
    selectedBlock.scale = v;
    buildTimeline();
    selectBlock(selectedBlock);
  } else {
    defaultScale = v;
    Prefs.set('zoom', v);
    markDirty();
  }
  drawAt(video.currentTime);
});
zoomLevel.addEventListener('change', () => {
  if (zoomLevelPreSnapshot) {
    pushHistory(zoomLevelPreSnapshot);
    zoomLevelPreSnapshot = null;
  }
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


// ---------------------------------------------------------------------------
