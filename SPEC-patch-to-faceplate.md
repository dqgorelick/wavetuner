# SPEC — patch → faceplate (the bridge)

*2026-08-14. Connects `PLAN-parametric-lab-v2.md` §1 (the patch layer) to
the real patch schema in `wavetuner-native/ios/SPEC-song-save-and-morph.md`.
Design only.*

---

## 0. The finding

v2 §1 proposes a patch layer above the manifest and sketches it as a
five-field object authored by hand:

```js
{ engine, waves, voices, noise, arp }
```

**That object already exists, for real, and as of 2026-08-14 it is
complete.** `wavetuner.patch.v1` carries every fact those gates want, in
more detail and — critically — *measured from a song that actually
sounds a particular way* rather than asserted about one.

Five of the catalog rows v2 wants to gate (`drift`, `slide`, `mutes`, the
motion family, `room`) map onto patch fields that **did not exist until
the save-completeness pass landed today**. The two threads are not
adjacent; the save work is the precondition for the patch layer.

So the bridge is one pure function in each direction:

```
song.patch  ──gatesFromPatch()──▶  gates  ──requires()──▶  manifest  ──▶  faceplate
song.ui     ◀──────────────────────────────────  manifestSeed · genomeSeed · pins
```

## 1. Three corrections to v2 §1's gate object

Written against the real schema, the sketch is wrong in three places —
each in a way that makes the model *simpler*, not harder.

### 1.1 ⛔ `engine: 'classic' | 'granular'` — not an enum

The app has no engine switch. Grains is an **additional source** layered
on the same voices, not an alternative to them: `snapshot.grains.isOn`
and the drone bus are independent, and "cello grains" is a patch where
grains are up and the waves are down. An enum cannot express a song that
is half of each, and that song is one slider away at all times.

Replace with four independent booleans, each *measured*:

```js
sources: {
  waves:   drone bus audible  && at least one voice unmuted,
  grains:  grains.isOn        && grains.masterGain > 0,
  noise:   !pinkNoise.muted   && pinkNoise.level > 0,
  ambient: ambient.sampleId != null,
}
```

v2's payoff survives intact — `engine==='classic'` becomes
`sources.waves`, and "not on cello grains" becomes `!sources.waves`,
which is *truer*: it now also covers a patch that muted its waves for
some other reason.

### 1.2 ⛔ `waves: ['sine','tri','saw','square']` — there is no wave set

The app has a continuous morph, `wave.dronePosition` in `0…3`
(sine · triangle · square · saw). "A square-only synth" is not a list —
it's the number `2`, plus an authorial intention not to move.

This splits v2's single rule into one derivable half and one that isn't:

* **`width` is derivable, and better than v2's version.** Pulse-width
  warp is only audible near square, so
  `requires: |p| abs(p.wave.dronePosition - 2) < 0.15`. v2 got the right
  answer ("width only on a square-only synth") from a hand-authored list;
  the real field gives the same answer from the sound itself, and also
  correctly *denies* width to a patch sitting at 2.4.
* **`shape` is NOT derivable.** Whether a song wants a morph knob is a
  decision about the song, not a fact about its state — a patch parked
  at sine looks identical whether shape is its whole point or irrelevant.
  This is the one genuine authorial field; see §3.

### 1.3 ⚠️ `voices: 4` — use `oscillatorCount`, never `frequencies.length`

A real exported patch (`device-backups/2026-07-17-iphone17pro/patches/…`):

```
oscillatorCount: 4      frequencies: [22.3, 56.5, 45.0, 22.4, 306.1, … ]   // 12 entries
```

`frequencies` is `maxOscillators` long and the tail is stale. Every
per-voice primitive (`pitch`, `levels`, `pans`, `mutes`) must slice to
`oscillatorCount` or the plate draws twelve lanes for a four-voice song.

⚠️ Same file has only 13 snapshot keys — no `filter`, `saturation`,
`pinkNoise`, `reverbSends`. **The projection must treat every block as
absent-able.** A missing block means "this song never touched it", which
for gating purposes reads as *off*, not as *default*.

## 2. The projection table

Every v2 catalog row against the field it reads. This is the bridge's
actual content.

