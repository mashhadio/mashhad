# مشهد (Mashhad)

A cross-platform desktop app (Electron, runs on **macOS**, **Windows** and **Linux**) for
recording your screen with **smooth, automatic zoom-in that follows your cursor**
(Screen Studio style) and **microphone noise cleanup** — then exporting a polished MP4,
MOV, WebM or GIF.

---

## What it does

You record your screen once; the app does the polish afterwards:

- **Screen or window recording** — pick a monitor (or a single window) and record at 30 or 60 fps, with a live "what will be captured" preview.
- **Smooth cursor-follow zoom** — while recording, every mouse move and click is logged. In the editor, the view eases in to zoom on your cursor and pans to follow it, so static screen-capture footage feels alive. Zooms are auto-generated around your clicks, or you add/remove/resize them by hand.
- **Microphone narration + noise cleanup** — optionally record your mic. On export, ffmpeg runs a neural denoise chain (RNNoise) with **Off / Light / Medium / Strong** presets; you can preview the cleaned audio before exporting.
- **Webcam overlay (optional)** — picture-in-picture from your camera, with **live background blur** (MediaPipe), repositionable and resizable, composited into the final video.
- **Click effects** — a visual ripple at each click (style / colour / size) and an optional click *sound* (volume adjustable).
- **Flexible export** — MP4, MOV, WebM or animated GIF, with quality and resolution presets, plus one-click **YouTube** and **editing master** presets.
- **Recording library** — every capture is saved and can be re-opened in the editor later.

> **Heads-up:** the cursor-follow zoom and click effects only work for **full-screen
> recordings**. When recording a single window the cursor can't be mapped onto the frame,
> so zooms stay centered and click effects are off.

---

## Screenshots

> _Drop images/GIFs into `docs/screenshots/` and they'll render here. A short
> screen-capture GIF of the cursor-follow zoom is the single most useful thing to show._

| Recorder home | Zoom editor |
|---|---|
| ![Recorder home screen](docs/screenshots/home.png) | ![Zoom editor](docs/screenshots/editor.png) |

**Cursor-follow zoom in action:**

![Smooth cursor zoom demo](docs/screenshots/zoom-demo.gif)

<!--
To capture these:
  • home.png    – the recorder home screen with a source selected
  • editor.png  – the editor with a couple of zoom blocks on the timeline
  • zoom-demo.gif – a few seconds of exported output showing the zoom easing in/out
Then `mkdir -p docs/screenshots` and save them with these names.
-->

---

## Requirements

