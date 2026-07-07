'use strict';

// Drag-to-select overlay. Coordinates are CSS pixels within this window, which
// is sized to exactly cover one display, so they equal DIP offsets relative to
// that display's top-left — the same space cursor-tracker and the cropper use.
//
// After a box is drawn it can be repositioned (drag inside it) and resized (drag
// a handle). When a platform format passes a locked aspect, resizing keeps that
// ratio unless Shift is held, which frees it.

const backdrop = document.getElementById('backdrop');
const hint = document.getElementById('hint');
const sel = document.getElementById('sel');
const dims = document.getElementById('dims');
const toolbar = document.getElementById('toolbar');
const recordBtn = document.getElementById('recordBtn');
const cancelBtn = document.getElementById('cancelBtn');

const MIN_SIZE = 16; // smallest allowed selection / ignore stray clicks
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const W = () => window.innerWidth;
const H = () => window.innerHeight;

// When a platform format is chosen the home screen passes a locked aspect (w/h)
// via the query string.
const ASPECT = (() => {
  const a = parseFloat(new URLSearchParams(location.search).get('aspect'));
  return Number.isFinite(a) && a > 0 ? a : null;
})();

hint.innerHTML = ASPECT
  ? 'اسحب لتحديد منطقة &nbsp;·&nbsp; النسبة مثبّتة (<b>Shift</b> للتحرّر) &nbsp;·&nbsp; اسحب الإطار لتحريكه أو المقابض لتغيير الحجم &nbsp;·&nbsp; <b>Esc</b>'
  : 'اسحب لتحديد منطقة &nbsp;·&nbsp; اسحب الإطار لتحريكه أو المقابض لتغيير الحجم &nbsp;·&nbsp; <b>Esc</b> للإلغاء';

// Resize handles live inside the selection box so they move with it.
const handleEls = {};
HANDLES.forEach((h) => {
  const el = document.createElement('div');
  el.className = `handle h-${h}`;
  el.dataset.h = h;
  sel.appendChild(el);
  handleEls[h] = el;
});

let mode = null; // 'draw' | 'move' | 'resize' | null
let handle = null; // active handle during a resize
let startMouse = { x: 0, y: 0 }; // pointer at gesture start
let startRect = null; // selection snapshot at gesture start
let rect = null; // { x, y, w, h } in this window's CSS px

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Aspect stays locked while a format is set unless the user holds Shift.
function aspectActive(shift) {
  return ASPECT && !shift;
}

// Named to avoid shadowing the native window.confirm/cancel-adjacent globals
// (this is a classic, non-module script, so a top-level `function confirm()`
// would otherwise shadow window.confirm for this whole window).
function confirmSelection() {
  if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) return;
  window.regionApi.send({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  });
}

function cancelSelection() {
  window.regionApi.send(null);
}

function showSelection() {
  backdrop.style.display = 'none';
  hint.style.display = 'none';
  sel.style.display = 'block';
  dims.style.display = 'block';
}

function resetToStart() {
  rect = null;
  sel.style.display = 'none';
  dims.style.display = 'none';
  toolbar.style.display = 'none';
  backdrop.style.display = 'block';
  hint.style.display = 'block';
}

function layout() {
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
  const flip = tbTop + 50 > H();
  toolbar.style.left = rect.x + 'px';
  toolbar.style.top = (flip ? rect.y - 54 : tbTop) + 'px';
}

// ---------------------------------------------------------------------------
// Gesture math
// ---------------------------------------------------------------------------

// Fresh draw: grow from the anchor toward the pointer, aspect-locked + clamped
// to the display when a format is active.
function computeDraw(mx, my, shift) {
  const sx = startMouse.x;
  const sy = startMouse.y;
  if (aspectActive(shift)) {
    const dirX = mx >= sx ? 1 : -1;
    const dirY = my >= sy ? 1 : -1;
    let w = Math.abs(mx - sx);
    let h = Math.abs(my - sy);
    if (w / h > ASPECT) h = w / ASPECT; else w = h * ASPECT;
    const maxW = dirX > 0 ? W() - sx : sx;
    const maxH = dirY > 0 ? H() - sy : sy;
    if (w > maxW) { w = maxW; h = w / ASPECT; }
    if (h > maxH) { h = maxH; w = h * ASPECT; }
    rect = { x: dirX > 0 ? sx : sx - w, y: dirY > 0 ? sy : sy - h, w, h };
  } else {
    rect = {
      x: Math.min(sx, mx),
      y: Math.min(sy, my),
      w: Math.abs(mx - sx),
      h: Math.abs(my - sy),
    };
  }
}

// Move: translate the box, keeping it fully on the display.
function computeMove(dx, dy) {
  rect = {
    x: clamp(startRect.x + dx, 0, W() - startRect.w),
    y: clamp(startRect.y + dy, 0, H() - startRect.h),
    w: startRect.w,
    h: startRect.h,
  };
}

