'use strict';

// Tiny content-protected badge showing the active recording scene. The main
// process sets the initial scene via the query string and updates it on each
// switch by calling window.setScene(...) through executeJavaScript.

const LABELS = { screen: '🖥 الشاشة', cam: '🎥 الكاميرا', both: '🖥 + 🎥' };

function setScene(scene) {
  const el = document.getElementById('label');
  if (el) el.textContent = LABELS[scene] || scene;
}
window.setScene = setScene;

setScene(new URLSearchParams(location.search).get('scene') || 'screen');