- **[Node.js](https://nodejs.org/)** 18+ (includes `npm`).
- A few hundred MB free for dependencies (Electron + a bundled ffmpeg binary).

Everything else — ffmpeg, the RNNoise model, the global input hook, the blur model — is
bundled or installed via `npm install`. No system ffmpeg needed.

---

## Quick start (run from source)

```bash
npm install   # first time only
npm start     # launches the app
```

`npm start` just runs `electron .`. **Run it from your own terminal**, not from an
automated/headless shell — a desktop GUI app needs your real login session to open a window.

On Windows you can also double-click **`Run Recorder.bat`** to launch it detached.

---

## Permissions (important — the app needs them to capture)

### macOS

macOS gates capture at the OS level. The app triggers the system prompts on launch, but
you'll usually have to grant these manually in **System Settings → Privacy & Security**:

| Permission | Why it's needed |
|---|---|
| **Screen Recording** | to capture the screen |
| **Accessibility** + **Input Monitoring** | to track cursor moves & clicks (this is what powers the smooth zoom) |
| **Microphone** | mic narration (optional) |
| **Camera** | webcam overlay (optional) |

macOS has no API to *prompt* for Screen Recording, so when it's off the app detects this
and pops a dialog with an **Open System Settings** button that jumps straight to the right
pane. After granting **Screen Recording** and **Accessibility**, **quit and relaunch** the
app — macOS only applies them to a fresh launch. If zoom never follows your cursor,
Accessibility/Input Monitoring is almost always the missing piece.

> In development (`npm start`) the running binary is Electron, so the entry to enable is
> named **Electron**, not "مشهد".

### Windows / Linux

No special setup on Windows. On Linux the global input hook (`uiohook-napi`) needs an X11
session (cursor tracking may not work under Wayland).

---

## Using the app — a quick walkthrough

1. **Pick a source.** Choose the **Screen** or **Window** tab, select a monitor/window. A live preview shows exactly what will be recorded.
2. **Set up audio/webcam (optional).** Toggle the microphone (and pick a device), and/or enable the webcam overlay with background blur.
3. **Choose frame rate** — 30 or 60 fps.
4. **Record.** Click **● Start Recording** or press the global hotkey **⌘⇧R** (macOS) / **Ctrl+Shift+R** (Windows/Linux) — it works even when the app is in the background. Press it again (or **Stop**) to finish.
5. **Edit.** When you stop, the editor opens automatically:
   - **Auto-zoom** generates eased zoom-ins around your clicks; tune the zoom level and smoothing, or add/clear/adjust zoom blocks on the timeline.
   - Position/size the **webcam overlay**, set **click effects** (look + sound), and choose a **mic noise** preset (preview it live).
6. **Export.** Pick a format (MP4 / MOV / WebM / GIF, or the YouTube / master presets), quality and resolution, then **Export**. ffmpeg renders the zoom animation, mixes the cleaned audio + click sounds, and writes the file. A progress bar tracks the encode.
7. **Reopen later.** Past recordings appear in the **library** on the home screen — click **Edit** to jump back into any of them.

---

## Where files go

Recordings and exports are saved under a **Mashhad** folder in your Videos location:

| OS | Path |
|---|---|
| macOS | `~/Movies/Mashhad` |
| Windows | `%USERPROFILE%\Videos\Mashhad` |
| Linux | `~/Videos/Mashhad` |

Builds released under the old **SmoothScreenRecorder** name used a folder of that name;
the app renames it on first launch, so earlier recordings carry over. If a `Mashhad`
folder already exists, the old one is left untouched rather than merged.

Each capture produces an intermediate `.webm` (the raw screen + mic), a `.cursor.json`
sidecar (cursor path + clicks + display info), and — if the webcam was on — a `.cam.webm`.
Your exported MP4/MOV/WebM/GIF is written wherever you choose in the save dialog.

---

## How it works under the hood

1. **Record** — the screen (and raw mic, and optionally webcam) is captured by Chromium's `MediaRecorder` and streamed to disk chunk-by-chunk (so long captures don't blow up memory). In parallel, `uiohook-napi` logs every cursor move/click to the sidecar JSON, normalised to 0–1 of the recorded display.
2. **Edit** — the editor renders a live preview on a `<canvas>`, computing a `{scale, center}` transform per frame with `easeInOutCubic` ramps and a low-pass-smoothed cursor path, so the pan/zoom is buttery rather than jittery. The webcam, click ripples, etc. are composited on the same canvas.
3. **Export** — the canvas animation is recorded to an intermediate video via its capture stream, then **ffmpeg** muxes it with the original mic audio (applying the RNNoise cleanup chain and mixing in click sounds) and encodes to your chosen format.

---

## Installers — build & install per OS

Installers are produced with `electron-builder`. Each build script writes its output to
`dist/`. **You must build on the target OS** — electron-builder does not cross-compile
reliably (macOS apps can't be signed from Windows, and the Linux `.deb`/AppImage packaging
tools aren't available on Windows/macOS). Build each platform on that platform (or in CI
with a runner per OS).

| OS | Build command | Produces (in `dist/`) |
|---|---|---|
| Windows | `npm run dist:win` | `Mashhad-<version>-<arch>.exe` (NSIS installer) |
| macOS | `npm run dist:mac` | `Mashhad-<version>-<arch>.dmg` **and** `.zip` |
| Linux | `npm run dist:linux` | `Mashhad-<version>-<arch>.AppImage` **and** `.deb` |

