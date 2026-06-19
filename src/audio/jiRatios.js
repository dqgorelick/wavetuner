/**
 * Tuning system registry + nearest-candidate / step-candidate lookup.
 *
 * A "tuning system" is a named collection of pitch candidates that the
 * UI uses for three things:
 *   1. Ratio-column readout (nearest candidate label)
 *   2. Align (snap every drone to its nearest candidate)
 *   3. Per-row ↑/↓ stepping (walk to next / prev candidate)
 *
 * Systems come in two flavors:
 *   - octave-reducing: candidates live in [0, 1200)¢ and extend up/down
 *     by octaves. Includes all JI variants (5/7/11-limit, Pythagorean)
 *     and 12-TET.
 *   - non-octave-reducing: candidates span absolute cents. The harmonic
 *     series (1, 2, 3, 4, 5…) is the canonical example — walking ↑
 *     climbs through harmonics rather than wrapping at the octave.
 *
 * Candidate shape: { n, d, cents, label, kind } where (n, d) is the
 * exact fraction for rational systems and (null, null) for 12-TET
 * (cents only). `label` is the display string for the Ratio column.
 *
 * Default system = '5-limit' (classical Western JI, ~12 candidates per
 * octave). Switchable via the tuning panel dropdown.
 */

const ODD_LIMIT_FOR_PRIME = {
  5: 15,   // ~12 ratios — includes 15/8 and 16/15
  7: 9,    // ~18 ratios — adds septimal 7/4, 7/5, 7/6, 9/7, etc.
  11: 11,  // ~28 ratios — Partch undecimal territory
};

const PRIMES_BY_LIMIT = {
  5: [2, 3, 5],
  7: [2, 3, 5, 7],
  11: [2, 3, 5, 7, 11],
};

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

// Largest odd factor of n (strips all factors of 2).
function maxOddFactor(n) {
  let m = n;
  while (m % 2 === 0 && m > 0) m /= 2;
  return m;
}

// True if n's prime factors are all in `primes`.
function isSmooth(n, primes) {
  let m = n;
  for (const p of primes) {
    while (m % p === 0) m /= p;
  }
  return m === 1;
}

// Generate octave-reduced JI candidates for a given prime/odd limit pair.
// Returns sorted-by-cents array of { n, d, cents, label, kind } where
// 1 <= n/d < 2.
function generateJiCandidates(primeLimit, oddLimit, maxNum = 64) {
  const primes = PRIMES_BY_LIMIT[primeLimit];
  const seen = new Set();
  const out = [];
  for (let n = 1; n <= maxNum; n++) {
    for (let d = 1; d <= maxNum; d++) {
      if (gcd(n, d) !== 1) continue;
      const r = n / d;
      if (r < 1 || r >= 2) continue;
      const oddMax = Math.max(maxOddFactor(n), maxOddFactor(d));
      if (oddMax > oddLimit) continue;
      if (!isSmooth(n, primes) || !isSmooth(d, primes)) continue;
      const key = `${n}/${d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ n, d, cents: 1200 * Math.log2(r), label: `${n}/${d}`, kind: 'ji' });
    }
  }
  out.sort((a, b) => a.cents - b.cents);
  return out;
}

// Pythagorean (3-limit) by chain of fifths. stackDepth = number of
// fifths in each direction. stackDepth=6 → 13 octave-reduced tones
// (a chromatic Pythagorean scale, just shy of the Pythagorean comma
// closing the circle). Big numerators (243/128, 729/512) are by
// design — they're the price of fifths-only construction.
function generatePythagoreanCandidates(stackDepth = 6) {
  const seen = new Set();
  const out = [];
  for (let k = -stackDepth; k <= stackDepth; k++) {
    let n = k >= 0 ? Math.pow(3, k) : 1;
    let d = k < 0 ? Math.pow(3, -k) : 1;
    // Octave-reduce to [1, 2).
    let r = n / d;
    while (r >= 2) { d *= 2; r = n / d; }
    while (r < 1) { n *= 2; r = n / d; }
    const g = gcd(n, d);
    n = Math.round(n / g);
    d = Math.round(d / g);
    const key = `${n}/${d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ n, d, cents: 1200 * Math.log2(n / d), label: `${n}/${d}`, kind: 'pythagorean' });
  }
  out.sort((a, b) => a.cents - b.cents);
  return out;
}

