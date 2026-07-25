'use strict';

// editor-state.js — part of the editor.js module split (see editor.html for load order).
// Shared module state: DOM element refs, playback/edit/session state, tiny pure helpers (hexToRgb/clamp/fmt). Loaded first — every other editor-*.js file reads/writes these top-level bindings.

'use strict';

// `video` points at the ACTIVE source's <video> element. The timeline can mix
// several source files; only one plays/draws at a time, and `setActiveEl` swaps
// this reference as playback crosses from one source to another.
let video = document.getElementById('srcVideo');
const camVideo = document.getElementById('camVideo');
const canvas = document.getElementById('preview');
// willReadFrequently forces a CPU-backed canvas. This both speeds up the pixel
// work and avoids a Chromium bug where MediaRecorder capturing a GPU-backed
// canvas emits empty (green) frames in the exported video.
const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

const playBtn = document.getElementById('playBtn');
const timeLabel = document.getElementById('timeLabel');
const timeline = document.getElementById('timeline');
const playhead = document.getElementById('playhead');
const tlOverlays = document.getElementById('tlOverlays');
const tlAudio = document.getElementById('tlAudio');
const tlRuler = document.getElementById('tlRuler');
const linkAudio = document.getElementById('linkAudio');
const addTrackBtn = document.getElementById('addTrackBtn');
const voBtn = document.getElementById('voBtn');
const importAudioBtn = document.getElementById('importAudioBtn');

const autoZoomBtn = document.getElementById('autoZoomBtn');
const addZoomBtn = document.getElementById('addZoomBtn');
const clearZoomBtn = document.getElementById('clearZoomBtn');
const splitBtn = document.getElementById('splitBtn');
const removeSilenceBtn = document.getElementById('removeSilenceBtn');
const silenceSens = document.getElementById('silenceSens');
const silenceSensVal = document.getElementById('silenceSensVal');
const silenceGap = document.getElementById('silenceGap');
const silenceGapVal = document.getElementById('silenceGapVal');
const silenceGroup = document.getElementById('silenceGroup');
const silenceStatus = document.getElementById('silenceStatus');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const clipTransition = document.getElementById('clipTransition');
const speedGroup = document.getElementById('speedGroup');
const speedRange = document.getElementById('speedRange');
const speedVal = document.getElementById('speedVal');
const sceneGroup = document.getElementById('sceneGroup');
const sceneTransRange = document.getElementById('sceneTransRange');
const sceneTransValEd = document.getElementById('sceneTransValEd');
const zoomLevel = document.getElementById('zoomLevel');
const zoomLevelVal = document.getElementById('zoomLevelVal');
const zoomLevelLabel = document.getElementById('zoomLevelLabel');
const smoothRamp = document.getElementById('smoothRamp');
const smoothVal = document.getElementById('smoothVal');
const noiseProfile = document.getElementById('noiseProfile');
const echoLevel = document.getElementById('echoLevel');
const audioStatus = document.getElementById('audioStatus');

const camControls = document.getElementById('camControls');
const camShow = document.getElementById('camShow');
const camPos = document.getElementById('camPos');
const camShape = document.getElementById('camShape');
const camSize = document.getElementById('camSize');
const camSizeVal = document.getElementById('camSizeVal');

const clickFx = document.getElementById('clickFx');
const clickStyle = document.getElementById('clickStyle');
const clickColor = document.getElementById('clickColor');
const clickSize = document.getElementById('clickSize');
const clickSizeVal = document.getElementById('clickSizeVal');
const clickSound = document.getElementById('clickSound');
const clickSoundName = document.getElementById('clickSoundName');
const clickVol = document.getElementById('clickVol');
const clickVolVal = document.getElementById('clickVolVal');

const exportFormat = document.getElementById('exportFormat');
const exportQuality = document.getElementById('exportQuality');
const exportResolution = document.getElementById('exportResolution');
const audioSync = document.getElementById('audioSync');
const audioSyncVal = document.getElementById('audioSyncVal');

const exportBtn = document.getElementById('exportBtn');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const exportStatus = document.getElementById('exportStatus');
const backBtn = document.getElementById('backBtn');
const topStatus = document.getElementById('topStatus');

let project = null;
// The recording source ({ id, cursor, camUrl, hasAudio, ... }) when the editor
// was opened from a recording, else null (studio-direct / import-only session).
// Zoom-tracking, click effects and the webcam overlay only apply to it.
let recording = null;
// All timeline media sources. Each: { id, kind:'recording'|'import', url, el,
// duration, width, height, hasAudio, name }. Clips reference these by `sourceId`.
let sources = [];
let activeSourceId = null;
let sourceSeq = 0;

let engine = null;
// A cursor-free engine for imported clips: same smooth zoom ramps, but pans to
// centre (imports have no cursor data to follow).
let plainEngine = null;
// Zoom blocks. Each carries a `sourceId` and its start/end are in that source's
// own time, so a block stays attached to its footage across reorders. Recording
// blocks pan with the cursor; import blocks zoom to centre.
let blocks = [];
let selectedBlock = null;
let defaultScale = 2.0;
let duration = 0;

