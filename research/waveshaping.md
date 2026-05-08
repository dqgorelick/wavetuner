# Waveshaping — wavetable morph + wavefolding

Two related synthesis techniques that move Wavetuner beyond pure-sine
drones, combined here because they share architecture (per-pool
state, single-slider control, same visualizer plumbing) and compose
naturally end-to-end.

1. **Wavetable morph** — replace the default `OscillatorNode` (sine)
   with a `setPeriodicWave`-driven oscillator that interpolates
   continuously through canonical shapes (sine → triangle → saw →
   square). One slider per pool.
2. **Wavefolding** — insert a `WaveShaperNode` after each pool's bus
   gain. A morphable curve folds signal that exceeds ±1 back into
   range, generating Buchla/Serge-style harmonics. One slider per
   pool.

Both are drop-in additions to the existing audio graph. No
`AudioWorkletNode`, no oscillator replacement, no structural rewiring.
The visualizer needs to mirror both effects in JS so the picture
matches the audio; the LSQ phase calibration needs a small
correction (or fallback) at non-sine output.

---

## 1. The audio chain (combined)

Per pool, the chain becomes:

```
   OscillatorNode(setPeriodicWave(morphedWave))
          │
          ▼
     pool gain (drone / kbd bus)
          │
          ▼
     WaveShaperNode(foldCurve, oversample='4x')
          │
          ▼
     masterGainNode → analyzers → destination
```

For the **drone pool**, the morph applies per-osc (each
`OscillatorNode` calls `setPeriodicWave` with the shared morphed
wave); the fold applies once on the bus.

For the **keyboard pool**, voices are spawned per noteOn — same
`setPeriodicWave` at creation, same shared bus shaper.

Two new singletons mirror the envelope architecture:

```
src/audio/Wave.js
  class Wave { position, setPosition, onChange, getPeriodicWave(ctx) }
  export const droneWave    = new Wave({ position: 0 })  // sine
  export const keyboardWave = new Wave({ position: 0 })

src/audio/Fold.js
  class Fold { amount, setAmount, onChange, applyTo(shaperNode) }
  export const droneFold    = new Fold({ amount: 0 })
  export const keyboardFold = new Fold({ amount: 0 })
```

`AudioEngine.initialize` creates the two `WaveShaperNode`s, calls
`droneFold.applyTo(droneFoldShaper)`, and subscribes to both module's
`onChange` so slider movement re-applies the curves. Same in
`KeyboardVoiceManager` for the keyboard side.

---

## 2. Wavetable morph

### Why `setPeriodicWave` over `OscillatorNode.type`

Web Audio offers three paths:

| Approach                          | Pros                              | Cons                                |
|-----------------------------------|-----------------------------------|-------------------------------------|
| `OscillatorNode.type = 'square'`  | Built-in, anti-aliased            | Only 4 discrete shapes, no morphing |
| `setPeriodicWave(PeriodicWave)`   | Anti-aliased, arbitrary harmonics | Need to compute Fourier coeffs      |
| `AudioWorkletNode`                | Maximum flexibility               | Anti-aliasing + phase mgmt on us    |

`setPeriodicWave` wins. Web Audio band-limits the harmonics per-pitch
automatically (`disableNormalization: false` normalizes peak to ±1).

### Fourier coefficients per anchor

All shapes are 2π-periodic, odd, peak ±1. Coefficients given as
sine-only series:

| Shape    | b_n (odd-only)             | b_n (all n)                       | Falloff |
|----------|----------------------------|-----------------------------------|---------|
| Sine     | b₁ = 1                     | —                                 | —       |
| Triangle | 8/π² · (−1)^((n−1)/2) / n² | 0 for even n                      | 1/n²    |
| Sawtooth | —                          | 2/π · (−1)^(n+1) / n              | 1/n     |
| Square   | 4/π · 1/n                  | 0 for even n                      | 1/n     |

### The chain — and the saw → reverse-saw caveat

The user originally proposed:

```
sine → triangle → sawtooth → reverse-saw → square
```

The saw → reverse-saw segment has a problem. Reverse-saw is
`−1 × sawtooth`; lerping their Fourier coefficients gives:

```
b_n(t) = (1 − t) · saw_n + t · isaw_n = (1 − 2t) · saw_n
```

At the midpoint t = 0.5 every coefficient is zero — **silence**. The
morph audibly fades out, then back in with inverted polarity. Not
useful musically.

