# Dissonance Curves — Predictive Consonance Mapping for Voice Movement

Research-grade. The goal: when the user drags a voice's pitch, show a
**curve of sensory dissonance over the pitch axis** so they can see — before
they land — where the consonant valleys are against everything else that's
sounding. This is the Plomp–Levelt / Sethares "dissonance curve" idea
(endolith gist, Sethares `comprog.html`, aatishb/dissonance) adapted to our
live multi-voice engine.

The headline finding: **we already have every primitive needed.** The
Sethares kernel ships in `AudioFeatures.js`, and `Wave.js`'s `shapeCoeffs()`
gives us a voice's partials *without* an AudioContext. A predictive curve is
just our existing dissonance scalar swept over a frequency axis instead of
sampled once at the current configuration. A 2-voice test run is a few hours;
the N-voice version is the same code with one good optimization.

---

## 1. What a dissonance curve actually is

**Sensory dissonance** (a.k.a. *roughness*) is the auditory phenomenon where
two partials close in frequency — within ~one critical band but not unison —
beat against each other and sound rough. Plomp & Levelt (1965) measured this
on pairs of pure tones; the roughness peaks at ~25% of a critical bandwidth
of separation and falls to zero at both unison and ~one full critical band.

For a **complex tone** (many partials), total roughness is the sum of
pairwise roughness over *all* partials of *all* sounding tones. Sethares'
key move: hold a timbre fixed, take two copies of it, and sweep the second
copy's fundamental from unison up to an octave (or beyond). Plot total
roughness against the interval ratio → a **dissonance curve**. Its **minima
("valleys") are the consonant intervals** *for that timbre*.

Two facts that matter for us:

- **The valleys move with timbre.** For a harmonic timbre (sine→saw→square)
  the minima land on (or very near) the simple ratios 1/1, 6/5, 5/4, 4/3,
  3/2, 5/3, 2/1 — i.e. just intonation falls out of the physics. For
  inharmonic / stretched spectra the valleys shift *off* the rational
  ratios. Since our voices morph sine↔triangle↔saw↔square (and can be
  folded/saturated), **our curve's valleys are a function of the current
  wave position**, which is exactly the kind of thing worth visualizing.

- **The curve is a 1-D slice, not the whole landscape.** With 2 voices the
  curve fully describes the situation. With N voices, "the dissonance of the
  chord" is a point in an (N−1)-dimensional space and can't be drawn as one
  curve. The thing that *is* drawable and *is* what the user wants: **freeze
  N−1 voices, sweep the one you're dragging.** That collapses to a 1-D curve
  again — see §4.

---

## 2. The references, digested

All three sources implement the same model; they differ only in
parameterization and packaging.

### endolith gist (`3066664`) & Sethares `comprog.html`

The canonical `dissmeasure(freqs, amps)`. Constants (verbatim):

```
Dstar = 0.24      # interval of max dissonance, in critical-band units
S1 = 0.0207
S2 = 18.96
C1 =  5
C2 = -5
A1 = -3.51
A2 = -5.75
```

For each pair of partials (after sorting by frequency):

```
Fmin  = min(f_i, f_j)
S     = Dstar / (S1 * Fmin + S2)     # frequency-dependent CB scaling
Fdif  = |f_i - f_j|
a     = min(amp_i, amp_j)            # "min" model (Sethares' preferred)
d_ij  = a * (C1*exp(A1 * S*Fdif) + C2*exp(A2 * S*Fdif))
D     = Σ d_ij  over all pairs
```

Curve generation: pick a base spectrum `freq[], amp[]`. For `alpha` in
`1 .. 2.3` step `0.01`, build the combined spectrum
`F = concat(freq, alpha*freq)`, `A = concat(amp, amp)`, and plot
`dissmeasure(F, A)` vs `alpha`. The `min`-amplitude variant is the modern
one; the older gist used `amp_i * amp_j` (product). We should use **min** to
match Sethares' Figure 3 and to match our own existing code (see §3).

### aatishb/dissonance (the interactive page)