`npm run dist` (no suffix) builds the default target for whatever OS you're currently on.
On macOS, `npm run dist:mac:all` builds **both** architectures (arm64 then x64), swapping in the
arch-matched `ffmpeg-static` binary before each — see [`scripts/ffmpeg-arch.js`](scripts/ffmpeg-arch.js).

> First time on a machine? Run `npm install` before any `dist:*` command so
> electron-builder and the native deps (`ffmpeg-static`, `uiohook-napi`) are present.

> **Windows build gotcha — "Cannot create symbolic link … a required privilege is not
> held by the client".** electron-builder unpacks its `winCodeSign` helper, which contains
> macOS symlinks, and a standard (non-admin) Windows account can't create symlinks. Fix it
> once with **either** of: enable **Settings → Privacy & Security → For developers →
> Developer Mode**, **or** run the build from an **Administrator** terminal. (Those macOS
> files aren't needed for a Windows build — only the `rcedit`/signing tools in that package
> are.)

### Windows — install

1. Double-click **`Mashhad-<version>-x64.exe`**.
2. Because the installer isn't code-signed, Windows SmartScreen may show a blue
   *"Windows protected your PC"* dialog → click **More info → Run anyway**.
3. The NSIS installer lets you choose the install folder and creates Start-menu / desktop
   shortcuts. Launch **مشهد (Mashhad)** from the Start menu.

_No extra permissions needed on Windows._

### macOS — install

1. Open **`Mashhad-<version>-<arch>.dmg`** and drag **Mashhad** into **Applications**.
2. First launch: because the app isn't notarized, macOS Gatekeeper blocks it. Either
   **right-click the app → Open → Open**, or go to **System Settings → Privacy & Security**
   and click **Open Anyway**.
