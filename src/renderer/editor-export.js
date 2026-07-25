'use strict';

// editor-export.js — part of the editor.js module split (see editor.html for load order).
// Export: render the zoom/cam/scene composite to a temp file, then hand it to the main process to mux + encode.

// Quality for the intermediate JPEG frame stream both frame-exact paths emit.
// It's re-encoded by ffmpeg into the final file, so this only needs to preserve
// enough detail for that pass — one shared constant so the two paths can't drift.
const EXPORT_JPEG_QUALITY = 0.92;

// Export
// ---------------------------------------------------------------------------
async function runExport() {
  if (exporting || !clips.length) return;

  // A clip whose source file was missing when the project opened is absent from
  // `sources` (see applyPendingProject — it's shelved in preservedSources with a
  // null URL). Left alone, that clip collapses to ~0s of picture during the
  // real-time capture while ffmpeg still lays down its full audio span, shoving
  // everything after it out of sync — and silently, since preview is timeline-
  // driven and looks fine. Refuse to export and name the file(s) to restore
  // rather than writing a broken, desynced video.
  const missingIds = [...new Set(
    [...clips, ...allOverlayClips(), ...allAudioClips()]
      .map((c) => c.sourceId)
      .filter((id) => !sourceById(id))
  )];
  if (missingIds.length) {
    const names = missingIds.map((id) => {
      const p = (preservedSources || []).find((s) => s.id === id);
      return p && p.name ? p.name : id;
    });
    exportStatus.textContent = `تعذّر التصدير — ملف مصدر مفقود: ${names.join('، ')}`;
    alert(`تعذّر التصدير: تعذّر العثور على ملف المصدر:\n${names.join('\n')}\n\nتأكد من وجود الملف ثم أعد فتح المشروع.`);
    return;
  }

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
  // Frame-EXACT picture path: render every output frame at its exact time and hand
  // ffmpeg a fixed-rate frame stream, so the picture can't drift against the
  // sample-exact audio (unlike the real-time MediaRecorder capture, whose frame
  // timing the browser controls). Handles clip transitions too (the loop freezes
  // the outgoing frame at each seam, like the real-time path). Still excludes
  // scene composites (their time-based crossfades need the real-time loop) and
  // GIF (its own path). captureFps is echoed to ffmpeg as the input rate.
  const hasTrans = clips.some((c, i) => i > 0 && c.transition && c.transition.type && c.transition.type !== 'none');
  const hasScenes = typeof sceneEvents !== 'undefined' && Array.isArray(sceneEvents) && sceneEvents.length > 0;
  const frameExact = !hasScenes && exportFormat.value !== 'gif';
  const captureFps = canvas.height > 1080 ? 30 : 60;
  console.log(`[export] picture path = ${frameExact ? 'frame-EXACT (deterministic)' : 'real-time capture'} | hasTrans=${hasTrans} hasScenes=${hasScenes} format=${exportFormat.value}`);
  try {
    let zoomedVideoPath;
    if (frameExact) {
      // Fast + exact: play each clip and capture frames by content time. Falls back
      // to the slow seek-based renderer only if it fails partway (e.g. play blocked).
      try {
        zoomedVideoPath = await renderFramesByPlaying((p) => setProgress(p * 60, 'جارٍ تجهيز اللقطات (سريع)'), captureFps);
      } catch (playErr) {
        console.warn('[export] play-based capture failed, falling back to seek-based:', playErr && playErr.message);
        zoomedVideoPath = await renderZoomedFrames((p) => setProgress(p * 60, 'جارٍ تجهيز اللقطات (مزامنة دقيقة)'), captureFps);
      }
    } else {
      // Scene composites: the real-time compositing loop.
      zoomedVideoPath = await renderZoomedWebm((p) => setProgress(p * 60, 'جارٍ تجهيز اللقطات'), interBitrate);
    }

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
        audioSyncMs: parseInt(audioSync.value, 10) || 0,
        videoInputFps: frameExact ? captureFps : 0,
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
    // Frame source. Preferred (frame-accurate): a MediaStreamTrackGenerator we
    // hand VideoFrames to, each stamped with its exact TIMELINE time — so ffmpeg
    // lays every frame at its true position against the sample-exact audio, with
    // none of the real-time-capture drift that made the picture creep ahead of
    // the voice. We still render in real time (all the zoom/cam/transition/scene
    // compositing below is unchanged) — only the timestamp is now content-time
    // instead of wall-clock. Fallback (engines without MediaStreamTrackGenerator/
    // VideoFrame): captureStream(0) manual mode + requestFrame(), the wall-clock
    // path that drifts slightly — kept only so export still works there.
    let writer = null, track = null, stream = null;
    try {
      if (typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function') {
        const generator = new MediaStreamTrackGenerator({ kind: 'video' });
        writer = generator.writable.getWriter();
        stream = new MediaStream([generator]);
      }
    } catch (_) { writer = null; }
    if (!writer) {
      // captureStream(0) = manual mode: exactly one frame per drawn frame via
      // requestFrame(), so no empty/duplicated frames sneak into the encoder.
      stream = canvas.captureStream(0);
      track = stream.getVideoTracks()[0];
    }
    const exactFrames = !!writer;
    console.log(`[export] frame-accurate timing: ${exactFrames ? 'ON (VideoFrame timestamps)' : 'OFF (fallback wall-clock capture)'}`);
    let lastTs = -1; // last VideoFrame timestamp (µs); kept strictly increasing
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
      if (writer) { try { writer.close(); } catch (_) {} }
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
      if (writer) { try { writer.close(); } catch (_) {} }
      window.api.abortExportCapture().catch(() => {}); // clean up the half-written temp file
      reject(e.error || new Error('خطأ في المُسجِّل'));
    };

    // Emit one frame. Frame-accurate path: wrap the canvas in a VideoFrame stamped
    // at timeline time `te` (seconds), so its position in the file is exact. The
    // fallback just requests a wall-clock frame. `te` is ignored in the fallback.
    const pushFrame = (te) => {
      if (exactFrames) {
        let ts = Math.round(Math.max(0, te || 0) * 1e6);
        if (ts <= lastTs) ts = lastTs + 1; // encoders require strictly increasing PTS
        lastTs = ts;
        let vf;
        try { vf = new VideoFrame(canvas, { timestamp: ts }); } catch (_) { return; }
        // Fire-and-forget with backpressure; close the frame once accepted so its
        // buffer is freed (writes resolve quickly at capture rate).
        writer.write(vf).then(() => { try { vf.close(); } catch (_) {} },
          () => { try { vf.close(); } catch (_) {} });
      } else if (track && track.requestFrame) {
        track.requestFrame();
      }
    };

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
        pushFrame(teNow);
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
      pushFrame(0);
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

// Frame-EXACT capture (see the frameExact branch in runExport). Renders every
// output frame deterministically — seek each source element to the frame's exact
// time, draw the same composite the preview uses, and stream the frame as a JPEG —
// instead of screen-recording the canvas in real time. ffmpeg reads the JPEGs at a
// fixed frame rate (exportVideo's image2pipe input), so each frame lands on an
// exact grid aligned with the sample-exact audio: the picture cannot drift. Reuses
// the same begin/chunk/end capture IPC as the real-time path — only the payload is
// a JPEG stream instead of a webm. No transitions/scenes here (runExport gates it).
async function renderZoomedFrames(onProgress, fps) {
  capturing = true;
  transSnapIdx = -1;
  lastDrawnScene = null; sceneXfadeFrom = null;
  await window.api.beginExportCapture();
  const toJpeg = () => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', EXPORT_JPEG_QUALITY);
  });
  try {
    const total = editedDuration();
    const N = Math.max(1, Math.round(total * fps));
    console.log(`[export] frame-EXACT render: ${N} frames @ ${fps}fps (deterministic; picture locked to audio)`);
    video.pause();
    video.muted = true;
    if (camReady) camVideo.pause();
    let activeId = null;
    let prevIdx = -1;
    for (let i = 0; i < N; i++) {
      const te = Math.min(total - 1e-4, i / fps);
      const m = editedToSource(te);
      if (m.clip.sourceId !== activeId) { setActiveEl(m.clip.sourceId); video.muted = true; activeId = m.clip.sourceId; }
      // Land the picture element(s) on this frame's exact source time before drawing.
      // (Seeking doesn't touch the canvas, so it still holds the previous frame.)
      await seekAndWait(video, m.src, { timeoutMs: 3000, epsilon: 0.25 / fps });
      if (activeIsRecording() && camReady) {
        try { await seekAndWait(camVideo, camTimeFor(m.src), { timeoutMs: 1500, epsilon: 0.25 / fps }); } catch (_) {}
      }
      // Crossing into a new clip: freeze the outgoing frame (the previous
      // iteration's, still on the canvas) so this clip's intro transition can
      // dissolve it — exactly what the real-time path does at each seam.
      if (m.idx !== prevIdx && prevIdx >= 0) snapshotOutgoing(m.idx);
      drawClipIdx = m.idx;
      drawAt(m.src);           // draws the incoming frame + composites the transition if in-window
      updateOverlayPlayback(te);
      drawOverlays(te);
      const blob = await toJpeg();
      await window.api.sendExportChunk(await blob.arrayBuffer());
      if (onProgress) onProgress((i + 1) / N);
      prevIdx = m.idx;
    }
    capturing = false;
    pauseOverlayEls();
    updateAudioRouting();
    return await window.api.endExportCapture();
  } catch (err) {
    capturing = false;
    pauseOverlayEls();
    updateAudioRouting();
    try { await window.api.abortExportCapture(); } catch (_) {}
    throw err;
  }
}

