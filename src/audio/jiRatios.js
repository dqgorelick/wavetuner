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
// Shape: array of either { n, d } (rational systems) or { cents }
// (12-TET — no clean fraction). The 1/1 / 0¢ degree must be first.
const CANONICAL_5_LIMIT = [
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 5, d: 4 }, { n: 4, d: 3 },
  { n: 3, d: 2 }, { n: 5, d: 3 }, { n: 15, d: 8 },
];
const CANONICAL_7_LIMIT = [
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 5, d: 4 }, { n: 4, d: 3 },
  { n: 3, d: 2 }, { n: 5, d: 3 }, { n: 7, d: 4 },
];
const CANONICAL_11_LIMIT = [
  // Partch's 4:5:6:7:9:11 hexad — the canonical "11-limit chord"
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 5, d: 4 }, { n: 11, d: 8 },
  { n: 3, d: 2 }, { n: 7, d: 4 },
];
const CANONICAL_PYTHAGOREAN = [
  { n: 1, d: 1 }, { n: 9, d: 8 }, { n: 81, d: 64 }, { n: 4, d: 3 },
  { n: 3, d: 2 }, { n: 27, d: 16 }, { n: 243, d: 128 },
];
const CANONICAL_12_TET = [
  { cents: 0 }, { cents: 200 }, { cents: 400 }, { cents: 500 },
  { cents: 700 }, { cents: 900 }, { cents: 1100 },
];
// Harmonic series — n/1 for n = 1..16. Voices beyond the 16th harmonic
// would need to extend the list; in practice voice count caps at 12.
const CANONICAL_HARMONIC = Array.from({ length: 16 }, (_, i) => ({ n: i + 1, d: 1 }));

export const TUNING_SYSTEMS = {
  '5-limit': {
    key: '5-limit',
    label: '5-limit JI',
    description: '2-3-5 primes — classical Western thirds & fifths',
    octaveReduced: true,
    generate: () => generateJiCandidates(5, ODD_LIMIT_FOR_PRIME[5]),
    canonical: CANONICAL_5_LIMIT,
  },
  '7-limit': {
    key: '7-limit',
    label: '7-limit JI',
    description: 'adds 7th prime — septimal "blue note" intervals',
    octaveReduced: true,
    generate: () => generateJiCandidates(7, ODD_LIMIT_FOR_PRIME[7]),
    canonical: CANONICAL_7_LIMIT,
  },
  '11-limit': {
    key: '11-limit',
    label: '11-limit JI',
    description: 'adds 11th prime — Partch undecimal territory',
    octaveReduced: true,
    generate: () => generateJiCandidates(11, ODD_LIMIT_FOR_PRIME[11]),
    canonical: CANONICAL_11_LIMIT,
  },
  'pythagorean': {
    key: 'pythagorean',
    label: 'Pythagorean',
    description: '3-limit chain of fifths — no thirds (5)',
    octaveReduced: true,
    generate: () => generatePythagoreanCandidates(6),
    canonical: CANONICAL_PYTHAGOREAN,
  },
  '12-tet': {
    key: '12-tet',
    label: '12-TET',
    description: 'equal temperament — 12 equal semitones per octave',
    octaveReduced: true,
    generate: () => generateTetCandidates(12),
    canonical: CANONICAL_12_TET,
  },
  'harmonic': {
    key: 'harmonic',
    label: 'Harmonic series',
    description: '1, 2, 3, 4, 5… — climbs the overtone series',
    octaveReduced: false,
    generate: () => generateHarmonicCandidates(16),
    canonical: CANONICAL_HARMONIC,
  },
};

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
 * Returns null if the system has no canonical scale defined.
 */
export function canonicalRatioForVoice(systemKey, degreeIdx) {
  const sys = getSystem(systemKey);
  const scale = sys.canonical;
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
