# Architecture Recommendation & Next Steps

## Recommended Architecture: Native iOS First

### Why Native iOS
1. **Shortest path to a working prototype** -- AVAudioEngine + Accelerate vDSP are built-in, no third-party dependencies needed
2. **Best audio performance** -- consistent 15-20ms latency, hardware-accelerated FFT
3. **SwiftUI** for a clean, modern UI with minimal code
4. **Metal** available for the oscilloscope visualization (or simpler CAShapeLayer for v1)
5. **No abstraction tax** -- you're building an audio app, not a CRUD app

### High-Level Architecture

```
┌──────────────────────────────────────────────────────┐
│                    SwiftUI Layer                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Oscilloscope │  │  Spectrogram │  │  Controls   │ │
│  │   (Metal)    │  │    View      │  │   Panel     │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                 │        │
│         └────────┬────────┘                 │        │
│                  │                          │        │
│         ┌────────v────────┐      ┌──────────v──────┐ │
│         │  Visualization  │      │  Composition    │ │
│         │    Manager      │      │   Parameters    │ │
│         └────────┬────────┘      └──────────┬──────┘ │
│                  │                          │        │
├──────────────────┼──────────────────────────┼────────┤
│                  │     Audio Engine          │        │
│         ┌────────v──────────────────────v────┘        │
│         │                                   │        │
│  ┌──────┴───────┐  ┌───────────┐  ┌────────┴──────┐ │
│  │   FFT        │  │ Frequency │  │  Oscillator   │ │
│  │  Analyzer    │──│  Mapper   │──│    Bank       │ │
│  │ (vDSP)      │  │ (Algo)    │  │ (AVAudioSrc)  │ │
│  └──────┬───────┘  └───────────┘  └────────┬──────┘ │
│         │                                   │        │
│  ┌──────┴───────┐              ┌────────────┴──────┐ │
│  │  Mic Input   │              │  Audio Output     │ │
│  │  (InputNode) │              │  (MainMixer)      │ │
│  └──────────────┘              └───────────────────┘ │
│                                                      │
│              AVAudioEngine / AVAudioSession           │
└──────────────────────────────────────────────────────┘
```

### Core Components

#### 1. FrequencyAnalyzer
- Captures mic input via `AVAudioEngine.inputNode`
- Runs vDSP FFT (4096-point) on audio buffers
- Outputs frequency magnitude spectrum 10-20 times per second
- Performs peak detection to identify dominant frequencies

#### 2. FrequencyMapper (the creative core)
- Takes FFT output (dominant frequencies + magnitudes)
- Applies the selected strategy:
  - **Mask**: generate drones at detected peaks
  - **Harmonize**: generate drones at harmonically related frequencies
  - **Fill**: generate drones in frequency gaps
- Outputs target frequencies + amplitudes for the oscillator bank
- Smooths transitions to avoid jarring changes

#### 3. OscillatorBank
- Array of `AVAudioSourceNode` instances generating sine waves
- Each oscillator has independent frequency and amplitude
- Smooth parameter changes (portamento) for organic transitions
- Supports binaural beat offsets (carried over from web app)

#### 4. Visualization
- Reads FFT data via lock-free ring buffer
- Renders Lissajous curve (from oscillator output) + frequency spectrum (from mic input)
- Metal for effects, or CAShapeLayer for simplicity in v1

---

## Phased Development Plan

### Phase 1: Proof of Concept (1-2 weeks of focused work)
- [ ] AVAudioEngine setup with simultaneous mic input + sine output
- [ ] Basic FFT analysis displaying frequency spectrum
- [ ] Single oscillator that tracks the loudest detected frequency
- [ ] Minimal SwiftUI UI: start/stop button, frequency display

### Phase 2: Core Experience (2-4 weeks)
- [ ] Multi-oscillator bank (4-8 oscillators)
- [ ] FrequencyMapper with mask/harmonize/fill strategies
- [ ] Smooth frequency transitions (portamento)
- [ ] Basic Lissajous visualization (CAShapeLayer)
- [ ] User controls: mode selection, volume, frequency range filter

### Phase 3: Polish & Visualization (2-3 weeks)
- [ ] Metal-based oscilloscope with glow/trail effects
- [ ] Spectrogram view showing mic input + generated drones
- [ ] Color cycling and adaptive rendering (ported from web app)
- [ ] Background audio support
- [ ] Presets: "mask speech," "enhance nature," "fill silence"
- [ ] Battery optimization (reduce analysis rate when backgrounded)

### Phase 4: Advanced Features
- [ ] Frequency band selection UI (draw/paint which frequencies to target)
- [ ] Save/load compositions
- [ ] Headphone mode detection (suggest ANC/transparency settings)
- [ ] Binaural beat integration
- [ ] Share compositions (URL scheme or export)

### Phase 5: Android (if desired)
- Extract DSP core to C++ library
- Either: native Kotlin app with JNI bridge to C++ core
- Or: evaluate Flutter with dart:ffi at this point

---

## Key Technical Decisions

### FFT Size: 4096
- 11.7 Hz resolution at 48kHz sample rate
- Good balance of frequency resolution vs. time resolution
- Sufficient to distinguish individual notes and frequency bands

### Analysis Rate: ~15-20 Hz
- Environmental sounds change slowly (seconds, not milliseconds)
- No need to analyze every audio buffer
- Reduces CPU/battery usage significantly

### Oscillator Count: 4-8
- Sufficient for multi-band drone composition
- Low CPU cost (sine generation is trivial)
- More oscillators = richer drone texture

### Portamento Time: 200-500ms
- Smooth transitions between target frequencies
- Prevents jarring jumps as the environment changes
- Musically pleasing glide effect

---

## Dependencies

### Required (built into iOS)
- AVFoundation / AVAudioEngine
- Accelerate / vDSP
- Metal (for visualization)
- SwiftUI

### Optional
- AudioKit -- if you want convenience wrappers (but adds a dependency)
- No third-party dependencies strictly necessary for the core functionality

---

## App Store Notes
- Declare `NSMicrophoneUsageDescription` with clear explanation
- Enable "Audio" background mode
- Avoid health claims ("reduces anxiety," "cures tinnitus") -- frame as a creative/generative audio tool
- No restrictions on generating audio tones or claiming frequency analysis
