'use strict';

// editor-export.js — part of the editor.js module split (see editor.html for load order).
// Export: render the zoom/cam/scene composite to a temp file, then hand it to the main process to mux + encode.

// Export
// ---------------------------------------------------------------------------
async function runExport() {
  if (exporting || !clips.length) return;
  exporting = true;
  pause();
  // Capture from the first clip's source.
  if (clips[0]) { setActiveEl(clips[0].sourceId); }
  exportBtn.disabled = true;
  progress.classList.add('active');

  const totalDur = editedDuration();
  // Single place to drive the bar + the percentage label so the two never drift.
  const setProgress = (pct, label) => {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = pct + '%';
    exportStatus.textContent = label ? `${label} · ${pct}٪` : `${pct}٪`;
  };
  setProgress(0, 'جارٍ التحضير');

  // Two phases share the bar: the canvas render (0–60%) then the ffmpeg encode
  // (60–99%), so the user sees steady movement through the whole export.
  const interBitrate = exportFormat.value === 'master' ? 50_000_000 : 16_000_000;

  // Everything from here on touches an external resource (the temp capture file
  // on the main process, the export-progress listener) that must be cleaned up
  // on ANY failure — including one during the capture phase itself, before the
  // ffmpeg call even starts — so it's all one try/catch/finally.
  let off = () => {};
  try {
    const zoomedVideoPath = await renderZoomedWebm((p) => {
      setProgress(p * 60, 'جارٍ تجهيز اللقطات');
    }, interBitrate);

    setProgress(60, 'جارٍ الترميز وتنقية الصوت');

    // ffmpeg prints `time=HH:MM:SS.ss` as it encodes; map that against the clip
    // duration to advance the bar from 60% toward 99% during the encode.
    off = window.api.onExportProgress((line) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (m && totalDur > 0) {
        const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        const frac = Math.max(0, Math.min(1, secs / totalDur));
        setProgress(60 + frac * 39, 'جارٍ الترميز والتصدير');
      }
    });

    // Click sounds must land on the edited timeline; drop any that were cut out.
    const editedClicks = recording
      ? clickTimes.map((t) => sourceToEdited(t, recording.id)).filter((t) => t != null)
      : [];

    // Overlay video clips and audio-track clips both contribute audio, mixed in at
    // their timeline `pos`. Voice-over clips carry `voice` so ffmpeg can denoise them.
    const overlayPayload = [...allOverlayClips(), ...allAudioClips()].map((c) => ({
      sourceId: c.sourceId, start: c.start, end: c.end, pos: c.pos, speed: c.speed || 1,
      gain: c.gain != null ? c.gain : 1, voice: !!c.voice,
    }));

    // Pass the clip list (with source ids) whenever the timeline isn't a single,
    // untrimmed recording clip — that lone case keeps the original fast path.
    const pureUnedited = recording && !isEdited() && clips.length === 1
      && clips[0].sourceId === recording.id && (clips[0].speed || 1) === 1 && !overlayPayload.length;
    const clipsPayload = pureUnedited
      ? null
      : clips.map((c) => ({ sourceId: c.sourceId, start: c.start, end: c.end, speed: c.speed || 1 }));

    const res = await window.api.runExport({
      zoomedVideoPath,
      options: {
        noiseProfile: noiseProfile.value,
        echoLevel: echoLevel.value,
        clickSound: clickSound.checked,
        clickTimes: clickSound.checked ? editedClicks : [],
        clickSoundName: clickSoundName.value,
        clickVolume: parseInt(clickVol.value, 10) / 100,
        durationSec: editedDuration(),
        clips: clipsPayload,
        overlayClips: overlayPayload,
        // When detached, the mic audio comes from the audio-track clip above, so
        // the recording video clips must not also contribute it.
        recordingAudioMuted: isAudioDetached(),
        format: exportFormat.value,
        quality: exportQuality.value,
        resolution: exportResolution.value,
      },
    });
    off();
    if (res.canceled) {
      exportStatus.textContent = 'أُلغِي التصدير.';
    } else {
      setProgress(100, 'تم');
      exportStatus.textContent = 'تم! حُفظ في ' + res.outputPath;
      await window.api.revealFile(res.outputPath);
    }
  } catch (err) {
    off();
    exportStatus.textContent = 'فشل التصدير: ' + err.message;
    console.error(err);
  } finally {
    progress.classList.remove('active');
    exportBtn.disabled = false;
    exporting = false;
    // The capture pass left the active element on the last clip's source; restore
    // the preview to the playhead so the active element/frame are consistent.
    if (clips.length) seekEdited(clamp(playheadEdited, 0, editedDuration()));
  }
}

