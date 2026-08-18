# Web frequency panels — per-voice + ALL (iOS port)

Ported 2026-08-03 from the iOS `FrequencyPanel.swift` / `Panels/AllPanel.swift`
surfaces. This doc marks the files this feature owns so concurrent sessions
(stage-gutter / side-column work) know the touch points.

## Files owned by this feature (new, self-contained)

- `src/components/FreqPanel.jsx` — per-voice panel host (header chips radio →
  controls / freq-keypad / note-keyboard faces; commits via
  `frequencyManager.setSlotHz` only)
- `src/components/AllPanel.jsx` — bus panel (mute-all, voices −/+, PAN ALL +
  GAIN, transpose dial ±24 st + octave jogger + RESET/APPLY, stereo-detune
  ZERO/RANDOM + shared `CurveEditor`)
- `src/components/NoteKeyboard.jsx` — one-octave piano + octave cluster +
  ±50¢ cents dial (tap = snap) + just/equal tuning cluster
- `src/components/EntryKeypad.jsx` — numeric keypad + buffer rules
- `src/components/FreqPanelParts.jsx` — OctaveJogger, FreqScrubber
  (coarse 2.5-oct relative bar + endless 200¢ fine ribbon + detune
  pair-lines), DetuneSlider
- `src/ui/pitchMath.js` — midi/Hz conversions, parseHz/formatHz
- `src/styles/freqPanels.css` — ALL panel styling lives here (not App.css),
  including the `.osc-controls-panel:has(.voice-panel)` z-hoist and the
  `button.console-all-caption` reset

## Touch points in shared files (small, keep intact)

- `App.jsx`: `freqPanelSel` state (voice index | 'all' | null, session-only) +
  count-shrink auto-close effect + `selectedVoice`/`onSelectVoice`/`voicePanel`
  props on `<OscillatorControls>`
- `OscillatorControls.jsx`: forwards selection props to MixerConsole; the
  panels themselves ride in the `sideMenus` column element from App
- `MixerConsole.jsx`: `selected` state lifted to `selectedVoice`/`onSelectVoice`
  props; ALL caption is now a `<button>` (opens the ALL panel, wears the
  corner marker when open)

## Placement contract

(Rev 2026-08-04 — replaces the original float-above-knob-band placement.)
The panels open in the side-menu column beside the console
(`.side-menu-stack` in App.css), radio-style with mixer / tuning / perform:
one surface in the column at a time, last-opened wins (`toggleSideMenu`
clears `freqPanelSel`; selecting a voice clears `sideMenu`). The stack owns
the chassis (background, border, width 310px, internal scroll);
`.voice-panel` is a plain flex column inside it, and its own `vp-head`
(mute · chips · ✕) is the title bar — no generic `.side-menu-head` — pinned
sticky while the stack scrolls. On ≤768px viewports the stack's bottom-sheet
behavior applies to the panels unchanged.

## Semantics carried from iOS

- Selection IS the panel (readout tap toggles/retargets; ALL and voice
  selection are one radio state).
- Chips display SOUNDING pitch (nominal × transpose ratio). The keypad and
  note faces run in the SOUNDING domain while the keypad's "[✓] apply
  transpose" checkbox is on (the default): seeds show nominal × ratio and
  commits divide the ratio back out, so what you type is what you hear.
  Unchecking drops both faces to the raw NOMINAL domain. Keypad side column:
  buffer + SET share the pad's 38px row rhythm (rows 1–2), then `clear` and
  the apply-transpose toggle as bare underlined WORDS (the ALL panel's
  .ap-word grammar; the checkbox rides un-underlined, whole row clickable).
  The controls-face scrubber stays nominal. Every commit still lands NOMINAL
  through `frequencyManager.setSlotHz` (ratio locks / follow-root / undo
  snapshots for free — never `audioEngine.setFrequency` directly).
- Note keyboard: tap commits immediately, keeps the current octave, equal
  mode preserves the cents deviation; just mode snaps to the nearest 5-limit
  ratio vs the anchor voice (hardcoded 5-limit like iOS). Cents-dial drag is
  anchored to the touch-down note; clean tap = snap to 0¢.
- ALL panel APPLY folds the transpose ratio into nominal Hz via
  `setAllFrequenciesBatch` then zeroes transpose (sounding unchanged);
  RESET uses `glideTranspose(0, 700)`.
