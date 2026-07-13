# iOS UI Overhaul — Web Parity Pass 2

Plan for the big UI overhaul of `wavetuner-native/ios/`: porting the current web UI (`wavetuner/`) feature-by-feature. Successor to `ios-port-plan.md` (engine-feature port, now ~complete) — this pass is about the *surface*: the main page, the panels, and the visual identity.

Created 2026-07-06. Status tracking continues in `ios-port-status.md`.

> **Working dirs**
> - Web (source of truth): `wavetuner/src/`
> - iOS (target): `wavetuner-native/ios/WaveTuner/`
> - Owner agents: `wavetuner-ui`, `wavetuner-dsp`, `hydra-metal-porter` (`.claude/agents/`)

---

## Scope

**In this pass:**
- New **listener-mode main page** (spec below): play/pause, mute dots, next-chord, auto-mode, mic, revert
- **Spectrum bar always visible** as the core of the app, with **transpose swipe** on mobile
- **Save-state (chord slot) system** — capture/recall preset chords; backs the main page's Next-chord/auto-mode and gets its own menu
- **Mixer** (port of `Mixer.jsx` — channel rows, voice rows, bus strip, master + peak meters)
- **Performance mode menu** (assumed = the PERFORM parameter-lock panel; see Open Questions)
- **Tunings menu** (port of `TuningPanel` — per-slot ratio/Hz/note editor + system/scale/load/align)
- **Pianoroll visualizer** (the web "Timeline", vizMode 4)
- **Hydra RGB visual as the default mode** (Metal port of the `builtin_chromatic` sketch)
- **Camera underlay stays** (iOS-only feature, carried through the new layout)
- Remove the **on-screen keyboard**
- Hide **MIDI** UI (engine plumbing stays; UI gated off for now)

**Explicitly out (this pass):** MIDI UI, on-screen keyboard, Hydra live-coding parity, routing patch bay, share/URL flows, generative-panel redesign, iCloud sync.

---

## Where each side stands (2026-07-06 snapshot)

**iOS today** — single-screen `ZStack` in `ContentView.swift` (728 lines): scope zone on top, a mode-switched `controlsPanel` below (`.generative / .main / .settings` via `@State currentMode`), tab bar, `KeyboardTray` overlay, Granular + Patches as sheets. State layer is one central `AudioEngine: ObservableObject` (~55 `@Published` props, setter methods firing `stateDidChange` for autosave) + singletons (`Palette`, `Tuning`, `MidiInput`, `MidiOutput`, `PatchStorage`). Engine features from pass 1 all landed: wave/fold, ADSR, stereo/detune, voice manager, tuning model, patches, Metal oscilloscope (experimental, Lissajous-only).

**Web today** — `App.jsx` owns ~40 `useState` hooks mirroring module singletons. Full-viewport scope canvas + Hydra overlay canvas, `FrequencySpectrumBar` (orbs + dissonance HUD), left stack (`TuningPanel` + `PerformPanel`), right stack (`Mixer` + toggle button column KBD/MIXER/TUNING/PERFORM), bottom `OscillatorControls`, corner icons (help/patches/hydra/share/MIDI/settings).

**Already at parity (keep, restyle only):** FrequencySpectrumBar (iOS version at `Views/FrequencySpectrumBar.swift` is excellent — orbs, drag, edge-pan, collision, dissonance HUD), SettingsPanel content, PatchesPanel, palette/theme system, patch schema (`wavetuner.patch.v1` — cross-platform compatible).

---

## Main page layout — "Listener mode" (spec from Dan, 2026-07-06)

**Design principle:** the main page is for someone who has no idea what a synthesizer is but wants to *listen* — think "432 Hz endless meditation app", with the full synth available behind menus for people who want to go deeper. Zero-knowledge-safe: nothing on this page can put the app in a state one button can't fix.

