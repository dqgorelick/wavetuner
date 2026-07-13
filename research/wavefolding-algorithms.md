# Wavefolding algorithms — survey + iOS click fix

Follow-up to `waveshaping.md` §3. Three questions answered here:

1. What algorithm are we running today?
2. Why does iOS click the moment fold leaves zero?
3. What other folding algorithms could ship, portable to both the web
   app and the iOS port?

---

## 1. Current algorithm (both platforms)

**Sine fold**: `f(x) = sin(drive·π·x)`, `drive = 1 + 3·amount` (1→4),
sampled into a 2048-point lookup table.

| | Web (`src/audio/Fold.js`) | iOS (`Models/Fold.swift`) |
|---|---|---|
| Evaluation | `WaveShaperNode` LUT | LUT + lerp per sample in render block |
| Dry/wet | parallel dry/wet GainNodes, `1−a` / `a`, ramped `setTargetAtTime` τ=30 ms | **none — full replacement when `amount > 0`** |
| Anti-aliasing | `oversample: '4x'` | **none** (documented v1 trade-off) |
| Where applied | per-pool **bus** (post-sum → intermodulation between voices) | **per-oscillator**, pre-mix |

Character: smooth/glassy, odd harmonics on a sine input. The Bessel
expansion `sin(z·sinθ) = 2·Σ J₂ₙ₋₁(z)·sin((2n−1)θ)` (same math as FM
sidebands) means the spectrum is effectively finite — the C∞ curve is
the *mildest-aliasing* folder in this survey, which is why 4× oversample
suffices on web and why iOS mostly gets away with none.

Two silent parity gaps, found 2026-07-13:

- **iOS has no dry/wet mix** (the click — §2).
- **iOS folds per-oscillator; web folds the summed bus.** Bus folding
  produces sum/difference intermodulation between simultaneously
  sounding voices (the "west-coast ring-mod" character called out in
  waveshaping.md §3); per-osc folding misses it. Likely a deliberate
  choice so the per-osc scope buffers show folded shapes, but it is a
  *sonic* difference, not just plumbing.

---

## 2. The iOS click at fold 0 → ε

**Root cause: the missing dry/wet mix.** At `amount = ε` the curve is
`sin((1+3ε)πx) ≈ sin(πx)` — *nothing like identity* (input 1.0 maps to
sin(π) = 0). The web output at ε is `(1−ε)·x + ε·sin(πx)` — an O(ε)
perturbation, inaudible, and further smoothed by the 30 ms gain ramp.
The iOS render block instead does

```swift
if foldActive {              // foldActive = amount > 0, per buffer
    s = Fold.applyFromTable(s, foldTable)   // FULL replacement
}
```

so the transfer function switches discontinuously from identity to
`sin(πx)` at a buffer boundary, mid-waveform. That step is the click,
and it's also why a small fold amount sounds like a sudden timbre jump
instead of a blend. Secondary: every dial write swaps the LUT
instantly (no smoothing), so drags step rather than fade — same class
of artifact, smaller magnitude.

Note the iOS *preview* (`SoundDesignViews.swift`) already draws
`dry·(1−a) + wet·a` and claims it matches the render loop — the UI is
right and the engine is wrong.

**Fix (web parity, ~10 lines in the render block):**

```swift
// per pool, render-thread state:
var foldSm: Float = 0                      // smoothed amount
let foldSmoothRate = 1 - exp(-1 / (sr * 0.03))   // τ = 30 ms, matches web

// per sample, replacing the if-foldActive block:
foldSm += (foldAmount - foldSm) * foldSmoothRate
if foldSm > 1e-4 {                         // settled-bypass fast path
    s += foldSm * (Fold.applyFromTable(s, foldTable) - s)
}
```

- `s + a·(fold(s) − s)` ≡ web's `(1−a)·dry + a·wet`.
- Smoothing must live on the render thread (one scalar per pool), same
  pattern as `gainSmoothRate` / `freqSmoothRate` already in the loop.
- The bypass check moves from raw `amount` to the *smoothed* value so
  turning the dial to 0 fades out instead of gating off.
- Table swaps during drags become inaudible for the same reason they
  are on web (waveshaping.md §3 "Continuity on curve swap"): per-event
  curve deltas are small once the 0→ε cliff is gone.
- Cost: one extra FMA + compare per sample per osc. Nothing.

---

## 3. Algorithm menu

Full agent-research dump with derivations lives in git history of this
file's draft; condensed here. All are memoryless static curves, so all
fit the existing LUT architecture on both platforms (bake the curve on
the main thread, swap under the existing lock / assign to the
WaveShaperNode). "Fold type" selector was already sketched as deferred
Phase 9 in waveshaping.md.