// Non-linear timeline. `clips` is an ordered list of source-time ranges that
// play back-to-back in EDIT order — so reordering, splitting and deleting clips
// all just rewrite this array. The video element always holds SOURCE time; the
// timeline/playhead work in "edited time" (cumulative clip lengths).
let clips = [];
let selectedClipId = null;
let clipSeq = 0;            // id generator so selection survives reorders
let clipHistory = [];       // snapshots of `clips` for undo
let clipFuture = [];        // snapshots of `clips` for redo
let playIdx = 0;            // index of the clip currently at the playhead
let playheadEdited = 0;     // playhead position in edited time (seconds)
let drawClipIdx = 0;        // clip index the current frame belongs to

// ---------------------------------------------------------------------------
// Overlay video tracks (CapCut-style layering). The main track (`clips`) plays
// as before; overlay clips are positioned in EDITED time (`pos`) within the main
// timeline, and at any instant the TOP-most overlay clip covering the playhead
// is drawn full-frame over the main video ("the top layer is what shows").
// `speed` is carried on every clip for Phase 2 (default 1); `pos`/len are in
// edited seconds. Overlay clips reference `sources` by `sourceId` like main clips.
// ---------------------------------------------------------------------------
let overlayTracks = []; // [{ id, clips: [{ id, sourceId, start, end, pos, speed }] }]
let overlayClipSeq = 0;
let overlayTrackSeq = 0;
let selectedOverlay = null; // { clipId } or null
// Each overlay clip gets its OWN hidden <video> (keyed by clip id) so it never
// fights the main `video` element or another overlay clip from the same source.
const overlayEls = new Map();

// Audio tracks (voice-over / audio clips), rendered below the main track. Not
// drawn — mixed into the export and played through per-clip <audio> elements in
// preview. Clips carry `pos`/`speed`/`gain` and `voice:true` for recorded VO.
let audioTracks = []; // [{ id, clips: [{ id, sourceId, start, end, pos, speed, gain, voice }] }]
let audioClipSeq = 0;
let audioTrackSeq = 0;
let selectedAudio = null; // { clipId } or null
const audioEls = new Map(); // clipId -> <audio>
let voState = null; // active voice-over recording: { recorder, chunks, startPos, stream, startTime }
let voArming = false; // true between the VO click and the mic stream resolving

// Name of the .ssproj backing this session (set after a manual save or when the
// editor was opened from a project). While set, edits are auto-saved to it.
let projectFileName = null;

// Clip transitions. Each clip can carry an intro `transition` ({type,duration})
// describing how it enters from the previous clip — so it follows the clip on
// reorder. We render it without a second decoder: when playback leaves a clip we
// snapshot its last frame to an offscreen canvas, then composite that frozen
// "outgoing" frame over the incoming clip's first `duration` seconds.
const DEFAULT_TRANSITION_DUR = 0.5;
const TRANSITION_LABELS = {
  fade: 'تلاشٍ', crossfade: 'تلاشٍ متقاطع', slide: 'انزلاق', wipe: 'مسح', zoom: 'تكبير',
};
const transCanvas = document.createElement('canvas');
const transCtx = transCanvas.getContext('2d', { alpha: false });
let transSnapIdx = -1;      // incoming clip index the snapshot is the outgoing frame for
let rafId = null;

// Recording "scenes" (screen / cam / both), switched live with F1/F2/F3 and
// logged in the recording. The editor composites them per source time with a
// crossfade. `sceneEvents` are { t (source seconds), scene }. Empty = no scene
// mode → the recording renders exactly as before.
let sceneEvents = [];
let sceneTransDur = 0.3;    // crossfade seconds (adjustable in the editor)
// Frozen outgoing-scene frame for the crossfade (separate from clip transitions).
const sceneTransCanvas = document.createElement('canvas');
const sceneTransCtx = sceneTransCanvas.getContext('2d', { alpha: false });
let lastDrawnScene = null;  // scene of the previous drawn frame (linear playback)
let lastSceneT = 0;         // source time of the previous scene-composed frame
let sceneXfadeFrom = null;  // outgoing scene during an active crossfade, or null
let sceneXfadeStart = 0;    // source time the crossfade began
// Playback intent. Drives the render loop independently of any single element's
// paused state — crossing into a new source momentarily pauses the fresh element
// while its async play() resolves, and we must not let that stop the loop.
let playing = false;
// True while a clip-advance seek is in flight. A just-activated element reports a
// STALE currentTime until its seek lands; without this guard the render loop's
// clip-end test could read that stale value and skip the new clip outright.
let mediaSeeking = false;
let exporting = false;
let capturing = false; // true only during the export canvas-capture pass
let camReady = false;

// Cleaned-audio preview: plays the ffmpeg-denoised mic in sync with the video so
// the noise setting can be heard before exporting.
const cleanAudio = new Audio();
let cleanAudioActive = false;
let audioPreviewToken = 0;

// Webcam overlay placement as the CENTRE of the overlay, in 0..1 of the frame.
let camFx = 0.85;
let camFy = 0.85;

// Click effects
const CLICK_FX_DUR = 0.45; // seconds
let clickTimes = []; // click times in seconds
let clickAudio = new Audio('../../assets/sfx/mouse.wav');
let lastFxTime = 0;

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 255, g: 205, b: 60 };
}

const DEFAULT_BLOCK_LEN = 2.4;

// Worst-case bound for resolving the main recording's real duration (its webm
// reports Infinity until the seek-past-end trick lands). Generous on purpose: a
// long/4K capture on a busy disk can take a while, and timing out to 0 here
// yields an empty editor (see the recording load path in editor-playback.js).
const REC_DURATION_TIMEOUT_MS = 10000;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = String(Math.floor(t / 60)).padStart(2, '0');
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