**Recommended chain**: `sine → triangle → sawtooth → square`,
position p ∈ [0, 3]. Drops the inverted-saw step entirely. Phase
polarity stays consistent; harmonic content varies monotonically;
no silent midpoint.

The full 5-anchor chain can come back as a v2 if the inversion is
specifically wanted — implement it via *phase rotation* (rotate
each harmonic by tπ between p=2 and p=3) rather than amplitude
lerp, which avoids the silent midpoint at the cost of more math.

### Building the PeriodicWave

```js
const HARMONICS = 64;
const ANCHOR_COEFFS = [/* sine, triangle, saw, square */];  // Float32Array(65)

function shapeCoeffs(p) {
  const seg = Math.min(2, Math.floor(p));
  const t = p - seg;
  const a = ANCHOR_COEFFS[seg];
  const c = ANCHOR_COEFFS[seg + 1];
  const b = new Float32Array(HARMONICS + 1);
  for (let n = 1; n <= HARMONICS; n++) {
    b[n] = a[n] * (1 - t) + c[n] * t;
  }
  return b;
}

function buildWave(ctx, p) {
  const sine = shapeCoeffs(p);
  const real = new Float32Array(HARMONICS + 1);
  return ctx.createPeriodicWave(real, sine, { disableNormalization: false });
}
```

### Cost & churn

Building a `PeriodicWave` with 64 harmonics is ~2 μs. Calling
`setPeriodicWave(sharedWave)` on each oscillator is a pointer
assignment internally. Per pool we share one wave across all of
that pool's oscillators.

Slider drag at 60 fps would rebuild the wave every frame —
unnecessary. Mitigations:

1. **Debounce** — defer rebuilding until the slider settles ~30 ms.
2. **Cache** — round position to slot index (e.g. 0.05 step) and
   reuse `PeriodicWave` objects (~60 cached waves cover the chain).

Use both. Crossfade-on-swap (running two oscillators in parallel
during the change) is overkill — `setPeriodicWave` on a running
oscillator preserves phase in practice on Chrome/Safari. If clicks
appear, add a 2 ms gain-ramp around the swap.

---

## 3. Wavefolding

Wavefolding is the West-Coast (Buchla / Serge) technique where
signal exceeding ±1 is *reflected back* into range. Driving a sine
harder doesn't make it louder — it makes it harmonically richer.
Combined with the wavetable morph, the synth gets a serious tonal
palette.

### `WaveShaperNode` — the relevant primitive

```js
const shaper = ctx.createWaveShaper();
shaper.curve = curveFloat32Array;     // [-1, 1] mapped to indices [0, len-1]
shaper.oversample = '4x';             // 'none' | '2x' | '4x'
input.connect(shaper).connect(output);
```

**The clamping.** Web Audio clamps input to [−1, 1] before lookup.
You can't wavefold by "driving the input past ±1" — folding has to
be encoded *in the curve itself*, with the curve defining what the
folded values look like across [−1, 1]. The drive level is realized
by rebuilding the curve with more folds.

**`oversample: '4x'`** runs the shaper at 4× sample rate internally
(upsample → curve → lowpass → downsample). Aliases above the
original Nyquist are filtered out. WaveShaper is one of Web Audio's
lightest nodes; 4× is the right always-on default for our use.

### Curve flavors

All curves below are sampled into a 2048-entry `Float32Array` at
slider-change time. Linear-mixed with identity so `fold = 0` is
bit-perfect bypass — no subtle distortion creeping in.

**Sine fold** (Buchla style — recommended default):

```js
function buildSineFold(fold, size = 2048) {
  const curve = new Float32Array(size);
  const drive = 1 + fold * 3;  // 1..4
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const folded = Math.sin(drive * Math.PI * x) / drive;  // amp-normalized
    curve[i] = (1 - fold) * x + fold * folded;
  }
  return curve;
}
```

Smooth. Adds gentle even harmonics at low drive; metallic and
eventually atonal at high drive. The `/ drive` keeps perceived
loudness sane as fold increases.

**Triangle fold** (Serge style — sharper, buzzier):

