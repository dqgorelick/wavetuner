# Generative Mode — Spec / Plan

Brian-Eno-style generative playback (not AI). A **conductor** drives the 4 drone
voices by moving them between the chords stored in the user's **save states** —
that set of saved chords is the ENTIRE musical landscape. The conductor never
invents pitches; every target comes from a saved scene.

Ownership: engine/UI split is **lifted** for this feature (user: "I build all
of it"), as with parameter-lock. See PARAMETER_LOCK.md for the sibling model.

---

## 1. Scope (narrowed 2026-07-04)

**Current phase (2026-07-04): transitions only, user-driven.** Isolate and tune
the controls that decide HOW to move from one save state to another; scene
ORCHESTRATION (weights, when-to-switch) is parked. **The USER picks the next
state** — saves have no order, they're arbitrary user choices — by staging a
slot in the capture bar as always, then pressing **TRANSITION** (next to GO).
One generative journey into that state, then stop. No scheduler loop at all.
The flow is **plan → shuffle → execute**: the conductor rolls a concrete plan,
the panel shows it (the debug visualizer), **Shuffle** re-rolls to preview
different outcomes, and Transition executes exactly the plan shown.

**v1 decides exactly five things**, all within the save-state landscape:

1. **Glide or step** between notes (per move — the §6 step system is built).
2. **Transition time** for each move.
3. **How notes switch** — all at once (block chord) vs one by one (staggered).
4. **Musical heuristics** — e.g. "two ascending notes transition together"
   (same-direction grouping), "longer jumps get more time" (dwell ∝ distance).
5. **When to switch save states, and to which** — convergence + restlessness
   decide *when*; a **weighted percentage per save state** decides *which* (§4.3).

**Explicitly deferred** (decide later, keep out of v1):
- Bringing notes in and out — mute/unmute as a generative move. (The v1
  conductor shipped with a `muteProb` move; **retire it** — remove the knob or
  default it to 0. The stop-taper's fade-out mutes stay: that's stop behavior,
  not a compositional move.)
- **User input / intervention** — the leash (yield / soft / hard correction),
  automatic intervention detection, claim tracking. The built, manual
  `returnToCourse()` button stays as a utility; nothing automatic.
- Sections / beginning→middle→end arc (user defines N sections later; flat first).
- Engine-lane contract items #1/#2/#4 (per-voice glide duration, undo-free
  apply, tagged writes) — v1 runs on existing public methods.
