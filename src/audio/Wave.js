/**
 * Wave - per-pool waveform morph (sine → triangle → saw → square).
 *
 * Replaces the default sine OscillatorNode with one driven by
 * setPeriodicWave. Position p ∈ [0, 3] interpolates linearly between
 * four anchor shapes' Fourier coefficients:
 *   p=0 sine, p=1 triangle, p=2 sawtooth, p=3 square.
 *
 * The user's originally-proposed reverse-saw segment was dropped: the
 * lerp between saw and reverse-saw passes through silence at the
 * midpoint (their coefficients cancel). See research/waveshaping.md §2.
 *
 * Two singletons: droneWave (used by AudioEngine) and keyboardWave
 * (used by KeyboardVoiceManager). Each pool subscribes to onChange so
 * a slider drag rebuilds the wave and re-applies it to every running
 * oscillator. PeriodicWave objects are cached by quantized position
 * so a slider sweep doesn't allocate on every pixel of motion.
 */

const HARMONICS = 64;       // Web Audio band-limits per-pitch above this
const POSITION_SLOTS = 60;  // 0.05 quantization across [0, 3]
const POSITION_MAX = 3;

// Pre-compute Fourier sine coefficients for the four anchor shapes.
// All shapes peak ±1, are 2π-periodic, and odd. Index 0 unused
// (createPeriodicWave's convention — coeffs are b₁..b_HARMONICS).
const ANCHOR_COEFFS = (() => {
  const N = HARMONICS;
  const sine = new Float32Array(N + 1);
  const tri  = new Float32Array(N + 1);
  const saw  = new Float32Array(N + 1);
  const sqr  = new Float32Array(N + 1);

  sine[1] = 1;

  // Triangle: 8/π² · (-1)^((n-1)/2) / n²  for odd n
  const triK = 8 / (Math.PI * Math.PI);
  for (let n = 1; n <= N; n += 2) {
    const sign = ((n - 1) / 2) % 2 === 0 ? 1 : -1;
    tri[n] = triK * sign / (n * n);
  }

  // Sawtooth: 2/π · (-1)^(n+1) / n  for all n ≥ 1
  const sawK = 2 / Math.PI;
  for (let n = 1; n <= N; n++) {
    const sign = (n + 1) % 2 === 0 ? 1 : -1;
    saw[n] = sawK * sign / n;
  }

  // Square: 4/π · 1/n  for odd n
  const sqrK = 4 / Math.PI;
  for (let n = 1; n <= N; n += 2) {
    sqr[n] = sqrK / n;
  }

  return [sine, tri, saw, sqr];
})();

// Interpolate the four anchors at position p ∈ [0, 3]. Returns a fresh
// Float32Array(HARMONICS + 1) of sine coefficients for createPeriodicWave.
function shapeCoeffs(p) {
  const clamped = Math.max(0, Math.min(POSITION_MAX, p));
  const seg = Math.min(2, Math.floor(clamped));
  const t = clamped - seg;
  const a = ANCHOR_COEFFS[seg];
  const c = ANCHOR_COEFFS[seg + 1];
  const out = new Float32Array(HARMONICS + 1);
  for (let n = 1; n <= HARMONICS; n++) {
    out[n] = a[n] * (1 - t) + c[n] * t;
  }
  return out;
}

class Wave {
  constructor({ position = 0 } = {}) {
    this.position = Math.max(0, Math.min(POSITION_MAX, position));
    this._listeners = new Set();
    // Cached PeriodicWave objects keyed by `${audioContext-id}:${slot}`
    // so rebuilds during a slider drag are pointer lookups, not Fourier
    // recomputes. The audioContext-id is the AudioContext object itself
    // (we use a WeakMap so contexts can be GC'd).
    this._cache = new WeakMap();  // ctx → Map<slot, PeriodicWave>
  }

  setPosition(p) {
    const v = Math.max(0, Math.min(POSITION_MAX, p));
    if (v === this.position) return;
    this.position = v;
    this._notify();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (e) { console.error('wave listener error', e); }
    }
  }

  /**
   * Return a (cached) PeriodicWave for the current position, built in
   * the given AudioContext. Quantization to POSITION_SLOTS keeps the
   * cache small (~60 entries per context).
   */
  getPeriodicWave(ctx) {
    if (!ctx) return null;
    const slot = Math.round(this.position * (POSITION_SLOTS / POSITION_MAX));
    let perCtx = this._cache.get(ctx);
    if (!perCtx) {
      perCtx = new Map();
      this._cache.set(ctx, perCtx);
    }
    let wave = perCtx.get(slot);
    if (!wave) {
      const slotPosition = (slot * POSITION_MAX) / POSITION_SLOTS;
      const sine = shapeCoeffs(slotPosition);
      const real = new Float32Array(HARMONICS + 1);
      wave = ctx.createPeriodicWave(real, sine, { disableNormalization: false });
      perCtx.set(slot, wave);
    }
    return wave;
  }
}

export const droneWave = new Wave({ position: 0 });
export const keyboardWave = new Wave({ position: 0 });

// Anchor names for UI labels — index matches the 0..3 position range.
export const WAVE_ANCHOR_NAMES = ['sine', 'triangle', 'saw', 'square'];

export default Wave;