```js
function buildTriFold(fold, size = 2048) {
  const curve = new Float32Array(size);
  const drive = 1 + fold * 3;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const driven = drive * x;
    const wrapped = ((driven + 1) % 4 + 4) % 4;
    const folded = 1 - Math.abs(wrapped - 2);
    curve[i] = (1 - fold) * x + fold * folded / drive;
  }
  return curve;
}
```

Discontinuous-derivative folds add more high-frequency content than
sine fold. Useful for "plucked" or "buzzy" tones.

**Tanh saturation** — for completeness; same node, different curve.
Soft-clips at ±1 instead of folding back. Smooth limiter, NOT a
fold. Could ship as a separate "Drive" knob alongside Fold if
wanted; one combined "harden the signal" knob also defensible.

**Recommendation.** Ship sine fold as v1 default. Triangle and tanh
behind a "fold type" selector if there's demand.

### Aliasing analysis

Sine fold at drive=4, fundamental 1 kHz → output's harmonics extend
to ~8 kHz. Plenty of headroom under 22 kHz Nyquist. At fundamental
5 kHz, drive=4 → 8th harmonic at 40 kHz. With 4× oversample,
internal Nyquist is 88 kHz, so it sits cleanly within the
oversampled band. Above ~10 kHz fundamental we'd see some aliasing
slip, but the keyboard's highest practical note is around 4–5 kHz.

**Conclusion: 4× oversample is sufficient across the audible range.**

### Per-pool vs. per-osc shaper

Per-pool (one shaper per bus) wins:
1. Symmetry with envelope + wavetable-morph architecture.
2. Cheaper — 2 nodes vs. 36 (4 drones + up to 32 voices).
3. Bus-level folding produces **intermodulation** — sum-and-difference
   frequencies between simultaneously sounding voices become
   audible (classic west-coast "ring-mod" character). Per-osc
   folding misses this.

Trade: a quiet voice and a loud voice in the same pool fold
together — the loud voice "shadows" the quiet one's harmonic
generation. Acceptable; the user can turn fold down for a cleaner
mix.

### Continuity on curve swap

`WaveShaperNode` is memoryless. Swapping the curve causes a
discontinuity in the output if the new curve at the current input
differs from the old curve. For a slider drag at ~60 fps with
smooth curve evolution, sample-to-sample step is small and
inaudible. No clicks expected; debounce is for performance, not
perceptual smoothness.

---

## 4. How they compose

The two stack independently and pair beautifully:

```
audio:       osc.setPeriodicWave(morphedWave) → bus → fold shaper → master
visualizer:  wtLookup(θ, morphedWT)           → foldLookup(raw, foldCurve) → output
```

Musically: a fold on a square is much harsher than a fold on a sine
(the square already has rich harmonics that the fold then mangles).
Two sliders give a wide tonal palette for very little DSP cost.

**Build order.** Ship morph first; folding benefits from having
morphed waveforms to fold. Either alone is also useful — they're
not mutually dependent.

---

## 5. Visualizer changes

The XY/face/Hilbert modes synthesize their own samples from
oscillator phase + amplitude + frequency (in `synthStereoData`,
`synthHilbertData`) rather than reading from the analyzer. The
static line mode synthesizes per-osc sums in `drawStatic`. To make
the picture match the audio, both effects need to be replicated in
JS in those paths.

### Wavetable lookup

```js
const WT_SIZE = 1024;

function sampleShape(norm, p) {
  // norm ∈ [0, 1), p ∈ [0, 3]
  const sine     = Math.sin(2 * Math.PI * norm);
  const triangle = 1 - 4 * Math.abs(norm - 0.5);
  const sawtooth = 2 * (norm < 0.5 ? norm : norm - 1);
  const square   = norm < 0.5 ? 1 : -1;
  const seg = Math.min(2, Math.floor(p));
  const t = p - seg;
  const anchors = [sine, triangle, sawtooth, square];
  return anchors[seg] * (1 - t) + anchors[seg + 1] * t;
}

function buildWavetable(p, size = WT_SIZE) {
  const wt = new Float32Array(size);
  for (let i = 0; i < size; i++) wt[i] = sampleShape(i / size, p);
  return wt;
}

function wtLookup(theta, wt) {
  const norm = ((theta / (2 * Math.PI)) % 1 + 1) % 1;
  const idx = norm * wt.length;
  const i0 = Math.floor(idx);
  const i1 = (i0 + 1) % wt.length;
  return wt[i0] + (wt[i1] - wt[i0]) * (idx - i0);
}
```

