# LLM-Assisted Development Workflow & Platform Strategy

## What LLM-Assisted iOS Development Actually Looks Like

### The Good

**Swift + SwiftUI is one of the best languages for LLM-assisted development.** Apple's ecosystem is heavily documented, Swift is opinionated with strong types, and SwiftUI is declarative (similar mental model to React). LLMs have extensive training data on all of it.

Concrete things that go well:
- **SwiftUI layouts** -- declarative, composable, very similar to React. LLMs nail this.
- **AVAudioEngine setup** -- well-documented API, lots of example code in training data. The boilerplate (session config, node connections, tap installation) is routine.
- **vDSP/Accelerate FFT** -- there are canonical patterns. LLMs can produce working FFT code reliably.
- **Metal shaders** -- MSL (Metal Shading Language) is C-like. Shader code for glow/blur/trail effects is well-covered.
- **App lifecycle, permissions, Info.plist** -- rote configuration that LLMs handle well.

### The Bad

**Xcode is the bottleneck, not the code.** The hardest parts of iOS development for a newcomer aren't writing Swift -- they're:

1. **Xcode project configuration** -- signing, capabilities, entitlements, build settings. LLMs can tell you what to change but can't click the checkboxes. You'll spend time in Xcode's UI navigating settings panels.

2. **Provisioning & signing** -- Apple Developer account, certificates, profiles. This is a one-time pain but it's real. Budget a few hours the first time.

3. **Debugging audio on-device** -- the iOS Simulator does NOT support real microphone input or low-latency audio output. You must test on a physical device from day one. This means setting up device provisioning immediately.

4. **Xcode error messages** -- Swift compiler errors can be cryptic, especially with SwiftUI's type inference. LLMs are decent at interpreting these but sometimes hallucinate fixes.

5. **API deprecations** -- Apple deprecates APIs frequently. LLMs may suggest patterns from iOS 15 that are deprecated in iOS 18. Always specify your target iOS version when prompting.

6. **Audio thread constraints** -- the real-time audio callback has strict rules (no allocation, no locks, no ObjC messaging). LLMs sometimes generate code that violates these constraints. The result: audio glitches that are hard to diagnose. You'll need to understand this constraint yourself.

### Practical Workflow

```
You (intent/design)  -->  LLM (generates Swift code)  -->  Xcode (build/run)
         ^                                                       |
         |                                                       v
         +----------  LLM (interprets errors)  <--------  Build errors / 
                                                          runtime behavior
```

**What this looks like day-to-day:**
- Describe what you want in a component/feature
- LLM generates Swift/SwiftUI code
- Paste into Xcode, build, hit errors
- Feed errors back to LLM, iterate
- Test on device for audio features
- Use Xcode's Instruments for performance profiling (LLM can't do this for you)

**Realistic pace:** With LLM assistance and no prior iOS experience, expect:
- Days 1-3: Xcode setup, signing, getting "Hello World" on device, learning the project structure
- Days 3-7: Basic audio engine working (mic input + FFT + sine output)
- Weeks 2-3: Core feature loop (analysis -> composition -> visualization)
- Weeks 3-5: Polish, effects, UI refinement

### Tips for LLM-Assisted iOS Development

- **Keep files small and focused.** LLMs work best with single-responsibility files. One file per view, one file for the audio engine, one for FFT analysis.
- **Use SwiftUI previews.** They give you fast visual iteration without full builds. LLMs can generate preview code.
- **Start with iOS 17+ as minimum target.** Newer APIs are cleaner, better documented, and the LLM won't suggest deprecated patterns.
- **Don't fight Xcode.** When the LLM suggests a project configuration change, do it through Xcode's UI rather than editing pbxproj files directly. Those files are fragile.
- **Commit often.** Xcode + LLM iteration can go sideways fast. Small commits give you rollback points.

---

## Native iOS-First vs. Cross-Platform: Honest Trade-offs

### Option A: Native iOS First, Android Later

#### Pros
- **Fastest path to a working iOS app.** No abstraction layer between you and the platform. When you hit an audio issue, the Stack Overflow answer applies directly.
- **Best audio performance.** AVAudioEngine is purpose-built for this. No bridge latency, no framework quirks.
- **LLMs are strongest here.** More training data on native iOS audio than on any cross-platform audio bridge. You'll get better code generation.
- **Simpler debugging.** One platform, one set of tools (Xcode + Instruments), one set of behaviors to understand.
- **SwiftUI is genuinely good.** If you're coming from React, the mental model transfers. It's not a burden.
- **Metal for visualization.** Direct GPU access, no abstraction. The oscilloscope can be exactly what you want.

#### Cons
- **Android requires a second codebase.** When you get there, you're either writing Kotlin + Jetpack Compose (another new platform) or extracting shared C++ (non-trivial refactor).
- **iOS-only limits your audience.** ~55% US market share, ~27% global.
- **Risk of iOS-specific patterns baking in.** If you structure the app around AVAudioEngine's specific graph model, porting to Android's Oboe (which has a different model) requires rethinking.
- **Two app store processes.** Separate review, separate metadata, separate release cadence.

