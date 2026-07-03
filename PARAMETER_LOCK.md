# Parameter Lock — implementation contract

Status: **BUILT** (2026-07-02). Engine + UI implemented in one pass. This document
records the design; see the sections below for what shipped. The two-scope +
timing layout was prototyped and approved as the param-lock-v2 artifact.

Shipped surface: `AudioEngine.setVolume` now notifies; `FrequencyManager` gained
scoped snapshots (volume + mute), the recall/undo scope state + API, scoped
recall/undo with skip-no-op; the tunings-menu `ScopePanel`; marker gating on
`recallScope.freq`; and inert I–IV slots on empty recall scope.

---

## 1. Concept

- **Capture is lossless.** `saveCurrent` always snapshots frequency **+ volume +
  on/off**, regardless of scope. Scope never limits what is *stored*.
- **Scope is a live recall mask.** ONE shared parameter set ("Parameters
  tracked") over `{frequency, volume, onoff}` governs both what recall applies
  and what undo/redo records — `recallScope` and `undoScope` are kept in lockstep
  via `toggleParam` (the engine keeps both fields for flexibility, but the UI
  exposes a single set; there is no per-scope split or link toggle).
- **Two independent timings.** `recallGlideMs` (Capture) and `undoGlideMs`
  (Undo/Redo) are set separately. `0 = snap`. Default frequency-only reproduces
  today's behavior.

Mental model: **the four saved slots are lossless photographs** (store everything,
re-view through any scope later). **Undo is a live action-log** of the dimension
you're currently performing. That asymmetry is intentional.

---

## 2. Snapshot (`_takeSnapshot`, FrequencyManager.js)

Grow the snapshot to always carry the full state:

```
{
  frequencies,   // existing — audioEngine.getAllFrequencies()
  volumes,       // NEW — per-voice getVolume()
  mutes,         // NEW — per-voice `muted` flag
  slotRatios, anchorSlot, tuningSystem   // existing
}
```

Capture is always full; scope is applied only at recall/undo time, never here.

---

## 3. New manager state (persisted + `_fire()` on change)

```
_recallScope : Set<'freq'|'vol'|'onoff'>   // default {'freq'}
_undoScope   : Set<'freq'|'vol'|'onoff'>   // default {'freq'}
_scopeLinked : boolean                     // default true
_recallGlideMs : number                    // EXISTS today
_undoGlideMs   : number                    // NEW; mirrors recall when linked
```

When `_scopeLinked`: writes to `_recallScope`/`_recallGlideMs` also set
`_undoScope`/`_undoGlideMs`. Toggling a param on the undo side while linked should
either be disabled in the UI or auto-unlink — UI's call; engine just needs the
setters below to be authoritative.

### API surface (UI consumes these)

```
getRecallScope() : string[]
getUndoScope()   : string[]
toggleRecallParam(key) : void
toggleUndoParam(key)   : void
isScopeLinked()  : boolean
setScopeLinked(bool) : void
recallGlideMs / setRecallGlideMs(ms)   // exist
undoGlideMs   / setUndoGlideMs(ms)     // new
```

Every setter fires `onChange` and persists.

---

## 4. Capture (`saveCurrent`) — unchanged signature

Already `saveCurrent({ name })`. No scope argument. Now snapshots the full state
(§2). The shipped capture button and I–IV slots need no change.

---

## 5. Recall (`stageSlot` / `launchAll` / `_applySnapshotSmooth`)

`_applySnapshotSmooth(snap, scope, timingMs)`:

- **frequency** — glide over `timingMs` (today's behavior) **iff** `'freq' ∈ scope`.
- **volume** — glide the level over `timingMs` (silent, no marker) **iff** `'vol' ∈ scope`.
- **on/off** — fade the voice gain over `timingMs` (`0 = instant`) **iff** `'onoff' ∈ scope`.
- Out-of-scope params are left untouched.

Save recall passes `(_recallScope, _recallGlideMs)`.
`stageSlot`/`launchAll` apply only `_recallScope`; **empty `_recallScope` → no-op.**

---

## 6. Undo / redo — **record only in-scope changes, restore only in-scope, skip no-op steps**

This is the approved model (not record-everything-and-filter — that produces dead
undo presses).

- **Recording:** `_captureSnapshot` / `_snapshotsEqual` decide "did something
  change" using **only `_undoScope` params** (compare freq only if `'freq' ∈
  undoScope`, volumes if `'vol'`, mutes if `'onoff'`). No in-scope change → no push.
  Store the **full** snapshot in the entry regardless (cheap, keeps data intact).
  Debounced via the existing `SNAPSHOT_DEBOUNCE_MS` so a flurry coalesces to one step.
- **Trigger:** `_scheduleSnapshot` must now also fire on **volume and mute
  changes**, not just frequency. (Engine must notify the manager on those edits.)
- **Applying:** `undo()`/`redo()` restore via `_applySnapshotSmooth(target,
  _undoScope, _undoGlideMs)` — only in-scope params move.
- **Skip no-op steps:** when undoing/redoing, skip any entry whose in-scope params
  already equal the current in-scope state; glide to the first entry that actually
  differs. Guarantees every press produces a visible change even if the scope was
  switched mid-session.
- Changing the scope selection itself is **not** an undoable action.

With the default scope `{'freq'}`, this reproduces exactly today's undo behavior.

---

## 7. UI responsibilities (UI agent — build once §3 lands)

- **Tunings-menu scope panel:** two cards (Captures / Undo-Redo), each with
  `Frequency / Volume / On-Off` chips + one timing slider (mixer-fader styled,
  matching `.freq-rail-glide-slider`), plus the "same as captures" link pill. The
  existing single glide slider becomes the Captures "recall timing" slider.
- **Gate the spectrum markers** (triangles + dots in `FrequencySpectrumBar.jsx`)
  on `getRecallScope().includes('freq')` — hidden when frequency isn't in scope.
- **CaptureBar I–IV inert** (dashed, non-performing) when `getRecallScope()` is empty.

---

## 8. Deferred (NOT in v1)

- **Pan.** Drone pan is structural, not a rampable scalar — see §9. Revisit later;
  the cheapest future path is instant-snap of the routing map (like on/off), not a glide.
- **Per-scope easing curve.** Keep the single existing recall curve for both
  timings for now.

---

## 9. Pan investigation summary (why it's deferred)

Two separate audio paths implement "pan" differently:

- **Drone voices (the save-state path) — HARD.** Pan is *discrete channel routing*,
  not a `-1..1` scalar: each voice's gain connects to L / R / both via a
  `ChannelMerger` (`routingMap`), and the global `lr`↔`stereo` mode swaps node
  topology (stereo = dual-oscillator pair, no pan value). Nothing to ramp. A real
  glide means inserting per-voice `StereoPannerNode`s or equal-power channel-gain
  crossfades and reworking the topology swap.
  Refs: `AudioEngine.js` init `:512-528`, `_connectDroneToChannels` `:1394-1431`,
  routing API `setVoiceRouting`/`getRoutingMap` `:2115-2177`, click-free swap
  `_clickFreeDroneRouteSwap` `:1446-1506`.
- **Keyboard / MIDI voices in `lr` mode — EASY** (but not the save-state path): a
  continuous `panner.pan` AudioParam already exists and is already glided via
  `setTargetAtTime` (`KeyboardVoiceManager.js` `_repanAllVoices` `:270-293`,
  `PAN_RAMP_TAU` `:46`).
- **Any voice while its pool is in `stereo` mode — blocked:** dual-osc + merger has
  `panner: null`, no single pan position to interpolate.

Glide pattern to mirror if pan is ever added: `glideToFrequencies`
(`AudioEngine.js:2617-2663`) — an rAF per-frame tween; `glideVolumes` (`:2696`)
is the linear-space sibling.
