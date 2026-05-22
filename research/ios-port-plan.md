# iOS Port Plan — Web → Native

Snapshot of what's in the web app (`wavetuner/`), what's in the iOS app (`wavetuner-native/ios/`), and the gap for each of the seven requested features. Each section ends with a concrete porting suggestion and risks. Order at the bottom is my recommendation for incremental shipping.

> **Working dirs**
> - Web: `/Users/dang/Development/wavetuner-workspace/wavetuner/src/`
> - iOS: `/Users/dang/Development/wavetuner-workspace/wavetuner-native/ios/WaveTuner/`

---

## iOS baseline — what exists today

- **Audio**: `AVAudioEngine` with a custom render block — `Audio/AudioEngine.swift:136–899`. **4 oscillators, hardcoded**, pure sine, always-on drones (no gates, no envelopes). Frequencies `[101.25, 102.78, 204.03, 204.66]` Hz, channel routing `[L, R, L, R]` (`AudioEngine.swift:131–132`). Per-osc frequency glide and gain smoothing both implemented.
- **Visualizer**: `Views/OscilloscopeView.swift` — Core Graphics CGContext rasterization, not Metal. Lissajous + Hilbert modes. `Audio/HilbertTransform.swift` is a real FFT-based Hilbert (Accelerate). No shaders anywhere yet.
- **Colors**: `Models/OscillatorColors.swift` — 4 fixed colors taken from the web's *old* `CLASSIC_PALETTE` (red/green/blue/yellow only). No theme system, dark mode forced.
- **Note display only**: `Models/NoteHelper.swift` formats frequencies as "G#2 +23¢" for the UI, but there's no keyboard or MIDI anywhere — no CoreMIDI/MIDIKit imports.
- **Persistence**: none. The single "undo" is a `frequencySnapshot` slot used only by the JI align / randomize buttons (`AudioEngine.swift:578, 599–674`).
- **Other things already shipped on iOS that the web doesn't have**: mic passthrough with LPF/HPF + reverb, camera underlay (grayscale feed behind scope), generative JI mode with portamento controls, group toggle.

Build config: SwiftUI app, iOS 17, Swift 5.9, XcodeGen-driven `project.yml`, `com.wavetuner.app`, mic permission + `UIBackgroundModes: audio` already declared.

---

## Feature 1 — Detune / Stereo

### Web
`src/audio/StereoMode.js:1–175` defines two per-pool singletons: `droneStereo` ('lr' default, 1 Hz) and `keyboardStereo` ('stereo' default, 1.5 Hz). Two modes per pool:
- **`lr`** — hard L/R routing per the engine's output map; `detuneCurve` ignored.
- **`stereo`** — each slot spawns *two* oscillators panned hard L and hard R, offset by `±curve[i] · detuneHz / 2`. Keyboard voices get a single osc panned center with an additive detune shift.

`detuneCurve` is a per-slot `[0,1]` weights array, resized when slot count changes (`resizeCurve()` at `StereoMode.js:134`), seeded with a Perlin-style smooth-random pattern (`randomizeCurve()` at line 39). `detuneHz` is the master scale (range 0–10 Hz). UI lives in `src/components/StereoModeControls.jsx` + `src/components/GlobalDetuneOrb.jsx`. Used by AudioEngine for drones and by `KeyboardVoiceManager.js:509` for note-on voices.

### iOS state
**Missing entirely.** Routing is the static `[0,1,0,1]` array. No per-osc detune, no pan.

### Port approach
1. Add a Swift `StereoMode` model that mirrors the web singleton: `mode: .lr | .stereo`, `detuneHz: Float`, `detuneCurve: [Float]`. Two instances (`droneStereo`, `keyboardStereo`) on AudioEngine.
2. Audio rendering split: in `'stereo'` mode, each logical drone needs two phase accumulators (L = `f + curve · detuneHz/2`, R = `f − curve · detuneHz/2`). Drop into the existing render block at `AudioEngine.swift:865`. This roughly doubles the inner-loop math; fine for 4 osc, watch CPU if you scale up.
3. Curve seeding: port the Perlin smooth-random generator straight across — pure math.
4. UI: a horizontal "stereo orb row" + a single `detuneHz` slider; tap an orb to randomize its curve weight.

### Risks / notes
- Web caps at 10 oscillators; iOS at 4 today. Decide whether iOS gains slot expansion *before* you bake in `'stereo'` mode (doubling at 12 osc is harmless; at 24 less so).
- Pan in iOS render block: don't reach for `AVAudioMixerNode` pan — you're already in a manual render callback, just write L and R samples directly.

