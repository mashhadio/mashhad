'use strict';

// Tiny preferences helper backed by the main-process settings.json.
// Load once, then get/set individual keys (set persists immediately).
(function (g) {
  let cache = {};
  g.Prefs = {
    async load() {
      try {
        cache = (await window.api.getSettings()) || {};
      } catch (_) {
        cache = {};
      }
      return cache;
    },
    get(key, fallback) {
      return cache && Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
    },
    set(key, value) {
      cache[key] = value;
      try {
        window.api.setSettings({ [key]: value });
      } catch (_) {}
    },
  };
})(window);