### 3a. Triangle / reflection fold (Serge-style) — cheapest add

Reflect signal past ±1 back into range; ideal Serge middle section.

```
fold(x) = 1 − 4·|frac((x+1)/4) − 1/2|        (period-4 triangle in x)
```

Harsh/buzzy vs. sine fold's glassy. ~6 ops, no transcendentals.
Already spec'd with a curve builder in waveshaping.md §3. **Worst
aliasing of the bunch** (C⁰ corners) — fine on web behind 4×
oversample, needs ADAA on iOS (§4) at high drive.

### 3b. Buchla 259 virtual-analog (5 parallel cells) — best sound-per-flop

Esqueda / Pöntynen / Välimäki / Parker, DAFx-17
(https://www.dafx17.eca.ed.ac.uk/papers/DAFx17_paper_82.pdf, eqs.
13–18, matches SPICE to ~1e-5 V). Five dead-zone+fold cells with
*different thresholds* in parallel plus a direct path:

```
s = sgn(v)                       // v = 5·drive·x  (±5 V domain)
V1 = 0.8333·v − 0.5000·s   if |v| > 0.6    else 0
V2 = 0.3768·v − 1.1281·s   if |v| > 2.994  else 0
V3 = 0.2829·v − 1.5446·s   if |v| > 5.46   else 0
V4 = 0.5743·v − 1.0338·s   if |v| > 1.8    else 0
V5 = 0.2673·v − 1.0907·s   if |v| > 4.08   else 0
out = −12·V1 − 27.777·V2 − 21.428·V3 + 17.647·V4 + 36.363·V5 + 5·v
```

(+ fixed one-pole lowpass ≈1.33 kHz tone control in the original;
optional for us — BiquadFilter after the shaper on web, one-pole in
the render block on iOS.) Because the thresholds stagger, folds appear
*progressively* with drive — the classic Buchla "timbre" bloom, harsher
and more complex than sin(kx). ~15 ops naive, and it tabulates exactly
(piecewise-linear), so on web it's **a drop-in curve swap** in
`buildSineFold`'s place. Drive must be baked into the curve (as today),
not applied as pre-gain, since WaveShaperNode clamps input to ±1.
Output needs peak-normalization at bake time (raw peaks are tens of
volts). Aliasing: bad naively (10 corners); paper uses BLAMP + 8×,
but ADAA1 on the tabulated curve gets most of it far cheaper.
Faust reference implementation: https://github.com/georgezachos/b259wf.

### 3c. Lockhart wavefolder (Lambert-W transistor cell) — LUT-ize it

