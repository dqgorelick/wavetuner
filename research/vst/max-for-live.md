# WaveTuner — Max for Live Research

## Platform Comparison

| | Web | iOS | JUCE (VST/AU) | Max for Live |
|---|---|---|---|---|
| **Language** | JS + Web Audio | Swift + AVFoundation | C++ + JUCE | Max/MSP + JS + Gen~ |
| **DSP** | OscillatorNode | Phase accumulator | Phase accumulator | `cycle~` or Gen~ |
| **Visualization** | Canvas 2D | Core Graphics | JUCE Graphics | `jsui` (JS Canvas) |
| **XY Control** | Mouse drag on XY pad | Touch drag on spectrum bar | Mouse drag + keyboard | `jsui` mouse events |
| **Parameters** | URL state | @Published props | APVTS | `live.dial` / `live.toggle` |
| **Preset System** | URL sharing | Not yet | JUCE state save | Ableton presets / Live Sets |
| **Distribution** | Browser | App Store | Plugin folders | Ableton Pack / .amxd file |

## Unified Design Language

Across all four platforms, WaveTuner should share:

### Visual Identity
- **Black background** everywhere
- **4 oscillator colors**: teal (`#4ec9b0`), orange (`#ce9178`), blue (`#569cd6`), yellow (`#dcdcaa`)
- **Lissajous oscilloscope** with 20-minute color cycling, dual-layer glow + white core, adaptive complexity, fade trail
- **Numbered dots** (1-4) for oscillator position on the XY grid
- **Ghost cursor** (translucent circle) showing mouse/touch control position
- Frequency grid with log-scale vertical lines at 50, 100, 200, 500, 1k, 2k, 5k, 10k Hz
- Single horizontal center line at 50% volume

### Interaction Model
- **Relative control** — mouse/touch deltas, not absolute position snapping
- **Multi-select** — control multiple oscillators simultaneously
- **Fine tune** — shift key or toggle button for 10x reduced sensitivity
- **Per-oscillator Play** — each oscillator can be independently toggled
- **Hold** — latches audio on after MIDI note-off (default on)
- **300ms attack/decay** — smooth fade on play/pause transitions

### DSP (identical across all)
- 4 sine oscillators with phase accumulation
- Stereo routing: osc 1,3 → L, osc 2,4 → R
- Per-oscillator gain smoothing (~300ms)
- Master gain: `1/sqrt(2)` ≈ 0.707
- Frequency range: 20–20,000 Hz (log scale)
- Default frequencies: 101.25, 102.78, 204.03, 204.66 Hz
- Default volumes: 0.50, 0.50, 0.48, 0.50

## Max for Live Architecture

### File Structure

```
max-for-live/
├── WaveTuner.maxpat          # Main patch (JSON) — importable into Max
├── wavetuner-ui.js           # jsui: XY pad + oscilloscope + ghost cursor
├── wavetuner-dsp.gendsp      # Gen~ patcher (XML): 4 oscillators + mixing
└── README.md
```

### How the Pieces Connect

```
┌─────────────────────────────────────────────────┐
│  Max for Live Instrument                        │
│                                                 │
│  live.dial (freq coarse x4)  ─┐                │
│  live.dial (freq fine x4)    ─┤                │
│  live.dial (volume x4)       ─┼──► gen~ (DSP) ──► plugout~ (stereo)
│  live.toggle (mute x4)      ─┤        │
│  live.toggle (play x4)      ─┤        │ waveform data
│  live.toggle (hold)          ─┘        ▼
│                                   jsui (UI)
│  live.toggle (xy tune x4)   ───► jsui
│  live.toggle (fine tune)     ───► jsui
│                                                 │
│  midiin → midiparse ──────────► gen~ (note gate)│
└─────────────────────────────────────────────────┘
```

### Gen~ DSP (wavetuner-dsp.gendsp)