3. Grant the capture permissions (see the [Permissions](#permissions-important--the-app-needs-them-to-capture)
   section): **Screen Recording**, **Accessibility**, **Input Monitoring**, and optionally
   **Microphone** / **Camera**. **Quit and relaunch** after granting Screen Recording and
   Accessibility — macOS only applies them to a fresh launch.

- **Apple Silicon vs Intel:** build on the Mac you're targeting, or pass
  `--arm64` / `--x64` (or `--universal`) to produce the matching `.dmg`.
- **Distributing to other Macs** needs signing + notarization: set `CSC_LINK` /
  `CSC_KEY_PASSWORD` to your Apple Developer cert and add a notarization step. For your
  *own* Mac you can skip this and just approve Gatekeeper manually as above.

### Linux — install

Two artifacts are produced; pick whichever suits the target distro:

**AppImage (works on most distros, no install needed):**
```bash
chmod +x Mashhad-<version>-x86_64.AppImage
./Mashhad-<version>-x86_64.AppImage
```

**Debian / Ubuntu (`.deb`):**
```bash
sudo apt install ./Mashhad-<version>-amd64.deb   # resolves dependencies
# or:  sudo dpkg -i Mashhad-<version>-amd64.deb && sudo apt -f install
```
Then launch **Mashhad** from your applications menu (or run `Mashhad` in a terminal).

> **Linux note:** the global cursor hook (`uiohook-napi`) that powers the smooth zoom needs
> an **X11** session — cursor tracking may not work under Wayland. Screen recording itself
> still works either way.

---

## Auto-update & distribution

New versions reach users automatically where possible. **This repo is private**; the compiled
installers are served from a **separate public repo** (`mashhad-releases`) as GitHub release
assets, so updates need no embedded credentials and the source stays closed.

| Platform | How users get updates |
|---|---|
| **Windows** (NSIS) | In-app auto-update — a banner offers **restart to update** |
| **Linux** AppImage | In-app auto-update (when run as a real AppImage) |
| **Linux** `.deb` | Reinstall the newer package (no in-app updater) |
| **macOS** | In-app banner announces the version; installs via `brew upgrade mashhad` or the `.dmg` link. Squirrel.Mac won't apply unsigned updates, so it can't self-install. |

The updater ([`src/main/updater.js`](src/main/updater.js)) reads the **GitHub releases** of
[`mashhadio/mashhad-releases`](https://github.com/mashhadio/mashhad-releases); electron-builder
uploads each build there directly. macOS also goes through the Homebrew tap in
[`homebrew-mashhad/`](homebrew-mashhad/), and [`site/`](site/) is the public download page —
[`.github/workflows/site.yml`](.github/workflows/site.yml) pushes it to the public releases repo's
`gh-pages` branch, since Pages can't serve from a private repo on a Free plan.

📄 **Full setup + per-release runbook: [`docs/distribution-setup.html`](docs/distribution-setup.html)**
(open in a browser) — the one-time setup (push the source to GitHub, add the `RELEASES_TOKEN`
secret, push the Homebrew tap, turn on Pages) and how to cut each release.

**Releasing (quick reference):**
```bash
# bump the version in package.json and site/release.js, then (after the release is
# published) refresh `version` + both sha256s in homebrew-mashhad/Casks/mashhad.rb
# and push that to the mashhadio/homebrew-mashhad repo. Then:
git commit -am "release X.Y.Z"
git tag vX.Y.Z && git push && git push --tags
```

> **Version strings live in five places.** `package.json` and `site/release.js` drive the
> build and the download links; the other three are static text that no script rewrites —
> `softwareVersion` in the JSON-LD block at the bottom of [`site/index.html`](site/index.html),
> and the `Current version:` line in both [`site/llms.txt`](site/llms.txt) and
> [`site/llms-full.txt`](site/llms-full.txt). Grep the old number before tagging:
> `grep -rn "X\.Y\.Z" package.json site/`
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds Windows, Linux, and both
macOS architectures on native runners and uploads them to a **draft** release. Review it, publish
it, then update the cask's `version` + both `sha256` hashes. To build one platform by hand
instead, `GH_TOKEN=… npm run release:win` (or `release:mac` / `release:linux`) does the same
upload; the `dist:*` scripts build without uploading.

---

## Project layout

```
src/
  main/
    main.js            Electron main: windows, IPC, capture sources, lifecycle
    cursor-tracker.js  Global mouse/click capture (uiohook-napi), normalised coords
    ffmpeg-export.js   ffmpeg mux, noise-reduction chains, encoders/presets
  preload/preload.js   Safe contextIsolated IPC bridge (window.api)
  renderer/
    index.html / index.js   Recorder home screen + recording pipeline + library
    editor.html / editor.js  Zoom/effects editor + export UI
    zoom-engine.js          Easing / cursor-follow / per-frame draw (shared)
    cam-processor.js        Webcam capture + background-blur pipeline
    prefs.js                Persisted user preferences
    styles.css
assets/
  rnnoise/*.rnnn       RNNoise neural denoise models
  sfx/*.wav            Click sound effects
build/
  entitlements.mac.plist  macOS camera/mic/screen entitlements
```

---

## Troubleshooting

- **Zoom never follows the cursor (stays centered).** You're recording a *window* (expected), or on macOS the **Accessibility / Input Monitoring** permission isn't granted — grant it and relaunch.
- **The app opens then immediately closes when launched from a script/CI.** GUI apps need a real desktop session; launch `npm start` from a normal terminal on the machine you're sitting at.
- **No screens/windows listed.** Click **↻ Refresh**; on macOS confirm **Screen Recording** is granted and relaunch.
- **Mic/webcam missing in the dropdowns.** Grant Microphone/Camera permission, then reopen the app so the device list re-populates.
- **Export fails mentioning ffmpeg.** Reinstall deps (`npm install`) so the bundled `ffmpeg-static` binary is restored.

---

## License

MIT © Abdul
