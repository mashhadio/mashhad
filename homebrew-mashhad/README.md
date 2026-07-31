# homebrew-mashhad

Homebrew **tap** for [مشهد (Mashhad)](https://github.com/mashhadio/mashhad-releases) — the macOS distribution + update channel.

> This folder is a **scaffold**. Push its contents to the public
> [`mashhadio/homebrew-mashhad`](https://github.com/mashhadio/homebrew-mashhad) repo
> (the `homebrew-` prefix is what lets `brew tap` find it).

## Install (users)

```sh
brew install mashhadio/mashhad/mashhad
```

That's the whole thing — no `brew tap`, no `brew trust`, no `--cask`. The
fully-qualified `owner/tap/cask` path makes Homebrew 6 auto-tap the repo *and*
record trust for this cask in `~/.homebrew/trust.json`.

**Don't shorten it to `brew tap … && brew install mashhad`.** Tapping explicitly
leaves the tap present-but-untrusted, and the short name is then rejected:

```
Error: Refusing to load cask mashhadio/mashhad/mashhad from untrusted tap mashhadio/mashhad.
```

Recovering from that needs a `brew trust` call, so the shorter-looking form is
actually the three-step one.

## Update (users)

```sh
brew upgrade mashhad
```

The short name works here because the install above already registered and
trusted the tap.

Homebrew compares the installed version against `version` in `Casks/mashhad.rb`;
when you publish a newer cask, `brew upgrade` pulls the new `.dmg`.

## Publishing a new macOS version (maintainer)

macOS builds can't be cross-compiled from Linux or Windows — they run either on a Mac
or on a `macos-*` CI runner.

```sh
# in the app repo — builds arm64 and x64 back to back and uploads both:
GH_TOKEN=<token> npm run release:mac

# then bump this cask:
shasum -a 256 dist/Mashhad-<version>-arm64.dmg dist/Mashhad-<version>-x64.dmg
#   -> edit Casks/mashhad.rb: set `version` and both `sha256 arm:` / `intel:` hashes
git commit -am "mashhad <version>" && git push
```

`version`, the release tag (`v<version>`), and the uploaded filenames must all match.

## Notes

- The `.dmg` is a public GitHub release asset, so no credentials are needed to download.
- The app is **unsigned** for now, so the cask's `postflight` strips the Gatekeeper
  quarantine attribute. Once you sign + notarize, delete that block.
- Both architectures ship, selected by the cask's `arch` stanza. Building the arm64
  `.dmg` on an Intel Mac (or vice versa) needs the arch-matched `ffmpeg-static` binary —
  `scripts/ffmpeg-arch.js` in the app repo handles that.
