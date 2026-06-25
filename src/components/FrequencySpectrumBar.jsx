import { memo, useEffect, useMemo, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { pairDissonance } from '../audio/dissonanceModel';
import { activeProfile } from '../audio/timbreProfiles';
import palette, { useTheme } from '../theme/palette';
import { isEditableTarget } from '../hooks/keyboardUtils';
import GlobalDetuneOrb from './GlobalDetuneOrb';

const FREQ_MIN = 0.1;
const FREQ_MAX = 20000;
const DOT_SIZE = 35;
const BAR_LINE_HEIGHT = 21;   // spectrum bar height (was 30; −30%)
const BAR_H_PADDING = 16;
const DOT_GAP = 14;

const PADDING_RATIO = 0.15;
const MIN_LOG_SPAN = 0.5;
const ZOOM_EASE = 0.25;

const SENSITIVITY_NORMAL = 0.5;
const SENSITIVITY_FINE = 0.1;

// Grab mode: vertical cursor motion adjusts volume. Scalar is in range-units / screen-height.
// Times getSensitivity() → normal ≈ 1 range/screen, fine ≈ 0.2 range/screen.
const GRAB_VOL_SCALAR = 2;

// Edge auto-pan: while dragging or grabbing, holding the pointer in the outer
// EDGE_ZONE of the *canvas* continuously drifts frequency toward that edge.
// The canvas is the centered min(viewport, CANVAS_MAX_WIDTH) region — same
// horizontal frame as the on-screen keyboard tray — so on wide displays the
// dragging area doesn't sprawl to the screen edges. Pulling toward the
// canvas edge scrolls the spectrum regardless of where the (narrower) bar
// sits inside it.
// Rate ramps linearly from 0 at the zone boundary to MAX_EDGE_PAN_RATE at the
// canvas edge, in octaves/sec. dt is clamped so a backgrounded tab can't jump.
// Zone width = 10% of canvas width = min(10vw, EDGE_ZONE_MAX_PX).
const CANVAS_MAX_WIDTH = 1200;
const EDGE_ZONE_FRAC = 0.10;
const EDGE_ZONE_MAX_PX = 120;
const MAX_EDGE_PAN_RATE = 2.0;
const MAX_EDGE_PAN_DT = 0.1;

const ABSOLUTE_LOG_MIN = Math.log2(FREQ_MIN);
const ABSOLUTE_LOG_MAX = Math.log2(FREQ_MAX);

// Adaptive tick density. Each level defines "nice" mantissas across every decade.
// At runtime, pick/fade levels so ~TARGET_TICK_COUNT ticks are on screen for any zoom.
const TICK_LEVELS = [
  { perDecade: 1, mantissas: [1] },
  { perDecade: 3, mantissas: [1, 2, 5] },
  { perDecade: 9, mantissas: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  {
    perDecade: 19,
    mantissas: [1, 1.1, 1.2, 1.3, 1.5, 1.7, 2, 2.3, 2.5, 2.8, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8],
  },
];
const TARGET_TICK_COUNT = 10;

function tickOpacityForRatio(ratio) {
  if (ratio < 0.3) return 0;
  if (ratio < 0.7) return (ratio - 0.3) / 0.4;      // fade in
  if (ratio < 1.5) return 1;                         // plateau
  if (ratio < 3.0) return 1 - (ratio - 1.5) / 1.5;   // fade out
  return 0;
}

const LOG2_10 = Math.log2(10);

function computeTicks(logMin, logMax) {
  const log10Min = logMin / LOG2_10;
  const log10Max = logMax / LOG2_10;
  const log10Span = log10Max - log10Min;
  if (log10Span <= 0) return [];

  // Max opacity across all levels that include this freq.
  const tickMap = new Map();
  for (const level of TICK_LEVELS) {
    const count = level.perDecade * log10Span;
    const opacity = tickOpacityForRatio(count / TARGET_TICK_COUNT);
    if (opacity <= 0) continue;

    const decadeStart = Math.floor(log10Min);
    const decadeEnd = Math.ceil(log10Max);
    for (let d = decadeStart; d <= decadeEnd; d++) {
      const decadeBase = 10 ** d;
      for (const m of level.mantissas) {
        const freq = m * decadeBase;
        if (freq < FREQ_MIN || freq > FREQ_MAX) continue;
        const log2Freq = Math.log2(freq);
        if (log2Freq < logMin || log2Freq > logMax) continue;
        const existing = tickMap.get(freq) || 0;
        if (opacity > existing) tickMap.set(freq, opacity);
      }
    }
  }
  return Array.from(tickMap, ([freq, opacity]) => ({ freq, opacity }));
}

const SHIFT_SYMBOL_TO_INDEX = {
  '!': 0, '@': 1, '#': 2, '$': 3, '%': 4,
  '^': 5, '&': 6, '*': 7, '(': 8, ')': 9,
};

function formatTick(freq) {
  const short = (n) => n.toFixed(2).replace(/\.?0+$/, '');
  if (freq >= 1000) return short(freq / 1000) + 'k';
  return short(freq);
}

// Two-decimal readout for the "active" label that appears below a dragged/grabbed dot.
function formatActiveFreq(freq) {
  if (freq >= 10000) return `${(freq / 1000).toFixed(1)}k`;
  if (freq >= 1000) return `${(freq / 1000).toFixed(2)}k`;
  return freq.toFixed(2);
}

const DOT_CENTER_Y = DOT_SIZE / 2;
const BAR_TOP_Y = DOT_SIZE + DOT_GAP;
const TOTAL_HEIGHT = BAR_TOP_Y + BAR_LINE_HEIGHT + 4;

// ── Dissonance HUD curve ─────────────────────────────────────────────────
// A transient sensory-dissonance field drawn behind the orbs while one (or
// more) orbs are grabbed/dragged. Baseline sits on the spectrum line and the
// field rises upward into the orb band (canvas overflows up; orbs z-index on
// top). Valleys mark consonant landing spots for the moving voice against the
// frozen background of the other sounding voices. Sine-world: each voice is a
// single partial at its fundamental. See research/dissonance-curves.md.
const DISS_CURVE_HEIGHT = 60;
// The fill bleeds DOWN past the spectrum line to fill the spectrum bar — its
// colors become the bar's background now that the track has no fill of its own.
const DISS_CURVE_DOWN = BAR_LINE_HEIGHT;
// Lift the curve's baseline (and its flat resting line) this many px ABOVE the
// spectrum bar — the colored region grows by the same amount and bleeds down
// across the gap into the bar.
const DISS_LINE_LIFT = 15;
// Horizontal sampling stride in CSS px. 2 keeps the field smooth while
// halving the per-frame field evaluations vs every-pixel.
const DISS_CURVE_STEP = 2;
// Peak exponent applied to the displayed level. Higher = the consonant peaks
// tower while everything below them collapses toward the baseline.
const DISS_PEAK_POW = 3;
// Reused per-column level buffer (avoids per-frame allocation now that the
// curve draws continuously). _dissLevels holds the freshly computed target;
// _dissDisplay is the on-screen value that eases toward it each frame so
// added/removed/retuned voices glide in instead of snapping.
let _dissLevels = null;
let _dissDisplay = null;
let _dissCols = 0;
let _dissAnimT = 0;
// Transition time constant (seconds). Larger = slower, more gradual glide.
let DISS_ANIM_TAU = 0.08;
if (typeof window !== 'undefined') {
  window.__dissAnim = (tau) => {
    if (Number.isFinite(tau)) DISS_ANIM_TAU = tau;
    return { tau: DISS_ANIM_TAU };
  };
}
// Highest partial frequency we bother evaluating (above hearing).
const DISS_MAX_FREQ = 20000;
// Display transform: with V active background voices,
//   dn = d / V                                   (per-voice mean roughness —
//        keeps the compression's dynamic range stable as voices pile up so
//        the field doesn't just saturate toward all-bright)
//   g  = min(CONTRAST_MAX, CONTRAST + CONTRAST_PER_VOICE · (V − 1))
//   v  = (dn / (dn + HALF)) ^ g
//
//   HALF             — soft compression half-point. Lower = valleys/peaks
//                      separate at lower roughness (more sensitive).
//   CONTRAST         — base gamma (1 voice) that extenuates the local minima:
//                      drives dips toward the baseline so consonant troughs
//                      read near-empty and dissonant peaks spike.
//   CONTRAST_PER_VOICE — how much MORE the dips are exaggerated per extra
//                      active voice, so dense chords deepen rather than wash
//                      out. (A root < 1 would lift valleys instead.)
// Live-tunable while exploring:  window.__dissTune(half, contrast, perVoice)
let DISS_HALF = 0.35;
let DISS_CONTRAST = 2.4;
let DISS_CONTRAST_PER_VOICE = 0.7;
const DISS_CONTRAST_MAX = 9;
if (typeof window !== 'undefined') {
  window.__dissTune = (half, contrast, perVoice) => {
    if (Number.isFinite(half)) DISS_HALF = half;
    if (Number.isFinite(contrast)) DISS_CONTRAST = contrast;
    if (Number.isFinite(perVoice)) DISS_CONTRAST_PER_VOICE = perVoice;
    return { half: DISS_HALF, contrast: DISS_CONTRAST, perVoice: DISS_CONTRAST_PER_VOICE };
  };
}

// ── Consonance drag damping ──────────────────────────────────────────────
// Instead of pulling the orb to a fixed spot (which fought the user when they
// tried to leave), we just SLOW the drag down inside consonant regions — like
// auto-ramping fine-tune (Shift) the closer you are to a valley. The orb never
// moves on its own and is always escapable; consonant basins simply occupy
// more pointer travel, so the nice (and nice-but-slightly-detuned) spots are
// easy to dial in. The damp factor multiplies the drag delta:
//   MIN  — slowest speed factor, at the bottom of a well (well under Shift's
//          0.2 now, so the nice-sounding hot spots really grip for fine-tuning).
//   RAMP — slowdown shape vs the (compressed) dissonance v. RAMP < 1 keeps the
//          slow zone concentrated at the deepest minima; → 1 spreads it across
//          all mildly-consonant areas.
// Toggle off: window.__dissDamping = false.  Tune: window.__dissDampTune(min, ramp).
let DISS_DAMP_MIN = 0.08;
let DISS_DAMP_RAMP = 0.5;
if (typeof window !== 'undefined') {
  window.__dissDampTune = (minScale, ramp) => {
    if (Number.isFinite(minScale)) DISS_DAMP_MIN = minScale;
    if (Number.isFinite(ramp)) DISS_DAMP_RAMP = ramp;
    return { minScale: DISS_DAMP_MIN, ramp: DISS_DAMP_RAMP };
  };
}

// Absolute color ramp: consonant (low) reads dim + cool, dissonant (high)
// reads vivid + hot. v ∈ [0,1] is the compressed field value.
function _dissFillStyle(v) {
  const hue = 190 - 190 * v;        // 190 (cyan) → 0 (red)
  const alpha = 0.04 + 0.72 * v;    // valleys near-vanish, peaks vivid
  return `hsla(${hue}, 90%, 55%, ${alpha})`;
}

// Inverse "hot spot" fill — grayscale. c ∈ [0,1] is the (squared) consonance
// (1 = nicest-sounding). Rough spots stay a dim dark gray; nice spots bloom to
// dramatic bright white so the landing targets pop as white hot spots.
function _hotSpotFill(c) {
  const light = 12 + 88 * c;        // near-black → pure white at the peaks
  const alpha = 0.04 + 0.96 * c;    // all but invisible in the rough, opaque at peaks
  return `hsla(0, 0%, ${light}%, ${alpha})`;
}

// Inverse view: show consonance hot spots (where the nice notes are) instead
// of the dissonance peaks. window.__dissHotSpots(false) flips back to compare.
let DISS_SHOW_HOTSPOTS = true;
if (typeof window !== 'undefined') {
  window.__dissHotSpots = (on) => { DISS_SHOW_HOTSPOTS = !!on; return DISS_SHOW_HOTSPOTS; };
}

// Include the voice(s) being moved in the displayed field, so the whole
// consonance map recalculates live as you drag (full current-chord view). A
// hot spot sits at the moving voice's own position (it's consonant with
// itself). NOTE: the drag damping still measures against the OTHER voices only
// (see consonanceSlowdown) so the orb stays free to move. Flip to the
// "landing guide" (exclude the mover): window.__dissIncludeMoving(false).
let DISS_INCLUDE_MOVING = true;
if (typeof window !== 'undefined') {
  window.__dissIncludeMoving = (on) => { DISS_INCLUDE_MOVING = !!on; return DISS_INCLUDE_MOVING; };
}

// Register fall-off: roll the consonance reading off at both ends so the very
// high and very low registers stop reading uniformly consonant. Per-octave
// power laws past each knee, folded into BOTH the displayed hot spots and the
// drag damping (via _effectiveV) so visual and feel agree.
//   High end: weight = (HF_KNEE / f) ^ HF_SLOPE   for f > HF_KNEE
//   Low end:  weight = (f / LF_KNEE) ^ LF_SLOPE   for f < LF_KNEE
// Live-tunable: window.__dissFalloff(knee, slope, floor) (high end),
//               window.__dissFalloffLow(knee, slope, floor) (low end).
let DISS_HF_KNEE = 600;     // Hz where the high-end roll-off begins
let DISS_HF_SLOPE = 1.1;    // gentler than before (was 1.5)
let DISS_HF_FLOOR = 0;
let DISS_LF_KNEE = 30;      // Hz where the low-end roll-off begins
let DISS_LF_SLOPE = 1.5;
let DISS_LF_FLOOR = 0;
if (typeof window !== 'undefined') {
  window.__dissFalloff = (knee, slope, floor) => {
    if (Number.isFinite(knee)) DISS_HF_KNEE = knee;
    if (Number.isFinite(slope)) DISS_HF_SLOPE = slope;
    if (Number.isFinite(floor)) DISS_HF_FLOOR = floor;
    return { knee: DISS_HF_KNEE, slope: DISS_HF_SLOPE, floor: DISS_HF_FLOOR };
  };
  window.__dissFalloffLow = (knee, slope, floor) => {
    if (Number.isFinite(knee)) DISS_LF_KNEE = knee;
    if (Number.isFinite(slope)) DISS_LF_SLOPE = slope;
    if (Number.isFinite(floor)) DISS_LF_FLOOR = floor;
    return { knee: DISS_LF_KNEE, slope: DISS_LF_SLOPE, floor: DISS_LF_FLOOR };
  };
}

// Build the frozen background as a flat partial list { f, a }: every unmuted,
// audible drone voice NOT in the exclude set (the grabbed/dragged orbs) plus
// all sounding keyboard/MIDI voices, each expanded into the ASSUMED timbre's
// partials. `profile` is a list of { ratio, amp } (see timbreProfiles.js) —
// decoupled from the actual synth so it works for MIDI-out and inharmonic
// timbres alike.
function _buildBackground(count, excludeSet, profile) {
  const bg = [];
  let voices = 0;
  const expand = (f0, amp) => {
    voices++;
    for (let h = 0; h < profile.length; h++) {
      const f = f0 * profile[h].ratio;
      if (f > DISS_MAX_FREQ) continue;
      bg.push({ f, a: amp * profile[h].amp });
    }
  };
  for (let i = 0; i < count; i++) {
    if (excludeSet.has(i)) continue;
    if (audioEngine.isMuted(i)) continue;
    const f0 = audioEngine.getFrequency(i);
    const vol = audioEngine.getVolume(i);
    if (f0 > 0 && vol > 0) expand(f0, vol);
  }
  const kv = keyboardVoiceManager.getVoicesForSynth
    ? keyboardVoiceManager.getVoicesForSynth()
    : [];
  for (const v of kv) {
    if (v.freq > 0 && v.amp > 0) expand(v.freq, v.amp);
  }
  return { parts: bg, voices };
}

// Raw (uncompressed) dissonance of a probe voice at fundamental f0 against a
// background partial list, expanded through `profile`. Shared by the curve
// draw loop and the gravity descent so both read the identical field.
function _probeDissonance(f0, background, profile) {
  let d = 0;
  for (let p = 0; p < profile.length; p++) {
    const pf = f0 * profile[p].ratio;
    if (pf > DISS_MAX_FREQ) continue;
    const pa = profile[p].amp;
    for (let k = 0; k < background.length; k++) {
      const b = background[k];
      d += pairDissonance(pf, b.f, pa, b.a);
    }
  }
  return d;
}

// Compress raw field dissonance to the displayed/used value v ∈ [0,1]:
// per-voice mean → soft compression → voice-count-aware gamma. Shared by the
// curve draw and the drag damping so the slow zones line up with the dark
// (consonant) bands the user sees.
function _compress(d, voiceCount) {
  const vc = Math.max(1, voiceCount || 1);
  const dn = d / vc;
  const gamma = Math.min(
    DISS_CONTRAST_MAX,
    DISS_CONTRAST + DISS_CONTRAST_PER_VOICE * (vc - 1),
  );
  return Math.pow(dn / (dn + DISS_HALF), gamma);
}

// Imposed register weight in [floor, 1]: 1 in the mid-band, decaying as a
// per-octave power-law past each knee (high end above HF_KNEE, low end below
// LF_KNEE).
function _registerWeight(f) {
  if (f > DISS_HF_KNEE) {
    const w = Math.pow(DISS_HF_KNEE / f, DISS_HF_SLOPE);
    return w < DISS_HF_FLOOR ? DISS_HF_FLOOR : w;
  }
  if (f < DISS_LF_KNEE) {
    const w = Math.pow(f / DISS_LF_KNEE, DISS_LF_SLOPE);
    return w < DISS_LF_FLOOR ? DISS_LF_FLOOR : w;
  }
  return 1;
}

// Effective dissonance v ∈ [0,1]: compressed roughness with the high-frequency
// fall-off folded in, so the high register reads more dissonant. v' = 1 −
// (1 − v)·weight(f). Shared by the curve draw and the damping so the hot spots
// and the drag feel agree.
function _effectiveV(d, voiceCount, freq) {
  const v = _compress(d, voiceCount);
  return 1 - (1 - v) * _registerWeight(freq);
}

// Drag-speed factor at a frequency: 1 in dissonant regions (full speed), down
// to DISS_DAMP_MIN at the bottom of a consonant well (auto fine-tune). Never
// moves the orb — only scales how far a pointer delta carries it.
function _dampFactor(freq, background, profile, voiceCount) {
  if (!background.length) return 1;
  const v = _effectiveV(_probeDissonance(freq, background, profile), voiceCount, freq);
  return DISS_DAMP_MIN + (1 - DISS_DAMP_MIN) * Math.pow(v, DISS_DAMP_RAMP);
}

// Paint the field across the bar's current (auto-zoomed) frequency range.
// Re-maps px→freq with the SAME log mapping the orbs use, so the curve stays
// glued to the spectrum as the range eases during edge-pan / out-of-bounds
// drags. At each pixel the probe voice contributes its full harmonic stack
// summed pairwise against the background partials — what makes consonance
// hot spots appear at the harmonic-series ratios for non-sine timbres.
//
// The canvas extends DISS_CURVE_DOWN px past the spectrum line so the column
// colors bleed down into the spectrogram (fading out lower down). The peak
// levels are lightly smoothed so the tops read as rounded rather than pointy.
function _drawDissonanceCurve(canvas, range, barWidth, background, probeProfile, voiceCount) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = barWidth;
  const cssUp = DISS_CURVE_HEIGHT;                 // rising part, above the line
  const cssDown = DISS_LINE_LIFT + DISS_CURVE_DOWN; // lift gap + bar fill
  const cssH = cssUp + cssDown;                     // full canvas height
  if (cssW <= 0) return;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const span = range.logMax - range.logMin;
  if (span <= 0 || probeProfile.length === 0) return;

  const cols = Math.floor(cssW / DISS_CURVE_STEP) + 1;
  if (!_dissLevels || _dissLevels.length < cols) _dissLevels = new Float32Array(cols);
  const lv = _dissLevels;
  // With nothing sounding the raw field would read "silence = totally
  // consonant" (a meaningless full-height fill), so target a flat zero instead
  // — a flat line resting on the spectrum line. It still eases there.
  const hasField = background.length > 0;

  // Pass 1 — field → displayed level per column.
  for (let i = 0; i < cols; i++) {
    if (!hasField) { lv[i] = 0; continue; }
    const f0 = Math.pow(2, range.logMin + (i * DISS_CURVE_STEP / cssW) * span);
    const d = _probeDissonance(f0, background, probeProfile);
    const v = _effectiveV(d, voiceCount, f0);
    // Hot-spot (inverse) view rises where consonant; the original view rises
    // where dissonant. Raised to a power so the peaks tower over everything.
    const base = DISS_SHOW_HOTSPOTS ? 1 - v : v;
    lv[i] = Math.pow(base, DISS_PEAK_POW);
  }

  // Pass 1.5 — light [0.25, 0.5, 0.25] smoothing so peak tops round off
  // instead of coming to a point. In-place, reading originals via `prev`.
  let prev = lv[0];
  for (let i = 0; i < cols; i++) {
    const cur = lv[i];
    const next = i + 1 < cols ? lv[i + 1] : cur;
    lv[i] = 0.25 * prev + 0.5 * cur + 0.25 * next;
    prev = cur;
  }

  // Pass 1.75 — temporal ease toward the new target, framerate-independent.
  // Snaps on the first frame and whenever the column count changes (a width
  // resize would otherwise blend across remapped pixels).
  if (!_dissDisplay || _dissDisplay.length < cols) _dissDisplay = new Float32Array(cols);
  const disp = _dissDisplay;
  const now = performance.now();
  if (cols !== _dissCols || _dissAnimT === 0) {
    for (let i = 0; i < cols; i++) disp[i] = lv[i];
  } else {
    const dt = Math.min(0.1, (now - _dissAnimT) / 1000);
    const alpha = dt > 0 ? 1 - Math.exp(-dt / DISS_ANIM_TAU) : 0;
    for (let i = 0; i < cols; i++) disp[i] += (lv[i] - disp[i]) * alpha;
  }
  _dissCols = cols;
  _dissAnimT = now;

  // Pass 2 — fill each column from its (rounded, eased) peak down to the canvas
  // bottom, so the color bleeds below the line; trace the tops with a soft
  // line. lineJoin/round keeps that line from spiking.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < cols; i++) {
    const px = i * DISS_CURVE_STEP;
    const level = disp[i];
    const top = cssUp * (1 - level);
    ctx.fillStyle = DISS_SHOW_HOTSPOTS ? _hotSpotFill(level) : _dissFillStyle(level);
    ctx.fillRect(px, top, DISS_CURVE_STEP, cssH - top);
    if (i === 0) ctx.moveTo(px, top);
    else ctx.lineTo(px, top);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Fade the bleed-down region out as it descends into the spectrogram, so it
  // dissolves rather than ending in a hard band. destination-out erases by the
  // gradient's alpha (nothing at the line → most at the bottom).
  const grad = ctx.createLinearGradient(0, cssUp, 0, cssH);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.92)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = grad;
  ctx.fillRect(0, cssUp, cssW, cssDown);
  ctx.globalCompositeOperation = 'source-over';
}

