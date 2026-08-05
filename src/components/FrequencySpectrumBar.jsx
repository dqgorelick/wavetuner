import { memo, useEffect, useMemo, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { pairDissonance } from '../audio/dissonanceModel';
import { droneStereo, panWidth, MAX_DETUNE_HZ } from '../audio/StereoMode';
import { activeProfile } from '../audio/timbreProfiles';
import { getMovingImpact } from '../audio/dissonanceSettings';
import { scrubRatio, getScrubSettings } from '../audio/scrubSettings';
import palette, { useTheme, DUO_WHITE } from '../theme/palette';
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
// Time constant (ms) for the frame-rate-INDEPENDENT zoom ease. A fixed
// per-frame lerp fraction converges twice as fast on 120Hz displays (the zoom
// felt instant on ProMotion Macs); easing by 1 - exp(-dt / ZOOM_TAU_MS) instead
// makes the zoom settle in ~300ms on any refresh rate.
const ZOOM_TAU_MS = 108;

const SENSITIVITY_NORMAL = 0.5;
const SENSITIVITY_FINE = 0.1;

// ── Orb-DRAG vertical axis (Settings → Orb drag) ────────────────────────
// Four modes, all of them owning the vertical axis of a drag; none of them
// touch the GRAB gesture, which keeps its volume drag (Dan, 2026-08-04).
// Vertical no longer sets the dragged voice's level in any mode — that job
// moved to the mixer console's faders.
//   'linear'    — flat 1x: a pixel of horizontal drag is worth the same pitch
//                 wherever the pointer is. Vertical does nothing.
//   'precision' — the tiers below.
//   'ios'       — the DIRECTIONAL ramp (audio/scrubSettings.js, Dan
//                 2026-08-04): 1x at the grab, raising the orb ABOVE it
//                 accelerates the sweep (to 4x), pulling BELOW slows it for
//                 precision (to the fine limit). One gesture covers both
//                 reach and resolution; a `< 1x >` rate tag over the dragged
//                 voice's Hz readout makes the invisible axis legible.
//   'zoom'      — zoom-as-gain (Dan, 2026-08-04): the vertical axis drives
//                 the VIEW SPAN instead of an invisible rate multiplier, and
//                 the span already IS the drag gain (the px→log conversion in
//                 handlePointerMove divides by it). Raising the pointer zooms
//                 out for coarse sweeps; pulling below leans the view in
//                 around the grab point for finer tuning — and all three
//                 terms of that curve (grab offset, slope, direction) are
//                 sliders in Settings. A continuous SUBTLE curve, applied with no
//                 easing while the finger is down. The rate needs no tag:
//                 the ruler's tick density is the readout, and on-screen orb
//                 motion stays proportional to finger motion at every depth.
//                 Multi-voice GRAB moves keep the stock auto-framing — you
//                 fine-tune one voice, you transport a chord.
//
// "Pull for precision" inverts the linear feel the way a video scrubber does:
// the further the pointer is pulled AWAY from where it grabbed the orb
// (vertically), the less pitch each horizontal pixel is worth. Tiers rather
// than a continuous curve so the resolution you're in is a place you can find
// again and hold; the drag integrates deltas, so crossing a boundary changes
// the rate without ever jumping the pitch. Distances are px of vertical
// travel from the grab.
const SCRUB_TIERS = [
  { dist: 70, scale: 0.5 },    // half speed
  { dist: 150, scale: 0.2 },   // fine
  { dist: 260, scale: 0.05 },  // super fine
];

function scrubScale(dy) {
  const d = Math.abs(dy);
  let scale = 1;
  for (const t of SCRUB_TIERS) {
    if (d >= t.dist) scale = t.scale;
  }
  return scale;
}

// ── 'zoom' mode ─────────────────────────────────────────────────────────
// Span multiplier relative to the range CAPTURED AT DRAG-CONFIRM (so
// whatever framing — or, on iOS, manual pinch — you start from is the 1x
// baseline). A CONTINUOUS curve applied INSTANTLY while the drag is live
// (Dan, 2026-08-04: the first cut used eased tier steps, and stepping
// between levels read as jitter — the view must track the finger 1:1 with
// no animation at all; only the release eases home). Kept SUBTLE for the
// same reason: this is a lean-in/lean-back of the frame, not a microscope.
// Depths are fractions of the pull direction's own viewport headroom (the
// ios ramp's normalization — the orb row sits near the screen bottom, so
// raw px would starve one side).
// The curve is y = mx + b in LOG span: log2(mult) = zoomOffset + depth *
// zoomScale * log2(dirEnd). All three terms are live settings (Settings →
// Orb drag → zoom; scrubSettings owns them) — `zoomOffset` is b, the span
// change at the grab itself (0 by default: grabbing no longer moves the
// view); `zoomScale` is m, how hard the pull leans the frame; `zoomInvert`
// swaps which direction leans in.
const ZOOM_TRAVEL = 0.85;       // full effect at 85% of the headroom
const ZOOM_MAX_OUT = 3;         // pull away → coarse, up to 3x wider
const ZOOM_MAX_IN = 0.35;       // pull toward → fine, down to ~1/3 span
// Hard floor on the zoomed-in span (log2 units): ~2.4 semitones around the
// dragged voice — "only the frequencies near the one moving". Also the
// effective fine limit: gain can't drop below MIN_ZOOM_SPAN / grabSpan.
const MIN_ZOOM_SPAN = 0.2;

/** The b term alone — the span multiplier a drag confirms at, before any pull. */
function zoomBaseMult() {
  return 2 ** getScrubSettings().zoomOffset;
}

function zoomSpanMult(pointerY, startY, viewportH) {
  const s = getScrubSettings();
  const base = 2 ** s.zoomOffset;
  const below = pointerY >= startY;
  // Headroom always comes from the REAL direction of travel (the orb row sits
  // near the screen bottom, so the two sides have very different room);
  // inverting only swaps which end of the curve that travel drives.
  const headroom = below ? viewportH - startY : startY;
  if (!(headroom > 0)) return base;
  const depth = Math.min(1, Math.abs(pointerY - startY) / (headroom * ZOOM_TRAVEL));
  const leansIn = s.zoomInvert ? !below : below;
  return base * (leansIn ? ZOOM_MAX_IN : ZOOM_MAX_OUT) ** (depth * s.zoomScale);
}

// Target range for an active zoom-mode drag: the scaled span, ANCHORED at
// the screen fraction where the voice sat at drag-confirm (drag.grabFrac) —
// zooming happens around the grab point, so confirming a drag never pans
// the view, and span changes grow/shrink the frame in place under the
// finger. Clamped by shifting at the absolute ends so the span survives to
// the edge.
function zoomDragTarget(drag) {
  const f = audioEngine.getFrequency(drag.index);
  const absSpan = ABSOLUTE_LOG_MAX - ABSOLUTE_LOG_MIN;
  const grabSpan = drag.grabSpan || absSpan;
  const span = Math.max(
    MIN_ZOOM_SPAN,
    Math.min(absSpan, grabSpan * (drag.spanMult ?? zoomBaseMult()))
  );
  const frac = drag.grabFrac ?? 0.5;
  let logMin = Math.log2(Math.max(FREQ_MIN, Math.min(FREQ_MAX, f))) - span * frac;
  let logMax = logMin + span;
  if (logMin < ABSOLUTE_LOG_MIN) {
    logMax += ABSOLUTE_LOG_MIN - logMin;
    logMin = ABSOLUTE_LOG_MIN;
  }
  if (logMax > ABSOLUTE_LOG_MAX) {
    logMin = Math.max(ABSOLUTE_LOG_MIN, logMin - (logMax - ABSOLUTE_LOG_MAX));
    logMax = ABSOLUTE_LOG_MAX;
  }
  return { logMin, logMax };
}

// `< 1x >` rate-tag visibility. OFF for now (Dan, 2026-08-04 late — a
// corner-border variant was tried on the Hz readout and then the mixer
// note cell and reverted the same day; how to read the ramp out is still
// an open call). The drag keeps computing rates so flipping this back is
// one line.
const SHOW_SCRUB_RATE_TAG = false;

// Label for the drag-rate tag riding above the dragged voice's Hz readout:
// "1x" in the neutral band around the grab row, "2.3x" above it, "1/5x"
// below (musician-friendly reciprocals rather than "0.21x"). Coarse
// quantization — one decimal up, integer reciprocal down — keeps the tag
// from flickering through every float on a continuous ramp.
function formatScrubRate(r) {
  if (r >= 0.95) {
    const v = Math.round(r * 10) / 10;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}x`;
  }
  return `1/${Math.round(1 / r)}x`;
}

// Release settle: how long the .settling class (a left/top overshoot
// transition in App.css approximating iOS's spring(0.4, 0.7)) stays on an
// orb after a drag releases. Slightly past the CSS 0.4s so the transition
// finishes before left/top go back to instant.
const ORB_SETTLE_MS = 420;

// JS twin of the CSS settle curve (cubic-bezier(0.34, 1.56, 0.64, 1) ≈
// easeOutBack): the zoom-mode release drives orb position per frame, so it
// needs the overshoot as a function. t 0→1, returns 0→1 overshooting ~1.1.
function settleEase(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

// Width of the fade band past each row edge: voice chrome (orb, labels,
// position line, readout) slides off the row and dissolves across this many
// px instead of clamping or blinking out (Dan, 2026-08-04).
const EDGE_FADE_PX = 56;

// Global-transpose drag: dragging the empty bar background left/right shifts
// the whole tuning's playback pitch (a DAW-BPM-style master offset that lives
// outside save-states). Semitones per pixel at normal sensitivity; Shift or
// the fine-tune toggle scales it down. Natural ("content follows finger")
// direction: dragging right slides the frequency labels right (pitch down).
// Flip TRANSPOSE_DRAG_SIGN to reverse.
const TRANSPOSE_SEMI_PER_PX = 0.03;
const TRANSPOSE_FINE_SCALE = 0.25;
const TRANSPOSE_DRAG_SIGN = -1;

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
// Keep in step with --stage-max in App.css (:root) — that variable caps
// the same frame for every edge-anchored piece of chrome.
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

// `padLog` widens the range ticks are GENERATED over (in log2 units) without
// touching the density decision, which always reads the visible span. The
// minor ticks below need it: a gap whose bounding label sits just off-screen
// still has to be subdivided, or the ridges stop short of the bar's edges.
function computeTicks(logMin, logMax, padLog = 0) {
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

    const decadeStart = Math.floor((logMin - padLog) / LOG2_10);
    const decadeEnd = Math.ceil((logMax + padLog) / LOG2_10);
    for (let d = decadeStart; d <= decadeEnd; d++) {
      const decadeBase = 10 ** d;
      for (const m of level.mantissas) {
        const freq = m * decadeBase;
        if (freq < FREQ_MIN || freq > FREQ_MAX) continue;
        const log2Freq = Math.log2(freq);
        if (log2Freq < logMin - padLog || log2Freq > logMax + padLog) continue;
        const existing = tickMap.get(freq) || 0;
        if (opacity > existing) tickMap.set(freq, opacity);
      }
    }
  }
  return Array.from(tickMap, ([freq, opacity]) => ({ freq, opacity }));
}

// ── Minor ruler ticks (iOS parity: the short ridges between the numbers) ──
// They sit on REAL round increments — 10s, 25s, 50s, 100s, 500s… — chosen per
// gap, NOT on an even pixel subdivision of it. The axis is logarithmic, so the
// pixel midpoint between 100 and 200 is 141.4 Hz: evenly-spaced ridges would
// lie about where the numbers are, which is the whole point of a ruler. Each
// gap between two SETTLED labels picks its own step so the ridge pitch lands
// near MINOR_TICK_PITCH px, then the ridges are planted at multiples of that
// step and positioned logarithmically (they bunch up toward the gap's high
// end, exactly as a log ruler should).
const MINOR_TICK_PITCH = 14;      // px, target spacing between ridges (iOS knurlPitch)
const MINOR_TICK_MIN_GAP = 30;    // px; tighter gaps than this get no ridges
const MINOR_NICE_STEPS = [1, 2, 2.5, 5, 10];
// Roughly every 5th ridge stands taller — but on the ROUNDEST values, not on
// every 5th index: with a 2.5 Hz step, index-5 would emphasize 37.5 while 35
// stayed short. The taller ridges land on multiples of the next nice step up.
const MINOR_TICK_EMPHASIS = 5;

/** Nearest 1/2/2.5/5×10ⁿ to `raw`, compared in log space so the choice is
 *  scale-free. */
function niceTickStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const decade = 10 ** Math.floor(Math.log10(raw));
  let best = 0;
  let bestErr = Infinity;
  for (const m of MINOR_NICE_STEPS) {
    const step = m * decade;
    const err = Math.abs(Math.log(step / raw));
    if (err < bestErr) { bestErr = err; best = step; }
  }
  return best;
}

/** The round-number lattice the ridges subdivide: the tick level that
 *  DOMINATES the current zoom (highest opacity, coarser on a tie), generated
 *  over a padded range so edge gaps still have a bounding mark. Not "every
 *  settled level" — at a tight zoom no level has finished fading in, and the
 *  ridges have to keep working there; past the finest level's fade-in the
 *  ruler is ridges only, so that level is the floor. */
function latticeTickFreqs(logMin, logMax, padLog = 0) {
  const log10Span = (logMax - logMin) / LOG2_10;
  if (log10Span <= 0) return [];
  let best = null;
  let bestOpacity = -1;
  for (const level of TICK_LEVELS) {
    const opacity = tickOpacityForRatio((level.perDecade * log10Span) / TARGET_TICK_COUNT);
    if (opacity > bestOpacity) { bestOpacity = opacity; best = level; }
  }
  if (bestOpacity <= 0) best = TICK_LEVELS[TICK_LEVELS.length - 1];
  const freqs = [];
  const decadeStart = Math.floor((logMin - padLog) / LOG2_10);
  const decadeEnd = Math.ceil((logMax + padLog) / LOG2_10);
  for (let d = decadeStart; d <= decadeEnd; d++) {
    const decadeBase = 10 ** d;
    for (const m of best.mantissas) {
      const freq = m * decadeBase;
      const log2Freq = Math.log2(freq);
      if (log2Freq < logMin - padLog || log2Freq > logMax + padLog) continue;
      freqs.push(freq);
    }
  }
  return freqs.sort((a, b) => a - b);
}

/** Ridge positions (px) for the gaps between `majors` (ascending freqs). */
function computeMinorTicks(majors, logMin, logMax, width) {
  const span = logMax - logMin;
  const out = [];
  if (!(span > 0) || !(width > 0)) return out;
  const xOf = (freq) => ((Math.log2(freq) - logMin) / span) * width;
  for (let i = 0; i < majors.length - 1; i++) {
    const lo = majors[i];
    const hi = majors[i + 1];
    const x0 = xOf(lo);
    const x1 = xOf(hi);
    if (x1 <= 0 || x0 >= width) continue;     // gap entirely off-screen
    const gap = x1 - x0;
    if (gap < MINOR_TICK_MIN_GAP) continue;
    const step = niceTickStep((hi - lo) / Math.round(gap / MINOR_TICK_PITCH));
    if (!step) continue;
    const tallStep = niceTickStep(step * MINOR_TICK_EMPHASIS);
    const first = Math.floor(lo / step) + 1;  // strictly inside the gap
    const last = Math.ceil(hi / step) - 1;
    if (last - first > 200) continue;         // runaway guard
    for (let k = first; k <= last; k++) {
      const freq = Number((k * step).toPrecision(12));  // kills 0.1-summing drift
      const x = xOf(freq);
      if (x < 0 || x > width) continue;
      const tall = Math.abs(freq - Math.round(freq / tallStep) * tallStep) < step * 1e-6;
      out.push({ freq, x, tall });
    }
  }
  return out;
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

// Pan readout under an orb, iOS's terse grammar (PanPot.valueLabel /
// FrequencySpectrumBar.swift readoutFlashes): the magnitude alone, because
// the rim dot's side is what says left-or-right; a hard pan is the bare side
// letter, no "100%" — the letter can't mean anything else. Dead center never
// reaches here (the head fades out at rest), so there's no 0% case.
function formatPanFlash(pan) {
  const pct = Math.round(Math.abs(pan) * 100);
  if (pct >= 100) return pan < 0 ? 'L' : 'R';
  return `${pct}%`;
}

// Vertical geometry is mode-dependent (orbs above vs below the spectrum) and
// lives in geometryFor() below — see the "Row geometry" section.

// ── Dissonance HUD curve ─────────────────────────────────────────────────
// A sensory-dissonance hot-spot field drawn behind the orbs. Its baseline is
// lifted above the spectrum bar; the field rises from there and bleeds down
// into the bar. The orbs float ABOVE the curve's max peak, each tethered to
// the curve surface by a short dynamic connector line. See
// research/dissonance-curves.md.
const DISS_CURVE_HEIGHT = 25;
// The fill bleeds DOWN past the spectrum line to fill the spectrum bar — its
// colors become the bar's background now that the track has no fill of its own.
const DISS_CURVE_DOWN = BAR_LINE_HEIGHT;
// Lift the curve's baseline (and its flat resting line) this many px ABOVE the
// spectrum bar — the colored region grows by the same amount and bleeds down
// across the gap into the bar.
const DISS_LINE_LIFT = 15;
// The transpose-drag band (just the frequency-number strip) is part of the
// mode-dependent geometry — see geometryFor().
// Horizontal sampling stride in CSS px. 1 = one column (and one field
// evaluation) per pixel: 1 is the finest fill, so the column bars line up
// tightly under the smooth curve stroke. 2 halves the per-frame cost at the
// expense of chunkier bars. This also sets the curve-level lookup resolution
// used by the position lines (smaller = more bars computed = more CPU per
// frame). At 2 with the fill hidden (DISS_SHOW_FILL=false, the default) only
// the [0.25,0.5,0.25]-smoothed curve stroke is visible, so the coarser
// sampling is imperceptible — and the field probe is the single largest
// continuous CPU sink on mobile (cols × profile × background pairDissonance
// calls, each two Math.exp, every frame).
const DISS_CURVE_STEP = 2;
// Peak exponent applied to the displayed level. Higher = sharper contrast (the
// consonant peaks tower while moderate-roughness regions collapse toward the
// baseline). Live-tunable via window.__dissPeak(pow).
let DISS_PEAK_POW = 3;
if (typeof window !== 'undefined') {
  window.__dissPeak = (pow) => {
    if (Number.isFinite(pow)) DISS_PEAK_POW = Math.max(0.5, Math.min(8, pow));
    return { pow: DISS_PEAK_POW };
  };
}
// Amplitude-normalization reference (linear 0..1). The field is normalized so
// the loudest sounding voice is treated as this level — making the curve's
// shape and brightness volume-INVARIANT at or above it (a 10% chord reads like
// a 100% chord), while chords entirely below it fade toward the baseline
// instead of blowing out white. Live-tunable via window.__dissAmpRef(v).
let DISS_AMP_REF = 0.1;
if (typeof window !== 'undefined') {
  window.__dissAmpRef = (v) => {
    if (Number.isFinite(v)) DISS_AMP_REF = Math.max(0.001, Math.min(1, v));
    return DISS_AMP_REF;
  };
}
// Consonance floor (applied to the consonance value BEFORE the peak power):
// rescale [floor, 1] → [0, 1] so moderate-consonance regions sink toward the
// baseline and only the strong valleys rise. This extenuates the peaks by
// DEEPENING their surroundings — the opposite of a pre-power gain, which lifts
// mids into a ceiling and flattens the field to white. 0 = no floor.
// Live-tunable via window.__dissFloor(v); try 0.3–0.5 for taller, sharper peaks.
let DISS_LEVEL_FLOOR = 0;
if (typeof window !== 'undefined') {
  window.__dissFloor = (v) => {
    if (Number.isFinite(v)) DISS_LEVEL_FLOOR = Math.max(0, Math.min(0.95, v));
    return DISS_LEVEL_FLOOR;
  };
}

// ── Derived curve geometry (row coordinates, y down) ─────────────────────
// Baseline = the level-0 flat line (lifted above the bar). Max = the level-1
// peak. In the classic layout the orbs float ORB_FLOAT_GAP above the max so
// they always clear the curve; in the flipped (iOS-style) layout they hang
// below the bar instead. All derived Y values live in geometryFor().
const ORB_FLOAT_GAP = 8;

// ── Played-note lines ────────────────────────────────────────────────────
// Every sounding keyboard/MIDI note draws a vertical line on the bar at its
// pitch, and is folded into the auto-zoom target so the view opens up to hold
// it (a note two octaves above the drones pulls the frame out to show both).
//
// The line rises from the base of the spectrum to the live curve surface at
// its pitch — the same stem the drone voices grow, minus the segment that
// reaches up to an orb. Its geometry lives with the position lines' (see
// _updateNoteLines), since the two share the curve-surface math.
//
// Envelope amp below this counts as silent: the line stops drawing and stops
const NOTE_AMP_THRESHOLD = 0.02;
// Two notes closer than this in log2 space (≈1 cent) draw as one line — the
// same pitch played on both keyboard and MIDI, or a stereo pair.
const NOTE_DEDUPE_LOG = 1 / 1200;

// Same-octave keyboard indicator: a small dot floating just above the orb,
// shown when a keyboard/MIDI note at this slot's EXACT octave is sounding.
// Replaces glowing the orb itself for that case (a played drone and a played
// key were indistinguishable). Non-zero octaves still use the flanking bubbles.
const KBD_DOT_SIZE = 5;
// Gap from the orb's top edge up to the dot's center. Large enough to clear
// the voice-number / freq label that sits above the orb (translate -100%), so
// the dot floats above the text rather than overlapping it.
const KBD_DOT_GAP = 18;

// ── Orb status flash (parameter display design language) ────────────────
// When a per-voice parameter is adjusted, every orb briefly overlays its
// value for that parameter: a one-line readout above the orb in the voice
// number's exact spot, color and type (the number hides for the duration
// — e.g. "45%", or the bare "L" at a hard pan; see formatPanFlash), plus an
// orb-colored indicator riding the orb's circumference on the top half at
// the value's position. Holds STATUS_FLASH_HOLD_MS after the last change,
// then fades out over STATUS_FLASH_FADE_MS. Pan (one dot) and detune (a
// mirrored pair of tick lines) use it; future per-voice params (level…)
// should reuse the same .fsb-status structure with their own readout.
const STATUS_FLASH_HOLD_MS = 1500;
const STATUS_FLASH_FADE_MS = 350;
// Orbit radius for the indicator dots — the orb's EDGE; each dot class
// pulls its center in by its own radius (see the CSS `top` calc) so
// every dot size sits flush against the inside of the rim.
// (A negative-space mask notch was tried here and reverted: animating a
// mask repaints the orb every frame and lagged the dial; a transform-
// rotated dot is compositor-cheap.)
const STATUS_ARC_RADIUS = DOT_SIZE / 2;

// ── Staged-patch target markers ──────────────────────────────────────────
// A staged slot previews each voice's target two ways: a floating dot
// STAGED_DOT_LIFT px above the orbs (tethered to its orb by a dotted line, and
// sliding down to meet the orb as the voice glides), plus an upward triangle
// rising from the bar's bottom edge marking that target on the spectrum. Both
// fade with how close the orb is to the target, so they dissolve when the orb
// is there and fade back in as it drifts away — a "return here" marker that
// persists after a launch until released.
const STAGED_DOT_LIFT = 65;
const STAGED_DOT_R = 7;              // smaller than the orbs (r = DOT_SIZE/2)
const TRIANGLE_W = 8;         // base (bottom) width — iOS: ±4 around the target x
const TRIANGLE_H = 7;         // ≈ equilateral for that base (iOS draws 8 × 6.5)

// ── Row geometry (container-local px, y down) ───────────────────────────
// Two layouts share every drawing routine and differ only in these Y values:
//   classic  — orbs float ABOVE the dissonance curve (overflowing the row's
//              top edge); voice number above each orb, which swaps to a live
//              Hz readout while dragged.
//   flipped  — iOS parity ("orbs below" in settings): the bar rides the top
//              of the row and the orbs hang BELOW it on short arms; the
//              voice number sits under each orb and a live Hz readout
//              appears in a strip above the curve while dragged.
// Flipped-only tuning:
const FLIPPED_ARM_GAP = 8;      // bar bottom → orb top edge (the short arm)
// Top strip reserved for the drag Hz readout. 25 puts ~12px of air between
// the digits' bottom edge and the curve zone's ceiling — iOS's clearance
// (hzLabelStem 8 + stemGap 2 + hzLabelCurveClearance 1.75); was 16, which
// left 3px and read visibly lower than iOS (Dan, 2026-08-04).
const FLIPPED_HZ_STRIP_H = 25;
// Height of the .fsb-hz-float box (its font-size, at line-height 1) and the y
// its stem leaves from — the digits' lower edge plus a hair of air, iOS's
// `digitsEdgeY`. The stem's other end lands where that voice's own position
// line meets the consonance curve, so readout + marker read as one continuous
// stem across the bar (iOS frequencyLabels(above:)).
const FLIPPED_HZ_FLOAT_H = 13;
const FLIPPED_HZ_STEM_TOP_Y = FLIPPED_HZ_FLOAT_H + 1;
function geometryFor(flipped) {
  const barTopY = flipped
    ? FLIPPED_HZ_STRIP_H + DISS_CURVE_HEIGHT + DISS_LINE_LIFT
    : DOT_SIZE + DOT_GAP;
  const dissBaselineY = barTopY - DISS_LINE_LIFT;
  const dissCurveMaxY = dissBaselineY - DISS_CURVE_HEIGHT;
  // Bottom of the spectrum bar — where every position line ends (classic)
  // or turns toward its orb (flipped).
  const posLineBottomY = barTopY + BAR_LINE_HEIGHT;
  const dotCenterY = flipped
    ? posLineBottomY + FLIPPED_ARM_GAP + DOT_SIZE / 2
    : dissCurveMaxY - ORB_FLOAT_GAP - DOT_SIZE / 2;
  // Same-octave kbd dot floats on the label side of the orb (above the
  // number classic, below it flipped) — KBD_DOT_GAP clears the text.
  const kbdDotCenterY = flipped
    ? dotCenterY + DOT_SIZE / 2 + KBD_DOT_GAP + KBD_DOT_SIZE / 2
    : dotCenterY - DOT_SIZE / 2 - KBD_DOT_GAP - KBD_DOT_SIZE / 2;
  // Staged-target dots: lifted above the orbs (classic) or parked just above
  // the curve's peak line (flipped, iOS's ghost row). They descend as a
  // launch lands — into the orb (classic), or onto the target frequency's
  // position at the spectrum's top edge (flipped: the orbs are on the far
  // side of the bar, so the handle anchors to the freq marker, not the orb).
  const stagedDotY = flipped
    ? dissCurveMaxY - STAGED_DOT_R
    : dotCenterY - STAGED_DOT_LIFT;
  const stagedLandY = flipped ? barTopY : dotCenterY;
  const totalHeight = flipped
    ? kbdDotCenterY + KBD_DOT_SIZE / 2 + 2
    : barTopY + BAR_LINE_HEIGHT + 4;
  // Target triangles hug the bar's BOTTOM edge, rising from the baseline
  // (iOS parity — the stagedOverlay triangles sit on blY, apex up).
  const triangleBaseY = posLineBottomY - 0.5;
  return {
    flipped,
    barTopY,
    dissBaselineY,
    dissCurveMaxY,
    posLineBottomY,
    dotCenterY,
    kbdDotCenterY,
    stagedDotY,
    stagedLandY,
    totalHeight,
    triangleBaseY,
    triangleApexY: triangleBaseY - TRIANGLE_H,
    // Release handle capping the foot of each played-note stem — 1px below
    // where the stem ends, so it reads as the stem's foot.
    noteDotY: posLineBottomY + 1,
    // Vertical band where a background drag transposes: just the
    // frequency-number strip. The bands outside it stay free so the other
    // markers (and, flipped, the orb row) stay clickable.
    transposeZoneTop: barTopY,
    transposeZoneBottom: barTopY + BAR_LINE_HEIGHT,
    // Transpose readout center — always ABOVE the spectrum. Classic: rides
    // the orb row at the bar's right edge (iOS lifts its readout OUT of the
    // orb row — Dan 2026-07-22: orbs ran over it when the tuning pushed a
    // voice to the right edge — but here the auto-zoom always keeps
    // right-edge padding, so orbs never reach it). Flipped: the readout
    // OVERFLOWS the row's top edge (overflow is visible — classic orbs
    // already draw up there), fully clear of the Hz label strip below it
    // (Dan 2026-08-04: "even higher than the labels"; it used to park
    // level with them in the strip). −15 puts the ~25px-tall two-line
    // box at ≈ −27..−3: a hair of air above the strip's y0.
    transposeReadoutY: flipped ? -15 : dotCenterY,
    // .fsb-side margin aligning the side adornments with the bar strip
    // (classic: the 4px bottom padding; flipped: the whole orb-row depth).
    sideMarginBottom: totalHeight - barTopY - BAR_LINE_HEIGHT,
  };
}
// Live geometry for the module-level draw helpers below. The component
// assigns this on every render (there is a single FrequencySpectrumBar
// instance in the app), so the rAF loops always read the current layout.
let GEO = geometryFor(false);
const TRIANGLE_HIT_PAD = 8;                      // invisible click/swipe padding
const SAME_SPOT_PX = 4;     // voice within this many px of target ⇒ on-spot (no markers)
const TRIANGLE_FADE_RANGE_PX = 4;  // triangle ramps in fast once the voice leaves its spot
const DOT_LINE_FADE_RANGE_PX = 12; // dot+line ramp in as the dot clears the orb's top edge
const STAGED_DESCENT_RANGE_PX = 55;  // orb-to-target px over which the dot lowers/lifts
const STAGED_DESCENT_EASE = 11;      // >1 makes the dot rush to full lift (less mid-travel)
const STAGE_FADE_MS = 300;  // markers ease in over this long when a slot is staged
// Step hop: the orb doesn't teleport to the landed dot — it glides over
// smoothly. Always 300 ms, floored there regardless of the step time, so
// even a 0 ms handoff gets the little slide. The landing time is known in
// advance (tail.until), so the hop PRE-EMPTS it by STEP_HOP_LEAD_MS: the
// orb is already moving while the dot makes its final approach and the two
// meet as it lands, instead of the orb reacting after the fact.
const STEP_HOP_MS = 300;
const STEP_HOP_LEAD_MS = 100;
// When the hop begins for a tail: lead ahead of the landing, but never
// before the step itself fired (tiny windows just slide immediately).
const stepHopStart = (tail) => Math.max(tail.startMs, tail.until - STEP_HOP_LEAD_MS);
// Smooth ease-in-out cubic (the engine's historical glide shape): gentle
// acceleration, gentle landing — no windup, no bounce.
const easeHop = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// Display-space frequency for a step tail at wall-clock nowMs: the old pitch
// held through the overlap window, then easing to `liveHz` along the hop
// curve. Returns null once the hop is done (the slot is simply live). Shared
// by the orb display and the auto-zoom so the frame moves WITH the orb.
function stepTailDisplayHz(tail, liveHz, nowMs) {
  const hopStart = stepHopStart(tail);
  if (nowMs < hopStart) return tail.freq;
  const hp = (nowMs - hopStart) / STEP_HOP_MS;
  if (hp >= 1) return null;
  const logFrom = Math.log2(Math.max(0.001, tail.freq));
  const logTo = Math.log2(Math.max(0.001, liveHz));
  return Math.pow(2, logFrom + (logTo - logFrom) * easeHop(Math.min(1, hp)));
}
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

// Auto contrast-stretch: per frame, map the field's actual [min,max] span to
// the full [0,1] height range so the peaks separate as much as possible (the
// raw consonance values otherwise cluster in a narrow band and read flat). The
// lo/hi window itself eases over DISS_CONTRAST_TAU so the field doesn't
// "breathe" as momentary peaks come and go. Toggle: window.__dissContrast(on).
let DISS_AUTO_CONTRAST = true;
let DISS_CONTRAST_TAU = 0.6;       // seconds — how fast the stretch window adapts
let _dissNormLo = 0;
let _dissNormHi = 1;
if (typeof window !== 'undefined') {
  window.__dissContrast = (on, tau) => {
    if (on !== undefined) DISS_AUTO_CONTRAST = !!on;
    if (Number.isFinite(tau)) DISS_CONTRAST_TAU = Math.max(0, tau);
    return { on: DISS_AUTO_CONTRAST, tau: DISS_CONTRAST_TAU };
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
//   CONTRAST         — gamma that extenuates the local minima: drives dips
//                      toward the baseline so consonant troughs read near-empty
//                      and dissonant peaks spike.
//   CONTRAST_PER_VOICE — extra gamma per active voice. Kept at 0 so the peak
//                      BRIGHTNESS is consistent across voice counts (a positive
//                      slope made white peaks only appear once ~5 voices pushed
//                      gamma high enough). The dn = d/V normalization already
//                      keeps the per-voice roughness comparable, so one fixed
//                      gamma renders the same color whether 1 or 12 voices play.
// Live-tunable while exploring:  window.__dissTune(half, contrast, perVoice)
let DISS_HALF = 0.35;
let DISS_CONTRAST = 5.2;          // ≈ the old 5-voice gamma, now used for all V
let DISS_CONTRAST_PER_VOICE = 0;  // 0 → voice-count-independent colors
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

// TEMP simplification: hide the filled hot-spot bloom (the white peaks) so only
// the curve outline shows, but keep the per-voice position lines (orb → curve →
// base). Flip via window.__dissFill(true) / window.__dissPosLines(false).
let DISS_SHOW_FILL = false;
let DISS_SHOW_POSITION_LINES = true;
if (typeof window !== 'undefined') {
  window.__dissFill = (on) => { DISS_SHOW_FILL = !!on; return DISS_SHOW_FILL; };
  window.__dissPosLines = (on) => { DISS_SHOW_POSITION_LINES = !!on; return DISS_SHOW_POSITION_LINES; };
}
// How much the voice(s) being moved contribute to the displayed field is the
// user-facing "Moving voice impact" setting (dissonanceSettings.getMovingImpact)
// applied per-voice in _buildBackground. The drag damping still measures against
// the OTHER voices only (impact 0 in consonanceSlowdown) so the orb stays free.

// Build the background as a flat partial list { f, a }: every unmuted, audible
// drone voice, each expanded into the ASSUMED timbre's partials. `profile` is a
// list of { ratio, amp } (see timbreProfiles.js) — decoupled from the actual
// synth so it works for MIDI-out and inharmonic timbres alike.
//
// Keyboard/MIDI voices are intentionally EXCLUDED: the curve maps the drone
// chord's consonance landscape so it stays a stable tuning reference while notes
// are played over it. (Amplitude, saturation, etc. still reflect the keyboard
// via the FFT-based DissonanceMeter — this field is drones-only by design.)
//
// Voices in `movingSet` (the grabbed/dragged orbs) have their amplitude AND
// their voice-count weight scaled by `impact` ∈ [0,1]: 1 = full (counts like
// any voice), 0 = excluded (the old landing-guide), in between = proportional.
// Scaling amplitude shrinks both the mover's clash contribution and its
// self-hot-spot; scaling the weight keeps the dn = d/V normalization honest.
function _buildBackground(count, movingSet, impact, profile) {
  // Pass 1 — gather every sounding voice as { f0, amp, weight } so we can find
  // the loudest before expanding into partials. amp is the per-voice linear
  // level (moving voices already scaled by impact).
  const src = [];
  for (let i = 0; i < count; i++) {
    if (audioEngine.isMuted(i)) continue;
    const f0 = audioEngine.getFrequency(i);
    const vol = audioEngine.getVolume(i);
    if (!(f0 > 0) || !(vol > 0)) continue;
    if (movingSet.has(i)) {
      if (impact <= 0) continue;            // excluded
      src.push({ f0, amp: vol * impact, weight: impact });
    } else {
      src.push({ f0, amp: vol, weight: 1 });
    }
  }

  // Step tails — during a step transition's overlap window the OLD note is
  // still ringing alongside the new one (AudioEngine.stepToFrequency). It's
  // a real sounding voice while it lasts, so it joins the field at its held
  // level: the curve then reflects both notes at once, matching the audio
  // and the visualizers. getStepTails() is already filtered to the audible
  // window, so tails drop out of the field the moment they release. (No
  // mute check: muting a slot mid-window targets the NEW voice's gain — the
  // tail keeps ringing.)
  for (const tail of audioEngine.getStepTails()) {
    if (tail.slot >= count) continue;
    if (!(tail.freq > 0) || !(tail.level > 0)) continue;
    src.push({ f0: tail.freq, amp: tail.level, weight: 1 });
  }

  // Amplitude-normalize: scale every voice so the loudest is treated as
  // DISS_AMP_REF's reciprocal of full — i.e. the loudest voice maps to 1 once
  // it reaches DISS_AMP_REF. This makes the field volume-invariant above the
  // reference (a quiet chord reads like a loud one) and fades it out below,
  // instead of the old behavior where low volumes collapsed the roughness and
  // the whole bar bloomed white. Relative balance between voices is preserved.
  let maxAmp = 0;
  for (const s of src) if (s.amp > maxAmp) maxAmp = s.amp;
  const norm = 1 / Math.max(maxAmp, DISS_AMP_REF);

  const bg = [];
  let voices = 0;
  for (const s of src) {
    voices += s.weight;
    const amp = s.amp * norm;
    for (let h = 0; h < profile.length; h++) {
      const f = s.f0 * profile[h].ratio;
      if (f > DISS_MAX_FREQ) continue;
      bg.push({ f, a: amp * profile[h].amp });
    }
  }
  return { parts: bg, voices };
}

// Count currently-sounding drone voices (unmuted, audible), regardless of the
// moving-impact weighting. Used to give a lone moving voice full impact so the
// curve doesn't vanish with nothing else to show against. Keyboard/MIDI voices
// are excluded to match _buildBackground — the curve is drones-only.
function _activeVoiceCount(count) {
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (!audioEngine.isMuted(i) && audioEngine.getFrequency(i) > 0 && audioEngine.getVolume(i) > 0) n++;
  }
  return n;
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

// ── Adaptive spectral-extent roll-off ────────────────────────────────────
// The inverse (hot-spot) view reads "fully consonant" wherever there's nothing
// nearby to clash with — including the dead zones past the chord's highest /
// lowest partial, which then bloom to full-height white at the edges. This
// rolls consonance off relative to the chord's OWN spectral extent, so it
// tracks the voices wherever they sit (no artificial fixed-frequency knees).
// Inside [fLo, fHi] (± a margin) the weight is 1; outside it decays as a
// per-octave power law down to a floor.
//   SLOPE  — octaves of roll-off steepness (weight = 2^(−slope·octavesOut)).
//   MARGIN — octaves of grace past the extent before fading begins (keeps
//            genuine octave-up/down landing spots from being clipped).
//   FLOOR  — minimum weight far outside the extent.
//   AMP    — minimum (normalized) partial amplitude that counts toward the
//            extent. Faint high harmonics (e.g. the 12th at ~1/12) otherwise
//            push fHi up to ~2 kHz while producing almost no real roughness,
//            leaving a wide "in-extent but consonant" band that blooms white.
//            Ignoring them pulls fHi down to where the SIGNIFICANT content is.
// Live-tunable: window.__dissExtent(slope, margin, floor, amp).
let DISS_EXTENT_SLOPE = 1.0;
let DISS_EXTENT_MARGIN = 0.5;
let DISS_EXTENT_FLOOR = 0;
let DISS_EXTENT_AMP = 0.2;
if (typeof window !== 'undefined') {
  window.__dissExtent = (slope, margin, floor, amp) => {
    if (Number.isFinite(slope)) DISS_EXTENT_SLOPE = Math.max(0, slope);
    if (Number.isFinite(margin)) DISS_EXTENT_MARGIN = Math.max(0, margin);
    if (Number.isFinite(floor)) DISS_EXTENT_FLOOR = Math.max(0, Math.min(1, floor));
    if (Number.isFinite(amp)) DISS_EXTENT_AMP = Math.max(0, Math.min(1, amp));
    return {
      slope: DISS_EXTENT_SLOPE, margin: DISS_EXTENT_MARGIN,
      floor: DISS_EXTENT_FLOOR, amp: DISS_EXTENT_AMP,
    };
  };
}

// Frequency extent of the SIGNIFICANT partials (amplitude ≥ DISS_EXTENT_AMP) in
// log2 Hz, padded by the margin. Faint partials are ignored so weak high
// harmonics don't stretch the band up into a consonant-reading dead zone.
// Computed once per frame and passed to _effectiveV so the per-column weight is
// O(1). Returns null when nothing clears the threshold (no roll-off).
function _backgroundExtent(background) {
  let fLo = Infinity, fHi = 0;
  for (let k = 0; k < background.length; k++) {
    const p = background[k];
    if (p.a < DISS_EXTENT_AMP) continue;
    if (p.f < fLo) fLo = p.f;
    if (p.f > fHi) fHi = p.f;
  }
  if (fHi === 0) return null;
  return { loEdge: Math.log2(fLo) - DISS_EXTENT_MARGIN, hiEdge: Math.log2(fHi) + DISS_EXTENT_MARGIN };
}

function _extentWeight(freq, extent) {
  if (!extent) return 1;
  const lf = Math.log2(freq);
  let octavesOut;
  if (lf > extent.hiEdge) octavesOut = lf - extent.hiEdge;
  else if (lf < extent.loEdge) octavesOut = extent.loEdge - lf;
  else return 1;
  const w = Math.pow(2, -DISS_EXTENT_SLOPE * octavesOut);
  return w < DISS_EXTENT_FLOOR ? DISS_EXTENT_FLOOR : w;
}

// Effective dissonance v ∈ [0,1]: compressed roughness with the adaptive
// spectral-extent roll-off folded in (so the dead zones past the chord's
// partials read more dissonant). v' = 1 − (1 − v)·extentWeight(f). `extent` is
// the per-frame background extent (see _backgroundExtent); pass null to skip the
// roll-off. Shared by the curve draw and the damping so visual + feel agree.
function _effectiveV(d, voiceCount, freq, extent) {
  const v = _compress(d, voiceCount);
  return 1 - (1 - v) * _extentWeight(freq, extent);
}

// Drag-speed factor at a frequency: 1 in dissonant regions (full speed), down
// to DISS_DAMP_MIN at the bottom of a consonant well (auto fine-tune). Never
// moves the orb — only scales how far a pointer delta carries it.
function _dampFactor(freq, background, profile, voiceCount) {
  if (!background.length) return 1;
  const extent = _backgroundExtent(background);
  const v = _effectiveV(_probeDissonance(freq, background, profile), voiceCount, freq, extent);
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
  // Adaptive spectral extent — computed once per frame, shared by every column
  // so the dead-zone roll-off costs O(1) per pixel.
  const extent = _backgroundExtent(background);

  // Pass 1 — field → displayed level per column.
  for (let i = 0; i < cols; i++) {
    if (!hasField) { lv[i] = 0; continue; }
    const f0 = Math.pow(2, range.logMin + (i * DISS_CURVE_STEP / cssW) * span);
    const d = _probeDissonance(f0, background, probeProfile);
    const v = _effectiveV(d, voiceCount, f0, extent);
    // Hot-spot (inverse) view rises where consonant; the original view rises
    // where dissonant. Sink moderate consonance toward the baseline with the
    // floor, then raise to a power so the surviving peaks tower over everything.
    const base = DISS_SHOW_HOTSPOTS ? 1 - v : v;
    const lifted = base > DISS_LEVEL_FLOOR ? (base - DISS_LEVEL_FLOOR) / (1 - DISS_LEVEL_FLOOR) : 0;
    lv[i] = Math.pow(lifted, DISS_PEAK_POW);
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

  // Shared timing for the temporal eases below. `firstFrame` snaps (no ease)
  // on mount and whenever the column count changes — a width resize would
  // otherwise blend across remapped pixels.
  const now = performance.now();
  const firstFrame = (cols !== _dissCols || _dissAnimT === 0);
  const dt = firstFrame ? 0 : Math.min(0.1, (now - _dissAnimT) / 1000);

  // Pass 1.6 — auto contrast-stretch. Find the field's current [lo,hi] span,
  // ease the normalization window toward it (so it adapts smoothly rather than
  // snapping every frame), then remap lv into [0,1]. This pulls the peaks and
  // troughs apart to use the full height, surfacing structure that otherwise
  // sits in a narrow bright band. Skipped when the span is too small to be
  // meaningful (near-flat field) so we don't amplify noise into fake peaks.
  if (DISS_AUTO_CONTRAST && hasField) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < cols; i++) {
      const x = lv[i];
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (firstFrame || DISS_CONTRAST_TAU === 0) {
      _dissNormLo = lo; _dissNormHi = hi;
    } else {
      const a = dt > 0 ? 1 - Math.exp(-dt / DISS_CONTRAST_TAU) : 0;
      _dissNormLo += (lo - _dissNormLo) * a;
      _dissNormHi += (hi - _dissNormHi) * a;
    }
    const nspan = _dissNormHi - _dissNormLo;
    if (nspan > 0.02) {
      const inv = 1 / nspan;
      for (let i = 0; i < cols; i++) {
        const x = (lv[i] - _dissNormLo) * inv;
        lv[i] = x < 0 ? 0 : x > 1 ? 1 : x;
      }
    }
  }

  // Pass 1.75 — temporal ease toward the new target, framerate-independent.
  if (!_dissDisplay || _dissDisplay.length < cols) _dissDisplay = new Float32Array(cols);
  const disp = _dissDisplay;
  if (firstFrame) {
    for (let i = 0; i < cols; i++) disp[i] = lv[i];
  } else {
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
    if (DISS_SHOW_FILL) {
      ctx.fillStyle = DISS_SHOW_HOTSPOTS ? _hotSpotFill(level) : _dissFillStyle(level);
      ctx.fillRect(px, top, DISS_CURVE_STEP, cssH - top);
    }
    if (i === 0) ctx.moveTo(px, top);
    else ctx.lineTo(px, top);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Fade the bleed-down region out as it descends into the spectrogram, so it
  // dissolves rather than ending in a hard band. destination-out erases by the
  // gradient's alpha (nothing at the line → most at the bottom). Only needed
  // when the fill is drawn — with the curve-only view there's nothing to fade.
  if (DISS_SHOW_FILL) {
    const grad = ctx.createLinearGradient(0, cssUp, 0, cssH);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.92)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = grad;
    ctx.fillRect(0, cssUp, cssW, cssDown);
    ctx.globalCompositeOperation = 'source-over';
  }
  // Per-voice position lines (and frequency-ruler ticks) are NOT drawn on the
  // canvas. The position lines are unified SVG polylines (see
  // _updatePositionLines) so the curve-region and bar segments share one stroke
  // + glow; the ruler ticks stay confined to the spectrum bar (.fsb-tick divs).
}

// Row Y of the dissonance-curve surface for a displayed level ∈ [0,1]
// (0 = baseline just above the bar, 1 = the curve's tallest peak).
function _curveSurfaceY(level) {
  return GEO.dissBaselineY - DISS_CURVE_HEIGHT * level;
}
// Eased curve level at a bar-relative pixel x, read from the live per-column
// buffer the draw loop fills. 0 when there's no field (paused / silent).
function _levelAtBarX(barPx) {
  const levels = _dissDisplay;
  if (!levels || !levels.length) return 0;
  const col = Math.round(barPx / DISS_CURVE_STEP);
  if (col < 0 || col >= levels.length) return 0;
  return levels[col];
}
// Top of the consonance-graph line under a CONTAINER x — the level lookup
// and surface row in one, since three callers want exactly this point: the
// readout stem's foot, the position line's upper stop, and the above-bar
// crossing test (an orb is "above" once its center clears this).
function _curveSurfaceAtX(containerX) {
  return _curveSurfaceY(_levelAtBarX(containerX - BAR_H_PADDING));
}

// The rotated tick labels pivot at the bar's lower edge and read upward,
// which leaves the strip just below the bar clear — so the played-note
// release dot (GEO.noteDotY) sits underneath the numbers rather than
// colliding with them. Pressing it releases that voice, the same path as
// re-pressing a held key.
// Midway between the staged-target dots (STAGED_DOT_R) and the speck this
// started as: big enough to read as a handle, still clearly subordinate to the
// staging chrome above the orbs.
const NOTE_DOT_R = 4.75;
// Still a small target, so an invisible concentric circle carries the pointer.
const NOTE_DOT_HIT_R = 9;

// Draw each voice's position line as a SINGLE SVG polyline: from the orb's edge
// down to the live dissonance-curve surface at its frequency (the dynamic curve
// top), then straight down to the bottom of the spectrum bar. One element per
// voice means the curve-region segment and the bar segment share one stroke +
// glow — no DOM/canvas seam at the spectrum top. The top endpoint rides the
// eased curve surface every frame, so it tracks the field as it morphs.
// `dragPos` (Map index → {x, y}) overrides a voice's orb endpoint while it's
// being finger-dragged or release-settling — the stem then runs from the orb
// at the finger down to the TRUE frequency x on the bar (iOS parity).
function _updatePositionLines(lineEls, dotXs, freqXs, dragPos, edgeFades) {
  for (let i = 0; i < lineEls.length; i++) {
    const el = lineEls[i];
    if (!el) continue;
    const dp = dragPos?.get(i);
    const dotX = dp ? dp.x : dotXs[i];
    const dotY = dp ? dp.y : GEO.dotCenterY;
    const freqX = freqXs[i];
    // Edge fade rides the element's own opacity (multiplies the JSX
    // strokeOpacity), so the line dissolves as its frequency slides off
    // the row instead of being cut by the SVG clip. Held voices are
    // exempt — their marker is anchored on screen.
    el.style.opacity = dp ? '' : String(edgeFades?.[i] ?? 1);
    // Finite, NOT non-negative: a left drag carries the orb past the row's
    // left edge, and a `>= 0` test there hid the whole line — frequency
    // marker included — for a voice sitting comfortably mid-bar (Dan,
    // 2026-08-04). The guard only ever meant "no position yet" (dotXs is
    // empty for the first frames after mount). Negative x is a real
    // coordinate; SVG clips the off-row part and keeps the rest.
    if (!Number.isFinite(dotX) || !Number.isFinite(freqX)) { el.style.display = 'none'; continue; }
    // Every voice's line rides up to the live curve surface at its frequency
    // (muted voices included — they just render dimmer, see the JSX styling).
    const level = _levelAtBarX(freqX - BAR_H_PADDING);
    const surfaceY = _curveSurfaceY(level);
    // The polyline runs orb → near bar edge → far endpoint. Classic: orb is
    // above, so it meets the curve surface first, then drops to the bar's
    // bottom. Flipped: the orb hangs below, and the stem's attachment slides
    // with a dragged orb (iOS parity): anchored at the bar's bottom edge
    // while the orb hangs below it, tracking the orb through the bar band,
    // and locking to the indicator's tip on the curve surface once the orb
    // is pulled above the spectrum — the stem "follows the line to the top".
    // The indicator itself always spans surface → bar bottom; only the stem's
    // attachment point moves.
    // Trim the orb endpoint to the orb's edge so the line meets it cleanly.
    const nearY = GEO.flipped
      ? Math.min(Math.max(dotY, surfaceY), GEO.posLineBottomY)
      : surfaceY;
    const seg = offsetLine(dotX, dotY, freqX, nearY, DOT_SIZE / 2, 0);
    if (!seg) {
      // Stem shorter than the orb radius (orb swallowing its attachment
      // point mid-crossing). iOS hides just the stem — keep the indicator.
      if (GEO.flipped) {
        el.style.display = '';
        el.setAttribute('points', `${freqX},${surfaceY} ${freqX},${GEO.posLineBottomY}`);
      } else {
        el.style.display = 'none';
      }
      continue;
    }
    el.style.display = '';
    el.setAttribute(
      'points',
      GEO.flipped
        ? (nearY < GEO.posLineBottomY
            ? `${seg.x1},${seg.y1} ${freqX},${nearY} ${freqX},${surfaceY} ${freqX},${GEO.posLineBottomY}`
            : `${seg.x1},${seg.y1} ${freqX},${GEO.posLineBottomY} ${freqX},${surfaceY}`)
        : `${seg.x1},${seg.y1} ${freqX},${surfaceY} ${freqX},${GEO.posLineBottomY}`,
    );
  }
}

// Stem tying the flipped layout's drag Hz readout back down to the spectrum.
// The readout sits in the top strip — the far side of the bar from the orbs —
// so without a tether it floats free of the voice it describes. The stem
// leaves the digits' lower edge and lands on the live curve surface at the
// voice's TRUE frequency x, exactly where its position line starts: the two
// meet, and the label + marker read as one stem from the readout, across the
// curve, down through the bar. It hangs straight down from a readout sitting
// on its own frequency and leans only when the collision pass has pushed that
// readout off it — iOS's convention, where the stem always starts at
// `targets[i]` no matter where the label was relaxed to.
//
// Both x's are set declaratively (they change only on re-render, with the
// readout's own layout); the per-frame write is the foot alone, which rides
// the eased curve as the field morphs.
function _updateHzStems(stemEls) {
  for (let i = 0; i < stemEls.length; i++) {
    const el = stemEls[i];
    if (!el) continue;
    const freqX = parseFloat(el.getAttribute('x2'));
    if (!(freqX >= 0)) continue;
    el.setAttribute('y2', _hzStemFootY(freqX).toFixed(2));
  }
}
// Foot of the readout stem: the curve surface at this x — the same point
// _updatePositionLines runs the voice's marker up to.
function _hzStemFootY(freqX) {
  return _curveSurfaceAtX(freqX);
}

// Played-note lines are the position line's LOWER segment: from the base of the
// spectrum straight up to the live curve surface at that pitch. A note has no
// orb, so there's no upper segment — the line simply stops where a drone's
// would turn to meet its orb, and a dot caps the base. Geometry is imperative
// for the same reason the position lines are: the top endpoint rides the eased
// curve, which morphs every frame.
//
// Each note's whole group is translated to its x, so the per-frame write is one
// transform plus one endpoint — the line and its dot stay glued without
// recomputing either. `voices` may name an id whose element hasn't mounted yet
// (the poll updates its ref before React flushes the new line); it's skipped
// and picked up next frame.
function _updateNoteLines(noteEls, voices, range, barWidth) {
  for (const v of voices) {
    const els = noteEls.get(v.id);
    if (!els || !els.line) continue;
    const x = BAR_H_PADDING + freqToFraction(v.hz, range.logMin, range.logMax) * barWidth;
    const surfaceY = _curveSurfaceY(_levelAtBarX(x - BAR_H_PADDING));
    els.g.setAttribute('transform', `translate(${x.toFixed(2)},0)`);
    els.line.setAttribute('y1', surfaceY.toFixed(2));
  }
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

// (ghostOffset — the fan ring that arranged N grab ghosts around one cursor —
// retired 2026-08-04 with the anchor+delta grab: each held orb keeps its own
// resting spacing and moves by the cursor's travel, so nothing stacks.)

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
// visible orbs aside instead of stacking under them. Indices in
// `excluded` (confirmed drags) sit the pass out entirely — a finger-held
// orb must neither shove its neighbors nor be shoved (iOS parity) — and
// keep their raw target x.
function resolveCollisions(targetsPx, dotSize, excluded) {
  const minGap = dotSize * 0.85;
  const resolved = [...targetsPx];
  if (resolved.length < 2) return resolved;

  for (let iter = 0; iter < 20; iter++) {
    const sorted = resolved
      .map((_, i) => i)
      .filter((i) => !excluded?.has(i))
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

// Width-aware sibling of the orb pass, for the above-bar Hz readouts (iOS
// resolveCollisions(targets:widths:padding:excluded:)). Each label claims its
// own horizontal extent, so a wide "1318.50" pushes its neighbors further than
// a narrow "82.40" does. Sorted once by TRUE position, then adjacent
// overlapping pairs are pushed apart symmetrically until every center distance
// clears the two half-widths plus `padding`.
// `excluded` labels (muted voices, and any whose readout has left the strip to
// ride a raised orb) sit the pass out entirely: they neither shove a neighbor
// nor get shoved, and keep their raw target — so the row doesn't jump when one
// fades out.
function resolveLabelCollisions(targets, widths, padding, excluded) {
  const resolved = [...targets];
  if (resolved.length < 2) return resolved;
  const sorted = targets
    .map((_, i) => i)
    .filter((i) => !excluded?.has(i))
    .sort((a, b) => targets[a] - targets[b]);
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const minGap = (widths[a] + widths[b]) / 2 + padding;
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

// Rendered width of a readout, for that pass (iOS's hzLabelWidth). Measured on
// a canvas in the float's exact CSS font rather than estimated per character —
// the monospace stack resolves to a different face on every platform.
let _hzMeasureCtx = null;
function _hzLabelWidth(text) {
  if (!_hzMeasureCtx) {
    _hzMeasureCtx = document.createElement('canvas').getContext('2d');
    _hzMeasureCtx.font =
      `800 ${FLIPPED_HZ_FLOAT_H}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    // Setting `font` resets spacing, so this has to follow it.
    if ('letterSpacing' in _hzMeasureCtx) _hzMeasureCtx.letterSpacing = '-0.3px';
  }
  return _hzMeasureCtx.measureText(text).width;
}
// Air the collision pass keeps between neighboring readouts (iOS hzLabelGap).
const HZ_FLOAT_GAP = 6;

