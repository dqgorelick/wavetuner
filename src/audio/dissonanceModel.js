/**
 * dissonanceModel — Sethares / Plomp-Levelt sensory-dissonance kernel.
 *
 * Single source of truth for the roughness math so the live FFT meter
 * (AudioFeatures) and the predictive spectrum-bar HUD (FrequencySpectrumBar)
 * can never disagree. The pairwise model and constants here were lifted
 * verbatim from AudioFeatures' original inline implementation.
 *
 * Model: d(x) = e^(-A·x) − e^(-B·x), where x is the frequency difference
 * between two partials scaled by the critical bandwidth at the lower
 * frequency. Peaks near x ≈ 0.22; zero at unison and at wide separation.
 * Amplitude weighting uses min(a1, a2) (Sethares' preferred form). The
 * result is peak-normalized so a maximally-rough pair of unit-amplitude
 * partials contributes 1.0.
 *
 * See research/dissonance-curves.md for the derivation and the mapping to
 * Sethares' canonical constants.
 */

// Difference-of-exponentials roughness shape. A/B match Sethares A1/A2.
export const DISS_A = 3.5;
export const DISS_B = 5.75;

// Roughness peaks at x ≈ 0.221 critical-bandwidths of separation; divide
// by the peak value so a single worst-case pair maxes out at 1.0.
const _PEAK = Math.exp(-DISS_A * 0.221) - Math.exp(-DISS_B * 0.221);

// Critical bandwidth as a power law of frequency (Sethares book appendix
// form). Wider at high frequencies, so the same interval reads smoother up
// top and rougher down low — handled for free by passing real Hz.
export function criticalBandwidth(f) {
  return 1.72 * Math.pow(f, 0.65);
}

/**
 * Roughness contributed by a single pair of partials. f1/f2 in Hz,
 * a1/a2 are linear amplitudes. Returns 0..1 (peak-normalized).
 */
export function pairDissonance(f1, f2, a1, a2) {
  const fMin = Math.min(f1, f2);
  const cb = criticalBandwidth(fMin);
  const x = Math.abs(f1 - f2) / cb;
  const d = Math.exp(-DISS_A * x) - Math.exp(-DISS_B * x);
  return Math.min(a1, a2) * d / _PEAK;
}

/**
 * Total roughness a probe partial at `freq` (unit amplitude) would
 * create against a frozen background of partials. `background` is an
 * array of { f, a } where f is Hz and a is linear amplitude.
 *
 * This is the sine-world "where can I land" field: sweep `freq` across
 * the pitch axis and the minima are the consonant landing spots against
 * the current chord. O(background.length) per evaluation — cheap enough
 * to sample per screen-pixel every frame.
 */
export function fieldDissonance(freq, background) {
  let d = 0;
  for (let i = 0; i < background.length; i++) {
    const b = background[i];
    d += pairDissonance(freq, b.f, 1, b.a);
  }
  return d;
}
