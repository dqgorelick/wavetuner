# Oscilloscope clarity at high frequencies — Plan

The XY / Hilbert / face scopes get visually "soft" at high frequencies —
the figure looks blurry or smeared rather than the crisp Lissajous you
see at 80–200 Hz. Meanwhile, low-frequency renders have a nice "moving
playhead" feel (the trace visibly drifts frame-to-frame because the
period is comparable to the frame interval), which we want to keep.

The proposal: **make the synth-buffer length adapt to frequency**. Long
buffers at low freqs (preserve the drift / playhead feel), short
buffers at high freqs (one or two clean cycles instead of forty
overlapping ones). One knob, one cause, one fix.

A future user-facing "samples per cycle" slider lives on the same
knob — defer the UI until the auto-adaptive feel is dialed in.

---

## 1. What's actually happening

Every visualizer mode synthesizes a fixed-size buffer and renders it:

| Mode             | Buffer source                  | N    | Why fixed N? |
|------------------|--------------------------------|------|--------------|
| 0 (Circle / XY)  | `synthStereoData(2048, sr)`    | 2048 | "matches previous density" |
| 1 (Static line)  | direct synth across `windowSec`| ≤1600| pixel-density |
| 2 (Face)         | `synthStereoData(2048, sr)` ×2 | 2048 | inherits XY |
| 3 (Hilbert)      | `synthHilbertData(2048, sr)`   | 2048 | inherits XY |

`Oscilloscope.jsx:459` then re-clamps the rendered window to
`XY_RENDER_N = 2048` samples — i.e. the whole synthesized buffer is
displayed.

At sample rate 44.1 kHz, 2048 samples = **46 ms of audio**. That means
the buffer contains roughly:

| Lowest freq | Cycles in buffer |
|-------------|------------------|
| 50 Hz       | ~2.3             |
| 100 Hz      | ~4.6             |
| 500 Hz      | ~23              |
| 1000 Hz     | ~46              |
| 2000 Hz     | ~92              |
| 5000 Hz     | ~232             |

For an XY Lissajous to be **visually crisp**, every cycle should map to
the same pixels. In practice it doesn't, for three compounding reasons:

### 1a. Phase drift accumulates within the buffer

Phases come from `audioEngine.calibratePhases` (LSQ recovery) plus the
accumulator. Tiny per-frame phase errors are fine over one cycle but
compound across 46 cycles — by cycle 46 the trace lands a few pixels
off cycle 1. Drawn together, they smear.

### 1b. Cycles_per_buffer is rarely an integer

Even with perfect phase recovery, if `f × bufSec` isn't an integer (it
almost never is for a chosen f), each cycle starts at a slightly
different sub-pixel position. With 46 of them stacked, every cycle is a
slightly different polyline — drawn over each other, they blur.

### 1c. The XY adaptive sampling caps too low

`drawXY` already adapts:
```js
const sampleStep = Math.round(1 + complexity * 7);   // max step 8
const smoothingFactor = 0.6 + complexity * 0.3;       // up to 0.9
```
At 5 kHz, step 8 means we draw every 8th sample = 23 visual points per
cycle. That's enough for one cycle to look smooth, but combined with
46 stacked copies it doesn't help — and the EMA smoothing actively
*pulls* successive points toward each other, distorting the figure
because adjacent samples are far apart in θ-space.

### 1d. Static mode (line) is mostly OK

Mode 1 synthesizes directly across `windowSec = periods / fundamental`.
Sample density is per-pixel, so cycles/pixel scales inversely with
fundamental. As long as the user keeps `staticPeriods` reasonable
(default 20), high-freq fundamentals just compress more cycles into
the strip — readable until you're sub-3-pixel-per-cycle. Doesn't need
the same fix; mention here so we don't accidentally regress it.

---

## 2. The "playhead" feel at low freqs

