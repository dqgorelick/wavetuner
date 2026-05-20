/**
 * Just Intonation ratio candidate sets + nearest-ratio lookup.
 *
 * Used by the frequency manager's Ratio column to render the closest
 * named ratio (relative to the anchor slot) plus the cents offset from
 * that ratio. The "limit" selector (5 / 7 / 11) controls how dense the
 * candidate set is — sparser sets give more stable labels as the user
 * drags; denser sets cover more JI corners (septimal, undecimal).
 *
 * Each candidate set is octave-reduced into [1, 2) and sorted by cents.
 * For arbitrary slot/anchor Hz, we octave-reduce the ratio, find the
 * nearest candidate by cents, and extend the candidate back into the
 * caller's octave for display.
 *
 * Default = 7 (prime-limit 7, odd-limit 9 — the "9-odd-limit" set,
 * ~18 ratios per octave with ~65¢ average gap).
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
// Returns sorted-by-cents array of { n, d, cents } where 1 <= n/d < 2.
function generateCandidates(primeLimit, oddLimit, maxNum = 64) {
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
      out.push({ n, d, cents: 1200 * Math.log2(r) });
    }
  }
  out.sort((a, b) => a.cents - b.cents);
  return out;
}

const CANDIDATES_BY_LIMIT = {
  5: generateCandidates(5, ODD_LIMIT_FOR_PRIME[5]),
  7: generateCandidates(7, ODD_LIMIT_FOR_PRIME[7]),
  11: generateCandidates(11, ODD_LIMIT_FOR_PRIME[11]),
};

export const SUPPORTED_LIMITS = [5, 7, 11];
export const DEFAULT_LIMIT = 7;

export function getCandidates(limit) {
  return CANDIDATES_BY_LIMIT[limit] || CANDIDATES_BY_LIMIT[DEFAULT_LIMIT];
}

export function ratioToCents(r) {
  return 1200 * Math.log2(r);
}

/**
 * For a target ratio (in any octave), find the nearest octave-reduced
 * candidate. Returns { n, d, octave, candidateCents, offsetCents,
 * halfGapPos, halfGapNeg } where:
 *   - n/d × 2^octave reconstructs the candidate at the input's octave
 *   - candidateCents is the candidate's cents in octave 0 (i.e. [0, 1200))
 *   - offsetCents = inputCents - (candidateCents + 1200*octave). Positive
 *     means input is above the candidate.
 *   - halfGapPos / halfGapNeg = cents distance to the midpoint between
 *     this candidate and its higher / lower neighbor (octave-wrapped).
 */
export function nearestRatio(targetRatio, limit = DEFAULT_LIMIT) {
  if (!Number.isFinite(targetRatio) || targetRatio <= 0) return null;
  const candidates = getCandidates(limit);
  if (candidates.length === 0) return null;

  const inputCents = 1200 * Math.log2(targetRatio);
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