// Captures the rendered canvas to a temp file on disk, streamed chunk-by-chunk
// over IPC as it's recorded (mirroring the rec:videoChunk pattern already used
// for live recording) instead of buffering the whole (potentially hundreds-of-MB)
// capture in renderer memory and sending it as one structured-clone IPC message.
// Resolves with the temp file's path rather than an ArrayBuffer.
async function renderZoomedWebm(onProgress, bitrate = 16_000_000) {
  transSnapIdx = -1; // start the capture with no pending transition snapshot
  capturing = true;  // overlay elements play muted alongside during capture
  lastDrawnScene = null; sceneXfadeFrom = null; // fresh scene-crossfade state
  await window.api.beginExportCapture();
  return new Promise((resolve, reject) => {
    // captureStream(0) = manual mode: we push exactly one frame per drawn frame
    // via requestFrame(), so no empty/duplicated frames sneak into the encoder.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    // Capture as VP8, NOT VP9. This intermediate is re-encoded by ffmpeg into the
    // final file, so its codec only needs to be fast. Chromium has no GPU encoder
    // for MediaRecorder VP9 (software-only), so at these bitrates VP9 can't encode
    // in real time — the capture loop stalls and drops frames, which shows as a
    // choppy/broken webcam (the static screen hides it). VP8 encodes fast enough
    // to sustain real time, keeping motion (the cam) smooth.
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    let finished = false;
    let chunkWriteQueue = Promise.resolve(); // serializes chunk writes, like recording does
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      chunkWriteQueue = chunkWriteQueue.then(async () => {
        const buf = await blob.arrayBuffer();
        await window.api.sendExportChunk(buf);
      });
    };
    rec.onstop = async () => {
      capturing = false;
      pauseOverlayEls();
      updateAudioRouting(); // restore preview audio routing
      try {
        await chunkWriteQueue; // wait for every chunk to reach disk
        resolve(await window.api.endExportCapture());
      } catch (err) {
        reject(err);
      }
    };
    rec.onerror = (e) => {
      // Stop the capture loop first. step() self-schedules via requestAnimationFrame
      // (and re-arms from the 'seeked' handler); without this it keeps running after
      // we reject below — burning CPU, fighting the user's seeks on the now-"idle"
      // editor, and eventually calling rec.stop() on this already-dead recorder
      // (an uncaught throw inside its setTimeout). It only bails on `if (finished)`.
      finished = true;
      capturing = false;
      pauseOverlayEls();
      updateAudioRouting();
      window.api.abortExportCapture().catch(() => {}); // clean up the half-written temp file
      reject(e.error || new Error('خطأ في المُسجِّل'));
    };

    const pushFrame = () => { if (track.requestFrame) track.requestFrame(); };

    // Adaptive capture rate. The export encodes the canvas in REAL TIME via
    // MediaRecorder (software-encoded — no GPU path). At ≤1080p most machines
    // sustain 60fps, so keep it — full smoothness for the common case. Above
    // 1080p (1440p/4K), real-time software encoding can't keep up at 60 and the
    // loop drops frames, so cap to 30 there. (The webcam-seek sync fix, not this
    // cap, is what keeps the cam smooth — 60fps was never the cam's problem.)
    const FRAME_MS = canvas.height > 1080 ? 1000 / 30 : 1000 / 60;
    let lastFrame = -1;

    // Capture the clips in edit order. Between clips we seek the source video to
    // the next clip's start — which can be backwards when clips were reordered.
    const seq = clips;
    const total = editedDuration() || duration;
    const startAt = seq.length ? seq[0].start : 0;
    let segIdx = 0;
    let elapsedBefore = 0;
    let skipping = false;

    let step;
    step = (now) => {
      if (finished) return;
      if (skipping) return; // waiting on a 'seeked'; onSeeked re-arms the loop
      drawClipIdx = segIdx;
      const segSp = seq[segIdx].speed || 1;
      if (video.playbackRate !== segSp) video.playbackRate = segSp; // per-clip speed

      // Reached the end of the current clip (source-second lead scaled by speed).
      if (video.ended || video.currentTime >= seq[segIdx].end - 0.02 * segSp) {
        snapshotOutgoing(segIdx + 1); // freeze for the next clip's transition
        elapsedBefore += clipTLen(seq[segIdx]); // timeline length (speed-scaled)
        const prevSourceId = seq[segIdx].sourceId;
        segIdx++;
        if (segIdx >= seq.length) {
          finished = true;
          video.pause();
          if (camReady) camVideo.pause();
          setTimeout(() => rec.stop(), 200);
          return;
        }
        const nextClip = seq[segIdx];
        const target = nextClip.start;
        // Crossing into a different source file: swap the active element.
        const switching = nextClip.sourceId !== prevSourceId;
        if (switching) {
          try { video.pause(); } catch (_) {}
          setActiveEl(nextClip.sourceId);
          video.muted = true; // element audio is never captured; keep it silent
        }
        // Idle the webcam over imported footage (it isn't drawn there); recording
        // clips seek it to the new clip below, in lockstep with the screen.
        if (camReady && !activeIsRecording()) camVideo.pause();
        // The screen and the (separate) webcam element each jump to `target`.
        // Figure out which actually has to MOVE: a `currentTime` write that
        // doesn't change position fires no 'seeked', so we must only wait on the
        // element that truly seeks — waiting on one that won't move would stall
        // the whole cut on the safety timeout.
        const el = video; // the element we're seeking (may have just switched)
        const camTarget = camReady && activeIsRecording() ? camTimeFor(target) : null;
        const camMoves = camTarget != null && Math.abs(camVideo.currentTime - camTarget) > 0.04;
        const mainMoves = Math.abs(el.currentTime - target) > 0.04;
        // An ended element must still be rewound to `target` to resume, even if
        // it's ~at target; that write may fire no event, so we don't wait on it.
        const mainNeedsRewind = mainMoves || el.ended;

        // Nothing moves (plain split, both already at target): keep rolling.
        if (!mainNeedsRewind && !camMoves) {
          if (el.paused) el.play().catch(() => {});
          lastFrame = -1;
          requestAnimationFrame(step);
          return;
        }

        // Otherwise jump and wait for whichever element(s) genuinely seek.
        skipping = true;
        // Freeze the recorder timeline during the seek. MediaRecorder runs on
        // wall-clock, so without this the last frame would be held for the seek
        // latency — bloating the video past the (precisely-cut) audio and
        // leaving a freeze-frame at every cut.
        if (rec.state === 'recording') rec.pause();
        // Register listeners BEFORE moving currentTime so a fast seek can't fire
        // before we're listening. Only wait on seeks that will actually emit —
        // waiting on one that won't move would stall on the safety timeout.
        const waits = [];
        if (mainMoves) waits.push(waitForSeeked(el, { timeoutMs: 2000 }));
        if (camMoves) waits.push(waitForSeeked(camVideo, { timeoutMs: 2000 }));
        // An ended element must still be rewound even if no 'seeked' is expected
        // for it (see mainNeedsRewind above), so this write isn't gated on `waits`.
        if (mainNeedsRewind) el.currentTime = target;
        if (camMoves) camVideo.currentTime = camTarget;
        Promise.all(waits).then(() => {
          skipping = false;
          lastFrame = -1;
          if (el === video && el.paused) el.play().catch(() => {});
          if (rec.state === 'paused') rec.resume();
          requestAnimationFrame(step);
        });
        return;
      }

      // Keep the webcam advancing during recording clips, idle during imports.
      if (camReady) {
        if (activeIsRecording()) { camVideo.playbackRate = segSp * camDurRatio(); if (camVideo.paused) camVideo.play().catch(() => {}); }
        else if (!camVideo.paused) camVideo.pause();
      }

      // Throttle to ~60fps so a 144Hz display doesn't produce a 144fps file.
      if (lastFrame < 0 || now - lastFrame >= FRAME_MS - 1) {
        lastFrame = now;
        const teNow = elapsedBefore + (video.currentTime - seq[segIdx].start) / segSp;
        drawAt(video.currentTime);
        updateOverlayPlayback(teNow); // drive overlay elements (muted) alongside
        drawOverlays(teNow);          // composite the top overlay layer
        pushFrame();
        if (onProgress && total) onProgress(Math.min(1, teNow / total));
      }
      requestAnimationFrame(step);
    };

    const begin = () => {
      // Draw and capture the first frame BEFORE starting, so the opening
      // keyframe has real content rather than an empty (green) buffer.
      transSnapIdx = -1; // no transition on the very first clip
      drawClipIdx = 0;
      drawAt(video.currentTime);
      updateOverlayPlayback(0);
      drawOverlays(0);
      // A timeslice makes the encoder emit chunks periodically (like recording's
      // 250ms) instead of buffering the whole capture and firing one huge
      // dataavailable at stop() — the reason this could be streamed at all.
      rec.start(1000);
      pushFrame();
      video.play();
      // The webcam belongs to the recording; only run it when the first clip is
      // a recording clip (the seam re-syncs it as later recording clips arrive).
      if (camReady && activeIsRecording()) camVideo.play().catch(() => {});
      requestAnimationFrame(step);
    };

    video.pause();
    video.muted = true;
    if (camReady && activeIsRecording()) camVideo.currentTime = camTimeFor(startAt);
    // Seek to the first clip (a no-op if we're already there), then start.
    seekAndWait(video, startAt, { timeoutMs: 1500, epsilon: 0.05 }).then(begin);
  });
}