// 12-TET (or n-TET) — equal-divisions-of-the-octave. No rational form;
// candidates carry cents only. Label is the cents value so the ratio
// column shows e.g. "100¢" instead of a fraction.
function generateTetCandidates(divisions = 12) {
  const step = 1200 / divisions;
  const out = [];
  for (let i = 0; i < divisions; i++) {
    const cents = i * step;
    out.push({
      n: null,
      d: null,
      cents,
      label: cents === 0 ? '0' : `${Math.round(cents)}¢`,
      kind: 'tet',
    });
  }
  return out;
}

// Harmonic series — 1/1, 2/1, 3/1, … up to maxN. NOT octave-reduced;
// these climb absolute cents (each step ~ a successively-narrower
// interval, mirroring the overtone series). Walking ↑ from 1/1 lands
// on 2/1 (octave), then 3/1 (octave+fifth), then 4/1 (two octaves)…
function generateHarmonicCandidates(maxN = 16) {
  const out = [];
  for (let n = 1; n <= maxN; n++) {
    out.push({
      n,
      d: 1,
      cents: 1200 * Math.log2(n),
      label: String(n),
      kind: 'harmonic',
    });
  }
  return out;
}

// ─── Tuning system registry ──────────────────────────────────────────

// Canonical scales per system — the ordered list of ratios that Load
// distributes voices across. Each entry is the "characteristic sound"
// of the system: enough degrees to fill a typical voice count without
// looking arbitrary. Voices beyond the scale length octave-extend for
// octave-reducing systems; harmonic series just keeps climbing.
//
// Each system carries TWO canonical arrays — a 7-note (diatonic /
// white-key) shape and a 12-note (chromatic) shape — selected at Load
// time by the user's "notes" toggle. For systems where 12-note JI has
// no single agreed form, the chromatic array reflects specific
// curatorial choices (see comments per system).
//
// Shape: array of either { n, d } (rational systems) or { cents }
// (12-TET — no clean fraction). The 1/1 / 0¢ degree must be first.

