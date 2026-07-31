/* ==========================================================================
   مشهد (Mashhad) — analytics
   Paste your GA4 Measurement ID into GA_ID to switch tracking on. While it's
   empty nothing is loaded and nothing is sent, so this file is safe to ship
   disabled. This whole file is public (the site deploys verbatim) — a GA4
   measurement ID is not a secret, but never put anything here that is.
   ========================================================================== */
(function(){
  var GA_ID = ""; // e.g. "G-XXXXXXXXXX"
  if(!GA_ID) return;

  // Standard gtag.js bootstrap.
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_ID);
  (document.head || document.documentElement).appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID);

  // Every download leaves for github.com, so page views alone say nothing about
  // conversion. Delegated from document so it covers links whose href is filled
  // in later by release.js, on both pages, without per-button wiring.
  document.addEventListener("click", function(e){
    var el = e.target;
    var a = el && el.closest ? el.closest("a[href]") : null;
    if(a){
      var href = a.getAttribute("href") || "";
      if(href.indexOf("releases/download/") !== -1){
        gtag("event", "download", {
          file_name: href.split("/").pop(),
          link_url: href
        });
      }
      return;
    }
    // Copying the brew command is the closest thing to a "Homebrew install"
    // signal the site can see — the install itself happens in a terminal.
    var btn = el && el.closest ? el.closest("button.copy") : null;
    if(btn){ gtag("event", "brew_copy"); }
  }, true);
})();
