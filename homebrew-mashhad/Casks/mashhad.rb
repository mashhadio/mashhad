cask "mashhad" do
  # Apple Silicon and Intel get separate builds — `arch` picks the right one and
  # substitutes into the url below as #{arch}.
  arch arm: "arm64", intel: "x64"

  version "1.0.0"

  # Refresh both on every release, from the published assets:
  #   shasum -a 256 Mashhad-<version>-arm64.dmg Mashhad-<version>-x64.dmg
  sha256 arm:   "8d00ee1aa7fdee1911f64d9a632ca8148df3a35b6773ad7b45762d11d77277ac",
         intel: "1abe7f43e63a7104c4382c19cad21f188b3405257bd94a194202ffdf549d1536"

  # Attached to the tagged release in the public mashhad-releases repo, so Homebrew can
  # verify the sha256 against a URL that never changes under it.
  url "https://github.com/mashhadio/mashhad-releases/releases/download/v#{version}/Mashhad-#{version}-#{arch}.dmg"
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