**Visualizer shows the *idealized* shape (sharp corners), not the
band-limited audio reality.** This matches the user's mental model
better than the audibly-correct band-limited version. Document the
difference: at very high pitches the audio sounds softer than the
picture suggests because Web Audio is band-limiting.

Per-pool wavetables (`droneWT`, `keyboardWT`) rebuilt on
`Wave.onChange`. ~0.1 ms each — cheap.

### Fold lookup

```js
function foldLookup(raw, foldCurve) {
  const clamped = Math.max(-1, Math.min(1, raw));
  const idx = (clamped + 1) * 0.5 * (foldCurve.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(foldCurve.length - 1, i0 + 1);
  return foldCurve[i0] + (foldCurve[i1] - foldCurve[i0]) * (idx - i0);
}
```

Per-pool fold curves (`droneFoldCurve`, `keyboardFoldCurve`) rebuilt
on `Fold.onChange`. `synthStereoData`, `synthHilbertData`, and
`drawStatic`'s aggregate path apply both effects per sample:

```js
const raw = wtLookup(theta, currentWT);          // morph
const folded = foldLookup(raw, currentFoldCurve); // fold
output[s] = amp * folded;
```

### Hilbert mode caveat

`synthHilbertData` plots `(sin θ, −cos θ)` per oscillator, which
traces a circle. The identity Hilbert(sin) = −cos doesn't hold for
non-sine shapes — the Hilbert transform is a per-frequency 90°
phase shift, so for `Σ bₙ sin(nθ)` the Hilbert pair is
`Σ −bₙ cos(nθ)`.

Recommended approach: build a *second* wavetable per pool with
phase-rotated harmonics (cos-basis). Each oscillator plots
`(wtLookup(θ, wt), −wtLookup(θ, wtH))`. At p=0 (sine) this
collapses to the existing circle automatically. For non-sine
morphs, per-osc shapes become the wavetable shape, not a circle —
documented as an intentional change.

---

## 6. LSQ phase calibration impact

`AudioEngine.calibratePhases` projects the analyzer signal onto a
sin/cos basis at each oscillator's frequency. Two issues at non-sine
output:

### Wavetable morph: fundamental-amplitude correction

For non-sine shapes, the analyzer signal contains harmonics that
the LSQ basis doesn't catch. The recovered fundamental amplitude is
*less than* the input's peak. For unit-peak shapes, the
fundamental's amplitude (= b₁) is:

| Shape    | b₁ (fundamental amplitude) |
|----------|----------------------------|
| Sine     | 1.000                      |
| Triangle | 8/π² ≈ 0.811               |
| Saw      | 2/π ≈ 0.637                |
| Square   | 4/π ≈ 1.273                |

(Square's b₁ > 1 because the band-limited fundamental of a
unit-peak square has amplitude 4/π — the peak-to-peak is the sum of
all harmonics, fundamental included.)

Fix: scale `aExpected` by `fundamentalFraction(droneWave.position)`
in `calibratePhases`. Phase recovery is unaffected; only the
confidence ratio.

### Wavefolding: deliberate fallback

For sine fold specifically, the fundamental amplitude as a function
of drive is the first Bessel function `J₁(drive · π)`:

| drive | J₁(drive·π) | note            |
|-------|-------------|-----------------|
| 1     | 0.285       | first attenuation |
| 2     | −0.123      | **phase flip**  |
| 4     | 0.069       | mostly higher harmonics |

The phase flip is the killer — at drives where J₁ < 0, the
LSQ-recovered phase *inverts* relative to the oscillator's "true"
phase. The existing confidence-blend logic would oscillate.

**Pragmatic mitigation:** at `fold > 0`, short-circuit
`calibratePhases`'s blend logic and let the phase accumulator carry
the visualizer for that pool. The accumulator runs at the unmodified
fundamental's phase; the visualizer's synth pipeline applies both
the morph and the fold curves at that phase. Picture is correct,
amplitude correction isn't critical.

```js
// In calibratePhases, per pool:
if (droneFold.amount > 0) return;  // skip phase-blend for this pool
// otherwise, apply fundamentalFraction(droneWave.position) correction
const aExpected = volume * sustain * masterScale
                  * fundamentalFraction(droneWave.position);
```