**On the page (all of it, nothing more):**
- **Visual field** — Hydra chromatic (default) full-bleed behind everything. Camera underlay **stays** (iOS keeps the camera feature).
- **FrequencySpectrumBar** — always visible, the core. Orbs draggable as today. **NEW: transpose swipe** — dragging the bar background (the number strip) transposes globally, port of the web's `beginTransposeDrag` (`FrequencySpectrumBar.jsx:1110+`). Should feel great on touch — this is a headline mobile interaction.
- **Voice mute row** — one large tappable palette-colored dot per voice (mute/unmute). No faders here; volume lives in the Mixer.
- **Transport row:**
  - **Play / Pause**
  - **Next chord** — advance to the next save slot (preset chord) with a glide transition
  - **Auto-mode** — toggle; app advances to the next chord every X seconds on its own
  - **Mic** — ambient passthrough for listening to the room through the tuning (headphones use case; engine already has this)
  - **Revert** — the "fix it" button: glide back to the intended program, undoing orb drags / mutes / transpose
- **Menu access**, in priority order: **1) Mixer, 2) Save states, 3) Tuning, 4) Perform, 5) Patches** (+ Settings and Granular tucked at the end).

**Decisions embedded:**
- Save-slot indicators are **not shown** on the main page in v1 (Dan leaning no) — "Next chord" is the only preset surface here; managing slots happens in the Save-states menu.
- **Revert semantics v1:** snapshot engine state every time a chord/preset is applied; Revert glides back to that snapshot. Cheap, predictable, and covers everything a listener can break from this page.
- Presentation: iPhone-first — menus open as sheets/slide-overs above the always-visible spectrum bar; iPad can revisit docked web-style panels later.

---

## Feature plans

Each feature = a `(dsp)` engine work item + a `(ui)` view work item, same split as pass 1. Sizes: S < half day, M ~ a day, L = multi-day.

### A. Shell restructure — remove keyboard, hide MIDI, new scaffold

**Web ref:** n/a. **iOS refs:** `ContentView.swift`, `KeyboardTray.swift`, `OnScreenKeyboard.swift`, `SettingsPanel.swift`.

Blast radius is small and confirmed:
- Delete `KeyboardTray.swift` + `OnScreenKeyboard.swift`; remove the overlay at `ContentView.swift:38`, the piano-keys toggle button (`ContentView.swift:67-86`), and `isKeyboardOpen` state. Engine paths they exercise (`noteOnFromUI`, hold flags, `Tuning` key/fill modes) stay — MIDI-in and future features use them.
- Gate off SettingsPanel's "midi & keyboard (testing)" section (lines 123-156 + rows) and "mpe output" section (158-166). Suggest a single `showMidiSettings` flag defaulting false rather than deletion — pass 3 turns it back on.
- Rebuild `ContentView` scaffold to the new main-page layout (pending spec above). Introduce a proper panel-presentation system: replace the 3-case `PanelMode` enum with whatever the layout needs (likely: pinned spectrum bar + swappable panel region + persistent visual behind).
- Persist per-panel open state (web persists `mixerOpen`, `tuningOpen`, `performOpen`, `hydraEnabled` to localStorage → UserDefaults on iOS).

**Owner:** wavetuner-ui. **Size:** M (mechanical parts S; scaffold depends on layout spec). **Engine gap:** none.

### A2. Listener main page

**Web ref:** none — this page is an iOS-first design (the web boots into the full synth). **iOS refs:** `ContentView.swift` (replaces `mainModeBody` as the default surface), engine features mostly present.