---

## Feature 2 — Hydra visualizer → Metal

### Web
`src/visuals/Hydra.js` boots a `hydra-synth` instance with `makeGlobal: true`. The oscilloscope `<canvas id="scope">` is registered as source `s0` (`Hydra.js:37–39`), then a sketch string is `eval()`'d. Three builtins in `hydraSketches.js`:
- **Chromatic** (default) — RGB-split lissajous with feedback noise
- **Feedback chromatic** — constant-scale feedback at 1.05, blend 0.23
- **Mouse feedback** — feedback scale/blend driven by `mouse.x/y`

User sketches persist in localStorage (`hydraStorage.js`). Audio features exposed on `window.audio` for in-sketch modulation.

### iOS state
None. `OscilloscopeView.swift` is pure CGContext today.

### Port approach (recommended: hand-translated MSL, ship 3 presets)
The research agent dug into this; bottom line — **don't try to recreate Hydra's live-coding loop on v1**. Three sketches with the same shape (RGB-split + feedback) port to one parameterised Metal fragment shader.

1. **Render harness**: replace the CGContext oscilloscope path with `MTKView` (wrapped in `UIViewRepresentable` for SwiftUI). Two passes:
   - **Pass A** — render the oscilloscope strokes *into* an offscreen `MTLTexture` (call this `s0`).
   - **Pass B** — fullscreen quad fragment shader samples `s0`, applies the Hydra effect, writes to screen. Needs **ping-pong textures** for `o0` so this frame can sample last frame (feedback).
2. **GLSL → MSL**: For three sketches, hand-translate. Apple's `MTLDevice.makeLibrary(source:)` *does* allow runtime MSL compilation (slow first compile but fine for live coding), so the "live editor" lane is open if you want it later — see `research/06-visualization.md` and the agent's notes.
3. **Hydra-export shortcut**: in the web app, replace `.out(o0)` with `.glsl()` to get the compiled fragment source. Useful as a reference when translating, even if you don't ship an automated pipeline.

### Risks / notes
- The current oscilloscope's "glow" pass (2–5 layered strokes, `OscilloscopeUIView.swift:416–530`) becomes trivial in MSL (one `gauss` blur or extra read taps). You'll likely simplify it.
- Feedback ping-pong requires careful resize handling on rotation — destroy and recreate both textures.
- Hilbert mode is independent of Hydra; keep the Accelerate FFT path and just have it feed the same `s0` texture.
- Curated presets > full Hydra parity for v1. The web app's user-sketch list is "Yours" in localStorage — nobody's sharing iOS shaders by URL on day one.

---

## Feature 3 — Latest colors

### Web
`src/theme/palette.js:53–93`. Singleton with two themes:
- **`duo`** (default) — index 0 is blue `#4a9eff`; one orange `#ff8c1a` at the Euclidean half-point `round(N/2)` (with a music-theory tweak at `N=12 → index 7` for the perfect fifth); all other slots `#e8edf5` white.
- **`classic`** — 12-color rainbow (`CLASSIC_PALETTE`).

Subscribe pattern (`palette.onChange(fn)`) for non-React redraws; `useTheme()` hook for React. URL param `t=duo|classic`.

### iOS state
Wired only to the first 4 of `CLASSIC_PALETTE` — the **old** look. No `duo`, no switcher.

### Port approach
1. Rename/replace `Models/OscillatorColors.swift` with a `Palette` enum / singleton matching the web shape: `theme: .duo | .classic`, `oscColor(index, count) → Color`. Identical math.
2. Persist active theme to `UserDefaults`.
3. Settings UI: a 2-row picker in `SettingsPanel.swift`.

### Risks / notes
- The Euclidean `round(N/2)` placement only behaves nicely at `count ≥ 5`. iOS will hit this once slot expansion lands; pin tests around `N=2,4,5,7,12`.
- All current iOS UI (`Views/*Fader.swift`, spectrum bar, mute dots) reads `OscillatorColors.color(for:)` — rewire callsites to `palette.oscColor(index, count)` and pass `count` through. Mechanical but pervasive.

---

## Feature 4 — Keyboard (playable instrument) + MIDI

### Web
`src/audio/KeyboardVoiceManager.js:1–1039` is the heart. Voice cap 32, source-tagged voices ('kbd' vs 'midi'). On `noteOn(slot, octave, midiNote)`, a voice is bound to a *drone slot* (not a degree) so reordering doesn't change pitch (`KeyboardVoiceManager.js:484`). Two sources:
- **kbd** (computer keyboard) — default 2-voice cap, hold-mode ON, AR-only envelope (long-attack expression).
- **midi** — default 32-voice cap, hold-mode OFF, full ADSR.

