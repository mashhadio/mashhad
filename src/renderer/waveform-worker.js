'use strict';

// Computes per-bucket peak amplitudes from decoded PCM channel data off the
// main thread. Pure numeric work with no DOM/Web Audio dependency, so it can
// run here instead of blocking the UI thread for the duration of a long
// import's peak extraction (see ensureWaveform in editor-timeline-render.js).
self.onmessage = (e) => {
  const { id, channels, sampleRate, peaksPerSec } = e.data;
  try {
    const per = sampleRate / peaksPerSec; // samples per peak bucket
    const length = channels[0].length;
    const totalPeaks = Math.max(1, Math.ceil((length / sampleRate) * peaksPerSec));
    const peaks = new Float32Array(totalPeaks);
    for (let ch = 0; ch < channels.length; ch++) {
      const data = channels[ch];
      for (let i = 0; i < data.length; i++) {
        const b = (i / per) | 0;
        const a = data[i] < 0 ? -data[i] : data[i];
        if (a > peaks[b]) peaks[b] = a;
      }
    }
    let maxPeak = 0;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > maxPeak) maxPeak = peaks[i];
    self.postMessage({ id, peaks, maxPeak }, [peaks.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