Work items:
- **ui:** the page itself per the layout spec above — visual field, spectrum bar (pinned), mute-dot row, transport row, menu access. Large-touch-target, label-free-where-possible design; this is the app's face.
- **ui:** transpose swipe on the spectrum bar (background/number-strip drag = global transpose, with the web's damping/sensitivity feel adapted to touch). Needs the transpose engine gap closed first (see C).
- **dsp (S):** auto-mode — dwell on the current chord slot for X seconds, then advance. Transitions use the Perform engine's transition mode (glide / step / step-all): **v1 = plain glide** until D's RecallEngine lands, then it consumes D's machinery. Dwell X (and its range) is configured in the **Perform menu**, persisted.
- **dsp (S):** revert — snapshot on every chord-slot apply; `revertToLastSaveState()` glides back to the last-applied save state.
- Already on iOS, just re-surfaced: play/pause (`start()`/stop), per-osc mute, mic passthrough (`passthroughVolume` + mic pipeline), camera underlay.

**Depends on:** A (shell), H-lite (chord slots to advance through — v1 can ship with a bundled factory chord set). **Owner:** ui L, dsp S. 

### H. Save states — chord slot system + menu

**Web ref:** `CaptureBar.jsx` + `frequencyManager` staged save-slot launch state (`getLaunchState/getStagedVolumes/getStagedMutes`, stage markers on the spectrum bar). **iOS ref:** none — distinct from `PatchesPanel` (named full presets). Interpretation to confirm: *save states = ordered quick chord slots* (capture-now, cycle-through, performance-oriented), *patches = named library presets*.

Work items:
- **dsp (M):** `ChordSlots` model — an ordered list of lightweight snapshots (frequencies, volumes, mutes — a subset of `PatchSnapshot`), capture/recall/reorder/delete, `advance()` with glide, persisted; ship with a curated factory set (the "intended program" chords). Recall respects the Perform panel's recall scope once D lands; until then it recalls everything.
- **ui (M):** the Save-states menu — slot list with capture button, tap-to-recall, reorder, delete; current-slot indicator. (Spectrum-bar stage markers like the web's are a later nicety.)

**Depends on:** A. Main page (A2) consumes the dsp half. **Owner:** dsp M, ui M.

### I. Sounds page (settings-hosted for now)

**Added by Dan 2026-07-06.** A place to choose the *sound source*: **sine/wavetable drones** vs **granular**, and then patches within each. Lives as a section in the Settings menu for now; may get promoted later.

- **ui:** a "sound" section in SettingsPanel: source picker (waves / granular), then source-specific patch selection — the existing named Patches list for the wave engine, and the granular patch list (`GranularPatch` — the granular track is building patch persistence right now) for granular.
- **dsp:** depends on what "choosing granular" means — granular as *the* voice for drones/chords vs. running alongside. Needs a shared decision with the granular track: `GranularEngine` is currently fully independent of `AudioEngine` (own sheet, own transport). Scope this with the granular session before building — **coordination point, not a solo overhaul item.**

**Owner:** ui S-M once semantics are decided. **Depends on:** granular track's patch layer.

### B. Mixer

**Web ref:** `Mixer.jsx` (throughout; drag hit-testing `applyAtPoint` :55-96, bus strip :726-777, master fader :333). **iOS ref:** closest thing today is `mainModeBody` fader row in `ContentView.swift:249-330`.

Structure to port — a vertical stack of *horizontal* faders with a drag-anywhere hit-test model (a vertical finger sweep sets every crossed fader to the finger's X):
- **Drone rows** (`D1..Dn`): freq + note/cents readout, horizontal fader, mute ×.
- **Partial rows**: indented under a drone, ratio tag (×N/÷N), clone/octave/remove buttons.
- **Voice rows** (`K…`/`M…`): live keyboard/MIDI voices — fill shows live envelope amp, ball shows target; released voices linger until inaudible. (MIDI hidden this pass, but voice rows still appear once any live-voice source exists; harmless to include from day 1 since KeyboardVoiceManager already runs on iOS.)
- **Bus strip**: collapsible Drone/KBD/MIDI bus faders (0..2 range, unity at midpoint, double-tap reset, per-bus lr↔stereo toggle) + always-visible **Master fader whose track is the stacked L/R peak meters** with peak-hold.

**iOS engine gaps (dsp first):**
1. **Buses** — iOS has `groupVolume` + per-osc volumes but no drone/kbd/midi bus gains or bus mutes. Add `droneBusGain/kbdBusGain/midiBusGain` (+ mutes) applied in the render block, `@Published` + setters + patch fields.
2. **Master peak levels** — add L/R peak (with decay) computed in the render block, exposed via a polled getter (not `@Published` — it's per-frame data; follow the ring-buffer/polling pattern the scope already uses).
3. **Partials** — web's `addPartial/setPartialVolume/setPartialRatio/removePartialAt`. Nothing on iOS. Decide: port now (dsp M) or descope partial rows to a follow-up. *Recommend descope* — the mixer is fully usable without them and it keeps this phase shippable.
4. Per-voice level setting (`setVoiceLevel`) and per-frame voice amp readout from `KeyboardVoiceManager`.

**UI notes:** per-frame reads (voice amps, peaks) should poll on a display link / `TimelineView`, not via `@Published`. Reuse `Palette.oscColor`.

**Owner:** dsp M (buses+peaks+voice levels), ui L. **Depends on:** shell (A).

### C. Tunings menu

**Web ref:** `TuningPanel` in `FrequencyManager.jsx:697-876`, rows :218-489, systems in `jiRatios.js:241-314`. **iOS ref:** SettingsPanel already has system picker / 7-12 / anchor / load (:79-84, 613-682) backed by `Models/TuningSystems.swift`.

Port the panel proper:
- **Per-slot rows**: root radio, mute marker, editable cells (Hz / ratio / note / cents), rocker (root row = ÷2 ×2 octave; others = ‹ › step through nearest tuning-system candidates).
- **Topbar**: root readout + voice count −/+.
- **Footer**: system picker, 7/12 scale-size radio, **Load** button.
- **Below**: **Align** button + global transpose readout/reset/snap.

**iOS engine gaps:** `TuningSystems.swift` already has candidate generation / `nearestRatio` / `stepCandidate`, and the engine has `loadScale` + JI align. Missing: `setSlotRatio`-style setters that commit a ratio against the anchor, per-cell commit paths (Hz/ratio/note/cents → frequency), and **global transpose** (`getTransposeSemitones` etc. — likely absent on iOS; now scheduled earlier, with the spectrum-bar transpose swipe, since the main page wants it too). "Frozen inputs during drags/glides" maps to the existing `draggingFaders`/glide state.

**Owner:** dsp S-M (commit setters + transpose), ui M-L (editable-cell grid is fiddly on touch — design keyboard-entry UX deliberately). **Depends on:** shell (A). Independent of Mixer.

### D. Performance mode menu (PERFORM panel — parameter lock)

**Web ref:** `PerformPanel`/`ScopePanel` in `FrequencyManager.jsx:546-644, 882-888`; state in `FrequencyManager.js` singleton. See also `PARAMETER_LOCK.md` at web root.

What it is: chips toggling which parameters are *tracked* for recall (freq / vol / on-off / transpose), a transition mode picker (glide / step / step-all), and sliders for recall-glide ms, step-overlap ms, undo-glide ms. **On iOS it additionally hosts auto-mode's dwell-time setting/range** (per Dan) — the main page's auto toggle uses whatever transition mode + dwell is set here.

**iOS engine gap — the biggest of this pass.** The web `FrequencyManager` singleton (recall scope, staged save-slot launch state, step transitions with tails/travelers, undo/redo timing) has **no iOS counterpart**. The iOS patch system applies patches instantly/glide-only. Port plan:
1. dsp: a Swift `RecallEngine` (or extend AudioEngine): `recallScope: Set<TrackedParam>`, `transitionMode: .glide/.step/.stepAll`, timing knobs, and step-transition machinery (per-slot staggered glides; the full tails/travelers *visualization* data can come later with the pianoroll polish).
2. ui: the panel itself is simple — chips + segmented picker + 3 sliders (S once the engine exists).

Still sequenced after Mixer + Tunings (most engine-heavy), but note the coupling: **auto-mode (A2) upgrades from plain-glide to the full transition modes the moment D's dsp lands** — so if auto-mode's glide-only v1 feels too flat in practice, pull the transition-mode slice of the RecallEngine forward. Re-read `PARAMETER_LOCK.md` before starting.

**Owner:** dsp L, ui S. **Open question:** confirm this (vs the pretty/perf/off Quality toggle) is what "performance mode menu" means. If it's the Quality toggle instead, that's an S item in the visualizer settings.

### E. Pianoroll visualizer (web "Timeline", vizMode 4)

**Web ref:** `Oscilloscope.jsx:850-1191, 1638-1655` — scrolling waterfall, X = time (now pinned right), Y = log frequency; per-source polylines of `{t, f, amp}` sampled each frame from the *note/voice model* (drones + step tails + travelers + live voices), halo+core two-pass draw, auto-range Y with easing, left-edge fade, color cycle.

**iOS port:** new scope mode alongside lissajous/hilbert. Everything it needs is already on iOS: sounding frequencies, volumes, mute state, `KeyboardVoiceManager` active voices, palette. Render approaches:
- v1: `CADisplayLink` + CGContext (same pattern as `OscilloscopeUIView`) — the web version is canvas-2D, ports almost 1:1. Lane sampling is pure Swift.
- v2 (optional): move to the Metal path once the Hydra harness exists, so the timeline can feed `s0` too.

Controls (window seconds 2-120, auto/manual Y range) go wherever visualizer settings land in the new layout. Step tails/travelers rendering can degrade gracefully until D lands.

**Owner:** wavetuner-ui (or dsp for the sampler if we want it off the render thread — it's UI-thread-fine at 4-12 sources). **Size:** M. **Independent** — can run parallel with B/C.

### F. Hydra RGB visual as default (Metal)

**Web ref:** `builtin_chromatic` in `hydraSketches.js:8-25` (`DEFAULT_SKETCH_ID`), runtime in `visuals/backends/hydra.js`, composited via `HydraOverlay.jsx` (scope canvas hidden but still drawn; hydra reads it as `s0`). The sketch, in Hydra DSL:

```js
src(s0).color(1, 0, 0)
  .modulate(osc(9, 0.04, 1), 0.01)
  .add(src(s0).color(0, 1, 0).modulate(osc(10, 0.1, 1), 0.01))
  .add(src(s0).color(0, 0, 1).modulate(osc(11, -0.1, 1), 0.01))
  .add(src(o0).modulate(noise(4, 0.1), 0.01), 0.4)
.out(o0)
```

RGB-split of the live scope image (each channel modulated by a slightly-different slow `osc()`) plus a 0.4-weight feedback trail of last frame (`o0`) warped by `noise(4, 0.1)`. Note: **this sketch does not read `window.audio` features** — its audio-reactivity comes entirely from the scope image. So no AudioFeatures port is needed for the default mode.

**iOS port** (this is pass-1 item **7b**, already anticipated by `MetalOscilloscopeView.swift` — its header calls itself the foundation for exactly this):
1. **Pass A**: render the oscilloscope strokes into an offscreen `MTLTexture` (`s0`) instead of directly to screen.
2. **Pass B**: fullscreen quad; fragment shader = hand-translated MSL of the sketch above (Hydra's `osc()`/`noise()` are tiny well-known GLSL functions — get exact source via the web's `.glsl()` export trick per `ios-port-plan.md`). **Ping-pong `o0` textures** for the feedback term; rebuild both on resize/rotation.
3. Default mode = this shader; plain lissajous stays available in the mode picker. The CG renderer remains the Hilbert fallback until the Metal path covers it.
4. Prereq cleanup from pass-1 known limitations list: none are blockers for chromatic (glow/camera-underlay can come later); Hilbert stays CG-only for now.

**Owner:** hydra-metal-porter. **Size:** L. **Independent track** — start immediately, in parallel with A/B.

---

## Rollout order

Two parallel tracks. Within track 1, each phase ships + gets tested via `ios-port-status.md` checklists before the next starts.

Menu priority from Dan: 1) Mixer, 2) Save states, 3) Tuning, 4) Perform, 5) Patches. The listener main page comes before all of them — it's the product.

