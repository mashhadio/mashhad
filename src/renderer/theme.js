'use strict';

// Light / night theme switch. Loaded synchronously in <head> so the saved theme
// is applied to <html> before first paint (no flash). Persisted in localStorage
// so it survives restarts and is shared by the recorder and editor windows.
(function () {
  var KEY = 'mashhad-theme';

  function current() {
    try { return localStorage.getItem(KEY) || 'dark'; } catch (_) { return 'dark'; }
  }
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  // Runs immediately on load (head, render-blocking) → applied before body paints.
  apply(current());

  function wire() {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    function refresh() {
      var light = current() === 'light';
      // Show the mode you'll switch TO.
      btn.textContent = light ? '🌙' : '☀️';
      btn.title = light ? 'التبديل إلى الوضع الليلي' : 'التبديل إلى الوضع النهاري';
    }
    refresh();
    btn.addEventListener('click', function () {
      var next = current() === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(KEY, next); } catch (_) {}
      apply(next);
      refresh();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
