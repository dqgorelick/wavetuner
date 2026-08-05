# iPad Music Ecosystem — How WaveTuner Could Participate

Research doc, written 2026-08-04. Nothing here is implemented; this is the map for deciding
*whether* and *where* to plug WaveTuner into the inter-app audio/MIDI world on iPad.
Companion reading: `../../wavetuner-native/ios/README-PORT.md` (architecture + parity),
`midi-mpe-output.md` (the MPE-out design we already shipped), `03-ios-audio.md` (original
iOS audio survey).

---

## 1. The ecosystem in layers

There are two eras of inter-app plumbing on iOS. The old era (Audiobus, Inter-App Audio)
is dead or dying; the modern ecosystem stands on three pillars — **AUv3** for audio
plugins, **Core MIDI** for note/control routing, **Ableton Link** for tempo sync — plus
**IDAM** as the iPad↔Mac bridge.

### AUv3 — Audio Unit v3 extensions (the "plugin inside another app" mechanism)

When people say an iPad app is a *module* in someone else's rig, they mean AUv3. An AUv3
is an **app extension**: a second binary shipped inside the app, run in a **separate
process** and hosted by another app. The host:

- instantiates the plugin (possibly **many instances at once**),
- **pulls** audio from it via a render block on the host's audio thread, at the host's
  sample rate and buffer size,
- embeds the plugin's UI as a view controller inside the host's own window,
- sends it MIDI (including MPE),
- automates its parameters via the `AUParameterTree`,
- saves/restores its state (`fullState`) inside the host's project file.

Four component types matter:

| Type | 4cc | Role | WaveTuner fit |
|---|---|---|---|
| Instrument | `aumu` | receives MIDI, makes sound | the drone/voice synth |
| Generator | `augn` | makes sound, no MIDI required | drones/sequence lanes as a self-playing source |
| Effect | `aufx` | processes audio through it | (saturation chain could, but not the point) |
| MIDI processor | `aumi` | transforms/emits MIDI, no audio | tuning systems + dice emitting MPE pitch |

### The hosts — where the users are

The hosts are the center of gravity; shipping an AUv3 means living inside all of them.

- **AUM** — the de facto modular mixer everyone patches things into. The single most
  important target.
- **Loopy Pro** — looper / live-performance host.
- **Drambo** — modular groovebox; hosts AUv3s inside its racks.
- **Logic Pro for iPad**, **Cubasis**, **Zenbeats** — the DAWs; AUv3 state rides their
  project files.
- **GarageBand** — hosts AUv3 instruments/effects; huge casual reach.
- **apeMatrix, Camelot Pro** — routing/rig hosts.

An app without an AUv3 is a standalone island that can only talk MIDI to these.

### Core MIDI virtual endpoints

Apps publish virtual MIDI sources/destinations and see each other's — this is how a
sequencer app drives a synth app with **no audio plumbing at all**. Transports layer on
top: USB (IDAM), Wi-Fi (RTP-MIDI network sessions), Bluetooth LE MIDI.
**WaveTuner already does this side fully** — see §3.

### Ableton Link

Zero-config LAN protocol for shared tempo / phase / beat-grid across apps, devices, and
Ableton Live itself. Not MIDI clock: every participant is a peer, anyone can nudge tempo,
everyone stays phase-aligned; optional start/stop-sync layer. Ships as a static C++
library with an Objective-C++ wrapper (LinkKit). Nearly every sequencer-ish iOS music app
has it; its presence is a checkbox buyers look for.

### IDAM — Inter-Device Audio + MIDI

The USB bridge that makes the iPad appear as an audio-input + MIDI device on a Mac.
Already built and device-verified in WaveTuner (MidiPanel connection section; the
fixed-route master-gain facade in `Audio/MasterVolume.swift` exists *because* of IDAM's
volume-knob-ignoring route).

### Legacy tier (do not build for these)

- **Inter-App Audio (IAA)** — Apple's old app-to-app audio API. Deprecated since iOS 13,
  effectively gone.
- **Audiobus** — the third-party pioneer of app-to-app audio routing. Still exists, but
  the ecosystem consolidated onto AUv3 hosting.

---

## 2. Terminology note: "PiP"

