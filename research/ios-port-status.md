# WaveTuner iOS — Status & Test Checklist

Living doc tracking what's shipped vs upcoming on the iOS port. Last updated 2026-07-06.

See `ios-port-plan.md` (same dir) for the full rationale on the rollout order.

---

## 🧪 Just landed — please test

### 12. Listener main page + panel menu system (UI overhaul phases 3–8, 2026-07-06)

The new app face (`ContentView.swift` rebuilt): full-bleed visual field, pinned spectrum bar, mute dots, transport, and all panels broken out of Settings into a menu row. Granular merged in as a menu entry. All landed in commits `3ec3af6..8f908f9`.

**Main page**
- [ ] Tap-to-start splash unchanged; after start: visual field fills the screen, bottom stack = spectrum bar → mute dots → transport → menu row
- [ ] Mute dots: one large palette dot per drone; tap = mute (hollow) / unmute (filled)
- [ ] Transport: ⏸ stops the engine (back to splash), ⏭ glides to the next factory chord, timer = auto-mode toggle (highlights), mic (disabled without headphones), ↩ Revert glides back to the last-applied chord (disabled until one applies)
- [ ] Menu row opens: mixer · chords · tuning · perform · patches · grains · ⚙
- [ ] Camera toggle now lives in Settings → ui; when on, flip/lens buttons sit at the visual field's top corners
- [ ] Grains: menu entry opens the granular panel; engine keeps sounding with the sheet closed; dots still drive notes (GRANULAR-PORT.md checklist still applies)

**Transpose swipe (headline interaction)**
- [ ] Horizontal drag on the bar background (not an orb): tick ruler slides under stationary orbs, "+N st" capsule appears; orb drags completely unaffected
- [ ] Double-tap background: transpose glides back to 0
- [ ] Tuning panel: transpose readout row with snap (whole st) + reset
- [ ] Save-state applies (Next chord) do NOT reset the live transpose (web parity)

**Mixer panel** (web Mixer.jsx port)
- [ ] Drone rows: sounding Hz (moves with transpose), fader, mute ×; vertical finger sweep across faders sets each to the finger's X (drag-anywhere)
- [ ] Bus strip (collapsible): drone/kbd/midi 0–2× faders, unity detent at center, double-tap resets to 1×, per-bus mute
- [ ] Master: fader track is live L/R peak meters with peak-hold ticks (green/amber/red)
- [ ] Voice rows appear while any live voice sounds (kbd/midi plumbing still hidden, harmless)

**Tunings panel** (web TuningPanel port)
- [ ] Per-slot rows: root radio, mute marker, Hz/ratio/note/cents cells → tap opens compact editor sheet, commit on return; invalid input reads red
- [ ] Root row: ÷2 ×2 transposes all proportionally; other rows: ‹ › steps to nearest system candidate
- [ ] Footer: system picker + 7/12 + Load (resizes voices, loads scale from anchor); JI section (var/glide/random/align/snap/undo) below
- Note: "align" is still 5-limit JI, not the active system (needs `computeJustIntonationTargets(systemKey:)` — flagged follow-up)

**Save states menu**
- [ ] Capture (named), tap-to-recall with playhead indicator, rename/overwrite via context menu, swipe delete, EditButton reorder, restore-factory footer (confirmed, user slots untouched)

**Perform panel (RecallEngine v1)**
- [ ] "parameters tracked" chips freq/vol/on-off/transpose (default: freq only) — only tracked params change on recall/undo/revert
- [ ] Transition: glide / step (staggered starts) / step-all (staggered + every voice re-attacks)
- [ ] Timing sliders: recall / step / undo; 0 reads "snap"; auto-mode dwell lives at the bottom
- [ ] Empty scope: recall inert, but Revert still fixes freq+vol+onoff (guard)
- [ ] Notes coming ON attack at transition start; notes going OFF hold and release at the end; a new recall mid-transition supersedes cleanly

**Patches panel** — restyled cards (palette dots, relative dates); behavior unchanged: [ ] save/load/rename/delete still work

### 11. Hydra chromatic shader (off by default — flip on to evaluate)

The web's default `builtin_chromatic` Hydra sketch, hand-ported to a two-pass Metal pipeline (scope strokes → offscreen `s0` texture → RGB-split fragment shader with ping-pong feedback). Becomes the app default with the new main page; for now it's opt-in.

