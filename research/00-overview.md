# Wavetuner Mobile: Research Overview

## Vision

A mobile app (iOS-first, then Android) that:

1. **Listens** to the environment via microphone, performing real-time FFT frequency analysis
2. **Generates** algorithmic drone compositions using sine waves that either drown out or harmonize with detected frequencies
3. **Visualizes** the audio as a beautiful oscilloscope/Lissajous display (similar to the existing web app)
4. **Plays alongside** active noise cancellation headphones (ANC operates independently in hardware)

### Use Cases
- Walk through a park and "tune in" to bird frequencies while masking human-generated noise
- Create ambient drone compositions that respond to the sonic character of a space
- Meditative/generative audio that adapts to your environment in real-time

## Research Documents

| Document | Contents |
|---|---|
| [01-existing-webapp.md](./01-existing-webapp.md) | Analysis of the current web app's architecture and what can be reused |
| [02-framework-comparison.md](./02-framework-comparison.md) | React Native vs Flutter vs Native for real-time audio |
| [03-ios-audio.md](./03-ios-audio.md) | iOS audio APIs, FFT, mic capture, and simultaneous I/O |
| [04-android-audio.md](./04-android-audio.md) | Android audio APIs and cross-platform considerations |
| [05-anc-and-masking.md](./05-anc-and-masking.md) | How ANC works, what's feasible, and the masking approach |
| [06-visualization.md](./06-visualization.md) | GPU-accelerated oscilloscope rendering on mobile |
| [07-architecture-recommendation.md](./07-architecture-recommendation.md) | Recommended architecture and next steps |

## Key Findings (TL;DR)

- **Framework**: Native Swift (iOS) + shared C++ DSP core is the gold standard. Flutter + dart:ffi is the best cross-platform compromise. React Native is weakest for real-time audio.
- **FFT on iOS**: Apple's Accelerate/vDSP framework is NEON-optimized, a 4096-point FFT takes < 0.1ms on modern iPhones.
- **Simultaneous mic + speaker**: Well-supported on both platforms. iOS `.playAndRecord` session category handles it. Headphone use is the cleanest path (no echo concerns).
- **ANC**: Operates entirely in headphone hardware. No API access. Your app plays "inside" the ANC loop -- your audio is additive, ANC only cancels external sound. This is actually ideal: ANC reduces ambient noise, your app adds the generative composition.
- **Latency**: 10-20ms round-trip achievable on iOS, 15-40ms on Android. More than sufficient for drone composition (not a latency-critical use case).
- **Visualization**: Metal (iOS) or Skia (cross-platform) for 60fps oscilloscope rendering.
