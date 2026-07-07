# Held-Note Saves — Spec / Plan (2026-07-05)

Saving notes played on the computer keyboard or a MIDI keyboard into save
states, recalling them, transitioning between them with the voice-leading
engine, and visualizing all of it — drones (≤ 12) and held notes together.

Companion to GENERATIVE.md (voice-led transitions, §6.6) and
PARAMETER_LOCK.md (tracked-parameter scopes). Nothing here is built yet.

---

## 1. Grounding — what exists

- **Two voice layers already exist.** The drone pool (12 slots,
  `AudioEngine`) and the keyboard pool (`KeyboardVoiceManager`, "KVM") are
  independent: KVM voices are transient OscillatorNodes with their own
  envelopes, spawned per note-on, capped at **32 in-engine** (not 15 — see
  §7). Identity = `(slot, octave, midiNote, source)`; voices are bound to a
  drone slot at note-on and retune when that orb drags. `getActiveVoices()`
  already exposes everything a snapshot needs; `setVoiceLevel()` and per-
  voice retune (`RETUNE_TAU` writes) already exist.
- **Sources.** `'kbd'` (computer keys, AR envelope `computerKbdEnvelope`,
  hold-latch default on) and `'midi'` (MidiInput → KVM, ADSR
  `keyboardEnvelope`, velocity). Per-source envelope + wave are **global
  settings**, not per-note — exactly the user's model: the save doesn't
  care how a note was input, "aside from the different envelopes and synth
  shapes that are stored in the settings."
- **MIDI out.** `MidiOutput` rebuilds requests per frame ({id, freq, level,
  velocity, priority}); `MpeVoiceAllocator` reconciles them onto 15 member
  channels with unique (channel, note) per voice and ±48 st bend. Held kbd
  voices already outrank drones (PRIO_KBD > PRIO_DRONE) so channel stealing
  degrades gracefully past 15.
- **Save slots** (`FrequencyManager`): snapshot = {frequencies, volumes,
  mutes, transpose, slotRatios, anchorSlot, tuningSystem}. Recall/undo apply
  through the tracked-parameter scope (`PARAM_KEYS = freq/vol/onoff/
  transpose`). Patches carry the slots.
- **Voice-leading engine** (built): pure `matchVoices()` over {i, hz} lists;
  travellers (detach/spawn/tween/land); conductor plan→execute; piano-roll
  draws travellers and keyboard voices already.

## 2. Snapshot shape

New save-slot snapshot field:

```js
heldNotes: [{
  hz,        // absolute sounding frequency (pre-transpose nominal)
  level,     // steady-state 0..1 (what setVoiceLevel speaks) — NOT raw velocity
  source,    // 'kbd' | 'midi' — selects the envelope/wave POOL on recall only
  slot,      // drone slot bound at capture (nullable) — retune-tracking hint
  octave,    // nullable, same purpose
}]
```

- **Input-agnostic by design**: `hz + level` is the note. `source` is kept
  only as the pool selector so a recalled note sounds through the same
  envelope/wave settings it was played with; it carries no other meaning.
  A save whose kbd/midi settings changed since capture plays the CURRENT
  settings — same rule as drones (mix/envelope live in the patch, not the
  save).
- **Captured set**: voices held at capture time — latched, physically held,
  or pedal-sustained — excluding released tails. Pedal state itself is not
  saved.
