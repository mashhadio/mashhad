'use strict';

// Click-through outline shown over the recorded region while recording. The
// region (DIP, relative to this display's top-left) arrives via the query string
// since this window owns no IPC channel. Coordinates equal CSS px here because
// the window exactly covers the display — same space the cropper uses.

const p = new URLSearchParams(location.search);
const x = parseFloat(p.get('x'));
const y = parseFloat(p.get('y'));
const w = parseFloat(p.get('w'));
const h = parseFloat(p.get('h'));

if ([x, y, w, h].every((n) => Number.isFinite(n))) {
  const B = 3; // border width — draw the line just outside the crop
  const frame = document.getElementById('frame');
  frame.style.display = 'block';
  frame.style.left = x - B + 'px';
  frame.style.top = y - B + 'px';
  frame.style.width = w + 2 * B + 'px';
  frame.style.height = h + 2 * B + 'px';

  document.getElementById('pillSize').textContent = `${Math.round(w)} × ${Math.round(h)}`;
  const pill = document.getElementById('pill');
  pill.style.display = 'inline-flex';
  // Sit just above the region; drop inside the top edge if there's no room.
  const above = y - 30;
  pill.style.left = x + 'px';
  pill.style.top = (above < 4 ? y + 6 : above) + 'px';
}