- Detune: per-voice DetuneSlider and the ALL curve edit the same
  `droneStereo.detuneCurve`; effective Hz = curve × master `detuneHz`
  (web keeps its variable master, unlike iOS's pinned 10 Hz).
- **Pitch lock** (2026-08-11, iOS `AudioEngine.pitchLocked` parity): the
  `.vp-lock` button under the octave jogger freezes the slot's NOMINAL Hz.
  `setFrequency(i, hz, {force})` / `setAllFrequenciesBatch(f, {force})` /
  `glideToFrequencies(..., {force})` refuse a locked slot unless forced.
  Forced (the mover IS the voice's own editor, or the whole state is being
  loaded): `setSlotHz` / `setSlotRatio` / `stepSlotRatio`, the anchor's own
  set in `setRootHz`, `restoreSnapshot` (undo + recall), `patches/apply.js`,
  and the ALL panel's transpose APPLY. Unforced (the lock holds): root-follow
  propagation, Align / Load, dice + generative, orb drags, the global detune
  orb. The global transpose is a separate multiplier on the audio nodes, not
  a rewrite of `frequencyValues`, so a locked voice still moves with it —
  same as iOS. The flag is session-only; iOS persists it, web does not yet.

## Look rules

- **Borderless (2026-08-11).** Every button in the panel is a filled shape,
  never an outlined one: chips, ✕, octave rocker, lock, keypad keys + SET,
  octave chevrons, just/equal, the ALL voice-count pill. Selection is carried
  by the FILL — `color-mix(lane colour, transparent 78%)` — so there is no
  ring to thicken or brighten. Four exceptions, all deliberate: the mute cell
  (its ring IS the muted state, and matches the fill exactly when sounding),
  the keypad buffer (a transparent border that only appears, red, on invalid
  input), the checkbox box, and the note keyboard's piano keys (the borders
  are the key edges; a black key with no edge disappears into the panel).
- **Radius: 4px** (`--vp-radius`, keypad-sized keys `--vp-radius-sm: 3px`) —
  the CONSOLE's mute-cell radius, so the lanes and the menu beside them read
  as one object. Was 8px. Circles (fader balls, pan dials) and the capsule
  fader tracks are not cells and keep their own geometry.
- The ✕ heads the panel's right COLUMN: a 38px slot matching the octave
  rocker and the lock beneath it, wearing the same chip chassis. The 38 came
  out of the mute slot (44 → 38) and the head's gap (8 → 6), NOT off the face
  chips, which land on their worst-case labels with ~0px to spare.
- The panel's mute cell (`.vp-mute`) is the CONSOLE's mute cell in colour:
  one `--cell-fill` at 50% of the lane colour serving as both the sounding
  fill and the outline both states wear, ink number, `background-clip:
  padding-box`. Do not re-introduce a full-saturation fill — it outshouts
  the 0.7 level fader next to it.
- The stereo-detune slider is the level fader on its side: same capsule
  track / fill / ball geometry as `.vfader`, in grey, because it trims a
  voice rather than being one.
- ≥769px BOTH panels drop `.vp-lane` — the per-voice panel's pan + level and
  the ALL panel's bus pan + bus gain are each already on screen in the
  console lane one column to the left — and the bars take the width back.
  The ≤768px sheet covers the console, so it keeps the lane.
- Each panel's trailing edge is a 38px COLUMN: ✕ in the header, then the
  octave rocker (vertical in both panels) and, on the per-voice panel, the
  pitch lock. Nothing else may sit in that column's width.
- ALL panel transpose block (Dan, 2026-08-11): the frequency offset and the
  note offset sit at the DIAL'S TWO ENDS above it (`.ap-transpose-ends`,
  leading = Hz, trailing = cents; caption-dim at 0, full ink off centre —
  the `live` class). Under the dial, `.ap-transpose-foot` reads
  TRANSPOSE · RESET · APPLY, the same row grammar as the stereo-detune
  section below it. No "TRANSPOSE:" prefix above.

## Verified

Headless (scratchpad `verify-freq-panels.js`, 18/18): open/retarget/close,
above-band geometry, coarse/fine/octave/keypad/note-key/cents-dial commits,
ALL transpose dial + jogger + RESET glide + APPLY fold, curve editor, voice
−/+. Mobile-width pass pending (blocked on a concurrent SettingsPanel WIP
crash at the time of writing).

ALL panel: headless (scratchpad `probe-all.mjs`, 12/12 at 1280 and 390) —
lane drops on desktop and stays on mobile, the rocker is vertical and
column-aligned under the ✕, the readout spans the dial's ends above it and
the foot row sits below, zeros are dim with the actions disabled, and APPLY
still folds the offset with the sounding pitch unchanged.

Pitch lock: headless (scratchpad `probe-lock.mjs`, 14/14) — button toggles
the flag; `setFrequency` and the batch setter are refused while the batch
still moves the neighbours; a root move leaves it; the panel's own commit
and a forced restore still land; the flag stays on its own slot across
voice-count grow and shrink.