// 5-limit major scale (Ptolemy's intense diatonic).
const CANONICAL_5_LIMIT_7 = [
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 5, d: 4 }, { n: 4, d: 3 },
  { n: 3, d: 2 }, { n: 5, d: 3 }, { n: 15, d: 8 },
];
// 5-limit chromatic — "Ptolemaic" 12-tone JI. Tritone = 45/32 (sharp
// side, per user choice); minor 7th = 9/5. Internally consistent but
// contains a wolf somewhere — unavoidable in 5-limit 12-tone JI.
const CANONICAL_5_LIMIT_12 = [
  { n: 1, d: 1 }, { n: 16, d: 15 }, { n: 9, d: 8 }, { n: 6, d: 5 },
  { n: 5, d: 4 }, { n: 4, d: 3 }, { n: 45, d: 32 }, { n: 3, d: 2 },
  { n: 8, d: 5 }, { n: 5, d: 3 }, { n: 9, d: 5 }, { n: 15, d: 8 },
];
// 7-limit diatonic — swaps in 7/4 for the leading tone (septimal
// minor 7th) so the system's defining ratio appears in the 7-note set.
const CANONICAL_7_LIMIT_7 = [
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 5, d: 4 }, { n: 4, d: 3 },
  { n: 3, d: 2 }, { n: 5, d: 3 }, { n: 7, d: 4 },
];
// 7-limit chromatic — 5-limit chromatic with septimal substitutions
// at the slots where 7-limit ratios beat the 5-limit equivalents: 7/6
// for minor 3rd, 7/5 for tritone, 7/4 for minor 7th.
const CANONICAL_7_LIMIT_12 = [
  { n: 1, d: 1 }, { n: 16, d: 15 }, { n: 9, d: 8 }, { n: 7, d: 6 },
  { n: 5, d: 4 }, { n: 4, d: 3 }, { n: 7, d: 5 }, { n: 3, d: 2 },
  { n: 8, d: 5 }, { n: 5, d: 3 }, { n: 7, d: 4 }, { n: 15, d: 8 },
];
// 11-limit "diatonic" — Partch's 4:5:6:7:9:11 hexad, padded to 7 with
// 15/8 so notes=7 always gives a fully-populated 7-degree scale.
const CANONICAL_11_LIMIT_7 = [
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 5, d: 4 }, { n: 11, d: 8 },
  { n: 3, d: 2 }, { n: 7, d: 4 }, { n: 15, d: 8 },
];
// 11-limit chromatic — 7-limit chromatic with 11/8 substituted as the
// sole tritone (dropping 7/5) so 11 actually appears in the scale and
// only one tritone exists. Keeps the perfect 4th (4/3) intact, since
// that's a foundational interval not worth losing for an extra
// undecimal. 11-limit doesn't reduce cleanly to 12 (Partch went to 43);
// this is a curated subset.
const CANONICAL_11_LIMIT_12 = [
  { n: 1, d: 1 }, { n: 16, d: 15 }, { n: 9, d: 8 }, { n: 7, d: 6 },
  { n: 5, d: 4 }, { n: 4, d: 3 }, { n: 11, d: 8 }, { n: 3, d: 2 },
  { n: 8, d: 5 }, { n: 5, d: 3 }, { n: 7, d: 4 }, { n: 15, d: 8 },
];
// Pythagorean diatonic — chain of fifths up from 1/1.
const CANONICAL_PYTHAGOREAN_7 = [
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 81, d: 64 }, { n: 4, d: 3 },
  { n: 3, d: 2 }, { n: 27, d: 16 }, { n: 243, d: 128 },
];
// Pythagorean chromatic — 5 fifths up + 6 fifths down from 1/1,
// octave-reduced. Biased toward the "flat" side (per user choice), so
// the tritone is 1024/729 (~588¢) rather than 729/512 (~612¢).
const CANONICAL_PYTHAGOREAN_12 = [
  { n: 1, d: 1 }, { n: 256, d: 243 }, { n: 9, d: 8 }, { n: 32, d: 27 },
  { n: 81, d: 64 }, { n: 4, d: 3 }, { n: 1024, d: 729 }, { n: 3, d: 2 },
  { n: 128, d: 81 }, { n: 27, d: 16 }, { n: 16, d: 9 }, { n: 243, d: 128 },
];
// 12-TET diatonic — major scale at standard semitone offsets.
const CANONICAL_12_TET_7 = [
  { cents: 0 }, { cents: 200 }, { cents: 400 }, { cents: 500 },
  { cents: 700 }, { cents: 900 }, { cents: 1100 },
];
// 12-TET chromatic — all 12 semitones, 100¢ apart.
const CANONICAL_12_TET_12 = Array.from({ length: 12 }, (_, i) => ({ cents: i * 100 }));
// Harmonic series — n/1 for n = 1..16. NOT octave-reducing; notes=7
// gives the first 7 harmonics (1..7), notes=12 the first 12 (1..12).
// Voices beyond N=12 keep climbing into the upper harmonics.
const CANONICAL_HARMONIC = Array.from({ length: 16 }, (_, i) => ({ n: i + 1, d: 1 }));

