import { useEffect, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { dronePanWeights, panWidth } from '../audio/StereoMode';
import { droneWave, keyboardWave } from '../audio/Wave';
import {
  getShapeTable, getHilbertTables, wtLookup, wtLookupRad,
} from '../audio/visualShape';
import { updateAudioFeatures } from '../audio/AudioFeatures';
import palette from '../theme/palette';

// Synth-buffer length policy for the XY / Hilbert / face scopes.
// - At low frequencies, we want a long buffer so the trace visibly
//   drifts frame-to-frame (the "playhead" feel below ~130 Hz).
// - At high frequencies, we want a short buffer so the figure shows
//   only a handful of cycles instead of dozens of overlapping copies
//   that smear from sub-pixel jitter and accumulated phase noise.
// Adaptive N = clamp(target_cycles × sampleRate / highestFreq, MIN, MAX).
// Sized off the HIGHEST active freq so a multi-kHz pair gets a short
// buffer regardless of any bass present — bass will visualize as a
// near-DC offset rather than a full cycle, but trying to do both
// well is impossible (long enough for bass = treble smears 20+ cycles).
// Rounded to a multiple of N_STEP so dragging an orb across the cap
// boundary doesn't make N (and therefore the figure) breathe.
// See research/oscilloscope-frequency-adaptive.md for the full diagnosis.
const VIZ_BUF_MIN_N = 128;
const VIZ_BUF_MAX_N = 2048;
const VIZ_BUF_N_STEP = 32;

// Base amplitude scale for the 'audio'-source XY scope. The analyzer now
// taps pre-master (so the final fader doesn't size the visualizer), which
// means the time-domain signal it reads runs at full pre-fader level and
// overflows the scope. Scale it down so the figure sits at a sane base
// size; the individual source mixers (drone/keyboard/midi) still ride it
// above/below this. Synth-source scopes are already normalized, so this
// only applies to the audio path.
const AUDIO_AMP_SCALE = 0.315;

function adaptiveBufferSize(highestActiveFreq, sampleRate, targetCycles) {
  if (!(highestActiveFreq > 0)) return VIZ_BUF_MAX_N;
  const ideal = (targetCycles * sampleRate) / highestActiveFreq;
  const stepped = Math.round(ideal / VIZ_BUF_N_STEP) * VIZ_BUF_N_STEP;
  return Math.max(VIZ_BUF_MIN_N, Math.min(VIZ_BUF_MAX_N, stepped));
}

// Highest-frequency component currently sounding (drone or keyboard).
// Returns 0 if nothing is making sound — caller falls back to
// VIZ_BUF_MAX_N. Drones that are muted contribute 0 gain so they're
// excluded; keyboard voices include release tails (still on screen).
function highestActiveFreq() {
  let highest = 0;
  const freqs = audioEngine.getAllFrequencies();
  for (let i = 0; i < freqs.length; i++) {
    if (audioEngine.isMuted(i)) continue;
    const f = freqs[i];
    if (f > highest) highest = f;
  }
  const voices = keyboardVoiceManager.getVoicesForSynth();
  for (const v of voices) {
    if (v.freq > highest) highest = v.freq;
  }
  return highest;
}

// Lowest-frequency component currently sounding — defines the longest
// period in the signal, so the scope trigger searches at least one full
// period of it to guarantee a zero-crossing is in range. Same active-set
// rules as highestActiveFreq (muted drones excluded, kbd release tails in).
// Returns 0 when nothing is sounding.
function lowestActiveFreq() {
  let lowest = Infinity;
  const freqs = audioEngine.getAllFrequencies();
  for (let i = 0; i < freqs.length; i++) {
    if (audioEngine.isMuted(i)) continue;
    const f = freqs[i];
    if (f > 0 && f < lowest) lowest = f;
  }
  const voices = keyboardVoiceManager.getVoicesForSynth();
  for (const v of voices) {
    if (v.freq > 0 && v.freq < lowest) lowest = v.freq;
  }
  return lowest === Infinity ? 0 : lowest;
}

// Oscilloscope "trigger" — phase-lock the audio-source XY scope by starting
// the render window at a rising zero-crossing on L instead of at the raw
// buffer tail. Without it, each frame captures an arbitrary phase of the
// waveform, so the Lissajous figure's endpoints and self-overlap jitter
// frame-to-frame (the flicker). Locking every frame to the same kind of
// crossing makes successive frames retrace the same curve from the same
// point, so the persisted trace overlaps and the figure holds still.
//
// Returns a start index ≤ the most-recent-window start (so the figure stays
// current), chosen as the LATEST rising crossing within ~1.5 fundamental
// periods. Hysteresis (the signal must dip below −thresh before a crossing
// counts) rejects the extra mid-period zero-crossings that wavefolded /
// multi-osc signals produce — without it the trigger would latch onto a
// different crossing each frame and trade one flicker for another. Falls
// back to the plain tail start when the signal is too quiet to trigger
// cleanly, so silence / DC degrade gracefully instead of locking to noise.
function triggeredStart(L, synthN, lowestHz, sampleRate) {
  const desiredStart = Math.max(0, L.length - synthN);
  if (desiredStart <= 0 || !(lowestHz > 0)) return desiredStart;

  const period = sampleRate / lowestHz;
  const span = Math.min(desiredStart, Math.ceil(period * 1.5));
  const lo = desiredStart - span;

  // Amplitude-relative hysteresis threshold from the search window's peak,
  // so the trigger is robust across volume levels and bails on silence.
  let peak = 0;
  for (let i = lo; i <= desiredStart; i++) {
    const a = L[i] < 0 ? -L[i] : L[i];
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return desiredStart;
  const thresh = peak * 0.1;

  let armed = false;
  let trigger = -1;
  for (let i = lo + 1; i <= desiredStart; i++) {
    if (L[i] < -thresh) {
      armed = true;
    } else if (armed && L[i - 1] < 0 && L[i] >= 0) {
      trigger = i;
      armed = false;
    }
  }
  return trigger >= 0 ? trigger : desiredStart;
}

// ── Hilbert FIR (windowed-sinc, 33 taps centered) ─────────────────────
// Used by the "Audio" source path of the Hilbert visualizer to compute
// the 90°-phase-shifted partner of the analyzer's mono signal. The
// ideal Hilbert kernel has h[k] = 2/(πk) for odd k, zero for even k.
// Hamming-windowing tapers the tails so the truncation doesn't ripple
// in the response. 33 taps gives a usable approximation across the
// audible range; longer kernels widen the dead-band near DC + Nyquist
// but cost more per sample. At 8192 input samples × ~16 nonzero taps,
// total cost is ~130k mults/frame — sub-millisecond.
const HILBERT_FIR = (() => {
  const L = 33;
  const center = (L - 1) / 2;
  const h = new Float32Array(L);
  for (let n = 0; n < L; n++) {
    const k = n - center;
    if (k === 0 || k % 2 === 0) {
      h[n] = 0;
      continue;
    }
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (L - 1));
    h[n] = (2 / (Math.PI * k)) * win;
  }
  // Pre-extract the nonzero (odd-k) tap indices + values for a tighter
  // inner loop — skips half the multiplies that would otherwise hit a
  // guaranteed zero.
  const taps = [];
  for (let n = 0; n < L; n++) {
    if (h[n] !== 0) taps.push({ offset: n - center, coef: h[n] });
  }
  return { center, taps };
})();

// Apply the FIR Hilbert transform to `input`, writing into `output`.
// Output[i] approximates the Hilbert-transformed input at sample i.
// Edge samples (within ±center of the buffer ends) get zero-padded
// context, so the very first / last 16 samples are slightly attenuated.
// We slice out only the buffer's middle region for visualization
// downstream, so this edge dimming is invisible.
function hilbertTransform(input, output) {
  const { taps } = HILBERT_FIR;
  const N = input.length;
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (const { offset, coef } of taps) {
      const idx = i + offset;
      if (idx >= 0 && idx < N) sum += coef * input[idx];
    }
    output[i] = sum;
  }
}

// Reusable scratch buffers for analyzer-mode Hilbert. Resized on demand
// so each frame doesn't allocate.
let _hilbertMono = null;
let _hilbertImag = null;
function ensureHilbertScratch(n) {
  if (!_hilbertMono || _hilbertMono.length !== n) {
    _hilbertMono = new Float32Array(n);
    _hilbertImag = new Float32Array(n);
  }
  return { mono: _hilbertMono, imag: _hilbertImag };
}

// ── Viz-only saturation replica ───────────────────────────────────────
// The analysers tap pre-master while the saturator sits post-master, so
// the audible squash never reaches the scope. When the "show in
// oscilloscope" option is on we replay the same memoryless curves
// (mirror of public/soft-limiter-worklet.js — keep in sync) over the
// scope's window here instead of re-plumbing the audio graph. Drive
// matches the audible drive; the master fader stays excluded (the scope
// deliberately never scales with the final fader), so the tap's hotter
// signal makes the squash read somewhat harder than what's audible at
// low master volumes.
const SAT_HALF_PI = Math.PI / 2;
function saturateInto(dst, src, curve, drive) {
  for (let i = 0; i < src.length; i++) {
    const x = src[i] * drive;
    let y;
    if (curve === 1) y = Math.tanh(x); // tanh
    else if (curve === 2) y = x >= 1 ? 1 : x <= -1 ? -1 : 1.5 * x - 0.5 * x * x * x; // cubic
    else if (curve === 3) y = x >= 1 ? 1 : x <= -1 ? -1 : Math.sin(x * SAT_HALF_PI); // sine
    else if (curve === 4) y = x > 1 ? 1 : x < -1 ? -1 : x; // hard clip
    else y = src[i]; // off / unknown — pass through undriven
    dst[i] = y;
  }
}

// Reusable scratch pair so the per-frame saturation pass doesn't allocate.
let _satL = null;
let _satR = null;
function ensureSatScratch(n) {
  if (!_satL || _satL.length !== n) {
    _satL = new Float32Array(n);
    _satR = new Float32Array(n);
  }
  return { L: _satL, R: _satR };
}

// Window function that ramps amplitude to 0 at the left/right edges so
// traces terminate at a single point on the center axis rather than
// hard-cutting. `p` is the sample's normalized position in [0, 1].
function edgeWindow(p, fadeFrac) {
  if (p < fadeFrac) return p / fadeFrac;
  if (p > 1 - fadeFrac) return (1 - p) / fadeFrac;
  return 1;
}

// Trace width drawStatic will use for a given box width. Split out so the
// smiling-face caller can clamp mouth curvature (which needs the chord
// length) with the exact same number drawStatic derives internally.
function staticTraceWidth(width) {
  // Capped at 1.5× the FrequencySpectrumBar's width (which is
  // `min(500, viewport - 40)` — see .freq-spectrum-bar in App.css).
  // Clamped again so it never overflows the canvas itself.
  const spectrumWidth = Math.min(500, Math.max(100, width - 40));
  return Math.min(width - 20, spectrumWidth * 1.5);
}

