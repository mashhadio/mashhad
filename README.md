# Smooth Screen Recorder

A Windows desktop app (Electron) for recording your screen with **smooth, automatic zoom-in on your cursor** (Screen Studio style) and **microphone noise cleanup**.

## Features

- **Screen recording** — pick a monitor and record at 30 or 60 fps.
- **Cursor tracking** — every mouse move and click is logged globally during the recording.
- **Smooth cursor zoom** — a post-processing editor adds eased zoom-ins that pan to follow your cursor. Auto-generated around your clicks, or add/remove zooms by hand.
- **Mic noise filtering** — ffmpeg cleans the microphone track (high-pass + FFT denoise + compression + loudness normalisation) with Off / Light / Medium / Strong presets.
- **MP4 export** — H.264 video + cleaned AAC audio, ready to share.

## How it works

1. **Record** the full screen plus raw mic audio; cursor positions/clicks are logged to a sidecar JSON.
2. **Edit** — the editor renders a live preview on a canvas, computing a `{scale, center}` transform per frame with `easeInOutCubic` ramps and a low-pass-smoothed cursor path so the pan is buttery.
3. **Export** — the zoom animation is rendered to a video via the canvas capture stream, then ffmpeg muxes it with the original mic audio (applying the noise chain) into an MP4.

## Run it

```powershell
npm install
npm start
```

## Build a Windows installer

```powershell
npm run dist:win
```

Produces an NSIS installer under `dist/`.

## Build for macOS

macOS builds **must be produced on a Mac** (signing/notarization can't be done from Windows).

```bash
npm install
npm run dist:mac      # produces a .dmg + .zip under dist/
```

macOS specifics, already wired up:

- **Permissions** — the app requests Camera & Microphone on launch (Info.plist usage
  strings + entitlements in `build/entitlements.mac.plist`). The user must also grant,
  in **System Settings → Privacy & Security**:
  - **Screen Recording** (for screen capture)
  - **Accessibility** (and **Input Monitoring**) — required for the cursor/click
    tracking that powers the smooth zoom. The app triggers this prompt automatically.
- **Signing & notarization** — for distribution to other Macs you need an Apple
  Developer account; set `CSC_LINK`/`CSC_KEY_PASSWORD` and add a notarization step.
  For running on your own Mac you can skip notarization (you'll approve Gatekeeper and
  the privacy prompts manually).
- The hotkey is **⌘⇧R** on macOS (Ctrl+Shift+R on Windows).

## Project layout

```
src/
  main/
    main.js            Electron main: windows, IPC, capture sources
    cursor-tracker.js  Global mouse capture (uiohook-napi)
    ffmpeg-export.js   ffmpeg mux + noise-reduction chains
  preload/preload.js   Safe IPC bridge
  renderer/
    index.html/.js     Recorder home screen
    editor.html/.js    Zoom editor + export
    zoom-engine.js     Easing / cursor-follow / frame draw (shared)
    styles.css
```

Recordings and exports are saved to `Videos\SmoothScreenRecorder`.
