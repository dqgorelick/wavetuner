/**
 * Fold - per-pool wavefolder using a WaveShaperNode.
 *
 * West-Coast (Buchla / Serge) wavefolding: signal that exceeds ±1 is
 * reflected back into range instead of clipping, generating rich
 * harmonic content. Web Audio's WaveShaperNode handles this with a
 * lookup table; the curve is rebuilt as the user drags the slider.
 *
 * Two singletons: droneFold (applied to the drone bus shaper) and
 * keyboardFold (applied to the keyboard bus shaper). AudioEngine
 * creates the WaveShaperNodes in initialize() and inserts them
 * immediately after each pool's bus gain. Subscribing to onChange
 * re-applies the curve.
 *
 * The curve is linear-mixed with identity, so amount=0 is bit-perfect
 * bypass — no subtle distortion creeping in.
 *
 * Note: WaveShaperNode CLAMPS its input to [-1, 1] before lookup, so
 * folding can't be implemented by pre-gain; it has to be encoded in
 * the curve. The drive parameter rebuilds the curve with more folds.
 *
 * See research/waveshaping.md §3.
 */

const CURVE_SIZE = 2048;

/**
 * Fold-type registry. Each entry defines the *fully-folded* transfer
 * shape for a given amount ∈ [0, 1] — dry/wet mixing is done externally
 * via gain nodes around the shaper (so fold=0 actually bypasses the
 * WaveShaperNode entirely instead of relying on the curve being
 * locally-identity).
 *
 * `sample(amount, x)` maps x ∈ [-1, 1] → raw folded value; curves that
 * can exceed ±1 (buchla) are peak-normalized at bake time in
 * buildFoldCurve, so keep sample() as the raw math.
 *
 * See research/wavefolding-algorithms.md for derivations and sources.
 */
export const FOLD_TYPES = {
  sine: {
    id: 'sine',
    label: 'Sine',
    blurb: 'Smooth, glassy folds along a sine curve — gentle ripples that turn liquid and vocal as you push it.',
    // drive 1..4. No /drive amplitude normalization: sin is bounded to
    // [-1, 1], and the Bessel expansion of sin(z·sin(ωt)) shows total
    // RMS stays roughly constant across drive — energy redistributes
    // from fundamental into harmonics rather than disappearing.
    sample(amount, x) {
      const drive = 1 + amount * 3;
      return Math.sin(drive * Math.PI * x);
    },
  },
  triangle: {
    id: 'triangle',
    label: 'Triangle',
    blurb: 'Hard mirror reflections, Serge-style — sharp creases give a buzzy, aggressive edge.',
    // Ideal reflection fold: the driven signal is passed through a
    // period-4 unit triangle (identity on [-1, 1], reflected beyond).
    sample(amount, x) {
      const u = (1 + amount * 3) * x;
      const t = (u + 1) / 4;
      return 1 - 4 * Math.abs(t - Math.floor(t) - 0.5);
    },
  },
  buchla: {
    id: 'buchla',
    label: 'Buchla 259',
    blurb: 'Five staggered folding cells modeled on the Buchla 259 timbre circuit — folds bloom in one at a time as it climbs.',
    // Esqueda/Pöntynen/Välimäki/Parker DAFx-17, eqs. 13-18: five
    // parallel dead-zone+fold cells with staggered thresholds plus a
    // direct path. Input mapped to the model's volt domain so amount
    // sweeps from one engaged cell (±1 V) to all five (±7 V). Raw
    // output peaks in the tens of volts — normalized at bake time.
    sample(amount, x) {
      const v = (1 + amount * 6) * x;
      const s = Math.sign(v);
      const a = Math.abs(v);
      const V1 = a > 0.6 ? 0.8333 * v - 0.5 * s : 0;
      const V2 = a > 2.994 ? 0.3768 * v - 1.1281 * s : 0;
      const V3 = a > 5.46 ? 0.2829 * v - 1.5446 * s : 0;
      const V4 = a > 1.8 ? 0.5743 * v - 1.0338 * s : 0;
      const V5 = a > 4.08 ? 0.2673 * v - 1.0907 * s : 0;
      return -12.0 * V1 - 27.777 * V2 - 21.428 * V3
        + 17.647 * V4 + 36.363 * V5 + 5.0 * v;
    },
  },
};

export const FOLD_TYPE_IDS = Object.keys(FOLD_TYPES);
export const DEFAULT_FOLD_TYPE = 'sine';

/**
 * Bake the fully-folded curve for (type, amount) into a Float32Array,
 * peak-normalized to ±1 (a no-op for sine/triangle, required for
 * buchla whose raw output is in volts).
 */
export function buildFoldCurve(type, amount, size = CURVE_SIZE) {
  const def = FOLD_TYPES[type] || FOLD_TYPES[DEFAULT_FOLD_TYPE];
  const fold = Math.max(0, Math.min(1, amount));
  const curve = new Float32Array(size);
  let peak = 0;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const v = def.sample(fold, x);
    curve[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak > 1) {
    const scale = 1 / peak;
    for (let i = 0; i < size; i++) curve[i] *= scale;
  }
  return curve;
}

/** Lerp-lookup into a baked curve, x ∈ [-1, 1]. Mirrors the audio path. */
export function sampleFoldCurve(curve, x) {
  const clamped = Math.max(-1, Math.min(1, x));
  const idx = (clamped + 1) * 0.5 * (curve.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(curve.length - 1, i0 + 1);
  return curve[i0] + (curve[i1] - curve[i0]) * (idx - i0);
}

class Fold {
  constructor({ amount = 0, type = DEFAULT_FOLD_TYPE } = {}) {
    this.amount = Math.max(0, Math.min(1, amount));
    this.type = FOLD_TYPES[type] ? type : DEFAULT_FOLD_TYPE;
    this._listeners = new Set();
  }

  setAmount(v) {
    const next = Math.max(0, Math.min(1, v));
    if (next === this.amount) return;
    this.amount = next;
    this._notify();
  }

  setType(t) {
    if (!FOLD_TYPES[t] || t === this.type) return;
    this.type = t;
    this._notify();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (e) { console.error('fold listener error', e); }
    }
  }

  /**
   * Build the curve for the current type + amount and assign it to the
   * given WaveShaperNode. Sets oversample='4x' as the always-on default —
   * see research/waveshaping.md §3 for the aliasing analysis.
   */
  applyTo(shaper) {
    if (!shaper) return;
    shaper.curve = buildFoldCurve(this.type, this.amount);
    shaper.oversample = '4x';
  }
}

export const droneFold = new Fold({ amount: 0 });
export const keyboardFold = new Fold({ amount: 0 });

export default Fold;