iOS **Picture-in-Picture** is a video-playback API (AVKit) and is not how music apps
compose. The floating-module feel in AUM/Drambo screenshots is AUv3 hosting — the host
owns the window; plugins are embedded view controllers. The right mental model for
"WaveTuner as a PiP-style module" is an AUv3 extension.

---

## 3. Where WaveTuner sits today

**Excellent MIDI citizen, standalone audio island.**

Already shipped (see README-PORT parity matrix):

- MIDI in with MPE voice allocation (`Audio/MidiInput.swift`, `MpeVoiceAllocator.swift`),
  velocity curves, voice cap.
- MPE **out** with destination picker (`Audio/MidiOutput.swift`) — drones + voices as
  per-note-pitch MPE, so external synths can already play WaveTuner's tunings.
- All three cross-device transports (`Audio/MidiTransports.swift`): IDAM (device-verified),
  RTP-MIDI network session, BLE MIDI.
- Fixed-route app-gain handling (`Audio/MasterVolume.swift`).

What's missing is the **audio half**: nobody can record WaveTuner's drones into Loopy
Pro, run its output through an AUM effects chain, or save a WaveTuner instance inside a
Logic project. The only way audio leaves the app is the hardware output (or the IDAM
input on a Mac). AUv3 is the door.

Engine shape (matters for §5): `Audio/AudioEngine.swift` (~3.4k lines) runs an
`AVAudioEngine` with **`AVAudioSourceNode`s** — i.e. the DSP already lives in pull-model
render callbacks, which is architecturally close to an AUv3 `internalRenderBlock`. The
granular island (`Audio/Granular/Engine/`, C++17, blockwise Faust-derived) is a *second*
engine with its own graph. What is NOT plugin-shaped: AVAudioSession ownership,
interruption/route-change handling, the transport state machine ("tape" pause/resume,
warm start), the mic chain, and singleton-flavored engine state.

---

## 4. Three tiers of participation (effort-ordered)

### Tier 1 — Ableton Link (small, standalone-side, immediate value)

The perform lanes / `SequenceConductor` / generative dwell clocks are exactly what
players want phase-locked to the rest of a rig. LinkKit is a drop-in static lib with a
small C++/Obj-C++ API — the C++ toolchain already exists for the granular island. Scope:

- Link session + tempo/quantum plumbing into `SequenceConductor`'s clock (lane dwell and
  stagger quantized to the Link beat grid, probably as an opt-in "sync" mode per lane —
  free-running seconds-based dwell stays the default).
- Start/stop sync as a follow-on.
- Settings UI: a "link" row in the midi + audio tab (session status, peer count).

No architectural surgery; makes standalone WaveTuner a good ensemble player.

### Tier 2 — AUv3 instrument/generator extension (the real move, real work)

WaveTuner-as-AUv3 in AUM is a genuinely distinctive product: a **just-intonation-native
drone/chord instrument with the consonance visualization**, feeding a mixer full of
effects, host-recorded, host-persisted. Nothing on the platform occupies that slot.

**Scope discipline for v1:** bring the drone synth only — tuning systems, detune/pan
collapse engine, wave morph/fold, MPE-capable MIDI in, the spectrum bar + orbs as the
plugin face. Leave in the standalone app: sequences/perform lanes, mic everything
(spectrogram/compressor — extensions get **no microphone**), grains (memory ceiling risk,
see §5), saves/patch browser beyond simple presets.

### Tier 3 — Spin-off AUv3s (reuse tier-2 infrastructure)

- **Grains as its own AUv3 instrument** — the C++ engine is already blockwise and
  self-contained; corpus memory footprint is the main question.
- **Tuning/dice as a MIDI-processor AUv3** (`aumi`) — emit MPE per-note pitch so
  WaveTuner's tuning systems and dice/guide logic drive *other people's* synths. Small
  audio-free extension; big conceptual reach.

---

## 5. AUv3 architecture implications, mapped to the codebase

### Process + target split

- New app-extension target in `project.yml` (xcodegen makes the mechanics cheap) + an
  **app group** if the app and extension share presets/corpora on disk.
- Engine code moves to a **shared framework** importable without app-only baggage.
  Everything the extension links must not touch `AVAudioSession`, `UIApplication`, mic
  capture, or the app's transport/lifecycle machinery. Today those are interleaved in
  `AudioEngine.swift`; the port is a *factoring* job before it is a *porting* job.

### Render-model inversion (the big one)

