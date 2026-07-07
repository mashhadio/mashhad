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
const STEREO = 'aformat=sample_rates=48000:channel_layouts=stereo';

// ffmpeg filtergraphs treat ':' as an option separator, and this path is always
// wrapped in single quotes (see arnndn() below) as a filtergraph-literal, so a
// literal single quote in the path must also be escaped or it would terminate
// the quoted literal early. Not attacker-reachable — `modelPath` is a fixed,
// internal path — but a model/app install path with a quote in it would
// otherwise just break the filtergraph.
function ffPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
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

// Echo / room-reverb reduction, in three strengths. ffmpeg has no ML dereverb,
// but a downward expander (agate) clamps the low-level reverb tail that lingers
// after speech and in the gaps between words; stronger levels lower the
// threshold (catch more of the tail), attenuate deeper (smaller `range`), close
// faster (shorter `release`), and add a light spectral pass for diffuse late
// reflections. It dries a roomy recording — it can't fully remove reverb that
// overlaps continuous speech. Appended AFTER the noise chain so denoise runs first.
// Tuned against a loudness-normalised signal (~-16 LUFS, so speech RMS ~0.1),
// which is why every chain that uses these runs loudnorm FIRST — a fixed
// threshold is only meaningful once the level is predictable. Higher level =
// more aggressive: a higher threshold clamps more of the tail, a smaller `range`
// attenuates it deeper, a shorter release closes faster, and `strong` adds a
// spectral pass for diffuse reflections.
const ECHO_CHAINS = {
  off: null,
  light: 'agate=threshold=0.03:range=0.4:ratio=2:attack=10:release=200',
  medium: 'agate=threshold=0.05:range=0.15:ratio=2.5:attack=8:release=130',
  strong: 'agate=threshold=0.08:range=0.06:ratio=4:attack=5:release=90,afftdn=nr=12:nf=-30',
};

// The mic-cleanup filter for a given noise profile + echo level. Either can be
// 'off'; returns null when both are off (raw audio). The echo gate always runs
// on a level-normalised signal so its threshold behaves the same on any mic.
function voiceChainFor(noiseProfile, echoLevel) {
  const base = chains()[noiseProfile] || null;
  let echo = ECHO_CHAINS[echoLevel] || null;
  if (!echo) return base;
  // The medium/strong denoise chains already run spectral denoise (afftdn/anlmdn)
  // AND end with a gate, so stacking the strong echo's extra afftdn on top thins
  // and pumps the voice. Drop the redundant spectral pass there — the expander
  // alone still dries the reverb tail.
  if (echoLevel === 'strong' && (noiseProfile === 'medium' || noiseProfile === 'strong')) {
    echo = 'agate=threshold=0.08:range=0.06:ratio=4:attack=5:release=90';
  }
  // The denoise chains already end normalised (loudnorm), so append directly.
  if (base) return `${base},${echo}`;
  // Echo-only: normalise first so the gate threshold lines up with speech level.
  return `highpass=f=100,loudnorm=I=-16:TP=-1.5:LRA=11,${echo}`;
}

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
    const STDERR_TAIL = 2000; // only the trailing chars are ever surfaced, on failure
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      // Keep only the trailing STDERR_TAIL chars as data arrives — the failure
      // path only ever reads the tail, so accumulating the full stream for the
      // whole process lifetime (even on success, where it's never read) served
      // no purpose and grows unbounded on a long/verbose export.
      stderr = (stderr + s).slice(-STDERR_TAIL);
      if (onProgress) {
        s.split(/\r|\n/).forEach((line) => {
          if (line.trim()) onProgress(line.trim());
        });
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
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
// Both probes below run ffmpeg with -i and no output, then parse information
// out of the stderr banner it prints — the only difference between them is
// what each is looking for, so they share this spawn/accumulate/parse-on-close
// shape via `parseFn`.
function probeViaStderr(filePath, fallback, parseFn) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(fallback);
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let out = '';
    proc.stderr.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve(fallback));
    proc.on('close', () => resolve(parseFn(out)));
  });
}

function probeHeight(filePath) {
  return probeViaStderr(filePath, 1080, (out) => {
    const m = out.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    return m ? parseInt(m[2], 10) : 1080;
  });
}

