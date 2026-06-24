# MIDI MPE Output — drones → external synth (Vital)

This is the implementation + setup notes for the MPE output feature. The
app can drive a software synth (target: **Vital**) so the web page is the
**frequency controller** and the VST is the sound source. Each drone is a
sustained voice that pitch-bends continuously across a wide frequency
range without retriggering.

Code: `src/audio/MidiOutput.js` (singleton), UI in
`src/components/SettingsPanel.jsx` ("MIDI out (MPE)" section), wired in
`src/App.jsx` (connects on Start) and `src/main.jsx` (`window.midiOut`).

---

## How it works

MIDI never sends a frequency — it sends a note number (0–127) the synth
maps to a pitch, plus a 14-bit **pitch bend** (0–16383, center 8192) as a
continuous offset. So `note + bend` together express any frequency.

In plain MIDI, pitch bend is per-channel and bends *every* note on that
channel. **MPE** solves this by putting **one note per channel**, giving
each voice its own private bend. That's the whole mechanism.

- MPE lower zone: channel 1 (index 0) is the master/global channel;
  channels 2–16 (indices 1–15) are member channels — one voice each.
- We have at most 12 drones, so drone slot `i` → member channel `i + 1`
  (MIDI channels 2–13).

### Per-voice mapping

| Drone property | MPE message |
|---|---|
| frequency (Hz) | note number (anchor) + **pitch bend** |
| volume slider | **channel pressure** (the MPE "Z" dimension), 0–127 |
| mute / unmute | **Note Off** / **Note On** |
| Note On velocity | constant `100` (drones have no velocity source) |

Drones have no "velocity" the way a key press does — they're sustained
oscillators. So Note On uses a constant velocity, and the volume slider
drives continuous expression via channel pressure. In the synth, map the
**Pressure** modulation source to amplitude/level to hear the volume
follow.

### Anchor strategy (dynamic nearest-note)