// `recommendedScale` is the scale size (7 or 12) the system shows as
// its hint on the picker — Load applies it. The harmonic series'
// natural identity is "climb the overtones," so we default it to 12
// (harmonics 1-12); diatonic-leaning systems default to 7. 12-TET also
// defaults to 7 because the major scale is its idiomatic "load" — the
// user can flip to 12 to fill out a full chromatic.
export const TUNING_SYSTEMS = {
  '5-limit': {
    key: '5-limit',
    label: '5-limit JI',
    description: '2-3-5 primes — classical Western thirds & fifths',
    octaveReduced: true,
    generate: () => generateJiCandidates(5, ODD_LIMIT_FOR_PRIME[5]),
    canonical7: CANONICAL_5_LIMIT_7,
    canonical12: CANONICAL_5_LIMIT_12,
    recommendedScale: 7,
  },
  '7-limit': {
    key: '7-limit',
    label: '7-limit JI',
    description: 'adds 7th prime — septimal "blue note" intervals',
    octaveReduced: true,
    generate: () => generateJiCandidates(7, ODD_LIMIT_FOR_PRIME[7]),
    canonical7: CANONICAL_7_LIMIT_7,
    canonical12: CANONICAL_7_LIMIT_12,
    recommendedScale: 7,
  },
  '11-limit': {
    key: '11-limit',
    label: '11-limit JI',
    description: 'adds 11th prime — Partch undecimal territory',
    octaveReduced: true,
    generate: () => generateJiCandidates(11, ODD_LIMIT_FOR_PRIME[11]),
    canonical7: CANONICAL_11_LIMIT_7,
    canonical12: CANONICAL_11_LIMIT_12,
    recommendedScale: 12,
  },
  'pythagorean': {
    key: 'pythagorean',
    label: 'Pythagorean',
    description: '3-limit chain of fifths — no thirds (5)',
    octaveReduced: true,
    generate: () => generatePythagoreanCandidates(6),
    canonical7: CANONICAL_PYTHAGOREAN_7,
    canonical12: CANONICAL_PYTHAGOREAN_12,
    recommendedScale: 7,
  },
  '12-tet': {
    key: '12-tet',
    label: 'Equal temperament',
    description: 'equal temperament — 12 equal semitones per octave',
    octaveReduced: true,
    generate: () => generateTetCandidates(12),
    canonical7: CANONICAL_12_TET_7,
    canonical12: CANONICAL_12_TET_12,
    recommendedScale: 7,
  },
  'harmonic': {
    key: 'harmonic',
    label: 'Harmonic series',
    description: '1, 2, 3, 4, 5… — climbs the overtone series',
    octaveReduced: false,
    generate: () => generateHarmonicCandidates(16),
    canonical7: CANONICAL_HARMONIC,
    canonical12: CANONICAL_HARMONIC,
    recommendedScale: 12,
  },
};

// Resolve the canonical scale array for a system + scale-size choice.
// Falls back to whichever array exists if the requested size isn't
// defined (defensive — every registered system carries both).
export function canonicalScale(system, scaleSize) {
  if (!system) return null;
  const size = scaleSize === 7 ? 7 : 12;
  return size === 7 ? (system.canonical7 || system.canonical12)
                    : (system.canonical12 || system.canonical7);
}

export const SUPPORTED_SYSTEMS = Object.keys(TUNING_SYSTEMS);
export const DEFAULT_SYSTEM = '5-limit';

// Cache candidate sets — generation is cheap but called per-frame from
// the ratio readout. Lazy + memoized so any future user-configurable
// system (e.g. custom n-TET) re-generates on demand.
const CANDIDATE_CACHE = {};

export function getCandidates(systemKey) {
  const sys = TUNING_SYSTEMS[systemKey] || TUNING_SYSTEMS[DEFAULT_SYSTEM];
  if (!CANDIDATE_CACHE[sys.key]) {
    CANDIDATE_CACHE[sys.key] = sys.generate();
  }
  return CANDIDATE_CACHE[sys.key];
}

export function getSystem(systemKey) {
  return TUNING_SYSTEMS[systemKey] || TUNING_SYSTEMS[DEFAULT_SYSTEM];
}

/**
 * Return the ratio (a Hz-multiplier number) for the i-th voice in the
 * canonical scale of the given system. For octave-reducing systems,
 * voices past the scale length get multiplied by 2^k so each extra
 * voice climbs an octave at a time. For harmonic series, voices past
 * the scale length (16) extend by re-using the highest harmonic (the
 * call site won't normally hit this since voice count is capped at 12).
 *
 * `scaleSize` chooses the 7-note (diatonic) or 12-note (chromatic)
 * canonical for the system. Defaults to the system's recommended size.
 *
 * Returns null if the system has no canonical scale defined.
 */