function computeEdgeRate(clientX) {
  const vw = window.innerWidth;
  const canvasWidth = Math.min(vw, CANVAS_MAX_WIDTH);
  const canvasLeft = Math.max(0, (vw - CANVAS_MAX_WIDTH) / 2);
  const canvasRight = canvasLeft + canvasWidth;
  const zone = Math.min(EDGE_ZONE_FRAC * canvasWidth, EDGE_ZONE_MAX_PX);
  if (zone <= 0) return 0;
  if (clientX < canvasLeft + zone) {
    const depth = Math.min(1, (canvasLeft + zone - clientX) / zone);
    return -depth * MAX_EDGE_PAN_RATE;
  }
  if (clientX > canvasRight - zone) {
    const depth = Math.min(1, (clientX - (canvasRight - zone)) / zone);
    return depth * MAX_EDGE_PAN_RATE;
  }
  return 0;
}

function freqToFraction(freq, logMin, logMax) {
  const clamped = Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
  return (Math.log2(clamped) - logMin) / (logMax - logMin);
}

function computeTargetRange(freqs) {
  const valid = freqs
    .filter((f) => f > 0)
    .map((f) => Math.max(FREQ_MIN, Math.min(FREQ_MAX, f)));
  if (valid.length === 0) {
    return { logMin: ABSOLUTE_LOG_MIN, logMax: ABSOLUTE_LOG_MAX };
  }
  const logs = valid.map((f) => Math.log2(f));
  const logLo = Math.min(...logs);
  const logHi = Math.max(...logs);
  const innerSpan = Math.max(logHi - logLo, MIN_LOG_SPAN);
  const center = (logLo + logHi) / 2;
  const totalSpan = innerSpan / (1 - 2 * PADDING_RATIO);
  const paddedMin = center - totalSpan / 2;
  const paddedMax = center + totalSpan / 2;
  return {
    logMin: Math.max(ABSOLUTE_LOG_MIN, paddedMin),
    logMax: Math.min(ABSOLUTE_LOG_MAX, paddedMax),
  };
}

