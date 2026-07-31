# homebrew-mashhad

Homebrew **tap** for [مشهد (Mashhad)](https://github.com/mashhadio/mashhad-releases) — the macOS distribution + update channel.

> **This file lives in two places.** The tap users actually fetch is
> [`mashhadio/homebrew-mashhad`](https://github.com/mashhadio/homebrew-mashhad) (the `homebrew-`
> prefix is what lets `brew tap` find it). A copy is kept under `homebrew-mashhad/` in the private
> app repo so the cask sits next to the code that produces the `.dmg`.
>
> That copy is a **mirror, not a clone** — committing there publishes nothing. To ship a cask
> change, copy the file into a checkout of the tap repo and push from there.

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

Normally CI does the building — tagging `vX.Y.Z` in the app repo runs the `Release`
workflow. To build by hand instead:

```sh
# in the app repo — builds arm64 and x64 back to back and uploads both:
GH_TOKEN=<token> npm run release:mac
```

Either way, once the release is **published**, bump the cask from the published assets:

```sh
shasum -a 256 Mashhad-<version>-arm64.dmg Mashhad-<version>-x64.dmg
#   -> set `version` and both `sha256 arm:` / `intel:` hashes in Casks/mashhad.rb
# then, IN A CHECKOUT OF THE TAP REPO (not the app repo's mirror):
git commit -am "mashhad <version>" && git push
```

`version`, the release tag (`v<version>`), and the uploaded filenames must all match.

Then verify from a clean state — a wrong hash or a wrong `app` stanza is invisible
until someone installs:

```sh
brew uninstall --cask mashhad; brew untap mashhadio/mashhad
brew install mashhadio/mashhad/mashhad && open -a Mashhad
```

## Notes

- The `.dmg` is a public GitHub release asset, so no credentials are needed to download.
- The app is **unsigned** for now, so the cask's `postflight` strips the Gatekeeper
  quarantine attribute. Once you sign + notarize, delete that block.
- Both architectures ship, selected by the cask's `arch` stanza. Building the arm64
  `.dmg` on an Intel Mac (or vice versa) needs the arch-matched `ffmpeg-static` binary —
  `scripts/ffmpeg-arch.js` in the app repo handles that.