- [ ] Settings → oscilloscope → renderer → **metal** (chromatic only renders on the Metal path)
- [ ] A "visual style" pill row (plain / chromatic) appears under the renderer row once metal is selected — tap **chromatic**
- [ ] Toggle survives force-quit (persisted to UserDefaults key `visualStyle`); renderer choice now persists too
- [ ] **Round 2 (parity + stroke width):** RGB fringing is clearly visible (green/blue edges + red slivers, hue drifts over time), strokes leave a persistent multi-ghost trail, and the trail wobbles frame-to-frame (noise warp) — verified against the compiled web GLSL (`research/hydra-chromatic-compiled.frag.glsl`)
- [ ] Settings → oscilloscope → **stroke width** slider (0.5–8×): thickens strokes on BOTH renderers; on metal+chromatic, thicker strokes bolden the whole visual
- [ ] Metal "plain" style now matches the CG neon look (5-layer glow stack, real ribbon thickness instead of 1-px lines)
- [ ] Scope shows the web look: RGB-split lissajous with slowly drifting chromatic aberration + a noise-warped feedback trail
- [ ] Compare side-by-side with the web app's default visual — should read as the same instrument
- [ ] Rotate the device — no stale feedback smears (textures rebuild, trail restarts from black)
- [ ] Flip back to `plain` — old Metal lissajous unchanged; flip Renderer back to CG — untouched
- Known inherited limits: 1-px lines, Hilbert blank on Metal, `.both` degrades to analysis (same as item 8)

### 10. Save states (chord slots) — engine only, no UI yet

Ordered lightweight chord snapshots (frequencies/volumes/mutes), distinct from named Patches. Backs the upcoming main page's Next-chord / auto-mode / Revert. Nothing visible yet — API surface only; first launch behavior unchanged.

- Factory set seeds on first touch: Home → Major triad → Subdominant → Sus9 → Maj7 → Open fifth (5-limit JI over 101.25 Hz), persisted to `Application Support/WaveTuner/savestates.json` (`wavetuner.savestates.v1`)
- Engine API: `advanceToNextSaveState()`, `applySaveState(_:glide:)`, `revertToLastSaveState()` (non-consuming "fix it"), `undoSaveStateApply()`, `captureSaveState(name:)`, auto-mode (`setAutoModeEnabled`, `setAutoDwellSeconds` 5-300s, default 30, never persists as on)
- [ ] Smoke test from debugger if desired: call `advanceToNextSaveState()` a few times → frequencies glide (~2s) through the factory progression

### 9. On-screen keyboard removed + MIDI settings hidden (UI overhaul pass 2, phase 1)

Per `ios-ui-overhaul-plan.md`: the piano-keys chip and keyboard tray are gone; "midi & keyboard (testing)" and "mpe output" settings sections are gated behind `showMidiSettings = false` in SettingsPanel.swift (all code intact, one flag re-enables).

- [ ] No piano-keys button on the scope zone; no keyboard tray anywhere
- [ ] Settings shows no MIDI/MPE sections
- [ ] Everything else unchanged: granular sheet, camera buttons, faders, generative mode
- ⚠️ Known: the **drones count stepper** lived inside the gated MIDI section and is hidden with it — gets re-homed in the main-page scaffold pass

### 8. Metal oscilloscope renderer (experimental, off by default)

A Metal-based renderer now lives alongside the CGContext one. **CGContext stays the default** — flip to Metal in Settings to evaluate.

- [ ] Settings → oscilloscope section → "Renderer" picker shows `CG` (default) and `Metal` (experimental)
- [ ] Default stays CG — visualizer behavior is 100% identical to before
- [ ] Flip to Metal — the lissajous still draws, but with these v1 limitations:
  - **Hilbert mode**: not supported on Metal — falls back to a clear canvas with a single log. Switch back to CG for Hilbert
  - **"both" source**: degrades to analysis-only on Metal
  - **No fade-trail / camera underlay** on Metal yet — the next Hydra shader round adds the offscreen-texture substrate that enables both
  - **Line thickness**: iOS clamps Metal `setLineWidth` to 1px regardless of value, so glow looks subtler than CG. Real bloom needs ribbon geometry — flagged for round 19
