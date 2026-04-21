# Existing Wavetuner Web App Analysis

## Tech Stack
- **React 19 + Vite** -- modern build tooling
- **Web Audio API** -- all audio generation and analysis
- **Canvas 2D** -- oscilloscope visualization (no libraries like p5.js)

## Audio Architecture

### Sine Wave Generation
- 2-10 `OscillatorNode` instances with per-oscillator `GainNode`
- Base frequencies: 50-130 Hz, with binaural beat offsets of 1-4 Hz
- Frequency range: 0.1 Hz to 20,000 Hz with logarithmic scaling
- Smooth transitions via `frequency.setTargetAtTime()`
- Master gain with dynamic scaling: `1.0 / Math.sqrt(oscillatorCount / 2)`

### Audio Graph
```
Oscillators -> Gain Nodes -> Channel Gain -> Stereo Merger -> Master Gain
                                                                  |
                                                              Splitter
                                                          /            \
                                                    Analyser1     Analyser2
                                                          \            /
                                                        Final Merger -> Destination
```

### Oscilloscope Visualization (`Oscilloscope.jsx`)
- `requestAnimationFrame` loop at 60fps
- **Lissajous curve**: XY plot from left/right `AnalyserNode` channels
- FFT size: 2048 samples
- 20-minute color cycling via sine wave RGB modulation
- Adaptive rendering: adjusts sampling step and line width based on zero-crossing frequency detection
- Dual-layer: colored line with glow + white outline
- Trail fade effect for visual persistence

### Routing System
- Visual patch bay with draggable SVG cables
- Multi-channel support (up to 32+ channels)
- Per-oscillator routing to multiple outputs

## Microphone: Current State

**Minimal** -- only used for device enumeration permission:
```javascript
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
stream.getTracks().forEach(track => track.stop()); // immediately stopped
```

No actual mic input processing, no frequency analysis of environment.

## What Transfers to Mobile

| Component | Reusability |
|---|---|
| Oscillator frequency logic | High -- math is portable |
| Binaural beat generation | High -- same algorithm |
| Lissajous visualization concept | High -- needs GPU rewrite |
| URL sharing system | Low -- mobile uses different sharing patterns |
| Web Audio API calls | None -- different APIs on native |
| React UI components | None -- native UI needed |
| Routing/patch bay | Medium -- concept transfers, UI doesn't |

## Key Files
- `/src/audio/AudioEngine.js` (776 lines) -- core audio engine, singleton pattern
- `/src/components/Oscilloscope.jsx` (190 lines) -- Lissajous visualization
- `/src/components/OscillatorControls.jsx` -- XY pad controls
- `/src/App.jsx` (300 lines) -- state management
