cask "mashhad" do
  # Apple Silicon and Intel get separate builds — `arch` picks the right one and
  # substitutes into the url below as #{arch}.
  arch arm: "arm64", intel: "x64"

  version "1.0.5"

  # Refresh both on every release, from the published assets:
  #   shasum -a 256 Mashhad-arm64.dmg Mashhad-x64.dmg
  sha256 arm:   "2130f38850b77d164179c31f00f05a818d942f26a5f711fb44457d5ad66d8f86",
         intel: "149c4575a23fcb1261c0127288b789a8ddfaf39e4cb6ac3f865e4a7454fc8c11"

  # Attached to the tagged release in the public mashhad-releases repo, so Homebrew can
  # verify the sha256 against a URL that never changes under it. The filename carries no
  # version — the tag in the path already pins it — but it must keep #{arch}: both macOS
  # builds land in the same release and a bare Mashhad.dmg would collide. Renamed as of
  # 1.0.5; do not point this at 1.0.2 or earlier, whose assets are Mashhad-<version>-<arch>.dmg.
  url "https://github.com/mashhadio/mashhad-releases/releases/download/v#{version}/Mashhad-#{arch}.dmg"
  name "مشهد"
  name "Mashhad"
  desc "Screen recorder with cursor-tracking smooth zoom and mic noise cleanup"
  homepage "https://mashhad.io"

  # Symbol form already means ">= catalina"; the string form is deprecated and
  # prints a warning on every `brew` invocation that touches the tap.
  depends_on macos: :catalina

  # The bundle inside the .dmg is "Mashhad.app" (electron-builder falls back to
  # `executableName` for the bundle filename because productName is non-ASCII).
  # Its CFBundleName is still "مشهد", which is what Finder and the menu bar show.
  # This must be the on-disk filename or Homebrew fails with "App source ... is not there".
  app "Mashhad.app"

  # The build is unsigned (no Apple Developer certificate yet), so macOS quarantines
  # it and shows "app is damaged / can't be opened". Strip the quarantine attribute
  # on install so it launches cleanly. Remove this block once the app is signed +
  # notarized.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Mashhad.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/مشهد",
    "~/Library/Preferences/com.abdul.mashhad.plist",
    "~/Library/Saved Application State/com.abdul.mashhad.savedState",
    "~/Library/Logs/مشهد",
  ]
end