// Edge-pan vector arrow that appears beside an actively-dragged/grabbed orb
// while the pointer is in the edge zone. Anchored on the OPPOSITE side from
// the push direction so the arrow stays on-screen when the orb itself is at
// the very edge of a small viewport: pushing right → arrow on the orb's
// left, pointing right.
const EDGE_ARROW_MAX_LEN = 60;
const EDGE_ARROW_ORB_GAP = DOT_SIZE / 2 + 2;
const EDGE_ARROW_HEAD = 7;

function renderEdgeArrow(key, x, y, edgeRate, color) {
  if (!edgeRate) return null;
  const magnitude = Math.min(1, Math.abs(edgeRate) / MAX_EDGE_PAN_RATE);
  if (magnitude <= 0) return null;
  const direction = edgeRate > 0 ? 1 : -1;
  const len = EDGE_ARROW_MAX_LEN * magnitude;
  const tipX = x - direction * EDGE_ARROW_ORB_GAP;
  const tailX = tipX - direction * len;
  const headBackX = tipX - direction * EDGE_ARROW_HEAD;
  const headHalf = EDGE_ARROW_HEAD * 0.75;
  return (
    <g key={key} className="fsb-edge-arrow">
      <line
        x1={tailX}
        y1={y}
        x2={tipX}
        y2={y}
        stroke={color}
        strokeWidth={3}
        strokeOpacity={0.95}
        strokeLinecap="round"
      />
      <polygon
        points={`${tipX},${y} ${headBackX},${y - headHalf} ${headBackX},${y + headHalf}`}
        fill={color}
      />
    </g>
  );
}

