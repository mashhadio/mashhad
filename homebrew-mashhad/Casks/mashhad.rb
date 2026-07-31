cask "mashhad" do
  # Apple Silicon and Intel get separate builds — `arch` picks the right one and
  # substitutes into the url below as #{arch}.
  arch arm: "arm64", intel: "x64"

  version "1.0.2"

  # Refresh both on every release, from the published assets:
  #   shasum -a 256 Mashhad-<version>-arm64.dmg Mashhad-<version>-x64.dmg
  sha256 arm:   "a346aaf9f0b5afdb08baa80e4f33660a6562285e411a2ea5afe7d633bedfb0e4",
         intel: "049a4adf73856b2d12a048f38a3552065f8a499337ad365f0bb4e9bc2bad9dda"

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
