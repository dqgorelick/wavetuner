# Timeline / Piano-Roll Frequency Visualizer — Spec

Status: proposed
Author: spec drafted 2026-07-02

## 1. Goal

A new visualizer mode that plots **which frequencies are sounding, over time** —
an arrangement-view / piano-roll timeline. It is a **stand-in for the
oscilloscope** for users who want to see change *over time* (which the XY / Lissajous
/ standing-wave scopes can't show — they only show an instantaneous window).

Core behavior:

- **Unquantized lines**, drawn continuously and scrolling. Not a grid of note
  rectangles — thin polylines that bend with detune / transpose / glides, since the
  tuning system is fully microtonal.
- **Scrolling waterfall**: "now" is pinned at the **right edge**; history scrolls
  **left** and falls off. (Decided over a sweeping-playhead model.)
- **Everything sounding** is drawn: drone oscillators (continuous held bands) **and**
  keyboard / MIDI played notes (discrete segments). (Decided over played-notes-only.)
- **Logarithmic Y axis** (equal vertical space per octave); low frequencies at the
  **bottom**, high at the **top**. (Decided over linear Hz.)
- **No audio-buffer access.** Everything is derived from the engine's note/voice
  state — `audioEngine` drone frequencies and `keyboardVoiceManager` voices — never
  from the `AnalyserNode` time-domain buffer. (Explicit constraint.)
- Should **feed Hydra** (see §9 — largely free if it renders to the scope canvas).

## 1a. "Off" quality → Timeline (implemented)

The visualizer **"Off" quality tier no longer blanks the scope** — it falls back to
this timeline. Rationale: an always-something lightweight view is more useful than a
black screen, and the timeline is cheap (frequency reads only, no FFT, no phase). So
`vizQuality === 'off'` forces `vizMode = 4` in the render loop, and both `'off'` and
`'performance'` take the cheaper per-frame path. Timeline is *also* independently
selectable as mode 4 from the visualizer dropdown.

## 2. Where it lives

Add it as a **new `vizMode`** (id `4`) rather than a separate mounted component.

Rationale:
- The user framed it as "a mode that is a stand-in for the oscilloscope" — i.e.
  mutually exclusive with the other scope modes. `vizMode` is the one existing
  mutually-exclusive selector (`VIZ_MODES` in `App.jsx:204`, dropdown at
  `App.jsx:1307`), so it fits.
- It renders into the existing `#scope` canvas, which is **already wired into Hydra
  as source slot `s0`** (`src/visuals/backends/hydra.js:75`) — so `src(s0)...`
  sketches get the timeline for free with zero extra plumbing (§9).
- Reuses the existing per-frame `requestAnimationFrame` loop, DPR sizing, quality
  tiers, and color-cycle scaffolding in `Oscilloscope.jsx`.

Trade-off accepted: the timeline needs to **retain history across frames** (unlike
the stateless scopes), so it introduces the first piece of persistent frame-to-frame
state in `Oscilloscope.jsx`. That state lives in a module-level ring buffer (§4), not
in React, matching the imperative style of the file.

### Touch list

| File | Change |
| --- | --- |
| `src/components/Oscilloscope.jsx` | New `drawTimeline()` fn + `vizMode === 4` branch in `drawScope`; new prop refs for the timeline controls; module-level history buffer + sampler. |
| `src/App.jsx` | 5th entry in `VIZ_MODES` (id 4, label "Timeline", icon); new state `timelineWindowSec`, `timelineFreqMin`, `timelineFreqMax` (+ localStorage persist, matching the `vizCycles` pattern at `App.jsx:337-411`); pass as props to `<Oscilloscope>`. |
| `src/components/HydraPanel.jsx` (or a small overlay) | Sliders for the X-range (time window) and Y-range (freq min/max) controls, alongside the existing viz sliders (§8). |
| `src/audio/AudioEngine.js` | (Maybe) a `getSoundingFrequencies()` helper that folds in transpose, so the timeline and future consumers share one definition of "actual sounding Hz" (§4.3). |

## 3. Data sources (no audio buffer)

All read imperatively each frame from the two singletons, exactly as the other scope
modes read them.

**Drones** — the continuously-held oscillators:
- `audioEngine.getAllFrequencies()` → nominal Hz per slot. **Excludes transpose**
  (transpose is applied in the pitch getters, not folded into `frequencyValues` —
  see `AudioEngine.js:28-35, 1161`). See §4.3 for how to reconcile.
- `audioEngine.isMuted(i)` — muted slots are excluded (their band ends).
- `audioEngine.volumeValues[i]` and `audioEngine.getDroneVizGain()` — for
  amplitude → line brightness/width, and to fade a band out with spacebar/pause.
- `palette.oscColor(i, count)` — slot color (same colors as the spectrum-bar orbs).

**Played notes** — keyboard + MIDI voices:
- `keyboardVoiceManager.getActiveVoices()` (`KeyboardVoiceManager.js:882`) → snapshot
  of `{ id, midiNote, degree, slot, octave, released, amp, source, startTime, freq }`.
  - `id` — stable per voice; **the key for tracking a note across frames**.
  - `freq` — smoothed **actual sounding** Hz (includes detune + transpose, because
    voices retune through `pitchForSlotAndOctave` × transpose).
  - `startTime` — in `audioContext.currentTime` seconds.
  - `source` — `'kbd'` | `'midi'`; lets us style computer-keyboard vs MIDI notes
    differently and satisfies "record the MIDI notes coming in."
  - `slot` / `degree` — for color (`palette.oscColor(slot, count)`), matching how
    voices already borrow their drone slot's color in the standing-wave scope.
  - `released` / `amp` — a released voice keeps drawing (fading) until `amp` hits 0.

> `getActiveVoices()` returns plain objects (built for the mixer + on-screen keyboard),
> which is a cleaner feed than `getVoicesForSynth()` (which is phase/pan-oriented for
> the synth XY path). Use `getActiveVoices()`.

**MIDI note flow, for reference:** `MidiInput._handleMessage` (`MidiInput.js:177`)
forwards note-on/off straight into `keyboardVoiceManager.noteOn/noteOff`. There is
**no existing note-history log** — MidiInput and the voice manager only expose the
*live* set. The timeline must build and retain its own history (§4).

## 4. Data model

### 4.1 Lanes and traces

Model each sounding source as a **lane** producing a **polyline trace** of samples
over time. This one representation handles both drones (long steady lines) and played
notes (short lines) uniformly, and naturally captures unquantized glides / detune /
transpose bends — which a note-rectangle model could not.

```
Lane key:
  drone → `d:<slot>`         (one lane per oscillator slot)
  voice → `v:<voiceId>`      (one lane per live voice id)

Sample (per lane, per frame it is audible):
  { t: seconds, f: soundingHz, amp: 0..1, color, source }

Trace:
  { key, source, color, points: Sample[], startT, lastT, active }
```

### 4.2 Sampling (once per frame, in `drawTimeline`)

```
now = audioContext.currentTime
for each drone slot i:
   if !isMuted(i) && soundingFreq(i) > 0 && droneVizGain > 0:
       append { t: now, f: soundingFreq(i), amp: volume[i]*droneVizGain, ... }
         to lane d:i   (create lane if new)
   else: mark lane d:i inactive (its current segment ended)

for each voice v in getActiveVoices():
   append { t: now, f: v.freq, amp: v.amp, source: v.source, ... } to lane v:<id>
voices whose id vanished this frame → mark lane inactive
```

Because samples are appended every frame, a steady drone becomes a dense horizontal
line and a bent note becomes a smooth curve — no interpolation guesswork.

### 4.3 Frequency reconciliation (transpose)

Drone `getAllFrequencies()` is **nominal** (pre-transpose); voice `freq` is
**post-transpose**. To draw both on the same axis consistently, convert drones to
sounding Hz:

```
soundingFreq(i) = audioEngine.getFrequency(i) * audioEngine.getTransposeRatio()
```

**Recommended:** add `audioEngine.getSoundingFrequencies()` returning
`frequencyValues.map(f => f * transposeRatio)` so this definition lives in one place.
(Verify against the existing pitch getter at `AudioEngine.js:~1161`, which already
applies `_transposeRatio` — reuse that path rather than re-deriving.)

### 4.4 History retention & memory bound

- Prune points older than **`max(windowSec, RETAIN_SEC)`** from the left. `windowSec`
  is what's visible; `RETAIN_SEC` (e.g. 180 s) is a longer retention so the user can
  widen the X-range slider and see recent history that already scrolled off.
- Drop lanes that are inactive **and** whose last point is older than the retention
  window.
- Cap total retained points defensively (e.g. 250k) and drop oldest if exceeded —
  `log()`-style console warn if we ever hit it, so silent truncation is visible.
- Cost estimate: ~60 fps × 180 s × (4 drones + ≤32 voices) ≈ 390k point-slots worst
  case; in practice far fewer voices are live. Comfortable for a `Float32`-backed ring
  buffer; a plain array of small objects is also fine for v1.

> "Record the MIDI notes coming in" (§1) is satisfied by this retained event history.
> **Optional follow-on** (out of v1 scope): expose an export of the voice-note lanes
> as JSON/MIDI, tying into the existing capture UI (`CaptureButton.jsx` /
> `CaptureBar.jsx`). Flagged, not specced here.

## 5. Coordinate mapping

**X (time):** drawn into the **centered middle 70%** of the width (same `TL_BAND_FRAC`
as Y). "Now" sits at the band's right edge (`xRight`), history runs left to `xLeft`.
```
bandW = width * 0.7 ;  xLeft = (width - bandW)/2 ;  xRight = xLeft + bandW
x(t) = xRight - ((now - t) / windowSec) * bandW    // t < now-windowSec → past xLeft
```
`windowSec` is the X-range control (default 12 s; range ~2–120 s). The **left** edge
**fades to black** (a linear-gradient vignette painted over the band after the traces)
so old history dissolves as it scrolls off — matching the spectrum bar's edge fade. The
**right** edge (where "now" is, so where notes onset) is left **crisp** with no fade, so
note onsets read sharply.

**Y (log frequency):** low at bottom, high at top, drawn into a **centered band =
70% of the usable height** (`TL_BAND_FRAC`) so the traces sit in the middle of the
screen rather than edge to edge.
```
bandH = usableHeight * 0.7 ;  bandTop = (usableHeight - bandH) / 2
y(f) = bandTop + bandH * (1 - (log2(f) - log2(fMin)) / (log2(fMax) - log2(fMin)))
```
`fMin` / `fMax` are the Y-range controls (default e.g. 55 Hz → 4186 Hz, i.e. A1–C8).
Reuse the log-frequency mapping approach already in `FrequencySpectrumBar.jsx` (it maps
by Hz in log space, not by semitone — correct for the microtonal tuning). Clamp/skip
points outside `[fMin, fMax]`.

Use `usableHeight` exactly as the other modes do (`height - BOTTOM_RESERVED - kbdTrayH`,
`Oscilloscope.jsx:1061-1070`) so the timeline centers in the visible region above the
orbs / keyboard tray.

## 6. Rendering

Draw order each frame (opaque background — this mode has no persistence-fade, unlike
the XY scopes):

1. **Clear** the usable region opaque (`rgba(0,0,0,1)`), plus the reserved bottom strip
   (already handled by `drawScope` at `Oscilloscope.jsx:1079`).
2. **No gridlines or axis labels** — the band is plain black behind the traces. (Octave
   gridlines were tried and removed; with the auto-fitting range they read as visual
   noise.)
3. **Lane traces:** for each lane, stroke its polyline through `(x(t), y(f))` using the
   **same two-pass look as the oscilloscope** (`drawXY`): a **colored outline** pass
   under a **white core** pass. All traces share the global **20-minute cycling color**
   (the same `r,g,b` the XY scope uses), not per-orb slot colors. Widths honor the
   **same Visualizer-panel sliders** as the scope: **Outline** (`vizOutline`) scales the
   colored halo — 0% collapses it to just the white core — and **White line**
   (`vizLineWidth`) scales the white core.
   - **Amplitude → line weight + alpha** (`amp`), so quiet/releasing notes thin out and
     fade; released voices taper to nothing as `amp → 0`.
   - **Gap-breaking:** the path breaks (moveTo, not lineTo) whenever consecutive
     samples are more than `TL_GAP_SEC` (0.1 s) apart. A drone toggled off stops
     sampling, so toggling it off/on leaves real gaps — the line renders as **dashes**
     across the silent stretches instead of bridging straight across them.
4. Reuse the global 20-minute **color cycle** (`r,g,b` in `drawScope`) only for
   accent/grid tint if desired; note colors should stay slot-derived for legibility.

## 7. Controls

Two required controls, per the request ("controls to control the Y range and X range"):

- **X range** — `windowSec` (time span visible). Slider, ~2–120 s, default 12.
- **Y range** — a **Range** toggle (`auto` / `manual`, default **auto**) plus `fMin` /
  `fMax` sliders (default 55–4186 Hz, used only in manual).
  - **Auto (implemented):** each frame the view eases toward framing every frequency
    **still visible in the X window** — not just what's sounding right now, but notes
    that have ended and haven't scrolled off yet. This is the key to it not jumping:
    the range only starts to contract once an extreme actually leaves the left edge, so
    **shrinking lags by ~`windowSec`** and the view stays big meanwhile. Padding is a
    half-octave each side with a ~2.2-octave minimum span (so a single note doesn't zoom
    to a sliver). Expansion eases fast (`0.22`/frame — a new extreme at the right edge
    grows the view immediately), contraction slow (`0.035` — smooths the step when an
    extreme scrolls off). Eased in log2-Hz space; clamped to 20 Hz–20 kHz. State lives
    module-level in `Oscilloscope.jsx` (`_tlAutoEased`), reset to null on switch to
    manual so re-enabling snaps to live content. The Low/High sliders are disabled while
    auto is on.

Wiring pattern (follow the existing viz controls exactly):
- App owns state + localStorage (`lsNum('timelineWindowSec', 12)` etc.), like
  `vizCycles` (`App.jsx:337-411`).
- Passed as props to `<Oscilloscope>`; each mirrored into a `useRef` via its own
  `useEffect` (like `vizCyclesRef`, `Oscilloscope.jsx:939-942`) so the rAF loop reads
  live values without restarting.
- Surface the sliders in the **Hydra panel** next to the other visualizer sliders
  (`vizScale`, `vizLineWidth`, …), shown only when `vizMode === 4`.

Optional enhancements (nice-to-have, not v1-blocking):
- **Mouse wheel** over the canvas to zoom the Y range (freq); **shift+wheel** or
  horizontal drag to zoom/pan the X range. Note the canvas already has pointer handlers
  for VFX drag (`Oscilloscope.jsx:1307`); gate these so they don't fight — e.g. VFX
  drag only in the XY modes, timeline zoom only in mode 4.

## 8. Hydra feed

- **Automatic:** because the timeline renders into `#scope`, and that canvas is bound
  as Hydra source `s0` (`hydra.js:75/99`), any sketch doing `src(s0)…` already receives
  the timeline. No new plumbing.
- **Optional scalars:** extend `window.audio` (`AudioFeatures.js:57-111`) with a few
  normalized timeline-derived values for reactive sketches — e.g. `pitchHi` / `pitchLo`
  (normalized position of the highest/lowest active note), `noteDensity` (active voice
  count normalized), `attackPulse` (spikes on each note-on). These are cheap to compute
  from the same per-frame scan and follow the existing `window.audio` convention.

## 9. Performance & quality tiers

Respect the existing `vizQuality` prop (`Oscilloscope.jsx:991-1047`):
- `'off'` → blank once and idle (already handled generically before the mode branch).
- `'performance'` → sample the history at half rate (every other frame) and/or decimate
  points when drawing (skip points closer than ~1px in x); skip the optional
  `window.audio` timeline scalars unless something reads them.
- `'pretty'` → full per-frame sampling and full-resolution strokes.

Drawing cost is dominated by total visible points; decimate by x-pixel spacing so a
wide time window doesn't linearly increase stroke work.

## 10. Edge cases

- **Nothing sounding:** draw grid only; keep the retained history scrolling off.
- **Voice `id` reuse:** ids come from a monotonic `_nextVoiceId++`
  (`KeyboardVoiceManager.js:56, 581`), so no reuse collisions within a session.
- **Retune / transpose mid-note:** the polyline bends — desired. Global transpose
  shifts drones and voices together (both go through the transpose ratio), so bands and
  notes move coherently.
- **Mute/unmute a drone:** ends the current band, starts a fresh lane segment on
  unmute. Model as lane going inactive → new segment (don't bridge the gap).
- **Sustain pedal / hold:** irrelevant to drawing — a held/latched voice simply stays
  in `getActiveVoices()` and keeps sampling until it actually releases and `amp → 0`.
- **DPR / resize:** already handled by `resizeCanvas`; all mapping is in CSS pixels.
- **Tab backgrounded:** rAF pauses; on resume there's a time gap — either bridge lanes
  across the gap or (simpler) let the gap show as a break. Prefer letting it break.

## 11. Implementation checklist

1. `AudioEngine.getSoundingFrequencies()` (transpose-folded drone Hz). Verify against
   the existing transpose-applying pitch getter.
2. Module-level history buffer + `sampleTimeline(now)` in `Oscilloscope.jsx`.
3. `drawTimeline(ctx, width, usableHeight, ...)` — grid, mapping, lane strokes.
4. `vizMode === 4` branch in `drawScope`; opaque clear; call sampler + draw.
5. New control props + refs (`timelineWindowSec`, `timelineFreqMin`, `timelineFreqMax`,
   optional `timelineAutoRange`).
6. `App.jsx`: `VIZ_MODES` entry (id 4, "Timeline" + icon), state + localStorage, pass
   props.
7. `HydraPanel.jsx`: X-range / Y-range sliders shown when `vizMode === 4`.
8. (Optional) `window.audio` timeline scalars.
9. (Optional / later) export retained voice-note history via the capture UI.

## 12. Open questions / future

- ~~**Auto-fit vs manual Y range**~~ — done: `auto` (default) / `manual` toggle; auto
  eases to frame the sounding content.
- **Note labels** — show note names (nearest 12-TET) or raw Hz on the Y grid? Tuning is
  microtonal, so Hz is honest; note names are friendlier. Recommend Hz + optional
  nearest-note.
- **Export/record** — is "record" purely visual retention (specced) or does the user
  want a savable/exportable capture? If the latter, scope a MIDI/JSON export pass tied
  to `CaptureButton`.
- **Playhead alternative** — if the waterfall feels too busy for very long windows, a
  sweeping-playhead variant could be a sub-toggle later.
