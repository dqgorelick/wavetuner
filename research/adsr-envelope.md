# Amplitude Envelope (ADSR) — Plan

Two parallel Attack/Decay/Sustain/Release envelopes — one per pool —
that shape:

- **Keyboard voices** at `noteOn` / `noteOff` (extends what
  `KeyboardVoiceManager` already does).
- **Drone slots** at mute / unmute (today these use a hard-coded 0.3 s
  exponential ramp; that gets replaced by the drone ADSR).

Modeled on Ableton's "Amplitude Envelope" panel: A/D in ms, S as a
0–100% level, R in ms, plus a small graph that previews the shape. We
render that panel **twice** — one for drones, one for keyboard — so the
two pools can have distinct character (e.g. snappy keys + slow drone
swells).

A separate **fixed 300 ms linear ramp** handles the transient case of
an oscillator slot being added or removed via the count control. That
path stays decoupled from the user envelopes — see §7c.

---

## 1. Mental model

The drone is a continuous oscillator pool, but the user already thinks of
the **mute toggle** as the slot's "note on / note off." Today:

- mute → `gainNode.gain.exponentialRampTo(0.001, t + 0.3)`
- unmute → `gainNode.gain.exponentialRampTo(volume, t + 0.3)`

That's a fixed-shape envelope already; we're just making it user-tunable.

**Two envelopes, not one.** The two pools serve different musical
purposes — drones are sustained beds you sculpt slowly, keyboard voices
are gestures you trigger. Forcing them to share an envelope means a
"slow drone swell" feel (3 s attack) collides with a playable keyboard
(needs ≤ 50 ms attack to feel responsive). Decoupling lets each pool
have its own character. The two envelopes are otherwise structurally
identical and reuse the same module code.

The envelope is **amplitude-shape only**. It does not own the final
amplitude target — that's still:

- Drone:   `volume_slider × droneEnv.sustain` (steady-state) shaped by A→D peak
- Keyboard:  `velocity × keyEnv.sustain` (steady-state) shaped by A→D peak

That separation matters: the user's volume slider per drone slot stays
the "this drone's loudness" control; the envelope's S knob is "what
fraction of that level holds during sustain."

---

## 2. What sits where (architecture)

One `Envelope` class, two singleton instances — one per pool. Same
code, different state.

```
src/audio/Envelope.js                  (new — class + factory)
  class Envelope {
    attack, decay, sustain, release    // per-instance state
    setAttack(s), setDecay(s),
    setSustain(0..1), setRelease(s)
    applyNoteOn(gainParam, ctx, peak)  // schedules 0 → peak → peak·sustain
                                       // tags gainParam._envState + _peak + _env
    applyNoteOff(gainParam, ctx)       // schedules current → 0 over R
    onChange(cb)                       // for UI graph + live retargeting
    retargetSustain(gainParam, ctx)    // recomputes peak·sustain target
                                       // for held nodes after sustain change
  }
  export const droneEnvelope = new Envelope({A:30, D:200, S:0.7, R:300})
  export const keyboardEnvelope = new Envelope({A:30, D:200, S:0.7, R:300})

AudioEngine.js                         (modified)
  muteOscillator(i)   → droneEnvelope.applyNoteOff on gainNodes[i]
  unmuteOscillator(i) → droneEnvelope.applyNoteOn on gainNodes[i] with peak = volume[i]
  setVolume(i, v) while !muted → reschedule sustain target to v·droneEnv.sustain
  droneEnvelope.onChange → for each unmuted slot, retarget to v·droneEnv.sustain

  // Add/remove slot path uses a separate fixed ramp (see §7c)
  _createSingleOscillator(i)        ramps in over FIXED_SLOT_FADE (0.3 s)
  setOscillatorCount(decrement)     ramps out over FIXED_SLOT_FADE (0.3 s)

KeyboardVoiceManager.js                (modified)
  drop the local attack/decay/sustain/release fields
  noteOn  → keyboardEnvelope.applyNoteOn(voice.gain, ctx, peak)
  noteOff → keyboardEnvelope.applyNoteOff(voice.gain, ctx)
  release tail length comes from keyboardEnvelope.release for stop scheduling
  keyboardEnvelope.onChange → for each non-released voice, retarget current
    ramp's destination to peak·newSustain (live retargeting; see §5)
```

