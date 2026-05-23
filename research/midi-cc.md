# MIDI CC support

Spec for adding MIDI Continuous Controller (CC) mappings to wavetuner.
v1 scope: CC controls **drone voice volume only**. The UI is built so it
extends naturally to other targets (partial volume, bus gain, master,
envelope, etc.) but only the drone-volume target ships first.

The behavioral model is borrowed from Ableton's MIDI-map mode: a single
button toggles the app into a "learn" state, eligible targets light up,
clicking a target arms it, and the next CC message that arrives binds.

---

## 1. UI elements

### 1.1 Top-right button

A new `.midi-toggle` button sits between `.share-toggle` and
`.settings-toggle` in the top-right cluster. Existing layout (see
`src/App.css:1563`):

```
.settings-toggle { right: 16px; }
.share-toggle    { right: 58px; }   ← currently
```

Becomes:

```
.settings-toggle { right: 16px; }
.midi-toggle     { right: 58px; }   ← NEW
.share-toggle    { right: 100px; }  ← shifted left
```

The button itself is the same 34×34 chassis as its neighbors. The label
is the literal text **MIDI** rather than an icon — mirrors the way the
on-screen-keyboard tray's KBD button reads as a word, and means a
glance can't mistake the dot indicators for the button's own glyph:

```jsx
<button className="midi-toggle" ...>
  <span className="midi-toggle-label">MIDI</span>
  <span className="midi-dot note" />
  <span className="midi-dot cc" />
</button>
```

```css
.midi-toggle-label {
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em;
}
```

States:

- **default** — same dim white as siblings.
- **`.active`** — lifted background (`rgba(255,255,255,0.22)`) plus a
  pulsing red ring whenever MIDI mode is on. There is no
  separate-from-active "learn" state: opening the panel == entering
  learn mode (see §2). One toggle, one visible state.

### 1.2 Activity dots

Two small (4 px) dots float on the **right edge** of the button, vertically
stacked:

```
┌──────────┐ ●  ← MIDI Note (upper)
│   DIN    │
└──────────┘ ●  ← CC (lower)
```

Positioned absolutely just outside the button's right edge so they don't
shift the button's center. CSS sketch:

```css
.midi-toggle { position: fixed; /* same as siblings */ }
.midi-toggle::after,
.midi-toggle::before {
  /* dots — implemented as real <span> children so we can drive their
     opacity from React rather than hammering DOM attrs */
}
.midi-dot {
  position: absolute;
  right: -8px;          /* sits just outside the button */
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);   /* idle */
  transition: background 80ms ease-out;
}
.midi-dot.note { top: 9px; }
.midi-dot.cc   { bottom: 9px; }
.midi-dot.flash { background: #4ade80; }   /* green flash on activity */
```

A `flash` class is added for ~120 ms whenever a corresponding message
arrives, then removed. The flash is throttled to one paint per
animation frame so a stream of CCs doesn't thrash React.

### 1.3 MIDI mappings panel

Position: **right-stack, immediately above `<Mixer>`**.

```
.right-stack
  └── MidiPanel       ← NEW (rendered when isMidiPanelOpen)
  └── Mixer
```

`.right-stack` already grows upward as panels are added (`flex-direction:
column`, bottom-anchored), so dropping the new component into the same
slot above the mixer just works.

Panel chassis matches `.mixer-panel`:

```css
.midi-panel {
  width: 275px;         /* same as mixer */
  padding: 9px 10px;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 12px;
  backdrop-filter: blur(10px);
}
```

Header row:

```
┌──────────────────────────────────────┐
│ MIDI MAPPINGS          [Save] [Clear]│
└──────────────────────────────────────┘
```

- **Save** — writes the current mapping table to `localStorage` under
  `midiMappings.v1` (see §5).
- **Clear** — wipes every mapping (in-memory + the persisted blob)
  after a one-step confirm.

Learn mode is on whenever this panel is visible — the corner
`.midi-toggle` opens the panel AND engages learn at the same time
(see §2). There is no separate "Learn" button inside the panel; it
would be redundant with the toggle the user already pressed.

Body — one row per active mapping:

```
┌──────────────────────────────────────┐
│ ● D1  CC 7   ch 1   ━━━━●━━━  [×]   │
│ ● D2  CC 8   ch 1   ━━●━━━━━  [×]   │
│ ● D3  CC 1   ch 1   ━━━━━●━━  [×]   │
│ + Add: click a voice in the mixer    │
└──────────────────────────────────────┘
```

Per-row:
- Color dot — the drone slot's `palette.oscColor(slot, oscillatorCount)`
  so the mapping is visually tied to its source.
- Target label — `D{slot+1}` for drone, future-extensible (`P{slot}.{idx}`
  for partials).