| Phase | Item | Owner(s) | Notes |
|---|---|---|---|
| **Track 1 — main page & panels** | | | |
| 1 | A. Shell: remove keyboard, hide MIDI, new scaffold | wavetuner-ui | Fully specified — start now |
| 2 | H-dsp. Chord slots model + factory chord set | wavetuner-dsp | Small, unblocks the main page |
| 3 | A2. Listener main page (transport, mute dots, auto-mode, revert, mic) | ui + dsp | The centerpiece; hydra default slots in when V1 lands |
| 4 | Transpose (dsp: global transpose engine) + spectrum-bar transpose swipe | dsp + ui | Also needed later by Tunings (C) |
| 5 | B. Mixer (dsp: buses/peaks/voice-levels → ui) | dsp + ui | Partials descoped to follow-up |
| 6 | H-ui. Save-states menu | wavetuner-ui | dsp half already landed in phase 2 |
| 7 | C. Tunings menu (dsp: commit setters → ui) | dsp + ui | Transpose already done in phase 4 |
| 8 | D. Perform panel (dsp: RecallEngine → ui) | dsp + ui | Confirm scope first (see Open Questions) |
| 9 | Patches menu restyle | wavetuner-ui | Panel already exists; style to match |
| 10 | I. Sounds page (settings section: waves vs granular + patches) | ui (+ granular track) | Semantics need a joint decision with the granular session first — can move earlier once decided |
| **Track 2 — visuals** (parallel) | | | |
| V1 | F. Hydra chromatic shader, two-pass MTKView harness | hydra-metal-porter | Higher urgency now — it's the main page's backdrop |
| V2 | E. Pianoroll/timeline mode | ui | CG v1; Metal `s0` integration after V1 |

