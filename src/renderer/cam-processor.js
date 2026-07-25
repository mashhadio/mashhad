'use strict';

// Live webcam pipeline: pulls frames from the selected camera, optionally runs
// MediaPipe Selfie Segmentation to blur the background, and renders to a canvas.
// The same canvas is shown as a preview AND captured for recording, so whatever
// the user sees (blurred or not) is exactly what gets recorded.
//
// If MediaPipe fails to load (offline asset issue, unsupported GPU, etc.) the
// processor degrades gracefully to a plain pass-through and reports
// blurAvailable = false so the UI can disable the blur toggle.

(function (global) {
  class CameraProcessor {
    constructor(canvas) {
      this.canvas = canvas;
      // CPU-backed canvas: avoids green/empty frames when the webcam canvas is
      // captured by MediaRecorder during recording.
      this.ctx = canvas.getContext('2d', { willReadFrequently: true });
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      // Background: 'none' (pass-through) | 'blur' | 'color' | 'image'.
      this.bgMode = 'none';
      this.bgColor = '#1e293b';
      this.bgImage = null; // HTMLImageElement when bgMode === 'image'
      this.blurAmount = 12;
      this.running = false;
      this.seg = null;
      this.blurAvailable = false;
      this.rawStream = null;
      this._busy = false;
      // Cap the processing loop to this rate. A webcam PiP needs no more than ~30
      // fps, but the loop was driven by requestAnimationFrame — so on a 60/120 Hz
      // display it ran segmentation + the CPU-rendered blur composite 2–4× more
      // often than the recording needs, stealing CPU from the screen encoder
      // (the frame-drop path). Gate to targetFps instead.
      this.targetFps = 30;
      this._lastFrameT = 0;
      // Bumped on every start()/stop() so a stale in-flight start() (still
      // awaiting getUserMedia/play()) or a stale _loop() continuation (still
      // awaiting a segmentation result) from a superseded call can detect that
      // and bail instead of racing the current one.
      this._gen = 0;
    }

    async init() {
      try {
        if (typeof SelfieSegmentation === 'undefined') throw new Error('SelfieSegmentation not loaded');
        this.seg = new SelfieSegmentation({ locateFile: (f) => `vendor/mediapipe/${f}` });
        this.seg.setOptions({ modelSelection: 1, selfieMode: false });
        this.seg.onResults((r) => this._onResults(r));
        this.blurAvailable = true;
      } catch (e) {
        console.warn('Background blur unavailable:', e.message);
        this.blurAvailable = false;
      }
      return this.blurAvailable;
    }

    async start(deviceId) {
      await this.stop();
      const gen = ++this._gen;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      // A newer start() (or a stop()) landed while we awaited getUserMedia —
      // discard this stream rather than binding a stale one over the current state.
      if (gen !== this._gen) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.rawStream = stream;
      this.video.srcObject = this.rawStream;
      await this.video.play();
      if (gen !== this._gen) return; // superseded again during play()
      this.canvas.width = this.video.videoWidth || 1280;
      this.canvas.height = this.video.videoHeight || 720;
      this.running = true;
      this._loop(gen);
    }

    async stop() {
      this._gen++; // invalidate any in-flight start() or _loop() continuation
      this.running = false;
      this._busy = false; // otherwise a rapid stop-then-start could re-arm a new
      // loop while the old one's _busy=true is never cleared, wedging future frames
      if (this.rawStream) {
        this.rawStream.getTracks().forEach((t) => t.stop());
        this.rawStream = null;
      }
      this.video.srcObject = null;
    }

    // Full teardown for good (app-level shutdown) — releases the MediaPipe
    // WASM/GPU resources, unlike stop() which only pauses for a preview toggle.
    close() {
      this.stop();
      if (this.seg) { try { this.seg.close(); } catch (_) {} this.seg = null; }
    }

    setBlur(on) { this.bgMode = on ? 'blur' : 'none'; }
    setBlurAmount(px) { this.blurAmount = px; }
    // mode: 'none'|'blur'|'color'|'image'. value: color string or HTMLImageElement.
    setBackground(mode, value) {
      this.bgMode = mode;
      if (mode === 'color' && value) this.bgColor = value;
      if (mode === 'image') this.bgImage = value || null;
    }
    // Background replacement needs segmentation; 'none' is a plain pass-through.
    _needsSeg() { return this.bgMode !== 'none'; }

    getStream(fps = 30) { return this.canvas.captureStream(fps); }

    // The stream to RECORD. With no background effect, hand back the raw webcam
    // stream directly: its frames come straight from the camera (encoded off the
    // main thread), so the recording doesn't stutter when the per-frame canvas
    // redraw stalls under the CPU load of a simultaneous screen encode — the
    // cause of choppy webcam files. Background replacement still needs the
    // processed canvas, so fall back to it when a background is active.
    recordStream(fps = 30) {
      if (this.bgMode === 'none' && this.rawStream) return this.rawStream;
      return this.canvas.captureStream(fps);
    }

    async _loop(gen) {
      // `gen` pins this call chain to the start() that spawned it — if a
      // stop()/start() has since bumped `_gen`, this is a stale continuation
      // (e.g. still awaiting a segmentation result from before a rapid
      // stop-then-restart) and must not keep running alongside the new loop.
      if (!this.running || gen !== this._gen) return;
      // Rate-limit to targetFps: if the last processed frame was too recent, skip
      // the work this tick and just reschedule. (1ms slack so a ~16.6ms rAF cadence
      // still lands one frame per ~33ms slot rather than dropping to ~20fps.)
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - this._lastFrameT < 1000 / this.targetFps - 1) {
        requestAnimationFrame(() => this._loop(gen));
        return;
      }
      this._lastFrameT = now;
      try {
        if (this._needsSeg() && this.blurAvailable && this.seg && this.video.readyState >= 2) {
          if (!this._busy) {
            this._busy = true;
            await this.seg.send({ image: this.video });
            this._busy = false;
          }
        } else {
          this._drawPlain();
        }
      } catch (e) {
        this._busy = false;
        this._drawPlain();
      }
      if (this.running && gen === this._gen) requestAnimationFrame(() => this._loop(gen));
    }

    _drawPlain() {
      const { ctx, canvas, video } = this;
      if (!video.videoWidth) return;
      ctx.filter = 'none';
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    _onResults(results) {
      const { ctx, canvas } = this;
      const w = canvas.width;
      const h = canvas.height;
      if (!results.image) return;

      ctx.save();
      ctx.clearRect(0, 0, w, h);

      // 1) Draw the person mask, then keep only the person pixels of the frame.
      ctx.filter = 'none';
      ctx.drawImage(results.segmentationMask, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-in';
      ctx.drawImage(results.image, 0, 0, w, h);

      // 2) Paint the chosen background BEHIND the person.
      ctx.globalCompositeOperation = 'destination-over';
      if (this.bgMode === 'color') {
        ctx.filter = 'none';
        ctx.fillStyle = this.bgColor;
        ctx.fillRect(0, 0, w, h);
      } else if (this.bgMode === 'image' && this.bgImage && this.bgImage.width) {
        ctx.filter = 'none';
        // cover-fit the background image into the frame
        const iw = this.bgImage.width, ih = this.bgImage.height;
        const cover = Math.max(w / iw, h / ih);
        const dw = iw * cover, dh = ih * cover;
        ctx.drawImage(this.bgImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else {
        // 'blur' (or 'image' with no loaded image yet): blurred camera frame.
        // Blur is the one costly per-frame filter here, and this canvas is
        // CPU-rendered (willReadFrequently). Blur a half-size copy with half the
        // radius and upscale it — visually ~identical for a soft background but a
        // fraction of the cost, since blur time scales with area × radius.
        const bw = Math.max(1, w >> 1);
        const bh = Math.max(1, h >> 1);
        let buf = this._bgBuf;
        if (!buf) { buf = this._bgBuf = document.createElement('canvas'); this._bgBufCtx = buf.getContext('2d'); }
        if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; }
        const bctx = this._bgBufCtx;
        bctx.clearRect(0, 0, bw, bh);
        bctx.drawImage(results.image, 0, 0, bw, bh);
        ctx.filter = `blur(${Math.max(1, this.blurAmount / 2)}px)`;
        ctx.drawImage(buf, 0, 0, w, h);
      }

      ctx.restore();
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  global.CameraProcessor = CameraProcessor;
})(window);