Hold-mode semantics, sustain pedal (CC 64) deferring releases (`KeyboardVoiceManager.js:633`), velocity curves `soft|hard|fixed|linear` (`line 440–446`), and toggle-vs-restart re-press behavior all live here.

Note routing is *not* a fixed chromatic scale — `src/audio/Tuning.js` maps each keyboard key onto a *drone slot index*, and the drone-slot's actual frequency is whatever the user has dragged it to. Two modes: `chromatic` (12 white+black keys → up to 12 slots) and `white-only` (7 white keys → up to 7 slots). Two fills: `fill` (cycle through slots beyond octave) or `jump` (silence beyond N slots). See `App.jsx:357–370` and `research/keyboard-instrument.md`.

MIDI input: `src/audio/MidiInput.js` uses Web MIDI, NOTE_ON/NOTE_OFF/CC64 only, hot-plug via `onstatechange`. iPad target needs CoreMIDI USB-MIDI + Bluetooth MIDI in for parity (no Web MIDI on iOS Safari anyway).

### iOS state
None. No keyboard view, no MIDI imports. Only `NoteHelper.swift` (frequency-to-name display).

### Port approach
This is the biggest single feature. Suggested phasing:
1. **Foundation**: port `Tuning.swift` (key mode + fill mode + `degreeAndOctaveForMidi`).
2. **VoiceManager**: a Swift `KeyboardVoiceManager` actor that allocates voices and writes target gains/freqs into the audio render block. Tag voices by source. Reuse the slot-binding model — don't bind to MIDI note, bind to *drone slot index*. Will require AudioEngine to expose dynamically-allocated voice slots in addition to its 4 fixed drone slots; or you treat the drones as voice 0..3 of a unified pool.
3. **On-screen keyboard**: a SwiftUI view, probably an `iPad`-first layout that mirrors `OnScreenKeyboard.jsx`. Per `research/keyboard-instrument.md`, the layout is opinionated — re-read that doc before designing.
4. **MIDI**: CoreMIDI client + virtual destination. Subscribe to NOTE_ON/OFF/CC64. Bluetooth-LE-MIDI just works through CoreMIDI on iOS 17. For audio-thread-safe note delivery, push into a lock-free SPSC ring buffer consumed by the render block, same pattern as the existing mic ring buffers.
5. **Velocity curves + hold + ADSR**: small math, depend on Feature 7 landing first.

### Risks / notes
- Computer-keyboard input is irrelevant on iOS; budget it only if you target iPad with a hardware keyboard. Otherwise drop and let on-screen + MIDI carry the load.
- Voice allocation interacts with Stereo mode (each voice in `'stereo'` keyboard mode = two oscs). Plan the render block before you write it.
- iPad MIDI requires Inter-App Audio entitlement? No — CoreMIDI is unrestricted, just declare nothing extra. Bluetooth-LE-MIDI peripheral mode (broadcasting OUT *as* a controller) does need `NSBluetoothAlwaysUsageDescription` and is probably out-of-scope.
- See `research/keyboard-instrument.md` for the layout/UX rationale — the agent flagged this doc; consult before building UI.

---

## Feature 5 — Wave folding & wave shaping

### Web
**Shape morph** — `src/audio/Wave.js`. `position ∈ [0, 3]` linearly interpolates between four Fourier-series anchors (0=sine, 1=triangle, 2=sawtooth, 3=square), `Wave.js:27–72`. Coefficients cached as `PeriodicWave` per `(context, position-slot)` to avoid recompute during drags (`Wave.js:110–127`). Two singletons `droneWave`, `keyboardWave`.

**Wavefolding** — `src/audio/Fold.js`. West-Coast sine-fold curve: `drive = 1 + amount · 3` (range [1,4]), curve = `sin(drive · π · x)` sampled to a 2048-point lookup applied via `WaveShaperNode` with `oversample='4x'` (`Fold.js:42–82`). Two singletons.

Both per-pool: drone bus and keyboard bus get independent settings.

### iOS state
None. `WaveformSynth.swift` and the render block both emit `sin(phase)`.