A Vue app wrapping the same Plomp–Levelt model with **user-editable spectra**
(harmonic, stretched, arbitrary partials) and a live, draggable curve. It is
the closest UX analog to what we want: an interactive curve that updates as
the timbre/partials change. Takeaways for us:

- It precomputes the curve over a fixed ratio grid and redraws on change —
  no audio-thread involvement. Confirms a **pure-math, off-thread** approach
  is the right architecture (we already do exactly this for the live meter).
- It exposes the partial list as the control surface. Our analog is the
  wave-morph position → `shapeCoeffs()` (§5), plus per-voice amplitude.

---

## 3. What the app already has (this is the important part)

We are not starting from zero. The Sethares kernel is **already in
production** in `src/audio/AudioFeatures.js`:

```js
const _A = 3.5;     // ≙ Sethares A1 = -3.51
const _B = 5.75;    // ≙ Sethares A2 = -5.75
const _PEAK = Math.exp(-_A*0.221) - Math.exp(-_B*0.221);  // normalization

function _criticalBandwidth(f) { return 1.72 * Math.pow(f, 0.65); }

function _pairwiseDissonance(f1, f2, a1, a2) {
  const cb = _criticalBandwidth(Math.min(f1, f2));
  const x  = Math.abs(f1 - f2) / cb;
  const d  = Math.exp(-_A*x) - Math.exp(-_B*x);
  return Math.min(a1, a2) * d / _PEAK;   // min-amplitude model, peak-normalized
}
```

This is the same difference-of-two-exponentials roughness curve, using the
`min(a1,a2)` model. The one difference from `comprog.html` is the
critical-band term: we use the **power law** `CB = 1.72·f^0.65` (the form
from the Sethares book appendix / Moore-Glasberg ERB-style scaling) rather
than the **linear** `S1·Fmin + S2`. Both are legitimate; ours is arguably
better at low frequencies. **For the predictive curve we should reuse this
exact kernel** so a curve valley reads the same number the live
`audioFeatures.dissonance` meter shows when you land there. Consistency
between "predicted" and "measured" is the whole point.

Other primitives already present:

| Need | Already in repo |
|---|---|
| Sethares pairwise roughness | `_pairwiseDissonance` (`AudioFeatures.js`) |
| Critical bandwidth | `_criticalBandwidth` (`AudioFeatures.js`) |
| **Voice partials w/o AudioContext** | `shapeCoeffs(position)` (`Wave.js`) — exported *specifically* "so non-audio consumers (AudioFeatures' dissonance calc) can model what partials a voice is contributing" |
| Per-voice freq / vol / mute | `audioEngine.frequencyValues / volumeValues / mutedStates` |
| Cents ↔ ratio, nearest candidate | `jiRatios.js` (`ratioToCents`, `nearestRatio`, `stepCandidate`) |
| "Snap toward candidate" visual vocabulary | `offsetToOpacity`, `halfGapPos/Neg` dim-arcs in `FrequencyManager` / sliders |
| Canvas overlay redrawn per-frame off live state | `DissonanceMeter._drawCurve` (already plots a curve + live marker!) |

