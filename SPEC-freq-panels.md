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
- Chips display SOUNDING pitch (nominal × transpose ratio); every editor and
  commit runs NOMINAL. Commits go through `frequencyManager.setSlotHz` (ratio
  locks / follow-root / undo snapshots for free — never `audioEngine.
  setFrequency` directly).
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

## Verified

Headless (scratchpad `verify-freq-panels.js`, 18/18): open/retarget/close,
above-band geometry, coarse/fine/octave/keypad/note-key/cents-dial commits,
ALL transpose dial + jogger + RESET glide + APPLY fold, curve editor, voice
−/+. Mobile-width pass pending (blocked on a concurrent SettingsPanel WIP
crash at the time of writing).