### Port approach
1. **Shape morph**: pre-compute the same four Fourier anchors as fixed-length lookup tables. At synth time, do a wavetable lookup per anchor and lerp by `position`. Web uses Web Audio's `PeriodicWave` (which does an inverse-DFT under the hood); iOS doing a direct sample-by-sample lookup is faster anyway. Anti-aliasing — band-limit by truncating harmonics above Nyquist when building tables, mirroring what `PeriodicWave` does behind the scenes.
2. **Wavefold**: port `buildSineFold()` verbatim to a 2048-element `Float` lookup table. In the render block, after generating the raw sample, do `output = fold[clamp(sample * (1 + amount*3), -1, 1) * 1023 + 1024]` (or whichever index scheme matches the web). The web uses 4× oversample via `WaveShaperNode` — for parity, run a 4× upsample → fold → decimate. Cheap polyphase FIR is fine; or skip oversample and accept some aliasing at high drives initially.
3. **Per-pool**: keep the `droneWave/keyboardWave` split. Even at v1 with a single bus, the data model should already be per-pool so it doesn't need refactoring once keyboard lands.

### Risks / notes
- Without oversample, fold at high `amount` will alias audibly above ~2 kHz fundamental. Acceptable for v1, fix later.
- See `research/waveshaping.md` for the curve derivation rationale.

---

## Feature 6 — Save states, undo/redo

### Web
`src/patches/schema.js` defines `PATCH_SCHEMA = 'wavetuner.patch.v1'`. localStorage-backed:
- Per-user patches: `{id, name, createdAt, updatedAt, source: 'user', frequencies | (ratios + anchorHz), snapshot: {volumes, muted, routing, stereo, envelopes, wave, fold, ...}}`
- **Autosave**: single rolling slot written every state mutation, restored on boot when no URL params (`src/patches/storage.js:122`, `App.jsx:555–585`).
- Cross-tab sync via `storage` event.

`capturePatch()` snapshots live engine state. `applyPatch()` / `applyPatchSmooth()` restore — smooth path lerps freqs+volumes when shape (osc count + routing) matches.

**No explicit undo/redo stack** — patches are snapshots. The only "undo" is the iOS-side JI-align undo (one slot), and it's iOS-only.

### iOS state
No persistence. Single-slot align undo only.

### Port approach
1. **Schema**: port `schema.js` to a Swift `Patch` struct, `Codable`. Use the *same* `PATCH_SCHEMA` version key so future cross-platform sharing is possible.
2. **Storage**: `JSONEncoder` + `FileManager` writing to `Application Support/patches/`. Index file + per-patch JSON, same shape as web's localStorage layout.
3. **Autosave**: subscribe to engine state changes, debounce 1s, write to a single `autosave.json` slot. Restore on launch.
4. **Undo/redo**: introduce a small in-memory ring of snapshots (capture on every "settled" mutation — i.e. on slider release, not during drag). Cmd+Z on iPad keyboard, swipe-to-undo gesture on iPhone, plus an explicit button. The existing JI-align snapshot becomes one item in this ring.
5. **Patches UI**: SwiftUI sheet, save/load/rename/delete. Builtin patches can ship as JSON in the app bundle.

### Risks / notes
- iCloud sync is a nice-to-have but a separate project. Land local-only first.
- The web URL-share flow (`App.jsx:655–751`) compresses everything into query params. iOS won't have the same browser-URL flow, but the same encoded string could become a sharable deep-link if you want parity later.

---

## Feature 7 — ADSR

### Web
`src/audio/Envelope.js` — one `Envelope` class, three singletons (`Envelope.js:124–147`):
- **`droneEnvelope`**: A=0.3s D=0.2s S=0.7 R=0.5s — slow swells.
- **`keyboardEnvelope`**: A=0.1s D=1.0s S=0.4 R=0.3s — MIDI poly, full ADSR.
- **`computerKbdEnvelope`**: A=2.0s D=0.001s S=1.0 R=0.7s — **AR-only** (no decay/sustain), long-attack expression.

Implementation: Web Audio gain ramps. `applyNoteOn` schedules `0→peak` over attack then `peak→peak·sustain` over decay; `applyNoteOff` ramps to 0 over release. `retargetSustain` glides held voices to a new sustain level via `setTargetAtTime` (tau 0.05s). See `research/adsr-envelope.md`.

### iOS state
None. Volumes are always-on with ~300ms gain smoothing.