- JI-lattice target generation (stay inside the user's curated scenes).

---

## 2. Grounding — what exists

"Scenes" = **save slots** in `FrequencyManager` (`{id, name, createdAt, snapshot}`,
max 8, persisted). Each `snapshot` is a lossless capture:
`{frequencies[], volumes[], mutes[], slotRatios(Map), anchorSlot, tuningSystem}`
(`_takeSnapshot`, FrequencyManager.js:969). 4 voices (`oscillatorCount`).

Primitives the conductor drives (all public, all built):
- `stageSlot(id)` + `getStagedFrequencies()` — select a scene (highlights in the
  capture bar exactly as if the user clicked it) and read its targets.
- `launchVoice(i)` — per-voice glide on an independent clock (log2 pitch space).
- `stepVoice(i)` — note-off/on re-articulation (§6), with the shared bipolar
  `stepGapMs` spacing.
- `setRecallGlideMs` / `setRecallCurve` — transition time and easing.
- engine `getAllFrequencies / isMuted` — read live state for heuristics.

---

## 3. Architecture

```
GenerativeConductor (built, singleton — src/audio/GenerativeConductor.js)
  ├─ scheduler loop      setTimeout "next event" (events seconds apart)
  ├─ decision function   pick next move from scenes + live state + heuristics
  └─ onChange()          emits state for the UI panel
        │  drives (never reaches into engine internals)
        ▼
FrequencyManager / AudioEngine   (public methods only, §2)
        ▼
GenerativePanel (throw-away UI, top-middle)   start/stop · return-to-course ·
                                              one slider per knob · scene weights
```

---

## 4. The conductor's decisions

**The loop always works toward a SELECTED save state** (user feedback,
2026-07-03): one slot is always staged, every target comes from it. The
conductor settles the audible voices into the selected state, then selects the
next one.

### 4.1 Per-move decisions (built)
Each tick moves a group of voices toward the staged scene:
- **Glide vs step** — weighted coin per move (`stepProbability`).
- **Transition time** — `glideMsMin..Max` interpolated by the move's normalized
  max|Δ| (log2 distance); dwell before the next tick scales the same way.
- **All at once vs one by one** — `density` picks how many of the group move
  this tick (largest jumps first); `staggerMsMin..Max` fans their launches out
  in time. stagger=0 → block chord; large stagger → one-by-one.

### 4.2 Heuristics (built)
From `current freqs` vs the staged scene's `snapshot.frequencies`, in log2 space:
- Per voice `Δᵢ = log2(targetᵢ / currentᵢ)` (signed pitch distance).
- **Same-direction grouping** — voices sharing `sign(Δ)` launch together
  ("two notes rising → launch together"); the more salient group (larger
  max|Δ|) moves first.
- **Dwell ∝ distance** — `max|Δ|` scales both glide duration and dwell.
- **Skip muted voices** — never move a silent voice (re-checked at
  delayed-fire time). This is a *guard*, not the deferred mute-as-a-move.

### 4.3 Scene switching — when + which (parked; USER-driven for now)
**Current build**: no automatic switching of any kind. The user stages the
next save state (slots are unordered — arbitrary user choices) and triggers
each transition manually. `sceneSwitchProb` and `muteProb` are gone from the
panel while transitions are the focus.

**Which** (LATER — the orchestration phase):
- **Per-scene weight**, user-set: `sceneWeights: { [slotId]: 0..1 }` in the
  conductor config (persisted alongside the other knobs). Default 1 for every
  slot; weight 0 = never selected.
- Selection = weighted random over slots, **excluding the currently selected
  one** (unless it's the only nonzero-weight slot).
- Weights are keyed by slot id: prune entries whose slot was deleted; a newly
  saved slot appears at weight 1. Renames don't matter (id is stable).
- **UI**: the GenerativePanel lists the save slots by name, one weight slider
  each (0–100%), live-tunable while running like every other knob.
- Later (not v1): first-order Markov — a weight *matrix* (from-scene ×
  to-scene) so transitions, not just destinations, are shaped.

### 4.4 Config — the transition knobs (✅ BUILT 2026-07-04, one-shot model)
Exactly what shapes ONE transition, all live-tunable + persisted:
- `spreadMs` (0–10s) — window over which departures scatter: 0 = block chord,
  large = one-by-one. (Absorbed the old `staggerMsMin/Max` pair.)
- `order` — who leaves when: `far-first` / `near-first` (by |Δ|), `low-high`
  (by target pitch), `random`. (`same-direction` moved out of this enum
  2026-07-04 — it's now the first RULE, below.)
- **Rules** (2026-07-04, NL_RULES.md — hand-built first, NL compiler later):
  a "rules" section under Step time in the panel; each rule is a probability
  slider ("chance it applies"), rolled ONCE per plan(); fired rules override
  the base knobs for that plan and are recorded on `plan.rules` (shown in the
  plan header + transition log). Rule #1: `ruleDirProb` "group ↑/↓ together" —
  when it fires, ordering/departures use the same-direction clustering
  (rising and falling leave as two gestures). Default 100% (the old
  order default); persisted `order:'same-direction'` migrates to `random`.
- `jitter` (0–1) — humanizes departure times (± a slot width).
- `stepProbability` — per-voice glide|step coin.
- `glideMsMin/Max` — per-voice travel time by pitch distance (needs contract
  item #1 — **built**: `launchVoice(i,{durMs})`, each `_launching` entry
  carries its own duration; shared `_recallGlideMs` is the fallback).
- `stepMsMin/Max` — per-step overlap window, distance-scaled exactly like the
  glide range (near → min, far → max); executed via `stepVoice(i,{overlapMs})`
  (per-call override of the tuning menu's `stepOverlapMs`, added 2026-07-04).
- Both time ranges render as ONE **two-thumb range slider** each in the panel
  (`RangeSlider`, overlaid native inputs; thumbs cross-clamp so lo ≤ hi, also
  enforced in `setConfigValue` via range specs `{type:'range', loKey, hiKey}`).
- Dead with the loop: `tickRate`, `density`, dwell scaling, taper.

### 4.4b Plan / debug visualizer — ✅ BUILT (2026-07-04, plan-preview model)
`plan()` rolls the dice ONCE into a concrete, inspectable plan:
`{seq, slotId, slotName, moves:[{i, fromHz, toHz, cents, mode, departMs,
durMs}], skipped:[{i, reason: muted|arrived}], totalMs, state: preview|running|
done|halted}`. The panel renders it as rows —
`▶ v0 220.0→246.9 +200¢ glide 6.0s @0.0s [▓▓▓░░]` — with live progress bars and
✓ per arrival (polled 4×/s while running). **Shuffle** re-rolls the same inputs
to preview a different outcome; **Transition** executes exactly the plan shown
(one setTimeout per departure; muted re-checked at fire time); **Halt** cancels
not-yet-departed voices, in-flight glides finish. The preview auto-replans when
the staged slot or a knob changes (never mid-run). Event ring-buffer log (40)
below the plan. Conductor: `plan/shuffle/transition/halt/getPlan/getLog/
getDebugState`.

### 4.5 Stop / taper — parked with the loop
The graceful taper belonged to the endless scheduler. A one-shot transition
ends on arrival; `halt()` is the only interrupt (lifted hand, not a brake
slam). Taper returns with the orchestration phase.

---

## 5. Deferred: intervention + the leash

Moved out of v1 scope (2026-07-04). Kept here as the eventual design: the
conductor subscribes to freq writes; a write it didn't originate claims that
voice for the user (`yield`), voices relax back after `releaseMs`; a soft leash
corrects drift > `softCents`, a hard leash pulls back beyond `hardCents`.
Requires the tagged-write contract item so self-moves aren't misread as
intervention. (`returnToCourse()` was built for the loop model and removed
with it 2026-07-04 — in the one-shot model, "get back on track" is simply
staging a save and pressing GO or TRANSITION.)

---

## 6. Stepped change (note-off / note-on) — ✅ BUILT (2026-07-03)

Every transition used to be a glide. A stepped move re-articulates: note-off →
frequency jumps at the silent instant (click-free) → note-on. Discrete/percussive
vs. glissando — a different compositional world. Built ahead of the scheduler:
- **Engine** `AudioEngine.stepVoiceTo(index, targetHz, gapMs)` — runs the drone
  release on the per-slot gain, jumps pitch at silence, then attack→decay. Muted
  voices retune silently. `MIN_STEP_RELEASE_S` floor keeps max overlap click-free.
- **Manager** `stepVoice(index)` — the stepped sibling of `launchVoice`; discrete,
  re-baselines `_lastStable`, one undo point, cancels any in-flight glide.
- **Note spacing** is a bipolar config `_stepGapMs` (persisted, ±5 s): negative =
  overlap (release compressed), 0 = butt-join, positive = a silent pause.
- **UI**: bipolar slider at the **bottom-left of the tuning menu** (`StepGapControl`;
  left = overlap, right = pause, ms readout under 1 s). On the spectrum bar,
  clicking a target **triangle steps**; the **dot / dotted-line still slides**
  (glide). Swipe-cascade respects the same split.
- The conductor exposes `glide | step` as a per-move type weighted by
  `stepProbability` (built).

### 6.1 The step event — ✅ BUILT (2026-07-03)
`FrequencyManager.onStep(fn)` / `_fireStep`. `stepVoice` captures `fromHz`,
gets the schedule back from `stepVoiceTo` (which returns `{fadeOutMs, onDelayMs,
attackMs, gapMs}`, or null for a muted voice), and emits
`{voice, fromHz, toHz, at, fadeOutMs, onDelayMs, attackMs, gapMs}`. One event
feeds both consumers below, in sync (both are otherwise diff/poll-based off
`frequencyValues` and would see a step as a silent instant pitch jump).

### 6.2 MIDI re-articulation — ✅ BUILT (2026-07-04)
A step re-articulates on the wire instead of bending. Done WITHOUT touching the
allocator — it drops out of the diff/poll model naturally via a per-slot **generation
counter** in the drone voice id (`drone:${slot}:${gen}`):
- `MidiOutput._onStep(evt)` (subscribed to `frequencyManager.onStep`) turns the
  CURRENT note into a lingering **tail** (`{gen, freq: fromHz, offAt}`) and **bumps
  `gen`**. Overlap (gapMs<0): tail `offAt = now + |gap|`; pause/butt: `offAt = now`.
  New note-on time `onAt = now + max(0, gap)`.
- `_buildRequests` emits, per unmuted slot: the tail id at its **frozen fromHz** while
  `now < offAt` (so the pitch jump doesn't bend it), AND the current-gen id at live Hz
  once `now >= onAt`. The allocator's ordinary diff then does the work: a new gen id →
  **note-on** (re-articulate); the old gen id vanishing → **note-off**; overlap keeps
  BOTH ids live briefly → a genuine **two-note overlap** on a second member channel.
- Glides don't fire step events, so they remain continuous per-note **pitch bends**.
Frame-accurate (rAF poll, ~16 ms), not sample-accurate — fine for MIDI. Tail + new note
are equal priority (PRIO_DRONE); if all 15 member channels are busy the excess parks
(no steal between equals). Mute clears the slot's tail/gap state.

### 6.3 Step visualizer (spectrum bar) — ✅ BUILT (2026-07-04, unified)
Driven imperatively off the step event (no per-frame React re-render of the heavy
bar). One transport rAF, per stepping voice. BOTH step types share one model: a
**single transition orb** (the imperative `.fsb-step-ghost` element) **waits at the
OLD position, soft-pulsing** ("here, not fully on") for `waitMs`, then **quick-slides
home** over `STEP_OVERLAP_SLIDE_MS` (200 ms, smoothstep). `waitMs` = `ghostMs` for an
OVERLAP (the old note's full life = hold + release, audible throughout) or the RAW gap
`evt.gapMs` for a PAUSE/butt — deliberately NOT `onDelayMs`, which also bakes in the
envelope release `R` and made the visual pause read longer than the gap the user set.
The real orb stays hidden underneath at the new position and is revealed at the hand-off.
(Note: the audio note-on is still at `R + gap`, so on a pause the orb lands ≈`R − slideMs`
before the note actually sounds.)
- The **number label and the position line ride along** with the orb, so the whole
  indicator departs the old spot and arrives together. Label = imperative
  `label.style.left`; line = a `stepLineXRef` override object read by
  `_updatePositionLines` (a plain ref, so it never mutates the memoized `dotXs`/
  `freqXs`). The staged dot/line target markers DON'T animate (a step lands them
  instantly) — only the orb carries the motion, glide-like.
- Auto-zoom **HOLDS while any transport is in flight** (`transportsRef.size > 0`) so
  the view stays framed on the old spot until the orb lands, then eases to the new
  framing.
Descriptor = `{ at, waitMs, fromHz, toHz }`. Files: `FrequencySpectrumBar.jsx`;
constants `STEP_MUTED_OPACITY`/`STEP_PULSE_*`/`STEP_OVERLAP_SLIDE_MS`;
`AudioEngine.stepVoiceTo` returns the timing.

### 6.4 Real overlap via an oscillator hand-off — ✅ BUILT (2026-07-03, revised)
Overlap plays **two notes at once with NO phase reset**. The naive approach (move
the old note onto a fresh oscillator) restarts its phase — an audible jump the user
caught. Fixed by keeping the old note on its OWN oscillator and pointing the SLOT at
a new one. For a negative-gap step, `stepVoiceTo`:
- **`_releaseTransientVoice`** detaches the slot's current oscillator(s) — they keep
  playing the OLD note at continuous phase (no reset), routing untouched, HOLD
  through the overlap (`holdSec` = `|gapMs|`, capped `MAX_STEP_OVERLAP_S` = 5 s),
  then RELEASE over the drone envelope release, self-stop + tear down on `onended`.
- **`_createSingleOscillator(index, false)` + `droneEnvelope.applyNoteOn`** gives the
  slot a fresh oscillator at the new pitch, attacking from silence over the USER's drone
  attack (not the fixed slot fade) — a new note legitimately from phase 0.
- Extra partials stay on their own oscillators and just retune (no reset).
The new note's attack + the old note's release both follow the drone envelope.
**Visualizer**: overlap and pause share one wait-then-slide transition orb (§6.3).
Not live-verified (no headless audio); user is the audio loop. MIDI overlap is built (§6.2).

### 6.5 Generative slide easing — ✅ BUILT (2026-07-03)
Generative note slides must read as eased (ease-in-out), not linear. Glides already
run through the shared recall curve, but that's a user-facing setting that could be
left on linear. The conductor **forces `ease-in-out` for the duration of a
transition** (saving the user's curve on `transition()`, restoring it in
`_finish`).

### 6.6 Voice-led mute changes (gliss between chords) — ✅ BUILT (2026-07-05)
Saves that differ by **mute mask** (e.g. 7 JI degrees loaded, chords = subsets)
used to transition as bare fades — nothing glissed because no per-slot frequency
changed. Now the transition is **voice leading**: slots are scale degrees, the
*sounding notes* are the voices, and a voice can travel **across slot indices**.

- **Matcher** — `src/audio/voiceLeading.js`, pure `matchVoices(sources, targets,
  {connect, maxTravelOct})`. Enumerates every injective matching of the smaller
  audible side into the larger (≤ 60k candidates, else greedy fallback), ranks by
  total |log2| travel; `connect` picks a percentile — 0 = closest/no crossings,
  1 = furthest/leapfrogging. Unmatched targets = **entrances** (anchored to the
  nearest matched source → bloom origin), unmatched sources = **exits** (anchored
  to the nearest matched target → merge destination). Pairs beyond `maxTravelOct`
  demote to fade-out + fade-in.
- **Travel = node adoption** (engine): `detachTravelVoice(i)` frees the sounding
  pair (slot gets a fresh silent pair and settles on ITS OWN save pitch at
  DEPARTURE — chains like 0→1 while 1→2 can't collide), the FM launch loop tweens
  `setTravelerFrequency`, `landTravelVoice(id, j)` makes slot j ADOPT the nodes —
  phase-continuous, no retrigger. Same-route landings ramp to the slot's gain over
  80 ms; cross-route hides the reconnect in a ~15 ms dip (click-free). Travelers
  are released by anything that invalidates slots (osc count change, launch-map
  freeze) — see `releaseAllTravelers` / FM `_releaseTravelEntries`.
- **FM primitives**: `travelVoice(i,j)`, `mergeVoice(i,intoHz)` (glide into a
  neighbour, release there), `bloomVoice(j,fromHz)` (attack at the anchor pitch,
  glide home), `fadeInVoice(j)`, `fadeOutVoice(i)` (classic mute when on-save;
  detach+release when off-save so the slot settles silently underneath).
- **Orb policy (2026-07-05, user-directed)**: no voice-led move may self-animate
  a spectrum orb — all UI animation stays *intentional* until the transition viz
  is designed. Orbs mirror slot pitch, so every voice-led bend runs on
  travellers, invisible to slots: blooms use `spawnTravelVoice(hz, forSlot)`
  (fresh pair attacks at the anchor pitch, borrows the destination slot's
  routing/detune/volume, glides, slot adopts at landing) rather than the GO
  launch-glide, whose orb slide was an unintentional carry-over. Slots stay
  parked on their save pitch from departure. The only orb motions left in a
  transition: same-slot movers (the long-standing launch glide), mute dim
  fades, and the step-hop ceremony. Bloom MIDI note-on now fires at landing,
  not bloom start.
- **Conductor knobs**: `connectClosest` (0..1 fader), `maxGlissOct` (leash);
  rules `ruleGlissProb` ("glissando note changes" — chance the mute delta is
  voice-led at all; 0 = plain fades) and `ruleBloomProb` ("bloom / merge" —
  chance entrances/exits bloom/merge instead of fading). Move modes in plans:
  `travel` (renders `v0→v3 gliss`), `bloom`, `merge`, `fade-in`, `fade-out`.
- Only active when the save carries `mutes` AND on/off is in the recall scope
  (`getStagedMutes()` — parameter lock respected); otherwise the legacy per-slot
  plan runs. Settle + `_currentSlotId` + staleness now compare mute masks too.
- Entrance/exit fade *speeds* deliberately ride the drone envelope's A/R — no
  extra knobs. MIDI: a travel is note-off at departure + note-on at landing (no
  cross-slot bend yet — `getTravelers()` exists for a future MIDI feed).
- **Piano-roll (timeline, vizMode 4) draws travels** — `sampleTimeline` feeds
  `getTravelers()` into `tv:{id}` lanes alongside the step tails: the source
  slot's band ends at departure, the traveller lane bends across to the new
  pitch, the destination's band picks up at landing. Blooms/merges/fades need
  no viz work (they're slot-native / envelope events the sampler already sees).
  Spectrum-bar animation not built yet (dots/lines design TBD).

---

## 7. UI surface (GenerativePanel)
**Throw-away UI for now** — a simple panel pinned **top-middle** of the app, not
integrated into the tuning panel. Disposable while we prototype the conductor;
polish/placement comes later.

**Every §4.4 knob is exposed here** — the panel is the parameter menu — plus:
- **Shuffle / Transition / Halt** — re-roll the plan, execute it, cancel
  pending departures. (Transition also lives in the capture bar next to GO as
  a **white AI-sparkle icon** button, not a text label.)
- **Auto-select** (2026-07-04, revised twice that day): the user's staged slot
  ALWAYS wins — pressing Transition with a save staged (and distance to
  travel) goes exactly there. Only when there's nowhere to go (nothing staged,
  or the staged state already reached) does `_autoSelectAndPlan` pick: a
  random save **other than the one the voices currently sit on**
  (`_currentSlotId`: the slot whose frequencies match every live voice within
  ε — judged from actual positions, not staging), or any save when they're on
  none. Candidates come ONLY from `_visibleSlots()` — the first stored slot
  per numeral I–V, exactly what the capture bar displays. `getSlots()` can
  hold MORE (stale saves from old sessions, slots imported with a patch, up to
  8 persisted); auto-selecting those landed voices on chords the user never
  chose, with no numeral highlighted (the "random spot" bug, found
  2026-07-04). Shuffle the candidates, stage → plan each until
  moves.length > 0 (a duplicate of the current chord yields no moves and is
  skipped). Repeated presses wander the visible saves one press at a time.
  With ZERO visible saves the sparkle doesn't render at all, and the panel
  shows "no save states — save at least one in the capture bar" in place of
  the plan (`conductor.getVisibleSlots()` is public for exactly this gating).
  Related stranding fix: the capture bar's deselect now calls
  `clearStaged({finishGlides: true})` — in-flight glides complete to their
  captured targets instead of freezing voices mid-glide off every save.
- Panel visibility is toggled by a **sparkle icon next to the TUNING button**
  in the bottom bar (persisted, `transitionOpen`).
- **The plan** (§4.4b) — per-move rows with live progress, skipped voices,
  event log.
- Header shows `current → save "II"` for the staged slot (slot names are the
  Roman numerals I–V; saves are unordered, the user picks).

---

## 8. Open decisions (recommended defaults in **bold**)
- **D1 target vocabulary** — **saved scenes only**; the save states ARE the
  landscape. JI-lattice exploration much later, if ever.
- **D2 session length** — **open-ended** until Stop (Stop → taper); flat
  behavior sustains until then (no sections in v1).
- **D3 generative scope** — **freq only** in v1 (mute-as-a-move retired, §1;
  volume deferred with it).
- **D4 scene-weight shape** — **flat per-destination weights** in v1; a
  from×to Markov matrix later if flat weights feel too memoryless.

---

## 9. Build phases
1. ✅ `GenerativeConductor` v1 (2026-07-03) — flat, no sections. `setTimeout`
   scheduler; weighted-random moves; same-direction grouping; dwell+glide ∝
   max|Δ|; taper on stop; `returnToCourse()`; all knobs live-tunable +
   persisted. Throw-away `GenerativePanel` top-middle, mounted in App.jsx.
   Drives existing public API only.
2. ✅ Step system (§6, 2026-07-03/04) — `stepVoiceTo`/`stepVoice`, bipolar
   spacing, step event, MIDI re-articulation, spectrum-bar transport orb,
   conductor glide|step per move.
3. ✅ One-shot TRANSITION rewrite (2026-07-04, user-directed) — killed the
   scheduler loop entirely (start/stop/taper/returnToCourse/auto-advance all
   gone); user stages a slot → **TRANSITION button** in the capture bar next
   to GO (its generative sibling); plan → **Shuffle** → execute with the §4.4
   knob set; plan/debug visualizer with live progress (§4.4b); contract item
   #1 built (`launchVoice(i,{durMs})` per-voice glide duration).
4. Tune the transition by ear; promote remaining hardcoded numbers to knobs
   as needed (distance norm 1 oct, arrival ε ~1.7¢, cluster width spread/4,
   glide curve). ← WE ARE HERE
5. Verify in-browser (no headless driver — manual check, as with param-lock).
6. Orchestration phase: automate "when to transition + to which" ON TOP of
   the one-shot primitive — scene weights (§4.3), settle time, taper's return.
7. Later, in rough order: mute/unmute as a compositional move (re-scoped),
   intervention/leash (§5), sections, Markov transition matrix, remaining
   contract items.
