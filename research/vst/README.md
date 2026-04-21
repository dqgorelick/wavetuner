# WaveTuner VST/AU Plugin Research

## Overview

WaveTuner generates binaural beats from multiple sine oscillators with stereo routing and Lissajous visualization. A VST3/AU plugin version would let users run it inside a DAW (Ableton, Logic, Reaper, etc.) as an instrument plugin.

Since WaveTuner **generates** audio rather than processing it, it should be a **VSTi / AUi (instrument plugin)** — the DAW creates it on an instrument track and it outputs stereo audio. No audio input needed.

## Framework: JUCE

| Framework | Language | Outputs | Notes |
|-----------|----------|---------|-------|
| **JUCE** | C++ | VST3, AU, AAX, CLAP | Industry standard, largest ecosystem, best documentation |
| iPlug2 | C++ | VST3, AU, AAX | Lighter weight, simpler API |
| NIH-plug | Rust | VST3, CLAP | Growing ecosystem, modern tooling, no AU support yet |
| CLAP SDK | C/C++ | CLAP only | Newer format, not yet universally supported by DAWs |

**Decision: JUCE** — builds VST3 + AU from one codebase, has a full custom GUI framework (including OpenGL), mature preset system, and the most documentation/community support.

---

## Development Setup

### What You Need

