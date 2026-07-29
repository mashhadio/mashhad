/* ==========================================================================
   مشهد (Mashhad) — shared release config
   Edit VERSION / file names / sizes here to match a published release.
   Used by index.html and download.html.
   ========================================================================== */
(function(){
  var VERSION = "0.1.0";
  // Public release channel (GitLab generic Package Registry).
  var BASE = "https://gitlab.com/api/v4/projects/abdu.medhat94%2Fmashhad-releases/packages/generic/mashhad/latest";

  var FILES = {
    win:   { name: "Mashhad-" + VERSION + "-x64.exe",        size: "~95 م.ب", url: BASE + "/Mashhad-" + VERSION + "-x64.exe" },
    mac:   { name: "Mashhad-" + VERSION + "-arm64.dmg",      size: "~110 م.ب", url: BASE + "/Mashhad-" + VERSION + "-arm64.dmg" },
    linux: { name: "Mashhad-" + VERSION + "-x86_64.AppImage", size: "~100 م.ب", url: BASE + "/Mashhad-" + VERSION + "-x86_64.AppImage" },
    deb:   { name: "Mashhad-" + VERSION + "-amd64.deb",      size: "~98 م.ب",  url: BASE + "/Mashhad-" + VERSION + "-amd64.deb" }
  };

  var LABELS = { win: "ويندوز", mac: "ماك", linux: "لينكس" };

  var BREW = "brew install --cask abdu.medhat94/mashhad/mashhad";
  var BREW_UPGRADE = "brew upgrade --cask mashhad";

  function detectOS(){
    var d = (navigator.userAgentData && navigator.userAgentData.platform) || "";
    var s = (d + " " + navigator.platform + " " + navigator.userAgent).toLowerCase();
    if(/win/.test(s)) return "win";
    if(/mac|iphone|ipad|ios/.test(s)) return "mac";
    if(/linux|x11|ubuntu|android/.test(s)) return "linux";
    return "win";
  }

  window.MASHHAD = {
    VERSION: VERSION,
    FILES: FILES,
    LABELS: LABELS,
    BREW: BREW,
    BREW_UPGRADE: BREW_UPGRADE,
    detectOS: detectOS
  };
})();