Esqueda / Pöntynen / Välimäki, SMC-17 + Applied Sciences 2017
(https://www.mdpi.com/2076-3417/7/12/1328):
`f(x) = sgn(x)·V_T·W(δ·e^(β·|x|·…)) − α·x` — one rounded analog fold per
polarity; cascade 2–6 cells for multi-fold. The Lambert-W iteration is
expensive *live* but the curve is static — **evaluate W offline at
curve-build time** and it costs the same as any LUT. Readable reference
port with all constants + the ADAA antiderivative: Steven Yi's Csound
UDO (https://github.com/kunstmusik/libsyi,
https://kunstmusik.com/2019/05/17/lockhart-wavefolder/). Papers note it
sounds very close to the Serge — probably redundant if we ship 3a+3b.

### 3d. Chebyshev / polynomial shapers — the "exactly no aliasing" option

`Σ aₙ·Tₙ(x)` outputs exactly harmonic n at amplitude aₙ for a
full-scale sine input; choosing max degree N with N·f0 < Nyquist gives
**zero aliasing by construction** (Smyth,
http://musicweb.ucsd.edu/~trsmyth/waveshaping/waveshaping_4up.pdf).
Alternating-sign odd terms approximating the sine-fold's Bessel weights
gives a fold-ish timbre with a hard band-limit. Caveat: spectrum is
exact only at unit input amplitude and morphs as amplitude drops (can
be musically useful, but it means envelope level changes timbre).
More a spectral-design tool than a folder; keep in back pocket.

### 3e. tanh / saturating-fold hybrid — seasoning, not a folder

`tanh(g·x)` is monotonic — saturates, never folds. Jatin Chowdhury's
hybrid `y = tanh(x) + G·fold(x)` (G ≈ 0.1–0.5) reads as "more like a
real analog folder" at high drive
(https://ccrma.stanford.edu/~jatin/ComplexNonlinearities/Wavefolder.html).
Cheap curve-bake variation on whatever fold type is active.

### 3f. Exact band-limited sine fold (Bessel route) — special case

For a *pure sine* input, `sin(z·sinθ)` has closed-form harmonic
amplitudes `2·J₂ₙ₋₁(z)`. On web this maps onto `PeriodicWave` —
alias-free folding with zero runtime cost, drive stepped/crossfaded.
Breaks the moment the input isn't a sine (our morph slider), and folds
per-osc rather than the bus. Not a general solution; noted for
completeness.

### Comparison

| Algorithm | Character | Cost/sample | Naive aliasing | web LUT? | Effort |
|---|---|---|---|---|---|
| Sine fold (current) | smooth, glassy | LUT lerp | mild | ✅ shipping | — |
| Triangle fold | harsh, buzzy | ~6 ops / LUT | severe | ✅ | trivial (spec'd) |
| Buchla 259 VA | staggered "timbre" bloom | ~15 ops / LUT | severe | ✅ | low (constants above) |
| Lockhart (LUT-ized) | rounded analog, ≈Serge | LUT lerp | moderate | ✅ | medium |
| Chebyshev | designable, band-limited | N FMA | zero (by N) | ✅ | low-medium |
| tanh hybrid | rounds any fold | few ops | mild | ✅ | trivial |

---

## 4. Anti-aliasing for iOS: ADAA, 1st order

iOS has no oversampling budget; **antiderivative anti-aliasing** is the
designed-for-this-case technique (Parker et al. DAFx-16; the
Lockhart/Serge papers adopted it precisely to avoid oversampling).
With `F1` = antiderivative of the fold curve:

```
y[n] = (F1(x[n]) − F1(x[n−1])) / (x[n] − x[n−1])
       …unless |x[n] − x[n−1]| < ε:  y[n] = f((x[n] + x[n−1])/2)
```

- **Works with LUTs**: build a second 2048-pt table for F1 by
  cumulative-trapezoid integration of the f table at bake time — same
  `Fold.rebuildTable` moment, one extra array. Reference implementation
  with LUT/LUT+ADAA1/LUT+ADAA2 variants:
  https://github.com/jatinchowdhury18/ADAA (BSD-3);
  formula derivations incl. all fallback branches:
  https://ryukau.github.io/filter_notes/antiderivative_antialiasing/antiderivative_antialiasing.html.
- **ε for Float32**: ~1e-4 relative. Too small → crackle from
  catastrophic cancellation; too large → loses AA on slow signals.
  (Faust `aanl.lib` uses 1e-3; doubles implementations use 1e-10.)
- **Half-sample latency**: ADAA output is delayed ~½ sample. With our
  dry/wet mix, compensate the dry path with `0.5·(x[n]+x[n−1])` or the
  mix combs slightly at the top octave (Chowdhury, "Practical
  Considerations for ADAA",
  https://jatinchowdhury18.medium.com/practical-considerations-for-antiderivative-anti-aliasing-d5847167f510).
- **Cost**: +1 table lerp, 1 divide, 1 branch, 1 float of state per
  osc. Negligible at our voice counts (20 voices × 48 kHz ≈ 1M
  evals/s ≪ 1% of a core).
- Sine fold even has a closed-form antiderivative
  (`−cos(kx)/k` — Faust `aa.sine`), so the current algorithm can adopt
  ADAA without any table integration if preferred.

Web: WaveShaperNode is stateless, so ADAA there would need an
AudioWorklet — not worth it; `oversample: '4x'` already covers the web.
The shared pattern is: **one curve-bake routine emits f (+ F1), web
consumes f, iOS consumes both.**

---

## 5. Recommendation

1. **Fix the iOS click first** (§2) — it's a parity bug, not an
   algorithm problem. ~10 render-block lines + per-pool smoothed
   amount. No web change needed.
2. **Ship a fold-type selector** (waveshaping.md Phase 9) with
   **triangle** (trivial, already spec'd) and **Buchla 259**
   (constants above, distinctly different character, best
   sound-per-flop). Both are curve-bake swaps on web; both reuse the
   existing LUT plumbing on iOS.
3. **Add ADAA1 to the iOS fold path** when (2) lands — the corner-y
   curves genuinely need it there, and it also retires the documented
   "v1 ships without oversample" caveat in `Fold.swift` for the
   existing sine fold at high pitches.
4. Skip Lockhart (≈Serge, redundant), keep Chebyshev and the Bessel
   route as back-pocket ideas.
5. Separately decide whether iOS should move fold to the **bus**
   (post-sum) for web intermodulation parity — sonic difference,
   independent of algorithm choice.