// Resize from a handle. Free-form first, then snapped to aspect when locked.
function computeResize(mx, my, shift) {
  const r0 = startRect;
  let left = r0.x;
  let top = r0.y;
  let right = r0.x + r0.w;
  let bottom = r0.y + r0.h;

  if (handle.includes('w')) left = Math.min(mx, right - MIN_SIZE);
  if (handle.includes('e')) right = Math.max(mx, left + MIN_SIZE);
  if (handle.includes('n')) top = Math.min(my, bottom - MIN_SIZE);
  if (handle.includes('s')) bottom = Math.max(my, top + MIN_SIZE);

  let w = right - left;
  let h = bottom - top;
  let x = left;
  let y = top;

  if (aspectActive(shift)) {
    // Each branch fits the box to the ratio and records how to place it relative
    // to its anchor (a fixed edge, or the box's centre for edge handles):
    //   'min'    → anchored edge stays put            (x = v)
    //   'max'    → opposite edge stays put            (x = v - size)
    //   'center' → box stays centred on the axis      (x = v - size / 2)
    let axMode; let axV; let ayMode; let ayV;

    if (handle.length === 2) {
      // Corner: the opposite corner is the anchor.
      const fixedLeft = !handle.includes('w');
      const fixedTop = !handle.includes('n');
      if (w / h > ASPECT) h = w / ASPECT; else w = h * ASPECT;
      axV = fixedLeft ? left : right; axMode = fixedLeft ? 'min' : 'max';
      ayV = fixedTop ? top : bottom; ayMode = fixedTop ? 'min' : 'max';
      const maxW = fixedLeft ? W() - axV : axV;
      const maxH = fixedTop ? H() - ayV : ayV;
      if (w > maxW) { w = maxW; h = w / ASPECT; }
      if (h > maxH) { h = maxH; w = h * ASPECT; }
    } else if (handle === 'n' || handle === 's') {
      // Vertical edge drives height; width follows, centred on the box's x.
      w = h * ASPECT;
      const cx = r0.x + r0.w / 2;
      const maxWByCenter = 2 * Math.min(cx, W() - cx);
      if (w > maxWByCenter) { w = maxWByCenter; h = w / ASPECT; }
      ayV = handle === 'n' ? bottom : top; ayMode = handle === 'n' ? 'max' : 'min';
      const maxH = handle === 'n' ? ayV : H() - ayV;
      if (h > maxH) { h = maxH; w = h * ASPECT; }
      axMode = 'center'; axV = cx;
    } else {
      // Horizontal edge drives width; height follows, centred on the box's y.
      h = w / ASPECT;
      const cy = r0.y + r0.h / 2;
      const maxHByCenter = 2 * Math.min(cy, H() - cy);
      if (h > maxHByCenter) { h = maxHByCenter; w = h * ASPECT; }
      axV = handle === 'w' ? right : left; axMode = handle === 'w' ? 'max' : 'min';
      const maxW = handle === 'w' ? axV : W() - axV;
      if (w > maxW) { w = maxW; h = w / ASPECT; }
      ayMode = 'center'; ayV = cy;
    }

    // Never let the ratio math drive either side below the minimum, or the box
    // becomes unconfirmable (e.g. a 9:16 box at 16px tall would be 9px wide).
    // Both sides cross the threshold together, so clamping preserves the ratio.
    w = Math.max(w, MIN_SIZE * Math.max(1, ASPECT));
    h = Math.max(h, MIN_SIZE * Math.max(1, 1 / ASPECT));

    x = axMode === 'min' ? axV : axMode === 'max' ? axV - w : axV - w / 2;
    y = ayMode === 'min' ? ayV : ayMode === 'max' ? ayV - h : ayV - h / 2;
  } else {
    // Free resize — keep the box on the display.
    x = clamp(x, 0, W());
    y = clamp(y, 0, H());
    w = Math.min(w, W() - x);
    h = Math.min(h, H() - y);
  }

  rect = { x, y, w, h };
}

// ---------------------------------------------------------------------------
// Pointer handling
// ---------------------------------------------------------------------------
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (toolbar.contains(e.target)) return; // toolbar owns its own clicks
  startMouse = { x: e.clientX, y: e.clientY };
  toolbar.style.display = 'none';

  if (rect && e.target.classList.contains('handle')) {
    mode = 'resize';
    handle = e.target.dataset.h;
    startRect = { ...rect };
  } else if (rect && e.target === sel) {
    mode = 'move';
    startRect = { ...rect };
  } else {
    mode = 'draw';
    rect = { x: startMouse.x, y: startMouse.y, w: 0, h: 0 };
    sel.classList.add('drawing'); // hide handles mid-draw
    showSelection();
    layout();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!mode) return;
  const mx = clamp(e.clientX, 0, W());
  const my = clamp(e.clientY, 0, H());
  if (mode === 'draw') computeDraw(mx, my, e.shiftKey);
  else if (mode === 'move') computeMove(e.clientX - startMouse.x, e.clientY - startMouse.y);
  else computeResize(mx, my, e.shiftKey);
  layout();
});

window.addEventListener('mouseup', () => {
  if (!mode) return;
  const wasDraw = mode === 'draw';
  mode = null;
  handle = null;
  sel.classList.remove('drawing');

  if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
    // A non-drag (or a too-small box) resets to the initial prompt.
    if (wasDraw) resetToStart();
    return;
  }
  showToolbar();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelSelection();
  else if (e.key === 'Enter') confirmSelection();
});

recordBtn.addEventListener('click', confirmSelection);
cancelBtn.addEventListener('click', cancelSelection);