- [ ] Move FPS / color cycle / glow pass settings → both renderers respect them

If Metal looks broken or wrong, just flip back to CG. Nothing in the audio path is touched.

### 7. Voice manager + CoreMIDI + on-screen keyboard 🎹

The app is now **playable as an instrument**. Voices ride additively on top of always-on drones using the same wave/fold/stereo path.

**On-screen keyboard:**

- [ ] Tap the **piano-keys icon** (top-right of the oscilloscope zone) — keyboard tray slides up at the bottom (~120pt)
- [ ] Press a white key → drone-pool note plays at that slot's frequency. Multiple fingers = multiple voices simultaneously
- [ ] Hold-mode toggle in tray: ON = taps latch (tap again to release); OFF = press-and-hold
- [ ] **Key mode** picker: `chromatic` (all 12 keys → 12 slots; only 4 active today so wraps) vs `whiteOnly` (7 white keys → up to 7 slots; black keys dim)
- [ ] **Fill mode** picker: `fill` (cycle through slots beyond count) vs `jump` (notes beyond count are silent and dimmed)
- [ ] **Release all** button — drops every held key
- [ ] Voices use `Envelope.keyboard` (default A=0.1 D=1.0 S=0.4 R=0.3) — drag the ADSR sliders in Settings → Sound Design and play the keyboard to hear them shape the note

**External MIDI:**

- [ ] Plug in a USB MIDI controller (via Lightning/USB-C adapter) OR pair a Bluetooth-LE-MIDI device — should appear in Settings → MIDI & Keyboard → "Connected devices"
- [ ] Play a note on the controller → same drone-pool routing applies (note 60 = C4 → slot 0 at octave 0, etc)
- [ ] CC 64 (sustain pedal) defers note-off releases until pedal lifts
- [ ] Settings → MIDI & Keyboard → toggle "MIDI input enabled" off → external notes ignored

**Settings to play with** (Settings → MIDI & Keyboard testing section):

- [ ] **Velocity curve**: linear / soft / hard / fixed (only affects velocity-sensitive sources)
- [ ] **Voice caps**: MIDI 1..32, kbd 1..16 (cap reached = oldest goes into release, no clip)
- [ ] **Hold modes** (3 toggles, one per source). On-screen hold is the same as the tray toggle
- [ ] **Re-press behavior** (only when computer-kbd hold is on): toggle vs restart

**What's deliberately not in v1 (sweep candidates):**
- No realistic notched white keys — simple stacked rectangles
- No velocity from touch pressure — fixed 0.8
- No drag-glissando (sliding from one key to another)
- No note labels on keys
- No envelope-driven key glow animation
- No off-screen voice indicators for MIDI notes outside C3..C5

### 4. Oscilloscope default flipped to analysis

