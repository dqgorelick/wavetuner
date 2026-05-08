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
 * Build a pure sine-fold curve for the given fold amount ∈ [0, 1].
 * Returns the *fully-folded* shape — dry/wet mixing is done externally
 * via gain nodes around the shaper (so fold=0 actually bypasses the
 * WaveShaperNode entirely instead of relying on the curve being
 * locally-identity).
 *
 * - amount=0 → drive=1 → sin(πx) (one half-period; dry/wet keeps this muted)
 * - amount=1 → drive=4 → sin(4πx) (3 folds per side)
 *
 * No /drive amplitude normalization: sin is already bounded to [-1, 1],
 * and Bessel expansion of sin(z·sin(ωt)) shows total RMS stays roughly
 * constant across drive — energy redistributes from fundamental into
 * harmonics rather than disappearing.
 */
export function buildSineFold(amount, size = CURVE_SIZE) {
  const fold = Math.max(0, Math.min(1, amount));
  const drive = 1 + fold * 3; // 1..4
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.sin(drive * Math.PI * x);
  }
  return curve;
}

class Fold {
  constructor({ amount = 0 } = {}) {
    this.amount = Math.max(0, Math.min(1, amount));
    this._listeners = new Set();
  }

  setAmount(v) {
    const next = Math.max(0, Math.min(1, v));
    if (next === this.amount) return;
    this.amount = next;
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
   * Build the curve for the current amount and assign it to the given
   * WaveShaperNode. Sets oversample='4x' as the always-on default —
   * see research/waveshaping.md §3 for the aliasing analysis.
   */
  applyTo(shaper) {
    if (!shaper) return;
    shaper.curve = buildSineFold(this.amount);
    shaper.oversample = '4x';
  }
}

export const droneFold = new Fold({ amount: 0 });
export const keyboardFold = new Fold({ amount: 0 });

export default Fold;