At 50 Hz, one period is 20 ms. A 60 fps frame is 16.7 ms. So between
two successive frames, the wave's phase advances by about 5/6 of a
cycle, and the trace visibly drifts across the screen — the user reads
this as a moving cursor or playhead. It's a quirk of "buffer length ~~
period" that gives oscillators in the audible-bass range a tactile,
animated feel.

We want to preserve this. The fix is to **only shorten the buffer when
high freqs are present**, not blanket-shrink it.

A 2048-sample buffer at 50 Hz holds 2.3 cycles — that's the source of
the drift. If we kept this at every frequency we'd get the same feel,
but at 5 kHz those 2.3 cycles are only 0.46 ms of audio — a buffer that
short can't be measured (analyzer FFT and LSQ both need ~5 ms minimum
to resolve). So full-frequency-tracking N is the wrong move.

Instead: **adapt down only when N is "too large for what's there."**
Below some target cycle count, leave N alone; above it, shrink.

---

## 3. Adaptive buffer length

```js
const TARGET_CYCLES = 6;            // user-controlled via the "Cycles" slider
const MIN_N = 128;                  // ~3 ms @ 44.1 kHz, lower bound for visual continuity
const MAX_N = 2048;                 // current behavior at the bottom of the range
const N_STEP = 32;                  // round to a multiple to avoid frame-to-frame jitter

function adaptiveBufferSize(highestActiveFreq, sampleRate) {
  if (!(highestActiveFreq > 0)) return MAX_N;
  const ideal = (TARGET_CYCLES * sampleRate) / highestActiveFreq;
  // Round to the nearest N_STEP, then clamp.
  const stepped = Math.round(ideal / N_STEP) * N_STEP;
  return Math.max(MIN_N, Math.min(MAX_N, stepped));
}
```

Behavior across the audible range (44.1 kHz, TARGET_CYCLES = 6):

| Highest active freq | Ideal N | Rounded + clamped |
|---------------------|---------|-------------------|
| 50 Hz               | 5292    | 2048 (cap)        |
| 80 Hz               | 3308    | 2048 (cap)        |
| 130 Hz              | 2035    | 2048 (cap)        |
| 200 Hz              | 1323    | 1312              |
| 500 Hz              | 529     | 512               |
| 1000 Hz             | 265     | 256               |
| 2000 Hz             | 132     | 128 (floor)       |
| 3000 Hz             | 88      | 128 (floor)       |
| 5000 Hz             | 53      | 128 (floor)       |

So below ~130 Hz, behavior is unchanged → low-freq playhead feel
preserved. Above that, N shrinks proportionally so the figure shows
roughly TARGET_CYCLES cycles in the buffer at any frequency.

### Why round to N_STEP

Without rounding, every 1 Hz freq drag would shift N by a few samples,
which itself shifts where the figure starts/ends in the synthesis
window, which causes a visible "breathing" jitter. Rounding to multiples
of 32 gives stable N within a frequency band so dragging an orb feels
smooth.

### Why "highest" active freq (revised)

The original draft of this plan sized N off the *lowest* active freq
to preserve a long buffer when bass content was present. Two problems
with that choice in practice:

1. The user's actual pain point is high-frequency cases (e.g. two
   ~3 kHz oscillators), where 46 ms of buffer = 100+ smeared cycles.
2. With a mixed bass + treble setup, lowest-based N keeps the buffer
   long, which means the treble cycles still smear — the bass "wins"
   the policy and the treble stays bad.

Sizing off the **highest** active freq fixes the high-freq case
unconditionally. The trade-off: when both bass and treble are
present, N is sized for the treble, so the bass shows as a near-DC
offset rather than a full cycle. That's the right call — the user
already has the static-line viz mode (mode 1) for "see slow bass
drift," and the XY/Hilbert/face modes are about figure clarity.

The user-facing **Cycles** slider remains the override: bump it up
when bass detail matters more than treble crispness; pull it down
when the figure is busy and you want fewer overlapping cycles.

