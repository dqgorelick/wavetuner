# iOS Audio: APIs, FFT, and Implementation

## AVAudioEngine (Recommended Starting Point)

The high-level audio API that wraps Core Audio with a graph-based architecture.

### Microphone Capture
```swift
let engine = AVAudioEngine()
let inputNode = engine.inputNode
let format = inputNode.outputFormat(forBus: 0)

inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, time in
    // buffer.floatChannelData contains raw PCM samples
    // This closure is called on the real-time audio thread
    let samples = buffer.floatChannelData![0]
    let frameCount = Int(buffer.frameLength)
    // Perform FFT here or copy to a ring buffer for processing
}
```

### Sine Wave Generation
```swift
let outputNode = AVAudioSourceNode { _, _, frameCount, audioBufferList -> OSStatus in
    let buffer = UnsafeMutableAudioBufferListPointer(audioBufferList)
    for frame in 0..<Int(frameCount) {
        let sample = sin(phase)
        phase += 2.0 * .pi * frequency / sampleRate
        buffer[0].mData!.assumingMemoryBound(to: Float.self)[frame] = sample
    }
    return noErr
}
engine.attach(outputNode)
engine.connect(outputNode, to: engine.mainMixerNode, format: nil)
```

### Simultaneous Mic + Speaker
```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(.playAndRecord, options: [.defaultToSpeaker])
try session.setPreferredIOBufferDuration(0.005) // 5ms -> 256 frames at 48kHz
try session.setActive(true)
```

---

## FFT via Accelerate Framework (vDSP)

Apple's hardware-accelerated DSP library. Uses ARM NEON SIMD on all modern iPhones. A 4096-point FFT runs in under 0.1ms.

### Key Functions
| Function | Purpose |
|---|---|
| `vDSP.FFT` | Modern Swift wrapper (iOS 14+) |
| `vDSP_fft_zrip` | In-place radix-2 FFT (C API) |
| `vDSP_zvmags` | Magnitude squared from complex FFT output |
| `vDSP_vsmul` | Scaling/normalization |

### Frequency Resolution
- **Sample rate**: 48,000 Hz (standard iOS)
- **FFT size 2048**: frequency bin = 48000/2048 = ~23.4 Hz resolution
- **FFT size 4096**: frequency bin = 48000/4096 = ~11.7 Hz resolution
- **FFT size 8192**: frequency bin = 48000/8192 = ~5.9 Hz resolution

For detecting environmental frequencies (birds: 2-8 kHz, speech: 85-255 Hz fundamental, music: 20-20kHz), **4096 is a good default**. Use 8192 if finer resolution is needed for low frequencies.

### What You Get From FFT
The output is an array of magnitudes per frequency bin. For a 4096-point FFT at 48kHz:
- Bin 0: DC (0 Hz)
- Bin 1: 11.7 Hz
- Bin 2: 23.4 Hz
- ...
- Bin 86: ~1007 Hz (roughly middle of piano)
- Bin 256: ~3000 Hz (speech sibilance range)
- Bin 512: ~6000 Hz (bird song range)
- Bin 2048: 24,000 Hz (Nyquist)

---

## AudioKit (Open Source Swift Library)

Wraps AVAudioEngine with convenient APIs. MIT licensed, actively maintained.

### Relevant Components
- `AudioEngine` -- simplified engine management
- `FFTTap` -- frequency-domain data in a closure
- `NodeFFT` -- FFT node in the audio graph
- `Oscillator` / `PlaygroundOscillator` -- sine/square/saw/triangle generation
- `Microphone` -- mic input node

### Trade-off
Convenience vs. control. AudioKit is great for prototyping and may be sufficient for production. If you need fine-grained control over the audio graph or processing pipeline, going direct to AVAudioEngine is preferable.

---

## Latency Characteristics

| Configuration | Round-trip Latency |
|---|---|
| AVAudioEngine, 256 frame buffer | ~15-20ms |
| AVAudioEngine, 512 frame buffer | ~20-25ms |
| RemoteIO AudioUnit (low-level) | ~5-10ms |
| With echo cancellation active | +5-10ms |

For a drone composition app, latency is not critical -- you're not playing a keyboard. Even 50ms latency between detecting a frequency and generating a matching drone is imperceptible to users. This means you can use larger buffers (better FFT resolution) without any UX impact.

---

## Audio Session Modes

| Mode | Echo Cancellation | Signal Processing | Use Case |
|---|---|---|---|
| `.default` | No | Standard | Playback only |
| `.measurement` | No | Flat response | Raw mic analysis |
| `.voiceChat` | Yes | Optimized for speech | Not ideal |
| `.playAndRecord` (category) | Yes (auto) | Standard | Mic + speaker |

**Recommendation**: Use `.playAndRecord` category with `.measurement` mode for the most accurate frequency analysis. This gives you flat mic response without the speech-optimized processing that would color the frequency data.

---

## Background Audio

To continue running when the app is backgrounded:
1. Enable "Audio" background mode in Xcode capabilities
2. Set `AVAudioSession` category before going to background
3. The system will keep your audio engine running

Battery consideration: continuous mic capture + FFT + sine output will drain battery. Consider:
- Reducing FFT rate when backgrounded (analyze every 500ms instead of every frame)
- Allowing users to "lock in" a composition and stop mic analysis
- Displaying battery usage warnings