// Build the soundtrack for a timeline that mixes several source files. Each clip
// is trimmed from its own source (or filled with silence when the source has no
// audio) and the segments are concatenated in edit order. Recording-source clips
// get the chosen denoise chain; imported clips pass through untouched. Everything
// is normalised to stereo 48 kHz so concat is valid. Returns the output label, or
// null when the whole timeline is silent. `addInput(path)` registers an ffmpeg
// input and returns its index.
function buildMultiSourceVoice(parts, addInput, cutSegs, sources, recordingSourceId, noiseChain, recordingAudioMuted) {
  // A clip contributes audio unless its source is silent, or it's a recording
  // clip whose audio was detached (muted here; supplied by the detached clip).
  const clipHasAudio = (c) => {
    const s = sources[c.sourceId];
    return !!(s && s.hasAudio) && !(recordingAudioMuted && c.sourceId === recordingSourceId);
  };

  // Count how many clips draw audio from each source, then register one input
  // per audio-bearing source and fan it out into one copy per consuming clip.
  const used = {}; // sourceId -> { index, count, queue: [pad labels] }
  for (const c of cutSegs) {
    if (clipHasAudio(c)) (used[c.sourceId] || (used[c.sourceId] = { count: 0 })).count++;
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
    const seg = `[seg${i}]`;
    if (clipHasAudio(c)) {
      const pad = used[c.sourceId].queue.shift();
      const denoise = c.sourceId === recordingSourceId && noiseChain ? `,${noiseChain}` : '';
      const tempo = atempoChain(c.speed);
      parts.push(`${pad}atrim=start=${(+c.start).toFixed(3)}:end=${(+c.end).toFixed(3)},asetpts=PTS-STARTPTS${tempo ? ',' + tempo : ''}${denoise},${STEREO}${seg}`);
    } else {
      // Silent gap: its timeline length is the source range divided by speed.
      const len = Math.max(0.001, (c.end - c.start) / (Number(c.speed) || 1)).toFixed(3);
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
// Build an atempo filter chain for an arbitrary speed factor. atempo only
// accepts 0.5–2.0 per instance, so out-of-range speeds are split into a chain
// (e.g. 4× → atempo=2,atempo=2). Empty string when speed is ~1.
function atempoChain(speed) {
  speed = Number(speed) || 1;
  if (Math.abs(speed - 1) < 1e-3) return '';
  const factors = [];
  let r = speed;
  while (r > 2) { factors.push(2); r /= 2; }
  while (r < 0.5) { factors.push(0.5); r *= 2; }
  factors.push(r);
  return factors.map((f) => `atempo=${f.toFixed(5)}`).join(',');
}

// ---- GIF: palette-based, silent — a self-contained path with none of the
// audio-mixing concerns below. ----------------------------------------------
async function exportGif({ zoomedVideoPath, resolution, outputPath, onProgress }) {
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

// Pick the video/audio encoder args for the requested format/quality (and, for
// "youtube", probe the source height to pick its recommended bitrate tier).
async function pickEncoders(format, quality, resolution, zoomedVideoPath) {
  const isMp4Container = format === 'mp4' || format === 'mov' || format === 'youtube' || format === 'master';
  if (format === 'youtube') {
    const h = resolution && resolution !== 'original' ? parseInt(resolution, 10) : await probeHeight(zoomedVideoPath);
    return { vEnc: youtubeVideoEncoder(h), aEnc: ['-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-ac', '2'], isMp4Container };
  }
  if (format === 'master') {
    // Near-visually-lossless H.264 — a clean source to re-edit (CapCut etc.)
    // with lots of headroom so the next re-encode stays sharp.
    return {
      vEnc: ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '14'],
      aEnc: ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2'],
      isMp4Container,
    };
  }
  return { vEnc: videoEncoder(format, quality), aEnc: audioEncoder(format, quality), isMp4Container };
}

// The canvas capture already carries every visual (zoom, webcam, transitions,
// scene composites) — this filtergraph fragment only applies the optional
// output-resolution scale, producing [vout].
function buildVideoFilterGraph(vf) {
  return `[0:v]${vf || 'null'}[vout]`;
}

// Main-track voice, in one of two layouts (mirroring the video, which the
// renderer already cut + reordered — this rebuilds the matching soundtrack):
//   mono   — the pure-recording path (the common case): one mic input, denoised
//            once over the whole concatenated voice.
//   stereo — the mixed-source path: each clip pulls audio from its own source.
// Pushes filtergraph fragments onto `parts` and registers inputs via
// `addInput`; returns { voiceLabel, chLayout }.
function buildAudioFilterGraph({ parts, addInput, cutSegs, sources, recordingSourceId, recPath, recHasAudio, pureRecording, noiseChain, recordingAudioMuted }) {
  if (!pureRecording) {
    return {
      voiceLabel: buildMultiSourceVoice(parts, addInput, cutSegs, sources, recordingSourceId, noiseChain, recordingAudioMuted),
      chLayout: 'stereo',
    };
  }
  if (!recHasAudio) return { voiceLabel: null, chLayout: 'mono' };

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
      const tempo = atempoChain(s.speed);
      parts.push(`${ins[i]}atrim=start=${(+s.start).toFixed(3)}:end=${(+s.end).toFixed(3)},asetpts=PTS-STARTPTS${tempo ? ',' + tempo : ''}[vc${i}]`);
      labels.push(`[vc${i}]`);
    });
    parts.push(`${labels.join('')}concat=n=${n}:v=0:a=1[vcut]`);
    src = '[vcut]';
  }
  const voiceChain = noiseChain ? noiseChain : 'aformat=sample_rates=48000:channel_layouts=mono';
  parts.push(`${src}${voiceChain}[voice]`);
  return { voiceLabel: '[voice]', chLayout: 'mono' };
}

