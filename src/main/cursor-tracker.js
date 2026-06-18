'use strict';

// Global cursor + click capture using uiohook-napi. Coordinates are normalised
// to 0..1 relative to the recorded display so the editor can map them onto the
// recorded video regardless of resolution.

let uIOhook = null;
try {
  ({ uIOhook } = require('uiohook-napi'));
} catch (err) {
  console.error('uiohook-napi unavailable:', err.message);
}

let active = false;
let recBase = 0;
let displayPhys = { x: 0, y: 0, w: 1920, h: 1080 };
let samples = [];
let clicks = [];

let moveHandler = null;
let downHandler = null;

function setDisplay(display, region) {
  // Electron bounds are always in DIP (logical points). uiohook reports mouse
  // coordinates in the OS global mouse space, whose units differ by platform:
  //   - Windows / Linux: physical pixels  -> scale DIP up by the scale factor.
  //   - macOS:           logical points   -> already matches DIP, do NOT scale.
  // Scaling on macOS divides clicks by an extra `scaleFactor`, squashing every
  // click into the top-left 1/sf of the frame (the offset bug on Retina).
  const sf = process.platform === 'darwin' ? 1 : (display.scaleFactor || 1);
  const b = display.bounds;
  // When recording a sub-region, normalise clicks relative to it (its top-left
  // is `bounds + region.offset`, in DIP) so 0..1 spans the cropped video.
  const ox = region ? b.x + region.x : b.x;
  const oy = region ? b.y + region.y : b.y;
  const w = region ? region.w : b.width;
  const h = region ? region.h : b.height;
  displayPhys = {
    x: ox * sf,
    y: oy * sf,
    w: Math.max(1, w * sf),
    h: Math.max(1, h * sf),
  };
}

function norm(e) {
  const x = (e.x - displayPhys.x) / displayPhys.w;
  const y = (e.y - displayPhys.y) / displayPhys.h;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function startCursorTracking(recBaseEpoch, display, region) {
  if (!uIOhook) return;
  if (active) stopCursorTracking();

  recBase = recBaseEpoch;
  if (display) setDisplay(display, region);
  samples = [];
  clicks = [];
  active = true;

  let lastSampleT = -1;

  moveHandler = (e) => {
    const t = Date.now() - recBase;
    if (t < 0) return;
    // Throttle to ~120Hz max to keep the log small.
    if (t - lastSampleT < 8) return;
    lastSampleT = t;
    const n = norm(e);
    samples.push({ t, x: n.x, y: n.y });
  };

  downHandler = (e) => {
    const t = Date.now() - recBase;
    if (t < 0) return;
    const n = norm(e);
    clicks.push({ t, x: n.x, y: n.y, button: e.button });
    samples.push({ t, x: n.x, y: n.y }); // ensure a sample exists at the click
  };

  uIOhook.on('mousemove', moveHandler);
  uIOhook.on('mousedown', downHandler);

  try {
    uIOhook.start();
  } catch (err) {
    console.error('uiohook start failed:', err.message);
    active = false;
  }
}

function stopCursorTracking() {
  if (!uIOhook || !active) return { samples: samples || [], clicks: clicks || [] };
  active = false;
  try {
    if (moveHandler) uIOhook.off('mousemove', moveHandler);
    if (downHandler) uIOhook.off('mousedown', downHandler);
    uIOhook.stop();
  } catch (err) {
    console.error('uiohook stop failed:', err.message);
  }
  const result = { samples, clicks };
  return result;
}

// Clear any retained cursor data without starting capture (used for window
// captures, where global cursor coordinates don't map onto the recording).
function resetCursorTracking() {
  if (active) stopCursorTracking();
  samples = [];
  clicks = [];
}

module.exports = { startCursorTracking, stopCursorTracking, resetCursorTracking };