- CC number + channel — read-only text.
- Value bar — small horizontal indicator of the last CC value received
  (0..127 → 0..1). Drawn the same way as `.mixer-fader-fill`. Useful
  during learn / mapping verification.
- `×` — clears that single mapping.

Empty state — when no mappings are bound:

```
┌──────────────────────────────────────┐
│ MIDI MAPPINGS          [Save] [Clear]│
│                                      │
│  No CC mappings yet.                 │
│  Click a drone in the mixer, then    │
│  move a knob on your controller.     │
└──────────────────────────────────────┘
```

---

## 2. Learn flow

Learn mode is bound directly to the corner `.midi-toggle`. Clicking it
opens the panel **and** immediately enters Phase A; clicking it again
(or pressing Escape) exits both at once. No separate Learn button.

The state machine lives in App (or a small `useMidiLearn` hook);
keeping it in React rather than the singleton means panels can
re-render in response to phase changes without ad-hoc event plumbing.

### Phase A — armed for target selection

User clicks the corner `MIDI` button. The mapping panel slides in
above the mixer and the corner button picks up `.active` with its
pulsing red ring. In the mixer:

- Every **un-muted drone row** (and only those — partials are deferred
  to v2) picks up a `.midi-targetable` class. This adds a dashed
  outline + slight pulse to communicate "click me".
- Hovering a targetable row dims its mixer interactions and shows
  a `+ Bind CC` overlay.
- Clicking a targetable row → Phase B for that slot.
- Clicking outside / pressing Escape → exit learn mode entirely.

```
Mixer (learn mode, no target yet)
┌──────────────────────────────────────┐
│ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐  │
│ ┊ D3   220.00   A3 +0   ━━━●━━━  ┊  │  ← dashed = targetable
│ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  │
└──────────────────────────────────────┘
```

### Phase B — armed for CC capture

A target is selected. The MIDI panel grows a temporary "armed" row:

```
┌──────────────────────────────────────┐
│ MIDI MAPPINGS          [Save] [Clear]│
│ ● D3   waiting for CC…       [cancel]│
└──────────────────────────────────────┘
```

The next incoming `CC` message captures `{ channel, ccNumber }` and
finalizes the mapping. Implementation detail: the captured CC is
considered *the* mapping for that target — a second CC message before
finalization simply moves the binding to the newer CC (matches Ableton).

`NOTE_ON`/`NOTE_OFF` messages do NOT capture in v1 — they would conflict
with the existing keyboard pipeline. The upper dot still flashes for
those messages so the user can see their controller is alive.

### Phase C — bound

The row populates with `CC N · ch M` and updates as the CC is moved.
The panel stays open so the user can chain bindings; clicking the
corner `MIDI` button (or Escape) exits learn mode and closes the
panel.

---

## 3. Audio behavior

### 3.1 Volume mapping semantics

When a CC is bound to a drone slot's volume, the **CC value scales the
slot's volume directly**. The CC becomes the new source of truth for
that slot's volume:

```
ccValue ∈ [0, 127]
slot.volume = ccValue / 127     // 0..1
```

The mixer's volume fader reflects the value (so the user sees the ball
follow the knob). Manually dragging the fader still works — it pushes
the new value back through `audioEngine.setVolume(slot, v)` like
always; the next CC message just overrides it again. (Same model as a
DAW: the knob wins when it moves.)

**Smoothing.** Web MIDI delivers messages at the controller's
resolution, typically 10–100 Hz. The existing `setVolume` already
uses `setTargetAtTime` with a short time-constant via the engine's
volume-ramp logic, so per-message updates won't click. If audible
stair-stepping shows up on slower controllers we can add a one-pole
filter in `MidiInput` (target value updated on message, audio param
ramped at 60 Hz).

### 3.2 14-bit CC handling

A controller sending 14-bit CCs emits **both** the MSB (CC X) and the
LSB (CC X+32) on every fader motion. If learn-arm latches the LSB,
the bound knob oscillates wildly because the LSB cycles 0→127
repeatedly within a single slider move.

v1 fix: **during learn-arm, ignore CCs in the range 32–63**. Those
are the LSB halves per MIDI 1.0; binding waits for the next message
in the MSB range. After binding, LSB messages arrive but don't match
any binding key, so they're dropped cleanly by `handleCc`.

This means CCs 32–63 can't be deliberately bound, even on controllers
that emit them as their primary 7-bit CC. v2 can add a settings
toggle if anyone actually hits this.

### 3.3 Out-of-scope CC behaviors (deferred)

- 14-bit CC pairs as a precision binding (use both MSB+LSB for sub-1%
  knob resolution) — v2; v1 ignores the LSB and uses 7-bit only.