### Port approach
1. **Model**: port the `Envelope` struct (just 4 floats + a `mode: .ar | .adsr` flag). Three instances (`drone`, `keyboard`, `computerKbd`).
2. **Render**: in the audio render block, give each voice an envelope-state machine `(stage, stageStartTime, levelAtStart)` and compute current gain from `now - stageStartTime`. Avoid `setTargetAtTime`-style exponentials on the audio thread — linear ramps are perfectly audible-as-natural for A/D/R.
3. **Drone bus**: today every osc is "always on at sustain=1". Keep that as the *default*, but route drone slot mute toggles through `applyNoteOn`/`applyNoteOff` so envelope shapes work consistently.
4. **Live slider behavior**: when the user drags a sustain slider with notes held, retarget glide them to the new level (same as `Envelope.js:112`).
5. **UI**: a single ADSR card with 4 sliders + a live curve preview (port `EnvelopeGraph.jsx`). Eventually one card per pool (drone/keyboard).

### Risks / notes
- Computer-keyboard's AR-only mode is computer-keyboard-only; if you skip computer-keyboard on iOS, this singleton drops out.
- Drones are currently the entire iOS feature — switching them through an envelope state machine is the most invasive change of all the features. Verify there's no audible click when a 0-attack 1-sustain envelope is wrapped around an existing always-on drone before shipping.

---

## Suggested rollout order

I'd ship these in roughly this sequence — each unblocks or simplifies the next:

| # | Feature | Why this slot |
|---|---|---|
| 1 | **Colors (duo theme)** | Pure UI, no audio risk, immediate visible refresh. Rewires palette callsites — do it before you fork more views. |
| 2 | **Save states (no undo yet)** | Foundation for everything that follows; you'll want to test new features by save-load-tweak. Also lets users keep work between builds. |
| 3 | **ADSR** | Required by Keyboard. Best to bake the envelope state machine into the render block once, before voices arrive. |
| 4 | **Wave shape + wave fold** | Audio-only changes inside the render block. Independent of voices/MIDI. High user-facing impact for low integration risk. |
| 5 | **Stereo / detune** | Touches the render block again (per-channel write). Easier after wave-shape is in because the inner loop already has structure. |
| 6 | **Keyboard + MIDI** | The big one. Land it once ADSR + Stereo + Save-states are stable so you're not debugging four new systems at once. |
| 7 | **Hydra → Metal visualizer** | Independent track — could be done in parallel by a separate person. Big visual win but doesn't unblock anything. Curated MSL preset approach, not full live-coding parity, for v1. |

**Undo/redo** rides along with Save-states (step 2) or gets bolted on after Keyboard (step 6) — whichever, it's a small surface.

---

## Open questions / decisions

- **Oscillator slot expansion**: web supports 2–12, iOS hardcoded at 4. Several of these features (Stereo curves, Keyboard slot binding, Colors duo placement) get noticeably richer at higher counts. Worth deciding whether to expand iOS's slot range *before* features 5/6 land, since it changes the data shapes you'll be writing.
- **iPad-first vs iPhone-first**: Keyboard + MIDI lean iPad. Hydra lean iPhone-friendly. The two features have nearly opposite hardware sweet spots; consider which device the next TestFlight focuses on.
- **Pure-Swift vs JUCE plugin reuse**: there's a `wavetuner-native/plugin/` JUCE tree that already has Oscillator / LFO / Lissajous DSP. Worth checking whether any DSP from there is portable into the iOS app via a static lib, vs. re-implementing in Swift. (I didn't dive into it — flag for follow-up.)
- **Live-coding Hydra in iOS**: the agent confirmed runtime MSL compilation is viable via `MTLDevice.makeLibrary(source:)`. Defer until after the curated preset path proves out.

---

## Reference files

Web side:
- `src/App.jsx:1–1105` — the wiring layer; every feature flag and singleton is touched here
- `src/audio/StereoMode.js`, `Wave.js`, `Fold.js`, `Envelope.js`, `KeyboardVoiceManager.js`, `MidiInput.js`, `Tuning.js`
- `src/theme/palette.js`
- `src/patches/{schema,storage,apply}.js`
- `src/visuals/{Hydra,hydraSketches,hydraStorage}.js`
- `research/adsr-envelope.md`, `research/keyboard-instrument.md`, `research/waveshaping.md`, `research/06-visualization.md`, `research/user-storage-architecture.md`

iOS side:
- `WaveTuner/Audio/AudioEngine.swift` (the one big file)
- `WaveTuner/Audio/WaveformSynth.swift`
- `WaveTuner/Views/{ContentView,OscilloscopeView,SettingsPanel}.swift`
- `WaveTuner/Models/{OscillatorColors,NoteHelper}.swift`
- `WaveTuner/project.yml`