// Overlay-track audio: each clip trimmed from its source, sped (atempo),
// delayed to its timeline position, and formatted ready to fold into the final
// mix. Returns the list of output labels (possibly empty).
function buildOverlayAudioFilterGraph({ parts, addInput, overlayClips, sources, noiseChain }) {
  const MAX_OVERLAY_AUDIO = 200; // bound the filtergraph size (cf. MAX_CLICKS)
  const overlayLabels = [];
  (Array.isArray(overlayClips) ? overlayClips : []).forEach((c, i) => {
    const s = sources[c.sourceId];
    if (!s || !s.hasAudio) return;               // silent overlay contributes nothing
    if (!(+c.end > +c.start)) return;            // skip degenerate/zero-length clips
    if (overlayLabels.length >= MAX_OVERLAY_AUDIO) return;
    const idx = addInput(s.path);
    const tempo = atempoChain(c.speed);
    const den = c.voice && noiseChain ? ',' + noiseChain : ''; // denoise recorded voice-over
    const vol = Math.max(0, Math.min(4, c.gain != null ? c.gain : 1)).toFixed(2);
    const ms = Math.max(0, Math.round((c.pos || 0) * 1000));
    const lbl = `[ov${i}]`;
    parts.push(
      `[${idx}:a]atrim=start=${(+c.start).toFixed(3)}:end=${(+c.end).toFixed(3)},asetpts=PTS-STARTPTS`
      + `${den}${tempo ? ',' + tempo : ''},volume=${vol},adelay=${ms}|${ms},${STEREO}${lbl}`
    );
    overlayLabels.push(lbl);
  });
  return overlayLabels;
}