1. **JUCE** — download from [juce.com](https://juce.com/) or clone the repo
2. **Xcode** — required for building on macOS (AU validation also needs Xcode)
3. **CMake** (recommended) or **Projucer** (JUCE's own project configurator)

### Two Ways to Set Up a Project

**Option A: CMake (recommended for version control)**
- Copy the example `CMakeLists.txt` from `JUCE/examples/CMake/AudioPlugin/`
- Point `add_subdirectory()` at your JUCE installation
- Build targets (VST3, AU, Standalone) are declared in one place
- `cmake . -B build && cmake --build build`

**Option B: Projucer**
- Open the Projucer app bundled with JUCE
- Create new project → "Audio Plug-In"
- Configure exporters (Xcode, VS, etc.) in the GUI
- Generates `.xcodeproj` / `.sln` files

CMake is better for git — Projucer generates platform-specific project files that are hard to diff.

### Typical Project Structure

```
WaveTunerPlugin/
├── CMakeLists.txt
├── JUCE/                          (git submodule or local copy)
├── Source/
│   ├── PluginProcessor.h/.cpp     (audio engine + parameters)
│   ├── PluginEditor.h/.cpp        (GUI)
│   ├── Oscillator.h/.cpp          (phase accumulator DSP)
│   ├── LissajousComponent.h/.cpp  (oscilloscope visualization)
│   └── Parameters.h               (parameter IDs and ranges)
└── Resources/
    └── (fonts, images if needed)
```

### Build Targets

One codebase builds all formats. In CMake:

```cmake
juce_add_plugin(WaveTuner
    PLUGIN_MANUFACTURER_CODE  Wave
    PLUGIN_CODE               WvTn
    FORMATS                   VST3 AU Standalone
    IS_SYNTH                  TRUE          # instrument, not effect
    NEEDS_MIDI_INPUT          TRUE          # for MIDI CC control
    NEEDS_MIDI_OUTPUT         FALSE
    PRODUCT_NAME              "WaveTuner")
```

Build outputs go to:
- **VST3**: `~/Library/Audio/Plug-Ins/VST3/WaveTuner.vst3`
- **AU**: `~/Library/Audio/Plug-Ins/Components/WaveTuner.component`
- **Standalone**: Regular `.app`

### macOS Signing

- AU bundles **must** be code-signed for the host to load them
- Ad-hoc signing works for local development: `codesign -s - WaveTuner.component`
- For distribution: Apple Developer certificate + notarization required
- JUCE's CMake does ad-hoc signing automatically during build (can conflict with real signing later — plan the pipeline)

---

## DSP: What Ports Directly

The iOS version's audio render callback is almost identical to what goes in JUCE's `processBlock()`:

| Concept | iOS (current) | JUCE (target) |
|---------|--------------|---------------|
| Sine generation | Manual phase accumulator in `AVAudioSourceNode` render callback | Phase accumulator in `processBlock()` |
| Sample rate | `AVAudioSession.sampleRate` | `getSampleRate()` from `prepareToPlay()` |
| Buffer size | Render callback buffer | `buffer.getNumSamples()` in `processBlock()` |
| Gain smoothing | Timer-based exponential ramp | `SmoothedValue<float>` (JUCE built-in) |
| Stereo routing | Hard-coded L/R pairs | Write to `buffer.getWritePointer(0)` (L) and `(1)` (R) |

The core loop is essentially:

```cpp
void processBlock(AudioBuffer<float>& buffer, MidiBuffer& midi)
{
    auto* leftChannel  = buffer.getWritePointer(0);
    auto* rightChannel = buffer.getWritePointer(1);
    
    for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
    {
        float left = 0.0f, right = 0.0f;
        
        for (int i = 0; i < 4; ++i)
        {
            float value = std::sin(phase[i]) * gainSmoothed[i].getNextValue();
            
            if (i % 2 == 0) left  += value;  // osc 0,2 → left
            else             right += value;  // osc 1,3 → right
            
            phase[i] += twoPi * frequency[i] / sampleRate;
            if (phase[i] >= twoPi) phase[i] -= twoPi;
        }
        
        leftChannel[sample]  = left  * masterGain;
        rightChannel[sample] = right * masterGain;
    }
}
```

---

## Parameter System: Coarse/Fine with Knob + Encoder Support

### Parameter Layout

```
Per oscillator (x4):
  osc{N}_freq_coarse   — 20-20000 Hz, logarithmic (skew ~0.2)
  osc{N}_freq_fine     — -10.0 to +10.0 Hz, linear
  osc{N}_volume        — 0.0 to 1.0, linear
  osc{N}_mute          — boolean

Global:
  master_gain          — 0.0 to 1.0, linear
```

The actual frequency used in DSP = `coarse + fine`. The coarse knob selects the register, the fine knob dials in the binaural beat offset. A full turn of the fine knob covers 20 Hz — enough for precise beat frequency control.

### JUCE Implementation

Parameters are defined using `AudioProcessorValueTreeState` (APVTS):

```cpp
AudioProcessorValueTreeState::ParameterLayout createParameterLayout()
{
    std::vector<std::unique_ptr<RangedAudioParameter>> params;
    
    for (int i = 1; i <= 4; ++i)
    {
        auto id = String(i);
        
        // Coarse: logarithmic 20-20000 Hz
        params.push_back(std::make_unique<AudioParameterFloat>(
            "osc" + id + "_freq_coarse",
            "Osc " + id + " Frequency",
            NormalisableRange<float>(20.0f, 20000.0f, 0.01f, 0.2f), // skew 0.2 = log-like
            defaultFreqs[i-1]));
        
        // Fine: linear ±10 Hz
        params.push_back(std::make_unique<AudioParameterFloat>(
            "osc" + id + "_freq_fine",
            "Osc " + id + " Fine Tune",
            NormalisableRange<float>(-10.0f, 10.0f, 0.01f),
            0.0f));
        
        // Volume: linear 0-1
        params.push_back(std::make_unique<AudioParameterFloat>(
            "osc" + id + "_volume",
            "Osc " + id + " Volume",
            NormalisableRange<float>(0.0f, 1.0f, 0.01f),
            0.5f));
        
        // Mute: boolean
        params.push_back(std::make_unique<AudioParameterBool>(
            "osc" + id + "_mute",
            "Osc " + id + " Mute",
            false));
    }
    
    params.push_back(std::make_unique<AudioParameterFloat>(
        "master_gain", "Master Gain",
        NormalisableRange<float>(0.0f, 1.0f, 0.01f),
        0.7f));
    
    return { params.begin(), params.end() };
}
```

### How Parameters Connect to Everything

```
                    ┌─────────────┐
                    │  DAW Host   │
                    │  Automation │
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────┐  ┌────────────────┐  ┌──────────────┐
│  Plugin GUI  │  │   APVTS        │  │  MIDI CC     │
│  (sliders,   │◄►│  (parameter    │◄─│  (knobs,     │
│   drag dots) │  │   state tree)  │  │   encoders)  │
└──────────────┘  └────────┬───────┘  └──────────────┘
                           │
                           ▼
                  ┌────────────────┐
                  │  processBlock  │
                  │  (reads params │
                  │   each block)  │
                  └────────────────┘
```

APVTS is the central hub. The GUI attaches to it via `SliderAttachment` / `ButtonAttachment`. The DAW reads/writes it for automation. MIDI CC can be routed to it. `processBlock()` reads current values each audio callback.

### Logarithmic Skew for Frequency

JUCE's `NormalisableRange` `skewFactor` controls how the 0-1 normalized range maps to the actual value:
- **skew = 1.0**: linear
- **skew = 0.2**: most of the knob range covers low frequencies, upper range compressed (good for 20-20kHz)
- The formula: `value = start + (end - start) * pow(normalized, 1/skew)`

This means turning a knob from 0% to 50% covers 20-200 Hz (where binaural beats live), and 50-100% covers 200-20kHz. The musically important range gets the most knob resolution.

---

## Endless Encoder / Relative MIDI CC Support

### The Problem

Standard MIDI CC is **absolute**: value 0-127, where each position maps to a fixed parameter value. Endless encoders send **relative** values: "turned clockwise 3 clicks" or "turned counterclockwise 2 clicks."

### Relative CC Encoding Modes

Different hardware uses different encodings for the same 7-bit MIDI CC byte:

| Mode | Clockwise | Counter-clockwise | Used by |
|------|-----------|-------------------|---------|
| **Two's complement** | 1-63 (+1 to +63) | 65-127 (-63 to -1) | Ableton Push, many controllers |
| **Sign-magnitude** | 1-63 (+1 to +63) | 65-127 (bit 6 = sign) | Some Behringer controllers |
| **Offset binary** | 65-127 (+1 to +63) | 0-63 (-64 to -1) | Mackie protocol |

### JUCE Doesn't Handle This Natively

JUCE treats all MIDI CC as absolute 0-127. You need custom code in `processBlock()` to detect and interpret relative CC:

```cpp
void handleMidiCC(int ccNumber, int ccValue, const String& paramId)
{
    // Detect relative mode (two's complement)
    float delta = 0.0f;
    if (ccValue >= 1 && ccValue <= 63)
        delta = static_cast<float>(ccValue);        // clockwise
    else if (ccValue >= 65 && ccValue <= 127)
        delta = static_cast<float>(ccValue) - 128;  // counterclockwise
    
    if (delta == 0.0f) return;
    
    auto* param = apvts.getParameter(paramId);
    float currentNorm = param->getValue();           // 0-1 normalized
    float step = delta * 0.005f;                     // sensitivity scaling
    float newNorm = juce::jlimit(0.0f, 1.0f, currentNorm + step);
    param->setValueNotifyingHost(newNorm);
}
```

### Sensitivity Scaling

The `step` multiplier controls how far one encoder click moves the parameter:
- **0.01**: 100 clicks for full sweep (precise, good for fine tune)
- **0.005**: 200 clicks for full sweep (default, good balance)
- **0.002**: 500 clicks for full sweep (very precise)

You'd want different sensitivity for coarse frequency (fewer clicks to sweep) vs fine frequency (more clicks for precision). Could also implement acceleration: faster turning = bigger steps.

### MIDI Learn

Standard approach: user right-clicks a GUI knob → "MIDI Learn" → turns a physical knob → that CC number is now mapped to that parameter. JUCE doesn't provide this out of the box, but it's a common pattern:

```cpp
// Store CC-to-parameter mappings
std::map<int, String> ccToParam;  // e.g., {1: "osc1_freq_coarse", 2: "osc1_freq_fine"}

// In processBlock(), iterate MIDI messages:
for (const auto& msg : midiMessages)
{
    if (msg.getMessage().isController())
    {
        int cc = msg.getMessage().getControllerNumber();
        int val = msg.getMessage().getControllerValue();
        
        if (midiLearnActive)
            ccToParam[cc] = midiLearnTargetParam;
        else if (ccToParam.count(cc))
            handleMidiCC(cc, val, ccToParam[cc]);
    }
}
```

---

## Oscilloscope: Yes, Fully Possible in JUCE

### Options for Real-Time Visualization

| Approach | Rendering | FPS | Best for |
|----------|-----------|-----|----------|
| **Component::paint()** | CPU (JUCE Graphics) | 30-60 | Simple waveforms, meters |
| **OpenGLContext** | GPU (OpenGL) | 60+ | Lissajous, heavy animation, many points |
| **Timer + repaint()** | CPU with periodic trigger | 30-60 | UI updates at fixed rate |

### Recommended: OpenGL for the Lissajous

The Lissajous oscilloscope draws thousands of points per frame with color cycling and trail fade — same as the web Canvas 2D and iOS Core Graphics versions. OpenGL is the right choice here:

```cpp
class LissajousComponent : public juce::Component,
                           public juce::OpenGLRenderer
{
public:
    LissajousComponent()
    {
        openGLContext.setRenderer(this);
        openGLContext.setContinuousRepainting(true);  // render every frame
        openGLContext.setSwapInterval(1);             // vsync
        openGLContext.attachTo(*this);
    }
    
    void newOpenGLContextCreated() override { /* init shaders, buffers */ }
    
    void renderOpenGL() override
    {
        // Read latest waveform data from ring buffer (lock-free)
        // Draw Lissajous: left channel = X, right channel = Y
        // Apply trail fade (draw semi-transparent black quad)
        // Draw colored line through sample points
        // Color cycles over 20 minutes (same as web/iOS)
    }
    
    void openGLContextClosing() override { /* cleanup */ }
    
    // Ring buffer fed from processBlock() (audio thread → GL thread)
    // Use a lock-free FIFO (juce::AbstractFifo) to pass waveform data
};
```

### Audio Thread → GUI Thread Data Flow

The oscilloscope needs waveform data from `processBlock()`, but rendering happens on a different thread. Use a lock-free ring buffer:

```cpp
// In PluginProcessor.h
juce::AbstractFifo fifo { 8192 };
std::array<float, 8192> leftBuffer, rightBuffer;

// In processBlock() — audio thread writes
auto [start1, size1, start2, size2] = fifo.write(numSamples);
// copy samples into leftBuffer/rightBuffer at those indices

// In LissajousComponent::renderOpenGL() — GL thread reads
auto [start1, size1, start2, size2] = fifo.read(2048);
// read samples for visualization
```

This is the same pattern as the iOS version's ring buffer (`waveformBufferL/R` with 8192 samples, snapshot of 2048).

### Trail / Fade Effect

Same approach as web and iOS — each frame, draw a semi-transparent black quad over the entire view before drawing new points:

```cpp
// OpenGL equivalent of the canvas fade
glEnable(GL_BLEND);
glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

// Draw black quad with alpha 0.1-0.3 (controls trail length)
drawQuad(0, 0, width, height, Colour(0, 0, 0, 0.15f));

// Draw new Lissajous points on top
drawLineStrip(points, currentColor);
```

---

## Preset System

JUCE provides this mostly for free via `getStateInformation` / `setStateInformation`:

```cpp
void getStateInformation(MemoryBlock& destData) override
{
    auto state = apvts.copyState();
    auto xml = state.createXml();
    copyXmlToBinary(*xml, destData);
}

void setStateInformation(const void* data, int sizeInBytes) override
{
    auto xml = getXmlFromBinary(data, sizeInBytes);
    if (xml && xml->hasTagName(apvts.state.getType()))
        apvts.replaceState(ValueTree::fromXml(*xml));
}
```

This saves/restores all parameter values when:
- The DAW saves/loads a project
- The user saves/loads a plugin preset

### Factory Presets

Ship a set of default binaural beat presets as XML resources:

```
Presets/
├── Deep Theta (4Hz).xml      — 100 Hz base, 4 Hz beat, harmonics at 200 Hz
├── Alpha Focus (10Hz).xml    — 200 Hz base, 10 Hz beat
├── Delta Sleep (2Hz).xml     — 80 Hz base, 2 Hz beat
├── Schumann Resonance.xml    — 7.83 Hz base frequencies
└── Custom Drone.xml          — wider frequency spread, no strict pairing
```

---

## Development Sequence

Suggested order for building this out:

### Phase 1: Minimal Viable Plugin (audio only)
1. Set up JUCE project with CMake (VST3 + AU + Standalone targets)
2. Define parameters (coarse freq, fine freq, volume, mute x4, master gain)
3. Implement `processBlock()` with phase accumulation (port from iOS)
4. Verify it generates correct binaural beats in a DAW
5. Implement `getStateInformation` / `setStateInformation`

### Phase 2: Basic GUI
6. Build the editor with JUCE sliders for all parameters (functional, not pretty)
7. Wire sliders to APVTS via `SliderAttachment`
8. Add frequency display (Hz + note name + cents)
9. Test automation in DAW (draw frequency sweeps, verify smooth transitions)

### Phase 3: MIDI CC + Encoders
10. Implement MIDI CC handling in `processBlock()`
11. Add relative CC decoding (two's complement mode)
12. Add MIDI learn (right-click → assign CC)
13. Test with a physical MIDI controller

### Phase 4: Custom GUI + Oscilloscope
14. Replace basic sliders with custom frequency spectrum bar + draggable dots
15. Add OpenGL Lissajous oscilloscope component
16. Implement lock-free ring buffer for audio → GL data flow
17. Add trail fade and color cycling
18. Add volume faders styled like iOS version

### Phase 5: Polish
19. Factory presets (theta, alpha, delta, etc.)
20. Resizable GUI
21. Code signing + notarization for distribution
22. Test across DAWs (Logic, Ableton, Reaper)

---

## References

- [JUCE Tutorials: Create a basic Audio/MIDI plugin](https://juce.com/tutorials/tutorial_create_projucer_basic_plugin/)
- [JUCE Tutorials: Adding plug-in parameters](https://juce.com/tutorials/tutorial_audio_parameter/)
- [JUCE Tutorials: Saving and loading plug-in state](https://juce.com/tutorials/tutorial_audio_processor_value_tree_state/)
- [JUCE: NormalisableRange (skew factor for log scaling)](https://docs.juce.com/master/classNormalisableRange.html)
- [JUCE: OpenGLContext](https://docs.juce.com/master/classOpenGLContext.html)
- [JUCE: Graphics class (2D rendering)](https://docs.juce.com/master/classjuce_1_1Graphics.html)
- [JUCE: AbstractFifo (lock-free ring buffer)](https://docs.juce.com/master/classAbstractFifo.html)
- [JUCE CMake API (build targets, signing)](https://github.com/juce-framework/JUCE/blob/master/docs/CMake%20API.md)
- [OpenGLRealtimeVisualization4JUCE](https://github.com/JanosGit/OpenGLRealtimeVisualization4JUCE) — example oscilloscope module
- [JUCE Forum: Relative MIDI CC from hardware controllers](https://forum.juce.com/t/relative-midi-cc-values-from-hardware-controller/57528)
