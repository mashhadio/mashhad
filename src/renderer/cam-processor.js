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
      this.blur = false;
      this.blurAmount = 12;
      this.running = false;
      this.seg = null;
      this.blurAvailable = false;
      this.rawStream = null;
      this._busy = false;
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
      this.rawStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      this.video.srcObject = this.rawStream;
      await this.video.play();
      this.canvas.width = this.video.videoWidth || 1280;
      this.canvas.height = this.video.videoHeight || 720;
      this.running = true;
      this._loop();
    }

    async stop() {
      this.running = false;
      if (this.rawStream) {
        this.rawStream.getTracks().forEach((t) => t.stop());
        this.rawStream = null;
      }
      this.video.srcObject = null;
    }

    setBlur(on) { this.blur = on; }
    setBlurAmount(px) { this.blurAmount = px; }

    getStream(fps = 30) { return this.canvas.captureStream(fps); }

    async _loop() {
      if (!this.running) return;
      try {
        if (this.blur && this.blurAvailable && this.seg && this.video.readyState >= 2) {
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
      if (this.running) requestAnimationFrame(() => this._loop());
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

      // 2) Paint the blurred frame behind the person.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.filter = `blur(${this.blurAmount}px)`;
      ctx.drawImage(results.image, 0, 0, w, h);

      ctx.restore();
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  global.CameraProcessor = CameraProcessor;
})(window);
