'use strict';

// Off-main-thread region crop (report finding #33). desktopCapturer only grabs a
// whole screen, so "record an area" means cropping the chosen sub-rectangle out
// of every captured frame. The main-thread path (index.js startRegionCropMainThread)
// does that with a per-frame Canvas2D drawImage inside requestAnimationFrame,
// competing with everything else the renderer does. Here we do it off-thread:
//
//   MediaStreamTrackProcessor.readable  (VideoFrames in)  -> this worker
//   OffscreenCanvas drawImage(frame, cropRect -> outRect)
//   MediaStreamTrackGenerator.writable  (VideoFrames out) -> recorded stream
//
// Both stream endpoints are transferred in from the main thread. We post
// 'firstframe' once the first output frame is written so the main thread can
// confirm the pipeline actually works and otherwise fall back — it is never
// assumed to succeed just because the WebCodecs APIs exist.

let stopped = false;

self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.type === 'stop') { stopped = true; return; }

  const { readable, writable, cx, cy, cw, ch, outW, outH } = d;
  if (!readable || !writable) return;

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d', { alpha: false });
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let announced = false;

  try {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      if (stopped) { frame.close(); break; }
      // Draw the crop sub-rectangle scaled into the output canvas.
      ctx.drawImage(frame, cx, cy, cw, ch, 0, 0, outW, outH);
      const ts = frame.timestamp; // microseconds — carry it onto the output frame
      frame.close();              // release the input frame promptly (no leak)
      const out = new VideoFrame(canvas, { timestamp: ts });
      // write() applies the generator's backpressure, pacing us to the consumer.
      await writer.write(out);
      out.close();
      if (!announced) { announced = true; self.postMessage('firstframe'); }
    }
  } catch (_) {
    // Stream closed/aborted, or an unsupported operation. If this happened before
    // 'firstframe', the main thread's timeout fires and it falls back to the
    // main-thread crop; after 'firstframe' the recording simply ends here.
  } finally {
    try { reader.cancel(); } catch (_) {}
    try { await writer.close(); } catch (_) {}
  }
};