For the keyboard pool, "highest active" includes any held voices, so
a high-pitched key over a 100 Hz drone shrinks N to match the key.
Drone-only and keyboard-only cases both work; mixed, the keyboard
note (typically higher) drives N.

---

## 4. Effect per visualizer mode

### Mode 0 (Circle / XY)

Today: `synthStereoData(2048, sr)` → trim to last 2048 → render.

Proposal: `synthStereoData(N, sr)` where N is adaptive. Removes the
trim step entirely (synthesize exactly what you render). At 1 kHz, the
figure now shows ~6 cycles' worth of trace, which for a clean
2:3-ratio Lissajous is one full closure plus a half — readable instead
of smeared.

### Mode 1 (Static line)

No change. Already pixel-density-driven via `samples = min(1600,
traceWidth)` and `windowSec = periods / fundamental`. The user's
`staticPeriods` slider already lets them control display density.

(Optional polish: a "max cycles per pixel" cap that auto-reduces
`staticPeriods` if the rendered shape would be sub-3-pixel-per-cycle
at the current width. Defer.)

### Mode 2 (Face)

The eyes use `synthStereoData(2048, sr)` — they pick up the adaptive N
the same way Mode 0 does. The mouth (`drawStatic`) inherits Mode 1's
behavior. Each gets its own fix; nothing extra here.

### Mode 3 (Hilbert)

`synthHilbertData(2048, sr)` is structurally the same as
`synthStereoData` for our purposes (same loop shape, same per-sample
cost). Adapts identically. The Hilbert plot's per-osc circles trace at
freq-dependent angular speeds; with smaller N at high freqs each
circle traces fewer revolutions, but it's still a circle — composite
epicycle figures stay legible.

---

## 5. The future user-facing slider

The user hinted at "a sample rate slider in the settings." That maps
cleanly onto exposing `TARGET_CYCLES` (with a friendlier name like
**Trail length** or **Cycles per frame**):

```
  ┌─ Visualizer ─────────────────────┐
  │  Trail length  [────●───]   6 c  │   ← slider value 1..16, controls TARGET_CYCLES
  │     (longer = more history,      │
  │      more drift at low freqs)    │
  └──────────────────────────────────┘
```

A "frame size" slider (raw N) is also defensible but harder to reason
about because the right N depends on freq. "Cycles per frame" is
freq-invariant — the user picks the visual character once and it
holds across the audible range.

Defer the UI until the auto-adaptive feel is dialed in. The
TARGET_CYCLES constant is the only hook needed; lifting it to settings
state is a 3-line change later.

---

## 6. Phased rollout

### Phase 1 — Adaptive buffer in the synth helpers
- Add `adaptiveBufferSize(lowestActiveFreq, sampleRate)` helper in
  `Oscilloscope.jsx` (or a new `src/audio/synth-buffer.js` if it grows).
- Compute "lowest active freq" once per frame in `drawScope` from
  `audioEngine.getAllFrequencies()` (filtering by mute) and
  `keyboardVoiceManager.getActiveVoices()` (non-released).
- Pass the chosen N into `synthStereoData` / `synthHilbertData` calls.
- Remove the `XY_RENDER_N = 2048` re-trim in `drawXY` — synthesize
  exactly what we render.

### Phase 2 — Verify each mode
- Drone-only at 50 / 200 / 500 / 1000 / 2000 Hz: confirm the figure
  reads cleanly at every step.
- Keyboard-only sweep through the Ableton-kbd range.
- Combined drone + high keyboard note: N should stay long (driven by
  drone).

### Phase 3 — Tune `TARGET_CYCLES` by ear
- Default 6 is a guess. Try 4, 8, 12 and pick by feel.
- Watch for: too few cycles → figure looks "flickery" because the LCM
  of the freq ratios isn't a full closure within N; too many → the
  high-freq smear returns.

### Phase 4 — Optional: sliders in settings
- New "Visualizer" section in `SettingsPanel.jsx`.
- Single slider: trail length / cycles per frame, mapped to
  TARGET_CYCLES.