- CC relative-mode (encoders that send 1/127 deltas) — v2.
- Min/max range and curve per mapping — v2; v1 is hardcoded linear
  0..1.
- "Takeover" mode where CC is ignored until it crosses the current
  value — v2. v1 always snaps.

---

## 4. Data model

### 4.1 Cardinality

The mapping table is a relation, not a function in either direction —
but with one asymmetric constraint:

| Direction       | Allowed?         |
|-----------------|------------------|
| 1 CC  → 1 knob  | yes (the common case) |
| 1 CC  → N knobs | **yes** — same CC drives multiple targets (e.g. one fader to ride D1 and D2 together) |
| 1 knob → N CCs  | **no** — each target has at most one CC bound to it |

`bind(target, channel, cc)`:

- If `target` already has a binding, replace it (drop the old CC for
  that target).
- If `(channel, cc)` is already bound to OTHER targets, leave those
  bindings intact. The new target is added alongside them.

Result: incoming CC dispatch is one-to-many (look up CC, fan out to
every bound target), and target-side state never holds more than one
CC.

### 4.2 Singleton

A new singleton `MidiCCMap.js` sitting beside `MidiInput.js`:

```js
// src/audio/MidiCCMap.js

class MidiCCMap {
  constructor() {
    if (MidiCCMap.instance) return MidiCCMap.instance;
    // Forward index: `${channel}:${cc}` → Set<targetKey>
    //   Multi-valued so one CC can drive multiple targets.
    this._ccToTargets = new Map();
    // Reverse index: targetKey('drone-volume:3') → { channel, cc, lastValue }
    //   Single-valued by design (a target has at most one CC).
    this._targetToCc = new Map();
    this._listeners = new Set();
    MidiCCMap.instance = this;
  }

  // Replaces any existing CC for `target`. Leaves other targets that
  // share `(channel, cc)` untouched.
  bind(target, channel, cc) { /* see §4.1 */ }
  unbind(target) { /* drop the target's row; remove it from the CC's
                      fan-out set; if that set is now empty, drop the
                      CC entry too */ }
  clear() { /* drop all */ }

  // Called by MidiInput on every CC message. Fans out to every target
  // sharing this CC.
  handleCc(channel, cc, value) {
    const ccKey = `${channel}:${cc}`;
    const targets = this._ccToTargets.get(ccKey);
    if (!targets || targets.size === 0) return false;
    const normalized = value / 127;
    for (const targetKey of targets) {
      const row = this._targetToCc.get(targetKey);
      if (row) row.lastValue = value;
      this._applyToTarget(this._parseTargetKey(targetKey), normalized);
    }
    this._fire();
    return true;
  }

  // Toolkit; not extended in v1 but the dispatch site is ready.
  _applyToTarget(target, normalized) {
    if (target.kind === 'drone-volume') {
      audioEngine.setVolume(target.slot, normalized);
    }
  }

  // Learn state — owned by the React hook, mirrored here for the
  // MidiInput callback to see.
  arm(target) { this._armed = target; this._fire(); }
  cancelArm() { this._armed = null; this._fire(); }
  _consumeArm(channel, cc) {
    if (!this._armed) return false;
    this.bind(this._armed, channel, cc);
    this._armed = null;
    return true;
  }

  toJSON() { /* serializable shape for localStorage */ }
  fromJSON(obj) { /* validate + restore */ }
  onChange(fn) { /* pub/sub */ }
}
```

`MidiInput._handleMessage` grows a CC branch:

```js
} else if (command === CC) {
  const channel = (data[0] & 0x0f) + 1;   // 1..16
  this._notifyCcActivity(channel, note, value); // for the lower dot

  // Existing sustain branch stays.
  if (note === CC_SUSTAIN) {
    keyboardVoiceManager.setSustainPedal(value >= 64);
    return;
  }

  // Learn mode steals the CC before it can route to a binding.
  if (midiCCMap._consumeArm(channel, note)) return;

  // Otherwise dispatch to any binding.
  midiCCMap.handleCc(channel, note, value);
}
```

The upper-dot (note activity) flash is fired from the existing NOTE_ON
branch via the same listener bus.

---

## 5. Persistence

`localStorage` key: `midiMappings.v1`. Shape:

```json
{
  "version": 1,
  "savedAt": "2026-05-23T20:14:00.000Z",
  "mappings": [
    { "channel": 1, "cc": 7,  "target": { "kind": "drone-volume", "slot": 0 } },
    { "channel": 1, "cc": 8,  "target": { "kind": "drone-volume", "slot": 1 } }
  ]
}
```

Behavior:

- **Save button** writes the current `midiCCMap.toJSON()` to the key.
- **Load on app start** — `MidiCCMap.fromJSON(JSON.parse(localStorage…))`
  is called once at module load (similar to how envelope/wave values
  are pushed before `AudioEngine.initialize`). Restored mappings take
  effect as soon as the engine is initialized; CC messages that arrive
  before init are dropped (existing `_enabled` gate).
- **Per-row × button** unbinds just that mapping in memory; the user
  has to hit Save to persist the removal. Saved table is the snapshot,
  not a live mirror — matches how the share URL works.
- **Clear all** button next to Save (small `×` icon) — wipes both
  memory and `localStorage` after a confirm.

URL params (`?cc=…`) are **out of scope for v1**. The share URL is
already at the edge of what's readable; CC mappings are personal to
each user's controller and don't belong in a shared link.

---

## 6. Edge cases & questions

1. **Slot deletion / oscillator-count changes.** Mappings are bound
   to the **slot index** (`D1`, `D2`, …), not to the underlying voice
   identity. Slots are always rendered sequentially, so this gives
   stable, predictable semantics: CC 7 → D1 always means "the first
   drone", regardless of what's been added or removed. If the user
   deletes D2, the drone formerly at D3 is now D2 and inherits D2's
   CC mapping. This is by design — surprising at first read, but
   consistent and easy to reason about ("CC 7 is the leftmost knob,
   period").

   When the count shrinks below a mapped slot's index, the binding is
   simply *inactive* (the target doesn't exist), but it's **kept** in
   the table so re-growing the count restores it. The panel renders
   such rows greyed-out with an "—" instead of a value bar.

2. **Re-binding a CC to a different target.** Allowed and additive —
   the new target joins the CC's fan-out set; previously-bound targets
   stay bound (see §4.1). To remove a target from a CC, click the
   row's `×`.

3. **Re-binding a target to a different CC.** Replaces the target's
   CC. The previous CC stays in the table if other targets still
   reference it; otherwise it's dropped (§4.1's `unbind` cleanup).

4. **MIDI input disabled.** The existing `midiInput.enabled` gate (top
   of `_handleMessage`) silences CC dispatch too — consistent with the
   note path. The mapping table survives across enable/disable; the
   panel's value bars just stop animating.

5. **Mute interaction.** A muted drone is **not** targetable in learn
   mode (only "un-muted" voices appear, per the original request). An
   already-bound mapping to a slot that is later muted is left intact
   — CC still writes to `audioEngine.setVolume(slot, …)`, the slot
   just isn't audible until unmuted. This keeps mute as a pure audio
   gate without entangling it with the mapping table.

6. **Partials.** Out of scope for v1. The `target.kind` field is the
   extension point; `partial-volume` with `{ slot, partialIndex }`
   slots in cleanly when v2 lands.

7. **Channel 0 vs. 1.** Channels are stored 1-indexed in the data
   model (matches what's displayed) but extracted from the status byte
   as 0-indexed inside `MidiInput`. The conversion happens at the
   single boundary in `_handleMessage`.

---

## 7. Implementation order

Roughly self-contained slices, each independently shippable:

1. **CC plumbing** — extend `MidiInput._handleMessage` with the CC
   branch, add `MidiCCMap` singleton, wire the lower-dot activity
   callback. No UI yet. Verifiable via console logs.
2. **Top-right button + dots** — add `.midi-toggle` with both
   activity dots and the open/close state for the MIDI panel.
3. **MIDI panel chassis + empty state** — render above the mixer
   in `.right-stack` when open.
4. **Learn flow** — phases A/B/C, mixer's `.midi-targetable`
   class, escape-to-cancel.
5. **Mapping rows + live value bars** — driven by `midiCCMap.onChange`.
6. **Save / clear all / per-row clear** — `localStorage` round-trip
   and the restore-on-boot path.
7. **Polish** — out-of-range badge, throttled dot flashes, restore
   safety against malformed JSON.

Each slice keeps the existing audio path untouched until step 4
actually starts writing values into `audioEngine.setVolume`.

---

## 8. Files touched

- `src/audio/MidiInput.js` — add CC branch, activity callbacks.
- `src/audio/MidiCCMap.js` — **new** singleton.
- `src/App.jsx` — mount `.midi-toggle` button, render `<MidiPanel>` in
  `.right-stack` above `<Mixer>`, manage `isMidiPanelOpen` + learn state.
- `src/components/MidiPanel.jsx` — **new** component.
- `src/components/Mixer.jsx` — read learn-mode flag from a context or
  prop, add `.midi-targetable` class + click handler on drone rows.
- `src/App.css` — `.midi-toggle`, `.midi-dot`, `.midi-panel`, learn-mode
  affordances on `.mixer-row-drone`.

No engine changes — `audioEngine.setVolume` is already the canonical
write path and CC just calls into it like any other UI action.
