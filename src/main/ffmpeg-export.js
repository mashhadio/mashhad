'use strict';

const { spawn } = require('child_process');
const path = require('path');

// ffmpeg-static ships a platform binary. Resolve it and fix the path when the
// app is packaged inside an asar archive.
let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

// RNNoise model (a trained neural net that strips background noise from voice
// far better than a spectral gate). cb.rnnn is the strongest general-purpose
// model. Resolve next to the app, unpacked from asar.
let modelPath = path.join(__dirname, '..', '..', 'assets', 'rnnoise', 'cb.rnnn');
if (modelPath.includes('app.asar')) modelPath = modelPath.replace('app.asar', 'app.asar.unpacked');

// Click sound effects mixed in at each recorded click.
const SFX_DIR = path.join(__dirname, '..', '..', 'assets', 'sfx');
function clickSfxFile(name) {
  const safe = ['mouse', 'mouse_soft'].includes(name) ? name : 'mouse';
  let p = path.join(SFX_DIR, `${safe}.wav`);
  if (p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

const MAX_CLICKS = 400; // cap filtergraph size

// ffmpeg filtergraphs treat ':' as an option separator, so a Windows path must
// have its colon and backslashes escaped.
function ffPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function arnndn() {
  return `arnndn=m='${ffPath(modelPath)}'`;
}

// Microphone cleanup chains applied to the mic track.
//   highpass     -> kill low rumble / AC hum
//   arnndn       -> RNNoise neural denoise (the heavy lifter)
//   afftdn       -> mop up residual hiss
//   acompressor  -> even out voice level
//   loudnorm     -> consistent broadcast loudness
// A gentle downward-expander gate that pushes residual noise down in the gaps
// between speech without hard-cutting word tails. range=0.06 caps attenuation.
const GATE = 'agate=threshold=0.012:range=0.06:ratio=2:attack=5:release=250';

function chains() {
  const rn = arnndn();
  return {
    off: null,
    // light: one RNNoise pass + level.
    light: `highpass=f=90,${rn},loudnorm=I=-16:TP=-1.5:LRA=11`,
    // medium: two RNNoise passes + hiss removal + level + gate.
    medium: `highpass=f=90,${rn},${rn},afftdn=nr=20:nf=-30,acompressor=threshold=-18dB:ratio=3:attack=15:release=220,loudnorm=I=-16:TP=-1.5:LRA=11,${GATE}`,
    // strong: three RNNoise passes + heavy hiss removal + level + firmer gate.
    strong: `highpass=f=100,${rn},${rn},${rn},afftdn=nr=30:nf=-35,anlmdn=s=0.0003,acompressor=threshold=-16dB:ratio=4:attack=12:release=250,loudnorm=I=-15:TP=-1.5:LRA=10,agate=threshold=0.02:range=0.03:ratio=3:attack=5:release=200`,
  };
}

function run(args, onProgress) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg binary not found (ffmpeg-static failed to resolve).'));
      return;
    }
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onProgress) {
        s.split(/\r|\n/).forEach((line) => {
          if (line.trim()) onProgress(line.trim());
        });
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

// A scale filter that downscales to the target height (never upscales) and
// keeps width even. null = keep original resolution.
function scaleFilter(resolution) {
  if (!resolution || resolution === 'original') return null;
  const h = parseInt(resolution, 10);
  if (!h) return null;
  return `scale=-2:'min(${h}\\,ih)':flags=lanczos`;
}

function videoEncoder(format, quality) {
  if (format === 'webm') {
    const crf = { high: 24, balanced: 31, small: 37 }[quality] || 31;
    return ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
  }
  const crf = { high: 18, balanced: 23, small: 28 }[quality] || 23;
  return ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', 'medium'];
}

function audioEncoder(format, quality) {
  const ab = { high: '192k', balanced: '160k', small: '128k' }[quality] || '160k';
  return format === 'webm' ? ['-c:a', 'libopus', '-b:a', ab] : ['-c:a', 'aac', '-b:a', ab];
}

// YouTube's recommended SDR upload bitrates (high frame-rate column, Mbps).
function youtubeVideoEncoder(height) {
  const tiers = [[2160, 60], [1440, 24], [1080, 12], [720, 7.5], [480, 4]];
  let mbps = 2.5;
  for (const [h, mb] of tiers) {
    if (height >= h) { mbps = mb; break; }
  }
  const k = Math.round(mbps * 1000);
  return [
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'slow',
    '-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.25)}k`, '-bufsize', `${k * 2}k`,
    '-g', '120', '-bf', '2',
  ];
}

// Read the pixel height of a video's first video stream.
function probeHeight(filePath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(1080);
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let out = '';
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve(1080));
    proc.on('close', () => {
      const m = out.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      resolve(m ? parseInt(m[2], 10) : 1080);
    });
  });
}

