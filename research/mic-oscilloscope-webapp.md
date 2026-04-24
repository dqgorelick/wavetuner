# Mic-based Oscilloscope Web App

A separable project idea: a web app whose entire purpose is to visualize arbitrary microphone input as a real-time oscilloscope. Not wavetuner — no synthesized oscillators, no tuning. Just "plug your mic in and see what it looks like."

This document is the scoping research for that project, referenced from conversations inside wavetuner because some of the phase-recovery techniques here transfer directly from the work done on wavetuner's visualizer.

## Does the synth-based visualizer architecture block mic input?

No. Wavetuner's visualizer has two parallel paths:

1. **Live XY scope** — pure analyzer-based. Renders whatever lands in `analyserNode1`/`analyserNode2`, regardless of source.
2. **Synth XY + static 1D** — driven by the phase accumulator and joint-LSQ phase recovery. Requires known-frequency oscillators.

A mic oscilloscope lives entirely in category (1). The LSQ machinery from wavetuner *transfers* (see below) but isn't a prerequisite.

## The two real design questions

1. Mic is mono — how do you get a 2D oscilloscope view out of a single channel?
2. Can you do "standing wave" zero-crossing stabilization on unpredictable input?

Both have established answers. Details below.

## Mono → 2D visualization

Four techniques, from simplest to fanciest:

### 1. Time-delay phase-space (Takens embedding)

- `X = signal[t]`, `Y = signal[t − τ]`
- A pure sine traces a circle. Vowels trace complex closed loops. Noise fills a diagonal band. Harmonically rich sounds look amazing.
- τ choice: roughly ¼ of the expected fundamental period (~1–3 ms for voice, ~5 ms for bass).
- Can be user-adjustable with a slider, or auto-derived from detected pitch (see pitch-detection section below).
- Zero extra DSP cost — just a ring buffer.

This is probably the single most visually rewarding option for arbitrary audio on a mono input.

### 2. Signal vs. derivative (phase plane)

- `X = s[t]`, `Y = s[t] − s[t−1]`
- Special case of Takens embedding with τ = 1 sample.
- Cleaner look for low-frequency content; noisier for high-frequency.

### 3. Hilbert transform (analytic signal)

- `X = signal`, `Y = 90°-phase-shifted signal`
- A narrowband tone traces a circle whose radius equals the instantaneous amplitude envelope.
- Requires either an FFT-based Hilbert transform or an all-pass IIR filter.
- Beautiful for whistling or sustained tones; overkill for general use.

### 4. Classic scrolling waveform (1D, not XY)

- `y = signal[t]` vs a horizontal time axis.
- Feels like a real hardware oscilloscope.
- Pair with XY phase-space as a secondary mode and you cover both "looks like a scope" and "looks cool."

### Recommended combo

Primary view: **classic scrolling waveform** (covers the "web-based oscilloscope" brief).
Secondary view (toggle or split): **phase-space XY** using Takens embedding (visual bonus).

## Zero-crossing / standing-wave stabilization

Yes, possible on arbitrary input — it's exactly what every hardware oscilloscope has done since the 1950s.

### Three triggering strategies, from simplest to most robust

#### Zero-crossing trigger (the classic)

- Scan buffer for `s[n] ≤ 0 < s[n+1]`.
- Apply hysteresis: require the signal to dip below some negative threshold (e.g. −0.05) before counting the next upward crossing. Rejects noise jitter.
- Start the displayed window from the trigger sample.
- Rock-steady for any signal with a stable period.

#### Auto-correlation trigger

- Compute autocorrelation of the buffer.
- Pick the lag that maximizes it (= detected period).
- Align the window to that period boundary.
- More robust than zero-crossing for harmonically complex signals or signals where zero doesn't coincide with a "natural" anchor point.
- O(N log N) via FFT.

#### Pitch-detection + phase recovery (the wavetuner transfer)

