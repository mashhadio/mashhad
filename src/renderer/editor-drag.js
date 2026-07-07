'use strict';

// editor-drag.js — part of the editor.js module split (see editor.html for load order).
// Timeline pointer interaction: zoom-block select/drag/resize and clip/overlay/audio-clip drag-reorder.

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
    // `b` mutates live during the drag (for visual feedback), so the pre-drag
    // state must be captured now — by mouseup it's already gone. Committed as a
    // single history entry on release, only if the drag actually moved anything.
    drag = { mode, block: b, clip: c, el: blockEl, startX: e.clientX, origStart: b.start, origEnd: b.end, moved: false, preSnapshot: snapshotState() };
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
    const preSnapshot = drag.preSnapshot;
    drag = null;
    if (moved) {
      pushHistory(preSnapshot); // one history entry for the whole drag gesture
      buildTimeline(); // reconcile rects that may now span clips
    }
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

