'use strict';

// Tiny content-protected badge showing the active recording scene. The main
// process sets the initial scene via the query string and updates it on each
// switch over IPC (via the scene-indicator preload).

const LABELS = { screen: '🖥 الشاشة', cam: '🎥 الكاميرا', both: '🖥 + 🎥' };

function setScene(scene) {
  const el = document.getElementById('label');
  if (el) el.textContent = LABELS[scene] || scene;
}

if (window.sceneIndicatorApi) window.sceneIndicatorApi.onSetScene(setScene);

setScene(new URLSearchParams(location.search).get('scene') || 'screen');
