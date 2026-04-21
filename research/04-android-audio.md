# Android Audio: APIs and Considerations

## Oboe (Recommended)

Google's C++ library for low-latency audio on Android. Wraps AAudio (8.1+) with OpenSL ES fallback.

### Key Capabilities
- **Microphone capture**: `AudioStream` with `Direction::Input`, callback-based
- **Sine output**: Output stream, fill buffers in `onAudioReady()` callback
- **Simultaneous I/O**: `FullDuplexStream` helper for synchronized input + output
- **Low latency**: `PerformanceMode::LowLatency` + exclusive MMAP mode on AAudio devices

### FFT Libraries (Oboe doesn't include FFT)
| Library | License | Notes |
|---|---|---|
| **KissFFT** | Public domain | Small, simple C, easy to bundle |
| **PFFFT** | BSD | SIMD-optimized (NEON on ARM), very fast |
| **Ne10** | BSD-3 | ARM NEON-optimized DSP from ARM Inc. |

**Recommendation**: PFFFT for production (NEON optimization matters on mobile), KissFFT for prototyping (simpler API).

### Latency Reality on Android

Android audio latency varies enormously by device:

| Device Category | Typical Round-trip |
|---|---|
| Google Pixel (latest) | 10-20ms |
| Samsung Galaxy S flagship | 15-30ms |
| Mid-range phones | 30-50ms |
| Budget phones | 50-100ms+ |

Use `AudioManager.getProperty(PROPERTY_OUTPUT_FRAMES_PER_BUFFER)` to get the optimal buffer size for each device.

Again: for a drone composition app, this latency is a non-issue.

---

## Echo Cancellation on Android

- `AcousticEchoCanceler` in `android.media.audiofx` -- attach to input stream's session ID
- Effectiveness varies significantly by OEM
- `AUDIO_SOURCE_UNPROCESSED` (API 24+): raw mic without AEC/AGC/noise suppression

---

## Android vs iOS: Key Differences

| Aspect | iOS | Android |
|---|---|---|
| Audio API | AVAudioEngine (Swift) | Oboe (C++) |
| FFT | Accelerate/vDSP (built-in) | Must bundle a library |
| Latency | Consistent (~15-20ms) | Varies wildly by device |
| Echo cancellation | Excellent, built-in | Device-dependent |
| Background audio | Reliable with capability | Foreground service required |
| API fragmentation | None (one hardware vendor) | Significant |

---

## Practical Considerations

### Foreground Service
Android requires a foreground service notification for continuous audio processing in the background. Users will see a persistent notification. This is a platform requirement, not optional.

### Audio Focus
Android's audio focus system means other apps can interrupt your audio. Handle `AUDIOFOCUS_LOSS` and `AUDIOFOCUS_GAIN` events to pause/resume gracefully.

### Permissions
- `RECORD_AUDIO` permission required
- Google Play requires "prominent disclosure" before the permission request (an in-app dialog explaining why)
- Data Safety section must disclose mic access

---

## Cross-Platform C++ DSP Core

If sharing code between iOS and Android, the DSP engine should be a standalone C++ library:

```
libwavetuner-dsp/
  include/
    frequency_analyzer.h    // FFT -> frequency bins -> peak detection
    drone_composer.h        // Frequency bins -> sine wave parameters
    oscillator_bank.h       // Multiple sine wave generators
    ring_buffer.h           // Lock-free audio data transfer
  src/
    frequency_analyzer.cpp  // Uses PFFFT or platform FFT
    drone_composer.cpp
    oscillator_bank.cpp
```

This library would be:
- Linked via Xcode on iOS (C++ interop with Swift)
- Linked via CMake/ndk-build on Android (JNI or Oboe callback)
- Pure C++ with no platform dependencies (FFT library abstracted)