// FAST frame-exact capture: instead of seeking to every frame (slow — precise
// seeks re-decode from a keyframe each time), PLAY each clip once (sequential
// decode ≈ real time) and sample it on requestAnimationFrame, reading the frame's
// source time from video.currentTime (the same mechanism preview uses, which works
// for the off-screen source elements). Each sample is placed on the fixed output
// grid BY CONTENT TIME (hold the last frame to fill each 1/fps slot), so the picture
// stays locked to the sample-exact audio — no drift, just faster. If a machine can't
// encode as fast as it plays, it captures fewer unique frames and holds them
// (slightly choppy) rather than desyncing. Handles transitions via the same
// snapshotOutgoing seam trick as the deterministic path. ffmpeg reads the JPEGs at
// `fps` (image2pipe). runExport falls back to the seek-based renderer if this throws.
async function renderFramesByPlaying(onProgress, fps) {
  capturing = true;
  transSnapIdx = -1;
  lastDrawnScene = null; sceneXfadeFrom = null;
  await window.api.beginExportCapture();
  const total = editedDuration();
  const N = Math.max(1, Math.round(total * fps));
  console.log(`[export] FAST play-based render: ${N} frames @ ${fps}fps (played, picture locked to audio)`);
  let nextSlot = 0;
  let sendQueue = Promise.resolve();
  let sendErr = null;
  let processed = 0;

  // Encode the CURRENT canvas once (as a JPEG) and queue it for `count` output
  // slots — a held frame duplicated across the slots it covers. toBlob captures the
  // canvas bitmap synchronously at call time, so encoding the previous frame can't
  // race the next draw; the sends are chained on sendQueue so they stay in order.
  // CRITICAL: ffmpeg's image2pipe assigns frame N to slot N by position, so we must
  // send EXACTLY one buffer per slot — a dropped frame would shift every later frame
  // and desync. If an encode ever fails, resend the last good frame (never skip).
  let lastBuf = null;
  const emit = (count) => {
    if (count <= 0) return;
    const bufP = new Promise((resolve) => {
      canvas.toBlob((b) => {
        if (!b) { resolve(lastBuf); return; }
        b.arrayBuffer().then((ab) => { lastBuf = ab; resolve(ab); }, () => resolve(lastBuf));
      }, 'image/jpeg', EXPORT_JPEG_QUALITY);
    });
    for (let c = 0; c < count; c++) {
      sendQueue = sendQueue
        .then(() => bufP)
        .then((buf) => {
          if (buf) return window.api.sendExportChunk(buf);
          sendErr = sendErr || new Error('frame encode failed'); // only if the very first frame fails
        })
        .catch((e) => { sendErr = sendErr || e; });
    }
  };
  const nextRaf = () => new Promise((res) => requestAnimationFrame(res));

  try {
    video.pause(); video.muted = true;
    if (camReady) camVideo.pause();
    let base = 0; // edited (timeline) start of the current clip
    for (let idx = 0; idx < clips.length; idx++) {
      const c = clips[idx];
      const sp = c.speed || 1;
      const clipEndTe = Math.min(total, base + (c.end - c.start) / sp);
      setActiveEl(c.sourceId); video.muted = true;
      // No `force`: writing the same currentTime fires no 'seeked' and would hang
      // until the timeout. The exact landing spot doesn't matter — we read each
      // frame's true time from rVFC below.
      await seekAndWait(video, c.start, { timeoutMs: 3000, epsilon: 0.02 });
      if (idx > 0) snapshotOutgoing(idx); // freeze outgoing frame for this clip's transition
      drawClipIdx = idx;
      const isRec = activeIsRecording();
      if (isRec && camReady) {
        try { camVideo.currentTime = camTimeFor(c.start); camVideo.playbackRate = sp * camDurRatio(); await camVideo.play().catch(() => {}); } catch (_) {}
      } else if (camReady && !camVideo.paused) { camVideo.pause(); }
      // Draw the clip's start frame now, so its slots are never filled with the
      // previous clip's frame if play()/the frame callback stalls.
      drawAt(c.start); updateOverlayPlayback(base); drawOverlays(base);
      video.playbackRate = sp;
      await video.play().catch(() => {});
      // Play through the clip, emitting output slots by content time (hold-behind).
      // Captured via requestAnimationFrame + video.currentTime — the same mechanism
      // preview uses, which works for these off-screen source elements (unlike
      // requestVideoFrameCallback, which needs an on-screen video to fire).
      let stall = 0, lastSrc = -1;
      for (;;) {
        await nextRaf();
        const src = video.currentTime;
        if (video.ended || src >= c.end - 1e-3) break;
        // Bail if playback isn't advancing (paused/stalled/backgrounded RAF), so a
        // stuck clip can't spin forever — its remaining slots get hold-filled below.
        if (src <= lastSrc + 1e-4) { if (++stall > 180) break; } else { stall = 0; lastSrc = src; }
        const te = base + (src - c.start) / sp;
        let count = 0;
        while ((nextSlot / fps) < te && nextSlot < N) { count++; nextSlot++; } // slots for the PREVIOUS frame (canvas as-is)
        emit(count);
        drawClipIdx = idx;
        drawAt(src);              // draw this frame (+ transition composite while in-window)
        updateOverlayPlayback(te);
        drawOverlays(te);
        if (onProgress && (processed % 5 === 0)) onProgress(Math.min(1, nextSlot / N)); // keep the bar moving within long clips
        if (++processed % 30 === 0) { await sendQueue; if (sendErr) throw sendErr; } // bound memory / pace to disk
      }
      video.pause();
      if (camReady && !camVideo.paused) camVideo.pause();
      // Fill the rest of this clip's slots with the last drawn frame.
      let count = 0;
      while ((nextSlot / fps) < clipEndTe && nextSlot < N) { count++; nextSlot++; }
      emit(count);
      base = clipEndTe;
      if (onProgress) onProgress(Math.min(1, base / total));
    }
    // Flush any trailing slots (rounding) with the final frame.
    let tail = 0;
    while (nextSlot < N) { tail++; nextSlot++; }
    emit(tail);
    capturing = false; pauseOverlayEls(); updateAudioRouting();
    await sendQueue;
    if (sendErr) throw sendErr;
    return await window.api.endExportCapture();
  } catch (err) {
    capturing = false; pauseOverlayEls(); updateAudioRouting();
    try { await window.api.abortExportCapture(); } catch (_) {}
    throw err;
  }
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