Gen~ runs at audio rate and handles:
- 4 `cycle` (sine) operators reading from `param` inputs
- Per-oscillator gain smoothing via `history` + exponential approach
- Mute/play gate per oscillator
- Master gain with smoothing
- MIDI note gate (note count tracking)
- Hold latch logic
- Stereo summing (osc 1,3 → left, osc 2,4 → right)
- Waveform snapshot output (via `out` channels for jsui to read)

Gen~ params map 1:1 to `live.dial` / `live.toggle` objects, which automatically get Ableton's MIDI mapping, automation, and preset saving.

### jsui Visualization (wavetuner-ui.js)

The `jsui` object provides a custom JavaScript canvas identical to HTML5 Canvas API. This handles:

**XY Pad (left portion):**
- Black background, log-scale frequency grid lines
- 4 colored dots at each oscillator's freq/vol position
- Click to select, drag for relative control
- Ghost cursor circles while dragging/selected
- Fine tune indicator

**Lissajous Oscilloscope (right portion):**
- Reads waveform data from Gen~ via `peek` or message passing
- Lissajous XY plot with dual-layer glow rendering
- 20-minute color cycling
- Adaptive complexity detection
- Fade trail via persistent offscreen buffer (mgraphics)

**Mouse Interaction:**
- `onclick`, `ondrag`, `onidle` for mouse tracking
- Relative delta calculation (same as JUCE version)
- Multi-select via modifier keys or XY Tune toggles
- Fine tune via shift key

### Parameter Layout

All parameters use `live.dial` or `live.toggle` for native Ableton integration:

| Parameter | Type | Range | Default |
|---|---|---|---|
| `osc1_freq` through `osc4_freq` | `live.dial` | 20–20000 Hz (log) | 101.25, 102.78, 204.03, 204.66 |
| `osc1_fine` through `osc4_fine` | `live.dial` | -10 to +10 Hz | 0 |
| `osc1_vol` through `osc4_vol` | `live.dial` | 0–1 | 0.50, 0.50, 0.48, 0.50 |
| `osc1_mute` through `osc4_mute` | `live.toggle` | 0/1 | 0 |
| `osc1_play` through `osc4_play` | `live.toggle` | 0/1 | 0 |
| `osc1_xy` through `osc4_xy` | `live.toggle` | 0/1 | 0 |
| `hold` | `live.toggle` | 0/1 | 1 |
| `fine_tune` | `live.toggle` | 0/1 | 0 |
| `master_gain` | `live.dial` | 0–1 | 0.707 |

### Max for Live Advantages

- **Embedded UI** — the jsui lives inside Ableton's device chain, no floating window
- **Native MIDI/key mapping** — right-click any `live.*` parameter to map
- **Automation lanes** — all parameters automatable in arrangement view
- **Device width** — can be as wide as needed (horizontal scroll in device chain)
- **Preset system** — Ableton handles save/load, Live Sets, device groups
- **Hot reload** — edit JS, save, changes apply immediately (fast iteration)

### Max for Live Limitations

- **Device height fixed at ~170px** — the Lissajous will be landscape/short
- **No EQ8-style expanded panel** — that's native Ableton only, not available to M4L
- **`jsui` performance** — software rendered, may need to limit oscilloscope FPS to 30
- **No global mouse tracking** — mouse events limited to jsui bounds
- **Ableton-only** — can't use in other DAWs

### Development Approach

Since Max patches are JSON and Gen~ patches are XML, both can be written as text files:

1. Write `wavetuner-dsp.gendsp` — Gen~ XML for the DSP
2. Write `wavetuner-ui.js` — jsui JavaScript for all visualization and interaction
3. Write `WaveTuner.maxpat` — JSON patch wiring everything together
4. Open in Ableton → Max editor → save as .amxd

The JS canvas API in `jsui` is nearly identical to HTML5 Canvas, so the web version's rendering code ports almost directly. The Gen~ DSP maps closely to the iOS phase accumulator approach.