// Compact arrangement of N ghost circles around a cursor: 1 center, 2 horizontal,
// 3+ regular polygon at radius R. Total extent stays ≤ 2R + DOT_SIZE.
const GHOST_RING_RADIUS = 7;
function ghostOffset(i, total) {
  if (total <= 1) return { dx: 0, dy: 0 };
  if (total === 2) {
    return { dx: (i === 0 ? -1 : 1) * GHOST_RING_RADIUS, dy: 0 };
  }
  const angle = -Math.PI / 2 + (2 * Math.PI * i) / total;
  return {
    dx: GHOST_RING_RADIUS * Math.cos(angle),
    dy: GHOST_RING_RADIUS * Math.sin(angle),
  };
}

// Shrink a line segment so each endpoint lies on the circumference of a circle
// centered at the original endpoint, rather than the center. If the circles
// overlap, return null so no line is rendered.
function offsetLine(x1, y1, x2, y2, r1, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length <= r1 + r2) return null;
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: x1 + ux * r1,
    y1: y1 + uy * r1,
    x2: x2 - ux * r2,
    y2: y2 - uy * r2,
  };
}

// Dots collision-resolve so they don't visually overlap. Muted dots
// participate too — they're rendered (dimmed) and need to push the
// visible orbs aside instead of stacking under them.
function resolveCollisions(targetsPx, dotSize) {
  const minGap = dotSize * 0.85;
  const resolved = [...targetsPx];
  if (resolved.length < 2) return resolved;

  for (let iter = 0; iter < 20; iter++) {
    const sorted = resolved
      .map((_, i) => i)
      .sort((a, b) => resolved[a] - resolved[b]);
    let moved = false;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const gap = resolved[b] - resolved[a];
      if (gap < minGap) {
        const overlap = minGap - gap;
        resolved[a] -= overlap / 2;
        resolved[b] += overlap / 2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return resolved;
}

function FrequencySpectrumBar({
  oscillatorCount = 4,
  fineTuneEnabled = false,
  onActiveChange,
  extraActive,
  // When true (e.g. the keyboard tray is open), grabbing or starting a
  // drag on a muted orb does NOT auto-unmute it. The orbs in this mode
  // serve primarily as a tuning interface for the keyboard, so we
  // shouldn't surprise-restart drone playback when the user nudges one.
  suppressAutoUnmute = false,
  // Side-adornment hooks: the "all" orb sits to the left, +/- oscillator
  // count buttons to the right of the spectrum-bar pill.
  onOscillatorCountChange,
  maxOscillators = 10,
  // Notified (true/false) when an orb starts/stops being dragged or
  // grabbed. Lets sibling panels (e.g. the tuning panel) drop into a
  // cheaper render mode while values are changing every frame.
  onDragStateChange,
}) {
  // Subscribe to theme changes so JSX re-renders when the user flips
  // palette in settings — every osc-color lookup below reads live from
  // the palette singleton.
  useTheme();
  const [barWidth, setBarWidth] = useState(500 - 2 * BAR_H_PADDING);
  const [frequencies, setFrequencies] = useState(() => Array(oscillatorCount).fill(440));
  const [muted, setMuted] = useState(() => Array(oscillatorCount).fill(false));
  const [draggingDots, setDraggingDots] = useState(() => new Set());
  const [globalOrbDragging, setGlobalOrbDragging] = useState(false);
  const [grabbedOscs, setGrabbedOscs] = useState(() => new Set());
  const [ghosts, setGhosts] = useState({}); // { [pointerId]: { index, x, y } } during drag
  const [grabCursor, setGrabCursor] = useState(null); // { x, y } in container coords while grabbed
  const [range, setRange] = useState({ logMin: ABSOLUTE_LOG_MIN, logMax: ABSOLUTE_LOG_MAX });
  const [shiftHeld, setShiftHeld] = useState(false);
  const [activeOrder, setActiveOrder] = useState([]); // indices sorted by first-activation

  const containerRef = useRef(null);
  const dragRef = useRef({});
  // Refs to each orb / label DOM element so the keyboard-voice rAF loop
  // can flip a `kbd-active` class and toggle bubble states without
  // round-tripping through React state.
  const dotElsRef = useRef([]);
  const labelElsRef = useRef([]);
  const rangeRef = useRef(range);
  const barWidthRef = useRef(barWidth);
  const grabbedRef = useRef(grabbedOscs);
  const fineTuneRef = useRef(fineTuneEnabled);
  const shiftRef = useRef(shiftHeld);
  const lastGrabXRef = useRef(null); // tracks cursor X between grab-driven frames
  const lastGrabYRef = useRef(null); // tracks cursor Y between grab-driven frames (volume)
  const mousePosRef = useRef({ x: 0, y: 0 }); // latest client-space cursor, always tracked
  const grabEdgeRateRef = useRef(0); // octaves/sec drift for grabbed oscs, set from cursor X
  const lastEdgePanTimeRef = useRef(null); // performance.now() of previous edge-pan tick
  // Auto-zoom loop is demand-driven; pointer handlers that enter the
  // edge-pan state without immediately mutating engine freqs (which would
  // wake via addFrequencyListener) call wakeRef.current() to start it.
  const wakeRef = useRef(null);
  // Dissonance HUD canvas + its rAF-driving refs. draggingRef mirrors the
  // dragging set so the per-frame draw loop can read it without restarting.
  const dissCanvasRef = useRef(null);
  const draggingRef = useRef(draggingDots);

  useEffect(() => { barWidthRef.current = barWidth; }, [barWidth]);
  useEffect(() => { grabbedRef.current = grabbedOscs; }, [grabbedOscs]);
  useEffect(() => { draggingRef.current = draggingDots; }, [draggingDots]);
  useEffect(() => { fineTuneRef.current = fineTuneEnabled; }, [fineTuneEnabled]);
  useEffect(() => { shiftRef.current = shiftHeld; }, [shiftHeld]);

  // Dissonance HUD: the consonance hot-spot field behind the orbs, drawn
  // continuously (always shown) so it maps the current chord even at rest.
  // Redraws every frame off live refs so auto-zoom / edge-pan stay aligned and
  // playing notes update it live. The displayed field includes the moving
  // voice(s) (DISS_INCLUDE_MOVING); only the drag damping excludes them.
  useEffect(() => {
    let raf = null;
    const draw = () => {
      const c = dissCanvasRef.current;
      if (c) {
        // Assumed spectral profile (timbreProfiles) — DECOUPLED from the synth
        // so it's correct for MIDI-out and inharmonic timbres. All voices and
        // the probe share it for now. Read each frame so a live timbre swap
        // (e.g. __dissTimbre('bell')) reshapes the field immediately.
        const profile = activeProfile();
        const exclude = DISS_INCLUDE_MOVING
          ? new Set()
          : new Set([...draggingRef.current, ...grabbedRef.current]);
        const { parts, voices } = _buildBackground(oscillatorCount, exclude, profile);
        _drawDissonanceCurve(c, rangeRef.current, barWidthRef.current, parts, profile, voices);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [oscillatorCount]);

  // Keyboard-voice glow loop. Each frame: ask the voice manager which
  // voices are sounding, group them by drone slot (via tuning), and
  // imperatively flip a `kbd-active` class on the matching orb + label
  // for octave-0 voices. ±1 / ±2 voices light up small bubbles flanking
  // the label (IG-photo style — far-octave lit while the in-between
  // bubble stays dim if there's nothing playing closer in).
  //
  // Direct DOM mutation rather than React state because envelope amps
  // change every audio block and a setState rerender on each tick would
  // thrash the spectrum bar's draggable elements.
  useEffect(() => {
    const ACTIVE_THRESHOLD = 0.05; // env amp below this counts as silent
    let raf = null;
    const tick = () => {
      const voices = keyboardVoiceManager.getActiveVoices();
      // slot → Map(octave → maxAmpAtThatOctave)
      const slotOctAmps = new Map();
      for (const v of voices) {
        if (v.slot < 0) continue;
        let octs = slotOctAmps.get(v.slot);
        if (!octs) { octs = new Map(); slotOctAmps.set(v.slot, octs); }
        const cur = octs.get(v.octave) || 0;
        if (v.amp > cur) octs.set(v.octave, v.amp);
      }

      const dots = dotElsRef.current;
      const labels = labelElsRef.current;
      const totalSlots = Math.max(dots.length, labels.length);
      const MAX_OCT = 5;
      for (let i = 0; i < totalSlots; i++) {
        const octs = slotOctAmps.get(i);

        // Orb / label "kbd-active" fires when ANY octave of this slot's
        // scale degree is sounding — exact pitch or octaves above /
        // below. The bubble columns already show *which* specific
        // octaves are active; the orb itself just signals "this slot
        // is being played."
        let maxAmp = 0;
        if (octs) {
          for (const a of octs.values()) {
            if (a > maxAmp) maxAmp = a;
          }
        }
        const slotActive = maxAmp > ACTIVE_THRESHOLD;

        // Skip while user is actively dragging/grabbing — those states
        // have their own dim styling and shouldn't flicker on retrigger.
        const dot = dots[i];
        if (dot) {
          const interacting = dot.classList.contains('dragging') ||
                              dot.classList.contains('grabbed');
          dot.classList.toggle('kbd-active', !interacting && slotActive);
        }

        const label = labels[i];
        if (!label) continue;
        label.classList.toggle('kbd-active', slotActive);

        // For each side: a bubble at distance `n` is
        //   'on'  if octave (sign·n) is currently sounding
        //   'dim' if any further-out octave on this side is sounding
        //         (so n is an "in-between" placeholder, IG-pagination
        //         style)
        //   ''    (hidden) otherwise
        const updateSide = (sign) => {
          // Pre-compute active flags up to MAX_OCT so we can answer
          // "is anything further than n active" in one pass.
          const active = new Array(MAX_OCT + 1).fill(false); // index 1..MAX_OCT
          let maxActive = 0;
          for (let n = 1; n <= MAX_OCT; n++) {
            const a = (octs && octs.get(sign * n)) || 0;
            if (a > ACTIVE_THRESHOLD) {
              active[n] = true;
              if (n > maxActive) maxActive = n;
            }
          }
          for (let n = 1; n <= MAX_OCT; n++) {
            const oct = sign * n;
            const sel = oct > 0 ? `+${oct}` : `${oct}`;
            const el = label.querySelector(`[data-octave="${sel}"]`);
            if (!el) continue;
            if (active[n])       el.dataset.state = 'on';
            else if (n < maxActive) el.dataset.state = 'dim';
            else                 el.dataset.state = '';
          }
        };
        updateSide(-1);
        updateSide(1);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setBarWidth(Math.max(100, entry.contentRect.width - 2 * BAR_H_PADDING));
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Auto-zoom is demand-driven: ticks only when (a) the engine notifies a
  // freq/mute change, (b) an edge-pan is active, or (c) the zoom range is
  // still easing toward target. At idle (no drag, no engine changes, range
  // settled) the rAF stops entirely — main thread freed, no per-frame
  // array allocs, no GC churn.
  //
  // Wake sources:
  //   - audioEngine.addFrequencyListener: covers every freq + mute mutation
  //     anywhere in the app (computer keyboard, MIDI, all-orb drag, glide,
  //     alignment, etc.).
  //   - wakeRef.current(): called by the drag and document pointermove
  //     handlers below when they set an edge rate but didn't change freq
  //     yet (e.g., grabbed orb at FREQ_MIN with rightward edge-pan, or the
  //     very first pointermove crossing into the edge zone).
  useEffect(() => {
    let rafId = 0;
    let dirty = true;             // initial sync on mount
    const arraysEqual = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };

    const schedule = () => {
      if (!rafId) rafId = requestAnimationFrame(tick);
    };
    const wake = () => {
      dirty = true;
      schedule();
    };

    const tick = () => {
      rafId = 0;
      let keepRunning = false;

      if (!audioEngine.initialized) {
        // Wait for init. Cheap poll — we land here only between component
        // mount and the first AudioContext start, typically a handful of
        // frames; once initialized, the loop becomes demand-driven.
        rafId = requestAnimationFrame(tick);
        return;
      }

      try {
        // Edge auto-pan: drift toward the edge for any drag/grab pointer in
        // the zone. Done before reading frequencies so this frame's render
        // sees the new values. Each successful setFrequency below fires
        // _notifyFrequencyChange → wake() — but we also force keepRunning
        // so the loop continues even on frames that don't actually move
        // anything (e.g., orb pinned at FREQ_MIN).
        let anyEdgePan = false;
        for (const pid in dragRef.current) {
          if (dragRef.current[pid].edgeRate) { anyEdgePan = true; break; }
        }
        if (grabbedRef.current.size > 0 && grabEdgeRateRef.current) anyEdgePan = true;

        if (anyEdgePan) {
          const now = performance.now();
          const dt = lastEdgePanTimeRef.current === null
            ? 0
            : Math.min(MAX_EDGE_PAN_DT, (now - lastEdgePanTimeRef.current) / 1000);
          lastEdgePanTimeRef.current = now;
          if (dt > 0) {
            const sens = (fineTuneRef.current || shiftRef.current) ? SENSITIVITY_FINE : SENSITIVITY_NORMAL;
            for (const pid in dragRef.current) {
              const d = dragRef.current[pid];
              if (!d.edgeRate) continue;
              const cur = audioEngine.getFrequency(d.index);
              const next = Math.max(FREQ_MIN, Math.min(FREQ_MAX, cur * 2 ** (d.edgeRate * dt * sens)));
              if (next !== cur) audioEngine.setFrequency(d.index, next);
            }
            if (grabbedRef.current.size > 0 && grabEdgeRateRef.current) {
              const factor = 2 ** (grabEdgeRateRef.current * dt * sens);
              for (const idx of grabbedRef.current) {
                const cur = audioEngine.getFrequency(idx);
                const next = Math.max(FREQ_MIN, Math.min(FREQ_MAX, cur * factor));
                if (next !== cur) audioEngine.setFrequency(idx, next);
              }
            }
          }
          keepRunning = true;
        } else {
          lastEdgePanTimeRef.current = null;
        }

        if (dirty) {
          dirty = false;
          const f = audioEngine.getAllFrequencies();
          const m = audioEngine.getAllMutedStates();
          if (f.length >= oscillatorCount && m.length >= oscillatorCount) {
            const newFreqs = f.slice(0, oscillatorCount);
            const newMuted = m.slice(0, oscillatorCount);
            setFrequencies((prev) => (arraysEqual(prev, newFreqs) ? prev : newFreqs));
            setMuted((prev) => (arraysEqual(prev, newMuted) ? prev : newMuted));

            const target = computeTargetRange(newFreqs);
            const cur = rangeRef.current;
            const nextMin = cur.logMin + (target.logMin - cur.logMin) * ZOOM_EASE;
            const nextMax = cur.logMax + (target.logMax - cur.logMax) * ZOOM_EASE;
            if (
              Math.abs(nextMin - cur.logMin) > 0.0001 ||
              Math.abs(nextMax - cur.logMax) > 0.0001
            ) {
              rangeRef.current = { logMin: nextMin, logMax: nextMax };
              setRange(rangeRef.current);
              // Still mid-ease: keep ticking next frame with dirty=true so
              // we re-evaluate against the (unchanged) target until the
              // exponential lerp settles below threshold.
              dirty = true;
              keepRunning = true;
            }
          }
        }
      } catch { /* ignore */ }

      if (keepRunning) schedule();
    };

    const unsub = audioEngine.addFrequencyListener(wake);
    wakeRef.current = wake;
    schedule();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      unsub();
      wakeRef.current = null;
    };
  }, [oscillatorCount]);

  const freqXs = useMemo(
    () => frequencies.map((f) => BAR_H_PADDING + freqToFraction(f, range.logMin, range.logMax) * barWidth),
    [frequencies, barWidth, range.logMin, range.logMax]
  );
  const dotXs = useMemo(
    () => resolveCollisions(freqXs, DOT_SIZE),
    [freqXs]
  );

  const getSensitivity = () =>
    (fineTuneRef.current || shiftRef.current) ? SENSITIVITY_FINE : SENSITIVITY_NORMAL;

  // Drag-speed multiplier at a frequency: slows the drag inside consonant
  // wells (auto fine-tune) without ever moving the orb. Builds the frozen
  // background (all sounding voices except the ones being moved). Reads only
  // stable refs + module singletons, so it's safe to capture in the mount-time
  // grab handler. Returns 1 (no damping) when disabled or nothing else sounds.
  const consonanceSlowdown = (freq) => {
    if (typeof window !== 'undefined' && window.__dissDamping === false) return 1;
    const profile = activeProfile();
    const exclude = new Set([...draggingRef.current, ...grabbedRef.current]);
    const { parts, voices } = _buildBackground(audioEngine.getOscillatorCount(), exclude, profile);
    if (!parts.length) return 1;
    return _dampFactor(freq, parts, profile, voices);
  };

  const toggleGrab = (index) => {
    setGrabbedOscs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else {
        next.add(index);
        if (!suppressAutoUnmute && !audioEngine.paused && audioEngine.isMuted(index)) {
          audioEngine.unmuteOscillator(index);
        }
      }
      return next;
    });
  };

  const releaseAllGrabs = () => {
    setGrabbedOscs((prev) => (prev.size === 0 ? prev : new Set()));
  };

  const handlePointerDown = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    // Selecting a muted osc with the mouse unmutes it — UNLESS the
    // keyboard tray is up (then the orbs are a tuning UI for the
    // keyboard and shouldn't kick the drone back on by surprise), and
    // never when the drone bus is paused (a paused drone shouldn't be
    // restarted by a stray click). Drag-confirm in handlePointerMove
    // applies its own unmute rule that overrides suppressAutoUnmute.
    if (!suppressAutoUnmute && !audioEngine.paused && audioEngine.isMuted(index)) {
      audioEngine.unmuteOscillator(index);
    }
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current[e.pointerId] = {
      index,
      containerLeft: rect.left,
      containerTop: rect.top,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      didDrag: false,
    };
    setDraggingDots((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
    setGhosts((prev) => ({
      ...prev,
      [e.pointerId]: { index, x: e.clientX - rect.left, y: e.clientY - rect.top, edgeRate: 0 },
    }));
  };

  const handlePointerMove = (e) => {
    const drag = dragRef.current[e.pointerId];
    if (!drag) return;
    e.preventDefault();
    const totalDx = e.clientX - drag.startX;
    const totalDy = e.clientY - drag.startY;
    if (!drag.didDrag && (totalDx * totalDx + totalDy * totalDy) > 4) {
      drag.didDrag = true;
      // Confirmed drag: unmute the orb regardless of suppressAutoUnmute
      // (i.e. even when the keyboard tray is up), but ONLY while the drone
      // bus is playing — a drag with drones paused shouldn't surprise-restart
      // playback. Tap-only interactions still go through toggleGrab and
      // honor suppressAutoUnmute as before.
      if (!audioEngine.paused && audioEngine.isMuted(drag.index)) {
        audioEngine.unmuteOscillator(drag.index);
      }
    }
    if (drag.didDrag) {
      const deltaX = e.clientX - drag.lastX;
      const deltaY = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (deltaX !== 0 || deltaY !== 0) {
        const sens = getSensitivity();
        if (deltaX !== 0) {
          const r = rangeRef.current;
          const curFreq = audioEngine.getFrequency(drag.index);
          const slow = consonanceSlowdown(curFreq);
          const logDelta =
            (deltaX / barWidthRef.current) * (r.logMax - r.logMin) * sens * slow;
          audioEngine.setFrequency(
            drag.index,
            Math.max(FREQ_MIN, Math.min(FREQ_MAX, curFreq * 2 ** logDelta))
          );
        }
        if (deltaY !== 0) {
          const volDelta = (-deltaY / window.innerHeight) * GRAB_VOL_SCALAR * sens;
          const curVol = audioEngine.getVolume(drag.index);
          audioEngine.setVolume(
            drag.index,
            Math.max(0, Math.min(1, curVol + volDelta))
          );
        }
      }
      drag.edgeRate = computeEdgeRate(e.clientX);
      // Edge-pan needs the auto-zoom loop alive even on frames where
      // setFrequency above didn't fire (e.g., orb already at FREQ_MIN/MAX).
      if (drag.edgeRate) wakeRef.current?.();
    } else {
      drag.edgeRate = 0;
    }
    const x = e.clientX - drag.containerLeft;
    const y = e.clientY - drag.containerTop;
    setGhosts((prev) => ({
      ...prev,
      [e.pointerId]: { index: drag.index, x, y, edgeRate: drag.edgeRate || 0 },
    }));
  };

  const handlePointerUp = (e, cancelled = false) => {
    const drag = dragRef.current[e.pointerId];
    if (!drag) return;
    const { index, didDrag } = drag;
    delete dragRef.current[e.pointerId];
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }

    if (!didDrag && !cancelled) {
      toggleGrab(index);
    } else if (didDrag && !cancelled) {
      releaseAllGrabs();
      // Snap range to target instead of letting it ease over ~58 frames.
      // The post-release ease was causing 1s of re-renders, which on cold JIT
      // reads as a UI freeze.
      try {
        const f = audioEngine.getAllFrequencies();
        const target = computeTargetRange(f.slice(0, oscillatorCount));
        rangeRef.current = target;
        setRange(target);
      } catch { /* no-op */ }
    }

    setDraggingDots((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    setGhosts((prev) => {
      const next = { ...prev };
      delete next[e.pointerId];
      return next;
    });
  };

  // Always-on cursor tracking. Uses pointermove so it continues to fire even when
  // a dot's pointermove handler calls preventDefault (which would suppress mousemove).
  // Pointer events bubble to document during setPointerCapture, so this listener
  // sees every cursor movement — during drag, grab, or idle.
  useEffect(() => {
    const onPointerMove = (e) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };

      if (grabbedRef.current.size === 0) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const rate = computeEdgeRate(e.clientX);
      setGrabCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top, edgeRate: rate });
      grabEdgeRateRef.current = rate;
      // Wake the auto-zoom rAF when entering edge-pan from a static cursor
      // (cursor moved into the edge zone without dragging an orb, so the
      // setFrequency path below may not fire on this event).
      if (rate) wakeRef.current?.();

      if (lastGrabXRef.current === null) {
        lastGrabXRef.current = e.clientX;
        lastGrabYRef.current = e.clientY;
        return;
      }
      const deltaX = e.clientX - lastGrabXRef.current;
      const deltaY = e.clientY - lastGrabYRef.current;
      lastGrabXRef.current = e.clientX;
      lastGrabYRef.current = e.clientY;
      if (deltaX === 0 && deltaY === 0) return;

      const sens = getSensitivity();
      const r = rangeRef.current;
      // Per-osc base log step, scaled individually by each osc's consonance
      // slowdown below (a single shared factor can't carry per-voice damping).
      const baseLog = deltaX !== 0
        ? (deltaX / barWidthRef.current) * (r.logMax - r.logMin) * sens
        : 0;
      const volDelta = deltaY !== 0
        ? (-deltaY / window.innerHeight) * GRAB_VOL_SCALAR * sens
        : 0;

      for (const idx of grabbedRef.current) {
        if (baseLog !== 0) {
          const cur = audioEngine.getFrequency(idx);
          const slow = consonanceSlowdown(cur);
          const next = Math.max(FREQ_MIN, Math.min(FREQ_MAX, cur * 2 ** (baseLog * slow)));
          audioEngine.setFrequency(idx, next);
        }
        if (volDelta !== 0) {
          const curVol = audioEngine.getVolume(idx);
          const nextVol = Math.max(0, Math.min(1, curVol + volDelta));
          audioEngine.setVolume(idx, nextVol);
        }
      }
    };
    document.addEventListener('pointermove', onPointerMove);
    return () => document.removeEventListener('pointermove', onPointerMove);
  }, []);

  // On transitions in the grab set: reset anchors on N→0, seed ghost on 0→N
  // so the ghost is visible immediately after a keyboard grab (even without mouse motion).
  useEffect(() => {
    if (grabbedOscs.size === 0) {
      setGrabCursor(null);
      lastGrabXRef.current = null;
      lastGrabYRef.current = null;
      grabEdgeRateRef.current = 0;
      return;
    }
    if (lastGrabXRef.current === null) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setGrabCursor({
          x: mousePosRef.current.x - rect.left,
          y: mousePosRef.current.y - rect.top,
          edgeRate: 0,
        });
      }
      lastGrabXRef.current = mousePosRef.current.x;
      lastGrabYRef.current = mousePosRef.current.y;
    }
  }, [grabbedOscs]);

  // Click-anywhere-but-a-dot to release grabs. Clicks on a dot have their own
  // toggle behavior (via pointerup → toggleGrab); clicks on the bar background,
  // ticks, or anywhere else in the document should release the grab.
  useEffect(() => {
    if (grabbedOscs.size === 0) return;
    const handleClick = (e) => {
      if (e.target.closest && e.target.closest('.fsb-dot')) return;
      releaseAllGrabs();
    };
    // Defer attachment so the click that toggled grab on doesn't immediately release.
    const id = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', handleClick);
    };
  }, [grabbedOscs]);

  // When oscillators are removed, drop any drag/grab state that referenced them
  // before the next render tries to read frequencies[idx] at an out-of-range index.
  useEffect(() => {
    const filterSet = (s) => {
      const next = new Set();
      for (const i of s) if (i < oscillatorCount) next.add(i);
      return next.size === s.size ? s : next;
    };
    setDraggingDots((prev) => filterSet(prev));
    setGrabbedOscs((prev) => filterSet(prev));
    setActiveOrder((prev) => {
      const next = prev.filter((i) => i < oscillatorCount);
      return next.length === prev.length ? prev : next;
    });
    setGhosts((prev) => {
      let changed = false;
      const next = {};
      for (const pid in prev) {
        if (prev[pid].index < oscillatorCount) next[pid] = prev[pid];
        else changed = true;
      }
      return changed ? next : prev;
    });
    for (const pid of Object.keys(dragRef.current)) {
      if (dragRef.current[pid].index >= oscillatorCount) delete dragRef.current[pid];
    }
  }, [oscillatorCount]);

  // Notify parent of the current active set (dragging ∪ grabbed).
  // Bail-out when identical to prior set so we don't force parent re-renders.
  useEffect(() => {
    if (!onActiveChange) return;
    const next = new Set([...draggingDots, ...grabbedOscs]);
    onActiveChange((prev) => {
      if (prev instanceof Set && prev.size === next.size) {
        let same = true;
        for (const v of prev) if (!next.has(v)) { same = false; break; }
        if (same) return prev;
      }
      return next;
    });
  }, [draggingDots, grabbedOscs, onActiveChange]);

  // Surface a coarse "an orb is being manipulated" boolean to the parent.
  // Covers both interaction modes: direct press-drag (draggingDots) and
  // click-to-grab then move (grabbedOscs). Only transitions on start/stop,
  // not per-move, so it doesn't add to the per-frame render cost.
  useEffect(() => {
    onDragStateChange?.(draggingDots.size > 0 || grabbedOscs.size > 0 || globalOrbDragging);
  }, [draggingDots, grabbedOscs, globalOrbDragging, onDragStateChange]);

  // Reconcile active-order (first-selected-wins) when drag/grab sets change.
  useEffect(() => {
    setActiveOrder((prev) => {
      const activeSet = new Set([...draggingDots, ...grabbedOscs]);
      const filtered = prev.filter((i) => activeSet.has(i));
      const existing = new Set(filtered);
      for (const i of grabbedOscs) {
        if (!existing.has(i)) { filtered.push(i); existing.add(i); }
      }
      for (const i of draggingDots) {
        if (!existing.has(i)) { filtered.push(i); existing.add(i); }
      }
      // Bail if unchanged
      if (filtered.length === prev.length && filtered.every((v, i) => v === prev[i])) {
        return prev;
      }
      return filtered;
    });
  }, [draggingDots, grabbedOscs]);

  // Global safety-net cleanup for drag/grab state — protects against stuck
  // drags when pointerup is lost (browser chrome, right-click, capture drop,
  // pointer leaving the window, Cmd/Alt-Tab, tab switch, minimize, etc).
  useEffect(() => {
    const resetDragOnly = () => {
      const anyDrag = Object.keys(dragRef.current).length > 0;
      if (!anyDrag) return;
      dragRef.current = {};
      setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
      setGhosts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    };
    const releaseAll = () => {
      dragRef.current = {};
      setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
      setGhosts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      setGrabbedOscs((prev) => (prev.size === 0 ? prev : new Set()));
      setShiftHeld(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') releaseAll();
    };
    // If pointer leaves the document entirely (mouse goes off-screen), reset.
    const onPointerLeave = (e) => {
      if (e.relatedTarget === null && e.target === document.documentElement) {
        resetDragOnly();
      }
    };
    // Global pointerup/cancel as a fallback for when the dot never got its own.
    const onDocPointerUp = () => resetDragOnly();
    const onDocPointerCancel = () => resetDragOnly();

    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('pointerup', onDocPointerUp);
    document.addEventListener('pointercancel', onDocPointerCancel);
    return () => {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerCancel);
    };
  }, []);

  // Keyboard: 1-9/0 toggle grab; shift+digit (or shifted symbol) mutes; Esc releases.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (isEditableTarget(e.target)) return;
      // Bail on Cmd/Ctrl/Alt so OS-level chords (Cmd+Tab, Cmd+1, etc.)
      // don't trigger grabs or mute toggles.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Shift') {
        setShiftHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        releaseAllGrabs();
        // Also force-reset any stuck drag state.
        if (Object.keys(dragRef.current).length > 0) {
          dragRef.current = {};
          setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
          setGhosts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
        }
        return;
      }
      if (e.key >= '0' && e.key <= '9') {
        const index = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
        if (index < oscillatorCount) {
          if (e.shiftKey) {
            audioEngine.toggleMute(index);
          } else {
            toggleGrab(index);
          }
        }
        return;
      }
      if (SHIFT_SYMBOL_TO_INDEX[e.key] !== undefined) {
        const index = SHIFT_SYMBOL_TO_INDEX[e.key];
        if (index < oscillatorCount) audioEngine.toggleMute(index);
      }
    };
    const handleKeyUp = (e) => {
      if (e.key === 'Shift') setShiftHeld(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, [oscillatorCount]);

  const visibleTicks = useMemo(
    () => computeTicks(range.logMin, range.logMax),
    [range.logMin, range.logMax]
  );

  return (
    <>
      <div className="orb-backdrop" />
      {/* Viewport-spanning dotted lines marking where edge auto-pan engages.
          Only shown during an active drag or grab — otherwise they're visual
          noise. CSS positions them at the 1200px canvas inset (matching the
          keyboard tray); see computeEdgeRate() for the matching JS math. */}
      {(draggingDots.size > 0 || grabbedOscs.size > 0) && (
        <>
          <div className="fsb-edge-zone-line fsb-edge-zone-line-left" aria-hidden="true" />
          <div className="fsb-edge-zone-line fsb-edge-zone-line-right" aria-hidden="true" />
        </>
      )}
      <div className="fsb-row" style={{ height: TOTAL_HEIGHT }}>
      <div className="fsb-side fsb-side-left">
        <GlobalDetuneOrb onDragStateChange={setGlobalOrbDragging} />
      </div>
      <div
        className="freq-spectrum-bar"
        ref={containerRef}
        style={{ height: TOTAL_HEIGHT }}
      >
        {/* Dissonance HUD — sits behind the orbs, rising up from the spectrum
            line and bleeding DISS_CURVE_DOWN px down into the spectrogram.
            Always shown; maps the current chord's consonance hot spots. */}
        <canvas
          ref={dissCanvasRef}
          className="fsb-diss-curve"
          style={{
            left: BAR_H_PADDING,
            top: BAR_TOP_Y - DISS_CURVE_HEIGHT - DISS_LINE_LIFT,
            width: barWidth,
            height: DISS_CURVE_HEIGHT + DISS_LINE_LIFT + DISS_CURVE_DOWN,
          }}
          aria-hidden="true"
        />
        <div
          className="fsb-track"
        style={{
          left: BAR_H_PADDING,
          top: BAR_TOP_Y,
          width: barWidth,
          height: BAR_LINE_HEIGHT,
        }}
      >
        {visibleTicks.map(({ freq, opacity }) => {
          const x = freqToFraction(freq, range.logMin, range.logMax) * barWidth;
          return (
            <div key={freq} className="fsb-tick" style={{ left: x, opacity }}>
              <span className="fsb-tick-label">{formatTick(freq)}</span>
            </div>
          );
        })}
        {frequencies.map((f, i) => {
          const x = freqToFraction(f, range.logMin, range.logMax) * barWidth;
          const isActive = draggingDots.has(i) || grabbedOscs.has(i) || extraActive?.has(i);
          const color = palette.oscColor(i, oscillatorCount);
          return (
            <div
              key={i}
              className={`fsb-freq-marker ${muted[i] ? 'muted' : ''} ${isActive ? 'active' : ''}`}
              style={{ left: x, background: color, '--marker-color': color }}
            />
          );
        })}
      </div>


      {(() => {
        const homeY = DOT_CENTER_Y;
        const homeR = DOT_SIZE / 2;
        const ghostYOffset = 0;
        const ghostR = DOT_SIZE / 2;
        return (
          <svg className="fsb-lines" width="100%" height={TOTAL_HEIGHT} style={{ overflow: 'visible' }}>
            {frequencies.map((_, i) => {
              // Lines stay visible for muted orbs too — same opacity treatment
              // as unmuted, since the line just maps the orb to its position on
              // the spectrum bar (it's not a "playing" signifier).
              const color = palette.oscColor(i, oscillatorCount);
              const isActive = draggingDots.has(i) || grabbedOscs.has(i);
              const opacity = isActive ? 0.6 : 0.35;
              const seg = offsetLine(dotXs[i], homeY, freqXs[i], BAR_TOP_Y, homeR, 0);
              if (!seg) return null;
              return (
                <line
                  key={`dot2bar-${i}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke={color}
                  strokeOpacity={opacity}
                  strokeWidth={isActive ? 1.5 : 1}
                />
              );
            })}
            {Object.entries(ghosts).map(([pid, g]) => {
              const color = palette.oscColor(g.index, oscillatorCount);
              const seg = offsetLine(
                dotXs[g.index], homeY,
                g.x, g.y + ghostYOffset,
                homeR, ghostR
              );
              if (!seg) return null;
              return (
                <line
                  key={`ghost-${pid}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke={color}
                  strokeOpacity={0.5}
                  strokeWidth={1}
                />
              );
            })}
            {grabCursor &&
              Array.from(grabbedOscs).map((idx, i, arr) => {
                const color = palette.oscColor(idx, oscillatorCount);
                const { dx, dy } = ghostOffset(i, arr.length);
                const seg = offsetLine(
                  dotXs[idx], homeY,
                  grabCursor.x + dx, grabCursor.y + dy + ghostYOffset,
                  homeR, ghostR
                );
                if (!seg) return null;
                return (
                  <line
                    key={`grab-${idx}`}
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke={color}
                    strokeOpacity={0.5}
                    strokeWidth={1}
                  />
                );
              })}
            {Object.entries(ghosts).map(([pid, g]) =>
              renderEdgeArrow(
                `drag-arrow-${pid}`,
                g.x,
                g.y + ghostYOffset,
                g.edgeRate,
                palette.oscColor(g.index, oscillatorCount)
              )
            )}
            {grabCursor &&
              Array.from(grabbedOscs).map((idx, i, arr) => {
                const { dx, dy } = ghostOffset(i, arr.length);
                return renderEdgeArrow(
                  `grab-arrow-${idx}`,
                  grabCursor.x + dx,
                  grabCursor.y + dy + ghostYOffset,
                  grabCursor.edgeRate,
                  palette.oscColor(idx, oscillatorCount)
                );
              })}
          </svg>
        );
      })()}

      {frequencies.map((_, i) => {
        const color = palette.oscColor(i, oscillatorCount);
        const isDragging = draggingDots.has(i);
        const isGrabbed = grabbedOscs.has(i);
        // "Boosted" = externally marked active (fader fine-tune selection)
        // while the dot is not currently being dragged/grabbed
        // from the bar. Gives the home orb the same bright, glowy treatment
        // the drag ghost has — so the user can see which osc they're
        // affecting from another control.
        const isBoosted = !isDragging && !isGrabbed && extraActive?.has(i);
        const classes = ['fsb-dot'];
        if (muted[i]) classes.push('muted');
        if (isDragging) classes.push('dragging');
        else if (isGrabbed) classes.push('grabbed');
        if (isBoosted) classes.push('boosted');
        return (
          <div
            key={i}
            ref={(el) => { dotElsRef.current[i] = el; }}
            className={classes.join(' ')}
            style={{
              left: dotXs[i] - DOT_SIZE / 2,
              top: DOT_CENTER_Y - DOT_SIZE / 2,
              width: DOT_SIZE,
              height: DOT_SIZE,
              '--dot-color': color,
            }}
            onPointerDown={(e) => handlePointerDown(e, i)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={(e) => handlePointerUp(e, true)}
          />
        );
      })}

      {frequencies.map((f, i) => {
        const color = palette.oscColor(i, oscillatorCount);
        const isActive = draggingDots.has(i) || grabbedOscs.has(i);
        return (
          <div
            key={`label-${i}`}
            ref={(el) => { labelElsRef.current[i] = el; }}
            className={`fsb-dot-label ${muted[i] ? 'muted' : ''} ${isActive ? 'active-freq' : ''}`}
            style={{ left: dotXs[i], top: -2, color }}
          >
            {/* Octave columns flanking the number. Vertical stacks of
                up to 5 bubbles per side. Looked up by `data-octave`
                from the rAF tick. Order chosen so flex-direction:
                column places the closest-to-root bubble where the user
                wants it: TOP of left col (-1) and BOTTOM of right col
                (+1). */}
            <span className="fsb-octave-col fsb-octave-col-left">
              <span className="fsb-octave-bubble" data-octave="-1" />
              <span className="fsb-octave-bubble" data-octave="-2" />
              <span className="fsb-octave-bubble" data-octave="-3" />
              <span className="fsb-octave-bubble" data-octave="-4" />
              <span className="fsb-octave-bubble" data-octave="-5" />
            </span>
            <span className="fsb-label-text">
              {isActive ? formatActiveFreq(f) : i + 1}
            </span>
            <span className="fsb-octave-col fsb-octave-col-right">
              <span className="fsb-octave-bubble" data-octave="+5" />
              <span className="fsb-octave-bubble" data-octave="+4" />
              <span className="fsb-octave-bubble" data-octave="+3" />
              <span className="fsb-octave-bubble" data-octave="+2" />
              <span className="fsb-octave-bubble" data-octave="+1" />
            </span>
          </div>
        );
      })}

      {Object.entries(ghosts).map(([pid, g]) => {
        const color = palette.oscColor(g.index, oscillatorCount);
        return (
          <div
            key={`ghost-${pid}`}
            className="fsb-ghost fsb-ghost-drag"
            style={{
              left: g.x - DOT_SIZE / 2,
              top: g.y - DOT_SIZE / 2,
              width: DOT_SIZE,
              height: DOT_SIZE,
              '--dot-color': color,
            }}
          />
        );
      })}

      {grabCursor &&
        Array.from(grabbedOscs).map((idx, i, arr) => {
          const color = palette.oscColor(idx, oscillatorCount);
          const { dx, dy } = ghostOffset(i, arr.length);
          return (
            <div
              key={`grab-ghost-${idx}`}
              className="fsb-ghost"
              style={{
                left: grabCursor.x - DOT_SIZE / 2 + dx,
                top: grabCursor.y - DOT_SIZE / 2 + dy,
                width: DOT_SIZE,
                height: DOT_SIZE,
                '--dot-color': color,
              }}
            />
          );
        })}

      </div>
      <div className="fsb-side fsb-side-right">
        <button
          type="button"
          className="fsb-count-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount - 1)}
          disabled={oscillatorCount <= 2}
          title="Remove oscillator"
          aria-label="Remove oscillator"
        >−</button>
        <button
          type="button"
          className="fsb-count-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount + 1)}
          disabled={oscillatorCount >= maxOscillators}
          title="Add oscillator"
          aria-label="Add oscillator"
        >+</button>
      </div>
      </div>
    </>
  );
}

export default memo(FrequencySpectrumBar);
