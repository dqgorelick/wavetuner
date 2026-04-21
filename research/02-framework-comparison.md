# Framework Comparison for Real-Time Audio

## The Core Constraint

Real-time audio processing (mic capture -> FFT -> sine generation -> output) requires:
- Deterministic timing (no GC pauses, no UI thread blocking)
- Low latency (< 20ms round-trip)
- Direct access to platform audio APIs

No cross-platform framework runs DSP in its scripting layer. The question is: **how cleanly can the framework bridge to native audio code?**

---

## Option 1: Native (Swift + Kotlin) -- Recommended

### Pros
- Lowest latency, full API access, no bridge overhead
- Best debugging and profiling tools for audio (Instruments on iOS, Systrace on Android)
- SwiftUI and Jetpack Compose for modern, declarative UI
- Largest community resources for audio programming per-platform

### Cons
- Two UI codebases
- Different UI paradigms (though both are declarative now)

### Mitigation
Write the DSP engine in **C/C++** (shared between platforms). Only the UI and platform glue are duplicated. For a drone/oscillator app, the DSP core is the bulk of the complexity -- the UI is relatively simple.

### Architecture
```
[Swift UI] <-> [Swift Audio Bridge] <-> [C++ DSP Engine] <-> [AVAudioEngine]
[Kotlin UI] <-> [JNI Bridge]       <-> [C++ DSP Engine] <-> [Oboe]
```

---

## Option 2: Flutter + dart:ffi -- Best Cross-Platform Compromise

### Pros
- Single UI codebase (Dart) with native-quality rendering via Skia/Impeller
- `dart:ffi` calls C/C++ directly -- lower overhead than React Native's JS bridge
- `CustomPainter` is excellent for custom visualizations (GPU-accelerated)
- Growing ecosystem, strong Google backing

### Cons
- Dart itself cannot do real-time audio (single-threaded, GC)
- All audio code still lives in C/C++ via FFI
- Less mature audio ecosystem than native
- Debugging FFI code is harder than pure native

### Architecture
```
[Flutter UI / CustomPainter] <-> [dart:ffi] <-> [C++ DSP Engine]
                                                      |
                                            [AVAudioEngine / Oboe]
```

---

## Option 3: React Native -- Weakest for Audio

### Pros
- JavaScript/React expertise transfers from the existing web app
- Web Audio API concepts are familiar
- `react-native-skia` provides good visualization performance

### Cons
- JS bridge adds ~5-15ms latency per crossing (audio data must cross this bridge)
- No mature real-time audio library (best option: `react-native-audio-api`, still pre-1.0)
- Must write native modules for DSP anyway -- negating the "single codebase" benefit
- GC in both JS and native layers can cause audio glitches

### Architecture
```
[React Native UI / RN Skia] <-> [JS Bridge] <-> [Native Module] <-> [Platform Audio]
```

---

## Option 4: JUCE (Full C++ Framework)

### Pros
- Industry standard for professional audio apps (Native Instruments, Arturia, etc.)
- Complete solution: audio I/O, FFT, oscillators, UI, cross-platform
- Single C++ codebase for everything
- Battle-tested, huge community

### Cons
- GPL license (or paid commercial license)
- Its own UI system (not native look-and-feel)
- Steep learning curve if unfamiliar with C++
- Overkill for a relatively simple app

---

## Recommendation Matrix

| Factor | Native | Flutter | React Native | JUCE |
|---|---|---|---|---|
| Audio latency | Best | Good | Poor | Best |
| UI quality | Best | Great | Good | Custom |
| Development speed | Slower | Fast | Fast | Slow |
| Visualization perf | Best | Great | Good | Good |
| Code sharing | C++ core | C++ core + UI | Limited | Full |
| Ecosystem maturity | Best | Good | Weak (audio) | Best (audio) |
| **Verdict** | **Gold standard** | **Best compromise** | **Not recommended** | **If you love C++** |

## Practical Recommendation

**Start with native iOS (Swift + AVAudioEngine)** for the MVP. The app concept is audio-first, and Swift gives you the shortest path to a working prototype with the best tools.

If/when Android becomes a priority, extract the DSP into a shared C++ library. At that point, evaluate whether to:
- Write a native Kotlin Android app (sharing the C++ core)
- Port to Flutter (sharing both C++ core and UI)

This avoids premature abstraction while keeping the door open.
