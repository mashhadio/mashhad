# Smooth Screen Recorder

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
> named **Electron**, not "Smooth Screen Recorder".

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

Recordings and exports are saved under a **SmoothScreenRecorder** folder in your Videos
location:

| OS | Path |
|---|---|
| macOS | `~/Movies/SmoothScreenRecorder` |
| Windows | `%USERPROFILE%\Videos\SmoothScreenRecorder` |
| Linux | `~/Videos/SmoothScreenRecorder` |

Each capture produces an intermediate `.webm` (the raw screen + mic), a `.cursor.json`
sidecar (cursor path + clicks + display info), and — if the webcam was on — a `.cam.webm`.
Your exported MP4/MOV/WebM/GIF is written wherever you choose in the save dialog.

---

## How it works under the hood

1. **Record** — the screen (and raw mic, and optionally webcam) is captured by Chromium's `MediaRecorder` and streamed to disk chunk-by-chunk (so long captures don't blow up memory). In parallel, `uiohook-napi` logs every cursor move/click to the sidecar JSON, normalised to 0–1 of the recorded display.
2. **Edit** — the editor renders a live preview on a `<canvas>`, computing a `{scale, center}` transform per frame with `easeInOutCubic` ramps and a low-pass-smoothed cursor path, so the pan/zoom is buttery rather than jittery. The webcam, click ripples, etc. are composited on the same canvas.
3. **Export** — the canvas animation is recorded to an intermediate video via its capture stream, then **ffmpeg** muxes it with the original mic audio (applying the RNNoise cleanup chain and mixing in click sounds) and encodes to your chosen format.

---

## Building a distributable

Builds are produced with `electron-builder`. **Build on the target OS** (you can't sign a
macOS app from Windows, and vice-versa).

```bash
npm run dist:mac   # → .dmg + .zip under dist/
npm run dist:win   # → NSIS installer under dist/
npm run dist       # → default target for the current OS
```

To install a macOS build: open the `.dmg`, drag **Smooth Screen Recorder** to Applications,
launch it, then grant the permissions above.

**Signing & notarization** (only needed to distribute to *other* machines): on macOS set
`CSC_LINK` / `CSC_KEY_PASSWORD` with your Apple Developer cert and add a notarization step.
For running on your *own* Mac you can skip notarization and just approve Gatekeeper + the
privacy prompts manually.

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
