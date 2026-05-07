# Keyboard / JI Polyphonic Instrument — Plan

A second instrument layered onto the existing Wavetuner engine. The
existing app stays exactly as it is (the **drone**); a new **keyboard**
pool plays the drone's tuning polyphonically over multiple octaves via
MIDI or the computer keyboard. Both run concurrently — the keyboard is
exposed via a slim **tray** that rolls up from the bottom of the screen,
not a view-mode switch.

---

## 1. Mental model

One tuning, two ways to play it. The drone defines a list of pitches;
those pitches, sorted ascending, become the **scale** of the keyboard.
Octaves above and below are derived by ×2 / ÷2 of the whole scale.

- **Drone (existing):** up to 8/10 sustained sines, each with explicit
  freq, volume, and L/R routing. Output is continuous.
- **Keyboard (new):** the same set of frequencies, interpreted as a
  scale. A MIDI note (or letter key) maps to (scale degree, octave).
  Notes are triggered with attack/decay envelopes, polyphonic, panned
  per the drone's L/R routing.

The bridge is the **tuning** itself — a live, sorted view of the drone's
frequencies that updates whenever any drone freq changes (so dragging an
orb past another reorders the keyboard live; held notes follow). Per-note
pan also comes from the drone (its L/R routing for that slot). Envelope
and key-mapping settings are keyboard-only.

A user workflow:
1. Build a chord/scale in the drone (existing flow — orb dragging, JI
   snap, etc.).
2. Roll up the keyboard tray at the bottom of the screen.
3. Play with a MIDI keyboard, on-screen keys, or the computer keyboard
   (Ableton-style letter layout). The drone keeps playing underneath.

Drone and keyboard pools are always concurrent in v1 — there's no
view-mode switch. Collapsing the tray hides the on-screen keys but does
not stop the keyboard pool (computer/MIDI input still works if the
toggle is on).

---

## 2. What sits where (architecture)

The current `AudioEngine` is a **fixed-pool** oscillator manager: N
permanent oscillators, all running, gain-gated for mute. That model
conflicts with polyphonic note-on/note-off, where oscillators are spawned
and stopped on demand.

Recommended split:

```
AudioEngine                         (existing — drone state, master bus)
  ├─ DroneVoices (existing)         existing oscillators[], gainNodes[]
  └─ KeyboardVoiceManager (new)     transient voices, ADSR-gated
        ├─ pool of ≤32 voices       each = OscillatorNode + GainNode (env)
        ├─ subscribes to Tuning     held notes track tuning changes live
        ├─ noteOn / noteOff API
        └─ pan = drone routing (v1)

Tuning (new shared module)
  ├─ sortedFrequencies: number[]    drone freqs sorted ascending (mute ignored)
  ├─ pitchForMidiNote(midi):number  sortedFreqs[degree] × 2^octave
  └─ change events                  fired when any drone freq moves
```

**Why a separate voice manager and not extending DroneVoices?**

- Drone voices are *always on*; keyboard voices are *triggered*. Reusing
  the same pool means converting permanent osc → triggered osc on view
  switch, which loses Web Audio's nice property that a stopped node is
  GC'd. Cleaner to have two pools that share the master bus.
- Channel routing in the existing engine is per-osc-index. Keyboard voices
  need per-voice pan (one StereoPannerNode per voice).
- The drone engine has steady-state assumptions baked into
  `calibratePhases` / phase tracking — those would break if oscillators
  could appear and disappear at the same indices.