The accumulator has been the primary driver during non-stationary
periods (slider drags, fade-ins) for a while already —
`calibratePhases`'s confidence-blend is a *correction* on top, not
a replacement. Falling back to accumulator-only at `fold > 0`
should be subtle in practice.

---

## 7. UI shape

Two new section pairs in `SettingsPanel`, mounted between Tune and
the envelope sections, mirroring the envelope's per-pool split:

```
┌─ Drone wave ───────────────────────┐
│      ╱⌒\                           │     ← live preview SVG (one cycle)
│     /   \                          │       through morph × fold
│                                    │
│  Shape   [────●─────]   triangle   │
│  Fold    [────●─────]    32 %      │
└────────────────────────────────────┘

┌─ Keyboard wave ────────────────────┐
│      ╱╲    ╱╲   ╱╲                 │
│     /  \  /  \ /  \                │
│      ‾‾   ‾‾   ‾‾                  │
│                                    │
│  Shape   [───────●──]   square     │
│  Fold    [────●─────]    32 %      │
└────────────────────────────────────┘
```

- **Shape** slider: 0..3, step 0.01. Anchor labels at each integer
  (sine | triangle | saw | square). Optional snap-to-anchor on
  modifier-hold.
- **Fold** slider: 0..1, step 0.01. Percentage readout, "off" at 0.
- **Live preview SVG**: one cycle of the *current* output —
  morphed shape passed through the fold curve, drawn from the same
  JS-side wavetable + foldCurve the visualizer uses. ~280×80 px.

Combining the two sliders in a single "wave" panel rather than two
separate panels keeps the UI compact and reflects the audio
pipeline (one shape, one fold, drone or keyboard).

### Preview shows the combined output

Reusing the JS-side `wtLookup` + `foldLookup` makes the preview
free — sample 280 points across one cycle, draw a polyline.
Re-renders on either slider change.

### Per-osc override (deferred)

Same pattern as envelope: future per-slot shape (e.g. drone slot 0
square, slot 1 sine) is a supplemental map keyed by index, falling
back to the pool default. No structural change to the audio graph;
each oscillator just calls `setPeriodicWave` with its slot's wave
instead of the pool's. Defer until there's a real use case.

---

## 8. Phased rollout

### Phase 1 — Wave module + per-pool state
- `src/audio/Wave.js`: `Wave` class, two singletons, anchor
  coefficients, `getPeriodicWave(ctx)`.
- `AudioEngine._createSingleOscillator` calls
  `osc.setPeriodicWave(droneWave.getPeriodicWave(ctx))`.
- Subscribe to `droneWave.onChange`, walk every drone osc, call
  `setPeriodicWave` (debounced ~30 ms).
- `KeyboardVoiceManager.noteOn` does the same with `keyboardWave`.
- Sanity check: shapes audibly change across the morph; no clicks.

### Phase 2 — Wavetable for the visualizer
- `sampleShape`, `buildWavetable`, `wtLookup` helpers in
  `Oscilloscope.jsx` (or `src/audio/visual-shape.js`).
- Maintain `droneWT`, `keyboardWT` rebuilt on respective
  `onChange`.
- Swap `Math.sin(θ)` for `wtLookup(θ, currentWT)` in
  `synthStereoData`, `synthHilbertData`, `drawStatic`'s aggregate
  path and per-osc layer.
- Build matching cos-basis wavetables `droneWT_H`, `keyboardWT_H`
  for `synthHilbertData`'s y-axis.

### Phase 3 — LSQ amplitude correction
- `fundamentalFraction(p)` precomputed per anchor + lerped.
- `calibratePhases` multiplies `aExpected` by the appropriate
  pool's `fundamentalFraction`.

### Phase 4 — Fold module + audio path
- `src/audio/Fold.js`: `Fold` class, two singletons, curve builder.
- `AudioEngine.initialize` creates `droneFoldShaper`,
  `keyboardFoldShaper` `WaveShaperNode`s with `oversample = '4x'`,
  inserts them into the bus chains immediately after each pool's
  bus gain.
- Subscribe to `droneFold.onChange` / `keyboardFold.onChange` —
  call `applyTo(shaper)`.
- Sanity: at `amount = 0`, output bit-exact unchanged from pre-fold
  build.

### Phase 5 — Fold for the visualizer
- Maintain `droneFoldCurve`, `keyboardFoldCurve` Float32Arrays
  rebuilt on `onChange`.
