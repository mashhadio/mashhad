/* ==========================================================================
   مشهد (Mashhad) — shared release config
   Edit VERSION / file names / sizes here to match a published release.
   Used by index.html and download.html.
   ========================================================================== */
(function(){
  var VERSION = "1.0.6";

  // GitHub account that owns the PUBLIC `mashhad-releases` + `homebrew-mashhad`
  // repos. Change this one line if the account changes — everything below
  // (downloads + brew commands) is derived from it.
  var OWNER = "mashhadio";

  // Assets attached to the tagged GitHub release.
  var BASE = "https://github.com/" + OWNER + "/mashhad-releases/releases/download/v" + VERSION;

  // Asset names must match build.artifactName / build.mac.artifactName in package.json.
  // The version is not in the filename — it is already in BASE, which is built from the
  // tag. Only macOS carries an arch suffix, because its two builds share one release and
  // would otherwise overwrite each other.
  // Sizes shown next to the download buttons. Refresh from the PUBLISHED release, not
  // from a guess — these had drifted badly (Linux was advertised at ~100 م.ب against a
  // real 140). One command, after publishing:
  //   gh api repos/mashhadio/mashhad-releases/releases --jq \
  //     '.[] | select(.tag_name=="vX.Y.Z") | .assets[] | "\(.name) \((.size/1048576)|floor)"'
  // Measured on 1.0.6.
  var FILES = {
    win:       { name: "Mashhad.exe",        size: "~103 م.ب", url: BASE + "/Mashhad.exe" },
    mac_arm64: { name: "Mashhad-arm64.dmg",  size: "~118 م.ب", url: BASE + "/Mashhad-arm64.dmg" },
    mac_x64:   { name: "Mashhad-x64.dmg",    size: "~130 م.ب", url: BASE + "/Mashhad-x64.dmg" },
    linux:     { name: "Mashhad.AppImage",   size: "~140 م.ب", url: BASE + "/Mashhad.AppImage" },
    deb:       { name: "Mashhad.deb",        size: "~94 م.ب",  url: BASE + "/Mashhad.deb" }
  };

  var LABELS = { win: "ويندوز", mac: "ماك", linux: "لينكس" };

  // One command. The fully-qualified owner/tap/cask path is what makes it one:
  // Homebrew 6 auto-taps it, and records trust for this cask automatically, so no
  // separate `brew tap` or `brew trust` step is needed.
  //
  // Do NOT "simplify" this to `brew tap … && brew install mashhad`. Tapping
  // explicitly leaves the tap present-but-untrusted, and the short name is then
  // refused with "Refusing to load cask ... from untrusted tap" — which is exactly
  // what the shorter-looking form used to do to people.
  //
  // After this runs the tap is registered and trusted, so the short name works from
  // then on — hence BREW_UPGRADE below needs no path and no `--cask`.
  var BREW_INSTALL = "brew install " + OWNER + "/mashhad/mashhad";
  var BREW = BREW_INSTALL;
  var BREW_UPGRADE = "brew upgrade mashhad";

  // The .dmg is unsigned (no Apple Developer certificate), so Gatekeeper quarantines
  // a direct download. Homebrew strips that automatically; a manual install needs this.
  //
  // Ordering matters on macOS 15+: this must run BEFORE the first launch. An unsigned,
  // quarantined app that gets double-clicked first is blocked and moved to the Trash
  // outright ("Malware Blocked and Moved to Trash") — there is no "open anyway" escape
  // hatch left, so the user has to restore it from the Trash and then run this.
  //
  // The bundle on disk is Mashhad.app — only its display name (CFBundleName) is مشهد,
  // so the Arabic name will not match a path here.
  var MAC_QUARANTINE = 'xattr -dr com.apple.quarantine /Applications/Mashhad.app';

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
    BREW_INSTALL: BREW_INSTALL,
    BREW_UPGRADE: BREW_UPGRADE,
    MAC_QUARANTINE: MAC_QUARANTINE,
    detectOS: detectOS,
    detectMacArch: detectMacArch
  };
})();
