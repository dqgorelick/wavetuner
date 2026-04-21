# Oscilloscope Visualization on Mobile

## Current Web Implementation

The web app uses Canvas 2D for a Lissajous curve:
- XY plot from left/right analyser channels
- 2048-point FFT feeding the visualization
- 20-minute color cycling
- Adaptive line width and sampling based on frequency content
- Glow and trail effects

## iOS: Metal

Apple's low-level GPU API.

### Approach
- Render waveform as a line strip or triangle strip with rounded caps
- Update vertex buffers each frame from audio callback data
- `MTKView` integrates with SwiftUI via `UIViewRepresentable`
- ProMotion displays support 120fps

### Performance
Massive overkill for a simple oscilloscope, but enables:
- Custom shaders for glow effects (fragment shader with Gaussian blur)
- Anti-aliased thick lines via triangle strips
- Post-processing effects (bloom, trails via render-to-texture with alpha decay)
- Thousands of points at 120fps with zero CPU overhead

### Simpler Alternative: Core Animation
- `CAShapeLayer` with `UIBezierPath` updated via `CADisplayLink`
- GPU-accelerated compositing
- Sufficient for hundreds of points at 60fps
- Much simpler code than Metal

## Android: OpenGL ES / Vulkan

### OpenGL ES 3.0
- Well-supported (Android 4.3+), simpler than Vulkan
- Render waveform as `GL_LINE_STRIP`
- `GLSurfaceView` with custom renderer
- Custom shaders for glow effects

### Hardware-Accelerated Canvas
- Android `Canvas.drawPath()` is hardware-accelerated by default
- 60fps feasible for moderate point counts
- Simplest approach, least control over effects

## Cross-Platform: Skia

The 2D graphics engine used internally by Flutter, Chrome, and Android.

### Via Flutter
- `CustomPainter` draws directly to Skia/Impeller canvas
- Paint paths, apply blur effects, control blend modes
- GPU-accelerated, 60fps trivially achievable
- Impeller (Flutter's Metal-backed renderer on iOS) eliminates shader compilation jank

### Via React Native
- `@shopify/react-native-skia` provides Skia access in RN
- Good performance for 2D graphics
- Shader support for custom effects

## Visualization Architecture

```
[Audio Thread]                    [Render Thread]
     |                                  |
  FFT Analysis                    CADisplayLink / 
  Peak Detection                  vsync callback
     |                                  |
     v                                  v
[Lock-free Ring Buffer] ------> Read latest FFT data
                                Compute vertex positions
                                Draw to screen
```

**Critical rule**: Never block the audio thread waiting for the render thread. Use a lock-free ring buffer or triple-buffering to decouple them.

## Lissajous on Mobile

The existing web app's Lissajous approach translates directly:

1. Route oscillators to separate L/R channels
2. Tap both channels with analysers
3. Plot left channel as X, right channel as Y
4. Apply visual effects (glow, trails, color cycling)

The only difference is the rendering API:
- Web: `ctx.lineTo()` on Canvas 2D
- iOS: `MTKView` or `CAShapeLayer`
- Android: `Canvas.drawPath()` or `GLSurfaceView`
- Flutter: `canvas.drawPath()` in `CustomPainter`

## Frequency Spectrum View (New for Mobile)

In addition to the Lissajous, consider a **spectrogram view** showing:
- X-axis: frequency (log scale, 20 Hz - 20 kHz)
- Y-axis: magnitude (dB)
- Color: which frequencies are being masked/harmonized
- Overlay: the generated drone frequencies as vertical lines

This gives users a functional view of what the app is doing alongside the aesthetic Lissajous view.

## Effects Worth Implementing

| Effect | Implementation | Cost |
|---|---|---|
| Glow / bloom | Fragment shader blur pass | Low (GPU) |
| Trail / persistence | Render to texture, blend with alpha decay | Low (GPU) |
| Color cycling | Uniform time variable in shader | Trivial |
| Thick anti-aliased lines | Triangle strip with rounded caps | Low |
| Background gradient | Simple gradient shader | Trivial |
| Particle emission at peaks | Particle system on frequency peaks | Medium |
