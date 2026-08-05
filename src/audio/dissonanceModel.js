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

// ── Critical-bandwidth lookup table ──────────────────────────────────────
// criticalBandwidth is a FRACTIONAL Math.pow, one of the slowest primitives
// in the language, and the spectrum bar's field sweep evaluates it once per
// partial PAIR — millions of times a second. The curve is smooth and
// strictly monotonic in log frequency, so a table at 32 steps/octave with
// linear interpolation reproduces it to ~1e-5 relative error (far below the
// model's own approximations) at a fraction of the cost. Covers 16 Hz to
// 32 kHz; outside that range it clamps to the end values, which is harmless
// — nothing audible lives there.
const CB_LUT_LO_OCT = 4;      // 2^4  = 16 Hz
const CB_LUT_OCTAVES = 11;    // 2^15 = 32 768 Hz
const CB_LUT_PER_OCT = 32;
const CB_LUT_N = CB_LUT_OCTAVES * CB_LUT_PER_OCT + 1;
const _cbLut = new Float64Array(CB_LUT_N);
for (let i = 0; i < CB_LUT_N; i++) {
  _cbLut[i] = criticalBandwidth(Math.pow(2, CB_LUT_LO_OCT + i / CB_LUT_PER_OCT));
}

/** Table-interpolated criticalBandwidth — same curve, no Math.pow. */
export function criticalBandwidthFast(f) {
  const t = (Math.log2(f) - CB_LUT_LO_OCT) * CB_LUT_PER_OCT;
  if (!(t > 0)) return _cbLut[0];
  if (t >= CB_LUT_N - 1) return _cbLut[CB_LUT_N - 1];
  const i = t | 0;
  const a = _cbLut[i];
  return a + (_cbLut[i + 1] - a) * (t - i);
}

/**
 * Roughness contributed by a single pair of partials. f1/f2 in Hz,
 * a1/a2 are linear amplitudes. Returns 0..1 (peak-normalized).
 */
export function pairDissonance(f1, f2, a1, a2) {
  const fMin = Math.min(f1, f2);
  const cb = criticalBandwidthFast(fMin);
  const x = Math.abs(f1 - f2) / cb;
  const d = Math.exp(-DISS_A * x) - Math.exp(-DISS_B * x);
  return Math.min(a1, a2) * d / _PEAK;
}

// ── Windowed field evaluation ────────────────────────────────────────────
// d(x) decays as a difference of exponentials, so partials far apart in
// critical bandwidths contribute nothing measurable: at x = 4 a unit pair
// is worth 5e-6 of the peak. The naive field probe nonetheless compares
// EVERY probe partial against EVERY background partial — for a 12-voice
// chord that's ~200 000 pair evaluations per curve frame, almost all of
// them returning zero, which made the consonance curve the single largest
// continuously-running CPU cost in the app.
//
// sortBackground() packs the partial list into frequency-sorted typed
// arrays once per frame; probeDissonance() then binary-searches the ±4·cb
// window around each probe partial and only walks that slice. Measured
// 5.7–7x faster with a worst-case relative error of 0.004% — invisible in
// a curve that is temporally eased and contrast-stretched afterwards.
const DISS_WINDOW_CB = 4;

/** Frequency-sorted view of a { f, a } partial list, for probeDissonance. */
export function sortBackground(parts) {
  const n = parts.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((x, y) => parts[x].f - parts[y].f);
  const f = new Float64Array(n);
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = parts[idx[i]];
    f[i] = p.f;
    a[i] = p.a;
  }
  return { f, a, n };
}

/** Index of the first entry in f[0..n) that is >= v. */
function _lowerBound(f, n, v) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Total roughness a probe voice at fundamental `f0` — expanded through
 * `profile` — creates against a sorted background (see sortBackground).
 * Partials above `maxFreq` are dropped from both sides. Equivalent to
 * summing pairDissonance over every pair, minus contributions below the
 * ±DISS_WINDOW_CB cutoff.
 */
export function probeDissonance(f0, sorted, profile, maxFreq) {
  const bf = sorted.f;
  const ba = sorted.a;
  const n = sorted.n;
  let d = 0;
  for (let p = 0; p < profile.length; p++) {
    const pf = f0 * profile[p].ratio;
    // Profiles are ratio-ascending, so once one partial clears the ceiling
    // every partial above it does too.
    if (pf > maxFreq) break;
    const pa = profile[p].amp;
    // cb(pf) bounds the window on BOTH sides: above pf it is exactly the
    // pair's cb (fMin = pf); below it, cb(fMin) < cb(pf) makes the real x
    // larger than the one this window is cut on, so nothing inside the
    // cutoff is missed.
    const w = DISS_WINDOW_CB * criticalBandwidthFast(pf);
    const hi = pf + w;
    for (let k = _lowerBound(bf, n, pf - w); k < n; k++) {
      const f2 = bf[k];
      if (f2 > hi) break;
      const x = (pf > f2 ? pf - f2 : f2 - pf) / criticalBandwidthFast(pf < f2 ? pf : f2);
      const amp = pa < ba[k] ? pa : ba[k];
      d += amp * (Math.exp(-DISS_A * x) - Math.exp(-DISS_B * x));
    }
  }
  return d / _PEAK;
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