**Why a class with two instances and not two ad-hoc modules?**

- Identical schedule/retarget code; only the four numbers differ.
- Each instance owns its own `onChange` listener set, so the drone
  panel's graph and the keyboard panel's graph subscribe independently
  without filtering events.
- Per-instance defaults differ in practice (drones probably default to
  longer A/R; keyboard defaults to snappy values) — instance
  construction is the natural place to set those.

**Why a separate module and not just statics on `AudioEngine` or
`KeyboardVoiceManager`?**

- Settings UI needs to subscribe to envelope changes for live graph
  redraw and held-note retargeting. A dedicated `onChange` keeps that
  subscription orthogonal to the audio-graph plumbing.
- Future per-drone-slot or per-keyboard-zone envelope overrides become
  additional `Envelope` instances; no rewire of the audio graph.

---

## 3. Envelope semantics — keyboard voices

This is exactly what `KeyboardVoiceManager` already does, refactored to
delegate scheduling to `Envelope`:

```
   amp
    |
    |    /\
    |   /  \____
    |  /        \________
    | /                  \__________
    |/                              \_______
    +----A---|-D-|-------S-------|----R----  → time
            peak  peak·sustain
```

- Note-on at t₀: `gain` = 0
  - linearRampTo(peak, t₀ + A)
  - linearRampTo(peak·sustain, t₀ + A + D)