#### The "Later Android" Realistic Assessment
"Later" often means "much later" or "never" for solo developers. If Android is truly important to you, factor that into the initial decision. If it's a "nice to have," go native iOS and don't look back.

---

### Option B: Cross-Platform from Day One

The two real contenders are **Flutter** and **React Native**. JUCE is a third option if you want to go all-in on C++.

#### Flutter + dart:ffi

**Pros:**
- Single UI codebase. Write once, both platforms get the same oscilloscope, same controls.
- `CustomPainter` is excellent for custom 2D graphics (your oscilloscope). GPU-accelerated via Skia/Impeller.
- dart:ffi calls C/C++ directly -- lower overhead than RN's bridge.
- Hot reload for UI iteration (though not for native audio code).
- Growing ecosystem, strong tooling.

**Cons:**
- **The audio code is still native.** You're writing C++ (or platform-specific Swift/Kotlin) for all audio processing. dart:ffi is a bridge, and you're maintaining the bridge code.
- **You're learning three things at once:** Dart/Flutter, C++ audio, and the platform audio APIs. With native iOS, you're learning one thing (Swift/iOS).
- **LLM support for Flutter audio is weaker.** There isn't a well-established Flutter audio processing library. You'll be in less-charted territory.
- **Debugging across the FFI boundary is painful.** When audio glitches, is it the C++ code, the FFI bridge, or the Dart side? Hard to tell.
- **Flutter's audio ecosystem is immature.** No equivalent of AudioKit. You're building more from scratch.

#### React Native

**Pros:**
- JavaScript/React is familiar from your web app.
- `react-native-skia` handles the visualization well.
- Conceptually closest to your existing codebase.

**Cons:**
- **JS bridge kills audio performance.** Every audio buffer crossing the bridge adds 5-15ms latency. Real-time audio must live entirely in native modules.
- **You end up writing native modules anyway.** The "write once" promise breaks down for audio-heavy apps. You're writing Swift and Kotlin native modules, plus the JS glue.
- **`react-native-audio-api` is pre-1.0.** The most promising RN audio library is still immature.
- **Worst of both worlds for this use case.** You get the complexity of cross-platform without the audio benefits. You still need to know iOS and Android audio APIs.

#### JUCE (C++ Everything)

**Pros:**
- True write-once for audio AND UI. Used by professional audio app developers.
- Built-in FFT, oscillators, audio I/O, cross-platform.
- Industry-standard. If you learn JUCE, you can build any audio app.

**Cons:**
- JUCE's UI looks like a desktop plugin, not a modern mobile app. Not "beautiful" by default.
- C++ is a harder language for LLM-assisted development (memory management, build systems).
- GPL license unless you pay for commercial.
- Steep learning curve.

---

## Decision Matrix: What Actually Matters for This Project

| Factor | Weight | Native iOS | Flutter | React Native | JUCE |
|---|---|---|---|---|---|
| Time to working prototype | High | **Best** | Medium | Medium | Slow |
| Audio quality/correctness | High | **Best** | Good (C++) | Poor | **Best** |
| LLM code generation quality | High | **Best** | Good | Good (JS) | Weak |
| Visualization quality | High | **Best** (Metal) | Great (Skia) | Good (Skia) | OK |
| Android "later" cost | Medium | High | **Low** | Medium | **Low** |
| Learning curve for you | Medium | Medium | High (3 things) | **Low** | Very High |
| Long-term maintainability | Medium | Good | Good | Poor | Good |
| Dependency risk | Low | **None** | Low | High | Low |

## Recommendation

**Go native iOS.** Here's why, specific to your situation:

1. **You're building this for yourself first.** You don't need Android market share. You need a working tool on your phone.

2. **The audio processing is the hard part, not the UI.** Cross-platform frameworks save you UI code but don't help with audio. The audio code is platform-specific regardless of framework choice.

3. **LLM-assisted development favors native.** You'll get more reliable code generation, clearer error messages, and better debugging. When you're leaning heavily on LLMs, reducing the number of abstraction layers reduces the number of things that can go wrong.

4. **The "Android tax" is deferred, not eliminated.** With Flutter, you pay the cross-platform tax on day one (learning Dart, managing FFI, debugging across boundaries). With native iOS, you pay nothing now and pay the Android tax only if/when you actually want Android. That tax is real but finite -- and by then you'll deeply understand the audio architecture, making the port more straightforward.

5. **The visualization wants Metal.** Your oscilloscope is a core part of the experience. Metal gives you direct GPU access for exactly the effects you want (glow, trails, color cycling). Cross-platform graphics layers can do this but with more indirection.

If you later decide Android is essential and a second native codebase feels like too much, you can evaluate Flutter at that point with the benefit of a working iOS app to port from, rather than designing speculatively for two platforms.
