/**
 * scrubSettings — orb-drag feel knobs. Two groups share this store (both are
 * per-device preferences, both are read every drag frame):
 *   scaleAmount / fineLimit  — the 'ios scaling' ramp (below).
 *   zoomOffset / zoomScale / zoomInvert — the 'zoom' mode curve, exposed as
 *     the y = mx + b it literally is in log-span space (Dan, 2026-08-04):
 *     `zoomOffset` is b (the span change applied the instant a drag confirms,
 *     zeroed by default), `zoomScale` is m (how hard vertical travel leans
 *     the frame), `zoomInvert` swaps which direction zooms in.
 *     FrequencySpectrumBar's zoomSpanMult consumes all three.
 *
 * The vertical axis of an orb drag no longer sets VOLUME (that moved to the
 * mixer console's faders — Dan, 2026-08-04). Instead, vertical position IS
 * the speed dial, and since 2026-08-04 (later the same day) it is
 * DIRECTIONAL rather than mirrored: at the grab row the drag runs at plain
 * 1:1 speed; pulling the orb ABOVE the row accelerates the sweep (up to 4x),
 * pulling it BELOW slows it down for precision (down to `fineLimit`). One
 * gesture covers both scenarios — reach up for range, drop down for fine —
 * which superseded the earlier mirrored ramp AND its `inverse` flip in one
 * move (both are gone; git + memory hold the shapes).
 *
 * (iOS still runs the mirrored ramp — this direction-split is web-only for
 * now, so the module no longer claims iOS symbol parity, but the localStorage
 * keys it kept are still the iOS UserDefaults names.)
 *
 * The ramp's on/off switch is the Settings → Orb drag mode itself ('ios' vs
 * 'linear' / 'pull for precision'), which lives in App state.
 *
 * Settings (localStorage):
 *   scaleAmount    — exponent on the depth→ratio curve, fixed point at 1x.
 *                    1 = the tuned curves, 0 = flat, 2 = exaggerated both ways.
 *   fineLimit      — the down side's far end: the ratio at full pull-down,
 *                    with 1x at the row held fixed. 0.05 = the precision
 *                    mode's 1/20 fine zone.
 *   zoomOffset     — b: log2 span offset applied at drag-confirm. 0 = the
 *                    view doesn't move when you grab; +0.14 is the 1.1x
 *                    "breathe" the mode shipped with.
 *   zoomScale      — m: multiplier on the pull→span exponent. 1 = the tuned
 *                    curve (3x out / ~1/3 in at full travel), 0 = flat (the
 *                    frame never leans), 2 = double the depth either way.
 *   zoomInvert     — flip the axis: raise to zoom IN, pull down to zoom out.
 */

const KEYS = {
  scaleAmount: 'scrubScaleAmount',
  fineLimit: 'scrubFineLimit',
  zoomOffset: 'zoomGrabOffset',
  zoomScale: 'zoomScaleAmount',
  zoomInvert: 'zoomInvert',
};

export const SCRUB_DEFAULTS = {
  scaleAmount: 1.2,     // Dan's feel, 2026-07-21
  fineLimit: 0.05,
  zoomOffset: 0,        // Dan, 2026-08-04: no zoom jump on grab by default
  zoomScale: 1,
  zoomInvert: false,
};

export const SCALE_AMOUNT_MIN = 0;
export const SCALE_AMOUNT_MAX = 2;
export const FINE_LIMIT_MIN = 0.01;
export const FINE_LIMIT_MAX = 1;
// Offset in log2 span units: ±1 is one octave of span (half / double frame).
export const ZOOM_OFFSET_MIN = -1;
export const ZOOM_OFFSET_MAX = 1;
export const ZOOM_SCALE_MIN = 0;
export const ZOOM_SCALE_MAX = 3;

const RANGES = {
  scaleAmount: [SCALE_AMOUNT_MIN, SCALE_AMOUNT_MAX],
  fineLimit: [FINE_LIMIT_MIN, FINE_LIMIT_MAX],
  zoomOffset: [ZOOM_OFFSET_MIN, ZOOM_OFFSET_MAX],
  zoomScale: [ZOOM_SCALE_MIN, ZOOM_SCALE_MAX],
};

const _settings = { ...SCRUB_DEFAULTS };
const _listeners = new Set();

function _clamp(key, v) {
  const range = RANGES[key];
  return range ? Math.max(range[0], Math.min(range[1], v)) : v;
}

if (typeof window !== 'undefined') {
  for (const key of Object.keys(SCRUB_DEFAULTS)) {
    try {
      const raw = localStorage.getItem(KEYS[key]);
      if (raw === null) continue;
      if (typeof SCRUB_DEFAULTS[key] === 'boolean') {
        _settings[key] = raw === 'true';
      } else {
        const n = parseFloat(raw);
        if (Number.isFinite(n)) _settings[key] = _clamp(key, n);
      }
    } catch { /* ignore */ }
  }
}

