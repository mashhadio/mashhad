/* ==========================================================================
   مشهد (Mashhad) — shared release config
   Edit VERSION / file names / sizes here to match a published release.
   Used by index.html and download.html.
   ========================================================================== */
(function(){
  var VERSION = "1.0.0";

  // GitHub account that owns the PUBLIC `mashhad-releases` + `homebrew-mashhad`
  // repos. Change this one line if the account changes — everything below
  // (downloads + brew commands) is derived from it.
  var OWNER = "mashhadio";

  // Assets attached to the tagged GitHub release.
  var BASE = "https://github.com/" + OWNER + "/mashhad-releases/releases/download/v" + VERSION;

  // Sizes are approximate — refresh them from dist/ after each real build.
  var FILES = {
    win:       { name: "Mashhad-" + VERSION + "-x64.exe",         size: "~95 م.ب",  url: BASE + "/Mashhad-" + VERSION + "-x64.exe" },
    mac_arm64: { name: "Mashhad-" + VERSION + "-arm64.dmg",       size: "~130 م.ب", url: BASE + "/Mashhad-" + VERSION + "-arm64.dmg" },
    mac_x64:   { name: "Mashhad-" + VERSION + "-x64.dmg",         size: "~130 م.ب", url: BASE + "/Mashhad-" + VERSION + "-x64.dmg" },
    linux:     { name: "Mashhad-" + VERSION + "-x86_64.AppImage", size: "~100 م.ب", url: BASE + "/Mashhad-" + VERSION + "-x86_64.AppImage" },
    deb:       { name: "Mashhad-" + VERSION + "-amd64.deb",       size: "~98 م.ب",  url: BASE + "/Mashhad-" + VERSION + "-amd64.deb" }
  };

  var LABELS = { win: "ويندوز", mac: "ماك", linux: "لينكس" };

  // The tap is on GitHub, so Homebrew resolves the bare `owner/tap/cask` shorthand
  // on its own — no explicit `brew tap` step needed.
  var BREW = "brew install --cask " + OWNER + "/mashhad/mashhad";
  var BREW_UPGRADE = "brew upgrade --cask mashhad";

  // The .dmg is unsigned (no Apple Developer certificate), so Gatekeeper quarantines
  // a direct download. Homebrew strips that automatically; a manual install needs this.
  var MAC_QUARANTINE = 'xattr -dr com.apple.quarantine "/Applications/مشهد.app"';

  function detectOS(){
    var d = (navigator.userAgentData && navigator.userAgentData.platform) || "";
    var s = (d + " " + navigator.platform + " " + navigator.userAgent).toLowerCase();
    if(/win/.test(s)) return "win";
    if(/mac|iphone|ipad|ios/.test(s)) return "mac";
    if(/linux|x11|ubuntu|android/.test(s)) return "linux";
    return "win";
  }

  // Apple Silicon vs Intel. Browsers report "MacIntel" on both, so fall back to the
  // WebGL renderer string ("Apple M1/M2/GPU" vs "Intel/AMD/Radeon"). Best-effort only —
  // the download page always shows both builds, this just picks the default.
  function detectMacArch(){
    try {
      var cvs = document.createElement("canvas");
      var gl = cvs.getContext("webgl") || cvs.getContext("experimental-webgl");
      if(gl){
        var ext = gl.getExtension("WEBGL_debug_renderer_info");
        var r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
        if(/intel|amd|radeon|nvidia|geforce/i.test(r)) return "x64";
        if(/apple/i.test(r)) return "arm64";
      }
    } catch(_){}
    return "arm64"; // every Mac shipped since late 2020 is Apple Silicon
  }

  // index.html asks for FILES[os] — resolve "mac" to the visitor's likely build.
  FILES.mac = detectOS() === "mac" && detectMacArch() === "x64" ? FILES.mac_x64 : FILES.mac_arm64;

  window.MASHHAD = {
    VERSION: VERSION,
    FILES: FILES,
    LABELS: LABELS,
    BREW: BREW,
    BREW_UPGRADE: BREW_UPGRADE,
    MAC_QUARANTINE: MAC_QUARANTINE,
    detectOS: detectOS,
    detectMacArch: detectMacArch
  };
})();