- Held: stays at peak·sustain until note-off
- Note-off at t₁:
  - capture current gain value (mid-attack short notes don't jump)
  - linearRampTo(0, t₁ + R)
  - oscillator.stop(t₁ + R + 0.05) — same 50 ms safety pad as today

`peak` is `velocity` (1.0 in v1; we keep the velocity arg for later).
Already implemented today as inline scheduling at lines 110–114 / 180–186
of `KeyboardVoiceManager.js` — moves into `Envelope.applyNoteOn/Off`.

---

## 4. Envelope semantics — drone mute/unmute

Drones run continuously, so "note on" is the **unmute** transition and
"note off" is **mute**. The oscillator never stops; only the gain node
animates.

### Unmute (note-on)

- Pre-state: `gain ≈ 0` (drone was muted)
- `peak = volumeValues[i]` (the slot's volume slider)
- `sustainLevel = peak × sustain` (envelope.sustain ∈ [0,1])
- Schedule:
  - `setValueAtTime(0, t)` (same defensive epsilon trick as today —
    use `1e-4` to keep `linearRampTo` stable; truly 0 is fine since we
    use linear, not exponential, ramps in the envelope module)
  - `linearRampToValueAtTime(peak, t + A)`
  - `linearRampToValueAtTime(sustainLevel, t + A + D)`

After `t + A + D`, the gain holds at `peak × sustain` indefinitely.

### Mute (note-off)

- Capture current gain value (`gain.value`)
- `cancelScheduledValues(t)`
- `setValueAtTime(currentValue, t)`
- `linearRampToValueAtTime(0, t + R)`

The oscillator does **not** stop — drones share phase across mute cycles
(important for beating with un-muted drones to stay phase-correlated).
This is the only behavioral difference from the keyboard pool's
`applyNoteOff`, and it's why the envelope module exposes
`applyNoteOff(gainParam, ctx)` rather than an oscillator-aware "stop"
helper. The mute path skips the `osc.stop()` schedule.

### Replacing today's exponential ramps

`muteOscillator` and `unmuteOscillator` currently use
`exponentialRampToValueAtTime`. Two reasons to switch to linear inside
the envelope module:

1. The keyboard side already uses linear ramps; matching keeps the
   "feel" identical between pools.
2. Exponential ramps need a non-zero floor (the existing code uses
   0.001 / `Math.max(currentGain, 0.001)`); linear ramps don't, which
   simplifies the value-capture logic on short releases.

The audible difference for short A/R values (~10–30 ms) is negligible.
For long releases (R = 1–2 s) linear release sounds slightly more "even"
than exponential — Ableton's Amplitude Envelope is also linear by
default, so this matches user expectation.

---

## 5. The volume slider × sustain interaction

The slot volume slider is independent of the ADSR. Three scenarios:

### A. Volume slider moves while drone is **un-muted (held note-on)**

The drone is sitting at `peak × droneEnv.sustain` where
`peak = volumeValues[i]`. When the slider moves to `v_new`, the
steady-state target becomes `v_new × droneEnv.sustain`.

```js
setVolume(i, v_new):
  this.volumeValues[i] = v_new
  if (mutedStates[i]) { this.preMuteVolumes[i] = v_new; return }
  const target = v_new * droneEnvelope.sustain
  gainNodes[i].gain.setTargetAtTime(target, t, 0.016)  // existing tau
```

Same `setTargetAtTime` call shape the engine uses today — only the
target changes from `v_new` to `v_new × sustain`.

### B. Volume slider moves while drone is **muted**

Today: stash in `preMuteVolumes[i]`, no audio change. Same with ADSR —
the next unmute will use the new value as `peak`.

### C. Sustain knob moves while drones / keyboard voices are held

**Drones (continuous):**
```js
droneEnvelope.onChange:
  for each unmuted drone i:
    target = volumeValues[i] * droneEnvelope.sustain
    gainNodes[i].gain.setTargetAtTime(target, t, 0.05)
```

**Keyboard voices (transient — also retarget live):**
```js
keyboardEnvelope.onChange:
  for each voice in voices, !voice.released:
    target = voice.peak * keyboardEnvelope.sustain
    voice.gain.gain.cancelScheduledValues(t)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t)
    voice.gain.gain.setTargetAtTime(target, t, 0.05)
```

Both pools live-retarget held notes to the new `peak × sustain` target.
Implementation note for keyboard: a voice mid-attack has a
`linearRampToValueAtTime(peak, t₀ + A)` already scheduled. Calling
`setTargetAtTime` after `cancelScheduledValues` overrides the in-flight
linear ramp and glides toward the new sustain target instead. The user
sees the envelope shape change live, which is what they want when
dragging the slider — they're auditioning. Tau is 0.05 s on both pools
so the change reads as smooth rather than instant.

**Caveat:** if the user drags sustain mid-attack, the voice doesn't
finish its scheduled attack peak — it heads straight for the new
sustain level. Acceptable because (a) sustain dragging is exploratory,
not performative, and (b) cancelling and re-scheduling A→D from current
gain to new peak to new sustain is much more code for a second-order
benefit. Document and move on.

### D. Volume × sustain edge case: sustain = 0

A drone at sustain = 0 fades to silence after A + D, then stays there.
That's fine — the drone is technically still "un-muted," just inaudible.
Matches a "pluck" envelope (full attack, zero sustain). To get sound back,
either raise sustain or re-trigger by mute → unmute.

---

## 6. UI: two "Envelope" sections in Settings panel

Two parallel panels, "Drone envelope" and "Keyboard envelope," stacked
between **Tune** and **MIDI input**. Same layout for each. A shared
`<EnvelopeControls>` component renders one panel; the settings panel
mounts it twice with different titles + envelope instances.

```
┌─ Drone envelope ───────────────────┐
│                                    │
│        ╱╲                          │     ← live preview graph (~80px tall)
│       ╱  ╲___________              │
│      ╱               ╲___          │
│     ╱                    ╲____     │
│                                    │
│  Attack    [─────●────]  300 ms    │
│  Decay     [──────●───]  200 ms    │
│  Sustain   [───────●──]   70 %     │
│  Release   [──────●───]  500 ms    │
└────────────────────────────────────┘

┌─ Keyboard envelope ────────────────┐
│                                    │
│       ╱╲                           │
│      ╱  ╲_______                   │
│     ╱           ╲___               │
│    ╱                ╲___           │
│                                    │
│  Attack    [──●──────]    30 ms    │
│  Decay     [──────●───]  200 ms    │
│  Sustain   [───────●──]   70 %     │
│  Release   [────●─────]  300 ms    │
└────────────────────────────────────┘
```

Default values reflect the typical use of each pool — drones lean
toward longer A/R for swells; keyboard leans snappier for playability.
Both are user-tunable; the two panels are otherwise identical.

### The graph

Pure SVG, four anchor points computed from the current ADSR values:

```
  P0 = (0, 0)                                  // start
  P1 = (xA, peakY)                             // attack peak
  P2 = (xA + xD, peakY × sustain)              // sustain start
  P3 = (xA + xD + xS_pad, peakY × sustain)     // sustain hold (visual pad)
  P4 = (xA + xD + xS_pad + xR, 0)              // release end
```

`xA, xD, xR` use a `Math.sqrt(ms)` mapping so 30 ms doesn't disappear
next to a 2000 ms release on the same axis (linear-time would render
short attack as a vertical line). `xS_pad` is a fixed visual width (~20 %
of the available width) — sustain has no time component, just a
horizontal "hold" segment for legibility.

Filled with a translucent fill underneath the polyline, like the
screenshot's mountain shape. Rebuilds on every `envelope.onChange`.

### Slider ranges

Match Ableton's defaults so the UI feels familiar:

| Param   | Min  | Max     | Step | Default | Curve              |
|---------|------|---------|------|---------|--------------------|
| Attack  | 1 ms | 10 s    | —    | 30 ms   | log (sqrt-ms slider)|
| Decay   | 1 ms | 10 s    | —    | 200 ms  | log                 |
| Sustain | 0 %  | 100 %   | 1 %  | 70 %    | linear              |
| Release | 1 ms | 10 s    | —    | 300 ms  | log                 |

Log mapping for time params keeps fine control near the bottom (10–500
ms range, where most musical envelopes live) without sacrificing the
slow-pad ceiling. Implementation: slider value 0..1 → ms via
`1 + 9999 × t²` (gives 1 ms…10 s, smooth). Display value uses ms < 1000,
then s (e.g. `1.20 s`).

### Sliders use the existing `tune-slider` styling

`SettingsPanel.jsx` already has `.tune-slider-row` / `.tune-slider-label`
/ `.tune-slider` / `.tune-slider-value` classes (used by Detune and
Glide). Reuse them for ADSR rows — no new CSS needed beyond the graph
container.

---

## 7. Edge cases

### 7a. Mute mid-attack / mid-decay (drone)

If the user clicks unmute then mute 50 ms into a 1 s attack:

1. Unmute scheduled `0 → peak` over 1 s, currently at `0.05 × peak`.
2. Mute reads `gain.value = 0.05 × peak` (Web Audio reports the
   in-flight ramp value).
3. `cancelScheduledValues(t)`, `setValueAtTime(0.05 × peak, t)`,
   `linearRampTo(0, t + R)`.

No click; release starts from where the envelope actually was. Same
trick the keyboard already uses (`KeyboardVoiceManager._releaseVoice`,
line 180).

### 7b. Re-mute during release (toggle spam)

Mute → mute again. The second mute sees `gain.value` already mid-release;
re-schedules a new release from there to 0. Effectively a no-op (the
gain keeps falling at roughly the same rate). Cheap, no special case.

Unmute during release → cancel release, `setValueAtTime(currentVal, t)`,
ramp `currentVal → peak` over `A × (1 − currentVal/peak)` so we don't
double the perceived attack length when the user re-unmutes a drone
mid-release. Simpler alternative: always do a full A from `currentVal`
to `peak` — slightly longer but predictable. **Pick the simple version**;
the visual and audible difference is small.

### 7c. Drone count change — fixed 300 ms ramp, NOT the envelope

Adding or removing a drone slot via the count `+ / −` buttons is a
**topology change**, not a "note on/off" event. Routing the count
control through the user envelope creates two problems:

1. With a 5-second attack (a perfectly normal drone setting), pressing
   `+` would silently add a slot that takes 5 s to become audible.
   Confusing.
2. Worse, with attack ≈ 0 the slot snaps in audibly — exactly the
   click the envelope was supposed to prevent — because the envelope's
   role is to be "soft enough for music," not "quick enough to mask
   topology change."

So the count path uses a **fixed 300 ms linear ramp**, decoupled from
the user envelope:

```js
const FIXED_SLOT_FADE = 0.3;  // seconds — short enough to feel snappy,
                              // long enough to mask zero-crossing pop

_createSingleOscillator(i):
  // existing setup (create osc, gain, routing, start)
  gain.gain.setValueAtTime(0, t)
  if (!mutedStates[i]) {
    const target = volumeValues[i] * droneEnvelope.sustain
    gain.gain.linearRampToValueAtTime(target, t + FIXED_SLOT_FADE)
  }

setOscillatorCount(decrement path, before osc.stop()):
  const t = ctx.currentTime
  gainNodes[i].gain.cancelScheduledValues(t)
  gainNodes[i].gain.setValueAtTime(gainNodes[i].gain.value, t)
  gainNodes[i].gain.linearRampToValueAtTime(0, t + FIXED_SLOT_FADE)
  oscillators[i].stop(t + FIXED_SLOT_FADE + 0.05)
  // ...then splice from arrays as today
```

Note that the **target** of the add ramp is still `volume × droneEnv.sustain`
— so adding a slot lands at the correct steady-state level the user's
envelope would've held. Only the **time** is fixed.

Mute / unmute on an existing slot still uses the user envelope. The
two paths are orthogonal: count changes use the fixed ramp, mute/unmute
uses the envelope.

### 7d. Sustain change while drone is mid-release (mute → release in flight)

A held drone is releasing. User drags sustain to 0.5. Should the in-flight
release retarget? **No.** Once released, the envelope is committed to
hitting 0; sustain only affects the next note-on. Track per-action state
on each gainNode (`gainNode._envState = 'attack' | 'decay' | 'sustain' |
'release' | 'idle'`) so `envelope.onChange` can skip non-sustaining
nodes. Cheap to maintain — set in the apply functions, cleared on
release-end via `setTimeout(t + R)`.

Actually simpler: only retarget nodes whose `audioEngine.mutedStates[i]`
is `false`. Muted nodes (in release or done) stay where they are. Skip
the explicit state machine.

### 7e. Toggle play/pause (spacebar) interaction

`pauseDrones` ramps `droneBusGain` to 0 over 300 ms — that's a *bus*
gain, not the per-oscillator envelope. The two compose multiplicatively.
No change needed: the envelope still runs on its own gain node;
pause/unpause just dim the output of all of them at once.

But: the sound through pause/unpause should **not** retrigger envelopes
when the bus comes back. Confirmed — only the bus moves.

### 7f. Velocity = 0 noteOn (MIDI quirk)

Some MIDI devices send `noteOn vel=0` instead of `noteOff`. Already
handled by `MidiInput`'s router (would route to noteOff). Mention here
only because if it bypassed the router, the envelope would schedule a
0-amplitude attack that does nothing — silent failure, but not a click.

---

## 8. Phased rollout

### Phase 1 — Envelope module + keyboard refactor
- New `src/audio/Envelope.js` exporting an `Envelope` class plus two
  singleton instances `keyboardEnvelope` and `droneEnvelope` with
  per-pool defaults.
- `KeyboardVoiceManager` deletes its local A/D/S/R fields and inline
  scheduling math; calls `keyboardEnvelope.applyNoteOn/Off`.
- Voices store `peak` so live sustain retargeting can compute
  `peak × sustain`.
- `keyboardEnvelope.onChange` retargets non-released voices via
  `setTargetAtTime` (tau 0.05).
- Sanity check: keyboard sounds identical to today with default values;
  dragging sustain mid-note glides held voices live.

### Phase 2 — Wire drone mute/unmute through droneEnvelope
- `muteOscillator(i)` → `droneEnvelope.applyNoteOff(gainNodes[i], ctx)`.
- `unmuteOscillator(i)` → `droneEnvelope.applyNoteOn(gainNodes[i], ctx,
  volumeValues[i])`.
- `setVolume(i, v)` on un-muted slot retargets to
  `v × droneEnvelope.sustain`.
- `droneEnvelope.onChange` retargets every un-muted drone's gain.

### Phase 3 — Fixed-ramp slot add/remove
- Constant `FIXED_SLOT_FADE = 0.3` in `AudioEngine`.
- `_createSingleOscillator` opens at gain 0, ramps to
  `volumeValues[i] × droneEnvelope.sustain` over `FIXED_SLOT_FADE`.
- `setOscillatorCount` decrement path ramps gain to 0 over
  `FIXED_SLOT_FADE` before `osc.stop()`.
- This path stays decoupled from `droneEnvelope` — changing the user's
  envelope sliders does not affect count-change ramps.

### Phase 4 — Settings panel "Envelope" sections (×2)
- `<EnvelopeControls envelope={...} title={...} />` rendered twice in
  `SettingsPanel.jsx`: once for `droneEnvelope`, once for
  `keyboardEnvelope`.
- Each panel: title, graph, four sliders, value readouts. Reuses
  `.tune-slider*` classes.
- Component owns the slider state and calls envelope setters; envelope
  fires `onChange` which the graph subscribes to.

### Phase 5 — Envelope graph component
- New `<EnvelopeGraph>` SVG component, ~280×80 px, four anchors + fill.
- Subscribes to its envelope's `onChange` and re-renders.
- Sqrt-ms x-axis mapping; fixed sustain pad width.

### Phase 6 — URL share state
- Include both envelopes' A/D/S/R in the URL hash format
  (e.g. `dEnv=30,200,0.7,300&kEnv=10,200,0.7,300`).
- Backwards compat: missing params → defaults.

---

## 9. Open questions

1. **Default values per pool.** Drones probably want longer A/R
   (300 ms / 500 ms) for swell-y character; keyboard wants snappier
   (10–30 ms / 200–300 ms) for playability. Worth tuning by ear once
   the controls are live — the values in §6's mockup are placeholders.

2. **A=0 / R=0 corner.** The sliders bottom at 1 ms (not 0) so a single
   sample never escapes. 1 ms is below human click-perception
   threshold; the envelope still produces a real ramp. Confirm by
   listening — if 1 ms still clicks on some hardware, raise floor to
   3 ms.

3. **Pre-existing 0.3 s mute fades that aren't in the envelope path.**
   `fadeOut` (used by routing/device changes) and `pauseDrones` both
   use 0.3 s exponential ramps on the bus, not per-oscillator. These
   are bus-level effects orthogonal to the envelope and stay as-is.
   Mention only so future-us doesn't conflate them. Note that
   `FIXED_SLOT_FADE` (count change) happens to be the same 300 ms by
   coincidence — keep it a separate constant in case one wants to
   diverge.

4. **Should the on-screen keyboard's key glow follow the envelope's
   amplitude?** The current `KeyboardVoiceManager.getActiveVoices()`
   returns `gain.gain.value`, which already reflects ADSR. If the
   on-screen keys read this for their glow brightness, the visual
   "fades in/out" with the envelope automatically — free side benefit.

5. **Linking the two envelopes (deferred).** Some users will want
   identical behavior on both pools. Could add a small "link" toggle
   that mirrors slider movements between the two envelopes. Easy to
   add later (one component-level subscription); not v1.

6. **Per-drone-slot envelope override (deferred).** A user might want
   slot 0 with a slow swell and slot 1 with a fast attack. The
   `Envelope` class already supports multiple instances; this would
   become a per-slot map with the global drone envelope as fallback.
   Defer until there's a real need.

---

## 10. Files likely to be touched / added

**New:**
- `src/audio/Envelope.js` — `Envelope` class + two singleton instances
  (`droneEnvelope`, `keyboardEnvelope`).
- `src/components/EnvelopeControls.jsx` — wrapper rendering title +
  graph + four sliders for one envelope instance. Mounted twice in
  the settings panel.
- `src/components/EnvelopeGraph.jsx` — SVG preview component used
  inside `EnvelopeControls`.

**Modified:**
- `src/audio/AudioEngine.js`
  - `muteOscillator` / `unmuteOscillator` → `droneEnvelope` helpers
  - `setVolume` → multiply target by `droneEnvelope.sustain` on un-muted
    slots
  - `_createSingleOscillator` → 0 → target ramp over `FIXED_SLOT_FADE`
  - `setOscillatorCount` decrement → 0 ramp over `FIXED_SLOT_FADE`
    before `osc.stop()`
  - subscribe to `droneEnvelope.onChange` to retarget held drones
- `src/audio/KeyboardVoiceManager.js`
  - drop local A/D/S/R fields and setters
  - `noteOn` / `_releaseVoice` → `keyboardEnvelope` helpers
  - store `voice.peak` for live sustain retargeting
  - subscribe to `keyboardEnvelope.onChange` to retarget held voices
- `src/components/SettingsPanel.jsx` — two `<EnvelopeControls>` mounts
- `src/App.jsx` — URL state serialization includes both envelopes' ADSR
- `src/App.css` — graph container styles only (sliders reuse existing
  classes)

The module split keeps the audio graph untouched: same gainNodes, same
routing, same bus topology. The envelopes are purely schedulers of
AudioParam changes against existing nodes.
