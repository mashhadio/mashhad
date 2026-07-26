cask "mashhad" do
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  # The .dmg is served from the public mashhad-releases generic Package Registry,
  # version-pinned so Homebrew can verify the sha256. Built on a Mac and uploaded
  # via `npm run publish` (see the releases project).
  url "https://gitlab.com/api/v4/projects/abdu.medhat94%2Fmashhad-releases/packages/generic/mashhad/#{version}/Mashhad-#{version}-arm64.dmg"
  name "مشهد"
  name "Mashhad"
  desc "Screen recorder with cursor-tracking smooth zoom and mic noise cleanup"
  homepage "https://gitlab.com/abdu.medhat94/smooth-screen-record"

  # If you also ship an Intel build, replace the single url/sha256 above with:
  #   on_arm  do; sha256 "..."; url ".../Mashhad-#{version}-arm64.dmg"; end
  #   on_intel do; sha256 "..."; url ".../Mashhad-#{version}-x64.dmg";  end

  app "مشهد.app"

  # The build is unsigned (no Apple Developer certificate yet), so macOS quarantines
  # it and shows "app is damaged / can't be opened". Strip the quarantine attribute
  # on install so it launches cleanly. Remove this block once the app is signed +
  # notarized.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/مشهد.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/مشهد",
    "~/Library/Preferences/com.abdul.mashhad.plist",
    "~/Library/Saved Application State/com.abdul.mashhad.savedState",
    "~/Library/Logs/مشهد",
  ]
end
