'use strict';

// Drag-to-select overlay. Coordinates are CSS pixels within this window, which
// is sized to exactly cover one display, so they equal DIP offsets relative to
// that display's top-left — the same space cursor-tracker and the cropper use.

const backdrop = document.getElementById('backdrop');
const hint = document.getElementById('hint');
const sel = document.getElementById('sel');
const dims = document.getElementById('dims');
const toolbar = document.getElementById('toolbar');
const recordBtn = document.getElementById('recordBtn');
const cancelBtn = document.getElementById('cancelBtn');

const MIN_SIZE = 8; // ignore stray clicks / tiny drags

let dragging = false;
let startX = 0;
let startY = 0;
let rect = null; // { x, y, w, h } in this window's CSS px

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function confirm() {
  if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) return;
  window.regionApi.send({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  });
}

function cancel() {
  window.regionApi.send(null);
}

function layoutRect() {
  sel.style.left = rect.x + 'px';
  sel.style.top = rect.y + 'px';
  sel.style.width = rect.w + 'px';
  sel.style.height = rect.h + 'px';

  dims.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
  // Place the readout just above the selection, or inside if near the top edge.
  const above = rect.y - 26;
  dims.style.left = rect.x + 'px';
  dims.style.top = (above < 4 ? rect.y + 6 : above) + 'px';
}

function showToolbar() {
  toolbar.style.display = 'flex';
  // Anchor below the selection; flip above if it would run off the bottom.
  const tbTop = rect.y + rect.h + 10;
  const flip = tbTop + 50 > window.innerHeight;
  toolbar.style.left = rect.x + 'px';
  toolbar.style.top = (flip ? rect.y - 54 : tbTop) + 'px';
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // Clicks on the toolbar shouldn't start a fresh selection.
  if (toolbar.contains(e.target)) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  rect = { x: startX, y: startY, w: 0, h: 0 };
  backdrop.style.display = 'none';
  hint.style.display = 'none';
  toolbar.style.display = 'none';
  sel.style.display = 'block';
  dims.style.display = 'block';
  layoutRect();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const x = clamp(e.clientX, 0, window.innerWidth);
  const y = clamp(e.clientY, 0, window.innerHeight);
  rect = {
    x: Math.min(startX, x),
    y: Math.min(startY, y),
    w: Math.abs(x - startX),
    h: Math.abs(y - startY),
  };
  layoutRect();
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
    // Treat a non-drag as "start over": restore the initial dim + hint.
    rect = null;
    sel.style.display = 'none';
    dims.style.display = 'none';
    backdrop.style.display = 'block';
    hint.style.display = 'block';
    return;
  }
  showToolbar();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
  else if (e.key === 'Enter') confirm();
});

recordBtn.addEventListener('click', confirm);
cancelBtn.addEventListener('click', cancel);