The scope now defaults to **analysis** (real audio capture from the ring buffer) instead of **synthesis** (mathematical regeneration that doesn't know about wave/fold/stereo yet). You can still toggle in Settings → "scope source" — Analysis / Synthesis / Both.

- [ ] On a fresh launch, the scope shows whatever's actually playing (not a regenerated sine)
- [ ] Drag wave shape to "square" — the visualizer now reflects the harmonics
- [ ] Drag fold up — visualizer shows the distortion shape
- [ ] Settings → scope source → toggle Synthesis. Now shape and fold are no longer visible (synthesis still emits sine for now). Toggle back to Analysis for the live view.

### 5. Patches sheet

Settings → "patches" section → "open" button → modal sheet with save / list / load / rename / delete.

- [ ] Tap "Save current…" → name it → save → row appears
- [ ] Twist some knobs, save again with a different name → two patches in the list
- [ ] Tap a row → drones glide (or jump) to that patch's state, sheet dismisses
- [ ] Swipe-left on a row → delete (no confirm dialog yet — flagged for sweep)
- [ ] Long-press a row → "Rename" via context menu
- [ ] Empty state (after deleting all): shows a hint message

UX notes for the styling sweep (deliberately not addressed yet):
- Default `List` style is utilitarian; doesn't match the rest of the dark/minimal aesthetic
- No "currently applied" indicator
- No delete confirmation
- Entry point is buried in Settings — could promote to its own icon on the main view later

### 6. Tuning model (foundation only — no UI yet)

`Tuning.shared` singleton lives in `Models/Tuning.swift`, exposing `keyMode` (chromatic / whiteOnly) and `fillMode` (fill / jump). `degreeAndOctaveForMidi(midi:oscillatorCount:)` returns the drone slot index + octave offset for any incoming MIDI note, or nil for silence.

Nothing to test in the UI — there is no UI yet. This is plumbing for the upcoming Voice Manager + on-screen keyboard agents. The settings are persisted to UserDefaults; a debug-build self-test runs at app launch and traps if the math ever breaks.

### 3. Sound design — wave shape, wavefold, ADSR, stereo

What changed: four new audio features wired through the engine. **Default behavior at first launch is bit-identical to before** — nothing changes audibly until you touch a knob. UI lives in Settings → **Sound Design (testing)** (bottom of the panel). Layout is rough on purpose — styling sweep later.

**Wave shape morph:**

- [ ] Settings → Sound Design → drag the **Wave** slider from 0 to 3
- [ ] At 0: pure sine (as before). At 1: triangle. At 2: sawtooth. At 3: square
- [ ] Intermediate values blend smoothly (e.g. 0.5 = halfway sine→tri)
- [ ] Anchor labels `sine / tri / saw / sq` appear under the slider

**Wavefold:**

- [ ] Drag **Fold** slider from 0 to 1
- [ ] At 0: bypass (no audible change vs prior step)
- [ ] At higher values: progressive west-coast folding distortion. More dramatic on square/saw shapes than on sine
- [ ] **Known limitation**: high fold amount aliases at high fundamentals (no oversample on v1). Acceptable, ship-blocker for later

**ADSR (drone envelope) — testing path uses mute toggle:**

- [ ] Drag **Attack** to ~3 seconds, **Release** to ~3 seconds
- [ ] On the main view, toggle a drone's **mute** ON — it fades out over the release time (vs the instant cut from before)
- [ ] Toggle mute OFF — it ramps in over the attack time
- [ ] Drag **Decay** + **Sustain** — confirm a decay ramp from peak down to sustain level after attack completes
- [ ] Switch envelope mode to **AR** — Decay & Sustain rows collapse (no-op in AR mode)

**Stereo:**

- [ ] Default mode is **LR** — should sound exactly like before (oscs 0+2 → L, 1+3 → R)
- [ ] Switch to **Stereo** mode + tap **Randomize curve** — should hear chorusing/widening as the 4 curve weights drive per-osc detune
- [ ] Drag **Detune Hz** from 0 to 10 — wider chorus as it increases
- [ ] Drag individual curve mini-sliders (one per osc, color-tinted by palette) to set per-osc detune weights manually

**Autosave coverage:** all four feature settings round-trip through autosave. Twist everything, force-quit, reopen → settings restored.

### 1. Duo color palette

What changed: the iOS app now has the same theme system as the web (`duo` default, `classic` toggle). Old fixed 4-color palette is gone.

**Manual test steps:**

- [ ] App opens with the **duo** theme by default
  - Index 0 fader: blue (`#4a9eff`)
  - Index 2 fader: orange (`#ff8c1a`)
  - Indices 1 and 3: soft white (`#e8edf5`)
- [ ] All UI elements pick up the new colors: faders, mute buttons, indicator dots on the spectrum bar, frequency labels
- [ ] Open Settings → **UI** section → find the **Theme** picker (segmented control, Duo / Classic)
- [ ] Tap "Classic" — animates over ~200ms to red/green/blue/yellow (the old palette as the first 4 of the 12-color rainbow)
- [ ] Tap "Duo" again — animates back
- [ ] Force-quit the app (swipe away in app switcher), reopen — theme selection persisted
- [ ] No visible regressions in OscilloscopeView, FrequencySpectrumBar, or any settings UI

**Known small thing**: the Theme picker uses `.segmented` style while the surrounding settings rows use a custom pill-toggle style. If it reads as out-of-place, mention it and we'll style-match.

### 2. Patch persistence (autosave only — no save/load UI yet)

What changed: the engine now snapshots state to disk 1 second after every change. On launch, the last snapshot is restored automatically. No visible buttons — this is invisible behavior.

**Manual test steps:**

- [ ] Open the app, adjust frequencies and volumes for several oscillators
- [ ] Toggle a mute or group
- [ ] Wait ~2 seconds (debounce window)
- [ ] Force-quit (swipe away in app switcher)
- [ ] Reopen — frequencies, volumes, mute state, group state should all be restored to where you left off
- [ ] (Optional) Inspect the file via Xcode → Window → Devices and Simulators → select your device → WaveTuner → "Download Container…" — open the downloaded `.xcappdata` and look in `AppData/Library/Application Support/WaveTuner/autosave.json`. Should be a tidy JSON with `schema: "wavetuner.patch.v1"`.

**What's intentionally NOT in the autosave**: scope FPS / glow / color-cycle settings, mic passthrough EQ, alignment/portamento knobs. Those are UI/transient state, not "the patch I want to recall." See `Patch.swift` snapshot fields for the exact list.

**What's NOT yet implemented but the schema is ready for**: `wave`, `fold`, `envelope`, `stereo` — placeholder fields exist, future agents will fill them.

---

## ⏭️ Up next (suggested order)

> **2026-07-06 — UI overhaul pass 2 kicked off.** The engine-feature rollout below is essentially complete; the next body of work (main-page redesign, mixer, tunings menu, perform panel, pianoroll/timeline, hydra chromatic shader as default, keyboard removal) is planned in **`ios-ui-overhaul-plan.md`** (same dir). Items 7b and 8 below are absorbed into that plan.

The rollout order from `ios-port-plan.md`. I'll work through these one or two at a time.

| #  | Feature                                | Status      | Owner agent          |
|----|----------------------------------------|-------------|----------------------|
| 1  | Duo color palette                      | ✅ Done      | wavetuner-ui         |
| 2a | Patch persistence — data layer         | ✅ Done      | wavetuner-dsp        |
| 2b | Patch picker UI (save / load / rename) | ✅ Done      | wavetuner-ui         |
| 3a | ADSR — engine                          | ✅ Done      | wavetuner-dsp        |
| 3b | ADSR — UI (in Settings, testing-quality) | ✅ Done    | wavetuner-ui         |
| 4a | Wave shape morph — engine              | ✅ Done      | wavetuner-dsp        |
| 4b | Wave + Fold — UI (in Settings)         | ✅ Done      | wavetuner-ui         |
| 4c | Wavefold — engine                      | ✅ Done      | wavetuner-dsp        |
| 5a | Stereo / detune — engine               | ✅ Done      | wavetuner-dsp        |
| 5b | Stereo — UI (in Settings)              | ✅ Done      | wavetuner-ui         |
| 6a | Tuning model (degree↔MIDI mapping)     | ✅ Done      | wavetuner-dsp        |
| 6b | Voice manager + CoreMIDI input         | ✅ Done      | wavetuner-dsp        |
| 6c | On-screen keyboard view                | ✅ Done      | wavetuner-ui         |
| 7a | MTKView migration of OscilloscopeView  | ✅ Done      | hydra-metal-porter   |
| 7b | First Hydra-style MSL shader preset    | ⏭️ Next up  | hydra-metal-porter   |
| 8  | Styling sweep (move Sound Design controls out of Settings into proper UI) | ⬜ Queued | wavetuner-ui |

Open decisions to make as we go:
- Expand iOS's hardcoded 4-osc cap? Several upcoming features get richer at higher N
- iPad-first vs iPhone-first focus for the Keyboard work
- Pre-compiled `.metallib` vs runtime-compiled MSL for shaders (probably pre-compiled for v1)

---

## ✅ Done (history)

- **2026-05-22** — Initial port plan + 3 specialized agents created (`hydra-metal-porter`, `wavetuner-ui`, `wavetuner-dsp`) at `.claude/agents/`. Available next session via `/agents`.
- **2026-05-22** — Track A (duo palette) + Track B (patch persistence data layer) merged in parallel. Build verified.

---

## How to use this doc

- **Before testing:** open this file, find the "🧪 Just landed" section, run through the checkboxes on a build
- **Anything off?** Tell Claude — include which checkbox, what you saw, what you expected. The relevant agent will own the fix
- **Want a different order?** The "Up next" table is a suggestion, not a contract. Reshuffle anytime