- Run YIN (or similar) on a rolling buffer to get `f_0` + confidence.
- Feed `f_0` as a basis frequency into the same joint-LSQ phase recovery built for wavetuner (`calibratePhases` in `AudioEngine.js`). The algorithm doesn't care whether oscillators are synthesized or detected — it just needs known frequencies.
- Recovered phase becomes the anchor for the display window.
- **Result**: when pitch is stable (held vowel, sustained note), display freezes into a standing wave showing every harmonic detail locked in place.
- When pitch confidence drops (consonants, silence, noise), fall back to zero-crossing or free-run; show a visible "searching" indicator.

This third option is the one that makes a mic oscilloscope feel magical rather than merely functional — it's the "soothing standing wave" aesthetic from wavetuner, driven by arbitrary live input.

### What to be honest about

Truly aperiodic signals — drums, consonants, broadband noise — have no stable period and therefore no stable anchor. The display *should* look chaotic for these, because the signal is chaotic. Don't fake it. Hardware scopes solve this with:

- **Free-run mode**: no trigger, just scroll continuously.
- **Single-shot**: capture one slice and hold.

Both are easy to offer as modes.

## Suggested feature set

- Mic permission + input-device picker
- Display modes: Scope (scrolling waveform) / Phase-space (XY Takens) / Spectrum (FFT) — user toggleable
- Trigger modes: Auto (zero-crossing with hysteresis) / Auto (pitch-locked) / Free-run / Single-shot
- Time base (horizontal samples per pixel)
- Sensitivity / gain
- Freeze button
- Screenshot / "save this moment"
- Optional: stereo input support (when available) for true XY scope

## Technical notes for implementation

### Audio graph
```
getUserMedia({ audio: {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} }) 
  → MediaStreamAudioSourceNode 
  → AnalyserNode (fftSize = 8192)
```

The `echoCancellation: false` etc. is important — defaults apply heavy processing that distorts the waveform for visualization purposes.

### Feedback risk

If mic and speakers are both active, you get a loop. For an oscilloscope app, either:
- Don't route mic to audio output (visual only, silent) — simplest, avoids the problem entirely.
- Recommend headphones in the UI.

### Latency

Mic → analyzer is at least one audio buffer (~5–20 ms). Not an issue unless you're also playing back the mic in real time.

### Permissions UX

Mic access requires an explicit user gesture to prompt. iOS Safari is strict: HTTPS required, user gesture required, can't be backgrounded. A "click to start" gate can double as the permission prompt trigger.

### Pitch detection caveats (for the pitch-locked trigger)

- YIN struggles on polyphonic input, inharmonic percussion, and below ~50 Hz.
- Confidence gating is essential — only apply pitch-lock when confidence exceeds a threshold.
- Several MIT-licensed JS implementations exist (e.g. `pitchy` on npm).

### Compute budget

All of these fit comfortably in the 60 fps frame budget on any modern device:
- Analyzer + scope render: negligible.
- Autocorrelation trigger: ~O(N log N) per frame, fine for N ≤ 8192.
- Pitch detection (YIN): ~O(N²) worst case but typically O(N × maxLag), runs happily at 60 fps on a 2048-sample buffer.
- Joint LSQ with K=1 (just the pitch-locked tone): trivially cheap.

## Relationship to wavetuner

This is a **separate project**. It shares:
- Canvas 2D XY-scope rendering patterns.
- The joint-LSQ phase-recovery approach (`_calibrateChannel`, `_sumCos`/`_sumSin` Dirichlet-kernel helpers, Cholesky solver) — directly portable because the algorithm is frequency-agnostic.
- Trigger stabilization philosophy.

It does **not** share:
- Oscillator synthesis, routing, tuning.
- Any UI.
- The audio graph structure.

A reasonable starting point would be lifting `synthStereoData`'s sin/cos-recurrence style and `_calibrateChannel`'s LSQ into a shared `dsp` module if both projects ever want to pull from the same source of truth, but realistically the code is small enough to just copy.