Suggested first PRs (parallelizable today): Phase 1's mechanical half (keyboard removal + MIDI gating), Phase 2 (chord slots dsp), and V1 (hydra harness) — three agents, no file overlap.

---

## Resolved decisions (Dan, 2026-07-06)

1. **Perform menu** = the PERFORM parameter-lock panel: glide/step transition modes + which parameters get tracked. (Not the pretty/perf/off Quality toggle.) It **also hosts auto-mode's dwell-time range** — see D.
2. **Save states = chord slots** — Next-chord reads from the save-state list. Confirmed.
3. **Revert → the last save state** (the last-applied chord slot's snapshot).
4. **Auto-mode** = dwell on a chord for X seconds, then advance using the **web's generative transition machinery** (glide / step / step-all, per the Perform panel's transition mode). Dwell range is configured in the Perform menu.
5. **Hydra is always front-and-center** — the permanent visual field of the app; on iOS it's a static GLSL→MSL shader (no live coding).

## Open questions

1. **Mixer partials** — descope partial rows from mixer v1? (Recommended: yes.)
2. **Oscillator count** — still capped at 4 on iOS (web: 2-12). The mixer and tunings rows make the cap very visible. Expand alongside the mixer phase, or later?
3. **Global transpose** — verify whether any transpose exists on iOS engine-side (likely absent); needed by phase 4 (transpose swipe), not just Tunings.
4. **Auto-mode before Perform lands** — auto-mode's *transitions* come from the RecallEngine (D). v1 ships with plain glide; step/step-all switch on when D's dsp lands. Acceptable, or pull the transition-mode slice of D forward?