// Build the soundtrack for a timeline that mixes several source files. Each clip
// is trimmed from its own source (or filled with silence when the source has no
// audio) and the segments are concatenated in edit order. Recording-source clips
// get the chosen denoise chain; imported clips pass through untouched. Everything
// is normalised to stereo 48 kHz so concat is valid. Returns the output label, or
// null when the whole timeline is silent. `addInput(path)` registers an ffmpeg
// input and returns its index.
function buildMultiSourceVoice(parts, addInput, cutSegs, sources, recordingSourceId, noiseChain) {
  const STEREO = 'aformat=sample_rates=48000:channel_layouts=stereo';

  // Count how many clips draw audio from each source, then register one input
  // per audio-bearing source and fan it out into one copy per consuming clip.
  const used = {}; // sourceId -> { index, count, queue: [pad labels] }
  for (const c of cutSegs) {
    const s = sources[c.sourceId];
    if (s && s.hasAudio) (used[c.sourceId] || (used[c.sourceId] = { count: 0 })).count++;
  }
  const ids = Object.keys(used);
  if (!ids.length) return null; // entirely silent timeline -> no audio track

  for (const id of ids) {
    const u = used[id];
    u.index = addInput(sources[id].path);
    u.queue = [];
    if (u.count === 1) {
      u.queue.push(`[${u.index}:a]`);
    } else {
      const outs = [];
      for (let i = 0; i < u.count; i++) outs.push(`[s${u.index}_${i}]`);
      parts.push(`[${u.index}:a]asplit=${u.count}${outs.join('')}`);
      u.queue.push(...outs);
    }
  }

  const segLabels = [];
  cutSegs.forEach((c, i) => {
    const s = sources[c.sourceId];
    const seg = `[seg${i}]`;
    if (s && s.hasAudio) {
      const pad = used[c.sourceId].queue.shift();
      const denoise = c.sourceId === recordingSourceId && noiseChain ? `,${noiseChain}` : '';
      parts.push(`${pad}atrim=start=${(+c.start).toFixed(3)}:end=${(+c.end).toFixed(3)},asetpts=PTS-STARTPTS${denoise},${STEREO}${seg}`);
    } else {
      const len = Math.max(0.001, c.end - c.start).toFixed(3);
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${len},asetpts=PTS-STARTPTS${seg}`);
    }
    segLabels.push(seg);
  });

  if (segLabels.length === 1) {
    parts.push(`${segLabels[0]}anull[voice]`);
  } else {
    parts.push(`${segLabels.join('')}concat=n=${segLabels.length}:v=0:a=1[voice]`);
  }
  return '[voice]';
}

/**
 * Mux the canvas-rendered (zoomed + webcam) video with the timeline's audio,
 * applying the chosen noise-reduction chain and optional click sounds, then
 * encode to the requested format.
 */
async function exportVideo({
  zoomedVideoPath,
  clips = null,
  sources = {},
  recordingSourceId = null,
  noiseProfile,
  clickSound,
  clickTimes = [],
  clickSoundName = 'mouse',
  clickVolume = 0.7,
  durationSec = 0,
  format = 'mp4',
  quality = 'balanced',
  resolution = 'original',
  outputPath,
  onProgress,
}) {
  const vf = scaleFilter(resolution);

  // ---- Resolve the audio plan from the clips + their source files ----------
  // The canvas-rendered video already carries every visual (zoom, webcam,
  // transitions, multi-source frames); here we only rebuild the soundtrack.
  // Each clip pulls audio from its own source, trimmed to its range, and the
  // segments are concatenated in edit order so audio tracks the cut video.
  const recPath = recordingSourceId && sources[recordingSourceId] ? sources[recordingSourceId].path : null;
  const recHasAudio = !!(recordingSourceId && sources[recordingSourceId] && sources[recordingSourceId].hasAudio);

  // No clip list => unedited single recording: keep the original simple path.
  const cutSegs = Array.isArray(clips) && clips.length ? clips : null;
  // When every clip comes from the one recording source we can use the original
  // recording-only filtergraph (one mic input, denoised once over the whole
  // concatenated voice). Any imported clip — even a silent one whose gap must be
  // preserved — forces the general multi-source path.
  const pureRecording = !cutSegs || cutSegs.every((c) => c.sourceId === recordingSourceId);

  // ---- GIF: palette-based, silent ----
  if (format === 'gif') {
    const fps = 15;
    const gh = resolution && resolution !== 'original' ? parseInt(resolution, 10) : 600;
    const scale = `fps=${fps},scale=-2:'min(${gh}\\,ih)':flags=lanczos`;
    const args = [
      '-y', '-i', zoomedVideoPath,
      '-filter_complex', `[0:v]${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
      '-loop', '0',
      outputPath,
    ];
    await run(args, onProgress);
    return outputPath;
  }

  // Pick encoders. "youtube" / "master" are MP4 presets.
  const isMp4Container =
    format === 'mp4' || format === 'mov' || format === 'youtube' || format === 'master';
  let vEnc;
  let aEnc;
  if (format === 'youtube') {
    const h = resolution && resolution !== 'original' ? parseInt(resolution, 10) : await probeHeight(zoomedVideoPath);
    vEnc = youtubeVideoEncoder(h);
    aEnc = ['-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-ac', '2'];
  } else if (format === 'master') {
    // Near-visually-lossless H.264 — a clean source to re-edit (CapCut etc.)
    // with lots of headroom so the next re-encode stays sharp.
    vEnc = ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '14'];
    aEnc = ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2'];
  } else {
    vEnc = videoEncoder(format, quality);
    aEnc = audioEncoder(format, quality);
  }

  const clicks = clickSound && clickTimes.length ? clickTimes.slice(0, MAX_CLICKS) : [];
  const useClicks = clicks.length > 0;
  const noiseChain = chains()[noiseProfile];

  // Inputs: input 0 is always the rendered video; audio sources and the click
  // sfx are appended as we discover we need them.
  const args = ['-y', '-i', zoomedVideoPath];
  let inputCount = 1;
  const addInput = (p) => { args.push('-i', p); return inputCount++; };

  // A single filtergraph covers video (scaling) and audio (cut + voice + clicks).
  const parts = [`[0:v]${vf || 'null'}[vout]`];

  // The video is already cut + reordered by the renderer; here we rebuild the
  // soundtrack from the same clips, in the same edit order, so it stays in sync.
  // Two layouts:
  //   mono   — the pure-recording path (the common case): one mic input, denoised
  //            once over the whole concatenated voice (unchanged from before).
  //   stereo — the mixed-source path: each clip pulls audio from its own source.
  let voiceLabel = null;
  let chLayout = 'mono';
  if (pureRecording) {
    if (recHasAudio) {
      const recIdx = addInput(recPath);
      let src = `[${recIdx}:a]`;
      if (cutSegs) {
        const n = cutSegs.length;
        const ins = [];
        if (n === 1) {
          ins.push(`[${recIdx}:a]`);
        } else {
          const splitOuts = cutSegs.map((_, i) => `[m${i}]`).join('');
          parts.push(`[${recIdx}:a]asplit=${n}${splitOuts}`);
          for (let i = 0; i < n; i++) ins.push(`[m${i}]`);
        }
        const labels = [];
        cutSegs.forEach((s, i) => {
          parts.push(`${ins[i]}atrim=start=${(+s.start).toFixed(3)}:end=${(+s.end).toFixed(3)},asetpts=PTS-STARTPTS[vc${i}]`);
          labels.push(`[vc${i}]`);
        });
        parts.push(`${labels.join('')}concat=n=${n}:v=0:a=1[vcut]`);
        src = '[vcut]';
      }
      const voiceChain = noiseChain ? noiseChain : 'aformat=sample_rates=48000:channel_layouts=mono';
      parts.push(`${src}${voiceChain}[voice]`);
      voiceLabel = '[voice]';
    }
  } else {
    chLayout = 'stereo';
    voiceLabel = buildMultiSourceVoice(parts, addInput, cutSegs, sources, recordingSourceId, noiseChain);
  }

  if (useClicks) {
    const clickIdx = addInput(clickSfxFile(clickSoundName));
    const mixIns = [];
    const dur = durationSec > 0 ? durationSec.toFixed(3) : 3600;
    parts.push(`anullsrc=r=48000:cl=${chLayout}:d=${dur}[base]`);
    mixIns.push('[base]');
    if (voiceLabel) mixIns.push(voiceLabel);

    const splitOuts = clicks.map((_, i) => `[c${i}]`).join('');
    parts.push(`[${clickIdx}:a]asplit=${clicks.length}${splitOuts}`);
    clicks.forEach((tc, i) => {
      const ms = Math.max(0, Math.round(tc * 1000));
      const vol = Math.max(0, Math.min(2, clickVolume)).toFixed(2);
      parts.push(`[c${i}]adelay=${ms}|${ms},volume=${vol},aformat=sample_rates=48000:channel_layouts=${chLayout}[cd${i}]`);
      mixIns.push(`[cd${i}]`);
    });
    parts.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0:dropout_transition=0[aout]`);

    args.push('-filter_complex', parts.join(';'));
    args.push('-map', '[vout]', '-map', '[aout]', ...vEnc, ...aEnc);
  } else if (voiceLabel) {
    args.push('-filter_complex', parts.join(';'));
    args.push('-map', '[vout]', ...vEnc, '-map', voiceLabel, ...aEnc);
  } else {
    args.push('-filter_complex', parts.join(';'));
    args.push('-map', '[vout]', ...vEnc, '-an');
  }

  // Force constant frame rate so the intermediate (captured at the monitor's
  // refresh rate, possibly VFR) becomes smoothly playable everywhere.
  args.push('-r', '60', '-fps_mode', 'cfr');
  if (isMp4Container) args.push('-movflags', '+faststart');
  args.push('-shortest');
  args.push(outputPath);

  await run(args, onProgress);
  return outputPath;
}

/**
 * Render just the cleaned mic audio (same chain as export) to a file, so the
 * editor can preview the noise-reduced sound before exporting.
 */
async function exportCleanAudio({ inputPath, noiseProfile, outputPath, onProgress }) {
  const chain = chains()[noiseProfile];
  const args = ['-y', '-i', inputPath, '-vn', '-map', '0:a:0'];
  if (chain) args.push('-af', chain);
  args.push('-c:a', 'aac', '-b:a', '192k', outputPath);
  await run(args, onProgress);
  return outputPath;
}

/** Detect whether a media file contains an audio stream (for old recordings). */
function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let out = '';
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve(false));
    proc.on('close', () => resolve(/Stream #\d+:\d+.*: Audio:/.test(out)));
  });
}

module.exports = { exportVideo, exportCleanAudio, probeHasAudio, ffmpegPath, modelPath };