- Apply `foldLookup(raw, curve)` after `wtLookup` in
  `synthStereoData`, `synthHilbertData`, `drawStatic` aggregate
  path.

### Phase 6 — LSQ fold fallback
- `calibratePhases` short-circuits its phase-blend at
  `fold > 0` (per pool). Phase accumulator becomes authoritative
  for that pool.

### Phase 7 — Settings panel UI
- Two `<WaveControls>` panels (drone + keyboard), each with shape
  slider + fold slider + combined preview SVG.
- Reuses `.tune-slider*` styling and `.envelope-graph` styling
  pattern.

### Phase 8 — URL share state
- Encode `dWave=<position>`, `kWave=<position>` (single floats, two
  decimals).
- Encode `dFold=<amount>`, `kFold=<amount>` similarly.
- Parse + push into singletons at module load.

### Phase 9 (deferred)
- Fold type selector (sine / triangle / tanh).
- LFO routing on shape position or fold amount.
- Reverse-saw segment via phase-rotation morph.
- Per-slot shape/fold overrides.

---

## 9. Open questions

1. **Saw → reverse-saw segment.** Recommended Option B (drop the
   inverted step, chain becomes `sine → tri → saw → square`,
   p ∈ [0, 3]). Re-add via phase-rotation in v2 if requested.

2. **Per-pool vs. global vs. per-osc shape/fold.** Per-pool is the
   recommended starting point (matches envelope architecture). One
   global pair simplifies UX; per-pool matches our existing split.

3. **Visualizer shape vs. audio shape.** Idealized piecewise-linear
   sampleShape (sharp corners) vs. band-limited
   `PeriodicWave`-equivalent. Recommended idealized — matches user
   mental model. Document the band-limit softening at high pitch.

4. **Fold preview shape choice.** Show the morph × fold combined
   output (recommended) vs. fold-only on a reference sine. Combined
   output is more informative.

5. **Snap-to-anchor on shape slider.** A small UX polish that keeps
   users from accidentally landing 5% off an anchor. Defer.

6. **Phase reset on `setPeriodicWave` or curve swap.** If clicks
   appear in practice (Safari historically less generous), add a
   2 ms gain-ramp around the change. Wait for user feedback first.

7. **LSQ fallback at fold > 0 — does phase tracking visibly
   degrade?** The accumulator is already the primary driver during
   non-stationary periods. Falling back to it should be subtle.
   Monitor.

---

## 10. Files likely to be touched / added

**New:**
- `src/audio/Wave.js` — `Wave` class + two singletons + Fourier
  coefficient anchors + `getPeriodicWave`.
- `src/audio/Fold.js` — `Fold` class + two singletons + curve
  builder + `applyTo`.
- `src/audio/visual-shape.js` (optional) — `sampleShape`,
  `buildWavetable`, `wtLookup`, `foldLookup` helpers if the
  Oscilloscope file becomes too dense to absorb them inline.
- `src/components/WaveControls.jsx` — combined shape + fold panel
  with preview SVG. Mounted twice in Settings.

**Modified:**
- `src/audio/AudioEngine.js`
  - `_createSingleOscillator` calls `setPeriodicWave` after start.
  - Create `droneFoldShaper` + `keyboardFoldShaper` in `initialize`,
    insert into bus chains.
  - Subscribe to `droneWave.onChange` and `droneFold.onChange`.
  - `calibratePhases` applies `fundamentalFraction` and
    short-circuits at `fold > 0`.
- `src/audio/KeyboardVoiceManager.js`
  - `noteOn` calls `setPeriodicWave` after `osc.start()`.
  - Subscribe to `keyboardWave.onChange` for live updates on
    running voices.
- `src/components/Oscilloscope.jsx`
  - Maintain pool-specific wavetables + fold curves, rebuilt on
    `onChange`.
  - Apply `wtLookup` + `foldLookup` in synth helpers.
  - Build cos-basis wavetables for the Hilbert path.
- `src/components/SettingsPanel.jsx` — two `<WaveControls>` mounts.
- `src/App.jsx` — URL state for `dWave`, `kWave`, `dFold`, `kFold`.

The audio-graph topology gains exactly two nodes (one
`WaveShaperNode` per pool). Every oscillator stays an
`OscillatorNode` going through the same gain/pan/bus chain — only
the *shape* the oscillator outputs and a downstream curve differ.