exportBtn.addEventListener('click', runExport);

const saveProjectBtn = document.getElementById('saveProjectBtn');
const openProjectBtn = document.getElementById('openProjectBtn');
saveProjectBtn.addEventListener('click', () => saveProject(false));
openProjectBtn.addEventListener('click', async () => {
  if (exporting) return;
  topStatus.textContent = 'جارٍ فتح المشروع…';
  try {
    await flushAutoSave(); // don't lose pending edits of the current project
    const res = await window.api.openProject();
    if (res && res.canceled) { topStatus.textContent = ''; return; }
    if (res && res.error) { topStatus.textContent = res.error; return; }
    // On success the main process reloads the editor with the project's state;
    // if any media was missing it's reported after the reload via the manifest.
  } catch (err) {
    topStatus.textContent = 'تعذّر فتح المشروع: ' + (err.message || err);
  }
});

backBtn.addEventListener('click', async () => {
  // Guard against discarding an import-only studio session on a stray click.
  // A saved (auto-saving) project is safe to leave — but flush any pending
  // auto-save first, since leaving tears down the renderer and its debounce.
  const hasImports = sources.some((s) => s.kind === 'import');
  if (hasImports && !projectFileName && !confirm('العودة إلى شاشة التسجيل ستترك المونتاج الحالي. متابعة؟')) return;
  await flushAutoSave();
  window.api.backHome();
});

init().catch((e) => {
  console.error(e);
  topStatus.textContent = 'خطأ: ' + e.message;
});