- **Captured UNCONDITIONALLY** (2026-07-05, user-confirmed): snapshots keep
  their lossless-capture invariant (`_takeSnapshot` is "always full — scope
  is applied at recall/undo time, never here"). heldNotes are in every save
  regardless of the `notes` toggle; the toggle is a playback filter. Turning
  tracking on later retroactively animates old saves' performance layers —
  nothing is ever lost at capture time.
- **Level, not velocity**: velocity already resolved into the envelope peak
  at note-on; saves store where the note *sits*, matching how the mixer
  addresses voices.
- Slots serialize to localStorage and ride patches like every other field;
  `_normalizeSlots` tolerates absence (old saves → no held notes).

## 3. A fifth tracked parameter: `notes`

`PARAM_KEYS = ['freq', 'vol', 'onoff', 'transpose', 'notes']` — label
**"held notes"** in the Parameters-tracked strip (PARAMETER_LOCK.md).

- **Apply-time only** — capture is always full (§2). Untracked (default
  **off** for one release, then revisit — low stakes since nothing is lost
  at capture): recall/undo/transitions ignore held notes and the staged
  preview hides them — exactly today's behavior. Tracked: GO/recall applies
  §4; undo restores through the same diff; the capture bar previews staged
  notes (§6); the conductor transitions them (§5).
- **This toggle IS the layering choice** (see §8): scope off = saves are a
  drone-layer instrument and playing stays live on top; scope on = saves are
  full performance states.
- **Future "drone" tracking** (user, 2026-07-05): today's freq/vol/onoff
  already ARE the drone layer, so "is the drone tracked?" = those three
  toggles. Rather than a new (overlapping) `drone` param key, present the
  list as GROUPS with header checkboxes that flip their children —
  **drone** (freq · vol · on/off), **global** (transpose), **performance**
  (notes). Pure UI sugar over the flat scope set; no schema change, can
  land any time.

## 4. Recall semantics (GO / recallSlot / undo)

Diff-based, never wholesale-releaseAll:

1. **Keep**: a live held voice whose hz matches a saved note within ε
   (same log2 tolerance as drones) survives untouched; its level retargets
   via `setVoiceLevel` if different.
2. **Spawn**: saved notes with no live match → new voices with the source's
   normal note-on envelope, at `level`, **latched** (nothing is physically
   holding them). Needs KVM: `spawnVoiceAt(hz, {level, source, slot,
   octave})` — note-on minus the midiNote→pitch resolution, with a
   synthetic id for noteOff-matching immunity.
3. **Release**: live held voices with no saved match → envelope release.
   **Asymmetric timing like mutes**: spawns attack at recall start,
   releases fire at the end of the recall glide (`_applySnapshotSmooth`'s
   deferred-mute pattern, same cancellation rules).
4. Re-binding: spawned voices bind to the current slot whose pitch is
   nearest their hz (within ε) so they keep retuning with orb drags; no
   match → unbound fixed-hz voice (small KVM extension: slotless voices
   skip `_retuneAllVoices`).

`stagedIsDirty()` gains a notes term (chord differs from staged →
GO lights). MIDI out needs nothing: requests are rebuilt per frame, so
spawned/released voices allocate/release channels automatically.

## 5. Transitions (voice-led)

Unify the voice space the conductor matches over. A **handle** replaces the
bare slot index:

```js
{ pool: 'drone', slot }            // sounding drone
{ pool: 'held',  voiceId | null }  // live held voice / saved note (target)
```

- Sources = sounding drones + held voices; targets = save's audible drone
  mask + save's heldNotes. `matchVoices()` is already pure over {i, hz} —
  it just needs opaque handles instead of ints.
- **v1 matches within each pool separately** (drones↔drones,
  held↔held). Cross-pool travel means an audible timbre morph (drone wave →
  keyboard wave mid-gliss) — musically interesting, architecturally a
  hand-off/crossfade design of its own. **Deferred, explicitly.** The
  `connect closest ↔ furthest` fader, leash, gliss/bloom rules apply per
  pool with the same knobs.
- Held-pool move primitives are all *easier* than drones (no slot
  bookkeeping, voices are already free agents):
  - **glide** — per-frame retune of the live voice from the FM launch loop
    (entry key `v${voiceId}`; KVM `glideVoice(voiceId, hz)` write). MPE out
    follows as pitch bend for free (requests read live freq).
  - **travel** — same thing; held voices have no home slot to vacate, so a
    held travel IS a glide. No adoption needed.
  - **bloom** — `spawnVoiceAt(anchorHz)` then glide home. **merge** — glide
    into the neighbour, release on arrival. **fade-in/out** — spawn /
    release.
  - **step** — release + spawn at target with overlap (the kbd envelope's
    own A/R; stepMs range maps to the overlap as with drones).
- Orb policy (memory: intentional-animation rule) is satisfied by
  construction: held voices have no orbs; nothing slot-bound moves.
- Settle: at `done`, the held chord must equal the save's heldNotes —
  spawn/release/retune whatever slipped, with ⚠ logs. `_currentSlotId`
  and staleness compare the held chord too (a played note mid-preview =
  stale plan → re-roll).

## 6. Visualization

- **Piano-roll (timeline) is the canonical transition view — it already
  works.** Keyboard voices draw as `v:` lanes, glides bend them (per-frame
  freq), spawns/releases start/end segments, travellers bridge drones.
  Held-note transitions cost ~zero new viz code. Up to 12 + 32 lanes is
  fine (lanes are cheap polylines).
- **Spectrum bar**: held notes are currently invisible there. Proposed
  (deliberate, per the intentional-animation rule — design before build):
  small satellite markers above the bar at held pitches, dimming with
  release; staged saves with tracked notes preview their chord as pending
  markers (mirroring the staged dots). NO passive motion: transition bends
  live on travellers/held glides appear only in the piano-roll until a
  transition visual is explicitly designed.
- **Capture bar preview**: staging a save with heldNotes shows a chord
  glyph/count on the numeral (e.g. "II ·5") so the user knows a
  performance layer rides that save.

## 7. Capacity — the "15" is only the MPE wire

- **In-engine**: KVM cap is 32 voices; WebAudio doesn't care about MPE. A
  save can hold 12 drones + dozens of notes; recall and transitions work
  entirely in-app at that size.
- **Single MPE zone out**: 15 member channels. Past 15 concurrent output
  voices the allocator already steals lowest-priority (drones yield to
  played/held notes). Saved chords ≤ 15 held notes are wire-safe; bigger
  chords sound fully in-app but truncate on the wire.
- **Scaling beyond 15 out** (deferred, both sketched):
  1. **Dual MPE zones on one port** — lower zone ch 2-15 + upper zone ch
     15-2 split ⇒ up to ~28 voices to one multi-zone-aware receiver.
  2. **Multiple output ports ("multiple VSTs")** — N `MpeVoiceAllocator`
     instances, one per enabled MIDI output; the allocator is already
     constructor-injected (`{memberChannels, send}`) precisely for this.
     Requests partition by pool (drones → port A, held → port B) or spill
     round-robin. UI: per-port enable + role in the MIDI panel.
- Recommendation: **cap saved held notes at 15 in v1** (capture warns and
  keeps the 15 most recent) so every save is wire-faithful; lift the cap
  when multi-port lands. In-engine truth stays uncapped.

## 8. Layers / consolidation

The question "constrain it, or support multiple layers / loaded patches?"
resolves without new architecture:

- The keyboard pool **already is a second layer** over the drones, and the
  tracked-parameter scope **already is the consolidation switch**:
  - `notes` untracked → saves manage the drone landscape; playing is a
    live, unsaved layer on top (today's behavior, preserved).
  - `notes` tracked → saves are consolidated performance states.
- **True multi-patch layering (two patches loaded at once) is out of
  scope** — the engine is a singleton 12-slot pool and everything (tuning,
  locks, mixer) assumes it. If it's ever wanted, it's a second AudioEngine
  behind a bus, not a save-format feature. Not planned.
- Possible middle step later: per-save "recall mask" overriding the global
  scope (this save recalls freq+notes, that one freq-only). Deferred until
  the global toggle proves insufficient.

## 9. Engine work list (build order)

1. **KVM capture/spawn API** — ✅ BUILT 2026-07-05, live-verified:
   `getHeldNotesSnapshot()` (NOMINAL detune-free hz — spawning re-applies
   the live detune curve, so storing detuned pitch would double it and make
   the diff read every voice as off-save), `getHeldNotesLive()`,
   `spawnVoiceAt(hz, {level, source, slot, octave})` (latched, synthetic
   null midiNote, slot hint or nearest-pitch re-bind; peak inverts the
   capture mapping), `releaseVoiceById(id)`. `noteOn`'s spawn body was
   extracted into `_spawnVoice` shared by both paths.
2. **Snapshot + scope** — ✅ BUILT 2026-07-05: `heldNotes` in
   `_takeSnapshot` (unconditional) + serialization + `getSlotHeldNotes(id)`;
   `'notes'` in PARAM_KEYS (default still off — enable the "notes ♪" chip
   in the tuning menu), `getStagedNotes()`, capture-bar ♪-count badge.
3. **Recall diff** — ✅ BUILT 2026-07-05, live-verified (save ♪2 → silence
   → stage → GO lit → GO → chord returns): `_diffHeldNotes` (greedy
   nearest-pitch within NOTE_MATCH_EPS ≈ 8.6¢; keep/spawn/release), applied
   in `launchAll` AND `_applySnapshotSmooth` (undo/recallSlot) with the
   mute-style asymmetry — spawns attack up front, releases deferred to the
   glide's end (`_deferredNoteTimer`, cancelled with the mute timer);
   `stagedIsDirty` + `_scopedEqual` (pitch-set identity; levels drift and
   don't count) grew notes terms.
4. **Conductor** — ✅ BUILT 2026-07-05, live-verified (2-note chord → 1-note
   save: one voice glisses −1200¢, the other merges into it; lands on 1
   voice): held pool matched separately via the same `matchVoices` (rule
   coins hoisted so ONE gliss/bloom roll covers both pools; gliss-off =
   identity matching via a `NOTE_EPS` leash). Move modes `n-glide` /
   `n-bloom` / `n-merge` / `n-fade-in` / `n-fade-out`; held moves join the
   same ordering/spread/duration mapping (they carry real Δ). FM primitives
   `glideHeldVoice` (launch-loop `v${id}` entries, rebind-to-nearest-slot on
   arrival, releaseOnArrive for merges), `bloomHeldNote`, `spawnHeldNote`,
   `releaseHeldVoice`; KVM `setVoiceFrequency` (per-frame nominal retune,
   extras ride) + `rebindVoiceToPitch`. Plan carries `heldSig` (staleness on
   played/released notes); settle + `_currentSlotId` diff the held chord.
   Voice-gone-mid-plan → spawn the target note instead. Knobs unchanged.
5. **Viz**: capture-bar chord badge — ✅ BUILT (♪-count top-right of the
   numeral, tooltip spells it out). **Octave-indicator pending marks —
   ✅ BUILT 2026-07-05, live-verified**: the kbd dot above each orb and the
   octave bubbles flanking the labels preview the staged save's note diff
   in the outline language — HOLLOW dot/bubble = a saved note will attack
   at that octave on GO/transition, a RING around a lit one = the sounding
   note there will release. Feed = `FM.getStagedNoteMarks()` (staged diff →
   {slot, octave, on|off}, polled by the FSB indicator rAF loop via
   `data-pending` attributes / `.pending-on|-off` classes — composes with,
   never falsifies, the live state). Piano-roll needs nothing.
6. **Deferred**: cross-pool travels (timbre-morph hand-off), multi-port /
   dual-zone MPE out, per-save recall masks.

## 10. Open decisions

1. `notes` scope default off (recommended — no behavior change on ship) or
   on? Low stakes either way: capture is unconditional (§2), so the toggle
   never costs data.
2. Recalled-voice slot re-binding: nearest-slot (recommended) vs always
   fixed-hz?
3. v1 held-note save cap at 15 for wire fidelity (recommended) vs uncapped?
4. Do held-pool transitions obey the same `Step probability`, or should
   held notes always glide (their envelopes make steps read as
   re-plucks)? Recommended: same knob, hear it, then decide.