---

## Process

Same machinery as pass 1:
- This doc = the plan; `ios-port-status.md` = living status + per-feature manual test checklists ("🧪 Just landed").
- Each phase lands as dsp-then-ui agent tasks; build verified via XcodeGen (`xcodegen generate` in `ios/`, files auto-included by folder membership).
- Default-behavior rule stays: every phase must leave first-launch behavior unchanged until the user opts in (exception: hydra-as-default and keyboard removal, which are the point).

**⚠️ Parallel work — granular synth build.** The iOS granular feature (Audio/Granular/*, `GranularPanel.swift`, next up: keyboard-playable phase) is being developed in parallel with this overhaul. Coordination rules:
- **Shared touchpoint = `ContentView.swift`** (the granular sheet entry point lives in the tab bar). The Phase-1 shell rework must carry the Granular entry into the new layout — don't orphan it. Keep shell PRs small and land them quickly so granular work rebases cheaply.
- Overhaul agents must not touch `Audio/Granular/*` or `GranularPanel.swift`; granular agents shouldn't restructure `ContentView` — if both need it in the same window, sequence, don't merge-race.
- `GranularEngine` is self-contained (own `@StateObject`, independent of `AudioEngine`), so engine-side work (buses, chord slots, transpose, RecallEngine) is conflict-free.