// Static synthesized view — per-oscillator colored traces (additive bloom)
// in each pool's morphed wave shape (idealized wavetable, so a square
// drone draws as a square), with the XY-scope's cycling color tinting
// the aggregate composite line.
// All synthesis uses `freqs[]` + the tweened `renderVolumes` so mute/
// unmute and freq tweaks animate smoothly.
function drawStatic(
  ctx, width, height, lineScale, r, g, b,
  renderVolumes, smoothedWindow, mode, targetPeriods, options = {}
) {
  // lineWidthScale:    multiplier on the base stroke widths for both
  //                    the per-osc colored lines and the aggregate
  //                    composite. User-controlled via a settings slider.
  // outlineThickness:  extra radius (in CSS pixels, pre-lineScale) of a
  //                    colored outer pass drawn UNDER the white-core
  //                    aggregate — matches the XY scope's neon-tube
  //                    look. 0 means just the white core (current
  //                    behavior); > 0 adds the colored glow halo.
  // curve:             bend of the wave's spine, in [−1, 1]. 0 draws the
  //                    usual straight line; +1 bends it along a full
  //                    semicircle smile (corners up), −1 a semicircle
  //                    frown (corners down). The arc is positioned so its
  //                    AVERAGE height stays at the straight line's height
  //                    — the center dips ~⅓ of the sag one way while the
  //                    corners swing ~⅔ the other — and the wave displaces
  //                    along the arc's radial normal, so partial bends
  //                    morph continuously from the line.
  // curveNeutralOnPause: when true, the bend follows the drone bus
  //                    gain's pause ramp — relaxing to 0 as the drones
  //                    fade out and returning to `curve` as they rise —
  //                    so the smile/frown moves in lockstep with the
  //                    eyes' audio-driven shrink and onset.
  const {
    lineWidthScale = 1, outlineThickness = 0, heightScale = 1,
    curve = 0, curveNeutralOnPause = false,
  } = options;
  // Clearing is the caller's responsibility — drawScope wipes the whole
  // bottom strip (including the reserved orb/UI area) each frame.

  const freqs = audioEngine.getAllFrequencies();
  const volumes = audioEngine.volumeValues || [];
  const phases = audioEngine.getAllPhases();
  // Keyboard voices contribute alongside drones — same standing-wave
  // model, just with envelope-driven amp instead of a tweened slider.
  // Each voice already carries its own phase + smoothed freq from
  // keyboardVoiceManager.updatePhases() in drawScope, so we just read
  // them. The keyboard pool's bus gain (kbd-on/off + volume) is folded
  // in via getKeyboardVizGain() below so muting the kbd bus hides voices
  // visually too. Viz gain excludes the master fader, so muting the final
  // mixer leaves the scope visible (only the kbd/midi mixer fades it).
  const voices = keyboardVoiceManager.getVoicesForSynth();
  const kbdEffectiveGain = audioEngine.getKeyboardVizGain
    ? audioEngine.getKeyboardVizGain()
    : 1;

  // Tween each oscillator's render volume toward its target so mute /
  // unmute / volume changes reshape the trace smoothly.
  const initial = renderVolumes.length === 0;
  while (renderVolumes.length < freqs.length) renderVolumes.push(0);
  const smooth = 0.15;
  for (let i = 0; i < freqs.length; i++) {
    const muted = audioEngine.isMuted(i);
    const target = (freqs[i] > 0 && volumes[i] > 0 && !muted) ? volumes[i] : 0;
    if (initial) {
      renderVolumes[i] = target;
    } else {
      renderVolumes[i] += (target - renderVolumes[i]) * smooth;
      if (Math.abs(renderVolumes[i] - target) < 1e-4) renderVolumes[i] = target;
    }
  }

  const visThreshold = 0.005;
  const isActive = (i) => freqs[i] > 0 && renderVolumes[i] > visThreshold;
  // Voice-side amp is already envelope-shaped (release tail fades it
  // out) and bus-gated — multiply by kbdEffectiveGain so the kbd-off
  // toggle hides voices instantly. Threshold matches drone path.
  const voiceAmp = (v) => v.amp * kbdEffectiveGain;
  const isVoiceActive = (v) => v.freq > 0 && voiceAmp(v) > visThreshold;
  const fadeZone = 0.1;

  // Target fundamental (lowest active freq across drones AND voices).
  // Including voices means a low-pitched key + high drones still picks
  // a window long enough to show the keyboard's slowest cycle.
  let targetFundamental = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    if (isActive(i) && freqs[i] < targetFundamental) targetFundamental = freqs[i];
  }
  for (const v of voices) {
    if (isVoiceActive(v) && v.freq < targetFundamental) targetFundamental = v.freq;
  }
  if (!isFinite(targetFundamental)) {
    for (const f of freqs) if (f > 0 && f < targetFundamental) targetFundamental = f;
  }
  if (!isFinite(targetFundamental)) targetFundamental = 100;

  // Periods to display is now user-controlled via the settings slider
  // (staticPeriods). The smoothing on `periods` below still tweens
  // between old and new values so slider drags glide instead of snap.
  if (smoothedWindow.fundamental === 0) {
    smoothedWindow.fundamental = targetFundamental;
    smoothedWindow.periods = targetPeriods;
  } else {
    const winSmooth = 0.1;
    smoothedWindow.fundamental +=
      (targetFundamental - smoothedWindow.fundamental) * winSmooth;
    smoothedWindow.periods +=
      (targetPeriods - smoothedWindow.periods) * winSmooth;
  }
  const fundamental = smoothedWindow.fundamental;
  const periods = smoothedWindow.periods;

  // Pause → line. A 0→1 factor that eases in while the transport is
  // paused and out when it resumes. It (a) scales the drawn amplitude
  // to zero so the summation wave collapses onto the center line and
  // (b) floors the aggregate's alpha (below) so the resulting flat line
  // stays visible even after the drone bus — and thus volSum — has
  // ramped to 0. Stored on the shared smoothedWindow ref so it persists
  // across frames. Deliberate, designed motion: the wave settles to a
  // resting line rather than just blinking out.
  const pausedTarget = audioEngine.paused ? 1 : 0;
  if (smoothedWindow.pausedFade === undefined) {
    smoothedWindow.pausedFade = pausedTarget;
  } else {
    smoothedWindow.pausedFade += (pausedTarget - smoothedWindow.pausedFade) * 0.12;
  }
  const pausedFade = smoothedWindow.pausedFade;

  const periodSec = 1 / fundamental;
  const windowSec = periods * periodSec;
  const windowHalf = windowSec / 2;

  const traceWidth = staticTraceWidth(width);
  const traceOffsetX = (width - traceWidth) / 2;
  const centerY = height * 0.5;

  // Arc spine for curved mode. Chord length = traceWidth; subtended
  // angle θ = |curve|·π so the extremes are semicircles. The arc's
  // AVERAGE height is pinned at centerY: the mean of cos φ over
  // [−θ/2, θ/2] is sinc(θ/2) = sin(θ/2)/(θ/2), so placing the circle
  // center R·sinc(θ/2) from the line balances the arc about it — the
  // midpoint leaves the line by ~⅓ of the sag and the corners by ~⅔ in
  // the other direction. As curve → 0, R → ∞ and the projection
  // converges on the straight line, so a knob sweep morphs smoothly
  // through straight.
  // Pause → neutral: scale the bend by the live drone bus gain — the
  // same 0.3 s fade / 0.5 s rise ramp that drives the eyes' shrink and
  // onset (see AudioEngine._applyDroneBusGain) — so the mouth un-bends
  // and returns in lockstep with the eyes instead of on its own clock.
  // Side effect by design: toggling the drone off also relaxes the face.
  const effCurve = curveNeutralOnPause
    ? curve * Math.min(1, audioEngine.getDroneVizGain())
    : curve;
  let arcGeom = null;
  if (Math.abs(effCurve) > 0.004) {
    const theta = Math.min(1, Math.abs(effCurve)) * Math.PI;
    const arcSign = effCurve > 0 ? 1 : -1; // +1 smile (corners up), −1 frown (corners down)
    const arcR = traceWidth / (2 * Math.sin(theta / 2));
    arcGeom = {
      theta,
      sign: arcSign,
      R: arcR,
      cx: traceOffsetX + traceWidth / 2,
      cy: centerY - arcSign * arcR * (Math.sin(theta / 2) / (theta / 2)),
    };
  }
  // Project a normalized position p ∈ [0,1] along the spine plus a signed
  // displacement (px; positive = "up" in straight mode, radially inward /
  // outward on the arc) into canvas coords. Writes into PT — the render
  // loops run per-sample, so no per-point allocation.
  const PT = { x: 0, y: 0 };
  const projectPoint = (p, disp) => {
    if (!arcGeom) {
      PT.x = traceOffsetX + p * traceWidth;
      PT.y = centerY - disp;
      return;
    }
    const phi = (p - 0.5) * arcGeom.theta;
    const rad = arcGeom.R - arcGeom.sign * disp;
    PT.x = arcGeom.cx + rad * Math.sin(phi);
    PT.y = arcGeom.cy + arcGeom.sign * rad * Math.cos(phi);
  };
  // Per-pool viz gain (pool bus only, NOT master) folds into each pool's
  // *contribution amount* below, so spacebar (pauses droneBusGain) fades
  // drone contributions out while leaving keyboard voices visible, and
  // toggling the keyboard bus does the inverse. Master is deliberately
  // excluded so muting the final mixer leaves the scope visible.
  const droneScale = audioEngine.getDroneVizGain();
  const kbdScale = kbdEffectiveGain;
  // 'wave' keeps individuals at ±0.22·h (aggregate up to 1.75× that).
  // 'beating' renders only the aggregate and gets ~1.5× the amplitude so
  // it's the dominant feature of the strip. NB: ampScale is just
  // height — pool gains are multiplied into each per-osc contribution
  // separately so drones and voices can fade independently.
  // heightScale is a per-caller amplitude multiplier (the smiling face's
  // "line height" slider); (1 - pausedFade) collapses the wave to a flat
  // line while paused.
  const ampScale = (mode === 'beating' ? height * 0.33 : height * 0.22)
    * heightScale * (1 - pausedFade);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (arcGeom) {
    // Same spine the samples ride: canvas angle α = sign·(π/2 − φ·sign…)
    // reduces to a centered arc around ±π/2 depending on direction.
    const mid = arcGeom.sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    ctx.arc(arcGeom.cx, arcGeom.cy, arcGeom.R, mid - arcGeom.theta / 2, mid + arcGeom.theta / 2);
  } else {
    ctx.moveTo(traceOffsetX, centerY);
    ctx.lineTo(traceOffsetX + traceWidth, centerY);
  }
  ctx.stroke();

  // Individual per-oscillator lines are thin; the aggregate composite is
  // drawn thicker and white. In 'beating' mode (no individuals) we use a
  // thinner aggregate so the longer 30-period waveform stays legible.
  const indivWidth = 2 * lineScale * lineWidthScale;
  const aggWidth = (mode === 'beating' ? indivWidth * 1.1 : indivWidth * 2);
  const aggOuterWidth = aggWidth + outlineThickness * 2 * lineScale;
  const TWO_PI = Math.PI * 2;

  // Per-pool morphed wave shapes (idealized wavetables, cached; rebuilt
  // only when a shape slider moves). Lookup cost ≈ the Math.sin it
  // replaces.
  const droneWT = getShapeTable(droneWave);
  const kbdWT = getShapeTable(keyboardWave);

  // Per-pool contribution amount = the effective amplitude this source
  // adds to the audio output (= slot volume × pool bus gain × master).
  // volSum / maxVol are computed in this gained space so the aggregate
  // normalization correctly accounts for both pools' loudness.
  const droneContrib = (i) => renderVolumes[i] * droneScale;
  const voiceContrib = (v) => v.amp * kbdScale;

  let volSum = 0;
  let maxVol = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (!isActive(i)) continue;
    const c = droneContrib(i);
    volSum += c;
    if (c > maxVol) maxVol = c;
  }
  for (const v of voices) {
    if (!isVoiceActive(v)) continue;
    const c = voiceContrib(v);
    volSum += c;
    if (c > maxVol) maxVol = c;
  }

  // In 'wave' mode each individual line peaks at ±ampScale (normalized by
  // maxVol so line height is stable across osc count), and the aggregate
  // is clamped to 1.75× that via aggHeightScale.
  // In 'beating' mode there are no individual lines — the aggregate is
  // the whole show — so we normalize it by volSum instead, which
  // guarantees its peak fits ±ampScale regardless of osc count.
  const synthNorm = mode === 'beating'
    ? (volSum > 0 ? 1 / volSum : 1)
    : (maxVol > 0 ? 1 / maxVol : 1);

  // Only cap in wave mode — in beating mode the aggregate's synthNorm
  // already normalizes its peak to ±1.
  const AGG_MAX_RATIO = 1.75;
  const aggHeightScale = mode === 'wave' && volSum > 0
    ? Math.min(1, (AGG_MAX_RATIO * maxVol) / volSum)
    : 1;
  const aggAlpha = Math.min(1, volSum / fadeZone);
  const edgeFade = 0.15;

  const samples = Math.min(1600, Math.max(256, Math.floor(traceWidth)));

  // Anchor to the lowest-freq active source (drone OR voice) so its
  // trace stays visually pinned (zero crossing at window center).
  // Every other source's rendered phase is taken relative to the
  // anchor, so the aggregate's beat envelope evolves in real time
  // and lines up with what you hear.
  //   relPhase = sourcePhase − (sourceFreq / anchorFreq) × anchorPhase
  let anchorFreq = 0;
  let anchorPhase = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (!isActive(i)) continue;
    if (anchorFreq === 0 || freqs[i] < anchorFreq) {
      anchorFreq = freqs[i];
      anchorPhase = phases[i] || 0;
    }
  }
  for (const v of voices) {
    if (!isVoiceActive(v)) continue;
    if (anchorFreq === 0 || v.freq < anchorFreq) {
      anchorFreq = v.freq;
      anchorPhase = v.phase || 0;
    }
  }
  const relPhases = new Array(freqs.length);
  for (let k = 0; k < freqs.length; k++) {
    relPhases[k] = anchorFreq > 0
      ? (phases[k] || 0) - (freqs[k] / anchorFreq) * anchorPhase
      : 0;
  }
  const relVoicePhase = (v) =>
    anchorFreq > 0 ? v.phase - (v.freq / anchorFreq) * anchorPhase : 0;
  // Temporal smoothing on these phases happens upstream in
  // calibratePhases (which caps the LSQ blend alpha so frame-to-frame
  // LSQ noise gets averaged across a few frames). That smoothing
  // benefits the synth XY too, so we don't do a second pass here.

  // ── per-oscillator colored layer (wave mode only) ─────────────────────
  if (mode === 'wave') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Drones first.
    const totalCount = freqs.length;
    for (let k = 0; k < freqs.length; k++) {
      if (!isActive(k)) continue;
      const c = droneContrib(k);
      const f = freqs[k];
      const color = palette.oscColor(k, totalCount);
      ctx.globalAlpha = Math.min(1, renderVolumes[k] / fadeZone) * droneScale;
      ctx.beginPath();
      ctx.lineWidth = indivWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      for (let i = 0; i < samples; i++) {
        const p = i / (samples - 1);
        const t = p * windowSec - windowHalf;
        const amp = c * wtLookupRad(droneWT, TWO_PI * f * t + relPhases[k]) * synthNorm * edgeWindow(p, edgeFade);
        projectPoint(p, amp * ampScale);
        if (i === 0) ctx.moveTo(PT.x, PT.y); else ctx.lineTo(PT.x, PT.y);
      }
      ctx.stroke();
    }
    // Then keyboard voices. Each voice borrows the color of the drone
    // slot at its scale degree, so a kbd note at degree 1 reads as
    // "the same color as the drone playing degree 1." Voices outside
    // the current scale (degree < 0) fall back to white.
    for (const v of voices) {
      if (!isVoiceActive(v)) continue;
      const c = voiceContrib(v);
      // Use the slot the voice is bound to (set at noteOn) rather than
      // resolving via degree — keeps the trace color stable when a
      // mid-press orb drag reorders the scale.
      const color = v.slot >= 0
        ? palette.oscColor(v.slot, totalCount)
        : 'rgba(255, 255, 255, 0.85)';
      ctx.globalAlpha = Math.min(1, v.amp / fadeZone) * kbdScale;
      ctx.beginPath();
      ctx.lineWidth = indivWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      const rp = relVoicePhase(v);
      for (let i = 0; i < samples; i++) {
        const p = i / (samples - 1);
        const t = p * windowSec - windowHalf;
        const amp = c * wtLookupRad(kbdWT, TWO_PI * v.freq * t + rp) * synthNorm * edgeWindow(p, edgeFade);
        projectPoint(p, amp * ampScale);
        if (i === 0) ctx.moveTo(PT.x, PT.y); else ctx.lineTo(PT.x, PT.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── aggregate composite line ───────────────────────────────────────────
  // Two-pass when outlineThickness > 0: a colored outer pass (widened by
  // the outline radius, with a matching-color shadow blur for the neon
  // halo) drawn first, then the white core on top. Mirrors the XY
  // scope's colored-glow-over-white-core look so the static wave reads
  // as part of the same visual language.
  // Pre-compute relative phases for keyboard voices once so the
  // per-sample loop just reads them — same shape as relPhases for
  // drones. Skipped voices are filtered out here, not inside the loop.
  const activeVoices = [];
  for (const v of voices) {
    if (!isVoiceActive(v)) continue;
    activeVoices.push({
      freq: v.freq,
      contrib: voiceContrib(v),
      relPhase: relVoicePhase(v),
    });
  }

  const drawAggPath = () => {
    ctx.beginPath();
    for (let i = 0; i < samples; i++) {
      const p = i / (samples - 1);
      const t = p * windowSec - windowHalf;
      let sum = 0;
      for (let k = 0; k < freqs.length; k++) {
        if (!isActive(k)) continue;
        sum += droneContrib(k) * wtLookupRad(droneWT, TWO_PI * freqs[k] * t + relPhases[k]);
      }
      for (const av of activeVoices) {
        sum += av.contrib * wtLookupRad(kbdWT, TWO_PI * av.freq * t + av.relPhase);
      }
      projectPoint(p, sum * synthNorm * ampScale * aggHeightScale * edgeWindow(p, edgeFade));
      if (i === 0) ctx.moveTo(PT.x, PT.y); else ctx.lineTo(PT.x, PT.y);
    }
    ctx.stroke();
  };

  // aggAlpha already incorporates per-pool gain via volSum (which is
  // in contribution-space) — no extra master multiplier needed here.
  // Floor it with pausedFade so the collapsed flat line stays visible
  // after the paused drone bus has faded volSum (and aggAlpha) to 0.
  ctx.globalAlpha = Math.max(aggAlpha, pausedFade);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (outlineThickness > 0) {
    ctx.lineWidth = aggOuterWidth;
    ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;
    drawAggPath();
  }

  ctx.lineWidth = aggWidth;
  ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
  drawAggPath();

  ctx.globalAlpha = 1;
}

// Produce (L, R) Float32Arrays matching what the analyzer would yield if
// the audio graph were noiseless and phase were perfectly known —
// i.e. synthesized directly from each oscillator's phase accumulator,
// target frequency, volume, routing map and the master clip-scale. Used
// for the side-by-side synthesized XY scope so the comparison against
// the real analyzer output is apples-to-apples (same N, same
// sampleRate, same amplitude scaling).
function synthStereoData(N, sampleRate, sampleOffsetBackward = 0) {
  const freqs = audioEngine.getAllFrequencies();
  const phases = audioEngine.getAllPhases();
  const volumes = audioEngine.volumeValues || [];
  const routingMap = audioEngine.getRoutingMap();
  // Partner oscillator data — second osc per drone, audible on R only
  // in 'stereo' mode. In 'lr' mode `audible` is false and the partner
  // contributes nothing to the synth output.
  const partners = audioEngine.getDronePartnerData
    ? audioEngine.getDronePartnerData()
    : [];
  // Per-pool viz gain (NOT master): drones see droneBusGain (so they fade
  // with spacebar/pause), keyboard sees keyboardBusGain (so they fade with
  // the keyboard volume slider / on-off toggle). Master is excluded so the
  // scope stays visible when the final mixer is muted.
  const droneScale = audioEngine.getDroneVizGain();
  const keyboardScale = audioEngine.getKeyboardVizGain();

  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const INV_TWO_PI = 1 / (Math.PI * 2);

  // Per-pool morphed shapes so the synth scope draws what the pool
  // actually sounds like (idealized wavetable — sharp corners).
  const droneWT = getShapeTable(droneWave);
  const kbdWT = getShapeTable(keyboardWave);

  // Helper to render one running osc into L/R via a normalized-phase
  // accumulator + wavetable lookup (no per-sample trig — same trick as
  // the old sin/cos rotation recurrence, but shape-aware). ampL/ampR
  // are the per-channel amplitudes — the continuous-pan counterpart of
  // the old goesLeft/goesRight booleans.
  const renderOsc = (f, phase, ampL, ampR, wt) => {
    if (ampL <= 0 && ampR <= 0) return;
    const dNorm = f / sampleRate; // < 0.5 for any audible f
    let norm = (phase || 0) * INV_TWO_PI - (N - 1 + sampleOffsetBackward) * dNorm;
    norm -= Math.floor(norm);
    for (let s = 0; s < N; s++) {
      const v = wtLookup(wt, norm);
      if (ampL > 0) L[s] += ampL * v;
      if (ampR > 0) R[s] += ampR * v;
      norm += dNorm;
      if (norm >= 1) norm -= 1;
    }
  };

  const pans = audioEngine.getVoicePans ? audioEngine.getVoicePans() : [];

  for (let k = 0; k < freqs.length; k++) {
    const muted = audioEngine.isMuted(k);
    const amp = (muted ? 0 : (volumes[k] || 0)) * droneScale;
    if (amp <= 0) continue;
    const f = freqs[k];
    if (!(f > 0)) continue;

    const partner = partners[k];
    const stereoMode = partner && partner.audible;
    const channels = routingMap[k] || [];
    const beyondStereo = channels.some((ch) => ch >= 2);

    if (stereoMode) {
      // Each drone is two oscillators in stereo mode. Mirror the tap
      // weights: primary/partner slide per the slot's pan (collapse
      // model) and the partner fades out with panWidth.
      const pan = beyondStereo ? 0 : (pans[k] || 0);
      const w = dronePanWeights(pan, 'stereo');
      renderOsc(f, phases[k], amp * w.primary[0], amp * w.primary[1], droneWT);
      if (partner.freq > 0) {
        const partnerAmp = amp * panWidth(pan);
        renderOsc(partner.freq, partner.phase, partnerAmp * w.partner[0], partnerAmp * w.partner[1], droneWT);
      }
    } else if (beyondStereo || channels.length === 0) {
      // Multichannel patch-bay slots keep the discrete projection onto
      // the two visualized channels; unrouted slots are silent.
      const goesLeft = channels.includes(0);
      const goesRight = channels.includes(1);
      if (!goesLeft && !goesRight) continue;
      renderOsc(f, phases[k], goesLeft ? amp : 0, goesRight ? amp : 0, droneWT);
    } else {
      // lr mode: single osc, continuous balance-law pan.
      const w = dronePanWeights(pans[k] || 0, 'lr');
      renderOsc(f, phases[k], amp * w.primary[0], amp * w.primary[1], droneWT);
    }
  }

  // Keyboard voices — same recurrence, with equal-power L/R split
  // matching StereoPannerNode's behavior so a v.pan = 0 voice splits
  // 0.707/0.707 across L and R (not 0.5/0.5), and full L/R lands at
  // 1/0 and 0/1.
  const voices = keyboardVoiceManager.getVoicesForSynth();
  for (const v of voices) {
    const f = v.freq;
    if (!(f > 0)) continue;
    const amp = v.amp * keyboardScale;
    if (amp <= 0) continue;

    const panAngle = (v.pan + 1) * Math.PI / 4; // [-1,1] → [0, π/2]
    const lAmp = Math.cos(panAngle) * amp;
    const rAmp = Math.sin(panAngle) * amp;
    renderOsc(f, v.phase, lAmp, rAmp, kbdWT);
  }

  return { L, R };
}

// Hilbertscope — plots the analytic signal (x, ĥ) in the complex plane,
// where ĥ is the Hilbert transform (90° phase shift) of x. For a pure
// sine x = amp·sin(θ), the Hilbert partner is −amp·cos(θ), so each
// oscillator traces a perfect circle of radius = its amplitude,
// rotating at its own frequency. For a morphed shape Σ bₙ·sin(nθ) the
// partner is Σ −bₙ·cos(nθ) (the identity is per-harmonic), so each
// oscillator traces its pool's analytic-signal curve instead of a
// circle — collapsing back to the circle at shape = sine. A mix of N
// oscillators composes rotating vectors into epicycle / Fourier-drawing
// figures. Vector magnitude = instantaneous envelope; vector angle =
// instantaneous phase. Output fits the same [-1, 1] envelope as
// synthStereoData (same masterScale-based count clipping), so drawXY's
// mapping works as-is.
function synthHilbertData(bufferSize, sampleRate) {
  const freqs = audioEngine.getAllFrequencies();
  const phases = audioEngine.getAllPhases();
  const volumes = audioEngine.volumeValues || [];
  // Viz gain (bus only, no master) so the polar scope survives a final-mixer mute.
  const droneScale = audioEngine.getDroneVizGain();
  const keyboardScale = audioEngine.getKeyboardVizGain();

  const X = new Float32Array(bufferSize);
  const Y = new Float32Array(bufferSize);
  const INV_TWO_PI = 1 / (Math.PI * 2);

  // Band-limited analytic pair per pool (x = sin-basis, y = its Hilbert
  // partner), from the same Fourier coefficients the audio uses.
  const droneH = getHilbertTables(droneWave);
  const kbdH = getHilbertTables(keyboardWave);

  const renderAnalytic = (f, phase, amp, pair) => {
    const dNorm = f / sampleRate;
    let norm = (phase || 0) * INV_TWO_PI - (bufferSize - 1) * dNorm;
    norm -= Math.floor(norm);
    for (let s = 0; s < bufferSize; s++) {
      X[s] += amp * wtLookup(pair.x, norm);
      Y[s] += amp * wtLookup(pair.y, norm);
      norm += dNorm;
      if (norm >= 1) norm -= 1;
    }
  };

  for (let k = 0; k < freqs.length; k++) {
    const muted = audioEngine.isMuted(k);
    const amp = (muted ? 0 : (volumes[k] || 0)) * droneScale;
    if (amp <= 0) continue;
    const f = freqs[k];
    if (!(f > 0)) continue;
    renderAnalytic(f, phases[k], amp, droneH);
  }

  // Keyboard voices — Hilbert is mono (analytic of the L+R mix), so
  // panning is irrelevant: each voice contributes the full amp regardless
  // of where it lands in the stereo field.
  const voices = keyboardVoiceManager.getVoicesForSynth();
  for (const v of voices) {
    const f = v.freq;
    if (!(f > 0)) continue;
    const amp = v.amp * keyboardScale;
    if (amp <= 0) continue;
    renderAnalytic(f, v.phase, amp, kbdH);
  }

  return { X, Y };
}

// X-Y (Lissajous) scope — draws stereo time-domain data with left channel
// on X and right channel on Y, adaptive sampling + smoothing, colored line
// over glow over white core. Fade-persistent clearing is the caller's
// responsibility (so side-by-side scopes can share a single fade pass
// instead of stacking alpha).
function drawXY(
  ctx,
  scopeSize, scopeOffsetX, scopeOffsetY,
  lineScale, r, g, b, timeData1, timeData2,
  options = {}
) {
  // source='audio' means the input is the analyzer's actual post-FX
  // signal (fold + shape). The complexity-based smoothing below was
  // tuned for synth mode where direction-change count ≈ "many oscs";
  // applied to a folded signal it averages adjacent samples 90% and
  // erases the fold's harmonics. Audio mode uses fixed minimal
  // smoothing so the fold/shape detail survives the render.
  // lineWidthScale / outlineScale: user multipliers from the Hydra
  // panel — 1.0 leaves the figure looking like the original.
  // rotation: 0 = square (L on X, R on Y), +1 = diamond rotated +45°,
  // −1 = diamond rotated −45° (mirror diamond). Both diamond modes
  // scale by 1/√2 so the rotated unit square fits the same scopeSize;
  // the sign flips which direction L=R maps to. Mono content (L=R)
  // draws vertically in either diamond direction, but asymmetric
  // lissajous figures mirror across the vertical axis between the two.
  const {
    source = 'synth',
    lineWidthScale = 1,
    outlineScale = 1,
    rotation = 0,
    ampScale: ampScaleOpt = null,
  } = options;
  const cx = scopeOffsetX + scopeSize / 2;
  const cy = scopeOffsetY + scopeSize / 2;
  // Pre-master audio runs hot; pull the audio figure down to its base size
  // about the scope center. Synth data is already ~unit-normalized. Callers
  // can force a specific scale (e.g. the Hilbert scope matches the audio
  // Lissajous) via options.ampScale.
  const ampScale = ampScaleOpt != null
    ? ampScaleOpt
    : (source === 'audio' ? AUDIO_AMP_SCALE : 1);
  const rotated = rotation === 1 || rotation === -1;
  const rotSign = rotation === -1 ? -1 : 1;
  const dataLen = timeData1.length;
  // Render the entire incoming buffer. The synth helpers now produce
  // exactly the desired length per frame (adaptive on freq via
  // adaptiveBufferSize), so we don't need to re-trim here. Cap at
  // VIZ_BUF_MAX_N as a defensive ceiling for callers that pass in
  // longer buffers.
  const renderStart = Math.max(0, dataLen - VIZ_BUF_MAX_N);

  let sampleStep, smoothingFactor, colorWidth, whiteWidth;
  if (source === 'audio') {
    // Walk every sample, lightly bind successive points just for visual
    // continuity. Line widths fixed at the synth-mode "low complexity"
    // baseline — wider strokes would re-blob the fold detail we're
    // trying to expose.
    sampleStep = 1;
    smoothingFactor = 0.2;
    colorWidth = 18 * lineScale;
    whiteWidth = 4 * lineScale;
  } else {
    // Direction-change count over the head of the rendered window = rough
    // frequency proxy. Drives adaptive sample step, line width, and
    // smoothing so high-frequency content renders cleanly without a hard
    // performance hit.
    let directionChanges = 0;
    let prevDiff = 0;
    const scanEnd = Math.min(dataLen, renderStart + 256);
    for (let i = renderStart + 2; i < scanEnd; i++) {
      const diff = timeData1[i] - timeData1[i - 1];
      if ((diff > 0 && prevDiff < 0) || (diff < 0 && prevDiff > 0)) {
        directionChanges++;
      }
      prevDiff = diff;
    }
    const complexity = Math.min(directionChanges / 50, 1);
    sampleStep = Math.round(1 + complexity * 7);
    colorWidth = (20 + complexity * 10) * lineScale;
    whiteWidth = (5 + complexity * 3) * lineScale;
    smoothingFactor = 0.6 + complexity * 0.3;
  }
  // Apply the user multipliers from the Hydra panel. lineWidthScale
  // affects the white core stroke; outlineScale affects the colored
  // outer/glow stroke. Both default to 1 so the look matches pre-
  // slider rendering.
  whiteWidth *= lineWidthScale;
  colorWidth *= outlineScale;

  const strokePath = (color, lw) => {
    ctx.beginPath();
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    let prevX = null;
    let prevY = null;
    for (let i = renderStart; i < dataLen; i += sampleStep) {
      let x1 = ((timeData1[i] * ampScale + 1) / 2) * scopeSize + scopeOffsetX;
      let y1 = ((timeData2[i] * ampScale + 1) / 2) * scopeSize + scopeOffsetY;
      if (rotated) {
        // Rotate ±45° around (cx, cy) and scale 1/√2 in one matrix:
        //   (dx', dy') = ((dx - s·dy)/2, (s·dx + dy)/2)
        // s = +1 rotates one way, s = −1 the other. Done in screen
        // coords so stroke widths and shadow blur stay isotropic
        // (ctx.rotate + ctx.scale would shrink them by 1/√2 too).
        const dx = x1 - cx;
        const dy = y1 - cy;
        x1 = cx + (dx - rotSign * dy) / 2;
        y1 = cy + (rotSign * dx + dy) / 2;
      }
      if (prevX !== null && prevY !== null) {
        x1 = prevX * smoothingFactor + x1 * (1 - smoothingFactor);
        y1 = prevY * smoothingFactor + y1 * (1 - smoothingFactor);
      }
      if (i === renderStart) ctx.moveTo(x1, y1); else ctx.lineTo(x1, y1);
      prevX = x1;
      prevY = y1;
    }
    ctx.stroke();
  };

  const col = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;
  strokePath(col, colorWidth);
  strokePath('rgba(255, 255, 255, 1)', whiteWidth);
}

// ── Timeline / piano-roll visualizer (vizMode 4) ───────────────────────
// A scrolling-waterfall view of every sounding frequency over time. "Now"
// is pinned to the right edge; history scrolls left and falls off. Reads
// ONLY the note/voice model (drone frequencies + keyboard voices), never
// the analyzer buffer — see research/timeline-visualizer.md.
//
// Persistent history lives module-level (not in React) so the imperative
// rAF loop can accumulate samples across frames. Each "lane" is one
// sounding source (a drone slot or a live voice) and holds a polyline of
// {t, f, amp} samples. Drones draw as long steady bands; played notes as
// short segments that bend with detune / transpose / glides.
const TL_RETAIN_SEC = 180;   // keep this much history so widening the X range reveals it
const TL_COMPACT_AT = 4096;  // slice a lane's dead head off once it grows past this
const TL_BAND_FRAC = 0.7;    // centered middle 70% of the usable HEIGHT (Y band)
const TL_BAND_FRAC_X = 0.6;  // centered middle 60% of the WIDTH (X / time band)
const TL_GAP_SEC = 0.1;      // break the line when samples are further apart than this
                             // (a drone toggled off/on) → dashed instead of bridged
// The timeline's traces are much thinner than the scope's, so the Outline /
// White line sliders barely register here. Amplify their effect 8× so the
// same slider travel gives a meaningful width range on the timeline.
const TL_STROKE_GAIN = 8;

// Auto-range (Y axis auto-fit) tuning. The view eases toward framing whatever
// is currently sounding, with padding above/below and a minimum span so a
// single note doesn't zoom to a razor-thin band. Expansion is fast (catch a
// new extreme quickly); contraction is slow (don't twitch when a note ends).
const TL_AUTO_PAD_OCT = 0.5;        // half-octave breathing room each side
const TL_AUTO_MIN_SPAN_OCT = 2.2;   // never show less than ~2 octaves
const TL_AUTO_EASE_EXPAND = 0.22;
const TL_AUTO_EASE_CONTRACT = 0.035;
const TL_AUTO_LO_FLOOR = 20;        // absolute Hz clamps
const TL_AUTO_HI_CEIL = 20000;

// laneKey → { kind:'drone'|'voice', slot, source, points:[{t,f,amp}], head, active, lastT }
const _timelineLanes = new Map();
// Eased auto-range bounds, in log2(Hz). Null until first computed / reset when
// auto-range is off so re-enabling snaps to the live content.
let _tlAutoEased = null;

function _ensureLane(key, meta) {
  let lane = _timelineLanes.get(key);
  if (!lane) {
    lane = { ...meta, points: [], head: 0, active: true, lastT: 0 };
    _timelineLanes.set(key, lane);
  } else {
    // Refresh mutable metadata (a voice's slot can change on retune).
    lane.slot = meta.slot;
    if (meta.source !== undefined) lane.source = meta.source;
  }
  return lane;
}

// Sample every currently-sounding source once per frame into its lane.
function sampleTimeline(now) {
  // Every lane fed this frame goes in `seen`; anything unfed ends (goes
  // inactive) in the prune pass below.
  const seen = new Set();

  // Drones — continuous bands. Sounding Hz includes global transpose so
  // they line up with voice frequencies on the same axis. Lanes are keyed
  // by slot + step generation: a glide bends one lane's polyline, while a
  // step transition bumps the generation — the old lane simply ENDS and a
  // new one starts at the target pitch, so the step draws as two discrete
  // segments instead of a connecting vertical bridge.
  const freqs = audioEngine.getSoundingFrequencies();
  const vols = audioEngine.volumeValues || [];
  const droneGain = audioEngine.getDroneVizGain();
  for (let i = 0; i < freqs.length; i++) {
    const key = 'd:' + i + ':g' + audioEngine.getSlotGeneration(i);
    const f = freqs[i];
    const audible =
      f > 0 && !audioEngine.isMuted(i) && droneGain > 0.001 && (vols[i] || 0) > 0;
    if (audible) {
      const lane = _ensureLane(key, { kind: 'drone', slot: i });
      lane.points.push({ t: now, f, amp: Math.min(1, (vols[i] || 0) * droneGain) });
      lane.active = true;
      lane.lastT = now;
      seen.add(key);
    }
  }

  // Step tails — the OLD note of an in-flight step transition keeps sounding
  // through its overlap window. Feed it into its own (previous-generation)
  // lane so the crossfade draws as two notes at once: the outgoing pitch
  // holds while the incoming one starts, then the tail lane ends when the
  // window closes. No isMuted check: muting a slot mid-overlap targets the
  // NEW voice's gain — the tail keeps ringing, so keep drawing it.
  if (droneGain > 0.001) {
    const transpose = audioEngine.getTransposeRatio();
    for (const tail of audioEngine.getStepTails()) {
      const key = 'd:' + tail.slot + ':g' + tail.gen;
      const lane = _ensureLane(key, { kind: 'drone', slot: tail.slot });
      lane.points.push({
        t: now,
        f: tail.freq * transpose,
        amp: Math.min(1, (tail.level || 0) * droneGain),
      });
      lane.active = true;
      lane.lastT = now;
      seen.add(key);
    }

    // Travelling voices (voice-led transitions, GENERATIVE.md §6.6) — notes
    // mid-gliss BETWEEN slots. The source slot's lane ended at departure
    // (the slot went silent) and the destination's lane starts at landing;
    // this lane is the audible bridge, bending from the old chord's pitch
    // to the new one's. Keyed by traveller id, so it ends on its own when
    // the voice lands (adopted by the destination slot) or releases (merge).
    for (const tv of audioEngine.getTravelers()) {
      if (!(tv.hz > 0)) continue;
      const key = 'tv:' + tv.id;
      const lane = _ensureLane(key, { kind: 'drone', slot: tv.fromIndex });
      lane.points.push({
        t: now,
        f: tv.hz * transpose,
        amp: Math.min(1, (tv.level || 0) * droneGain),
      });
      lane.active = true;
      lane.lastT = now;
      seen.add(key);
    }
  }

  // Keyboard + MIDI voices — discrete note segments. Voice amp is the raw
  // per-voice gain; fold in the keyboard bus viz gain so a muted bus hides
  // notes (matching the other scope modes).
  const kbdGain = audioEngine.getKeyboardVizGain();
  const voices = keyboardVoiceManager.getActiveVoices();
  for (const v of voices) {
    if (!(v.freq > 0)) continue;
    const amp = (v.amp || 0) * kbdGain;
    if (amp <= 0.0005) continue; // released and faded out — stop extending
    const key = 'v:' + v.id;
    seen.add(key);
    const lane = _ensureLane(key, { kind: 'voice', slot: v.slot, source: v.source });
    lane.points.push({ t: now, f: v.freq, amp: Math.min(1, amp) });
    lane.active = true;
    lane.lastT = now;
  }

  // Prune old points; drop dead lanes. Any lane not fed this frame has
  // ended — a released voice, a muted/silenced drone, a superseded step
  // generation, or an expired step tail.
  const cutoff = now - TL_RETAIN_SEC;
  for (const [key, lane] of _timelineLanes) {
    if (!seen.has(key)) lane.active = false;
    const pts = lane.points;
    while (lane.head < pts.length && pts[lane.head].t < cutoff) lane.head++;
    if (lane.head > TL_COMPACT_AT) {
      lane.points = pts.slice(lane.head);
      lane.head = 0;
    }
    if (lane.head >= lane.points.length && !lane.active) {
      _timelineLanes.delete(key);
    }
  }
}

// Target Y-range (in log2 Hz) that frames every currently-sounding lane, with
// padding and a minimum span. Returns null when nothing is visible so the
// caller can hold the last eased range instead of collapsing.
//
// Crucially this frames every frequency still VISIBLE in the X window — not
// just what's sounding right now — including notes that have ended but haven't
// scrolled off yet. So the range only starts to contract once an extreme
// actually leaves the left edge, i.e. it lags shrinking by ~windowSec and
// stays big meanwhile (no jumping when a note stops).
function _timelineAutoTarget(now, win) {
  let lo = Infinity;
  let hi = 0;
  const cutoff = now - win;
  for (const lane of _timelineLanes.values()) {
    const pts = lane.points;
    for (let i = lane.head; i < pts.length; i++) {
      const p = pts[i];
      if (p.t < cutoff) continue; // scrolled off the left — no longer framed
      if (p.f > 0) {
        if (p.f < lo) lo = p.f;
        if (p.f > hi) hi = p.f;
      }
    }
  }
  if (hi <= 0) return null;
  let loLog = Math.log2(lo) - TL_AUTO_PAD_OCT;
  let hiLog = Math.log2(hi) + TL_AUTO_PAD_OCT;
  const span = hiLog - loLog;
  if (span < TL_AUTO_MIN_SPAN_OCT) {
    const c = (loLog + hiLog) / 2;
    loLog = c - TL_AUTO_MIN_SPAN_OCT / 2;
    hiLog = c + TL_AUTO_MIN_SPAN_OCT / 2;
  }
  loLog = Math.max(Math.log2(TL_AUTO_LO_FLOOR), loLog);
  hiLog = Math.min(Math.log2(TL_AUTO_HI_CEIL), hiLog);
  return { loLog, hiLog };
}

// Draw the timeline into [0,0,width,height] (height = usable area above the
// orbs). `now` is audioContext.currentTime. windowSec = X-range. When
// autoRange is on the Y-range eases to frame the sounding content; otherwise
// fMin / fMax (the manual sliders) set it.
// Left-edge fade gradient cache for drawTimeline — rebuilt only when the
// geometry it depends on changes (see the fade block below).
const _tlGradCache = { grad: null, width: 0, xLeft: 0, fadeW: 0 };

function drawTimeline(
  ctx, width, height, now, windowSec, fMin, fMax, autoRange, lineScale,
  r, g, b, outlineScale = 1, lineWidthScale = 1
) {
  const win = Math.max(0.1, windowSec);
  let lo, hi;
  if (autoRange) {
    const target = _timelineAutoTarget(now, win);
    if (target) {
      if (!_tlAutoEased) {
        _tlAutoEased = { lo: target.loLog, hi: target.hiLog };
      } else {
        // Expand fast toward a new extreme, contract slowly when one leaves.
        const eLo = target.loLog < _tlAutoEased.lo ? TL_AUTO_EASE_EXPAND : TL_AUTO_EASE_CONTRACT;
        const eHi = target.hiLog > _tlAutoEased.hi ? TL_AUTO_EASE_EXPAND : TL_AUTO_EASE_CONTRACT;
        _tlAutoEased.lo += (target.loLog - _tlAutoEased.lo) * eLo;
        _tlAutoEased.hi += (target.hiLog - _tlAutoEased.hi) * eHi;
      }
    } else if (!_tlAutoEased) {
      // Nothing sounding yet — seed from the manual range so the first notes
      // ease in from a sane starting frame.
      _tlAutoEased = {
        lo: Math.log2(Math.max(1, Math.min(fMin, fMax))),
        hi: Math.log2(Math.max(fMin, fMax)),
      };
    }
    lo = Math.pow(2, _tlAutoEased.lo);
    hi = Math.max(lo * 1.02, Math.pow(2, _tlAutoEased.hi));
  } else {
    // Manual: reset the eased state so re-enabling auto snaps to live content.
    _tlAutoEased = null;
    lo = Math.max(1, Math.min(fMin, fMax));
    hi = Math.max(lo * 1.02, Math.max(fMin, fMax));
  }
  const logLo = Math.log2(lo);
  const logSpan = Math.log2(hi) - logLo || 1;
  // Draw into a centered band so the traces sit in the middle of the screen
  // rather than filling edge to edge: 70% of the height (Y = log-frequency),
  // 60% of the width (X = time, "now" at the band's right edge xRight,
  // history running left to xLeft).
  const bandH = height * TL_BAND_FRAC;
  const bandTop = (height - bandH) / 2;
  const bandW = width * TL_BAND_FRAC_X;
  const xLeft = (width - bandW) / 2;
  const xRight = xLeft + bandW;
  const yOf = (f) => bandTop + bandH * (1 - (Math.log2(f) - logLo) / logSpan);
  const xOf = (t) => xRight - ((now - t) / win) * bandW;

  // Opaque background — the timeline has no persistence fade.
  ctx.fillStyle = 'rgba(0, 0, 0, 1)';
  ctx.fillRect(0, 0, width, height);

  // Clip to the band so notes below fMin / above fMax don't bleed out.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, bandTop, width, bandH);
  ctx.clip();

  // Every trace shares the global 20-minute cycling color (same r/g/b the XY
  // scope uses) rather than per-orb slot colors.
  const cycColor = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Precompute per-lane render params once. Widths scale by amplitude then by
  // the same Visualizer-panel sliders the scope uses: `outlineScale` (Outline)
  // for the colored halo, `lineWidthScale` (White line) for the white core.
  const draws = [];
  for (const lane of _timelineLanes.values()) {
    const pts = lane.points;
    if (lane.head >= pts.length) continue;
    const a = pts[pts.length - 1].amp; // latest amp → width + alpha
    const baseW = 3.6 * lineScale * (0.5 + a * 0.8);
    draws.push({
      lane,
      colorW: baseW * outlineScale * TL_STROKE_GAIN,
      whiteW: Math.max(0.5, baseW * 0.3 * lineWidthScale * TL_STROKE_GAIN),
      alpha: Math.min(1, 0.45 + a * 0.55),
    });
  }

  // Trace one lane's visible polyline. Break the path across time gaps
  // (> TL_GAP_SEC) so a drone toggled off/on draws as separate dashes instead
  // of a straight bridge across the silent stretch.
  const traceLane = (lane) => {
    const pts = lane.points;
    ctx.beginPath();
    let penDown = false;
    let prevT = 0;
    for (let i = lane.head; i < pts.length; i++) {
      const p = pts[i];
      const x = xOf(p.t);
      if (x < -4) { prevT = p.t; continue; } // older than the visible window
      const y = yOf(p.f);
      if (!penDown || p.t - prevT > TL_GAP_SEC) {
        ctx.moveTo(x, y);
        penDown = true;
      } else {
        ctx.lineTo(x, y);
      }
      prevT = p.t;
    }
    ctx.stroke();
  };

  // Two global passes so the white cores land on top of EVERY colored halo —
  // intersecting notes then show clean white crossings instead of one note's
  // halo covering another's core. Pass 1: all colored outlines (skipped when
  // Outline is 0). Pass 2: all white cores.
  ctx.strokeStyle = cycColor;
  for (const d of draws) {
    if (d.colorW <= 0.1) continue;
    ctx.globalAlpha = d.alpha;
    ctx.lineWidth = d.colorW;
    traceLane(d.lane);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
  for (const d of draws) {
    ctx.globalAlpha = d.alpha;
    ctx.lineWidth = d.whiteW;
    traceLane(d.lane);
  }

  ctx.globalAlpha = 1;

  // Soft LEFT edge fade only — old history dissolves into the background as
  // it scrolls off the left, but the RIGHT edge (where "now" is, so where new
  // notes onset) stays crisp so onsets read sharply. Opaque black over the
  // left margin, fading to clear over the inner `fadeW`, then clear all the
  // way to the right.
  const fadeW = bandW * 0.16;
  // Cached: the gradient only depends on width/xLeft/fadeW, which change
  // on resize, not per frame — and this runs every frame (creating a
  // fresh gradient object per frame is measurable GC + Skia churn, and
  // the timeline is also the 'off'-tier fallback mode).
  const gc = _tlGradCache;
  if (!gc.grad || gc.width !== width || gc.xLeft !== xLeft || gc.fadeW !== fadeW) {
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(Math.max(0, xLeft / width), 'rgba(0, 0, 0, 1)');
    grad.addColorStop(Math.min(1, (xLeft + fadeW) / width), 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    gc.grad = grad;
    gc.width = width;
    gc.xLeft = xLeft;
    gc.fadeW = fadeW;
  }
  ctx.fillStyle = gc.grad;
  ctx.fillRect(0, bandTop, width, bandH);

  ctx.restore();
}

/**
 * Oscilloscope component - Canvas-based visualization
 * Uses refs and imperative animation loop to avoid React re-render overhead
 */
export default function Oscilloscope({
  staticMode = 'beating',
  staticPeriods = 10,
  staticLineWidth = 1.0,
  staticOutlineThickness = 0,
  // Overall face scale: multiplies the base size both face modes (2 and
  // 5) derive their whole layout from, so eyes, gaps and mouth scale
  // together. 1 = original.
  faceScale = 1,
  // Smiling-face (vizMode 2) geometry. Eye size / gap / mouth-gap are
  // multipliers on the original hardcoded proportions; mouth line width
  // and period count are absolute; standing height scales the mouth
  // wave's amplitude. Defaults reproduce the original face.
  faceEyeSize = 1,
  faceEyeGap = 1,
  faceMouthWidth = 1,
  faceMouthLineWidth = 2,
  faceStandingHeight = 1,
  faceStandingPeriods = 20,
  faceMouthGap = 1,
  // Mouth curvature: −1 (semicircle frown) … 0 (straight) … +1
  // (semicircle smile). faceMouthCurveWidth is the mouth-width
  // multiplier at full bend — the effective width lerps from
  // faceMouthWidth to it as |curve| goes 0 → 1.
  faceMouthCurve = 0,
  faceMouthCurveWidth = 1,
  // When true, the smile/frown relaxes to the neutral straight line
  // while the transport is paused and returns on play.
  faceMouthPauseNeutral = true,
  vizMode = 0,
  vizCycles = 13,
  // Timeline (vizMode 4) controls. windowSec = X-range (seconds of history
  // visible); freqMin/freqMax = Y-range (log-frequency window in Hz).
  timelineWindowSec = 12,
  timelineFreqMin = 55,
  timelineFreqMax = 4186,
  // When true, the Y-range auto-fits to the sounding frequencies (the
  // freqMin/freqMax sliders are ignored).
  timelineAutoRange = true,
  // Lissajous-specific multipliers (vizMode 0). Sliders in the Hydra
  // panel drive these; defaults of 1 preserve the look from before
  // those sliders existed.
  vizScale = 1,
  vizLineWidth = 1,
  vizOutline = 1,
  // Lissajous rotation: 0 = square (axis-aligned L/R), +1 = diamond
  // (+45°), −1 = mirror diamond (−45°). Diamond modes scale by 1/√2
  // so the figure stays within the original scope bounds.
  vizRotation = 0,
  // Render quality tier: 'pretty' (full), 'performance' (skip work the
  // active mode doesn't consume + half-rate features), 'off' (blank the
  // scope, skip the loop). See drawScope for what each tier gates.
  vizQuality = 'pretty',
  // Replay the master saturator's curve over the audio-source scope
  // window (the analysers tap pre-master, so the audible saturation is
  // otherwise invisible here). See saturateInto.
  scopeSaturation = false,
  // True when something actually reads window.audio this frame (a
  // features-consuming visual backend running — hydra sketch uniforms).
  // The per-frame audio-feature FFT is skipped entirely when false.
  featuresActive = true,
  // Drag-on-scope → Feedback sliders. App owns the slider state and
  // passes this callback; the pointer handlers below compute the slider
  // values from the drag position so the gesture and the sliders stay
  // visibly synced.
  onVfxDrag,
}) {
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const calibrateTickRef = useRef(0);
  const dimensionsRef = useRef({ width: 0, height: 0, scaleX: 1, scaleY: 1 });

  const staticModeRef = useRef(staticMode);
  useEffect(() => {
    staticModeRef.current = staticMode;
  }, [staticMode]);
  const staticPeriodsRef = useRef(staticPeriods);
  useEffect(() => {
    staticPeriodsRef.current = staticPeriods;
  }, [staticPeriods]);
  const staticLineWidthRef = useRef(staticLineWidth);
  useEffect(() => {
    staticLineWidthRef.current = staticLineWidth;
  }, [staticLineWidth]);
  const staticOutlineRef = useRef(staticOutlineThickness);
  useEffect(() => {
    staticOutlineRef.current = staticOutlineThickness;
  }, [staticOutlineThickness]);
  const faceScaleRef = useRef(faceScale);
  useEffect(() => { faceScaleRef.current = faceScale; }, [faceScale]);
  const faceEyeSizeRef = useRef(faceEyeSize);
  useEffect(() => { faceEyeSizeRef.current = faceEyeSize; }, [faceEyeSize]);
  const faceEyeGapRef = useRef(faceEyeGap);
  useEffect(() => { faceEyeGapRef.current = faceEyeGap; }, [faceEyeGap]);
  const faceMouthWidthRef = useRef(faceMouthWidth);
  useEffect(() => { faceMouthWidthRef.current = faceMouthWidth; }, [faceMouthWidth]);
  const faceMouthLineWidthRef = useRef(faceMouthLineWidth);
  useEffect(() => { faceMouthLineWidthRef.current = faceMouthLineWidth; }, [faceMouthLineWidth]);
  const faceStandingHeightRef = useRef(faceStandingHeight);
  useEffect(() => { faceStandingHeightRef.current = faceStandingHeight; }, [faceStandingHeight]);
  const faceStandingPeriodsRef = useRef(faceStandingPeriods);
  useEffect(() => { faceStandingPeriodsRef.current = faceStandingPeriods; }, [faceStandingPeriods]);
  const faceMouthGapRef = useRef(faceMouthGap);
  useEffect(() => { faceMouthGapRef.current = faceMouthGap; }, [faceMouthGap]);
  const faceMouthCurveRef = useRef(faceMouthCurve);
  useEffect(() => { faceMouthCurveRef.current = faceMouthCurve; }, [faceMouthCurve]);
  const faceMouthCurveWidthRef = useRef(faceMouthCurveWidth);
  useEffect(() => { faceMouthCurveWidthRef.current = faceMouthCurveWidth; }, [faceMouthCurveWidth]);
  const faceMouthPauseNeutralRef = useRef(faceMouthPauseNeutral);
  useEffect(() => { faceMouthPauseNeutralRef.current = faceMouthPauseNeutral; }, [faceMouthPauseNeutral]);
  const vizScaleRef = useRef(vizScale);
  useEffect(() => { vizScaleRef.current = vizScale; }, [vizScale]);
  const vizLineWidthRef = useRef(vizLineWidth);
  useEffect(() => { vizLineWidthRef.current = vizLineWidth; }, [vizLineWidth]);
  const vizOutlineRef = useRef(vizOutline);
  useEffect(() => { vizOutlineRef.current = vizOutline; }, [vizOutline]);
  const vizRotationRef = useRef(vizRotation);
  useEffect(() => { vizRotationRef.current = vizRotation; }, [vizRotation]);
  const vizQualityRef = useRef(vizQuality);
  useEffect(() => { vizQualityRef.current = vizQuality; }, [vizQuality]);
  const scopeSaturationRef = useRef(scopeSaturation);
  useEffect(() => { scopeSaturationRef.current = scopeSaturation; }, [scopeSaturation]);
  const featuresActiveRef = useRef(featuresActive);
  useEffect(() => { featuresActiveRef.current = featuresActive; }, [featuresActive]);
  // Tracks whether the scope has already been blanked once for the 'off'
  // tier, so we clear a single frame and then idle instead of clearing
  // every frame.
  const offClearedRef = useRef(false);
  // Half-rate tick for the performance-mode audio-feature update.
  const featuresTickRef = useRef(0);

  // Visualizer mode (controlled by parent via prop):
  //   0 — single centered synthesized XY scope (circle)
  //   1 — tall standing-wave (1D static line)
  //   2 — face: two synth XY "eyes" + 1D "mouth" beneath
  //   3 — Hilbertscope: plots (signal, Hilbert-transform) per sample —
  //       each osc traces a circle, composite is a Fourier epicycle.
  //   4 — Timeline / piano-roll.
  //   5 — inverse face: two standing-wave "eyes" (1/3 cycles) + XY
  //       "mouth" beneath (the mirror of mode 2).
  const vizModeRef = useRef(vizMode);
  useEffect(() => {
    vizModeRef.current = vizMode;
  }, [vizMode]);
  // User-controlled "trace cycles" — the synth buffer length per frame
  // tracks this × sampleRate / lowest-active-freq, clamped. Higher =
  // more history (richer drift at low freqs), lower = crisper figures
  // at high freqs. See research/oscilloscope-frequency-adaptive.md §5.
  const vizCyclesRef = useRef(vizCycles);
  useEffect(() => {
    vizCyclesRef.current = vizCycles;
  }, [vizCycles]);
  const timelineWindowRef = useRef(timelineWindowSec);
  useEffect(() => { timelineWindowRef.current = timelineWindowSec; }, [timelineWindowSec]);
  const timelineFreqMinRef = useRef(timelineFreqMin);
  useEffect(() => { timelineFreqMinRef.current = timelineFreqMin; }, [timelineFreqMin]);
  const timelineFreqMaxRef = useRef(timelineFreqMax);
  useEffect(() => { timelineFreqMaxRef.current = timelineFreqMax; }, [timelineFreqMax]);
  const timelineAutoRangeRef = useRef(timelineAutoRange);
  useEffect(() => { timelineAutoRangeRef.current = timelineAutoRange; }, [timelineAutoRange]);

  // Per-oscillator rendered amplitude, tweened toward the real (muted-or-not)
  // volume each frame so mute/unmute fades the static trace instead of
  // snapping it.
  const renderVolumesRef = useRef([]);
  // Smoothed fundamental + periods, tweened toward targets so zoom and
  // mute transitions glide rather than snap.
  const smoothedWindowRef = useRef({ fundamental: 0, periods: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Mixer-console + knob-band heights (--console-h / --knob-band-h on
    // #wrapper). Read on resize — they only change via media query —
    // and cached so the draw loop never forces a style recalc.
    let consoleH = 210;
    let knobBandH = 72;
    const readConsoleH = () => {
      const wrapper = document.getElementById('wrapper');
      if (!wrapper) return;
      const style = getComputedStyle(wrapper);
      const v = parseFloat(style.getPropertyValue('--console-h'));
      if (Number.isFinite(v) && v > 0) consoleH = v;
      const b = parseFloat(style.getPropertyValue('--knob-band-h'));
      if (Number.isFinite(b) && b >= 0) knobBandH = b;
    };
    readConsoleH();

    // Resize handler. Sizes the backing store at devicePixelRatio so the
    // render stays crisp on HiDPI / Retina displays, while keeping the CSS
    // size and all drawing coordinates in CSS pixels via setTransform.
    // DPR is capped at 2 — matching the iOS scope's "medium" render scale,
    // which reads as sharp on 3× phones for roughly half the pixel work.
    // At DPR 3 the full-viewport backing store is ~3 Mpx and every trail
    // fill is a read-modify-write over all of it; the cap cuts fill and
    // stroke rasterization cost by ~56% with no visible quality loss.
    const resizeCanvas = () => {
      readConsoleH();
      const cssWidth = window.innerWidth;
      const cssHeight = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = cssHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dimensionsRef.current = {
        width: cssWidth,
        height: cssHeight,
        scaleX: cssWidth / 1024,
        scaleY: cssHeight / 1024
      };
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Pre-calculate constants for color cycling
    const TWO_PI = 2 * Math.PI;
    const PHASE_OFFSET = TWO_PI / 3;
    const CYCLE_TIME = 20 * 60 * 1000;

    // #wrapper is the app root and stable for the page's lifetime; cache
    // it so the draw loop doesn't run a DOM query per frame (re-fetched
    // if it's ever remounted).
    let wrapperEl = document.getElementById('wrapper');
    
    // Animation loop - runs independently of React
    // Matches original: iterates all points, no sampling
    //
    // Frame-rate cap: 60 fps, matching the iOS scope's default
    // scopeMaxFPS. On ProMotion displays rAF fires at 120 Hz, which
    // doubles every per-frame cost (analyser reads, FFT feature walk,
    // full-viewport fills) for no perceptible gain — a major phone-heat
    // contributor. The 1.5 ms tolerance keeps genuine 60 Hz displays
    // from dropping frames to timer jitter.
    const FRAME_MIN_MS = 1000 / 60 - 1.5;
    let lastFrameTs = 0;
    const drawScope = (ts) => {
      animationFrameRef.current = requestAnimationFrame(drawScope);

      const now = typeof ts === 'number' ? ts : performance.now();
      if (now - lastFrameTs < FRAME_MIN_MS) return;
      lastFrameTs = now;

      if (!audioEngine.initialized) return;

      const quality = vizQualityRef.current;
      offClearedRef.current = false;

      // 'off' is no longer a blank tier — it falls back to the lightweight
      // timeline (vizMode 4) so there's always something showing. Both
      // 'off' and 'performance' take the cheaper per-frame path.
      const perf = quality !== 'pretty';
      const vizMode = quality === 'off' ? 4 : vizModeRef.current;
      const isTimeline = vizMode === 4;

      // Advance per-oscillator phase accumulators once per frame so the
      // static waveform draws the actual audio phase (and therefore the
      // real beat pattern), not an idealized all-phases-aligned snapshot.
      // Same advance for keyboard voices so their contributions in the
      // synth XY / Hilbert paths render in the right phase relationship
      // with the drone. Then rebase the accumulator from what the analyzer
      // actually sees, eliminating drift from Web Audio start-phase
      // uncertainty and freq-smoothing approximation (run at half rate —
      // the 20%-per-frame blend cap already spreads corrections over ~5
      // frames, so doubling the gap to ~33 ms is invisible while halving
      // the LSQ cost).
      //
      // Only the phase-synthesizing modes consume any of this: the
      // standing wave (1), the face mouth (2), and the Hilbert scope (3).
      // The plain Lissajous (0) reads the analyzer directly and ignores
      // phase entirely, so performance mode skips all of it there. Pretty
      // mode keeps the original always-on behavior so the look can't shift.
      // The timeline (4) reads frequencies only, never phase, so it skips
      // all of this regardless of tier.
      if (!isTimeline && (!perf || vizMode !== 0)) {
        audioEngine.updatePhases();
        keyboardVoiceManager.updatePhases();
        calibrateTickRef.current = (calibrateTickRef.current + 1) & 1;
        if (calibrateTickRef.current === 0) audioEngine.calibratePhases();
      }

      // Tier-3 audio features (dissonance, consonance, beating, centroid,
      // flux, …) for the dissonance meter under the spectrum and for Hydra
      // sketches referencing `audio.dissonance` etc. via callback uniforms.
      // The scan is a full FFT walk (3 × 4096-bin passes plus a pairwise
      // dissonance sweep), so it only runs when something actually reads
      // the result — featuresActive is false whenever the settings panel
      // is closed and the active visual backend doesn't consume features
      // (the shader backend never does). In performance mode it
      // additionally runs at half rate — the meter and sketches tween
      // fine off ~30 Hz.
      let runFeatures = featuresActiveRef.current;
      if (perf && runFeatures) {
        featuresTickRef.current = (featuresTickRef.current + 1) & 1;
        runFeatures = featuresTickRef.current === 0;
      }
      if (runFeatures) updateAudioFeatures(audioEngine);

      const { width, height, scaleX, scaleY } = dimensionsRef.current;

      // Calculate color based on 20-minute cycle.
      const position = (Date.now() % CYCLE_TIME) / CYCLE_TIME;
      const angle = position * TWO_PI;
      const r = Math.sin(angle) * 127 + 128;
      const g = Math.sin(angle + PHASE_OFFSET) * 127 + 128;
      const b = Math.sin(angle + PHASE_OFFSET * 2) * 127 + 128;
      const lineScale = Math.min(scaleX, scaleY);

      // Bottom-reserved strip = ~top-of-orbs. Derived from the mixer
      // console's height (--console-h, cached in resizeCanvas) so the
      // CSS layout and this opaque band can't drift apart: 20px of
      // bottom chrome under the console (panel inset + gaps — the
      // play/save row is gone, transport lives beside the console now)
      // + the console itself + 18px of overlap into the spectrum-bar
      // row (same relationship the old fixed 135px had).
      const BOTTOM_RESERVED = 38 + consoleH + knobBandH;
      // Keyboard tray, when open, occludes another --kbd-tray-h (120 px)
      // below that. Read from the #wrapper class so we don't have to
      // thread a prop through every Oscilloscope ancestor. Subtract
      // both from usableHeight so the trace (drawStatic) and the
      // Lissajous scope (drawXY) center in the visible region rather
      // than the geometric viewport center.
      if (!wrapperEl || !wrapperEl.isConnected) wrapperEl = document.getElementById('wrapper');
      const kbdTrayH = wrapperEl && wrapperEl.classList.contains('kbd-tray-open') ? 120 : 0;
      const usableHeight = Math.max(0, height - BOTTOM_RESERVED - kbdTrayH);
      const staticStyle = staticModeRef.current;
      const sampleRate = audioEngine.audioContext
        ? audioEngine.audioContext.sampleRate
        : 44100;

      // Opaque clear of the reserved bottom strip every frame so the
      // orbs / controls always have a clean backdrop regardless of
      // what mode the visualizer is in.
      ctx.fillStyle = 'rgba(0, 0, 0, 1)';
      ctx.fillRect(0, usableHeight, width, height - usableHeight);

      // Adaptive synth-buffer length — driven by the highest active
      // freq + the user's "cycles" slider. Computed once per frame so
      // every mode that consumes synth buffers gets the same N this
      // tick. See research/oscilloscope-frequency-adaptive.md.
      const synthN = adaptiveBufferSize(
        highestActiveFreq(),
        sampleRate,
        vizCyclesRef.current
      );

      // Per-mode source policy:
      //   0 (Circle), 2 (Face)  → 'audio'  (analyzer's actual signal,
      //                            so wavefolding + setPeriodicWave
      //                            shapes show through visibly)
      //   3 (Hilbert)           → 'synth'  (per-osc analytic curves —
      //                            circles at shape=sine, the pool's
      //                            band-limited analytic figure once
      //                            morphed; the FIR audio path is
      //                            technically valid but visually
      //                            less informative)
      //   1 (Standing line)     → synth, baked into drawStatic
      //
      // Pulls a stereo (L, R) pair appropriate for the source.
      // 'audio' returns subarray views of the analyzer's time-domain
      // buffer (post-master, post-fold, post-shape — the actual sound).
      // 'synth' returns freshly-synthesized arrays from osc phase in
      // each pool's morphed wave shape (idealized, pre-fold). Both are
      // length-bounded by synthN so the viz density stays consistent
      // across sources.
      const getXY = (source) => {
        if (source === 'audio') {
          // Read the analyzer directly. In 'stereo' mode (drone or
          // keyboard) the same signal goes to both channels, so the
          // lissajous collapses to a diagonal — that's an accurate
          // reading of what's playing. Detune still shows up as
          // beating in either L or R individually.
          const L = audioEngine.getTimeDataLeft();
          const R = audioEngine.getTimeDataRight();
          if (!L || !R) return { L: new Float32Array(0), R: new Float32Array(0) };
          // Phase-lock the window to a rising zero-crossing on L so the
          // figure holds still instead of flickering. Same start index for
          // both channels so the X/Y correspondence is preserved.
          const start = triggeredStart(L, synthN, lowestActiveFreq(), sampleRate);
          const Lw = L.subarray(start, start + synthN);
          const Rw = R.subarray(start, start + synthN);
          // Optionally replay the master saturator over the window (into
          // scratch — the subarrays are views into the engine's analyser
          // buffers, which other readers consume this frame).
          const satCurve = scopeSaturationRef.current
            ? audioEngine.getSaturationCurve()
            : 0;
          if (satCurve) {
            const drive = audioEngine.getSaturationDrive();
            const scratch = ensureSatScratch(Lw.length);
            saturateInto(scratch.L, Lw, satCurve, drive);
            saturateInto(scratch.R, Rw, satCurve, drive);
            return { L: scratch.L, R: scratch.R };
          }
          return { L: Lw, R: Rw };
        }
        return synthStereoData(synthN, sampleRate);
      };

      // Hilbert path is synth-only by policy. The audio variant
      // (FIR-transformed mono) is left available below in case we
      // expose it again later, but the call site picks 'synth'.
      const getHilbertXY = (source) => {
        if (source === 'audio') {
          const L = audioEngine.getTimeDataLeft();
          const R = audioEngine.getTimeDataRight();
          if (!L || !R) return { X: new Float32Array(0), Y: new Float32Array(0) };
          const N = L.length;
          const { mono, imag } = ensureHilbertScratch(N);
          for (let i = 0; i < N; i++) mono[i] = (L[i] + R[i]) * 0.5;
          hilbertTransform(mono, imag);
          const start = Math.max(0, N - synthN);
          return { X: mono.subarray(start), Y: imag.subarray(start) };
        }
        return synthHilbertData(synthN, sampleRate);
      };

      if (vizMode === 0) {
        // ── MODE 0: single centered XY scope ──────────────────────────
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, usableHeight);
        // vizScale is the user's overall-zoom multiplier on the figure.
        // 1 = legacy 95%-fit; 0.5 = half size; 1.5 = pushes to fill.
        const scopeSize = Math.max(0, Math.min(width, usableHeight) * 0.95 * vizScaleRef.current);
        const scopeX = (width - scopeSize) / 2;
        const scopeY = (usableHeight - scopeSize) / 2;
        const { L, R } = getXY('audio');
        drawXY(ctx, scopeSize, scopeX, scopeY, lineScale, r, g, b, L, R, {
          source: 'audio',
          lineWidthScale: vizLineWidthRef.current,
          outlineScale: vizOutlineRef.current,
          rotation: vizRotationRef.current,
        });

      } else if (vizMode === 1) {
        // ── MODE 1: tall standing wave filling the scope region ──────
        // Colored aggregate + narrower stroke so it reads as part of
        // the scope's visual language rather than a separate readout.
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.fillRect(0, 0, width, usableHeight);
        if (staticStyle !== 'off') {
          drawStatic(
            ctx, width, usableHeight, lineScale, r, g, b,
            renderVolumesRef.current, smoothedWindowRef.current,
            staticStyle, staticPeriodsRef.current,
            {
              lineWidthScale: staticLineWidthRef.current,
              outlineThickness: staticOutlineRef.current,
            }
          );
        }

      } else if (vizMode === 2) {
        // ── MODE 2: face (two eyes + mouth) ───────────────────────────
        // Layout goals:
        // 1. Eye span never narrower than the mouth — on a narrow
        //    viewport we don't want a wide mouth hanging off the face.
        //    Enforced by passing the eye-span width to drawStatic (so
        //    its internal traceWidth math is bounded by that) and
        //    translating the mouth horizontally to sit under the eyes.
        // 2. The whole face (eyes + gap + mouth) is vertically centered
        //    in the usable area, so empty space ends up equally above
        //    and below instead of stacking all at the bottom.
        // 3. Gaps and mouth proportions scale off baseEyeSize (the eye
        //    size at slider = 100%), so they stay consistent across screen
        //    sizes AND are unaffected by the Eye size slider — that slider
        //    scales the drawn eyes only, never the mouth.
        // The face* refs are user sliders: eye size / gap / mouth-gap are
        // multipliers on these base proportions (default 1 = original).
        // faceScale multiplies the base size the whole layout derives
        // from, so eyes, gaps and mouth all scale together. The clamps
        // below still bound the drawn eyes/mouth to the viewport.
        const baseEyeSize = Math.min(width * 0.35, usableHeight * 0.42)
          * faceScaleRef.current;
        // The full layout (eye centers, mouth, vertical centering) is
        // computed from baseEyeSize only — the Eye size slider scales
        // just the drawn eyes, in place about their fixed centers, so
        // nothing else on the face moves when it changes.
        const eyeGap = baseEyeSize * 0.1 * faceEyeGapRef.current;
        const totalEyesWidth = baseEyeSize * 2 + eyeGap;
        const eyesOffsetX = (width - totalEyesWidth) / 2;
        const leftEyeCenterX = eyesOffsetX + baseEyeSize / 2;
        const rightEyeCenterX = eyesOffsetX + baseEyeSize * 1.5 + eyeGap;

        // Mouth geometry is pinned to two unscaled eye-widths — the eye
        // gap is deliberately excluded so the Eye gap slider never
        // resizes the mouth — scaled by its own slider (default 1) and
        // re-centered so it stays symmetric under the eyes. The width
        // lerps between the straight-mouth multiplier and the
        // curved-mouth multiplier as the bend knob moves toward either
        // extreme, so the straight and fully-curved mouths can be sized
        // independently.
        const mouthBend = Math.max(-1, Math.min(1, faceMouthCurveRef.current));
        const mouthWidthMult = faceMouthWidthRef.current
          + (faceMouthCurveWidthRef.current - faceMouthWidthRef.current) * Math.abs(mouthBend);
        const mouthWidth = baseEyeSize * 2 * mouthWidthMult;
        const mouthOffsetX = (width - mouthWidth) / 2;
        const mouthGap = Math.round(Math.max(12, baseEyeSize * 0.15) * faceMouthGapRef.current);
        const mouthHeight = Math.max(
          0,
          Math.min(
            Math.round(baseEyeSize * 0.5),
            usableHeight - baseEyeSize - mouthGap - 20
          )
        );

        // Center vertically. Clamp to a 10-px top margin so the eyes
        // never touch the viewport edge.
        const totalFaceHeight = baseEyeSize + mouthGap + mouthHeight;
        const eyesTop = Math.max(
          10,
          Math.round((usableHeight - totalFaceHeight) / 2)
        );
        const mouthTop = eyesTop + baseEyeSize + mouthGap;
        const eyeCenterY = eyesTop + baseEyeSize / 2;

        // Clamp the bend so the arc stays on the canvas. The total sag
        // (corner-to-midpoint) has the closed form (chord/2)·tan(θ/4),
        // so the largest angle a sag budget allows is
        // 4·atan(2·maxSag/chord). The arc's average height is pinned at
        // the mouth line, splitting the sag across it: the corners take
        // ~⅔ (bounded by .67) on one side and the midpoint ~⅓ (bounded
        // by .37) on the other, so both rooms constrain both bends.
        // mouthRise is the arc's actual highest point above the line —
        // the clear-band logic below needs it.
        let mouthCurve = mouthBend;
        let mouthRise = 0;
        if (mouthBend !== 0) {
          const chord = staticTraceWidth(mouthWidth);
          const mouthCenterY = mouthTop + mouthHeight / 2;
          const roomUp = Math.max(0, mouthCenterY - 10);
          const roomDown = Math.max(0, usableHeight - mouthCenterY - 10);
          const maxSag = mouthBend > 0
            ? Math.min(roomUp / 0.67, roomDown / 0.37)
            : Math.min(roomDown / 0.67, roomUp / 0.37);
          const theta = Math.min(
            Math.abs(mouthBend) * Math.PI,
            4 * Math.atan((2 * maxSag) / chord)
          );
          if (theta > 0.004 * Math.PI) {
            mouthCurve = Math.sign(mouthBend) * (theta / Math.PI);
            const half = theta / 2;
            const arcR = chord / (2 * Math.sin(half));
            const sincH = Math.sin(half) / half;
            // Smile: the corners are the top (sinc − cos above the
            // line); frown: the midpoint is (1 − sinc above the line).
            mouthRise = mouthBend > 0
              ? arcR * (sincH - Math.cos(half))
              : arcR * (1 - sincH);
          } else {
            mouthCurve = 0;
          }
        }

        // Drawn eye size: base × Eye size slider, clamped so eyes growing
        // about their fixed centers stay inside the top and side edges.
        const eyeSize = Math.max(
          0,
          Math.min(
            baseEyeSize * faceEyeSizeRef.current,
            2 * (eyeCenterY - 4),
            2 * Math.min(leftEyeCenterX, width - rightEyeCenterX)
          )
        );
        const drawnEyesTop = eyeCenterY - eyeSize / 2;
        const leftEyeX = leftEyeCenterX - eyeSize / 2;
        const rightEyeX = rightEyeCenterX - eyeSize / 2;

        // Fade-clear everything above the mouth (includes the eye
        // region + gap so trails bleeding into the gap fade out too).
        // Oversized eyes can dip below mouthTop; extend the fade band
        // to cover them so their trails fade instead of being erased.
        // Either bend arcs above mouthTop (smile corners, frown midpoint)
        // — raise the opaque band to keep the curved mouth
        // persistence-free, but never so high it cuts into the eyes'
        // trail region (a mouth reaching the eyes keeps its top inside
        // the fade band and picks up their trail look).
        let opaqueTop = mouthTop;
        if (mouthCurve !== 0) {
          opaqueTop = Math.min(
            mouthTop,
            Math.floor(mouthTop + mouthHeight / 2 - mouthRise - mouthHeight * 0.45)
          );
        }
        const clearSplit = Math.min(
          usableHeight,
          Math.max(opaqueTop, Math.ceil(drawnEyesTop + eyeSize))
        );
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, clearSplit);
        // Opaque clear of the remaining mouth region + below — static
        // wave has no persistence.
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.fillRect(0, clearSplit, width, usableHeight - clearSplit);

        // Both eyes show the full L/R mix — identical traces left and
        // right. Source switches between synth (clean sines) and audio
        // (post-master analyzer buffer) per the Visualizer setting.
        const { L, R } = getXY('audio');
        const xyOpts = {
          source: 'audio',
          lineWidthScale: vizLineWidthRef.current,
          outlineScale: vizOutlineRef.current,
          rotation: vizRotationRef.current,
        };
        drawXY(ctx, eyeSize, leftEyeX, drawnEyesTop, lineScale, r, g, b, L, R, xyOpts);
        drawXY(ctx, eyeSize, rightEyeX, drawnEyesTop, lineScale, r, g, b, L, R, xyOpts);

        // Mouth: white-line static wave, constrained to the eye span
        // so it can never be wider than the eyes above it.
        if (staticStyle !== 'off' && mouthHeight > 0) {
          ctx.save();
          ctx.translate(mouthOffsetX, mouthTop);
          drawStatic(
            ctx, mouthWidth, mouthHeight, lineScale, r, g, b,
            renderVolumesRef.current, smoothedWindowRef.current,
            staticStyle, faceStandingPeriodsRef.current,
            {
              lineWidthScale: faceMouthLineWidthRef.current,
              outlineThickness: staticOutlineRef.current,
              heightScale: faceStandingHeightRef.current,
              curve: mouthCurve,
              curveNeutralOnPause: faceMouthPauseNeutralRef.current,
            }
          );
          ctx.restore();
        }

      } else if (vizMode === 3) {
        // ── MODE 3: Hilbertscope ─────────────────────────────────────
        // Analytic-signal plot: each osc traces a circle, composite is
        // a Fourier epicycle. Reuses drawXY for visual consistency, and
        // shares the audio Lissajous box (0.95) + amplitude scale
        // (AUDIO_AMP_SCALE) so the polar scope reads at the same size as
        // mode 0 instead of an ad-hoc shrink.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, usableHeight);
        const scopeSize = Math.max(0, Math.min(width, usableHeight) * 0.95 * vizScaleRef.current);
        const scopeX = (width - scopeSize) / 2;
        const scopeY = (usableHeight - scopeSize) / 2;
        const { X, Y } = getHilbertXY('synth');
        drawXY(ctx, scopeSize, scopeX, scopeY, lineScale, r, g, b, X, Y, {
          source: 'synth',
          ampScale: AUDIO_AMP_SCALE,
          lineWidthScale: vizLineWidthRef.current,
          outlineScale: vizOutlineRef.current,
          rotation: vizRotationRef.current,
        });

      } else if (vizMode === 5) {
        // ── MODE 5: inverse face (wave eyes + XY mouth) ───────────────
        // The mirror of mode 2: the eyes are standing-summation waves
        // (drawStatic) at 1/3 the usual period count, and the mouth is
        // the XY oscilloscope (drawXY). A standing wave fills only a
        // thin horizontal band, so the eye boxes are wide and short
        // (rather than square) to keep the face compact; the whole face
        // (eyes + gap + square scope mouth) is vertically centered.
        // faceScale multiplies the base eye width everything else (eye
        // height, gaps, mouth size) derives from — whole face scales.
        const eyeW = Math.max(0, Math.min(width * 0.30, usableHeight * 0.42))
          * faceScaleRef.current;
        const eyeH = eyeW * 0.6;
        const eyeGap = eyeW * 0.4;
        const totalEyesWidth = eyeW * 2 + eyeGap;
        const eyesOffsetX = (width - totalEyesWidth) / 2;
        const leftEyeX = eyesOffsetX;
        const rightEyeX = eyesOffsetX + eyeW + eyeGap;

        // Negative gap: the eye box's lower half and the mouth box's
        // upper region are both empty padding (the wave is a thin band
        // centered in eyeH; the XY figure fills only ~0.6 of its box),
        // so the boxes intentionally overlap to bring the *visible*
        // eyes down close to the *visible* mouth without the drawn
        // content colliding.
        const mouthGap = -Math.round(eyeW * 0.26);
        // Square XY mouth, sized off the eye width and bounded by the
        // vertical room left under the eyes.
        const mouthSize = Math.max(
          0,
          Math.min(
            eyeW * 1.44,
            usableHeight - eyeH - mouthGap - 20
          )
        );
        const mouthX = (width - mouthSize) / 2;

        // Center the whole face vertically; clamp to a 10-px top margin.
        const totalFaceHeight = eyeH + mouthGap + mouthSize;
        const eyesTop = Math.max(
          10,
          Math.round((usableHeight - totalFaceHeight) / 2)
        );
        const mouthTop = eyesTop + eyeH + mouthGap;

        // Opaque-clear the full eye band (static wave has no persistence),
        // fade-clear below it so the XY mouth keeps its trails. The split
        // is the eye-box bottom, not mouthTop — with the negative overlap
        // mouthTop sits inside the eye band, and clearing there would let
        // the eye wave's lower peaks smear into the fade region. The mouth
        // figure sits well below the eye-box bottom, so it's unaffected.
        const clearSplit = Math.min(eyesTop + eyeH, usableHeight);
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.fillRect(0, 0, width, clearSplit);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, clearSplit, width, usableHeight - clearSplit);

        // Eyes: standing summation wave at 1/3 the period count. Both
        // eyes read the same shared render state, so they render as an
        // identical matched pair.
        if (staticStyle !== 'off' && eyeW > 0) {
          const eyePeriods = Math.max(1, Math.round(staticPeriodsRef.current / 3));
          const staticOpts = {
            lineWidthScale: staticLineWidthRef.current,
            outlineThickness: staticOutlineRef.current,
          };
          for (const eyeX of [leftEyeX, rightEyeX]) {
            ctx.save();
            ctx.translate(eyeX, eyesTop);
            drawStatic(
              ctx, eyeW, eyeH, lineScale, r, g, b,
              renderVolumesRef.current, smoothedWindowRef.current,
              staticStyle, eyePeriods, staticOpts
            );
            ctx.restore();
          }
        }

        // Mouth: XY oscilloscope, same audio source + options as mode 0.
        if (mouthSize > 0) {
          const { L, R } = getXY('audio');
          drawXY(ctx, mouthSize, mouthX, mouthTop, lineScale, r, g, b, L, R, {
            source: 'audio',
            lineWidthScale: vizLineWidthRef.current,
            outlineScale: vizOutlineRef.current,
            rotation: vizRotationRef.current,
          });
        }

      } else if (vizMode === 4) {
        // ── MODE 4: Timeline / piano-roll ────────────────────────────
        // Scrolling waterfall of every sounding frequency over time.
        // Accumulate this frame's samples into the module-level history,
        // then draw the visible window. Uses audioContext.currentTime as
        // the clock (there's no sequencer/transport in the app).
        const nowSec = audioEngine.audioContext
          ? audioEngine.audioContext.currentTime
          : performance.now() / 1000;
        sampleTimeline(nowSec);
        drawTimeline(
          ctx, width, usableHeight, nowSec,
          timelineWindowRef.current,
          timelineFreqMinRef.current,
          timelineFreqMaxRef.current,
          timelineAutoRangeRef.current,
          lineScale,
          r, g, b,
          vizOutlineRef.current,
          vizLineWidthRef.current
        );
      }
    };

    // Start animation loop
    drawScope();

    // Cleanup
    return () => {
      window.removeEventListener('resize', resizeCanvas);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Drag-on-scope → Feedback sliders. Maps the viewport-relative drag
  // position into the slider ranges (scale 0..3, blend 0..1) and pushes
  // them through the App-supplied callback so React state and the panel
  // sliders stay in sync. Pointer capture lets the drag continue if the
  // user moves off the canvas mid-drag.
  const onVfxDragRef = useRef(onVfxDrag);
  useEffect(() => { onVfxDragRef.current = onVfxDrag; }, [onVfxDrag]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const applyFromEvent = (e) => {
      const cb = onVfxDragRef.current;
      if (!cb) return;
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      const scale = Math.max(0, Math.min(3, (e.clientX / w) * 3));
      const blend = Math.max(0, Math.min(1, e.clientY / h));
      cb(scale, blend);
    };
    const onPointerDown = (e) => {
      // Ignore secondary buttons so right-clicks don't hijack the drag.
      if (e.button !== undefined && e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      applyFromEvent(e);
      e.preventDefault();
    };
    const onPointerMove = (e) => {
      // Only update while the canvas is actually capturing this pointer
      // (mid-drag). Hovering without pressing should not scrub the
      // sliders.
      if (!canvas.hasPointerCapture?.(e.pointerId)) return;
      applyFromEvent(e);
    };
    const onPointerUp = (e) => {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  return (
    <div className="oscilloscope-container">
      <canvas ref={canvasRef} id="scope" />
    </div>
  );
}