export function canonicalRatioForVoice(systemKey, degreeIdx, scaleSize) {
  const sys = getSystem(systemKey);
  const size = scaleSize === 7 || scaleSize === 12
    ? scaleSize
    : (sys.recommendedScale || 7);
  const scale = canonicalScale(sys, size);
  if (!scale || scale.length === 0) return null;
  if (degreeIdx < 0) return null;

  if (sys.octaveReduced) {
    // Walk through the scale, wrapping every `scale.length` indices to
    // the start while multiplying by 2 (next octave up).
    const octave = Math.floor(degreeIdx / scale.length);
    const inScale = scale[degreeIdx % scale.length];
    if (inScale.cents != null) {
      return Math.pow(2, (inScale.cents + octave * 1200) / 1200);
    }
    return (inScale.n / inScale.d) * Math.pow(2, octave);
  }
  // Harmonic series — no octave wrap, climb the harmonics directly.
  const cap = scale.length - 1;
  const idx = Math.min(degreeIdx, cap);
  const cand = scale[idx];
  return cand.n / cand.d;
}

// ─── Back-compat shims (old prime-limit numeric API) ─────────────────

// Map legacy numeric limits to the new string keys. Kept for callers
// that pass 5/7/11; new code should use system keys directly.
const LEGACY_LIMIT_TO_SYSTEM = { 5: '5-limit', 7: '7-limit', 11: '11-limit' };
export const SUPPORTED_LIMITS = [5, 7, 11];
export const DEFAULT_LIMIT = 7;

function resolveSystemKey(arg) {
  if (typeof arg === 'string') return TUNING_SYSTEMS[arg] ? arg : DEFAULT_SYSTEM;
  if (typeof arg === 'number') return LEGACY_LIMIT_TO_SYSTEM[arg] || DEFAULT_SYSTEM;
  return DEFAULT_SYSTEM;
}

export function ratioToCents(r) {
  return 1200 * Math.log2(r);
}

/**
 * For a target ratio (in any octave), find the nearest candidate in
 * the given tuning system. Returns { n, d, octave, candidateCents,
 * offsetCents, halfGapPos, halfGapNeg, label, kind }.
 *
 * Accepts either a system key string ('5-limit', '12-tet', etc.) or a
 * legacy numeric limit (5, 7, 11).
 *
 * For octave-reducing systems, the input ratio is octave-reduced into
 * [0, 1200)¢ and the candidate index + octave together reconstruct it.
 * For non-octave-reducing systems (harmonic), the scan happens in
 * absolute cents and `octave` is always 0.
 */