The live meter computes dissonance from the **FFT** (post wave-shape, folder,
saturation — what's actually heard). The predictive curve will instead
compute from the **engine model** (synthetic partials from `shapeCoeffs`),
because we need to evaluate hypothetical pitches that aren't sounding yet. The
two will differ slightly (the model omits folder/saturation harmonics — §8),
but they share the kernel, so they agree on the dominant structure.

---

## 4. Two voices vs. N voices

### Two voices — trivial

Freeze voice A's partials. Sweep voice B's fundamental across the pitch
range. At each sweep point, build B's partials, concatenate with A's, run
`dissmeasure`. That's literally Sethares Figure 3 with our two timbres. ~500
sweep points, a handful of partials each — sub-millisecond.

### N voices — the "frozen background" slice

The actionable question is never "what's the dissonance of all N voices at
once" (a scalar, already on the meter). It's **"if I move *this* voice, where
can it land consonantly against the others?"** That is a 1-D slice:

```
background = Σ partials of all voices EXCEPT the one being moved   (frozen)
curve(f)   = dissmeasure( background ∪ partials_of_moved_voice(f) )
```

Sweep `f` for the moved voice → one curve. Its valleys are the consonant
landing spots **given the current chord**. Move a different voice → a
different curve. This is both tractable and exactly the user's mental model
("where can I land this voice").

**Decomposition / optimization.** `dissmeasure(A ∪ B)` splits into three
independent sums:

```
D(f) = D_within_background          // constant in f  → compute ONCE, drop or add as offset
     + D_within_moved_voice(f)      // voice vs its own partials; in a fixed timbre this is
                                     //   constant in f (its internal interval structure
                                     //   scales with f but CB scaling makes it ~flat) → cheap
     + D_cross(f)                   // moved partials × background partials → the ONLY part
                                     //   that varies meaningfully and must be recomputed per f
```

So per sweep point you only evaluate `P_moved × P_background` cross-pairs,
**not** `(P_total choose 2)`. With 12 voices × ~8 audible partials each:
`P_background ≈ 88`, `P_moved ≈ 8` → ~700 cross-pairs × 500 sweep points ≈
350k kernel evals per full curve. That's ~1–3 ms in plain JS. Recompute on a
`requestAnimationFrame` throttle during a drag and it's free.

(For comparison, the naive "concat everything and run the full O(P²) measure
at every sweep point" is ~9.6k pairs × 500 = 4.8M — still <10 ms, but the
decomposition is 10× cheaper and lets us cache the frozen background.)

### "Total landscape" — out of scope, but note it

If you ever want *global* harmony guidance (not per-voice), the full N-voice
dissonance is a surface over an (N−1)-D ratio space. You can't draw it, but
you can **sample** it: e.g. for a chord, show each voice's individual slice
stacked, or compute dissonance for a discrete set of candidate chords
(snap-to-JI permutations) and rank them. That's a later feature; the per-voice
slice is the MVP and probably 90% of the value.

---

## 5. Timbre: where the partials come from

Each voice's spectrum is fully determined by its **wave-morph position** and
fundamental. `Wave.js` already gives us the sine coefficients:

```js
import { shapeCoeffs } from '../audio/Wave';

// Build a partial list for a voice at fundamental f0 and morph position p.
// shapeCoeffs(p) returns Float32Array[65] of sine amplitudes b_1..b_64.
function voiceSpectrum(f0, position, voiceAmp, { maxPartials = 12, floor = 0.01 } = {}) {
  const coeffs = shapeCoeffs(position);        // 0=sine,1=tri,2=saw,3=square
  const out = [];
  for (let n = 1; n < coeffs.length; n++) {
    const a = Math.abs(coeffs[n]);
    if (a < floor) continue;                   // skip inaudible partials
    const f = f0 * n;
    if (f > 20000) break;                       // above hearing
    out.push({ f, a: a * voiceAmp });
    if (out.length >= maxPartials) break;       // cap for performance
  }
  return out;
}
```

Notes:

- **Drone vs keyboard waves are separate** (`droneWave`, `keyboardWave`
  singletons). Use each pool's own `position` for its voices' spectra.
- **Amplitude weighting matters.** A muted or near-silent voice should drop
  out of the background (use `volumeValues[i]`, `mutedStates[i]`, and the
  effective-gain getters already used in `AudioFeatures`). The `min`-amp
  model means a quiet voice contributes little roughness automatically, but
  skipping it outright is cheaper.
- **Partial cap.** Sine has 1 partial; square/saw have many but they fall off
  as `1/n` (saw) or `1/n²` (tri), so `maxPartials ≈ 12` with an amplitude
  `floor` captures essentially all the audible roughness while bounding cost.
- **Octave/register.** Critical bandwidth widens with frequency, so the same
  ratio is rougher low and smoother high — the kernel handles this for free
  via `_criticalBandwidth(min(f1,f2))`. Don't octave-fold the partials; feed
  real Hz.

---

## 6. Proposed module + API

A new pure-math module, sharing the kernel with the meter. **Refactor the
kernel out of `AudioFeatures.js`** into `src/audio/dissonanceModel.js` so the
meter and the curve are guaranteed to agree (single source of truth):

```js
// src/audio/dissonanceModel.js
export const DISS_A = 3.5, DISS_B = 5.75;
const PEAK = Math.exp(-DISS_A*0.221) - Math.exp(-DISS_B*0.221);
export function criticalBandwidth(f) { return 1.72 * Math.pow(f, 0.65); }
export function pairDissonance(f1, f2, a1, a2) { /* …existing body… */ }

// Total roughness of a partial list [{f,a}, …].
export function totalDissonance(parts) {
  let d = 0;
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++)
      d += pairDissonance(parts[i].f, parts[i].a, parts[j].f, parts[j].a);
  return d;
}

// Cross-roughness between two partial lists (the only f-dependent term).
export function crossDissonance(moved, background) {
  let d = 0;
  for (const m of moved)
    for (const b of background)
      d += pairDissonance(m.f, b.f, m.a, b.a);
  return d;
}
```

```js
// src/audio/dissonanceCurve.js
import { crossDissonance, totalDissonance } from './dissonanceModel';
import { voiceSpectrum } from './voiceSpectrum';   // §5 helper

// Build the frozen background ONCE per drag-start (or per chord change).
export function buildBackground(movedSlot) {
  const bg = [];
  // …gather voiceSpectrum() for every audible voice except movedSlot,
  //   drones (droneWave.position) + keyboard voices (keyboardWave.position)…
  return { parts: bg, selfDiss: totalDissonance(bg) };
}

// Sweep the moved voice across a cents range; return a typed array of
// dissonance values aligned to that range.
export function sweepCurve({ background, position, voiceAmp, baseHz,
                            centsLo = -2400, centsHi = 2400, steps = 600 }) {
  const out = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const cents = centsLo + (centsHi - centsLo) * (i / steps);
    const f0 = baseHz * Math.pow(2, cents / 1200);
    const moved = voiceSpectrum(f0, position, voiceAmp);
    out[i] = background.selfDiss
           + crossDissonance(moved, background.parts);
    // (+ optional within-voice term; ~constant, usually omit)
  }
  return out;   // caller normalizes for display
}
```

Display normalization: the curve's absolute magnitude depends on voice count,
so normalize per-curve (`d / max`) for the overlay, or normalize against the
**current** chord's dissonance so "0" on the plot = "as consonant as the most
consonant point in range." Mark valleys via simple local-minima detection,
and cross-reference `nearestRatio()` to **label** each valley with its JI
ratio when it's within a few cents of a candidate.

---

## 7. Where it lives in the UI

Three integration points, in increasing ambition:

1. **Standalone curve panel (MVP).** A canvas like `DissonanceMeter`'s
   `_drawCurve`, but X = cents/ratio over ±1–2 octaves and Y = dissonance,
   with the dragged voice's current pitch as a live vertical marker and
   valleys dotted. Recompute on drag (rAF-throttled). Reuses the exact
   drawing patterns already in `DissonanceMeter.jsx`.

2. **Overlay on the frequency editor / orb.** The `FrequencySliders` /
   `GlobalDetuneOrb` surfaces already draw **dim-arcs toward candidate
   ratios** using `offsetToOpacity` + `halfGapPos/Neg`. Overlay the
   dissonance curve along the same axis so the user sees roughness valleys
   *and* JI candidates together — and the valleys explain *why* those
   candidates are the snap targets for this timbre.

3. **Snap-to-valley + haptic-style detents.** Once the curve exists, "snap
   the dragged voice to the nearest dissonance minimum" is a one-liner
   (local-min search near the cursor). This is the most musically novel
   feature: snapping to *timbre-aware* consonance rather than to a fixed JI
   table. Pairs naturally with the existing `stepSlotRatio` ↑/↓ stepping.

---

## 8. Caveats & limitations (be honest in UI copy)

- **Sensory dissonance ≠ musical consonance.** This model captures
  *roughness/beating* only. It says nothing about harmony, tonality, voice
  leading, or virtual-pitch/root perception (a 4:5:6 major triad and its
  inversions can have similar roughness but very different musical function).
  Sell it as "roughness / beating map," not "the chord is "good"."
- **Model omits the nonlinear stages.** Our real signal passes through the
  wave folder and soft-limiter saturation, which *add* partials (and
  roughness) the `shapeCoeffs`-based spectrum doesn't see. The live FFT meter
  *does* see them. So the predicted curve can read smoother than reality when
  the folder/drive is up. Options: (a) ship v1 as "pre-effects" and note it;
  (b) later, model the folder's added harmonics analytically; (c) blend the
  predicted curve with the live FFT background for the frozen voices.
- **Equal-amplitude / partial-cap approximations** shift valley *depths*
  slightly but not their *locations* — fine for guidance.
- **It's a slice, not the surface** (§4). Moving voice A changes A's curve;
  it does not tell you what happens if you then move B. Recompute per drag.
- **Stretched/inharmonic timbres** (heavy fold) genuinely move the valleys
  off JI — that's a feature to surface, not a bug, but it means "valley" and
  "simple ratio" can disagree, and the UI should show the actual valley.

---

## 9. Recommended MVP / test run

Smallest end-to-end slice that proves the idea, in order:

1. **Extract** the kernel into `dissonanceModel.js` (pure refactor; meter keeps
   working, now imports it). Low risk, unlocks reuse.
2. **`voiceSpectrum()`** helper over `shapeCoeffs` (§5).
3. **Two-voice curve**, hard-coded to slots 0 and 1: freeze slot 0, sweep
   slot 1 over ±1 octave (600 pts), draw in a dev canvas. Verify the valleys
   land on 3/2, 4/3, 5/4… for a saw/square position and visibly *shift* as
   you move the wave-morph slider. This single visual is the whole proof.
4. **Generalize to "moved voice vs frozen background"** (§4) with the
   `buildBackground` / `crossDissonance` split. Wire `baseHz` to the actually-
   dragged slot.
5. **Overlay + valley labels** via `nearestRatio` (§6–7).
6. (Stretch) **Snap-to-valley** detents.

Steps 1–3 are an afternoon and answer "is this worth it." Everything after is
incremental on a known-good kernel.

---

## References

- endolith, "Sethares dissonance" gist — https://gist.github.com/endolith/3066664
  (Python `dissmeasure`, constants, Figure-3 curve reproduction).
- W. Sethares, "Relating Tuning and Timbre" / `comprog.html` —
  https://sethares.engr.wisc.edu/comprog.html (canonical `dissmeasure`,
  `Dstar=0.24, S1=0.0207, S2=18.96, C1=5, C2=-5, A1=-3.51, A2=-5.75`).
- aatishb/dissonance — https://github.com/aatishb/dissonance ,
  page: https://aatishb.com/dissonance/ (interactive, editable-spectrum
  dissonance curves; closest UX analog).
- Plomp & Levelt, "Tonal Consonance and Critical Bandwidth," *JASA* 38 (1965)
  — the underlying psychoacoustic measurements.
- Sethares, *Tuning, Timbre, Spectrum, Scale* (Springer) — the power-law
  critical-band form `1.72·f^0.65` we already use.

### In-repo cross-references
- `src/audio/AudioFeatures.js` — existing Sethares kernel + live FFT meter.
- `src/audio/Wave.js` — `shapeCoeffs()` synthetic partials (no AudioContext).
- `src/components/DissonanceMeter.jsx` — canvas curve + live-marker pattern to copy.
- `src/audio/jiRatios.js` — `nearestRatio`, `offsetToOpacity`, candidate labels.
- `src/audio/FrequencyManager.js` — slot/anchor/ratio model the sweep reads from.
- Companion: `research/tuning-systems-catalog.md`, `research/waveshaping.md`.
</content>
</invoke>