| row | patch field | status |
|---|---|---|
| `pitch` | `frequencies[0..<oscillatorCount]` | ✅ |
| `levels` | `snapshot.volumes` | ✅ |
| `pans` | `snapshot.pan` | ✅ |
| `mutes` | `snapshot.muted` | ✅ |
| `shape` | `snapshot.wave.dronePosition` | ⚠️ authorial (§1.2) |
| `width` | `snapshot.wave.droneWidth` + gate on `dronePosition≈2` | ✅ |
| `fold` | `snapshot.fold.droneAmount` / `.droneType` | ✅ |
| `waveLevel` | `snapshot.groupVolume` × `mixer.droneBusGain` | ✅ |
| `noise` | `snapshot.pinkNoise.level` / `.muted` | ✅ |
| `saturation` | `snapshot.saturation.amount` | ✅ |
| `lpf` / `lpfPeak` | `snapshot.filter.highCutHz` / `.resHigh` | ✅ |
| `hpf` / `hpfPeak` | `snapshot.filter.lowCutHz` / `.resLow` | ✅ |
| `reverb` | `snapshot.reverbSends.synthMix` (× `.master`) | ✅ |
| `detune` | `snapshot.stereo.drone.detuneHz` + `.detuneCurve` | ✅ |
| `drift` | `snapshot.driftHz` | 🆕 **landed today** |
| `slide` | `snapshot.motion.orbViscosity` (catalog says "the viscosity chase") | 🆕 **landed today** |
| `autoCycle` | `SongProgram.dwellSecondsDefault` | ✅ |
| `remix` | dice — `SongProgram.rules` | ✅ |
| `tune` | `SongProgram.systemKey` + `anchorSlot` | ✅ |
| `auto` | program arms (`SongKind`) | ✅ |
| `room` | `snapshot.room` (`RoomPatch`) | 🆕 **landed today** |
| `arpOn/Bpm/Oct/Dir` | — | 🔴 **absent** (§4) |
| `satButton` | `snapshot.saturation.style` | ⚠️ 3 vs 5 (§2.1) |
| `filter` / `resonance` | — | lab-only abstraction |
| `satViz` | `saturationInViz` (UserDefaults) | ⚠️ look, not patch |
| `orbs` | chrome | n/a |

### 2.1 Two mismatches worth knowing

* **`satButton` is `soft · warm · hot`; `SaturationStyle` is
  `tape · smooth · crunch · fuzz · hard`.** Five real circuits, three lab
  chips. v2 cuts `satButton` anyway, so this only matters if it comes
  back — and if it does, the segment should quote the real five.
* **⛔ `room` is not a second reverb knob.** v2's cut list says "a second
  reverb knob no song carries; fold into `reverb`". In the app they are
  genuinely different: `reverbSends` is *how much of this song goes to
  the room*, `RoomPatch` is *what the room is* — shared with the mic, and
  the reason `SPEC-song-save-and-morph.md` §3 pulled it into the patch.
  Folding them **on the plate** is right (one knob, one gesture). Folding
  them **in the data** would be a bug.

## 3. What the patch cannot answer

Three of v2's inputs are authorial and no amount of schema fixes that:

1. **`shape`** — does this song want a morph knob? (§1.2)
2. **`pins`** — art direction (manifest §2b).
3. **hand-authored `controls: [...]`** — locking a plate you like (v2 §6).

They belong to the **song**, next to `kind` / `program` / `look`, not to
the patch. Which gives the second direction of the bridge a home.

## 4. 🔴 Arp blocks the arp family

`arp: false` is the one gate with nothing behind it. The arp
(`Audio/Arpeggiator.swift` — division, pattern, octaves, gate, swing,
level, accent, bedDuck) is **not captured in any patch**: it was gap G5
in the save audit and was deliberately deferred, because it is a second
ContentView `@StateObject` island with the same attach problem grains
had.

Consequence: **four catalog rows (`arpOn`, `arpBpm`, `arpOct`, `arpDir`)
cannot be gated, drawn truthfully, or shipped** until `ArpPatch` lands.
The grains bridge (`attachGranular` + pending snapshot + deferred
on-intent) is the proven template and the arp copy is small. This is now
the strongest argument for un-deferring it — it isn't one missing knob,
it's a whole family of the catalog.

## 5. Direction B — the plate ships back

