'use strict';

// Shared zoom/pan engine used by both the editor preview and the export render.
// Given the cursor log and a list of zoom blocks, it computes for any time `t`
// the { scale, cx, cy } transform (cx/cy are normalised 0..1 focal points).
//
// Design goals (the "Screen Studio" feel):
//  - Scale ramps in/out with easeInOutCubic so zooms never pop.
//  - When zoomed in, the view pans to follow a *smoothed* cursor path, so motion
//    is buttery rather than tracking raw jittery samples.
//  - The focal point is clamped so the crop never shows outside the frame.

(function (global) {
  function easeInOutCubic(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  class ZoomEngine {
    /**
     * @param {{samples:Array<{t,x,y}>, clicks:Array<{t,x,y}>}} cursor
     * @param {Array<{start,end,scale}>} blocks  zoom blocks in seconds
     * @param {{ramp:number, smoothing:number}} opts
     */
    constructor(cursor, blocks = [], opts = {}) {
      this.samples = (cursor && cursor.samples) || [];
      this.clicks = (cursor && cursor.clicks) || [];
      this.blocks = blocks;
      this.ramp = opts.ramp != null ? opts.ramp : 0.55; // seconds for zoom in/out
      this.smoothing = opts.smoothing != null ? opts.smoothing : 0.22; // sec time-constant
      this._buildSmoothPath();
    }

    setBlocks(blocks) {
      this.blocks = blocks;
    }

    // Pre-compute a low-pass filtered cursor path (in seconds) so panning is smooth.
    _buildSmoothPath() {
      const s = this.samples;
      this.path = [];
      if (!s.length) return;
      let sx = s[0].x;
      let sy = s[0].y;
      let prevT = s[0].t / 1000;
      this.path.push({ t: prevT, x: sx, y: sy });
      for (let i = 1; i < s.length; i++) {
        const t = s[i].t / 1000;
        const dt = Math.max(0.001, t - prevT);
        const alpha = 1 - Math.exp(-dt / this.smoothing);
        sx += (s[i].x - sx) * alpha;
        sy += (s[i].y - sy) * alpha;
        this.path.push({ t, x: sx, y: sy });
        prevT = t;
      }
    }

    _cursorAt(t) {
      const p = this.path;
      if (!p.length) return { x: 0.5, y: 0.5 };
      if (t <= p[0].t) return { x: p[0].x, y: p[0].y };
      if (t >= p[p.length - 1].t) return { x: p[p.length - 1].x, y: p[p.length - 1].y };
      // binary search
      let lo = 0;
      let hi = p.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (p[mid].t <= t) lo = mid;
        else hi = mid;
      }
      const a = p[lo];
      const b = p[hi];
      const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }

    _scaleAt(t) {
      let scale = 1;
      const R = this.ramp;
      for (const blk of this.blocks) {
        if (t < blk.start || t > blk.end) continue;
        const target = blk.scale;
        let s;
        const inEnd = blk.start + R;
        const outStart = blk.end - R;
        if (t < inEnd && t < outStart) {
          const p = (t - blk.start) / R;
          s = 1 + (target - 1) * easeInOutCubic(clamp(p, 0, 1));
        } else if (t > outStart && t > inEnd) {
          const p = (blk.end - t) / R;
          s = 1 + (target - 1) * easeInOutCubic(clamp(p, 0, 1));
        } else if (t >= inEnd && t <= outStart) {
          s = target;
        } else {
          // Block shorter than 2*ramp: triangular ramp.
          const half = (blk.end - blk.start) / 2;
          const d = Math.min(t - blk.start, blk.end - t);
          const p = clamp(d / Math.max(1e-3, half), 0, 1);
          s = 1 + (target - 1) * easeInOutCubic(p);
        }
        if (s > scale) scale = s;
      }
      return scale;
    }

    /** Returns { scale, cx, cy } for time t (seconds). */
    getState(t) {
      const scale = this._scaleAt(t);
      if (scale <= 1.0001) return { scale: 1, cx: 0.5, cy: 0.5 };
      const c = this._cursorAt(t);
      const half = 0.5 / scale;
      const cx = clamp(c.x, half, 1 - half);
      const cy = clamp(c.y, half, 1 - half);
      return { scale, cx, cy };
    }

    /**
     * Draw the zoomed frame for the given source onto a 2D canvas context.
     * Source may be a video element or any drawable with width/height.
     */
    drawFrame(ctx, source, srcW, srcH, dstW, dstH, t) {
      const { scale, cx, cy } = this.getState(t);
      const cropW = srcW / scale;
      const cropH = srcH / scale;
      let sx = cx * srcW - cropW / 2;
      let sy = cy * srcH - cropH / 2;
      sx = clamp(sx, 0, srcW - cropW);
      sy = clamp(sy, 0, srcH - cropH);
      ctx.drawImage(source, sx, sy, cropW, cropH, 0, 0, dstW, dstH);
    }

    /**
     * Map a normalised source point (0..1) to canvas pixel coords, accounting
     * for the current zoom/pan transform. Used to draw click effects in the
     * right place inside the zoomed view. Returns { x, y, scale }.
     */
    mapPoint(nx, ny, srcW, srcH, dstW, dstH, t) {
      const { scale, cx, cy } = this.getState(t);
      const cropW = srcW / scale;
      const cropH = srcH / scale;
      let sx = cx * srcW - cropW / 2;
      let sy = cy * srcH - cropH / 2;
      sx = clamp(sx, 0, srcW - cropW);
      sy = clamp(sy, 0, srcH - cropH);
      return {
        x: ((nx * srcW - sx) / cropW) * dstW,
        y: ((ny * srcH - sy) / cropH) * dstH,
        scale,
      };
    }

    /**
     * Auto-generate zoom blocks from clicks: zoom in shortly before each click,
     * hold on it, then release. Overlapping windows are merged into one block.
     */
    static autoBlocks(cursor, { scale = 2.0, lead = 0.45, hold = 1.9, duration } = {}) {
      const clicks = (cursor && cursor.clicks) || [];
      if (!clicks.length) return [];
      const windows = clicks.map((c) => {
        const t = c.t / 1000;
        return { start: Math.max(0, t - lead), end: t + hold, scale };
      });
      windows.sort((a, b) => a.start - b.start);
      const merged = [windows[0]];
      for (let i = 1; i < windows.length; i++) {
        const last = merged[merged.length - 1];
        const w = windows[i];
        if (w.start <= last.end + 0.3) {
          last.end = Math.max(last.end, w.end);
          last.scale = Math.max(last.scale, w.scale);
        } else {
          merged.push(w);
        }
      }
      if (duration) merged.forEach((m) => (m.end = Math.min(m.end, duration)));
      return merged;
    }
  }

  global.ZoomEngine = ZoomEngine;
})(window);