export function nearestRatio(targetRatio, systemArg = DEFAULT_SYSTEM) {
  if (!Number.isFinite(targetRatio) || targetRatio <= 0) return null;
  const systemKey = resolveSystemKey(systemArg);
  const sys = getSystem(systemKey);
  const candidates = getCandidates(systemKey);
  if (candidates.length === 0) return null;

  const inputCents = 1200 * Math.log2(targetRatio);

  if (!sys.octaveReduced) {
    // Absolute scan — for harmonic series. Octave is meaningless here
    // (each candidate already occupies its own absolute pitch).
    let bestIdx = 0;
    let bestDist = Math.abs(candidates[0].cents - inputCents);
    for (let i = 1; i < candidates.length; i++) {
      const d = Math.abs(candidates[i].cents - inputCents);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const cand = candidates[bestIdx];
    const offsetCents = inputCents - cand.cents;
    // Gap to neighbors — clamp ends at half the candidate spacing of
    // the adjacent step. (Past the last harmonic, distance grows
    // unbounded; clamp via mirroring the last-known gap.)
    const lastGap = candidates.length > 1
      ? candidates[candidates.length - 1].cents - candidates[candidates.length - 2].cents
      : 1200;
    const prevCents = bestIdx === 0 ? cand.cents - lastGap : candidates[bestIdx - 1].cents;
    const nextCents = bestIdx === candidates.length - 1
      ? cand.cents + lastGap
      : candidates[bestIdx + 1].cents;
    return {
      n: cand.n,
      d: cand.d,
      octave: 0,
      candidateCents: cand.cents,
      offsetCents,
      halfGapPos: (nextCents - cand.cents) / 2,
      halfGapNeg: (cand.cents - prevCents) / 2,
      label: cand.label,
      kind: cand.kind,
    };
  }

  const octave = Math.floor(inputCents / 1200);
  const reducedCents = inputCents - octave * 1200;

  // Linear scan — candidate counts are <30, faster than worrying about
  // binary search and the octave-wrap edge case.
  let bestIdx = 0;
  let bestDist = Math.abs(candidates[0].cents - reducedCents);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(candidates[i].cents - reducedCents);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  // Wrap-around: 1/1 in the next octave up sits at 1200¢ — closer than
  // a candidate at, say, 1088¢ when input is at 1190¢.
  const wrapDist = Math.abs(1200 - reducedCents);
  let octaveAdj = 0;
  if (wrapDist < bestDist) {
    bestIdx = 0;
    bestDist = wrapDist;
    octaveAdj = 1;
  }

  const cand = candidates[bestIdx];
  const finalOctave = octave + octaveAdj;
  const candCentsAbs = cand.cents + finalOctave * 1200;
  const offsetCents = inputCents - candCentsAbs;

  // Neighbor gaps (octave-wrapped). The midpoint between this candidate
  // and the next/prev candidate defines where the dim arc reaches 0.
  const prevCents = bestIdx === 0
    ? candidates[candidates.length - 1].cents - 1200
    : candidates[bestIdx - 1].cents;
  const nextCents = bestIdx === candidates.length - 1
    ? candidates[0].cents + 1200
    : candidates[bestIdx + 1].cents;
  const halfGapPos = (nextCents - cand.cents) / 2;
  const halfGapNeg = (cand.cents - prevCents) / 2;

  return {
    n: cand.n,
    d: cand.d,
    octave: finalOctave,
    candidateCents: cand.cents,
    offsetCents,
    halfGapPos,
    halfGapNeg,
    label: cand.label,
    kind: cand.kind,
  };
}

/**
 * Step the current ratio to the next or previous candidate in the
 * given system. Returns { ratio, n, d, cents, label, kind } where
 *   - `ratio` is the new multiplier relative to anchor (a number,
 *     ready to multiply by anchorHz)
 *   - `n, d` are the displayed fraction for rational systems, both
 *     null for 12-TET
 *   - `cents` is the new absolute cents value (signed)
 *
 * Behavior:
 *   - If `currentRatio` already sits within EXACT_CENTS_TOLERANCE of a
 *     candidate, step by ±1 candidate from there (handling octave wrap
 *     for octave-reducing systems).
 *   - If `currentRatio` is drifted, "first press" snaps to the nearest
 *     candidate in the requested direction (the user's first ↑ press
 *     tidies up; the second moves them along).
 *
 * Returns null when the system is empty or input is invalid.
 */
export function stepCandidate(currentRatio, systemArg, direction) {
  if (direction !== 1 && direction !== -1) return null;
  if (!Number.isFinite(currentRatio) || currentRatio <= 0) return null;
  const systemKey = resolveSystemKey(systemArg);
  const sys = getSystem(systemKey);
  const candidates = getCandidates(systemKey);
  if (candidates.length === 0) return null;

  const inputCents = 1200 * Math.log2(currentRatio);

  if (!sys.octaveReduced) {
    // Harmonic-series-style stepping in absolute cents. No octave wrap;
    // off the top of the list we clamp to the last candidate.
    let bestIdx = 0;
    let bestDist = Math.abs(candidates[0].cents - inputCents);
    for (let i = 1; i < candidates.length; i++) {
      const d = Math.abs(candidates[i].cents - inputCents);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const drift = inputCents - candidates[bestIdx].cents;
    const onCandidate = Math.abs(drift) <= EXACT_CENTS_TOLERANCE;

    let nextIdx;
    if (onCandidate) {
      nextIdx = bestIdx + direction;
    } else if (direction === 1) {
      // Snap to the first candidate strictly above current cents.
      nextIdx = drift < 0 ? bestIdx : bestIdx + 1;
    } else {
      nextIdx = drift > 0 ? bestIdx : bestIdx - 1;
    }
    nextIdx = Math.max(0, Math.min(candidates.length - 1, nextIdx));
    const cand = candidates[nextIdx];
    return {
      ratio: Math.pow(2, cand.cents / 1200),
      n: cand.n,
      d: cand.d,
      cents: cand.cents,
      label: cand.label,
      kind: cand.kind,
    };
  }

  // Octave-reducing path. Find nearest candidate in [0,1200) within
  // the current octave, then step. Octave wrap rolls to the next
  // octave's first candidate, or the previous octave's last.
  const octave = Math.floor(inputCents / 1200);
  const reducedCents = inputCents - octave * 1200;
  let bestIdx = 0;
  let bestDist = Math.abs(candidates[0].cents - reducedCents);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(candidates[i].cents - reducedCents);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  // Check wrap-around — 1/1 at next octave might be closer than the
  // top candidate within this octave.
  let curOctave = octave;
  const wrapDist = Math.abs(1200 - reducedCents);
  if (wrapDist < bestDist) {
    bestIdx = 0;
    curOctave = octave + 1;
    bestDist = wrapDist;
  }

  const drift = reducedCents - candidates[bestIdx].cents
    - (curOctave === octave + 1 ? 1200 : 0);
  const onCandidate = Math.abs(drift) <= EXACT_CENTS_TOLERANCE;

  let nextIdx = bestIdx;
  let nextOctave = curOctave;

  if (onCandidate) {
    nextIdx = bestIdx + direction;
    if (nextIdx >= candidates.length) { nextIdx = 0; nextOctave += 1; }
    else if (nextIdx < 0) { nextIdx = candidates.length - 1; nextOctave -= 1; }
  } else if (direction === 1) {
    // Snap to first candidate strictly above current cents.
    if (drift < 0) {
      // bestIdx is already above current — go there.
      nextIdx = bestIdx;
      nextOctave = curOctave;
    } else {
      nextIdx = bestIdx + 1;
      if (nextIdx >= candidates.length) { nextIdx = 0; nextOctave += 1; }
    }
  } else {
    if (drift > 0) {
      nextIdx = bestIdx;
      nextOctave = curOctave;
    } else {
      nextIdx = bestIdx - 1;
      if (nextIdx < 0) { nextIdx = candidates.length - 1; nextOctave -= 1; }
    }
  }

  const cand = candidates[nextIdx];
  const absCents = cand.cents + nextOctave * 1200;
  // For rational systems, extend n/d into the target octave so the
  // displayed fraction matches what the lock will store.
  let n = cand.n;
  let d = cand.d;
  if (n != null && d != null) {
    const ext = extendOctaves(n, d, nextOctave);
    n = ext.n;
    d = ext.d;
  }
  return {
    ratio: Math.pow(2, absCents / 1200),
    n,
    d,
    cents: absCents,
    label: cand.label,
    kind: cand.kind,
  };
}

/**
 * Extend an octave-reduced n/d into the given octave and reduce. Returns
 * { n, d } in lowest terms — e.g., (3/2, octave=1) -> 3/1; (5/4, -1) ->
 * 5/8. Display formatter elsewhere decides whether to show "3" or "3/1".
 */
export function extendOctaves(n, d, octave) {
  let num = n, den = d;
  if (octave > 0) num *= Math.pow(2, octave);
  else if (octave < 0) den *= Math.pow(2, -octave);
  const g = gcd(num, den);
  return { n: Math.round(num / g), d: Math.round(den / g) };
}

/**
 * Compute display opacity for a ratio that's offset by `offsetCents`
 * from its nearest candidate. Opacity tapers linearly from 1.0 at the
 * candidate to 0.0 at the midpoint to the neighbor on the appropriate
 * side. Pass halfGapPos when offset > 0, halfGapNeg when offset < 0.
 *
 * The result is clamped to [minOpacity, 1.0] so dim ratios stay
 * faintly readable rather than vanishing entirely — feels better than
 * a hard pop-out at the midpoint.
 */
export function offsetToOpacity(offsetCents, halfGapPos, halfGapNeg, minOpacity = 0.18) {
  const half = offsetCents >= 0 ? halfGapPos : halfGapNeg;
  if (!half || half <= 0) return 1;
  const t = Math.min(1, Math.abs(offsetCents) / half);
  return Math.max(minOpacity, 1 - t);
}

// "On" tolerance for the underline cue — within ±this many cents of the
// candidate, we render the ratio underlined as "exact". 1.5¢ is below
// the perception threshold for sustained tones but generous enough that
// floating-point round-trips through Hz don't lose the underline.
export const EXACT_CENTS_TOLERANCE = 1.5;