Today the app owns the clock: `AVAudioEngine` + source nodes pushing to the device the
app configured. An AUv3 hands you `internalRenderBlock` and the **host** pulls, at the
host's sample rate / buffer size / thread. Web analogy: owning the `AudioContext` vs.
being an `AudioWorkletProcessor` inside someone else's.

Good news: the per-block DSP (mip-mapped wavetables, detune-pair collapse pan law, fold
mix, envelopes, saturation chain) already lives in `AVAudioSourceNode` callbacks — the
math ports nearly as-is. The work is extracting a **pure synth core** with:

- explicit sample-rate plumbing (host can change it between `allocateRenderResources`
  calls; today the session's rate is ambient),
- no assumption of a single global engine instance (hosts instantiate **multiple
  copies** — every `static`/singleton in the render path is a bug),
- no transport ownership (the tape-pause fairy, warm start, interruption handling stay
  app-side; the plugin renders when pulled, silence when not),
- real-time-safe allocation discipline in `allocateRenderResources` /
  `deallocateRenderResources` (wavetable bakes, voice pools).

### Parameters + state

- `AUParameterTree`: faders, pans, detune curve/ceiling, morph, fold amount/type,
  envelope times, saturation amount/style become host-automatable parameters with
  addresses, ranges, and units. Ramped parameter events arrive on the render thread —
  the existing one-pole smoothing (τ 30 ms pan weights etc.) slots right in.
- `fullState` / `fullStateForDocument`: host-project persistence. `PatchSnapshot` is
  most of this already; it needs a second serialization door (and a versioned dictionary
  wrapper, since host project files live for years).
- Factory presets = a curated subset of `BuiltinPatches`.

### UI embedding

The extension's `AUViewController` embeds SwiftUI via `UIHostingController`, at whatever
size the host grants — often a small resizable pane, sometimes tiny, sometimes hidden
entirely (headless hosting is legal; audio must work with no UI ever loaded). Realistic
plan: a **compact plugin face** (spectrum bar + orbs + a knob row) designed for ~AUM pane
sizes, not the full app UI. The iPad side-column work is adjacent thinking but the
constraint is harsher here.

### Constraints to know up front

- **Memory ceiling.** Extensions get a hard cap far below app limits (historically a few
  hundred MB on modern iPads, less on older ones; hosts running 20 plugins expect each to
  be lean). The drone synth is trivially fine. The granular corpus + 8-voice engine needs
  measuring before promising tier 3.
- **No microphone / no AVAudioSession control.** All mic features stay app-only.
- **Multiple instances** — see render section; also UserDefaults/@AppStorage reads in
  shared code become per-extension-process, not per-instance.
- **Sandbox:** extension and app don't share a container unless an app group is set up.
- **Testing:** hosts differ meaningfully (AUM vs Logic vs GarageBand); `auval` on Mac
  Catalyst / the AU lab-style validation catches the basics, real hosts catch the rest.

---

## 6. Recommended order

1. **Tier 1 (Link)** — small, ships alone, immediately useful, no risk to the app.
2. **Factoring pass** — extract the pure synth core out of `AudioEngine.swift` behind a
   render-block-shaped interface *while still used by the standalone app* (the app's
   source-node callbacks call the same core). This is valuable refactoring even if the
   AUv3 never ships, and it de-risks the extension completely.
3. **Tier 2 v1** — `aumu` instrument extension: synth core + parameter tree + compact
   face + presets. Validate in AUM first, then Logic/GarageBand.
4. **Tier 3** — grains AUv3 and/or the `aumi` tuning MIDI processor, reusing the target +
   framework infrastructure.

## 7. Open questions

- Instrument (`aumu`) vs generator (`augn`) for v1 — or register both from one extension?
  Drones argue generator (sound with no MIDI), but instrument is what hosts surface in
  their "instruments" pickers and what MPE routing expects. Leaning `aumu` that starts
  its drones on load.
- How much of the tuning UI belongs in the plugin face vs. "edit in the full app and
  export presets"?
- Does the pan/detune collapse engine's stereo assumption survive hosts that render
  mono or multichannel buses?
- Link quantization semantics for lanes whose dwell is defined in *seconds* (0–120 s) —
  quantize launches only, or stretch dwell to bar multiples?
- Business framing: AUv3 as part of the base app vs. IAP — hosts show the plugin to
  anyone who owns the app either way.
