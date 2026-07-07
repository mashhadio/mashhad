'use strict';

// editor-tracks.js — part of the editor.js module split (see editor.html for load order).
// Overlay-track and audio-track operations (add/move/delete track or clip), and voice-over recording/import.

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