A faceplate rated in the lab has to become the app's actual surface.
That is a third field on `Song`, and it is a **third category**: not
sound (`patch`), not lens (`look`), but *control surface*.

```swift
struct SongUI: Codable, Equatable {
    var manifestSeed: Int?      // which controls got drawn — with the patch, this IS the song's identity
    var genomeSeed: Int?        // how they're laid out and styled
    var controls: [String]?     // hand-authored override (v2 §6), nil = draw from the seed
    var pins: [String: Double]? // art direction (manifest §2b)
    var wantsShape: Bool?       // the one authorial gate (§1.2 / §3)
}
```

Same conventions as everything else in that schema: optional, lenient
decode, `nil` ⇒ fall back to the draw. It costs ~40 bytes per song and it
means a plate is reproducible from two integers.

**Two seeds, two consequences** (v2 §6): `manifestSeed` travels with the
patch as the song's identity, so a song that changes its *sound* keeps
its *plate*; `genomeSeed` is re-rollable, so "I like these controls, show
me another arrangement" is a one-field write.

## 6. Rules

**⛔ Draw the plate from `song.patch`, never from the live engine.**
A song's settings are a load-time default that the user then edits
(`SPEC-song-save-and-morph.md` §7.2). If the gates read live state, the
plate would re-draw itself *as you turn its knobs* — turn the noise down
to zero and the noise knob vanishes under your finger. The gates read the
saved document; the controls drive the live engine.

**⛔ The plate is a discrete switch in a morph.** When song-switching
cross-fades (§8 of the save spec), continuous params lerp but the control
surface cannot — half a knob is not a knob. It flips at `t = 0`, with the
song title, for the same reason: the user pressed a thing and the surface
should answer immediately even though the sound takes three seconds.

**⚠️ Re-tap doesn't redraw.** Re-tapping the current song restores its
settings and advances (§7.4). Since the plate is drawn from the saved
patch and the saved patch didn't change, the plate must not flicker.

## 7. What this needs from the save thread

The bridge is gated on two phases already in
`SPEC-song-save-and-morph.md` §11:

| needs | why |
|---|---|
| **P0/P2 — the look** | `satViz` is a look field, and the faceplate and the look are the same *kind* of problem: state scattered across UserDefaults with no capture seam. `Models/Look.swift` is the pattern `SongUI` copies. **Also the fix for "visual settings aren't saved between songs".** |
| **arp (G5)** | §4 — four catalog rows |

Everything else the projection table needs is in the schema as of today.

## 8. Build order

| | | |
|---|---|---|
| B1 | `gatesFromPatch(patch)` in the lab — pure JS, reads real exported patch JSON, absent-block tolerant | small |
| B2 | Rewrite the catalog's `requires` against real fields (§2), drop the `engine` enum for `sources` | v2 P1 |
| B3 | Load real patches into the lab — `device-backups/**/patches/*.json` + `BuiltinPatches` — so song-mode batches (v2 §6) draw from the actual catalog | small |
| B4 | `ArpPatch` on the grains-bridge template → unblocks the arp family | small |
| B5 | `Song.ui` (`SongUI`) + capture/apply, after `Models/Look.swift` sets the pattern | small |
| B6 | Port `gatesFromPatch` to Swift so the app draws the same plate the lab rated | medium |

⚠️ **B1 and B6 must stay one algorithm.** Two implementations of the gate
rules is how the lab starts rating plates the app will never render. Keep
the thresholds (`0.15` for square, `> 0` for audible) in one table, and
port that table rather than the code.

## 9. Open

1. **§1.2** — is `wantsShape` really the only authorial gate, or does
   `fold` want one too? (A patch at `fold 0` may still want the knob.)
   The general form of this question is "does an at-rest parameter want
   its control?", and it may deserve one mechanism rather than N flags.
2. **§5** — does `SongUI` live on `Song`, or inside `SongLook`? Separate
   reads cleaner (a plate is not a lens) but adds a fourth top-level
   field to every song.
3. **§2.1** — if `satButton` returns, does it quote the real five
   circuits, or keep three chips that lie?
4. **§6** — the plate is drawn from the saved patch. What happens to a
   *user* song saved mid-tweak — does capture re-draw the manifest from
   the new patch, or keep the plate the user has been looking at?