function FrequencySpectrumBar({
  oscillatorCount = 4,
  fineTuneEnabled = false,
  // 'linear' | 'precision' | 'ios' | 'zoom' — see the Orb-DRAG vertical axis
  // notes up top.
  orbDragMode = 'linear',
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
  // iOS-style flipped layout (settings → "orb row"): orbs hang below the
  // spectrum on short arms, number under each orb, drag Hz readout on top.
  // Below is the default layout; "above spectrum" is the opt-in classic look.
  orbsBelow = true,
  // Settings → "Pan dots": pin the rim indicator on every orb full-time,
  // tracking the live pan (iOS panDotAlwaysOn). Off, the indicator only
  // appears during a pan flash. The text readout keeps flashing either way.
  panDots = true,
  // The console's lifted selection (a voice index, 'all', or null — the
  // frequency panel's subject). That voice's orb wears a white ring, the
  // orb-row counterpart of the note cell's corner brackets.
  selectedVoice = null,
}) {
  // Subscribe to theme changes so JSX re-renders when the user flips
  // palette in settings — every osc-color lookup below reads live from
  // the palette singleton.
  useTheme();
  // Mode-dependent row geometry. Also published to the module-level GEO so
  // the rAF draw helpers (position lines, curve surface) read the same
  // layout — safe because the app mounts a single spectrum bar. Declared
  // BEFORE the draw-loop effects below so the publish runs first on mount.
  const geo = useMemo(() => geometryFor(!!orbsBelow), [orbsBelow]);
  useEffect(() => { GEO = geo; }, [geo]);
  const [barWidth, setBarWidth] = useState(500 - 2 * BAR_H_PADDING);
  const [frequencies, setFrequencies] = useState(() => Array(oscillatorCount).fill(440));
  const [muted, setMuted] = useState(() => Array(oscillatorCount).fill(false));
  const [draggingDots, setDraggingDots] = useState(() => new Set());
  const [globalOrbDragging, setGlobalOrbDragging] = useState(false);
  const [grabbedOscs, setGrabbedOscs] = useState(() => new Set());
  // Live pointer-drag positions for the REAL orbs (no ghost — the orb itself
  // rides the finger, iOS parity). Container-local center coords, anchored at
  // the orb's rendered position on touch-down plus the total pointer delta.
  // `confirmed` mirrors dragRef's didDrag so a mere tap never pulls the orb
  // out of the collision pass.
  const [dragOrbs, setDragOrbs] = useState({}); // { [pointerId]: { index, x, y, edgeRate, confirmed } }
  // Voices whose orb is currently dragged ABOVE the spectrum bar (flipped
  // layout only) — iOS's orbsAboveBar. Toggled with ±3px hysteresis around
  // the bar's bottom edge so the label swap doesn't flicker at the crossing;
  // cleared on release. Drives the drag Hz readout detaching from the top
  // strip to glue itself above the raised orb.
  const [orbsAbove, setOrbsAbove] = useState(() => new Set());
  // Indices mid release-settle: the .settling class transitions left/top from
  // the finger back to the resolved spot for ~0.4s (approximating the iOS
  // release spring), then a timer removes it so live position updates from
  // the rAF zoom loop stay instant.
  const [settlingDots, setSettlingDots] = useState(() => new Set());
  const settleTimersRef = useRef(new Map()); // index → timeout id
  // Zoom-mode release settle, driven per-frame in JS instead of the CSS
  // .settling transition: the frame eases home at the same time, so the
  // orb's target (its marker) MOVES every frame — a CSS left/top transition
  // retargeting against that read as the orb falling away to the zoomed-out
  // spot (the round-3 bug the old freeze-then-ease hold worked around).
  // Instead the orb renders at marker(current frame) + offset·frac, where
  // offset is the finger→marker gap at release and frac decays 1→0 on the
  // same overshoot curve as the CSS settle — the orb rides its marker home
  // while closing the gap, one continuous motion. State mirrors
  // zoomSettleRef (the loop's source of truth: index → {dx, dy, t0}) as
  // index → {dx, dy, frac} for the renderers.
  const [zoomSettle, setZoomSettle] = useState(() => new Map());
  const zoomSettleRef = useRef(new Map());
  const [grabCursor, setGrabCursor] = useState(null); // { x, y } in container coords while grabbed
  // Per-grabbed-orb anchor, all in container coords: where the orb was placed
  // when the gesture took hold (ax, ay) and where the cursor was at that
  // moment (sx, sy). The orb renders at anchor + (cursor − start), the same
  // rule `dragRef` carries for a pointer drag; only the anchor differs — a
  // drag anchors on the ORB (the finger is already on it), a grab anchors on
  // the CURSOR at grab time (Dan, 2026-08-04: the orb meets the mouse the
  // moment the number is pressed, no motion required, no formation offset —
  // so ax==sx and every grabbed orb sits exactly ON the cursor). Absent =
  // grabbed before the cursor was ever seen; the pointermove handler anchors
  // it on the first move instead.
  const [grabAnchors, setGrabAnchors] = useState({});
  const grabAnchorsRef = useRef(grabAnchors);
  const [range, setRange] = useState({ logMin: ABSOLUTE_LOG_MIN, logMax: ABSOLUTE_LOG_MAX });
  const [shiftHeld, setShiftHeld] = useState(false);
  // Global transpose (semitones) — mirrored from the engine so the moving
  // frequency labels re-render. The engine owns the value (it persists to
  // localStorage and applies the playback multiplier); this is a read-only
  // reflection driving the tick relabel. Subscribed below.
  const [transpose, setTranspose] = useState(() => audioEngine.getTransposeSemitones());
  const transposeDragRef = useRef(null);
  // ── Orb status flash (pan / detune) ──
  // Adjusting a per-voice parameter shows its status on ALL orbs, holds
  // 1.5 s past the last change, then fades back to the normal orb look.
  // One flash at a time — a new param takes over the display. `values`
  // snapshots per-voice on every event so the display tracks a live drag;
  // `active` is the voice being edited ('all' for global edits like the
  // ALL panel's ZERO/RANDOM) — only edited voices swap their number for
  // the text readout, the others keep their numbers and just show the
  // indicator; `leaving` drives the fade-out class.
  //   pan     values[i] ∈ [−1, 1]; indicator dot at pan×90° (0 = top).
  //   detune  values[i] = effective Hz (curve × ceiling × panWidth); TWO
  //           radial tick lines at ±(d/max)×90° — coincident at 12
  //           o'clock when clean, spread to the 9/3 horizons at full.
  const [statusFlash, setStatusFlash] = useState(null); // { param, values, active, leaving }
  const statusFlashTimersRef = useRef({ hold: 0, leave: 0 });
  // Live per-voice pans, mirrored from the engine for the PINNED rim dots
  // (Settings → "Pan dots" / iOS panDotAlwaysOn). Refreshed on every pan
  // event — the cadence the flash already re-renders at — so the dots track
  // a dial drag; the flash's own `values` stay an event-time snapshot.
  // A slot added since the last event isn't in the array yet — the render
  // falls back to the engine for those (no resync effect needed).
  const [voicePans, setVoicePans] = useState(() => audioEngine.getVoicePans());
  useEffect(() => {
    const timers = statusFlashTimersRef.current;
    const show = (param, values, active) => {
      clearTimeout(timers.hold);
      clearTimeout(timers.leave);
      setStatusFlash({ param, values, active, leaving: false });
      timers.hold = setTimeout(() => {
        setStatusFlash((prev) => (prev ? { ...prev, leaving: true } : prev));
        timers.leave = setTimeout(() => setStatusFlash(null), STATUS_FLASH_FADE_MS);
      }, STATUS_FLASH_HOLD_MS);
    };
    // Pan events arrive once PER VOICE. A dial drag is a lone event, but
    // global actions (the mixer/settings stereo-mode toggle, the tray
    // reset) loop over every voice synchronously — taking the last event's
    // index would crown one arbitrary orb as "edited" and only IT would
    // get the text readout. Coalesce each synchronous burst in a
    // microtask: multiple distinct voices → a global edit (active 'all',
    // every orb shows its readout), a single voice → that dial's drag.
    const pendingPan = { indices: new Set(), queued: false, disposed: false };
    const offPan = audioEngine.addPanListener((index) => {
      pendingPan.indices.add(index);
      if (pendingPan.queued) return;
      pendingPan.queued = true;
      queueMicrotask(() => {
        pendingPan.queued = false;
        const [first] = pendingPan.indices;
        const active = pendingPan.indices.size > 1 ? 'all' : first;
        pendingPan.indices.clear();
        if (pendingPan.disposed) return;
        const pans = audioEngine.getVoicePans();
        // Same array feeds the transient flash and the pinned dots — the
        // flash keeps it as its snapshot, the dots re-read it each event.
        setVoicePans(pans);
        show('pan', pans, active);
      });
    });
    // Detune flash: curve edits ('curve', with the slot index when a
    // single node/panel slider is dragged). The old 'detune' kind is
    // gone with the master ceiling slider. Structural curve events (slot
    // add/remove) stay silent. Mode-blind engine: the effective spread
    // is the nominal curve narrowed by each voice's pan width, so
    // hard-panned voices (the L/R preset's origin) show 0 — the
    // statusReadoutShown suppression below keeps those quiet.
    const offDetune = droneStereo.onChange((sm, info) => {
      if (!info || info.structural) return;
      if (info.kind !== 'curve') return;
      const values = audioEngine.getVoicePans()
        .map((pan, i) => sm.nominalDetuneHzAt(i) * panWidth(pan));
      show('detune', values, info.index ?? 'all');
    });
    return () => {
      pendingPan.disposed = true;
      offPan();
      offDetune();
      clearTimeout(timers.hold);
      clearTimeout(timers.leave);
    };
  }, []);
  // Whether voice i's readout text is actually visible during the current
  // flash: it must be an edited voice AND its value must be off-rest (a
  // centered pan / zero detune suppresses the text — the indicator alone
  // tells the story). The voice number only hides when this is true, so a
  // suppressed readout never leaves a blank above the orb (mode-toggle pan
  // resets land on center; RANDOM curves can roll near-zero slots).
  const statusReadoutShown = (i) => {
    if (!statusFlash) return false;
    if (statusFlash.active !== i && statusFlash.active !== 'all') return false;
    const v = statusFlash.values[i] ?? 0;
    return statusFlash.param === 'pan' ? Math.abs(v) >= 0.005 : v >= 0.05;
  };
  // Launch state for a *staged* save slot (targets + which voices are
  // mid-glide + which have fired), or null when nothing is staged. Driven by
  // the frequencyManager singleton but re-read only when its stageVersion
  // changes — NOT on every frequency event — so drags don't churn it. The
  // per-frame descent animation instead rides the component's normal
  // re-renders (the `frequencies` state updates each glide frame).
  const [stageState, setStageState] = useState(() => frequencyManager.getLaunchState());
  // Time-based fade-in (0→1 over STAGE_FADE_MS) applied on top of the per-voice
  // distance fade, so the dots/lines ease in when a slot is staged instead of
  // popping to full opacity.
  const [stageFade, setStageFade] = useState(1);
  const stageFadeRef = useRef({ raf: 0, start: 0, slotId: frequencyManager.stagedSlotId });
  // The staged triangles/dots are a FREQUENCY affordance — hide them entirely
  // when frequency isn't in the recall scope (volume/on-off recall silently).
  const showFreqMarkers = frequencyManager.getRecallScope().includes('freq');
  useEffect(() => {
    let lastVersion = frequencyManager.stageVersion;
    const sync = () => {
      const v = frequencyManager.stageVersion;
      if (v === lastVersion) return;
      lastVersion = v;
      setStageState(frequencyManager.getLaunchState());
      // When the staged slot changes, restart the ease-in.
      const slotId = frequencyManager.stagedSlotId;
      const sf = stageFadeRef.current;
      if (slotId !== sf.slotId) {
        sf.slotId = slotId;
        if (sf.raf) { cancelAnimationFrame(sf.raf); sf.raf = 0; }
        if (slotId == null) { setStageFade(1); return; }  // released — markers unmount
        sf.start = 0;
        setStageFade(0);
        const tick = (t) => {
          if (!sf.start) sf.start = t;
          const p = Math.min(1, (t - sf.start) / STAGE_FADE_MS);
          setStageFade(p);
          sf.raf = p < 1 ? requestAnimationFrame(tick) : 0;
        };
        sf.raf = requestAnimationFrame(tick);
      }
    };
    sync();
    const off = frequencyManager.onChange(sync);
    return () => { off(); if (stageFadeRef.current.raf) cancelAnimationFrame(stageFadeRef.current.raf); };
  }, []);
  // Step-transition ceremony: while a step tail is live the ORB holds its
  // old pitch on screen (the engine is already sounding the target
  // underneath) and the staged dot descends at the target on the step-time
  // clock; when it lands the orb relocates to it — the dot IS the incoming
  // note. When the window closes the orb doesn't teleport — it HOPS over to
  // the landed dot with a smooth 200 ms ease-in-out slide (STEP_HOP_MS).
  // stepAnims maps slot → { gen, freq: heldHz, p: 0..1 descent } during the
  // window (with `hp` joining STEP_HOP_LEAD_MS before the dot lands so the
  // orb meets it on arrival), then hop-only until the slide completes.
  // Driven by its own rAF loop because nothing else re-renders during the
  // window (frequencies jumped once at step time and then sit still). Both
  // phases derive statelessly from the engine's viz tails, which linger a
  // grace period past their audible window — so even a 0 ms handoff (whose
  // audible window never spans a frame) still gets its hop.
  const [stepAnims, setStepAnims] = useState({});
  const draggingDotsRef = useRef(draggingDots);
  useEffect(() => { draggingDotsRef.current = draggingDots; }, [draggingDots]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = 0;
      const tails = audioEngine.getStepTailsViz();
      // A slot being dragged follows the live engine pitch immediately —
      // holding or hopping the display would make the drag feel stuck.
      const dragged = draggingDotsRef.current;
      const now = performance.now();
      const next = {};
      for (const tail of tails) {
        if (dragged.has(tail.slot)) continue;
        const cur = next[tail.slot];
        if (cur && cur.gen > tail.gen) continue; // newest re-step wins
        // Descent progress (the falling dot) and hop progress (the sliding
        // orb) OVERLAP during the lead-in: the hop starts STEP_HOP_LEAD_MS
        // before the dot lands so the orb meets it on arrival.
        const dur = Math.max(1, tail.until - tail.startMs);
        const p = Math.min(1, (now - tail.startMs) / dur);
        const hopStart = stepHopStart(tail);
        const hp = now >= hopStart ? (now - hopStart) / STEP_HOP_MS : null;
        if (hp != null && hp >= 1) continue; // ceremony fully played out
        next[tail.slot] = { gen: tail.gen, freq: tail.freq, p, hp };
      }
      if (!Object.keys(next).length) {
        setStepAnims((prev) => (Object.keys(prev).length ? {} : prev));
        return;
      }
      setStepAnims(next);
      raf = requestAnimationFrame(tick);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    kick();
    const off = frequencyManager.onChange(kick);
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, []);
  const [activeOrder, setActiveOrder] = useState([]); // indices sorted by first-activation

  const containerRef = useRef(null);
  const dragRef = useRef({});
  // Refs to each orb / label DOM element so the keyboard-voice rAF loop
  // can flip a `kbd-active` class and toggle bubble states without
  // round-tripping through React state.
  const dotElsRef = useRef([]);
  const labelElsRef = useRef([]);
  // Per-slot "same-octave played" dots floating above each orb (see
  // geo.kbdDotCenterY). Toggled `.active` by the keyboard-glow rAF loop.
  const kbdDotElsRef = useRef([]);
  const rangeRef = useRef(range);
  const barWidthRef = useRef(barWidth);
  const grabbedRef = useRef(grabbedOscs);
  const fineTuneRef = useRef(fineTuneEnabled);
  const orbDragModeRef = useRef(orbDragMode);
  const shiftRef = useRef(shiftHeld);

  // Keep the local transpose readout in sync with the engine (covers the
  // persisted value applied at boot and any programmatic change).
  useEffect(() => audioEngine.addTransposeListener(
    () => setTranspose(audioEngine.getTransposeSemitones())
  ), []);

  // Is the pointer over the draggable number strip (the frequency-label band,
  // up to the top of the dissonance curve)? Container-local Y test so orbs —
  // which float outside this band — and the spectrogram below are never grabbed.
  const inTransposeZone = (clientY) => {
    const el = containerRef.current;
    if (!el) return false;
    const y = clientY - el.getBoundingClientRect().top;
    return y >= geo.transposeZoneTop && y <= geo.transposeZoneBottom;
  };
  // Number-strip drag → global transpose. Orbs stopPropagation on pointerdown,
  // so any press reaching the container is background; we further gate on the
  // strip band. Driven off window listeners (not pointer capture) so it never
  // fights the orb/grab gestures; persists once on release to avoid thrash.
  const beginTransposeDrag = (e) => {
    if (e.button !== 0) return;
    if (e.target?.closest?.('.fsb-dot')) return;
    if (!inTransposeZone(e.clientY)) return;
    e.preventDefault();
    const el = containerRef.current;
    if (el) el.style.cursor = 'grabbing';
    // Accumulate per-move deltas (not total-from-start) so toggling Shift
    // mid-drag only changes the rate going forward — no jump.
    transposeDragRef.current = { x: e.clientX, semi: audioEngine.getTransposeSemitones() };
    const move = (ev) => {
      const s = transposeDragRef.current;
      if (!s) return;
      const dx = ev.clientX - s.x;
      s.x = ev.clientX;
      const fine = (shiftRef.current || fineTuneRef.current) ? TRANSPOSE_FINE_SCALE : 1;
      s.semi += dx * TRANSPOSE_SEMI_PER_PX * fine * TRANSPOSE_DRAG_SIGN;
      audioEngine.setTransposeSemitones(s.semi, { persist: false });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      transposeDragRef.current = null;
      if (el) el.style.cursor = '';
      audioEngine.setTransposeSemitones(audioEngine.getTransposeSemitones()); // persist final
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Double-click the number strip → reset transpose to 0.
  const resetTranspose = (e) => {
    if (e.target?.closest?.('.fsb-dot')) return;
    if (!inTransposeZone(e.clientY)) return;
    audioEngine.setTransposeSemitones(0);
  };
  // Cursor hint: ew-resize only while hovering the draggable number strip.
  const updateTransposeCursor = (e) => {
    const el = containerRef.current;
    if (!el || transposeDragRef.current) return; // an active drag keeps 'grabbing'
    el.style.cursor = inTransposeZone(e.clientY) ? 'ew-resize' : '';
  };
  const lastGrabXRef = useRef(null); // tracks cursor X between grab-driven frames
  const lastGrabYRef = useRef(null); // tracks cursor Y between grab-driven frames (volume)
  const mousePosRef = useRef(null); // latest client-space cursor; null until the first pointermove
  const grabEdgeRateRef = useRef(0); // octaves/sec drift for grabbed oscs, set from cursor X
  const lastEdgePanTimeRef = useRef(null); // performance.now() of previous edge-pan tick
  // Auto-zoom loop is demand-driven; pointer handlers that enter the
  // edge-pan state without immediately mutating engine freqs (which would
  // wake via addFrequencyListener) call wakeRef.current() to start it.
  const wakeRef = useRef(null);
  // Sounding keyboard/MIDI notes, in NOMINAL Hz. `noteLines` drives the SVG
  // (changes only on note on/off); noteVoicesRef is the same set read by the
  // per-frame draw and zoom loops, which can't close over state; noteElsRef
  // maps voice id → its elements, for the amp→opacity write (on the group, so
  // the stem and its dot fade together) and the stem's curve-riding endpoint.
  const [noteLines, setNoteLines] = useState([]);
  const noteVoicesRef = useRef([]);
  const noteElsRef = useRef(new Map());
  // Dissonance HUD canvas + its rAF-driving refs. draggingRef mirrors the
  // dragging set so the per-frame draw loop can read it without restarting.
  const dissCanvasRef = useRef(null);
  const draggingRef = useRef(draggingDots);
  // Per-voice position lines (orb → curve surface → bar bottom) updated
  // imperatively each frame, plus refs caching the current orb x-positions the
  // draw loop reads.
  const posLineRefs = useRef([]);
  // Flipped-layout drag-readout stems (top strip → curve surface), same
  // per-frame treatment as the position lines they land on.
  const hzStemRefs = useRef([]);
  const dotXsRef = useRef([]);
  const freqXsRef = useRef([]);
  const edgeFadesRef = useRef([]);
  // Mirrors of dragPosByIndex / settlingDots for the per-frame stem drawer,
  // which can't close over state.
  const dragPosRef = useRef(new Map());
  const settlingRef = useRef(new Set());

  useEffect(() => { barWidthRef.current = barWidth; }, [barWidth]);
  useEffect(() => { grabbedRef.current = grabbedOscs; }, [grabbedOscs]);
  useEffect(() => { grabAnchorsRef.current = grabAnchors; }, [grabAnchors]);
  useEffect(() => { draggingRef.current = draggingDots; }, [draggingDots]);
  useEffect(() => { fineTuneRef.current = fineTuneEnabled; }, [fineTuneEnabled]);
  useEffect(() => { orbDragModeRef.current = orbDragMode; }, [orbDragMode]);
  useEffect(() => { shiftRef.current = shiftHeld; }, [shiftHeld]);

  // Dissonance HUD: the consonance hot-spot field behind the orbs, drawn
  // continuously (always shown) so it maps the current chord even at rest.
  // Redraws every frame off live refs so auto-zoom / edge-pan stay aligned and
  // playing notes update it live. The displayed field includes the moving
  // voice(s) scaled by the "Moving voice impact" setting; the drag damping
  // always excludes them.
  useEffect(() => {
    let raf = null;
    // One thrown frame used to kill this loop FOREVER: the re-arm sat at the
    // end of the body, so an exception skipped it and the curve, the position
    // lines, the readout stems and the note lines all froze at their last
    // values — with the orbs and the auto-zoom still live, which reads as
    // "the spectrum stopped following the frequencies" (observed once while
    // drag-testing, 2026-08-04; the throwing statement is NOT identified).
    // The re-arm now lives in `finally` so a bad frame costs one frame, and
    // the first failure is reported instead of vanishing.
    let loggedDrawError = false;
    // The field recompute (_buildBackground + _drawDissonanceCurve — the
    // pairDissonance sweep across every curve column) is the most expensive
    // continuously running CPU work in the app, and its output is temporally
    // eased anyway, so it runs at half the loop rate. The cheap DOM updates
    // below (position lines, stems, note lines) stay at full rate so drags
    // track the finger without lag.
    let fieldTick = 0;
    const drawFrame = () => {
      fieldTick ^= 1;
      const c = dissCanvasRef.current;
      if (c && fieldTick === 0) {
        // Assumed spectral profile (timbreProfiles) — DECOUPLED from the synth
        // so it's correct for MIDI-out and inharmonic timbres. All voices and
        // the probe share it for now. Read each frame so a live timbre swap
        // (e.g. __dissTimbre('bell')) reshapes the field immediately.
        const profile = activeProfile();
        const movingSet = new Set([...draggingRef.current, ...grabbedRef.current]);
        // A lone active voice drives the curve at full impact — at the reduced
        // slider impact with nothing else sounding the curve would near-vanish.
        const impact = _activeVoiceCount(oscillatorCount) <= 1 ? 1 : getMovingImpact();
        // When paused, force an empty field so the line eases down to flat zero.
        const { parts, voices } = audioEngine.paused
          ? { parts: [], voices: 0 }
          : _buildBackground(oscillatorCount, movingSet, impact, profile);
        const r = rangeRef.current;
        const bw = barWidthRef.current;
        _drawDissonanceCurve(c, r, bw, parts, profile, voices);
      }
      // Position lines (orb → live curve surface → bar bottom) are owned by the
      // SVG layer; their top endpoint reads the curve levels the draw just eased.
      // Dragged orbs override their endpoint with the finger position; orbs
      // mid release-settle override with their CSS-transitioned rendered
      // position so the stem rides the orb home instead of snapping ahead.
      let dragPos = dragPosRef.current;
      if (settlingRef.current.size) {
        const crect = containerRef.current?.getBoundingClientRect();
        if (crect) {
          dragPos = new Map(dragPos);
          for (const i of settlingRef.current) {
            if (dragPos.has(i)) continue;
            const el = dotElsRef.current[i];
            if (!el) continue;
            const r = el.getBoundingClientRect();
            dragPos.set(i, {
              x: r.left + r.width / 2 - crect.left,
              y: r.top + r.height / 2 - crect.top,
            });
          }
        }
      }
      _updatePositionLines(posLineRefs.current, dotXsRef.current, freqXsRef.current, dragPos, edgeFadesRef.current);
      // The drag readout's stem lands on that same curve surface, so its foot
      // rides the eased levels too (only mounted in the flipped layout).
      _updateHzStems(hzStemRefs.current);
      // Played-note stems ride the same freshly-eased curve.
      _updateNoteLines(
        noteElsRef.current, noteVoicesRef.current, rangeRef.current, barWidthRef.current,
      );
    };
    // 60 fps cap: on ProMotion phones rAF fires at 120 Hz, doubling the
    // HUD's per-frame cost for no visible gain (the field is eased and the
    // stems track sub-frame anyway). 1.5 ms tolerance so real 60 Hz
    // displays don't drop frames to timer jitter.
    const FRAME_MIN_MS = 1000 / 60 - 1.5;
    let lastTs = 0;
    const draw = (ts) => {
      const now = typeof ts === 'number' ? ts : performance.now();
      if (now - lastTs < FRAME_MIN_MS) {
        raf = requestAnimationFrame(draw);
        return;
      }
      lastTs = now;
      try {
        drawFrame();
      } catch (err) {
        if (!loggedDrawError) {
          loggedDrawError = true;
          console.error('[FrequencySpectrumBar] draw frame threw (loop kept alive):', err);
        }
      } finally {
        raf = requestAnimationFrame(draw);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [oscillatorCount]);

  // Keyboard-voice glow loop. Each frame: ask the voice manager which
  // voices are sounding, group them by drone slot (via tuning), and
  // imperatively update its indicators. A note at the slot's EXACT octave
  // shows a dot floating above the orb (kbdDot `.active`) rather than
  // glowing the orb — a played drone and a played key were otherwise
  // indistinguishable. Notes an octave or more away glow the orb + label
  // (`kbd-active`) and light small bubbles flanking the label (IG-photo
  // style — far-octave lit while the in-between bubble stays dim if
  // there's nothing playing closer in).
  //
  // Direct DOM mutation rather than React state because envelope amps
  // change every audio block and a setState rerender on each tick would
  // thrash the spectrum bar's draggable elements.
  useEffect(() => {
    const ACTIVE_THRESHOLD = 0.05; // env amp below this counts as silent
    let raf = null;
    // Octave-bubble element lookup cache: label element → { '+1': el, … }.
    // The loop previously ran `label.querySelector('[data-octave=…]')` for
    // every bubble of every slot every frame (MAX_OCT × 2 sides × N slots =
    // up to 120 live selector queries per frame). The bubbles are static
    // children of the label, so one lookup per label lifetime suffices;
    // the WeakMap drops entries automatically when labels unmount.
    const bubbleCache = new WeakMap();
    const bubblesFor = (label) => {
      let map = bubbleCache.get(label);
      if (!map) {
        map = {};
        for (const el of label.querySelectorAll('[data-octave]')) {
          map[el.dataset.octave] = el;
        }
        bubbleCache.set(label, map);
      }
      return map;
    };
    // 30 Hz is plenty for this loop — everything it writes is a binary
    // class / attribute state, not a tweened value, and running at rAF
    // rate (120 Hz on ProMotion phones) just multiplies the per-frame
    // getActiveVoices() allocation churn and DOM writes.
    const GLOW_MIN_MS = 1000 / 30 - 1.5;
    let lastTs = 0;
    const tick = (ts) => {
      const now = typeof ts === 'number' ? ts : performance.now();
      if (now - lastTs < GLOW_MIN_MS) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastTs = now;
      const voices = keyboardVoiceManager.getActiveVoices();
      // Pending note marks from the staged save's held-note diff — the
      // outline language: a HOLLOW dot/bubble marks an octave where a saved
      // note will attack on GO/transition, a RING around a lit one marks a
      // sounding note that will release. slot → Map(octave → 'on'|'off').
      const marks = frequencyManager.getStagedNoteMarks();
      const pendBySlot = new Map();
      if (marks) {
        const put = (arr, dir) => {
          for (const m of arr) {
            let om = pendBySlot.get(m.slot);
            if (!om) { om = new Map(); pendBySlot.set(m.slot, om); }
            // A swap (release + attack at the same octave) reads as arrival.
            if (!(dir === 'off' && om.get(m.octave) === 'on')) om.set(m.octave, dir);
          }
        };
        put(marks.off, 'off');
        put(marks.on, 'on');
      }
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
      const kbdDots = kbdDotElsRef.current;
      const totalSlots = Math.max(dots.length, labels.length);
      const MAX_OCT = 5;

      for (let i = 0; i < totalSlots; i++) {
        const octs = slotOctAmps.get(i);

        // Split this slot's sounding octaves into the EXACT-pitch octave (0)
        // and everything else. Octave 0 drives the dot-above-orb; non-zero
        // octaves glow the orb + label and light the bubble columns. Keeping
        // them separate means a keyboard note at the drone's own pitch shows
        // the floating dot instead of lighting the orb (which reads the same
        // as a normally-playing drone).
        let zeroAmp = 0;
        let nonZeroAmp = 0;
        if (octs) {
          for (const [oct, a] of octs) {
            if (oct === 0) { if (a > zeroAmp) zeroAmp = a; }
            else if (a > nonZeroAmp) nonZeroAmp = a;
          }
        }
        const zeroActive = zeroAmp > ACTIVE_THRESHOLD;
        const nonZeroActive = nonZeroAmp > ACTIVE_THRESHOLD;

        // Skip while user is actively dragging/grabbing — those states
        // have their own dim styling and shouldn't flicker on retrigger.
        const dot = dots[i];
        const interacting = dot
          ? dot.classList.contains('dragging') || dot.classList.contains('grabbed')
          : false;
        // Orb glow: OTHER-octave notes only now (the same-octave case is the
        // dot-above below, so a played drone isn't confused with a played key).
        if (dot) {
          dot.classList.toggle('kbd-active', !interacting && nonZeroActive);
          // No release-tail state on the orb: a muted slot reads as muted
          // immediately, even while its envelope release is still sounding.
        }

        // Same-octave dot floating above the orb. Hidden during interaction.
        const kbdDot = kbdDots[i];
        const pend = pendBySlot.get(i);
        if (kbdDot) {
          kbdDot.classList.toggle('active', !interacting && zeroActive);
          const p0 = pend ? pend.get(0) : undefined;
          kbdDot.classList.toggle('pending-on', p0 === 'on');
          kbdDot.classList.toggle('pending-off', p0 === 'off');
        }

        const label = labels[i];
        if (!label) continue;
        label.classList.toggle('kbd-active', zeroActive || nonZeroActive);

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
          const bubbles = bubblesFor(label);
          for (let n = 1; n <= MAX_OCT; n++) {
            const oct = sign * n;
            const sel = oct > 0 ? `+${oct}` : `${oct}`;
            const el = bubbles[sel];
            if (!el) continue;
            const nextState = active[n] ? 'on' : (n < maxActive ? 'dim' : '');
            // Guard the writes — an unconditional dataset assignment dirties
            // style on every bubble every tick even when nothing changed.
            if (el.dataset.state !== nextState) el.dataset.state = nextState;
            // Pending on/off preview rides an independent attribute so it
            // composes with (never falsifies) the live state.
            const p = (pend ? pend.get(oct) : undefined) || '';
            if ((el.dataset.pending || '') !== p) el.dataset.pending = p;
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

  // Played-note poll. Collects every sounding keyboard/MIDI voice as a NOMINAL
  // frequency — detune AND transpose divided back out — because that's the
  // space the orbs and the zoom range live in. A note played at an orb's pitch
  // then lands exactly on that orb, and transposing slides the tick labels
  // without dragging the note stems across them.
  //
  // Nominal has to come from getHeldNotesLive, NOT getActiveVoices().freq: that
  // one is the SOUNDING pitch, which carries the voice's detune (and in stereo
  // is just the L side of a pair straddling the orb). Drawing it puts the stem
  // sharp of its own orb — and because detune is a fixed Hz offset, that error
  // grows without bound in cents as pitch falls: ~1.5 cents at 60 Hz becomes
  // ~6 at 28 Hz, and further with the detune orb up.
  //
  // Two consumers, two update rates. The zoom loop and the SVG read the pitch
  // set, which only changes on note on/off (setState, coalesced by signature).
  // Opacity tracks the live envelope amp, which changes every audio block, so
  // it's written straight to the DOM — a setState per frame would rerender the
  // draggable orbs.
  useEffect(() => {
    let raf = null;
    let sig = '';
    // Last known nominal per voice id. getHeldNotesLive drops a voice the
    // instant it's released, but its stem lives on through the release tail —
    // and a released voice's pitch is frozen, so the last value stays true.
    const nominalById = new Map();
    // 30 Hz cap — stem opacity follows the envelope smoothly at 30 Hz, and
    // the loop otherwise allocates arrays + a signature string per tick
    // (120 of them per second on ProMotion) even when nothing is playing.
    const NOTE_MIN_MS = 1000 / 30 - 1.5;
    let lastTs = 0;
    const tick = (ts) => {
      const now = typeof ts === 'number' ? ts : performance.now();
      if (now - lastTs < NOTE_MIN_MS) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastTs = now;
      const voices = keyboardVoiceManager.getActiveVoices();
      // Idle fast path: nothing sounding and nothing displayed — skip the
      // signature build and DOM walk entirely (the common at-rest state).
      if (voices.length === 0 && sig === '' && nominalById.size === 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const ratio = audioEngine.getTransposeRatio() || 1;
      for (const h of keyboardVoiceManager.getHeldNotesLive()) nominalById.set(h.id, h.hz);
      const next = [];
      const logs = [];
      for (const v of voices) {
        if (!(v.freq > 0) || v.amp < NOTE_AMP_THRESHOLD) continue;
        // Fallback covers only a voice already releasing when we first saw it
        // (mount mid-tail) — sharp by the detune, but fading out anyway.
        const hz = nominalById.get(v.id) ?? v.freq / ratio;
        const log = Math.log2(hz);
        // Same pitch from two sources reads as one note on the bar.
        let dup = false;
        for (const l of logs) {
          if (Math.abs(l - log) < NOTE_DEDUPE_LOG) { dup = true; break; }
        }
        if (dup) continue;
        logs.push(log);
        next.push({ id: v.id, hz, slot: v.slot });
      }
      next.sort((a, b) => a.hz - b.hz);

      noteVoicesRef.current = next;
      const nextSig = next.map((n) => `${n.id}:${n.hz.toFixed(4)}`).join(',');
      if (nextSig !== sig) {
        sig = nextSig;
        setNoteLines(next);
        // The pitch set moved — kick the demand-driven zoom loop so it reframes.
        wakeRef.current?.();
      }

      for (const v of voices) {
        const els = noteElsRef.current.get(v.id);
        if (els) els.g.style.opacity = Math.min(1, v.amp / 0.5);
      }

      // Evict voices the manager has dropped entirely, so a long session's
      // note history can't accumulate in the cache.
      if (nominalById.size > voices.length) {
        const alive = new Set(voices.map((v) => v.id));
        for (const id of nominalById.keys()) if (!alive.has(id)) nominalById.delete(id);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
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
    let lastZoomMs = 0;           // timestamp of the previous zoom-ease step
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

            // Frame the current voices AND any staged targets, so a staged
            // save state's destination dots can't sit off-screen — the view
            // zooms out to include where the notes are heading. Only ACTIVE
            // voices count: targets for inactive voices beyond the current
            // count are hidden (Heuristic 1), so they mustn't pull the zoom.
            const staged = frequencyManager.getStagedFrequencies();
            const stagedActive = staged ? staged.slice(0, newFreqs.length) : null;
            // A step ceremony keeps the ORB at its old pitch, then hops it
            // over — frame the orb's DISPLAY pitch (held, then sliding along
            // the hop curve) so the zoom moves in lockstep with the orb
            // instead of waiting for the ceremony to finish.
            const nowP = performance.now();
            const tailFreqs = [];
            for (const tail of audioEngine.getStepTailsViz()) {
              if (tail.slot >= newFreqs.length) continue;
              const hz = stepTailDisplayHz(tail, newFreqs[tail.slot], nowP);
              if (hz != null) tailFreqs.push(hz);
            }
            let framed = newFreqs;
            if (stagedActive && stagedActive.length) framed = framed.concat(stagedActive);
            if (tailFreqs.length) framed = framed.concat(tailFreqs);
            // Sounding keyboard/MIDI notes pull the frame open too, so a note
            // played outside the drones' span zooms out to show both. Framing
            // exactly the set the note poll draws keeps the view honest: a
            // line is on screen for as long as it exists.
            const noteVoices = noteVoicesRef.current;
            if (noteVoices.length) framed = framed.concat(noteVoices.map((n) => n.hz));
            // Range ownership: a confirmed zoom-mode drag owns the frame —
            // its scaled span, anchored at the grab point — and the stock
            // voice-framing yields until release. With two simultaneous
            // zoom drags the first-started one steers (insertion order);
            // both still tune fine, sharing whatever span it sets. GRAB
            // moves (multi-voice transport) never take ownership.
            let zoomTarget = null;
            if (orbDragModeRef.current === 'zoom') {
              for (const pid in dragRef.current) {
                const d = dragRef.current[pid];
                if (d.didDrag) { zoomTarget = zoomDragTarget(d); break; }
              }
            }
            const target = zoomTarget ?? computeTargetRange(framed);
            // Tails expire silently (no engine event) — keep re-evaluating
            // while a ceremony is playing so the zoom-in starts on its own
            // the moment the hop completes.
            if (tailFreqs.length) {
              dirty = true;
              keepRunning = true;
            }
            const cur = rangeRef.current;
            // Frame-rate-independent ease: dt clamped so an idle gap (or the
            // first step of a fresh zoom) can't produce a big jump.
            const nowMs = performance.now();
            const dt = lastZoomMs === 0 ? 16 : Math.min(33, nowMs - lastZoomMs);
            lastZoomMs = nowMs;
            // While a zoom-mode drag owns the frame, apply its target
            // DIRECTLY — no ease (Dan, 2026-08-04: any animation between
            // levels while the finger is down reads as jitter; the view is
            // part of the gesture and must track it 1:1). The target itself
            // is continuous in pointer travel and anchored at the grab
            // point, so there is no step to smooth over. Release drops
            // ownership and the stock ease below carries the frame home.
            const k = zoomTarget ? 1 : 1 - Math.exp(-dt / ZOOM_TAU_MS);
            const nextMin = cur.logMin + (target.logMin - cur.logMin) * k;
            const nextMax = cur.logMax + (target.logMax - cur.logMax) * k;
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

      // Advance the zoom-mode release settle (see zoomSettleRef): decay each
      // orb's release offset along the overshoot curve and hand the renderers
      // the fraction. Runs every tick — the render this setState forces is
      // what moves the orb, and it composes with whatever the range ease
      // above did this same frame (both write in one React batch).
      if (zoomSettleRef.current.size) {
        const nowS = performance.now();
        const live = new Map();   // ref: keeps t0 for the next tick
        const frames = new Map(); // state: what this frame renders
        for (const [i, s] of zoomSettleRef.current) {
          const t = (nowS - s.t0) / ORB_SETTLE_MS;
          if (t >= 1) continue;
          live.set(i, s);
          frames.set(i, { dx: s.dx, dy: s.dy, frac: 1 - settleEase(t) });
        }
        zoomSettleRef.current = live;
        setZoomSettle(frames);
        if (live.size) keepRunning = true;
      }

      if (keepRunning) schedule();
    };

    const unsub = audioEngine.addFrequencyListener(wake);
    // Staging/launch changes should re-evaluate the zoom too (so newly staged
    // targets pull the frame open, and it eases back in once staging clears).
    const unsubStage = frequencyManager.onChange(wake);
    wakeRef.current = wake;
    schedule();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      unsub();
      unsubStage();
      wakeRef.current = null;
    };
  }, [oscillatorCount]);

  // Orb positions read DISPLAY frequencies: a slot mid-step-transition holds
  // its old pitch on screen until the descending dot lands (stepAnims above),
  // then slides to the live engine value with a smooth ease-in-out — the
  // interpolation runs in log2 (pitch) space, so the motion tracks the
  // bar's own axis.
  const displayFrequencies = useMemo(() => {
    const keys = Object.keys(stepAnims);
    if (!keys.length) return frequencies;
    const out = frequencies.slice();
    for (const k of keys) {
      const i = +k;
      if (i >= out.length) continue;
      const a = stepAnims[k];
      if (a.hp != null) {
        // Hop in progress (may start while the dot is still falling).
        const logFrom = Math.log2(Math.max(0.001, a.freq));
        const logTo = Math.log2(Math.max(0.001, out[i]));
        out[i] = Math.pow(2, logFrom + (logTo - logFrom) * easeHop(Math.min(1, a.hp)));
      } else {
        out[i] = a.freq; // held at the old pitch
      }
    }
    return out;
  }, [frequencies, stepAnims]);
  const freqXs = useMemo(
    () => displayFrequencies.map((f) => BAR_H_PADDING + freqToFraction(f, range.logMin, range.logMax) * barWidth),
    [displayFrequencies, barWidth, range.logMin, range.logMax]
  );
  // Confirmed drags sit out of the collision pass (a finger-held orb neither
  // shoves nor is shoved — iOS parity). Derived from dragOrbs' confirmed flag
  // rather than draggingDots so a mere tap-in-progress never reshuffles the row.
  // Grabbed orbs are out for the same reason: they're on the cursor, not in the
  // row, so their resting x has nothing to shove.
  const collisionExcluded = useMemo(() => {
    const s = new Set();
    for (const g of Object.values(dragOrbs)) if (g.confirmed) s.add(g.index);
    for (const i of grabbedOscs) s.add(i);
    return s;
  }, [dragOrbs, grabbedOscs]);
  const dotXs = useMemo(
    () => resolveCollisions(freqXs, DOT_SIZE, collisionExcluded),
    [freqXs, collisionExcluded]
  );
  // Continuous edge fade: 1 inside the row, ramping to 0 across EDGE_FADE_PX
  // past either edge. Every piece of a voice's chrome — orb, number label,
  // position line, Hz readout + stem, pan dot — fades out as it slides off
  // the row instead of clamping at the edge or vanishing at a threshold
  // (Dan, 2026-08-04: "everything should fade out when it goes off screen").
  // Keyed on the voice's TRUE position (freqXs, not the collision-pushed
  // dotXs) so the whole voice fades as one mark; dragged/grabbed voices are
  // exempt at the use sites — they ride the pointer, which is on screen by
  // definition.
  const edgeFades = useMemo(() => {
    const rowW = barWidth + BAR_H_PADDING * 2;
    return freqXs.map((x) => {
      const out = Math.max(-x, x - rowW, 0);
      return Math.max(0, 1 - out / EDGE_FADE_PX);
    });
  }, [freqXs, barWidth]);
  // Fully faded = out of the layout entirely: dropped from the readout
  // collision pass and the selection ring unmounts.
  const offRow = useMemo(() => edgeFades.map((f) => f === 0), [edgeFades]);
  // Index → live drag position, for the orb/label/stem renderers. Last-write-
  // wins if two pointers ever hold the same orb (matches the old ghost map).
  const dragPosByIndex = useMemo(() => {
    const m = new Map();
    for (const g of Object.values(dragOrbs)) m.set(g.index, g);
    return m;
  }, [dragOrbs]);
  // GRAB moves the real orbs too (Dan, 2026-08-04): a grab is a drag that keeps
  // going after the button comes up, so the orbs it holds obey every rule a
  // dragged orb does — above all the above-the-curve handoff.
  //
  // ONE positioning model for both gestures (Dan, 2026-08-04 late): anchor +
  // total pointer delta, exactly like `handlePointerMove`. For a grab the
  // anchor IS the cursor at grab time (ax==sx), so every grabbed orb sits
  // exactly on the cursor — instantly, un-animated (an ease toward an
  // already-stale cursor made fast grab-toggle-plus-move miss the mark), and
  // stacked when several are held (Dan, 2026-08-04: the orb meets the mouse,
  // not a formation around it).
  const grabPosByIndex = useMemo(() => {
    const m = new Map();
    if (!grabCursor) return m;
    for (const idx of grabbedOscs) {
      const a = grabAnchors[idx];
      if (!a) continue;   // grabbed before any cursor was seen; stays home
      m.set(idx, {
        index: idx,
        x: a.ax + (grabCursor.x - a.sx),
        y: a.ay + (grabCursor.y - a.sy),
        edgeRate: grabCursor.edgeRate || 0,
        confirmed: true,
        grabbed: true,
      });
    }
    return m;
  }, [grabCursor, grabbedOscs, grabAnchors]);
  // Union of both — what every renderer that positions an orb (and the chrome
  // riding it: label, selection ring, pan dot, stem, readout) reads. A pointer
  // drag wins if an orb is somehow in both.
  const orbPosByIndex = useMemo(() => {
    if (grabPosByIndex.size === 0 && zoomSettle.size === 0) return dragPosByIndex;
    const m = new Map(grabPosByIndex);
    for (const [i, g] of dragPosByIndex) m.set(i, g);
    // Zoom-mode release settle: the orb sits at its (frame-tracking) marker
    // plus the decaying release offset — computed HERE, against this render's
    // dotXs, so the orb and the easing frame move as one. Live gestures win.
    for (const [i, s] of zoomSettle) {
      if (m.has(i) || !Number.isFinite(dotXs[i])) continue;
      m.set(i, {
        index: i,
        x: dotXs[i] + s.dx * s.frac,
        y: geo.dotCenterY + s.dy * s.frac,
        edgeRate: 0,
        confirmed: true,
      });
    }
    return m;
  }, [dragPosByIndex, grabPosByIndex, zoomSettle, dotXs, geo.dotCenterY]);
  useEffect(() => {
    dotXsRef.current = dotXs;
    freqXsRef.current = freqXs;
    edgeFadesRef.current = edgeFades;
  }, [dotXs, freqXs, edgeFades]);
  useEffect(() => { dragPosRef.current = orbPosByIndex; }, [orbPosByIndex]);
  // Any orb under a finger (or held by a keyboard grab) — the whole readout
  // strip's on/off switch, iOS's `dragReadout`.
  const hzStripShown = draggingDots.size > 0 || grabbedOscs.size > 0;
  // Above-bar Hz readouts (flipped layout): one per voice, where each sits, and
  // whether it's up. iOS frequencyLabels(above:) — touch ANY orb and the whole
  // chord's frequencies come up over the spectrum, each planted over its own
  // pitch. A readout parks at its voice's TRUE frequency and STAYS there while
  // the finger drags the orb around below; the only thing that moves it
  // sideways is the width-aware collision pass, so voices tuned close together
  // step apart instead of stacking. Muted voices are out (nothing sounding to
  // read) — EXCEPT the one under the finger: you can't tune what you can't
  // read, so a muted voice being moved gets its readout like any other (Dan,
  // 2026-08-04). A voice whose orb has been pulled above the bar is out too —
  // it carries its readout with it and stops holding space here. Every voice
  // stays MOUNTED so both edges can fade (see .fsb-hz-float / .fsb-hz-stem).
  // Readouts show the SOUNDING pitch (nominal × transpose) — iOS parity,
  // and the ruler ticks already slide with the transpose, so the number
  // matches the axis under it (Dan, 2026-08-04).
  const soundingRatio = 2 ** (transpose / 12);
  const hzFloats = useMemo(() => {
    if (!geo.flipped) return [];
    const texts = frequencies.map((f) => formatActiveFreq(f * soundingRatio));
    const widths = texts.map(_hzLabelWidth);
    const hidden = new Set();
    for (let i = 0; i < frequencies.length; i++) {
      const held = draggingDots.has(i) || grabbedOscs.has(i);
      if ((muted[i] && !held) || !(frequencies[i] > 0) || orbsAbove.has(i)) hidden.add(i);
      // Fully faded off the row: out of the collision pass too, so a far
      // off-screen readout can't shove the on-screen ones around. Held
      // voices stay: their pitch is what the drag is reading out.
      if (offRow[i] && !held) hidden.add(i);
    }
    const resolved = resolveLabelCollisions(freqXs, widths, HZ_FLOAT_GAP, hidden);
    // No edge clamp: the readout FOLLOWS its pitch off the row and fades out
    // across the edge band (edgeFades → --edge-fade), instead of sticking at
    // the edge with a long stem back to its marker (Dan, 2026-08-04; this
    // replaced the iOS-style clamp).
    return frequencies.map((_, i) => ({
      index: i,
      text: texts[i],
      x: resolved[i],
      fade: (draggingDots.has(i) || grabbedOscs.has(i)) ? 1 : edgeFades[i],
      shown: hzStripShown && !hidden.has(i),
    }));
  }, [geo.flipped, frequencies, freqXs, muted, orbsAbove, hzStripShown,
      draggingDots, grabbedOscs, offRow, edgeFades, soundingRatio]);
  // (A "1/5×" / "2.4×" rate tag used to ride beside the drag readout here.
  // Removed 2026-08-04, Dan: the tier is felt in the drag, and the tag both
  // cluttered the readout and shoved the Hz digits sideways as it appeared.
  // The rate itself is untouched — see scrubScale / scrubRatio.)
  useEffect(() => { settlingRef.current = settlingDots; }, [settlingDots]);

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
    // Damping always measures against the OTHER voices (mover impact 0),
    // independent of the display's "Moving voice impact" setting, so the orb
    // never gets stuck on its own self-consonance.
    const movingSet = new Set([...draggingRef.current, ...grabbedRef.current]);
    const { parts, voices } = _buildBackground(audioEngine.getOscillatorCount(), movingSet, 0, profile);
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

  // Start the release settle for the given indices: the .settling class turns
  // on the left/top transition, and a timer strips it once the ease lands.
  // Safe to capture in mount-time handlers — touches only setters and refs.
  const beginSettle = (indices) => {
    if (!indices.length) return;
    setSettlingDots((prev) => {
      const next = new Set(prev);
      for (const i of indices) next.add(i);
      return next;
    });
    for (const i of indices) {
      clearTimeout(settleTimersRef.current.get(i));
      settleTimersRef.current.set(i, setTimeout(() => {
        settleTimersRef.current.delete(i);
        setSettlingDots((prev) => {
          if (!prev.has(i)) return prev;
          const next = new Set(prev);
          next.delete(i);
          return next;
        });
      }, ORB_SETTLE_MS));
    }
  };
  // A re-grab mid-settle takes the orb back under the finger immediately: the
  // transition class must go in the same commit that repositions the orb, or
  // drag-follow would ease instead of tracking.
  const cancelSettle = (index) => {
    const t = settleTimersRef.current.get(index);
    if (t !== undefined) {
      clearTimeout(t);
      settleTimersRef.current.delete(index);
    }
    setSettlingDots((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    // The zoom-mode JS settle too — a re-grab mid-flight takes over from
    // wherever the composed motion has the orb right now.
    if (zoomSettleRef.current.has(index)) {
      const next = new Map(zoomSettleRef.current);
      next.delete(index);
      zoomSettleRef.current = next;
      setZoomSettle((prev) => {
        if (!prev.has(index)) return prev;
        const n = new Map(prev);
        n.delete(index);
        return n;
      });
    }
  };
  useEffect(() => () => {
    for (const t of settleTimersRef.current.values()) clearTimeout(t);
  }, []);

  // Above-the-bar crossing (flipped layout, iOS parity) — the ONE rule both
  // gestures run, so a grab hands its readout off exactly where a drag does
  // (Dan, 2026-08-04). ±3px hysteresis on the orb's center against the TOP OF
  // THE CONSONANCE CURVE under the orb — not the bar's bottom edge, which
  // flipped the readout the moment the orb left its rest row, ~36px before it
  // had cleared anything. The orb has to rise past the graph line it's sitting
  // under; that's also where the position-line stem locks to the indicator's
  // tip, so the readout hands off from the frequency to the orb in one motion.
  // Purely visual — tuning math is untouched. Reads only setters and module
  // helpers, so it's safe to capture in the mount-time grab handler.
  const updateOrbAbove = (index, x, y) => {
    const crossY = _curveSurfaceAtX(x);
    if (y < crossY - 3) {
      setOrbsAbove((prev) => {
        if (prev.has(index)) return prev;
        const next = new Set(prev);
        next.add(index);
        return next;
      });
    } else if (y > crossY + 3) {
      setOrbsAbove((prev) => {
        if (!prev.has(index)) return prev;
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };
  const clearOrbsAbove = (indices) => {
    setOrbsAbove((prev) => {
      let next = null;
      for (const i of indices) {
        if (!prev.has(i)) continue;
        next = next || new Set(prev);
        next.delete(i);
      }
      return next || prev;
    });
  };

  // Grabbed orbs run that same test off the positions they're RENDERED at —
  // an effect rather than a line in the pointermove handler, because a
  // keyboard grab (1-9) seeds the cursor with no pointer motion at all and
  // still has to hand its readout off. Each held orb is tested at its own spot
  // on the fan ring. Costs nothing on frames where nothing crosses:
  // updateOrbAbove returns the identical set and React bails out.
  useEffect(() => {
    if (!geo.flipped || grabPosByIndex.size === 0) return;
    for (const [idx, p] of grabPosByIndex) updateOrbAbove(idx, p.x, p.y);
  }, [geo.flipped, grabPosByIndex]);

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
    // Anchor at the orb's RENDERED center (iOS's dragStartRestingX): the orb
    // never jumps to the pointer, and re-grabbing one mid-settle picks it up
    // exactly where the transition has it right now.
    const el = dotElsRef.current[index];
    let anchorX = dotXsRef.current[index] ?? 0;
    let anchorY = geo.dotCenterY;
    if (el) {
      const r = el.getBoundingClientRect();
      anchorX = r.left + r.width / 2 - rect.left;
      anchorY = r.top + r.height / 2 - rect.top;
    }
    cancelSettle(index);
    dragRef.current[e.pointerId] = {
      index,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      didDrag: false,
      anchorX,
      anchorY,
    };
    setDraggingDots((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
    setDragOrbs((prev) => ({
      ...prev,
      [e.pointerId]: { index, x: anchorX, y: anchorY, edgeRate: 0, confirmed: false },
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
      // Zoom mode's 1x baseline: whatever span the view had when the drag
      // became real. Captured here (not pointerdown) so a tap never disturbs
      // the framing, and on iOS a manual pinch composes naturally — a
      // pre-pinched-in view means precision is already bought and the curve
      // multiplies from there. grabFrac is the voice's screen position in
      // that frame — the zoom's anchor, so taking the frame never pans it.
      const rGrab = rangeRef.current;
      drag.grabSpan = rGrab.logMax - rGrab.logMin;
      const fGrab = audioEngine.getFrequency(drag.index);
      drag.grabFrac = Math.max(0, Math.min(1,
        (Math.log2(Math.max(FREQ_MIN, Math.min(FREQ_MAX, fGrab))) - rGrab.logMin)
          / (drag.grabSpan || 1)
      ));
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
      drag.lastX = e.clientX;
      // Vertical travel from the grab sets the horizontal tuning rate: the
      // precision tiers, the iOS ramp, or nothing at all in linear mode.
      // Volume is never on this axis during a drag — the faders own it.
      // Zoom mode applies NO multiplier here: it retargets the view span
      // instead (the auto-zoom loop reads drag.spanMult), and the span is
      // already a factor of the logDelta below — folding it in twice would
      // square the gain.
      const mode = orbDragModeRef.current;
      if (mode === 'zoom') {
        drag.spanMult = zoomSpanMult(e.clientY, drag.startY, window.innerHeight);
        // Vertical-only moves change the span target without any frequency
        // event, so kick the demand-driven zoom loop ourselves.
        wakeRef.current?.();
      }
      const scrub = mode === 'precision'
        ? scrubScale(e.clientY - drag.startY)
        : mode === 'ios'
          ? scrubRatio(e.clientY, drag.startY)
          : 1;
      // Read by the `< 1x >` tag over the Hz readout (and the edge arrow).
      // In zoom mode the effective rate is the span tier itself.
      drag.rate = mode === 'zoom' ? drag.spanMult : scrub;
      if (deltaX !== 0) {
        const sens = getSensitivity();
        const r = rangeRef.current;
        const curFreq = audioEngine.getFrequency(drag.index);
        const slow = consonanceSlowdown(curFreq);
        const logDelta =
          (deltaX / barWidthRef.current) * (r.logMax - r.logMin) * sens * slow * scrub;
        audioEngine.setFrequency(
          drag.index,
          Math.max(FREQ_MIN, Math.min(FREQ_MAX, curFreq * 2 ** logDelta))
        );
      }
      // Edge auto-pan rides the ramp too, but the ramp may only ever SLOW the
      // climb (iOS `min(1, edgePushRatio)`): unclamped, a pointer parked deep
      // below the orb makes the edge sweep lurch. The arrow drawn on the orb
      // reads this value, so it visualizes the effective rate. Zoom mode
      // clamps by its span ratio for the same reason — zoomed in, the view
      // is tight, and a full-rate sweep would tear across it. Precision-mode
      // tiers leave the sweep at full speed, as they shipped.
      drag.edgeRate = computeEdgeRate(e.clientX)
        * (mode === 'ios' || mode === 'zoom' ? Math.min(1, drag.rate ?? 1) : 1);
      // Edge-pan needs the auto-zoom loop alive even on frames where
      // setFrequency above didn't fire (e.g., orb already at FREQ_MIN/MAX).
      if (drag.edgeRate) wakeRef.current?.();
    } else {
      drag.edgeRate = 0;
    }
    // Anchor + total delta (not the raw pointer): live frequency-driven
    // position changes never double-count, and edge-pan zooming under a
    // stationary finger doesn't drift the orb.
    const x = drag.anchorX + (e.clientX - drag.startX);
    const y = drag.anchorY + (e.clientY - drag.startY);
    // Above-the-bar crossing — see updateOrbAbove.
    if (geo.flipped && drag.didDrag) updateOrbAbove(drag.index, x, y);
    setDragOrbs((prev) => ({
      ...prev,
      [e.pointerId]: {
        index: drag.index, x, y, edgeRate: drag.edgeRate || 0, confirmed: drag.didDrag,
        rate: drag.rate ?? 1,
      },
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
      if (orbDragModeRef.current === 'zoom') {
        // Zoom mode releases from a deliberately foreign span (maybe a
        // 2.4-semitone close-up) — snapping that to the full frame in one
        // commit is a visual cut, so let the demand-driven loop ease home
        // instead (woken below; the drag record is already gone, so the
        // loop reads the stock voice framing). The cold-JIT re-render
        // concern behind the snap in the other branch was measured on
        // near-target releases; the ease is the point here. Revisit if
        // release-lag reappears.
      } else {
        // Snap range to target instead of letting it ease over ~58 frames.
        // The post-release ease was causing 1s of re-renders, which on cold JIT
        // reads as a UI freeze.
        try {
          const f = audioEngine.getAllFrequencies();
          const base = f.slice(0, oscillatorCount);
          const staged = frequencyManager.getStagedFrequencies();
          const stagedActive = staged ? staged.slice(0, base.length) : null;
          const target = computeTargetRange(stagedActive && stagedActive.length ? base.concat(stagedActive) : base);
          rangeRef.current = target;
          setRange(target);
        } catch { /* no-op */ }
      }
    }

    // Any ended zoom-mode drag — released OR cancelled — must hand the frame
    // back: no frequency event fires here, and the loop may be asleep at the
    // drag's foreign span. The frame eases home IMMEDIATELY, and the orb's
    // return runs in the same motion: capture the finger→marker offset here
    // and let the loop decay it per frame (zoomSettleRef), the orb welded to
    // its moving marker plus the shrinking offset. This replaced the round-3
    // freeze-then-ease hold (frame frozen for ORB_SETTLE_MS, then eased),
    // which read as two sequenced moves (Dan, 2026-08-04).
    let jsSettle = false;
    if (didDrag && orbDragModeRef.current === 'zoom') {
      const pos = dragPosRef.current.get(index);
      if (pos && Number.isFinite(dotXs[index])) {
        const dx = pos.x - dotXs[index];
        const dy = pos.y - geo.dotCenterY;
        zoomSettleRef.current.set(index, { dx, dy, t0: performance.now() });
        // Seed the render state in THIS commit — the loop's first setZoomSettle
        // lands a frame after the dragOrbs entry is gone, and that gap frame
        // rendered the orb teleported onto its marker (caught by the headless
        // release probe).
        setZoomSettle((prev) => {
          const n = new Map(prev);
          n.set(index, { dx, dy, frac: 1 });
          return n;
        });
        jsSettle = true;
      }
      wakeRef.current?.();
    }

    // A confirmed drag settles home: the .settling transition lands in the
    // same commit that hands the orb's position back to dotXs, so it eases
    // from the finger to the resolved spot in one motion (iOS spring parity).
    // Zoom mode settles through the per-frame path above instead — a CSS
    // left/top transition would fight the frame-driven positions.
    if (didDrag && !jsSettle) beginSettle([index]);
    setDraggingDots((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    setDragOrbs((prev) => {
      const next = { ...prev };
      delete next[e.pointerId];
      return next;
    });
    // iOS clears orbsAboveBar unconditionally on release — the stem and
    // labels derive from the orb's position, so they settle home with it.
    setOrbsAbove((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
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
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setGrabCursor({ x: cx, y: cy, edgeRate: rate });
      grabEdgeRateRef.current = rate;
      // Wake the auto-zoom rAF when entering edge-pan from a static cursor
      // (cursor moved into the edge zone without dragging an orb, so the
      // setFrequency path below may not fire on this event).
      if (rate) wakeRef.current?.();

      // Anchoring normally happens at grab time (the grab-set effect below);
      // this is the fallback for a voice grabbed before the cursor was ever
      // seen (mousePosRef still null) — it jumps straight onto the cursor at
      // the first move. Write-through the ref NOW, not just via the
      // state-sync effect: pointermove outruns React's re-render, and a
      // second move arriving before the sync would re-anchor the orb.
      const pending = [];
      for (const idx of grabbedRef.current) if (!grabAnchorsRef.current[idx]) pending.push(idx);
      if (pending.length) {
        const additions = {};
        for (const idx of pending) additions[idx] = { ax: cx, ay: cy, sx: cx, sy: cy };
        grabAnchorsRef.current = { ...grabAnchorsRef.current, ...additions };
        setGrabAnchors((prev) => ({ ...prev, ...additions }));
      }

      // First motion of a grab only moves the orbs there — the jump itself is
      // never a tuning gesture (Dan). `lastGrabX/Y` are nulled whenever the
      // grab set changes, so pitch and volume start accumulating on the NEXT
      // event, from where the cursor is now.
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

  // Grab set transitions. JOINING anchors the orb on the CURSOR right away
  // (Dan, 2026-08-04: pressing the number brings the orb to the mouse — no
  // waiting for motion, no ease chasing a stale cursor; the jump is instant,
  // so any in-flight release settle is cancelled first, exactly like a drag's
  // pointerdown does). LEAVING settles the orb home on the same .settling
  // ease a drag release uses (the only animation either gesture has) and
  // drops it out of orbsAbove, whose readout and stem derive from a position
  // it no longer has (iOS clears that set unconditionally on release).
  const prevGrabbedRef = useRef(new Set());
  useEffect(() => {
    const prev = prevGrabbedRef.current;
    prevGrabbedRef.current = new Set(grabbedOscs);
    const removed = [...prev].filter((i) => !grabbedOscs.has(i));
    if (removed.length) {
      beginSettle(removed);
      clearOrbsAbove(removed);
      const next = { ...grabAnchorsRef.current };
      for (const i of removed) delete next[i];
      grabAnchorsRef.current = next;
      setGrabAnchors((p) => {
        const pruned = { ...p };
        for (const i of removed) delete pruned[i];
        return pruned;
      });
    }
    const added = [...grabbedOscs].filter((i) => !prev.has(i));
    if (added.length) {
      for (const i of added) cancelSettle(i);
      const rect = containerRef.current?.getBoundingClientRect();
      const mouse = mousePosRef.current;
      // No cursor seen yet → leave the orb unanchored (it stays home); the
      // pointermove fallback jumps it onto the cursor at the first move.
      if (rect && mouse) {
        const cx = mouse.x - rect.left;
        const cy = mouse.y - rect.top;
        const additions = {};
        for (const i of added) additions[i] = { ax: cx, ay: cy, sx: cx, sy: cy };
        grabAnchorsRef.current = { ...grabAnchorsRef.current, ...additions };
        setGrabAnchors((p) => ({ ...p, ...additions }));
      }
    }
  }, [grabbedOscs]);

  // Any change to the grab set drops the tuning reference, so the next
  // pointermove is spent on the JUMP alone and pitch/volume start accumulating
  // from wherever the cursor is then — grabbing a voice never nudges what it's
  // already holding. Also seeds `grabCursor` from the last known mouse spot so
  // the orbs (anchored at grab time) render on the cursor before it moves.
  useEffect(() => {
    lastGrabXRef.current = null;
    lastGrabYRef.current = null;
    if (grabbedOscs.size === 0) {
      setGrabCursor(null);
      grabEdgeRateRef.current = 0;
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && mousePosRef.current) {
      setGrabCursor({
        x: mousePosRef.current.x - rect.left,
        y: mousePosRef.current.y - rect.top,
        edgeRate: 0,
      });
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
    setDragOrbs((prev) => {
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
      const drags = Object.values(dragRef.current);
      if (drags.length === 0) return;
      dragRef.current = {};
      // A lost pointerup still settles home instead of teleporting.
      beginSettle(drags.filter((d) => d.didDrag).map((d) => d.index));
      setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
      setDragOrbs((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    };
    const releaseAll = () => {
      const drags = Object.values(dragRef.current);
      dragRef.current = {};
      beginSettle(drags.filter((d) => d.didDrag).map((d) => d.index));
      setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
      setDragOrbs((prev) => (Object.keys(prev).length === 0 ? prev : {}));
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
        const drags = Object.values(dragRef.current);
        if (drags.length > 0) {
          dragRef.current = {};
          beginSettle(drags.filter((d) => d.didDrag).map((d) => d.index));
          setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
          setDragOrbs((prev) => (Object.keys(prev).length === 0 ? prev : {}));
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

  // Ticks are generated in PLAYED space — the visible range shifted up by the
  // transpose (log2 of the ratio = semitones/12). This makes the axis label
  // the frequency each position actually SOUNDS, so as the bar is dragged the
  // round-number labels update: new ones scroll in and each sits at the orb
  // that plays it. (Positioning below uses the same shifted range, which maps
  // a played freq back to its nominal on-screen position — the orbs don't move.)
  const tickLogShift = transpose / 12;
  const visibleTicks = useMemo(
    () => computeTicks(range.logMin + tickLogShift, range.logMax + tickLogShift),
    [range.logMin, range.logMax, tickLogShift]
  );
  // Ridges between the numbers. They subdivide the dominant level's lattice
  // (padded 2 octaves so edge gaps whose bounding mark sits off-screen still
  // get ridges); any ridge landing under a visible label is dropped — that
  // label already draws a full-height line there.
  const minorTicks = useMemo(() => {
    const lo = range.logMin + tickLogShift;
    const hi = range.logMax + tickLogShift;
    // Only a label that's actually READABLE displaces a ridge. A level at
    // 0.2 opacity is a ghost line — dropping ridges under it would leave
    // visibly empty stretches of ruler (the 60/70/80/90 gap at full zoom).
    const majorXs = visibleTicks
      .filter((t) => t.opacity >= 0.5)
      .map((t) => freqToFraction(t.freq, lo, hi) * barWidth);
    return computeMinorTicks(latticeTickFreqs(lo, hi, 2), lo, hi, barWidth)
      .filter((m) => !majorXs.some((mx) => Math.abs(mx - m.x) < 1.5));
  }, [range.logMin, range.logMax, tickLogShift, barWidth, visibleTicks]);

  return (
    <>
      <div className={`orb-backdrop${geo.flipped ? ' flipped' : ''}`} />
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
      {/* gesture-live hoists the whole row's stacking context above every
          menu/panel while an orb is under a finger, held by a grab, or still
          settling home — a dragged orb must never disappear under the console,
          knob band, or an open side-menu column (Dan, 2026-08-04). Scoped to
          the gesture so the at-rest rules (side menu covers the orb row,
          settings panel over everything) keep their existing stacking. */}
      <div
        className={`fsb-row${draggingDots.size > 0 || grabbedOscs.size > 0 || settlingDots.size > 0 || zoomSettle.size > 0 ? ' gesture-live' : ''}`}
        style={{ height: geo.totalHeight }}
      >
      <div className="fsb-side fsb-side-left" style={{ marginBottom: geo.sideMarginBottom }}>
        <GlobalDetuneOrb onDragStateChange={setGlobalOrbDragging} />
      </div>
      <div
        className="freq-spectrum-bar"
        ref={containerRef}
        onPointerDown={beginTransposeDrag}
        onPointerMove={updateTransposeCursor}
        onDoubleClick={resetTranspose}
        style={{ height: geo.totalHeight }}
      >
        {/* Dissonance HUD — sits behind the orbs, rising up from the spectrum
            line and bleeding DISS_CURVE_DOWN px down into the spectrogram.
            Always shown; maps the current chord's consonance hot spots. */}
        <canvas
          ref={dissCanvasRef}
          className="fsb-diss-curve"
          style={{
            left: BAR_H_PADDING,
            top: geo.barTopY - DISS_CURVE_HEIGHT - DISS_LINE_LIFT,
            width: barWidth,
            height: DISS_CURVE_HEIGHT + DISS_LINE_LIFT + DISS_CURVE_DOWN,
          }}
          aria-hidden="true"
        />
        <div
          className="fsb-track"
        style={{
          left: BAR_H_PADDING,
          top: geo.barTopY,
          width: barWidth,
          height: BAR_LINE_HEIGHT,
        }}
      >
        {/* Ticks are generated + positioned in PLAYED space (range shifted by
            the transpose), so the round-number labels update live as the bar is
            dragged and each sits at the orb that actually plays it. */}
        {visibleTicks.map(({ freq, opacity }) => {
          const x = freqToFraction(freq, range.logMin + tickLogShift, range.logMax + tickLogShift) * barWidth;
          return (
            <div key={freq} className="fsb-tick" style={{ left: x, opacity }}>
              <span className="fsb-tick-label">{formatTick(freq)}</span>
            </div>
          );
        })}
        {/* Minor ridges rising from the bar's floor between the labels (iOS
            parity) — on round sub-increments of each gap, see
            computeMinorTicks. */}
        {minorTicks.map(({ freq, x, tall }) => (
          <div
            key={`minor-${freq}`}
            className={`fsb-tick-minor${tall ? ' tall' : ''}`}
            style={{ left: x }}
            aria-hidden="true"
          />
        ))}
      </div>


      {(() => {
        const homeY = geo.dotCenterY;
        const ghostYOffset = 0;
        return (
          <svg className="fsb-lines" width="100%" height={geo.totalHeight} style={{ overflow: 'visible' }}>
            {/* Occlusion mask: white shows, black hides. Black discs at every
                orb punch holes so the staged tether lines/dots read as passing
                BEHIND the orbs — which are translucent hollow rings that would
                otherwise let the lines bleed through them. */}
            <defs>
              <mask id="fsb-staged-occlude" maskUnits="userSpaceOnUse"
                    x={-200} y={Math.min(geo.stagedDotY, homeY) - 100} width={8000} height={440}>
                <rect x={-200} y={Math.min(geo.stagedDotY, homeY) - 100} width={8000} height={440} fill="white" />
                {dotXs.map((ox, oi) => (
                  <circle key={`occ-${oi}`} cx={ox} cy={homeY} r={DOT_SIZE / 2 + 2} fill="black" />
                ))}
              </mask>
            </defs>
            {/* Played notes: one vertical line per sounding keyboard/MIDI
                voice, at its pitch. Drawn first so the orbs and their position
                lines stay on top, and colored by the drone slot the note was
                played from, which ties a line back to the orb it came from.
                Opacity is written per-frame from the envelope amp by the note
                poll, so a line attacks and releases with the note it marks. */}
            {noteLines.map((n) => {
              // Every voice binds to a slot (noteOn refuses a note without one;
              // spawnVoiceAt falls back to the nearest drone), so the neutral
              // is for the slotless voice the KVM API still permits — and it
              // tests null explicitly because `null >= 0` is true, which would
              // otherwise reach oscColor(null) and take osc 1's classic color.
              const color = n.slot != null && n.slot >= 0
                ? palette.oscColor(n.slot, oscillatorCount)
                : DUO_WHITE;
              // Children sit at local x=0; _updateNoteLines translates the group
              // to the note's pitch and rides y1 up to the curve surface every
              // frame. The mount-time transform here just avoids a one-frame
              // flash at the bar's left edge before that first write lands.
              const x = BAR_H_PADDING + freqToFraction(n.hz, range.logMin, range.logMax) * barWidth;
              return (
                <g
                  key={`note-${n.id}`}
                  transform={`translate(${x.toFixed(2)},0)`}
                  ref={(el) => {
                    if (el) noteElsRef.current.set(n.id, { g: el, line: el.querySelector('line') });
                    else noteElsRef.current.delete(n.id);
                  }}
                >
                  <line
                    x1={0}
                    y1={geo.posLineBottomY}
                    x2={0}
                    y2={geo.posLineBottomY}
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    style={{ filter: `drop-shadow(0 0 4px ${color})` }}
                  />
                  <circle
                    cx={0}
                    cy={geo.noteDotY}
                    r={NOTE_DOT_R}
                    fill={color}
                    style={{ filter: `drop-shadow(0 0 3px ${color})` }}
                  />
                  {/* Pointer target only — the visible dot is a 5px speck.
                      Releases this exact voice by id, so two notes a cent apart
                      can't release each other. */}
                  <circle
                    className="fsb-note-dot"
                    cx={0}
                    cy={geo.noteDotY}
                    r={NOTE_DOT_HIT_R}
                    fill="transparent"
                    onPointerDown={(e) => {
                      // Stop the press reaching the bar background, which would
                      // otherwise read it as the start of a transpose drag.
                      e.stopPropagation();
                      e.preventDefault();
                      keyboardVoiceManager.releaseVoiceById(n.id);
                    }}
                  />
                </g>
              );
            })}
            {DISS_SHOW_POSITION_LINES && frequencies.map((_, i) => {
              // Full per-voice position line: orb edge → live curve surface →
              // bar bottom, as ONE polyline. Geometry is set every frame by
              // _updatePositionLines (the top endpoint rides the eased curve);
              // here we own only the stroke + glow. Stays visible for muted orbs
              // (dimmed, no glow). The drop-shadow gives a soft per-osc-color
              // halo so the whole line reads consistently with the orbs' glow.
              const color = palette.oscColor(i, oscillatorCount);
              const isActive = draggingDots.has(i) || grabbedOscs.has(i);
              const isMuted = muted[i];
              // The line always shows the TRUE current state — the pending
              // on/off preview lives on the drone-tray cells below, so the
              // orb row stays free of staging chrome.
              return (
                <polyline
                  key={`posline-${i}`}
                  ref={(el) => { posLineRefs.current[i] = el; }}
                  fill="none"
                  stroke={color}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  strokeOpacity={isMuted ? 0.28 : (isActive ? 0.95 : 0.6)}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  style={{ filter: isMuted ? 'none' : `drop-shadow(0 0 3px ${color})` }}
                />
              );
            })}
            {/* Readout stems (flipped layout): one per readout in the top
                strip (see hzFloats), tying it down to the curve surface at
                that voice's true frequency — where its position line begins.
                Fades with its label (`.showing`), so the whole strip comes up
                and goes down as one. Only the foot is written per frame
                (_updateHzStems); the rest is layout. */}
            {hzFloats.map(({ index: i, x, fade, shown }) => {
              const color = palette.oscColor(i, oscillatorCount);
              return (
                <line
                  key={`hz-stem-${i}`}
                  ref={(el) => { hzStemRefs.current[i] = el; }}
                  className={`fsb-hz-stem${shown ? ' showing' : ''}`}
                  x1={x}
                  y1={FLIPPED_HZ_STEM_TOP_Y}
                  x2={freqXs[i]}
                  y2={_hzStemFootY(freqXs[i])}
                  stroke={color}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  style={{ filter: `drop-shadow(0 0 3px ${color})`, '--edge-fade': fade }}
                />
              );
            })}
            {/* Staged-slot targets: a floating dot STAGED_DOT_LIFT above each
                orb (tethered by a dotted line) marks where that voice will glide
                to; on launch the dot slides down to meet the orb as it lands. An
                upward triangle at the bar's bottom edge marks the same target
                frequency down on the spectrum. The whole group fades
                with the orb's horizontal proximity (also Heuristic 2 — hidden
                when the orb is already on target, fading back in as it drifts, so
                it persists as a "return here" marker). Click/swipe the line or
                dot to launch (or to return once landed). */}
            {stageState && showFreqMarkers && (
              <g mask="url(#fsb-staged-occlude)">
              {stageState.targets.map((tf, i) => {
              if (!Number.isFinite(tf)) return null;
              // Heuristic 1: the saved state has more voices than are currently
              // loaded — don't show markers for those inactive voices.
              if (i >= frequencies.length) return null;
              const isLaunching = !!stageState.launching[i];
              const tx = BAR_H_PADDING + freqToFraction(tf, range.logMin, range.logMax) * barWidth;
              // Gap between the voice's TRUE frequency position and its target —
              // freqXs, not the collision-pushed dotXs. A voice that's only being
              // shoved aside visually (its frequency unchanged) stays on target,
              // so its marker doesn't appear; only a real frequency change does.
              const gap = Math.abs(freqXs[i] - tx);
              // The triangle appears as soon as the voice leaves its saved spot.
              const triOpacity = Math.min(1, Math.max(0,
                (gap - SAME_SPOT_PX) / TRIANGLE_FADE_RANGE_PX));
              if (triOpacity <= 0.02) return null;   // voice on-spot — nothing to show
              const color = palette.oscColor(i, oscillatorCount);
              // Descent is driven by that gap, not launch progress: the dot HOLDS
              // its target x and lowers toward its landing spot as the orb nears
              // the target, and rises back to full lift as the orb moves away.
              // The landing spot is the orb itself in the classic layout; in the
              // flipped layout the orbs hang on the far side of the bar, so the
              // handle instead lands on the target frequency's position at the
              // spectrum's TOP edge (where the triangle marks it). It animates
              // both ways — a launch lowers it, an undo/return raises it — with no
              // snap when a launch is aborted mid-flight. Cubing the linear falloff
              // makes the dot rise FAST as the orb first moves off target (so it
              // clears the landing spot and fades in sooner), then eases to full lift.
              //
              // EXCEPT during a step transition: there the descent runs on the
              // step-time CLOCK — the orb is holding its old spot while the
              // incoming note (this dot) sinks to its landing spot; the orb
              // relocates on landing. Smoothstepped so it eases in and out but
              // still lands exactly when the overlap window closes.
              const stepAnim = stepAnims[i];
              // Dot landed: the marker's job is done — hide it while the orb
              // finishes its slide. (During the pre-landing lead the dot is
              // still falling while the orb is already moving, so the marker
              // stays up until the dot actually touches down.)
              if (stepAnim && stepAnim.p >= 1) return null;
              const descent = stepAnim
                ? stepAnim.p * stepAnim.p * (3 - 2 * stepAnim.p)
                : Math.pow(
                  Math.max(0, Math.min(1, 1 - gap / STAGED_DESCENT_RANGE_PX)),
                  STAGED_DESCENT_EASE
                );
              const dotY = geo.stagedDotY + (geo.stagedLandY - geo.stagedDotY) * descent;
              // The dot + tether fade continuously with the dot's height: full
              // opacity once it's a fade-range clear of its landing spot, then
              // tapering to 0 as it sinks all the way there — so it dissolves
              // INTO the orb (classic) / INTO the bar's top edge (flipped)
              // instead of blinking out partway down.
              //
              // During a step transition the dot does NOT fade: it rides at full
              // opacity all the way down, and the whole marker simply unmounts
              // at the instant it lands (p=1 → the orb jumps over and the
              // on-target gap hides the marker). The tether is hidden for the
              // ride — just the incoming note descending, no leash.
              const stepping = !!stepAnim;
              const orbTop = homeY - DOT_SIZE / 2;
              const dotLineOpacity = stepping ? 1 : Math.min(1, Math.max(0,
                geo.flipped
                  ? (geo.stagedLandY - dotY) / (DOT_LINE_FADE_RANGE_PX + STAGED_DOT_R)
                  : (homeY - dotY) / (DOT_LINE_FADE_RANGE_PX + (homeY - orbTop))));
              const showDot = !isLaunching && dotLineOpacity > 0.1;
              // Dotted tether: dot → orb edge (classic, trimmed both ends like
              // the ghosts) / dot → the freq marker at the spectrum's top edge
              // (flipped — a short vertical leash that never crosses the bar).
              const seg = geo.flipped
                ? offsetLine(tx, dotY, tx, geo.stagedLandY, STAGED_DOT_R, 0)
                : offsetLine(tx, dotY, dotXs[i], homeY, STAGED_DOT_R, DOT_SIZE / 2);
              // The transition mode decides how a launch travels (glide tween
              // vs step retrigger — both step flavors count as step for a
              // single-dot gesture); holding shift inverts it for this
              // gesture — desktop's quick way to borrow the other mode.
              const launchWith = (invert) => {
                const stepMode = frequencyManager.transitionMode !== 'glide';
                const useStep = invert ? !stepMode : stepMode;
                if (useStep) frequencyManager.stepVoice(i);
                else frequencyManager.launchVoice(i);
              };
              const launch = (e) => {
                e.stopPropagation();
                // Touch implicitly captures the pointer to this element on down;
                // release it so pointerenter still fires on sibling lines as the
                // finger swipes across them.
                try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* none held */ }
                launchWith(e.shiftKey);
              };
              // Swipe: crossing a pending line/dot with the button/finger held
              // launches that voice — drag across several for a cascade.
              const swipeOver = (e) => { if (e.buttons & 1) launchWith(e.shiftKey); };
              const pts = `${tx},${geo.triangleApexY} `
                + `${tx + TRIANGLE_W / 2},${geo.triangleBaseY} `
                + `${tx - TRIANGLE_W / 2},${geo.triangleBaseY}`;
              return (
                <g key={`staged-${i}`} opacity={stageFade}>
                  {!stepping && seg && (
                    <line
                      x1={seg.x1}
                      y1={seg.y1}
                      x2={seg.x2}
                      y2={seg.y2}
                      stroke={color}
                      strokeWidth={isLaunching ? 2.5 : 1}
                      strokeOpacity={isLaunching ? 0.95 : 0.58}
                      strokeDasharray={isLaunching ? undefined : '0.75 3.5'}
                      strokeLinecap="round"
                      opacity={dotLineOpacity}
                      style={isLaunching ? { filter: `drop-shadow(0 0 5px ${color})` } : undefined}
                    />
                  )}
                  {/* Fat invisible hit line along the tether for click/swipe (only
                      once the dot has cleared the orb — otherwise it'd swallow
                      clicks near the orb while invisible; hidden during a step
                      ride along with the visible tether). */}
                  {!stepping && showDot && seg && (
                    <line
                      x1={seg.x1}
                      y1={seg.y1}
                      x2={seg.x2}
                      y2={seg.y2}
                      stroke="transparent"
                      strokeWidth={16}
                      strokeLinecap="round"
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onPointerDown={launch}
                      onPointerEnter={swipeOver}
                    />
                  )}
                  {/* Invisible hit box over the triangle — click/swipe it to send
                      this voice back to its saved position (it's the reliable
                      target since it shows even for small drifts). */}
                  {!isLaunching && triOpacity > 0.1 && (
                    <rect
                      x={tx - TRIANGLE_W / 2 - TRIANGLE_HIT_PAD}
                      y={geo.triangleApexY - TRIANGLE_HIT_PAD}
                      width={TRIANGLE_W + 2 * TRIANGLE_HIT_PAD}
                      height={TRIANGLE_H + 2 * TRIANGLE_HIT_PAD}
                      fill="transparent"
                      style={{ pointerEvents: 'all', cursor: 'pointer' }}
                      onPointerDown={launch}
                      onPointerEnter={swipeOver}
                    />
                  )}
                  {/* Upward triangle marking the target frequency on the spectrum —
                      appears as soon as the voice leaves its saved spot. */}
                  <polygon
                    points={pts}
                    fill={color}
                    fillOpacity={0.72}
                    stroke={color}
                    strokeWidth={0.75}
                    opacity={triOpacity}
                    style={{ filter: `drop-shadow(0 0 1.5px ${color})`, pointerEvents: 'none' }}
                  />
                  {/* Invisible hit target over the floating dot (only once shown). */}
                  {showDot && (
                    <circle
                      cx={tx}
                      cy={dotY}
                      r={STAGED_DOT_R + 7}
                      fill="transparent"
                      style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                      onPointerDown={launch}
                      onPointerEnter={swipeOver}
                    />
                  )}
                  {/* Floating target dot (above the orb classic / above the
                      freq marker flipped). */}
                  <circle
                    cx={tx}
                    cy={dotY}
                    r={STAGED_DOT_R}
                    fill={color}
                    fillOpacity={isLaunching ? 1 : 0.9}
                    opacity={dotLineOpacity}
                    style={{
                      filter: `drop-shadow(0 0 ${isLaunching ? 7 : 4}px ${color})`,
                      pointerEvents: 'none',
                    }}
                  />
                </g>
              );
              })}
              </g>
            )}
            {/* No tether in either gesture: the real orb rides the pointer
                (iOS parity), and its position line above doubles as the stem
                back to the true frequency x. */}
            {Object.entries(dragOrbs).map(([pid, g]) =>
              renderEdgeArrow(
                `drag-arrow-${pid}`,
                g.x,
                g.y + ghostYOffset,
                g.edgeRate,
                palette.oscColor(g.index, oscillatorCount)
              )
            )}
            {/* Grabbed orbs get the same arrow beside wherever each one now
                sits — one per orb, not one per cursor, since they no longer
                stack at a single point. */}
            {[...grabPosByIndex.values()].map((g) =>
              renderEdgeArrow(
                `grab-arrow-${g.index}`,
                g.x,
                g.y + ghostYOffset,
                g.edgeRate,
                palette.oscColor(g.index, oscillatorCount)
              )
            )}
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
        // While a pointer holds this orb — or a grab does — it rides the
        // cursor directly (no ghost, iOS parity); on release the .settling
        // transition eases it back onto its resolved dotXs spot (zoom mode
        // instead settles per-frame through orbPosByIndex, composed with the
        // frame easing home).
        const dragPos = orbPosByIndex.get(i);
        const classes = ['fsb-dot'];
        if (muted[i]) classes.push('muted');
        if (isDragging) classes.push('dragging');
        else if (isGrabbed) classes.push('grabbed');
        if (isBoosted) classes.push('boosted');
        if (settlingDots.has(i)) classes.push('settling');
        // The frequency panel's subject. The ring itself is drawn by the
        // .fsb-sel-ring layer below, not here; the class stays as the
        // state hook on the orb.
        if (selectedVoice === i) classes.push('selected');
        // Edge fade as a filter: composes with whatever opacity the orb's
        // state classes set (muted, dragging, paused…) without touching
        // them, and fades the glow with the disc. Applied only when < 1 so
        // the everyday path keeps its filter-free rendering (plus-lighter
        // blending stays untouched).
        const fade = dragPos ? 1 : edgeFades[i];
        return (
          <div
            key={i}
            ref={(el) => { dotElsRef.current[i] = el; }}
            className={classes.join(' ')}
            style={{
              left: (dragPos ? dragPos.x : dotXs[i]) - DOT_SIZE / 2,
              top: (dragPos ? dragPos.y : geo.dotCenterY) - DOT_SIZE / 2,
              width: DOT_SIZE,
              height: DOT_SIZE,
              '--dot-color': color,
              filter: fade < 1 ? `opacity(${fade})` : undefined,
              pointerEvents: fade === 0 ? 'none' : undefined,
            }}
            onPointerDown={(e) => handlePointerDown(e, i)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={(e) => handlePointerUp(e, true)}
          />
        );
      })}

      {/* Selection ring — the frequency panel's subject, matching the
          corner brackets its note cell wears in the console. Its OWN layer
          rather than an outline on the orb: the orb dims itself with
          element opacity (muted 0.4, paused 0.42), and an outline is part
          of the element, so the mark faded out on exactly the voices you
          most need to pick out of the row (Dan, 2026-08-04). Here it stays
          full white whatever the orb is doing. Rides the orb through a
          drag/settle the way the pinned pan dot does. Exactly one is ever
          mounted — the CSS hover rule depends on that. */}
      {selectedVoice != null && selectedVoice >= 0 && selectedVoice < frequencies.length && (() => {
        const dragPos = orbPosByIndex.get(selectedVoice);
        if (offRow[selectedVoice] && !dragPos) return null;
        return (
          <div
            className={`fsb-sel-ring${settlingDots.has(selectedVoice) ? ' settling' : ''}`}
            style={{
              filter: !dragPos && edgeFades[selectedVoice] < 1
                ? `opacity(${edgeFades[selectedVoice]})` : undefined,
              left: dragPos ? dragPos.x : dotXs[selectedVoice],
              top: dragPos ? dragPos.y : geo.dotCenterY,
              // Border-box, so the ring's 1.5px stroke lands entirely in
              // the 3px it adds over the orb: flush against the rim, no air
              // (iOS parity).
              width: DOT_SIZE + 3,
              height: DOT_SIZE + 3,
            }}
          />
        );
      })()}

      {/* Same-octave keyboard indicator: a dot floating above each orb,
          shown (`.active`) by the glow rAF loop when a note at this slot's
          exact octave is sounding — instead of lighting the orb itself. */}
      {frequencies.map((_, i) => (
        <div
          key={`kbd-dot-${i}`}
          ref={(el) => { kbdDotElsRef.current[i] = el; }}
          className="fsb-kbd-dot"
          style={{
            left: dotXs[i],
            top: geo.kbdDotCenterY,
            '--dot-color': palette.oscColor(i, oscillatorCount),
            filter: edgeFades[i] < 1 ? `opacity(${edgeFades[i]})` : undefined,
          }}
        />
      ))}

      {/* Voice-number label. Classic: above the orb, swapping to a live Hz
          readout while dragged. Flipped: BELOW the orb (iOS parity) and it
          stays the number — the live Hz readout instead rides the strip at
          the row's top (see fsb-hz-float below), where the dragging finger
          can't cover it. */}
      {frequencies.map((f, i) => {
        const color = palette.oscColor(i, oscillatorCount);
        const isActive = !geo.flipped && (draggingDots.has(i) || grabbedOscs.has(i));
        // The label rides the orb: at the cursor during a drag or grab, easing
        // home with it during the release settle (same .settling transition).
        const dragPos = orbPosByIndex.get(i);
        const lx = dragPos ? dragPos.x : dotXs[i];
        const lyCenter = dragPos ? dragPos.y : geo.dotCenterY;
        // Orb pulled above the spectrum: the number would trail it up over the
        // curve, doubling with the Hz float that's now glued to the orb — so
        // the raised orb carries the readout ALONE (Dan, 2026-08-04).
        const raised = geo.flipped && orbsAbove.has(i) && dragPos;
        return (
          <div
            key={`label-${i}`}
            ref={(el) => { labelElsRef.current[i] = el; }}
            className={`fsb-dot-label ${geo.flipped ? 'below ' : ''}${muted[i] ? 'muted' : ''} ${isActive ? 'active-freq' : ''} ${statusReadoutShown(i) ? 'status-hidden' : ''} ${settlingDots.has(i) ? 'settling' : ''} ${raised ? 'raised-hidden' : ''}`}
            style={{
              left: lx,
              top: geo.flipped
                ? lyCenter + DOT_SIZE / 2 + 2
                : lyCenter - DOT_SIZE / 2 - 2,
              color,
              filter: !dragPos && edgeFades[i] < 1 ? `opacity(${edgeFades[i]})` : undefined,
            }}
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
              {isActive ? formatActiveFreq(f * soundingRatio) : i + 1}
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

      {/* Flipped-mode Hz readouts: the strip at the top of the row (above the
          curve) — iOS's instrument-bar drag readout. Touching any orb raises
          the WHOLE chord's frequencies, each planted over its own pitch, so a
          drag is read against every other voice and not just the one moving.
          They do NOT track the orb: the finger can pull an orb anywhere and
          the numbers stay put over the pitches they read out, stepping aside
          only for each other (see hzFloats' collision pass). The stems drawn
          in the SVG layer above are what tie them back to their markers. */}
      {hzFloats.map(({ index: i, text, x, fade, shown }) => (
        <div
          key={`hz-float-${i}`}
          className={`fsb-hz-float${shown ? ' showing' : ''}`}
          style={{ left: x, top: 0, color: palette.oscColor(i, oscillatorCount), '--edge-fade': fade }}
        >
          {text}
        </div>
      ))}
      {/* …except once the orb is dragged ABOVE the bar, where it would cover
          the strip: there the readout leaves the strip (and the collision
          pass) to glue itself just above the raised orb, riding it as iOS's
          floating Hz label does. */}
      {geo.flipped && frequencies.map((f, i) => {
        if (!(draggingDots.has(i) || grabbedOscs.has(i))) return null;
        const dragPos = orbPosByIndex.get(i);
        if (!dragPos || !orbsAbove.has(i)) return null;
        return (
          <div
            key={`hz-raised-${i}`}
            className="fsb-hz-float above-orb showing"
            style={{
              left: dragPos.x,
              top: dragPos.y - DOT_SIZE / 2 - 4,
              color: palette.oscColor(i, oscillatorCount),
            }}
          >
            {formatActiveFreq(f * soundingRatio)}
          </div>
        );
      })}

      {/* Drag-rate tag (Dan, 2026-08-04, with the directional ramp): a
          small `< 1x >` centered ABOVE the dragged voice's Hz readout —
          wherever that readout currently is (the strip, or glued to a
          raised orb) — reading out the vertical axis: climbs past 1x as
          the orb rises, drops toward 1/20x as it's pulled down. The
          chevrons are the affordance ("this changes"); dim white so the
          Hz digits stay the loud element. Never mounted in linear mode
          (no rate to read); replaces the iOS calipers, which Dan found
          confusing. HIDDEN for now via SHOW_SCRUB_RATE_TAG. */}
      {SHOW_SCRUB_RATE_TAG && geo.flipped && orbDragMode !== 'linear' && frequencies.map((_, i) => {
        const dragPos = dragPosByIndex.get(i);
        if (!dragPos || !dragPos.confirmed) return null;
        const raised = orbsAbove.has(i);
        const strip = !raised && hzFloats.find((h) => h.index === i);
        // Strip readout tops the row (top 0, height FLIPPED_HZ_FLOAT_H);
        // the raised float hangs off the orb bottom-anchored, so clear its
        // full height too.
        const left = strip ? strip.x : dragPos.x;
        const top = raised
          ? dragPos.y - DOT_SIZE / 2 - 4 - FLIPPED_HZ_FLOAT_H - 3
          : -3;
        return (
          <div
            key={`rate-${i}`}
            className="fsb-rate-tag"
            style={{ left, top }}
          >
            <span className="fsb-rate-chev">&lt;</span>
            {formatScrubRate(dragPos.rate ?? 1)}
            <span className="fsb-rate-chev">&gt;</span>
          </div>
        );
      })}

      {/* Pinned pan dots (Settings → "Pan dots", on by default — iOS
          panDotAlwaysOn). The same rim indicator the pan flash draws, but
          mounted full-time on every orb and reading the LIVE pan, so each
          orb wears its stereo placement at a glance. It rides the orb
          through a drag/settle (the flash layer below stays parked on the
          resolved spot, as it always has); while it's on, the flash hands
          this layer the pan dot so there's never a doubled indicator. */}
      {panDots && frequencies.map((_, i) => {
        const dragPos = orbPosByIndex.get(i);
        const pan = Math.max(-1, Math.min(1, voicePans[i] ?? audioEngine.getVoicePan(i)));
        return (
          <div
            key={`pan-dot-${i}`}
            className={`fsb-status pinned${geo.flipped ? ' flipped' : ''}${muted[i] ? ' muted' : ''}${dragPos ? ' dragging' : ''}${settlingDots.has(i) ? ' settling' : ''}`}
            style={{
              left: dragPos ? dragPos.x : dotXs[i],
              top: dragPos ? dragPos.y : geo.dotCenterY,
              '--dot-color': palette.oscColor(i, oscillatorCount),
              '--status-arc-r': `${STATUS_ARC_RADIUS}px`,
              filter: !dragPos && edgeFades[i] < 1 ? `opacity(${edgeFades[i]})` : undefined,
            }}
          >
            <div className="fsb-status-arc" style={{ transform: `rotate(${pan * 90}deg)` }}>
              <span className="fsb-status-arc-dot" />
            </div>
          </div>
        );
      })}

      {/* Orb status flash — the orb parameter-display language. Every orb
          gets a brightened indicator on its INNER radius, but only voices
          BEING EDITED swap their number for the text readout — the rest
          keep their numbers so the bar stays legible.
            pan     one dot at the pan position (−1 → left horizon,
                    0 → top, +1 → right); readout "45%", or "L"/"R"
                    at a hard pan (formatPanFlash).
                    Centered shows no text — the 12-o'clock dot alone
                    says "center".
            detune  two SMALLER dots spreading symmetrically from
                    12 o'clock (clean, coincident — reads as one dot)
                    out to the 9/3 horizons at the max master detune;
                    readout is the voice's effective spread in Hz. Zero
                    shows no text — the single top dot says "clean".
          When the readout is suppressed (at-rest value) the voice number
          stays visible instead — see statusReadoutShown. */}
      {statusFlash && frequencies.map((_, i) => {
        const color = palette.oscColor(i, oscillatorCount);
        const isPan = statusFlash.param === 'pan';
        const pan = isPan ? Math.max(-1, Math.min(1, statusFlash.values[i] ?? 0)) : 0;
        const det = isPan ? 0 : Math.max(0, statusFlash.values[i] ?? 0);
        const spreadDeg = Math.min(1, det / MAX_DETUNE_HZ) * 90;
        const atRest = isPan ? Math.abs(pan) < 0.005 : det < 0.05;
        const isEdited = statusFlash.active === i || statusFlash.active === 'all';
        return (
          <div
            key={`status-${i}`}
            className={`fsb-status${geo.flipped ? ' flipped' : ''}${statusFlash.leaving ? ' leaving' : ''}${muted[i] ? ' muted' : ''}`}
            style={{
              left: dotXs[i],
              top: geo.dotCenterY,
              '--dot-color': color,
              '--status-arc-r': `${STATUS_ARC_RADIUS}px`,
            }}
          >
            {/* Same offset as .fsb-dot-label so the readout lands exactly
                where the voice number sits (below the orb in flipped mode).
                Kept mounted while at rest so the opacity fade can animate
                both ways during a drag.
                Terse pan grammar, iOS parity (FrequencySpectrumBar.swift's
                readoutFlashes, Dan 2026-08-04): a BARE percentage — the rim
                dot's side already says which way it's panned, so "L 50%"
                was saying it twice — and a full pan drops the number for
                the bare side letter, since 100% is the only value the
                letter alone can mean. Center shows nothing (`atRest` fades
                the head out; the 12-o'clock dot is the readout). */}
            {isEdited && (
              <div
                className={`fsb-status-head${atRest ? ' centered' : ''}`}
                style={{ top: (DOT_SIZE / 2 + 2) * (geo.flipped ? 1 : -1), color }}
              >
                {isPan ? formatPanFlash(pan) : `${det.toFixed(1)}Hz`}
              </div>
            )}
            {isPan ? (
              // Skipped when the pinned layer is up: it already draws this
              // dot, live and unfading, on every orb.
              !panDots && (
                <div className="fsb-status-arc" style={{ transform: `rotate(${pan * 90}deg)` }}>
                  <span className="fsb-status-arc-dot" />
                </div>
              )
            ) : (
              <>
                <div className="fsb-status-arc" style={{ transform: `rotate(${-spreadDeg}deg)` }}>
                  <span className="fsb-status-arc-dot fsb-status-arc-dot-sm" />
                </div>
                <div className="fsb-status-arc" style={{ transform: `rotate(${spreadDeg}deg)` }}>
                  <span className="fsb-status-arc-dot fsb-status-arc-dot-sm" />
                </div>
              </>
            )}
          </div>
        );
      })}

      {/* Transpose readout — iOS parity (transposeReadout in
          FrequencySpectrumBar.swift), parked at the bar's TOP-RIGHT in the
          orb row's airspace (Dan 2026-08-03: was top-left; iOS puts it at
          the right edge, with the left edge reserved for the zoom
          readout's mirror). Two stacked lines — the concrete "how far did
          the tuning move" numbers: the root (lowest active) drone's Hz
          shift `root × (ratio − 1)`, and the offset in cents. Clicking it
          glides the transpose home over the SAME window recalls use, so
          the return matches the app's glide feel. Always in the tree
          (opacity-gated, not conditionally mounted) so it fades in/out.
          Last sibling so it wins hit-testing over the transpose-drag
          background. */}
      {(() => {
        const offCenter = Math.abs(transpose) > 0.05;
        const root = frequencies.reduce(
          (m, f) => (f > 0 && f < m ? f : m), Infinity);
        const ratio = audioEngine.getTransposeRatio() || 1;
        const hzDelta = (Number.isFinite(root) ? root : 0) * (ratio - 1);
        // Whole Hz once the shift is big, one decimal while it's small so
        // sub-semitone nudges don't read as "+0hz".
        const signed = (v, digits) => (v >= 0 ? '+' : '') + v.toFixed(digits);
        const hzText = `${signed(hzDelta, Math.abs(hzDelta) >= 10 ? 0 : 1)}hz`;
        const centsText = `${signed(transpose * 100, 0)}c`;
        return (
          <button
            type="button"
            className="fsb-transpose-readout"
            style={{
              right: BAR_H_PADDING,
              top: geo.transposeReadoutY,
              opacity: offCenter ? 1 : 0,
              pointerEvents: offCenter ? 'auto' : 'none',
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => audioEngine.glideTranspose(0, frequencyManager.recallGlideMs)}
            title="Reset transpose"
            aria-label={`Transpose ${hzText} ${centsText} — click to reset`}
          >
            <span>{hzText}</span>
            <span className="fsb-transpose-cents">{centsText}</span>
          </button>
        );
      })()}

      </div>
      <div className="fsb-side fsb-side-right" style={{ marginBottom: geo.sideMarginBottom }}>
        <div className="fsb-count-row">
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
      </div>
    </>
  );
}

export default memo(FrequencySpectrumBar);
