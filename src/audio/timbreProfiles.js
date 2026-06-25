/**
 * timbreProfiles — assumed spectral profiles for the dissonance model.
 *
 * A spectral profile is a list of partials `{ ratio, amp }`:
 *   - ratio: the partial's frequency as a multiple of the fundamental
 *            (1 = fundamental). Integers → harmonic timbre; arbitrary
 *            floats → inharmonic timbre (bells, gamelan).
 *   - amp:   linear amplitude of that partial, fundamental ≈ 1.
 *
 * DELIBERATELY DECOUPLED from the audio synthesis (Wave.js / shapeCoeffs).
 * The sounding timbre may be an external instrument driven over MIDI — or a
 * plain sine we nonetheless want to *treat* as harmonic for consonance
 * purposes. So the dissonance HUD asks this module "what partials should I
 * assume," not "what is the oscillator actually doing."
 *
 * The consonance valleys in a Sethares dissonance curve come entirely from
 * the partial ratios here: a full harmonic series yields the familiar JI
 * consonances (3/2, 4/3, 5/4…); inharmonic spectra yield different ones —
 * which is exactly why gamelan/carillon want their own profiles.
 *
 * See research/dissonance-curves.md.
 */

// Drop partials below this amplitude and cap the count — keeps the
// dissonance inner loop bounded for dense spectra.
const PARTIAL_FLOOR = 0.03;
const MAX_PARTIALS = 16;

/**
 * Build a harmonic-series profile. `rolloff` is the amplitude exponent
 * (amp = 1/n^rolloff): 1 ≈ sawtooth brightness, 2 ≈ triangle softness.
 * `oddOnly` skips even harmonics (square / clarinet-like). `count` is the
 * number of partials to emit (after the odd filter).
 */
export function harmonicProfile({ count = 12, rolloff = 1, oddOnly = false } = {}) {
  const out = [];
  const step = oddOnly ? 2 : 1;
  for (let n = 1; out.length < count && out.length < MAX_PARTIALS; n += step) {
    const amp = 1 / Math.pow(n, rolloff);
    if (amp < PARTIAL_FLOOR) break;
    out.push({ ratio: n, amp });
  }
  return out;
}

// Normalize an arbitrary partial list to fundamental amp 1 and trim by floor.
function _normalize(partials) {
  const base = partials[0]?.amp || 1;
  return partials
    .map((p) => ({ ratio: p.ratio, amp: p.amp / base }))
    .filter((p) => p.amp >= PARTIAL_FLOOR)
    .slice(0, MAX_PARTIALS);
}

// Inharmonic placeholders — APPROXIMATE ratios, to be replaced with measured
// spectra. They exist to prove the model handles non-integer partials (the
// valleys shift off JI automatically). Sources: Sethares, "Tuning, Timbre,
// Spectrum, Scale," gives measured bell/gamelan spectra to slot in here.

// Minor-third church bell / carillon (classic 5-partial idealization):
// hum, prime, tierce (minor 3rd), quint (5th), nominal (octave), + upper.
const BELL_APPROX = _normalize([
  { ratio: 0.5, amp: 0.5 },   // hum
  { ratio: 1.0, amp: 1.0 },   // prime (fundamental)
  { ratio: 1.2, amp: 0.7 },   // tierce — minor third (inharmonic!)
  { ratio: 1.5, amp: 0.5 },   // quint
  { ratio: 2.0, amp: 0.45 },  // nominal
  { ratio: 2.5, amp: 0.25 },
  { ratio: 2.67, amp: 0.2 },
  { ratio: 3.0, amp: 0.18 },
  { ratio: 4.0, amp: 0.12 },
]);

// Javanese gamelan saron (metallophone) — strongly inharmonic upper partials.
// Approximate ratios; real instruments vary bar-to-bar.
const GAMELAN_APPROX = _normalize([
  { ratio: 1.0, amp: 1.0 },
  { ratio: 2.8, amp: 0.6 },
  { ratio: 5.0, amp: 0.3 },
  { ratio: 5.9, amp: 0.2 },
  { ratio: 6.8, amp: 0.15 },
]);

export const TIMBRE_PROFILES = {
  harmonic: {
    label: 'Harmonic series',
    description: 'Full integer harmonics, 1/n rolloff (sawtooth-like). JI consonances.',
    partials: harmonicProfile({ count: 12, rolloff: 1 }),
  },
  'harmonic-soft': {
    label: 'Harmonic (soft)',
    description: 'Integer harmonics, 1/n² rolloff (triangle-like). Same valleys, shallower.',
    partials: harmonicProfile({ count: 12, rolloff: 2 }),
  },
  'harmonic-odd': {
    label: 'Odd harmonics',
    description: 'Odd integer harmonics only (square / clarinet-like).',
    partials: harmonicProfile({ count: 8, rolloff: 1, oddOnly: true }),
  },
  bell: {
    label: 'Bell / carillon (approx)',
    description: 'Inharmonic minor-third bell. Placeholder ratios — replace with measured.',
    partials: BELL_APPROX,
  },
  gamelan: {
    label: 'Gamelan saron (approx)',
    description: 'Inharmonic metallophone. Placeholder ratios — replace with measured.',
    partials: GAMELAN_APPROX,
  },
};

export const SUPPORTED_TIMBRES = Object.keys(TIMBRE_PROFILES);
export const DEFAULT_TIMBRE = 'harmonic';

let _active = DEFAULT_TIMBRE;

export function getActiveTimbreKey() { return _active; }
export function setActiveTimbre(key) {
  if (TIMBRE_PROFILES[key]) _active = key;
}
/** The partial list of the currently-selected profile. */
export function activeProfile() {
  return (TIMBRE_PROFILES[_active] || TIMBRE_PROFILES[DEFAULT_TIMBRE]).partials;
}

// Console hook so the assumed timbre can be swapped live while exploring:
//   __dissTimbre('bell')  →  watch the valleys move off JI.
if (typeof window !== 'undefined') {
  window.__dissTimbre = (key) => {
    setActiveTimbre(key);
    return _active;
  };
}