/** Live settings object — read every drag frame; never mutate from outside. */
export function getScrubSettings() { return _settings; }

export function setScrubSetting(key, value) {
  if (!(key in SCRUB_DEFAULTS)) return;
  const next = typeof SCRUB_DEFAULTS[key] === 'boolean'
    ? !!value
    : (Number.isFinite(value) ? _clamp(key, value) : null);
  if (next === null || next === _settings[key]) return;
  _settings[key] = next;
  try { localStorage.setItem(KEYS[key], String(next)); } catch { /* ignore */ }
  for (const fn of _listeners) {
    try { fn(_settings); } catch { /* ignore */ }
  }
}

export function onScrubSettingsChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ── The ramp ─────────────────────────────────────────────────────────────
// (depth, ratio) anchors per DIRECTION. Depth is 0 at the grab row and 1 at
// 75% of that direction's headroom (SCRUB_TRAVEL). Both start at exactly 1x —
// the row itself is plain speed — and diverge: UP accelerates toward a 4x
// coarse sweep, DOWN decelerates toward the fine zone (0.05 = 1/20, the
// precision mode's deepest tier; the live end stop is the `fineLimit`
// setting via fineLimitedRatio). Both sorted by depth.
const SCRUB_UP_ANCHORS = [
  [0.0, 1.0],
  [0.1, 1.2],
  [0.3, 1.6],
  [0.5, 2.2],
  [0.75, 3.1],
  [1.0, 4.0],
];
const SCRUB_DOWN_ANCHORS = [
  [0.0, 1.0],
  [0.1, 0.7],
  [0.3, 0.35],
  [0.5, 0.15],
  [0.75, 0.07],
  [1.0, 0.05],
];

// Fraction of the direction's headroom (row→viewport-bottom pulling down,
// row→viewport-top pulling up) that the ramp spans. The last anchor is
// reached at 75% of the way; the last 25% either way clamps to it.
const SCRUB_TRAVEL = 0.75;

/**
 * Raw depth→ratio curve. `orbY` is the gesture's anchor row (viewport px),
 * `pointerY` the pointer's current viewport Y. The direction picks the
 * table — above the row reads the accelerating one, below the fine one —
 * and depth is the distance from the row normalized against 75% of that
 * direction's own headroom (per-direction because the orb row sits near the
 * screen bottom, not mid-screen). Geometric interpolation between anchors so
 * both ramps feel exponential rather than linear.
 */
function rampRatio(pointerY, orbY, viewportH) {
  const below = pointerY >= orbY;
  const anchors = below ? SCRUB_DOWN_ANCHORS : SCRUB_UP_ANCHORS;
  const headroom = below ? viewportH - orbY : orbY;
  if (!(headroom > 0)) return anchors[0][1];

  const depth = Math.abs(pointerY - orbY) / (headroom * SCRUB_TRAVEL);
  if (depth <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (depth >= last[0]) return last[1];

  for (let i = 1; i < anchors.length; i++) {
    const [hiD, hiR] = anchors[i];
    if (depth > hiD) continue;
    const [loD, loR] = anchors[i - 1];
    const t = (depth - loD) / (hiD - loD);
    return loR * Math.pow(hiR / loR, t);
  }
  return last[1];
}

/**
 * Fine limit — the down side's end stop. Geometric remap of the sub-1x side:
 * depth 0 (ratio 1, plain speed at the row) is the fixed point and the
 * deepest pull lands exactly on `fineLimit`, with the curve between them
 * stretched smoothly (no dead zone, unlike a plain max()). Takes the
 * post-scaleAmount ratio; a no-op above 1x, so the up side never sees it.
 */
function fineLimitedRatio(r, scaleAmount, fineLimit) {
  const rampMin = Math.pow(
    SCRUB_DOWN_ANCHORS[SCRUB_DOWN_ANCHORS.length - 1][1], scaleAmount);
  if (!(r < 1) || !(rampMin < 1) || !(fineLimit > 0) || fineLimit === rampMin) return r;
  return Math.pow(r, Math.log(fineLimit) / Math.log(rampMin));
}

/**
 * The drag-speed multiplier for a pointer at `pointerY` (viewport px) against
 * the grab point at `orbY`. Callers multiply their horizontal delta by it.
 * Above the row > 1x, below < 1x, exactly 1x at the grab.
 */
export function scrubRatio(pointerY, orbY, viewportH = typeof window !== 'undefined' ? window.innerHeight : 0) {
  const s = _settings;
  // scaleAmount is the strength exponent about the fixed point 1x, so it
  // exaggerates/flattens both directions symmetrically; then the down
  // side's end stop (a no-op on the up side).
  const scaled = Math.pow(rampRatio(pointerY, orbY, viewportH), s.scaleAmount);
  return fineLimitedRatio(scaled, s.scaleAmount, s.fineLimit);
}