- URL share state includes the value.

---

## 7. Edge cases

### 7a. No active oscillators

`lowestActiveFreq` is `Infinity`. Helper falls back to `MAX_N` so the
visualizer still renders silence without crashing. Already covered by
the `if (!(lowestActiveFreq > 0)) return MAX_N;` guard above.

### 7b. Frequency drag across the cap boundary

A user dragging an orb from 100 Hz → 200 Hz crosses the point where N
transitions from 2048 (capped) to ~1344 (rounded). Without smoothing,
the buffer length jumps in one frame and the figure visibly resizes /
re-syncs. The N_STEP rounding helps (steps come in 64-sample chunks)
but a smooth `lowestSmoothed += (target − lowestSmoothed) × 0.1` on
the *frequency* used to compute N would make the transition feel like
a glide instead of a snap. Add if needed; first try without.

### 7c. Persistence-trail accumulation at small N

Mode 0's rendering relies on per-frame `fillRect(rgba(0,0,0,0.6))` to
fade the previous trace. That fade rate is independent of N, so a
shorter buffer doesn't change the trail length on screen — only the
density of the new line drawn on top. Good.

### 7d. Performance ceiling at low N

`synthStereoData` is O(N × oscs). At N = 256 with 4 drones + 4
keyboard voices, that's 256 × 8 = 2048 sin/cos rotations per frame —
trivially fast. No risk; if anything, this is a perf *improvement* at
high freqs because we're synthesizing fewer samples.

### 7e. `calibratePhases` analyzer buffer is unrelated

`AudioEngine.calibratePhases` uses the analyzer's 8192-sample buffer
for LSQ phase recovery — that's a separate path from the visualizer's
synth buffer and isn't touched by this proposal. The analyzer buffer
provides phase truth; the synth buffer renders that truth. They can
have different lengths without coupling.

---

## 8. Open questions

1. **TARGET_CYCLES sweet spot.** 6 is a starting guess. Ear-test
   needed. Adaptive could even be mode-specific — XY scopes might want
   fewer cycles (figure clarity), Hilbert might want more (more
   revolutions = richer epicycle). Decide after listening.

2. **Should the smoothing factor in `drawXY` also adapt to N?** Right
   now it scales with `complexity` (= direction-change density), which
   itself shrinks at high freq when N shrinks (fewer samples → fewer
   direction changes detected). So smoothing naturally relaxes. Worth
   verifying the cascade is stable; fix if it overshoots.

3. **Does the line-mode static visualizer want a similar "auto-reduce
   periods" behavior?** As §4 notes, the existing `staticPeriods`
   slider handles this manually. Auto could feel magical or
   frustrating depending on use case. Punt to user feedback.

4. **Persistent-trail length at low freq.** With N = 2048 at 50 Hz, the
   buffer holds 46 ms. The on-screen trail length is governed by the
   fade-clear alpha, not by N. So changing N at low freqs (we don't,
   per §3) wouldn't affect trail length anyway. Confirms the fix is
   "free" at the bottom of the range.

---

## 9. Files likely to be touched / added

**Modified:**
- `src/components/Oscilloscope.jsx`
  - Add `adaptiveBufferSize` helper.
  - Compute `N` once per frame in `drawScope` from current freqs +
    active keyboard voices.
  - Pass `N` into `synthStereoData(N, sr)` / `synthHilbertData(N, sr)`
    calls in modes 0, 2, 3.
  - Remove the redundant `XY_RENDER_N = 2048` trim in `drawXY` (or
    keep it as `Math.min(dataLen, MAX_N)` to be defensive).

**Optional later:**
- `src/components/SettingsPanel.jsx` — new "Visualizer" section with
  the trail-length / cycles-per-frame slider.
- `src/App.jsx` — URL serialization for the slider.

No new modules required for the core fix. No audio-graph changes —
only the visualizer's synth buffer length moves.