The two pools share `masterGainNode` (so master volume affects both
equally) and the same analyzer/visualizer chain, so the oscilloscope picks
up both audio sources without changes. Since drone+keyboard play
concurrently, `calibratePhases`'s LSQ fit will see keyboard voices as
residual noise on top of the drone signal — the existing confidence-based
fallback to the phase accumulator handles this gracefully (drone phase
tracking gets noisier when keyboard is loud, but doesn't break). No
structural change needed today.

---

## 3. Tuning representation

```js
// shared module: src/audio/Tuning.js
class Tuning {
  // Source of truth: the drone's frequency list, sorted ascending.
  // Mute is IGNORED — muted drone slots still appear in the scale. To
  // remove a slot from the keyboard, reduce drone count instead.
  // No octave folding, no dedup. Two drones at the same freq → two
  // identical scale degrees. Drones spanning multiple octaves keep their
  // literal ordering (so a high "interloper" freq inside an octave will
  // be higher than the next octave's low notes — non-monotonic across
  // octaves, by design).
  sortedFrequencies = []

  // MIDI mapping: pick a "root" MIDI note (e.g. 60). For a key offset
  // k = midi - rootMidi:
  //   degree = ((k % N) + N) % N
  //   octave = Math.floor(k / N)         where N = sortedFrequencies.length
  //   freq   = sortedFrequencies[degree] * 2^octave
  pitchForMidiNote(midi)

  // Listeners — keyboard voice manager subscribes so held notes
  // re-tune when drone freqs change.
  onChange(callback)
}
```

**Live re-sort.** Whenever a drone frequency changes (slider drag, JI
snap, glide, etc.), `sortedFrequencies` is recomputed. The drone's "slot
0" is *not* sticky to "scale degree 0" — if the user drags slot 5 below
slot 3, the keyboard order changes accordingly. This is the user-chosen
behavior; it can feel busy during drags, but it's predictable and matches
the "drone is the scale, sorted" mental model.

**Held notes follow the re-sort by degree, not by drone slot.** A held
voice on (degree=1, octave=0) plays whatever the *current* second-lowest
drone freq is. If reordering pushes a different drone slot into the
second position, the held note retunes to the new freq. Implementation:
voice manager subscribes to `Tuning.onChange` and recomputes each voice's
target freq via `oscillator.frequency.setTargetAtTime(newFreq, t, 0.016)`
— same tau as the drone's `setFrequency`, so the glide feels consistent
with what dragging an orb already does.

**Voice's degree no longer exists** (e.g., user reduced drone count below
the voice's degree+1): keep the voice's last-computed freq until release.
Simplest behavior, no special-case audio glitches.

**Beating preserved.** Two drones at 100/102 Hz become scale degrees 0
and 1 at literal 100/102 Hz, with 2 Hz beating when both are held. At
octave-up they're 200/204 (4 Hz beat); at octave-down 50/51 (1 Hz). The
beating relationship scales with octave, which is the right musical
behavior — you hear the same "fattness" at every register, just at the
appropriate beat frequency.

**Octave duplicates.** A drone of `100, 200` produces literal scale
degrees 100 and 200. Octave up: 200, 400. So the second key of octave 0
and the first key of octave 1 both play 200 Hz. That's allowed — pressing
either key sounds the same note. User's choice.

---

## 4. Voice manager (note-on / note-off)

```js
// src/audio/KeyboardVoiceManager.js
class KeyboardVoiceManager {
  constructor(audioContext, masterBus, tuning) {
    tuning.onChange(() => this._retuneAllVoices());
  }

  // Triggers a new voice. Voice is identified internally by (degree, octave).
  noteOn(midiNote /*0..127*/, velocity /*0..1, ignored in v1*/)
  noteOff(midiNote)

  setSustainPedal(down /*bool*/)   // CC 64

  // Envelope params (shared across voices)
  setAttack(seconds)
  setDecay(seconds)
  setSustain(0..1)
  setRelease(seconds)
}
```

**Per-voice graph:**

```
  OscillatorNode → GainNode (envelope) → StereoPannerNode → masterBus
```

- `OscillatorNode` is created and `.start()`-ed at note-on, `.stop()`-ed
  after release tail completes. GC'd automatically.
- `GainNode` does the ADSR via `setTargetAtTime` / `linearRampToValueAtTime`
  at known times.
- `StereoPannerNode` holds the per-voice pan. Set once at note-on from the
  drone's routing for the voice's scale degree (see §5). Static for the
  voice's lifetime in v1.

**Voice identity.** Each voice stores `(degree, octave, midiNote, panner,
gainNode, oscNode)`. The `(degree, octave)` is the lookup key for retuning
on tuning changes. `midiNote` is what `noteOff` keys on (so we can find a
held voice by the MIDI key that triggered it).

**Voice stealing.** Hard cap at 32. If exceeded, steal the oldest
*released* voice (one already in its release tail). If all 32 are still
held, steal the oldest held voice with a fast fade-out (~10 ms) to avoid
clicks.

**Velocity (v1).** Ignored. All notes play at full ADSR-peak amplitude.
Velocity-driven curves come later.

**Sustain pedal (CC 64).** When down, `noteOff` is deferred — voice goes
into a "would-release-but-pedal-held" state. When pedal lifts, all such
voices get their pending release. Standard MIDI behavior.

**Why separate gain + panner instead of one gain-and-pan?** Web Audio's
`StereoPannerNode` does equal-power pan correctly with a single param;
doing it manually with two gain nodes is more code for the same result.

---

## 5. Panning (v1: follow drone routing)

Per-voice pan is derived from the drone's L/R routing for that scale
degree:

- Drone slot routed only to L (channel 0) → pan = −1
- Drone slot routed only to R (channel 1) → pan = +1
- Drone slot routed to both → pan = 0
- Drone slot routed to neither (silenced from drone) → pan = 0

Pan is captured at note-on. Held voices don't repan if the drone's
routing changes mid-note (avoids retroactive surprises and one less
subscription to wire up).

**Future modes** (deferred): round-robin (alternating L/R per note-on) and
random (uniform pan in [−1, 1] per note-on). Both fit on the same
`StereoPannerNode` plumbing — the only thing to add is a pan-source
selector.

---

## 6. UI shape

The drone UI stays exactly as it is today. The keyboard is exposed via a
**slim tray** (max ~50 px tall) that rolls up from the bottom of the
screen. Expanding the tray pushes the drone UI up by the tray's height —
minimal disruption.

When collapsed, only a thin tab is visible at the bottom-right corner.

### Tray layout (left → right)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ◀ oct 4 ▶ │┌─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┐│ ⌨ ON │ ▼ │
│            ││ │█│ │█│ │ │█│ │█│ │█│ │ │█│ ││      │   │
│  ⌨ labels  ││●│○│●│●│○│●│●│●│○│●│●│○│●│●│●││      │   │
│            │└─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┘│      │   │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Octave block** (left, top): `◀ oct 4 ▶`. Click arrows or use Z/X on
  the computer keyboard.
- **Labels toggle** (left, below octave): when on, overlays Ableton-style
  letter labels on each key (A, W, S, E, D, F, T, G, Y, H, U, J, K, O, L,
  P) and adds Z/X markers next to the octave arrows: `◀Z oct 4 X▶`. When
  off, keys show note names + color dots only. Purely a visual aid;
  independent from whether the computer keyboard actually triggers
  notes.
- **Keys** (center): on-screen keyboard, ~14 keys at this height. Each
  key shows a small **color dot** matching the drone palette for the
  scale degree it currently maps to (live-updated as orbs reorder).
  Active keys glow; brightness follows the voice's ADSR amplitude. Keys
  outside the current scale (in `jump` modes) show no dot.
- **Computer-kbd input toggle** (right): `⌨ ON / OFF`. Controls whether
  letter keystrokes trigger notes. Independent of the labels toggle.
- **Close button** (right): `▼` collapses the tray.

### Settings panel — new "Keyboard" section

The slim tray can't fit the full set of keyboard controls. Anything not
needed during play lives in the existing settings panel under a new
section:

```
  ┌─ Keyboard ─────────────────────────┐
  │  Envelope                          │
  │    Attack    [────●─────]   30 ms  │
  │    Decay     [──────●───]  200 ms  │
  │    Sustain   [───────●──]   0.7    │
  │    Release   [────●─────]  300 ms  │
  │                                    │
  │  Key mapping                       │
  │    Keys     ( ) White  (●) Chrom   │
  │    Fill     (●) Fill   ( ) Jump    │
  │                                    │
  │  MIDI input                        │
  │    Device   [ none           ▾ ]   │
  └────────────────────────────────────┘
```

### Key-mapping semantics

The keyboard always thinks in MIDI notes — letters and on-screen taps
translate to MIDI first. With scale length N, a MIDI key offset k from
the keyboard root:

- `chromatic + fill`: every k fires; degree = `((k % N) + N) % N`,
  octave = `floor(k / N)`. Sequence: …deg0, deg1, …, degN−1, deg0,
  deg1… across consecutive semitone keys.
- `chromatic + jump`: only `0 ≤ k%12 < N` fires; degree = `k % 12`,
  octave = `floor(k/12)`. The next octave restarts at k%12 == 0.
- `white-only + fill`: only white-key MIDI notes (`0,2,4,5,7,9,11` within
  an octave) fire. Compute the white-key index `w = whiteKeyOrdinal(k)`;
  degree = `((w % N) + N) % N`, octave = `floor(w / N)`.
- `white-only + jump`: only the first N white keys per octave fire.

### Computer keyboard (Ableton-style)

```
  Letters → MIDI offset (semitones from root)
    A  S  D  F  G  H  J  K  L          → 0, 2, 4, 5, 7, 9, 11, 12, 14
    W  E     T  Y  U     O  P          → 1, 3,    6, 8, 10,   13, 15

  Z = octave down (root −= 12)
  X = octave up   (root += 12)
```

Letters fire MIDI note-on / note-off on keydown / keyup (with
`event.repeat` filtering to skip OS key-repeat retriggers). The
`white-only` mapping silences the W/E/T/Y/U/O/P row automatically (those
are black-key MIDI notes, which a white-only mapping skips).

**Bail-out rules:**
- Skip if `e.target` is `INPUT`, `TEXTAREA`, or `isContentEditable`.
- Skip if the `⌨ ON/OFF` toggle is off.
- Computer kbd is active even when the tray is collapsed (the toggle
  governs it, not the tray's visibility).

**F-key fullscreen shortcut: removed.** The current `App.jsx` keydown
handler that toggles fullscreen on `f`/`F` is deleted entirely.
Fullscreen still works via the on-screen button. The `f` letter is now
free for keyboard play.

---

## 7. MIDI input

```js
// src/audio/MidiInput.js
class MidiInput {
  async connect()                  // navigator.requestMIDIAccess
  setActiveInput(deviceId)
  // events forwarded:
  //   onNoteOn(midi, velocity)
  //   onNoteOff(midi)
  //   onCC(controller, value)     // CC 64 → setSustainPedal in v1
  //   onPitchBend(value)          // future
}
```

Web MIDI API requires a permission prompt and is gated on user gesture.
Browser support: Chrome/Edge fine; Safari requires the experimental flag
or polyfill. On-screen keyboard + computer keyboard always work, so MIDI
gracefully degrades to "not available."

**v1 messages:** note-on, note-off, CC 64 (sustain pedal). Pitch-bend and
other CCs deferred.

---

## 8. Visualizer in keyboard mode

Keyboard voices flow through the master bus → analyzers → existing
oscilloscope code. **No new visualizer mode required for v1.** Whatever
mode is selected (XY, line, face, hilbert, static) renders the live audio
as it would for the drone.

When pan modes (round-robin, random) land later, a synthesized
keyboard-aware XY scope (assigning voices to X/Y axes by pan, like the
brief originally described) becomes worth doing. For v1, the pan derives
from drone routing — the existing analyzer-fed scope already represents
that correctly.

---

## 9. Phased rollout

### Phase 1 — Plumbing (no UI yet)
- `Tuning` module with `sortedFrequencies`, `pitchForMidiNote`,
  `onChange` events. Hooks into `audioEngine.setFrequency` /
  `setAllFrequenciesBatch` so drone changes propagate.
- `KeyboardVoiceManager` with `noteOn`/`noteOff`/`setSustainPedal`, ADSR
  via gain, panner per voice, tuning subscription.
- Wire to `audioEngine.masterGainNode` so keyboard audio joins the
  analyzer chain.
- Console-test: trigger from the dev console, confirm sound and that
  scope reacts.

### Phase 2 — Tray + on-screen keyboard
- `KeyboardTray` component: collapsed tab + expanded ~50 px strip.
  Roll-up animation; pushes drone UI up by tray height.
- Slim layout: octave block (left), keys (center), kbd-input + close
  (right).
- On-screen keys with color dots (synced live to drone palette per
  scale degree). Pointer/touch → noteOn/noteOff. ADSR-driven glow.
- Octave shift arrows.
- **Remove the F-key fullscreen shortcut** in `App.jsx`. Button still
  works.

### Phase 3 — Computer keyboard
- Ableton-style letter mapping, Z/X octave shift.
- `⌨ ON/OFF` toggle in tray right panel.
- Editable-element + toggle bail-outs.
- Active regardless of tray expanded/collapsed (toggle is the gate).

### Phase 4 — Labels toggle
- Toggle below the octave block.
- When on: overlay letter labels (A, W, S, E, …) on each key; show Z/X
  next to octave arrows.
- Independent of the kbd-input toggle.

### Phase 5 — Settings panel: Keyboard section
- New section in `SettingsPanel.jsx` with envelope (ADSR), key mapping
  (white/chromatic × fill/jump), MIDI device picker.
- Wire envelope sliders to voice manager.

### Phase 6 — Key-mapping picker behavior
- Apply 2×2 mapping to all input sources (on-screen, MIDI, computer
  keyboard). Verify each combination end-to-end.

### Phase 7 — MIDI input
- `MidiInput` module + device picker (already stubbed in settings).
- Hook note-on, note-off, CC 64 → voice manager.
- Test with a real MIDI keyboard.

### Phase 8 — Live retuning polish
- Confirm orb-drag re-sort behavior feels right with held notes.
- Decide if the orb-drag glide tau (drone's 0.016 s) is the right value
  for keyboard retunes too, or if a slightly slower glide reads better
  for held notes.
- URL share state includes keyboard params (envelope, key mapping,
  labels toggle, etc.).

---

## 10. Open questions / decisions to make

Resolved (per the latest round):
- ✅ Scale-degree mapping, ascending order, no folding, no dedup
- ✅ 32-voice cap
- ✅ Sustain pedal in v1 (CC 64)
- ✅ Held notes track tuning changes (the keyboard is also a polyphonic drone)
- ✅ Drone+keyboard concurrent: future, but architecture supports it
- ✅ v1 has no velocity effects
- ✅ v1 panning = follow drone routing
- ✅ Beating preserved (no near-freq dedup)
- ✅ Muted drone slots still appear in the keyboard scale
- ✅ Keyboard re-sorts live as drone freqs reorder
- ✅ F-key fullscreen shortcut removed entirely
- ✅ Both pools always concurrent — no view-mode switch
- ✅ Keyboard exposed as a slim ~50 px tray rolling up from bottom
- ✅ Tray layout: octave + labels toggle (left), keys (center),
  kbd-input toggle + close (right)
- ✅ Envelope, key mapping, MIDI device picker live in the existing
  Settings panel (new "Keyboard" section)
- ✅ Labels toggle below the octave block — overlays Mac kbd letters on
  each note and shows Z/X markers, independent of the kbd-input toggle

Still open (small):

1. **Keyboard root MIDI note.** Probably MIDI 60 (C4) — matches the most
   common Ableton/MIDI-keyboard convention. Should this be user-settable?
   For v1, hardcode 60.

2. **Default ADSR values.** Suggest A=10ms, D=200ms, S=0.7, R=300ms for a
   "soft-attack, sustained sine" feel that matches the drone aesthetic.
   Tunable, no commitment — easy to revisit.

3. **Voice retune glide.** Tuning change → `setTargetAtTime(newFreq, t,
   0.016)`. Same tau as drone. If this feels twitchy on held notes during
   a fast orb drag, bump to ~0.05 s. Wait until it's playable to decide.

4. **On-screen keyboard range.** 1.5 octaves visible feels right for
   thumb-reach on mobile, 2+ for desktop. Worth testing — placeholder
   value is fine for phase 2.

---

## 11. Files likely to be touched / added

**New:**
- `src/audio/Tuning.js`
- `src/audio/KeyboardVoiceManager.js`
- `src/audio/MidiInput.js`
- `src/components/KeyboardTray.jsx` (the slim bottom tray + roll-up)
- `src/components/OnScreenKeyboard.jsx` (the keys themselves —
  reusable inside the tray)
- `src/components/EnvelopeControls.jsx` (lives in Settings panel)
- `src/components/KeyMappingControls.jsx` (lives in Settings panel)
- `src/components/MidiDevicePicker.jsx` (lives in Settings panel)
- `src/hooks/useComputerKeyboard.js` (Ableton-style letter listener)

**Modified:**
- `src/audio/AudioEngine.js` — small `getAudioBus()` API exposing
  `audioContext` + `masterGainNode` cleanly; subscribe-to-frequency-change
  hook so `Tuning` can listen.
- `src/App.jsx` — instantiate shared `Tuning` + `KeyboardVoiceManager`,
  mount `<KeyboardTray>`, **remove the F-key fullscreen handler**.
- `src/components/Oscilloscope.jsx` — no changes for v1 (analyzer-fed
  scope already picks up keyboard audio). Touched in a later phase if
  the keyboard-aware synthesized XY mode lands.
- `src/components/SettingsPanel.jsx` — new "Keyboard" section
  containing envelope, key mapping, and MIDI device picker.
- `src/App.css` — tray styles, drone-UI vertical shift when tray
  expands.

The `AudioEngine` doesn't need to know about keyboard-specific concepts —
it stays a drone engine that exposes a shared bus and a freq-change
notification hook. That keeps the existing drone code path mostly
untouched and lets the new pool be tested in isolation.