When a voice starts, its note number is the integer MIDI note **closest
to the drone's current Hz**, so the bend starts near center. The bend
range is **±48 semitones** (Vital's fixed MPE value), giving ~8 octaves
of click-free sweep around wherever the voice started.

While a voice is held, frequency changes move **only the pitch bend** —
never the note number — so there's no retrigger / envelope click. If a
single held sweep ever exceeds ±48 semitones, the voice re-anchors with a
brief Note Off / Note On (rare for drone-style use).

#### Frequency math

```js
freqToMidi(f)        = 69 + 12 * log2(f / 440)
anchorNote           = round(freqToMidi(f))            // at note-on
bendValue(f, anchor) = 8192 + round((freqToMidi(f) - anchor) / 48 * 8192)
volToPressure(v)     = round(clamp(v, 0, 1) * 127)
```

- Resolution: ±48 st over 8192 steps ≈ **0.59 cents/step** — far below
  audible pitch discrimination.
- Range per held note: ±48 st = ±4 octaves around the anchor. Because the
  anchor is chosen at the *current* pitch, the reachable range is
  effectively the whole audio band, sweepable 8 octaves at a time.

> For reference, a **fixed** anchor of MIDI note 55 (G3 ≈ 196 Hz) would
> cover 196 ÷ 16 ≈ **12.25 Hz** to 196 × 16 ≈ **3,136 Hz** in one held
> note with no retrigger ever. We use dynamic anchoring instead so there's
> no high-frequency ceiling.

### Transport + sync

MPE is ordinary MIDI sent with one-note-per-channel discipline — no
special mode. `MidiOutput` reads drone state straight from `AudioEngine`
and runs its own `requestAnimationFrame` poll loop **only while enabled**,
diffing frequency / volume / mute / count each frame and emitting the
minimal set of messages. A static drone is silent on the wire; a glide
comes across as a smooth stream of pitch-bend updates.

It does **not** send any MPE Configuration Message (MCM) or pitch-bend-
range RPN by default — just raw Note On/Off, pitch bend, and channel
pressure. The MPE standard already defaults member channels to ±48, which
is what we scale to. **Do not enable the RPN config for Vital:** Vital is
fixed at ±48 and *stops applying pitch bend entirely* when it receives
those RPN messages (it then needs a plugin reload to recover —
[forum.vital.audio](https://forum.vital.audio/t/pitch-bend-range-in-mpe-mode/5225)).
The RPN config is available as an opt-in (`midiOut.setSendZoneConfig(true)`
or the Settings checkbox) only for a synth that genuinely requires it.

---

## Setup

### 1. Create a virtual MIDI port

The browser sends to a virtual port; the synth listens on the other end.

- **macOS** — open **Audio MIDI Setup** → Window → *Show MIDI Studio* →
  double-click **IAC Driver** → check *Device is online*. The default
  "Bus 1" port is enough.
- **Windows** — install **loopMIDI** (Tobias Erichsen) and create a port.

### 2. Run the synth on that port

Prefer **Vital standalone** listening directly on the virtual port. A DAW
in the middle (Bitwig, Ableton, etc.) may re-interpret MPE into its own
per-note expressions; standalone keeps the raw channel-per-voice messages
intact. In Vital's audio/MIDI settings, select the IAC / loopMIDI port as
the MIDI input.

### 3. Enable MPE in Vital

- Vital menu → enable **MPE**.
- **Known bug:** after loading a project, MPE often must be toggled
  **off then on** for pitch bend to register. If bends do nothing on
  first load, this is almost always why.
- Map the **Pressure** modulation source to a destination (e.g. master
  level or a filter) if you want the drone volume slider to do something
  audible — pressure isn't routed to anything by default.

### 4. Enable output in the app

- Click **Start** (the audio gesture also requests Web MIDI access).
- Open **Settings** → **MIDI out (MPE)** → toggle **on**, and pick the
  IAC / loopMIDI port from the dropdown.
- Un-muted drones should now sound in Vital and track the frequency
  sliders. Muting a drone releases its note.

### Running inside a DAW (Ableton Live 11+) — confirmed recipe

You don't have to use standalone. In **Ableton Live 11 or newer** (Live 10
and earlier have no MPE — use standalone there):

1. **Preferences → Link, Tempo & MIDI**, find the **IAC Driver input** row,
   turn **Track** on, and turn on its **MPE Mode** toggle. This is the step
   that makes Live spread the 15 channels to per-note voices instead of
   collapsing them to one global channel.
2. On the **MIDI track hosting Vital**: **MIDI From → IAC Driver** (routing
   locks to "All Channels" once MPE Mode is on), arm / Monitor = In.
3. In **Vital**: set the **pitch-bend range to 48** (Vital's own MPE toggle
   is *optional* here — Ableton already does the MPE channel distribution).

Without step 1's MPE Mode toggle, every drone bends every voice (global
pitch bend) — that's the tell that the DAW is merging channels.

### Console testing

After clicking Start:

```js
midiOut.status          // 'connected'
midiOut.devices         // [{ id, name, ... }]
midiOut.setEnabled(true)
midiOut.setBendRange(48) // match the synth's bend range
window.__midiOutDebug = true   // log every message as you move a drone
```

---

## Pitch-bend range: the ±2 vs ±48 convention

MPE splits the bend range by channel role
([MPE spec](https://d30pueezughrda.cloudfront.net/campaigns/mpe/mpespec.pdf),
[midi.org](https://midi.org/community/midi-specifications/how-midi-mpe-pitch-bend-works)):

- **Master channel (ch 1): ±2 semitones** — for global/zone-wide bend.
- **Member channels (ch 2–16): ±48 semitones** — the wide per-note range.

A receiver adopts those defaults **when it receives an MPE Configuration
Message (MCM)**, or when its own MPE mode is switched on. Without that, a
channel uses the ordinary MIDI default of **±2**. Either range can be set
explicitly with **RPN 0** (pitch-bend sensitivity) sent per channel.

We send notes/bends on **member channels** and scale to ±48. So the synth
*must* be treating those channels as ±48 — which means **MPE must be truly
active on the synth**, not just nominally enabled. If the synth applies our
bends over ±2, every move comes out **24× too small** (a −6.7-semitone move
reads as ≈ −0.28 st). That's the signature to watch for.

Vital specifically: a healthy MPE-enabled Vital uses ±48 automatically (no
MCM needed). But sending it the MCM/RPN **corrupts** its bend handling so
it reverts to ±2-like behavior, and that state **survives an MPE off/on
toggle — only a full plugin reload clears it.** Hence we never send the MCM,
and the opt-in zone config sends only plain RPN 0 (no MCM).

## Troubleshooting

### Pitch moves, but ~24× too little (e.g. 311→211 Hz only nudges Vital to 305 Hz)

The synth is applying our member-channel bend over **±2** instead of ±48
(see the convention above). For Vital this almost always means it's still
in the corrupted state from a past MCM/RPN:

1. **Fully reload the Vital instance** — close and reopen the plugin (or
   quit/relaunch standalone). Toggling MPE off/on is *not* enough.
2. Enable **MPE** in the reloaded instance.
3. Keep the app at **bend range ±48** and **"Send MPE zone config" OFF**.
4. Verify with `midiOut.testBend(12)` — you should hear a full **octave**
   slide up and down. (If it only wiggles a fraction of a semitone, the
   synth is still on ±2.)

For a **non-Vital** synth that genuinely defaults member channels to ±2,
either set its bend range to 48 in its own UI, or enable **"Send MPE zone
config"** in the app (sends RPN 0 = ±48 to member channels, ±2 to master —
no MCM).

### Vital snaps to the nearest semitone and ignores pitch bend entirely

This is the **RPN-config-breaks-Vital** bug. Vital is fixed at ±48 in MPE
mode, but if it receives MPE-spec pitch-bend-range RPN messages it stops
applying *all* pitch bend (note numbers still play, so it sounds locked to
equal-tempered pitches). See
[forum.vital.audio](https://forum.vital.audio/t/pitch-bend-range-in-mpe-mode/5225).

Fix:
1. Make sure **"Send MPE zone config (RPN)" is OFF** in Settings → MIDI out
   (it's off by default; `midiOut.sendZoneConfig` should be `false`).
2. **Reload the Vital instance** (close/reopen the plugin or standalone) to
   clear the broken pitch-bend state earlier RPN messages already put it
   in — toggling MPE alone won't recover it.
3. Move a drone — pitch should now track continuously.

Confirm Vital responds to bend at all with `midiOut.testBend(24)`: you
should hear a ±24-semitone (2-octave) slide. A full-range probe is
`midiOut.testBend(48)`.

### First pitch is right, but moving a drone doesn't change the pitch

This is a **bend-range mismatch** (or MPE isn't active in the synth).

- At note-on we send the *nearest note number*, so the initial pitch is
  correct within a semitone even if the bend is barely applied.
- Every change after that is sent as **pitch bend only**, scaled to the
  configured range (default ±48). If the synth is actually using ±2
  (its non-MPE default), a bend meant to move 5 semitones moves only
  `5 × 2/48 ≈ 0.2` semitones — pitch looks frozen.

Fixes, in order:
1. **Enable MPE in the synth.** In Vital, that switches it to ±48 and
   matches our default. If bends still don't register, **toggle MPE off
   then on** (Vital's known after-load bug).
2. If the synth can't do MPE / uses a different range, set
   **Settings → MIDI out → Synth bend range** (or `midiOut.setBendRange(n)`)
   to whatever the synth uses. Note: with a small range the click-free
   sweep window shrinks to ±n semitones, so large frequency jumps will
   re-anchor (a brief retrigger).
3. Confirm the **browser side** is emitting continuous bends: set
   `window.__midiOutDebug = true` and watch the console while you move a
   drone — you should see a stream of `bend ch… → …` lines. If you do,
   the web app is working and the problem is synth-side.

---

## Constraints

- **HTTPS or localhost required** (Web MIDI). `file://` does not count.
- **Works in:** Chrome, Edge, Opera, Firefox (Firefox prompts to install
  a Site Permission Add-On on first access).
- **Does NOT work in Safari or any iOS browser** (all iOS browsers use
  WebKit and inherit the block). A native app would be required there.
- Output is **off by default** and the choice is remembered across
  reloads (`localStorage`: `midiOutEnabled`, `midiOutPort`).

## Notes / possible follow-ups

- The output mirrors the drone *configuration* (per-slot frequency,
  volume, mute, count). Global drone pause (spacebar) affects local audio
  only — it does not release MPE notes. Could be wired in if desired.
- Stereo-mode drone detune (two oscillators per slot) is collapsed to the
  nominal center frequency for MPE — one note per slot can't represent
  the L/R beat.
- Volume currently maps to channel pressure only. If a target VST ignores
  pressure, adding CC11 (Expression) alongside it is a one-line change in
  `_sync()`.
