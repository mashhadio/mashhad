/* ==========================================================================
   مشهد (Mashhad) — analytics

   Fill in either token to switch a provider on; leave both empty and nothing is
   loaded or sent. Enabling both is fine — they don't interfere.

   CF_TOKEN — Cloudflare Web Analytics. Cookieless, so no consent banner, and
              blocked far less often than GA. Page views / referrers / countries
              only: it has no custom events, so the download split has to come
              from GitHub's per-asset download_count (which is server-side and
              can't be blocked at all — better data than any beacon).
   GA_ID    — Google Analytics 4. More capable, but cookie-based (consent banner
              if you expect EU traffic) and blocked by Brave and uBlock, so
              expect a meaningful undercount. Only GA records the custom events
              below.

   This file is public — the site deploys verbatim. Both of these tokens are
   meant to be public; never put anything here that isn't.
   ========================================================================== */
(function(){
  var CF_TOKEN = ""; // e.g. "a1b2c3d4e5f6..."
  var GA_ID    = ""; // e.g. "G-XXXXXXXXXX"

  var head = document.head || document.documentElement;

  // --- Cloudflare Web Analytics -------------------------------------------
  // The beacon reads its own tag's data-cf-beacon, so the attribute has to be
  // set before the element is appended.
  if(CF_TOKEN){
    var cf = document.createElement("script");
    cf.defer = true;
    cf.src = "https://static.cloudflareinsights.com/beacon.min.js";
    cf.setAttribute("data-cf-beacon", JSON.stringify({ token: CF_TOKEN }));
    head.appendChild(cf);
  }

  // --- Google Analytics 4 --------------------------------------------------
  if(!GA_ID) return;

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_ID);
  head.appendChild(s);

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