// Final mix: silent base + main voice + overlays + click SFX, amix'd together
// when more than one contributes (overlays/clicks are always stereo-formatted,
// so the mix upgrades to stereo whenever either is present). Returns the audio
// label to -map (possibly just `voiceLabel` unchanged, or null if silent).
function buildFinalMix({ parts, addInput, voiceLabel, overlayLabels, chLayout, useClicks, clicks, clickSoundName, clickVolume, durationSec }) {
  const needsMix = useClicks || overlayLabels.length > 0;
  if (!needsMix) return voiceLabel;

  if (overlayLabels.length) chLayout = 'stereo';
  const dur = durationSec > 0 ? durationSec.toFixed(3) : 3600;
  const mixIns = [];
  parts.push(`anullsrc=r=48000:cl=${chLayout}:d=${dur}[base]`);
  mixIns.push('[base]');
  if (voiceLabel) {
    // Match the base layout so amix doesn't up/down-mix unexpectedly.
    parts.push(`${voiceLabel}aformat=sample_rates=48000:channel_layouts=${chLayout}[voicem]`);
    mixIns.push('[voicem]');
  }
  mixIns.push(...overlayLabels);

  if (useClicks) {
    const clickIdx = addInput(clickSfxFile(clickSoundName));
    const splitOuts = clicks.map((_, i) => `[c${i}]`).join('');
    parts.push(`[${clickIdx}:a]asplit=${clicks.length}${splitOuts}`);
    clicks.forEach((tc, i) => {
      const ms = Math.max(0, Math.round(tc * 1000));
      const vol = Math.max(0, Math.min(2, clickVolume)).toFixed(2);
      parts.push(`[c${i}]adelay=${ms}|${ms},volume=${vol},aformat=sample_rates=48000:channel_layouts=${chLayout}[cd${i}]`);
      mixIns.push(`[cd${i}]`);
    });
  }

  parts.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0:dropout_transition=0[aout]`);
  return '[aout]';
}

// Thin orchestrator: resolves the audio plan, builds each filtergraph piece via
// the helpers above, and assembles the final ffmpeg args. Everything ffmpeg-
// specific (encoders, filtergraph syntax, per-layout audio plumbing) lives in
// those helpers; this just wires them together in the right order.
async function exportVideo({
  zoomedVideoPath,
  clips = null,
  overlayClips = [],
  recordingAudioMuted = false,
  sources = {},
  recordingSourceId = null,
  noiseProfile,
  echoLevel = 'off',
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
  if (format === 'gif') return exportGif({ zoomedVideoPath, resolution, outputPath, onProgress });

  const vf = scaleFilter(resolution);
  const { vEnc, aEnc, isMp4Container } = await pickEncoders(format, quality, resolution, zoomedVideoPath);

  // Resolve the audio plan from the clips + their source files. Each clip pulls
  // audio from its own source, trimmed to its range, and the segments are
  // concatenated in edit order so audio tracks the cut video.
  const recPath = recordingSourceId && sources[recordingSourceId] ? sources[recordingSourceId].path : null;
  // When the mic audio is detached, the recording VIDEO clips contribute no audio
  // (the detached clip in overlayClips provides it instead), so treat rec as
  // silent for the video-clip audio path.
  const recHasAudio = !recordingAudioMuted
    && !!(recordingSourceId && sources[recordingSourceId] && sources[recordingSourceId].hasAudio);
  // No clip list => unedited single recording: keep the original simple path.
  const cutSegs = Array.isArray(clips) && clips.length ? clips : null;
  // When every clip comes from the one recording source we can use the original
  // recording-only filtergraph. Any imported clip — even a silent one whose gap
  // must be preserved — forces the general multi-source path.
  const pureRecording = !cutSegs || cutSegs.every((c) => c.sourceId === recordingSourceId);

  const clicks = clickSound && clickTimes.length ? clickTimes.slice(0, MAX_CLICKS) : [];
  const useClicks = clicks.length > 0;
  const noiseChain = voiceChainFor(noiseProfile, echoLevel);

  // Inputs: input 0 is always the rendered video; audio sources and the click
  // sfx are appended as we discover we need them.
  const args = ['-y', '-i', zoomedVideoPath];
  let inputCount = 1;
  const addInput = (p) => { args.push('-i', p); return inputCount++; };

  // A single filtergraph covers video (scaling) and audio (cut + voice + clicks).
  const parts = [buildVideoFilterGraph(vf)];

  const { voiceLabel, chLayout } = buildAudioFilterGraph({
    parts, addInput, cutSegs, sources, recordingSourceId, recPath, recHasAudio, pureRecording, noiseChain, recordingAudioMuted,
  });
  const overlayLabels = buildOverlayAudioFilterGraph({ parts, addInput, overlayClips, sources, noiseChain });
  const audioLabel = buildFinalMix({
    parts, addInput, voiceLabel, overlayLabels, chLayout, useClicks, clicks, clickSoundName, clickVolume, durationSec,
  });

  args.push('-filter_complex', parts.join(';'));
  if (audioLabel) args.push('-map', '[vout]', '-map', audioLabel, ...vEnc, ...aEnc);
  else args.push('-map', '[vout]', ...vEnc, '-an');

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
async function exportCleanAudio({ inputPath, noiseProfile, echoLevel = 'off', outputPath, onProgress }) {
  const chain = voiceChainFor(noiseProfile, echoLevel);
  const args = ['-y', '-i', inputPath, '-vn', '-map', '0:a:0'];
  if (chain) args.push('-af', chain);
  args.push('-c:a', 'aac', '-b:a', '192k', outputPath);
  await run(args, onProgress);
  return outputPath;
}

/** Detect whether a media file contains an audio stream (for old recordings). */
function probeHasAudio(filePath) {
  return probeViaStderr(filePath, false, (out) => /Stream #\d+:\d+.*: Audio:/.test(out));
}

module.exports = { exportVideo, exportCleanAudio, probeHasAudio };
