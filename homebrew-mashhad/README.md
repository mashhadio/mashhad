# homebrew-mashhad

Homebrew **tap** for [مشهد (Mashhad)](https://gitlab.com/abdu.medhat94/smooth-screen-record) — the macOS distribution + update channel.

> This folder is a **scaffold**. Push its contents to a new **public** repo named
> `homebrew-mashhad` under your account (the `homebrew-` prefix is required for
> `brew tap` to find it). The source app repo can stay private.

## Install (users)

```sh
brew tap abdu.medhat94/mashhad https://gitlab.com/abdu.medhat94/homebrew-mashhad.git
brew install --cask mashhad
```

## Update (users)

```sh
brew upgrade --cask mashhad
```

Homebrew compares the installed version against `version` in `Casks/mashhad.rb`;
when you publish a newer cask, `brew upgrade` pulls the new `.dmg`.

## Publishing a new macOS version (maintainer)

Do this **on a Mac** (macOS builds can't be cross-compiled):

```sh
# in the app repo, on the Mac:
npm run dist:mac                 # produces dist/Mashhad-<version>-arm64.dmg (+ .zip)
RELEASES_TOKEN=<token> npm run publish   # uploads dmg/zip to mashhad-releases

# then bump this cask:
shasum -a 256 dist/Mashhad-<version>-arm64.dmg   # copy the hash
#   -> edit Casks/mashhad.rb: set `version` and `sha256`
git commit -am "mashhad <version>" && git push
```

`version`, the app repo's git tag, and the uploaded filename must all match.

## Notes

- The `.dmg` URL points at the **public** `mashhad-releases` generic Package
  Registry (version-pinned), so no credentials are needed to download.
- The app is **unsigned** for now, so the cask's `postflight` strips the Gatekeeper
  quarantine attribute. Once you sign + notarize, delete that block.
- Intel + Apple Silicon: build both arches and use the `on_arm`/`on_intel` form
  shown in the cask comments (two `url`/`sha256` pairs).
