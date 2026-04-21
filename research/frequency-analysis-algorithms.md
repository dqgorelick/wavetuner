# Frequency Analysis Algorithms for Wavetuner

> Research document covering spectral analysis, dominant frequency extraction, response generation, and platform implementation for an environmental audio deconstruction system.

---

## Table of Contents

1. [Frequency Analysis Algorithms](#1-frequency-analysis-algorithms)
2. [Dominant Frequency Extraction](#2-dominant-frequency-extraction)
3. [Response Generation (Sine Wave Composition)](#3-response-generation-sine-wave-composition)
4. [Platform-Specific Implementation Notes](#4-platform-specific-implementation-notes)
5. [Architecture Recommendations](#5-architecture-recommendations)
6. [Recommended Approach](#6-recommended-approach)

---

## 1. Frequency Analysis Algorithms

### 1.1 FFT (Fast Fourier Transform)

The FFT is the workhorse of spectral analysis. It decomposes a time-domain signal into its constituent frequency components in O(N log N) time.

**Key relationships:**

| Parameter | Formula | Example (44.1kHz) |
|---|---|---|
| Frequency resolution | `Fs / N` | 4096-point: **10.77 Hz** |
| Max detectable frequency | `Fs / 2` (Nyquist) | **22,050 Hz** |
| Time window duration | `N / Fs` | 4096-point: **92.9 ms** |
| Number of frequency bins | `N / 2 + 1` | 4096-point: **2049 bins** |

**Common FFT sizes and their trade-offs at 44.1kHz:**

| FFT Size (N) | Freq Resolution | Window Duration | Use Case |
|---|---|---|---|
| 256 | 172.3 Hz | 5.8 ms | Ultra-low latency, poor freq detail |
| 512 | 86.1 Hz | 11.6 ms | Low latency monitoring |
| 1024 | 43.1 Hz | 23.2 ms | Reasonable compromise |
| 2048 | 21.5 Hz | 46.4 ms | Good frequency detail |
| 4096 | 10.8 Hz | 92.9 ms | High frequency detail |
| 8192 | 5.4 Hz | 185.8 ms | Very high detail, high latency |
| 16384 | 2.7 Hz | 371.5 ms | Near-individual-note resolution |

**Window functions** are essential to reduce spectral leakage. The choice matters:

- **Hann (Hanning):** Best general-purpose window. Good frequency resolution, moderate side-lobe suppression (-31 dB). Main lobe width: 4 bins. This is the default recommendation.
- **Hamming:** Similar to Hann but discontinuous at edges. Side lobes at -43 dB but decay more slowly.
- **Blackman-Harris:** Excellent side-lobe suppression (-92 dB) at the cost of a wider main lobe (8 bins). Good when you need to detect weak signals near strong ones.
- **Flat-top:** Best amplitude accuracy (0.01 dB error vs ~1.4 dB for Hann), but worst frequency resolution. Use for calibration.
- **Rectangular (no window):** Narrowest main lobe but worst leakage (-13 dB side lobes). Almost never the right choice for environmental audio.

For wavetuner, **Hann** is the starting point. Switch to **Blackman-Harris** if you need to detect quiet tonal components buried near loud ones.

**Overlap** improves temporal resolution without changing frequency resolution. Standard practice is 50% overlap (hop size = N/2) with a Hann window, which provides smooth temporal evolution. For realtime tracking, 75% overlap (hop size = N/4) gives better time resolution at 4x the computational cost.

### 1.2 STFT (Short-Time Fourier Transform)

The STFT is simply a sequence of overlapping FFTs applied to consecutive frames of audio. It produces a **spectrogram** -- a 2D representation of frequency content over time.

```
Signal: [============================]
Frame 1:  [----window----]
Frame 2:      [----window----]         (50% overlap)
Frame 3:          [----window----]
...

Each frame -> FFT -> one column of the spectrogram
```

**The fundamental trade-off:** Time resolution and frequency resolution are inversely related. This is not a limitation of the algorithm; it is a property of signals themselves (the Gabor limit, analogous to the Heisenberg uncertainty principle).

- Want to know *exactly* what frequency? Use a long window. But you lose time precision.
- Want to know *exactly* when* something happened? Use a short window. But you lose frequency precision.

For wavetuner's realtime mode, the STFT is the primary analysis tool. Parameters:

```
FFT size:    2048 or 4096
Window:      Hann
Hop size:    512 (75% overlap with 2048) or 1024 (50% overlap)
Sample rate: 44100 Hz or 48000 Hz
```

This gives a new spectral frame every 11.6 ms (hop=512) or 23.2 ms (hop=1024), which is fast enough for smooth realtime response.

### 1.3 Constant-Q Transform (CQT)

The CQT uses logarithmically-spaced frequency bins, meaning each bin has a constant ratio (Q factor) between its center frequency and bandwidth. This mirrors how human hearing and musical pitch work -- octaves are logarithmic.

**Why it matters for wavetuner:**

- Standard FFT: bins are linearly spaced. At 10.8 Hz resolution, you get the same 10.8 Hz precision at 100 Hz and at 10,000 Hz. This is wasteful at high frequencies (where 10 Hz differences are inaudible) and insufficient at low frequencies (where 10 Hz is the difference between musical notes).
- CQT: bins are log-spaced. A 12-bins-per-octave CQT matches the Western chromatic scale. Each bin is ~6% wide relative to its center frequency.

**CQT parameters:**

| Parameter | Typical Value | Notes |
|---|---|---|
| Bins per octave | 12, 24, 36, or 48 | 12 = chromatic, 24 = quarter-tone |
| Minimum frequency | 27.5 Hz (A0) or 55 Hz (A1) | Sets the lowest analysis frequency |
| Maximum frequency | 8000-16000 Hz | Upper bound |
| Q factor | ~24 at 24 bins/octave | Higher Q = narrower bins relative to frequency |

**Trade-offs vs FFT:**

- Pro: Much better low-frequency resolution relative to human perception
- Pro: Directly maps to musical pitch
- Con: Significantly more expensive to compute (O(N^2) naive, though efficient implementations exist)
- Con: Variable time resolution (long windows at low frequencies, short at high)
- Con: Not natively available in Web Audio API

**Recommendation for wavetuner:** Use standard FFT/STFT for the browser prototype. Consider CQT for the native app if musical mapping is a priority. Libraries like `essentia.js` provide CQT in the browser if needed.

### 1.4 Goertzel Algorithm

The Goertzel algorithm computes the energy at a **single specific frequency** in O(N) time, compared to O(N log N) for a full FFT. It is optimal when you only need a handful of frequency bins.

**When Goertzel beats FFT:**

- If you need fewer than ~log2(N) frequency bins, Goertzel is faster
- For a 4096-point transform, that threshold is about 12 bins
- Perfect for: "is there energy at 60 Hz (mains hum)?" or "check these 8 specific frequencies"

**Wavetuner application:** Use Goertzel for **targeted monitoring** after the initial FFT analysis identifies dominant frequencies. In the realtime pipeline, once you know the top 5-10 frequencies to track, switch to Goertzel for lower-latency tracking between full FFT frames.

```javascript
// Goertzel for a single frequency
function goertzel(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const k = Math.round(N * targetFreq / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);

  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  // Power at target frequency
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}
```

### 1.5 Spectral Peak Detection

Raw FFT output contains thousands of bins. Extracting meaningful "dominant frequencies" requires peak detection.

**Basic peak picking:**

1. Compute magnitude spectrum: `|X[k]| = sqrt(re[k]^2 + im[k]^2)`
2. Convert to dB: `20 * log10(|X[k]| / reference)`
3. Find local maxima: bins where `|X[k]| > |X[k-1]|` and `|X[k]| > |X[k+1]|`
4. Apply threshold: discard peaks below noise floor + margin
5. Sort by magnitude, take top N

**Parabolic interpolation** refines the frequency estimate beyond bin resolution. Since the true peak usually falls between bins, fit a parabola through the peak bin and its two neighbors:

```javascript
function interpolatePeak(magnitudes, peakBin, sampleRate, fftSize) {
  const alpha = magnitudes[peakBin - 1];  // left neighbor (dB)
  const beta  = magnitudes[peakBin];      // peak (dB)
  const gamma = magnitudes[peakBin + 1];  // right neighbor (dB)

  // Fractional bin offset (-0.5 to +0.5)
  const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);

  // Interpolated frequency
  const freq = (peakBin + p) * sampleRate / fftSize;

  // Interpolated magnitude
  const magDB = beta - 0.25 * (alpha - gamma) * p;

  return { freq, magDB };
}
```

This improves frequency accuracy from bin-width (~10.8 Hz for 4096 FFT) to roughly **1-2 Hz** in typical conditions. For wavetuner, this is critical -- a 10 Hz error in the generated response tone would produce audible beating artifacts.

### 1.6 Mel-Frequency and Bark Scale Analysis

Human hearing is not linear. We perceive the difference between 100 Hz and 200 Hz as much larger than the difference between 5000 Hz and 5100 Hz. Perceptual frequency scales account for this.

**Mel scale:**

```
mel = 2595 * log10(1 + f / 700)
```

Commonly used with triangular filter banks (as in MFCCs for speech/audio ML). Typical configuration: 26-40 mel bands spanning 0-8000 Hz (or up to Nyquist).

**Bark scale:**

The Bark scale divides the audible range into 24 **critical bands**, which correspond to the bandpass filtering that occurs in the cochlea. This is more directly useful for psychoacoustic analysis.

| Bark Band | Center Freq (Hz) | Bandwidth (Hz) |
|---|---|---|
| 1 | 50 | 80 |
| 2 | 150 | 100 |
| 3 | 250 | 100 |
| 5 | 450 | 110 |
| 10 | 1170 | 280 |
| 15 | 3400 | 700 |
| 20 | 7700 | 2500 |
| 24 | 15500 | 3500 |

**Wavetuner application:** Use Bark-scale critical bands to group detected frequencies into perceptually meaningful regions. Instead of responding to each of 50 detected peaks individually, group them by critical band and generate one tonal response per band. This produces a more coherent, less chaotic output.

### 1.7 Welch's Method / Periodogram

For the **snapshot/fingerprint mode** (5-second captures), a single FFT is not optimal. The raw periodogram (single FFT of the entire signal) has high variance -- it is a noisy estimate of the true power spectral density.

**Welch's method** reduces variance by:

1. Dividing the signal into overlapping segments
2. Windowing each segment
3. Computing the FFT of each segment
4. Averaging the magnitude-squared spectra

```
5-second capture at 44.1kHz = 220,500 samples

Welch's parameters:
  Segment length: 4096 samples (92.9 ms)
  Overlap: 50% (hop = 2048)
  Number of segments: floor((220500 - 4096) / 2048) + 1 = ~106 segments
  Window: Hann

Result: averaged power spectrum with 2049 frequency bins
        frequency resolution: 10.77 Hz
        variance reduced by factor of ~106 compared to single periodogram
```

The result is a smooth, reliable spectral estimate that represents the **average** frequency content over the 5-second window. This is exactly what you want for a fingerprint -- a stable characterization of the acoustic environment, not a moment-by-moment account.

**Confidence metric:** The number of segments also gives you a natural confidence measure. With 106 averages, you can compute confidence intervals on each bin's power estimate using chi-squared statistics.

---

## 2. Dominant Frequency Extraction

### 2.1 Peak Detection Strategies

**Threshold-based:**

The simplest approach. Set a dB threshold (e.g., -40 dBFS) and only consider peaks above it.

- Pro: Simple, fast
- Con: Fails in varying noise conditions. A quiet room and a loud street need different thresholds.

**Prominence-based (recommended):**

A peak's **prominence** is how much it stands out from its surroundings. Compute it as the height of the peak above the higher of the two nearest valleys (minima) on either side.

```
Spectrum:    ___/\___/\   /\______
                 P1   P2  P3

P1: prominence = height above valleys on either side
P2: low prominence (barely rises above neighbors) -> likely not meaningful
P3: high prominence -> likely a real tonal component
```

A minimum prominence threshold of **6-10 dB** works well for environmental audio. This automatically adapts to the overall level.

**Spectral flatness gating:**

Before doing peak detection at all, check the spectral flatness (ratio of geometric mean to arithmetic mean of the spectrum). A value near 1.0 means the spectrum is noise-like (flat) and contains no meaningful peaks. A value near 0.0 means strong tonal components exist.

```javascript
function spectralFlatness(magnitudes) {
  const N = magnitudes.length;
  let logSum = 0;
  let linearSum = 0;
  for (let i = 0; i < N; i++) {
    logSum += Math.log(magnitudes[i] + 1e-10);
    linearSum += magnitudes[i];
  }
  const geometricMean = Math.exp(logSum / N);
  const arithmeticMean = linearSum / N;
  return geometricMean / (arithmeticMean + 1e-10);
}
// < 0.1 = strong tonal content, > 0.8 = mostly noise
```

### 2.2 Spectral Descriptors

Beyond raw peaks, these aggregate descriptors characterize the spectrum:

**Spectral centroid** -- the "center of mass" of the spectrum. Indicates perceived brightness.

```
centroid = sum(f[k] * |X[k]|^2) / sum(|X[k]|^2)
```

A centroid of 2000 Hz means the audio "sounds" centered around 2 kHz. Useful for wavetuner to set the overall register of the tonal response.

**Spectral spread** -- the standard deviation around the centroid. Wide spread = broadband noise. Narrow spread = concentrated tonal content.

**Spectral flux** -- the frame-to-frame change in the spectrum. High flux indicates transients (percussive sounds, speech). Low flux indicates steady-state (drones, HVAC, traffic hum).

```javascript
function spectralFlux(currentFrame, previousFrame) {
  let flux = 0;
  for (let i = 0; i < currentFrame.length; i++) {
    const diff = currentFrame[i] - previousFrame[i];
    flux += Math.max(0, diff); // half-wave rectified: only increases
  }
  return flux;
}
```

**Wavetuner use:** Spectral flux can trigger mode changes. High flux (someone talking, music playing) might call for a different response strategy than low flux (steady hum of an air conditioner).

### 2.3 Fundamental Frequency Estimation

Environmental audio often contains harmonic series -- a fundamental frequency F0 with overtones at 2*F0, 3*F0, etc. The FFT will show peaks at all harmonics, but you want to identify the fundamental.

**Autocorrelation method:**

Compute the autocorrelation of the signal and find the first significant peak after the origin. The lag of that peak corresponds to the period of the fundamental.

```
Period (samples) = lag of first autocorrelation peak
F0 = sampleRate / period
```

Works well for periodic signals but struggles with noise.

**YIN algorithm:**

An improved autocorrelation method designed for pitch detection. Key steps:

1. Compute the **difference function** (related to autocorrelation)
2. Apply **cumulative mean normalization** (removes the bias toward short lags)
3. Apply an **absolute threshold** (typically 0.1-0.2)
4. Use **parabolic interpolation** on the selected lag

YIN achieves pitch detection accuracy within ~0.5% for clean signals. The `pitchyin` function in many audio libraries implements this.

**pYIN (Probabilistic YIN):**

Extends YIN by outputting multiple pitch candidates with probabilities, then uses a hidden Markov model (HMM) to select the most likely pitch trajectory over time. This is the state of the art for monophonic pitch tracking and handles noisy signals much better than basic YIN.

**Wavetuner application:** Use harmonic detection to **simplify the response**. If you detect peaks at 220, 440, 660, and 880 Hz, recognize this as a single harmonic series with F0 = 220 Hz. Generate a response based on the fundamental rather than responding to each harmonic independently.

### 2.4 Noise Floor Estimation and Adaptive Thresholding

Environmental audio always has a noise floor. Detecting it and adapting your threshold is crucial.

**Minimum statistics method:**

Track the minimum power in each frequency bin over a sliding window of several seconds. The noise floor tends to be the minimum value, since tonal components come and go but the noise floor is relatively constant.

```javascript
class NoiseFloorEstimator {
  constructor(numBins, historyLength = 50) {
    // Ring buffer of recent spectra
    this.history = [];
    this.historyLength = historyLength;
    this.numBins = numBins;
  }

  update(spectrum) {
    this.history.push([...spectrum]);
    if (this.history.length > this.historyLength) {
      this.history.shift();
    }
  }

  getNoiseFloor() {
    const floor = new Float32Array(this.numBins);
    for (let bin = 0; bin < this.numBins; bin++) {
      let min = Infinity;
      for (let frame = 0; frame < this.history.length; frame++) {
        if (this.history[frame][bin] < min) {
          min = this.history[frame][bin];
        }
      }
      floor[bin] = min;
    }
    return floor;
  }
}
```

Set your peak detection threshold at **noise floor + 6 to 12 dB** per bin. This adapts automatically to different environments.

**Wavetuner application:** In the realtime mode, continuously update the noise floor estimate. Peaks must exceed the adaptive threshold to be considered "dominant." This prevents the system from responding to random noise fluctuations while still catching genuine tonal events.

### 2.5 Frequency Tracking Across Frames

In realtime mode, peaks appear in consecutive FFT frames. Naive frame-by-frame peak detection produces jittery, unstable frequency estimates. You need **track association** to link peaks across frames.

**Simple nearest-neighbor tracking:**

1. Maintain a list of active tracks, each with a current frequency and amplitude
2. For each new frame, match detected peaks to existing tracks by minimum frequency distance
3. If a peak has no nearby track, start a new track
4. If a track has no nearby peak for N consecutive frames, terminate it

**Frequency tolerance:** Allow up to ~2% frequency drift between frames (roughly a quarter-tone). Larger drift means a new event.

**Exponential smoothing:**

```javascript
function smoothFrequency(tracked, detected, alpha = 0.3) {
  return alpha * detected + (1 - alpha) * tracked;
}
```

An alpha of 0.1-0.3 provides stable tracking while still responding to real changes within a few frames.

**Wavetuner application:** Frequency tracking is critical for the realtime mode. Without it, the generated response tones will jump erratically. With tracking, the response smoothly follows the evolving environmental audio.

---

## 3. Response Generation (Sine Wave Composition)

### 3.1 Mapping Detected Frequencies to Generated Tones

Several mapping strategies, ranging from literal to creative:

**Direct mirroring:**

Generate tones at the exact detected frequencies. The output "reflects" the input spectrum. This is the simplest approach and useful as a baseline.

**Harmonic complement:**

For each detected frequency F, generate tones at harmonically related frequencies that are *not* present in the input. For example, if the input has energy at 200 Hz and 400 Hz (harmonics 1 and 2), generate 600 Hz (harmonic 3) and 800 Hz (harmonic 4) to "complete" the harmonic series.

**Intervallic mapping:**

Map detected frequencies to musically related tones -- a perfect fifth above (ratio 3:2), a major third (5:4), an octave (2:1). This creates consonant or dissonant textures depending on the chosen intervals.

**Inverse spectral weighting:**

Generate tones that are strong where the environment is quiet and quiet where the environment is loud. This fills in the "gaps" in the environmental spectrum, creating an acoustically complementary texture.

```javascript
function inverseSpectralMap(envSpectrum, minFreq, maxFreq, numTones) {
  // Find frequency regions with lowest energy
  const valleys = findSpectralValleys(envSpectrum, minFreq, maxFreq);
  // Generate tones at valley frequencies
  return valleys.slice(0, numTones).map(v => ({
    frequency: v.freq,
    amplitude: scaleAmplitude(v.depth) // deeper valley = louder tone
  }));
}
```

### 3.2 Phase Relationships and Beating

When generated tones are close in frequency to environmental sounds, **beating** occurs. Two tones at frequencies F1 and F2 produce an amplitude modulation at rate |F1 - F2|.

- |F1 - F2| < 1 Hz: slow pulsing, almost phase-cancellation territory
- |F1 - F2| = 1-8 Hz: perceptible beating, can feel unsettling or "wobbly"
- |F1 - F2| = 8-15 Hz: rough, dissonant texture
- |F1 - F2| > 15 Hz: two distinct tones perceived

**For wavetuner:** Beating is a powerful creative tool. Intentionally placing generated tones 1-4 Hz away from detected frequencies creates slow, evolving textures. Placing them exactly on the detected frequencies (with controlled phase) approaches noise cancellation territory.

Phase control matters most when the generated tone is near-identical in frequency to an environmental component. In practice, you cannot control the relative phase between your speaker output and the ambient sound (it depends on room acoustics, speaker placement, etc.), so true phase cancellation is unreliable outside of headphones. Focus on **frequency relationships** rather than phase relationships.

### 3.3 Psychoacoustic Considerations

**Auditory masking:**

A loud tone masks nearby frequencies. The masking pattern is asymmetric -- it extends further upward in frequency than downward. A 1 kHz tone at 60 dB masks frequencies from roughly 800-1500 Hz.

Implication: If the environment has a strong 1 kHz component, generating tones at 1.1 kHz or 900 Hz may be inaudible due to masking. Either generate tones outside the masking region or generate them loud enough to exceed the masking threshold.

**Critical bands:**

The ear groups frequencies within a critical band (~100 Hz wide at low frequencies, ~20% of center frequency at higher frequencies). Two tones within the same critical band interact (roughness, beating). Two tones in different critical bands are perceived independently.

Map this to wavetuner: Use critical band analysis (Bark scale) to ensure generated tones are placed in perceptually distinct regions from the environmental audio, unless beating/roughness is the desired effect.

**Equal loudness contours (Fletcher-Munson):**

Human hearing is most sensitive around 2-5 kHz and much less sensitive at low and high frequencies. A generated tone at 100 Hz needs to be much louder (in SPL) than one at 3 kHz to be perceived at the same loudness.

Apply A-weighting or equal-loudness compensation to the generated tone amplitudes so that the perceptual loudness is uniform across frequency.

### 3.4 ANC vs. Deconstructive Tonal Response

**Active Noise Cancellation (ANC):**

- Generates an *anti-phase* copy of the unwanted sound
- Requires precise phase alignment (within a few degrees)
- Requires latency under ~1 ms for broadband cancellation
- Works reliably only in controlled acoustic environments (headphones, car cabins, ducts)
- Goal: silence

**Wavetuner's deconstructive approach:**

- Generates musically/tonally related sounds inspired by the environment
- Phase alignment is not critical
- Latency requirements are relaxed (50-200 ms acceptable)
- Works in any environment since it is additive, not cancellative
- Goal: transform the sonic environment, not silence it

This distinction is fundamental. Wavetuner does not need the extreme latency and phase precision of ANC. This makes browser-based implementation entirely feasible.

### 3.5 Envelope Shaping

Raw sine waves sound harsh and clinical. Apply amplitude envelopes for a musical output.

**ADSR envelope:**

```
Amplitude
  |    /\
  |   /  \___________
  |  /    |          |\
  | /     |          | \
  |/______|__________|__\____
    A   D    S          R

A = Attack (5-50 ms for smooth onset, avoids clicks)
D = Decay (50-200 ms)
S = Sustain level (0.3-0.8 of peak)
R = Release (100-500 ms for smooth fade)
```

For the realtime mode, tones should fade in when a frequency is first detected and fade out when it disappears. Use exponential envelopes to avoid abrupt transitions:

```javascript
function createToneEnvelope(audioContext, gainNode, targetGain, rampTime = 0.05) {
  gainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, rampTime);
}
```

The `setTargetAtTime` method in Web Audio provides exponential ramping, which sounds more natural than linear ramps.

### 3.6 Additive Synthesis

Wavetuner's output is fundamentally **additive synthesis** -- combining multiple sine waves to create a complex tone.

```javascript
class AdditiveVoice {
  constructor(audioContext, frequency, amplitude) {
    this.osc = audioContext.createOscillator();
    this.gain = audioContext.createGain();

    this.osc.type = 'sine';
    this.osc.frequency.value = frequency;
    this.gain.gain.value = 0; // start silent

    this.osc.connect(this.gain);
    this.osc.start();
  }

  setFrequency(freq, rampTime = 0.05) {
    this.osc.frequency.setTargetAtTime(freq, this.osc.context.currentTime, rampTime);
  }

  setAmplitude(amp, rampTime = 0.05) {
    this.gain.gain.setTargetAtTime(amp, this.osc.context.currentTime, rampTime);
  }

  connect(destination) {
    this.gain.connect(destination);
  }

  stop(fadeTime = 0.1) {
    const now = this.osc.context.currentTime;
    this.gain.gain.setTargetAtTime(0, now, fadeTime);
    this.osc.stop(now + fadeTime * 5); // stop after fade completes
  }
}
```

**Voice management:**

Maintain a pool of 8-16 oscillator voices. As dominant frequencies are detected and tracked:

- Assign free voices to new frequency tracks
- Update active voices when tracked frequencies change
- Release voices when tracks are terminated
- Use smooth parameter transitions (50 ms ramp time) to avoid artifacts

Limit the total number of simultaneous voices to prevent CPU overload and auditory clutter. In practice, 4-8 simultaneous tones is the sweet spot -- enough for richness, not so many that it becomes noise.

---

## 4. Platform-Specific Implementation Notes

### 4.1 Web Audio API (Browser Prototype)

The Web Audio API provides a built-in audio graph model with analysis and synthesis nodes.

**AnalyserNode:**

The quickest path to spectral data. It performs a real-time FFT on the audio stream.

```javascript
const audioContext = new AudioContext({ sampleRate: 44100 });
const analyser = audioContext.createAnalyser();

analyser.fftSize = 4096;        // power of 2, range: 32-32768
analyser.smoothingTimeConstant = 0.8;  // 0 = no smoothing, 1 = max
analyser.minDecibels = -90;
analyser.maxDecibels = -10;

// Connect mic input
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const source = audioContext.createMediaStreamSource(stream);
source.connect(analyser);

// Read spectrum
const freqData = new Float32Array(analyser.frequencyBinCount); // N/2
analyser.getFloatFrequencyData(freqData); // dB values

const timeData = new Float32Array(analyser.fftSize);
analyser.getFloatTimeDomainData(timeData); // raw samples
```

**Limitations of AnalyserNode:**

- Uses a Blackman window (not configurable)
- `smoothingTimeConstant` applies exponential averaging that obscures transients (set to 0 for raw data)
- No access to phase information (magnitude only)
- No hop size control -- it always uses the most recent N samples
- No overlap-add or proper STFT

**AudioWorklet (recommended for production):**

For full control, use an AudioWorklet to access raw sample data and implement your own FFT.

```javascript
// processor.js (runs in audio thread)
class AnalysisProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0][0]; // mono channel
    if (!input) return true;

    // Accumulate samples
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.bufferIndex++] = input[i];

      if (this.bufferIndex >= this.buffer.length) {
        // Buffer full -- send to main thread for analysis
        this.port.postMessage({
          type: 'buffer',
          data: new Float32Array(this.buffer)
        });
        // Overlap: shift by hop size
        this.buffer.copyWithin(0, 2048); // 50% overlap
        this.bufferIndex = 2048;
      }
    }
    return true;
  }
}
registerProcessor('analysis-processor', AnalysisProcessor);
```

```javascript
// Main thread
await audioContext.audioWorklet.addModule('processor.js');
const workletNode = new AudioWorkletNode(audioContext, 'analysis-processor');
source.connect(workletNode);

workletNode.port.onmessage = (event) => {
  if (event.data.type === 'buffer') {
    const spectrum = performFFT(event.data.data); // use a JS FFT library
    const peaks = detectPeaks(spectrum);
    updateSynthesis(peaks);
  }
};
```

**FFT libraries for the browser:**

- **fft.js** -- pure JS, fast, well-tested. ~10x faster than naive implementations. Handles up to 2^16 = 65536 points easily.
- **KissFFT compiled to WASM** -- near-native performance. Best for heavy workloads.
- **dsp.js** -- older library, includes FFT, windowing, and various filters. Less maintained.

**ScriptProcessorNode:** Deprecated. Do not use for new development. It runs on the main thread and causes audio glitches under load.

**Synthesis side:**

Web Audio's OscillatorNode and GainNode are sufficient for additive synthesis. Create oscillators for each voice and control their parameters with audio-rate scheduling:

```javascript
const osc = audioContext.createOscillator();
const gain = audioContext.createGain();
osc.type = 'sine';
osc.frequency.setValueAtTime(440, audioContext.currentTime);
gain.gain.setValueAtTime(0.1, audioContext.currentTime);
osc.connect(gain).connect(audioContext.destination);
osc.start();
```

Use `setTargetAtTime` for smooth transitions and `linearRampToValueAtTime` for precise control.

### 4.2 iOS (AVAudioEngine / Accelerate / AudioUnit)

**AVAudioEngine** is Apple's high-level audio framework. It provides a node-based graph similar to Web Audio.

```swift
let engine = AVAudioEngine()
let inputNode = engine.inputNode
let format = inputNode.outputFormat(forBus: 0)

// Install a tap for raw audio data
inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, time in
    let channelData = buffer.floatChannelData![0]
    let frameCount = Int(buffer.frameLength)
    // Process channelData[0..<frameCount]
}

try engine.start()
```

**vDSP (Accelerate framework)** provides hardware-accelerated FFT on Apple Silicon and Intel:

```swift
import Accelerate

let log2n = vDSP_Length(log2(Float(fftSize)))
let fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!

// Split complex format required by vDSP
var realPart = [Float](repeating: 0, count: fftSize / 2)
var imagPart = [Float](repeating: 0, count: fftSize / 2)
var splitComplex = DSPSplitComplex(realp: &realPart, imagp: &imagPart)

// Pack input into split complex
var inputCopy = Array(inputSamples)
inputCopy.withUnsafeMutableBufferPointer { ptr in
    ptr.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftSize / 2) {
        vDSP_ctoz($0, 2, &splitComplex, 1, vDSP_Length(fftSize / 2))
    }
}

// Forward FFT
vDSP_fft_zrip(fftSetup, &splitComplex, 1, log2n, FFTDirection(kFFTDirection_Forward))

// Compute magnitudes
var magnitudes = [Float](repeating: 0, count: fftSize / 2)
vDSP_zvmags(&splitComplex, 1, &magnitudes, 1, vDSP_Length(fftSize / 2))
```

vDSP FFT is extremely fast -- a 4096-point FFT completes in under 10 microseconds on modern Apple hardware. This leaves enormous headroom for additional processing.

**Latency:** iOS audio hardware typically runs at 256 or 512 sample buffer sizes (5.8 or 11.6 ms at 44.1 kHz). With `AVAudioSession` configured for `.measurement` category, round-trip latency can be as low as ~10 ms.

### 4.3 Android (Oboe / AAudio)

Android audio is historically more challenging due to device fragmentation and higher latencies.

**Oboe** (Google's recommended C++ audio library) provides the best cross-device experience:

```cpp
#include <oboe/Oboe.h>

class AudioAnalyzer : public oboe::AudioStreamCallback {
    oboe::DataCallbackResult onAudioReady(
        oboe::AudioStream *stream,
        void *audioData,
        int32_t numFrames) override {

        float *input = static_cast<float*>(audioData);
        // Accumulate into analysis buffer
        // Perform FFT when buffer is full
        return oboe::DataCallbackResult::Continue;
    }
};

// Setup
oboe::AudioStreamBuilder builder;
builder.setDirection(oboe::Direction::Input)
       ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
       ->setSharingMode(oboe::SharingMode::Exclusive)
       ->setSampleRate(48000)
       ->setChannelCount(1)
       ->setFormat(oboe::AudioFormat::Float)
       ->setCallback(&analyzer);
```

**AAudio** is the underlying native API (Android 8.1+). Oboe wraps it and falls back to OpenSL ES on older devices.

**FFT on Android:** Use KissFFT (C, lightweight, no dependencies) or PFFFT (optimized for ARM NEON). The Android NDK does not include a built-in FFT.

**Latency:** Varies wildly by device. Flagship phones (Pixel, Samsung Galaxy S series) achieve ~20-40 ms round-trip. Older or budget devices may have 100-200 ms. Oboe's `PerformanceMode::LowLatency` helps but cannot fix hardware limitations.

### 4.4 Cross-Platform Libraries

| Library | Language | License | FFT Performance | Notes |
|---|---|---|---|---|
| **FFTW** | C | GPL (or commercial) | Best-in-class | "Fastest Fourier Transform in the West." GPL license may be problematic. |
| **KissFFT** | C | BSD | Good | Simple, portable, no dependencies. Ideal for mobile. |
| **PFFFT** | C | BSD-like | Very good (SIMD) | ARM NEON and SSE optimized. Great for mobile. |
| **JUCE** | C++ | Dual (GPL/commercial) | Good | Full audio framework with FFT, synthesis, UI. Overkill if you only need FFT. |
| **essentia.js** | WASM | AGPL | Moderate | Comprehensive audio analysis in the browser. Includes CQT, pitch detection, etc. |
| **Meyda** | JS | MIT | Moderate | Browser audio feature extraction (spectral centroid, flux, etc.). Lightweight. |
| **Tone.js** | JS | MIT | N/A (uses Web Audio) | Synthesis and scheduling. Good for the output side. |

**Recommendation:** Use **fft.js** or **KissFFT (WASM)** for the browser prototype. Use **PFFFT** or **vDSP** for native apps.

---

## 5. Architecture Recommendations

### 5.1 Realtime Pipeline

```
                    ┌─────────────────────────────────────────────────┐
                    │                 ANALYSIS                        │
                    │                                                 │
  Mic Input ──►  Buffer  ──►  Window  ──►  FFT  ──►  Peak Detect    │
  (AudioWorklet    (ring       (Hann)      (4096)    (prominence     │
   or native)      buffer,                            + interpolation)│
                   2048 hop)                                          │
                    │                                                 │
                    │           ┌──── Noise Floor Estimator           │
                    │           │     (min statistics, ~3s window)    │
                    │           │                                     │
                    │    Peak Detect receives adaptive threshold      │
                    │                                                 │
                    └─────────────────┬───────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────────────┐
                    │              TRACKING & MAPPING                  │
                    │                                                 │
                    │  Frequency Tracker  ──►  Harmonic Grouper      │
                    │  (nearest-neighbor       (group harmonics       │
                    │   + smoothing)            to fundamentals)      │
                    │                                                 │
                    │              ──►  Bark Band Aggregator          │
                    │                   (perceptual grouping)         │
                    │                                                 │
                    │              ──►  Frequency Mapper              │
                    │                   (detected → generated)        │
                    └─────────────────┬───────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────────────┐
                    │              SYNTHESIS                          │
                    │                                                 │
                    │  Voice Allocator  ──►  Oscillator Pool (8-16)  │
                    │  (assign voices         │                       │
                    │   to mapped freqs)      ├── Gain Envelopes     │
                    │                         ├── Frequency Smoothing │
                    │                         └── Master Gain/Limiter │
                    │                                                 │
                    │                    ──►  Audio Output            │
                    └─────────────────────────────────────────────────┘
```

**Frame rate:** At 44.1 kHz with a hop size of 1024, you get ~43 analysis frames per second. With a hop of 512, ~86 frames per second. The synthesis side updates smoothly via parameter automation (setTargetAtTime).

### 5.2 Snapshot / Fingerprint Pipeline

```
  Mic Input ──► Record 5 seconds (220,500 samples at 44.1kHz)
                        │
                        ▼
              Welch's Method (4096-point segments, 50% overlap, ~106 averages)
                        │
                        ▼
              Smoothed Power Spectral Density (2049 bins, 10.77 Hz resolution)
                        │
                        ▼
              ┌─────────┴──────────┐
              │                    │
        Peak Detection      Spectral Descriptors
        (top 10-20 peaks)   (centroid, spread, flatness, rolloff)
              │                    │
              └─────────┬──────────┘
                        │
                        ▼
              Fingerprint Object:
              {
                timestamp: "2026-04-08T14:23:00Z",
                location: "...",
                peaks: [
                  { freq: 120.3, amplitude: -22.1, prominence: 18.4 },
                  { freq: 240.7, amplitude: -28.5, prominence: 12.1 },
                  ...
                ],
                descriptors: {
                  centroid: 1847.2,
                  spread: 1203.5,
                  flatness: 0.23,
                  rolloff85: 4200.0
                },
                barkBandEnergies: [12.3, 15.1, 18.4, ...],  // 24 values
                psd: Float32Array(2049)  // full PSD for later use
              }
```

This fingerprint object can be stored, compared with other snapshots, and used as the basis for generating a tonal response at any later time.

### 5.3 Latency Budget

**Realtime mode target: < 150 ms from sound event to tonal response.**

| Stage | Browser | iOS | Android |
|---|---|---|---|
| Audio input buffer | 23 ms (1024 samples) | 5.8 ms (256) | 10-40 ms |
| FFT analysis | 1-3 ms | < 0.1 ms | 0.5-2 ms |
| Peak detection + mapping | < 1 ms | < 0.5 ms | < 1 ms |
| Synthesis parameter update | ~1 ms | ~0.5 ms | ~1 ms |
| Audio output buffer | 23 ms (1024 samples) | 5.8 ms (256) | 10-40 ms |
| **Total** | **~50-70 ms** | **~12-15 ms** | **~25-85 ms** |

Browser latency is dominated by the AudioContext's buffer size. With `audioContext.createMediaStreamSource` and a reasonable buffer (1024 samples), 50-70 ms is achievable. This is well within the 150 ms target.

### 5.4 Buffer Size Trade-offs

| Requirement | Favors Smaller Buffer | Favors Larger Buffer |
|---|---|---|
| Low latency | X | |
| High frequency resolution | | X |
| Low CPU usage | X (fewer samples per FFT) | |
| Stable spectral estimate | | X |
| Transient detection | X | |
| Low-frequency detection | | X |

**Practical compromise:** Use FFT size 4096 with a hop size of 1024 (75% overlap, effective latency of 1024 samples = 23 ms). This provides 10.8 Hz frequency resolution with acceptable latency. For very low latency needs, drop to FFT size 2048 (21.5 Hz resolution, 11.6 ms hop).

Note: FFT size and buffer size can be decoupled. You can accumulate samples from small audio callbacks (128 or 256 samples) into a larger ring buffer and run the FFT whenever enough new samples have arrived.

---

## 6. Recommended Approach

### 6.1 Algorithm Combination for Wavetuner

For this specific use case, the recommended stack is:

**Analysis chain:**

1. **STFT with Hann window, 4096 points, hop 1024** -- primary spectral analysis
2. **Parabolic interpolation on peaks** -- sub-bin frequency accuracy
3. **Adaptive noise floor** (minimum statistics, 3-second window) -- robust peak detection in varying environments
4. **Prominence-based peak detection** (minimum 8 dB prominence, top 10 peaks) -- extract meaningful frequencies
5. **Harmonic grouping** -- collapse harmonic series to fundamentals
6. **Bark-band energy aggregation** -- perceptual summary for mapping

**Tracking (realtime):**

- Nearest-neighbor frequency tracking with exponential smoothing (alpha = 0.2)
- Track birth/death with 3-frame hysteresis (a peak must appear for 3 consecutive frames to birth a track; must disappear for 3 frames to die)

**Snapshot mode:**

- Welch's method with 4096-point segments, 50% overlap
- Store full fingerprint object including peaks, descriptors, and Bark-band energies

**Synthesis:**

- Additive synthesis with 8-voice polyphony
- Mapping strategy selectable by user (direct mirror, harmonic complement, inverse spectral, intervallic)
- 50 ms exponential envelope ramps
- Master limiter to prevent clipping

### 6.2 Browser Prototype Starting Point

Start with the simplest viable pipeline:

**Phase 1 -- Prove the concept (1-2 days):**

```javascript
// 1. Get mic input
const ctx = new AudioContext({ sampleRate: 44100 });
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const source = ctx.createMediaStreamSource(stream);

// 2. Use AnalyserNode for quick spectral data
const analyser = ctx.createAnalyser();
analyser.fftSize = 4096;
analyser.smoothingTimeConstant = 0; // raw data
source.connect(analyser);

// 3. Analysis loop
const freqData = new Float32Array(analyser.frequencyBinCount);
function analyze() {
  analyser.getFloatFrequencyData(freqData); // dB values

  // Simple peak detection
  const peaks = findProminentPeaks(freqData, {
    minProminence: 8,
    maxPeaks: 8,
    sampleRate: 44100,
    fftSize: 4096
  });

  // Update synthesis
  updateVoices(peaks);

  requestAnimationFrame(analyze);
}
analyze();

// 4. Oscillator pool for synthesis
const voices = Array.from({ length: 8 }, () => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  return { osc, gain, active: false };
});
```

**Phase 2 -- AudioWorklet pipeline (3-5 days):**

Replace `AnalyserNode` with `AudioWorkletProcessor` for access to raw samples. Implement proper windowing, custom FFT (using fft.js), parabolic interpolation, and frequency tracking.

**Phase 3 -- Snapshot mode (2-3 days):**

Record 5 seconds into a buffer, run Welch's method offline, generate and store the fingerprint object. Add UI for capturing and comparing snapshots.

### 6.3 Key Parameters to Tune

These are the parameters that most affect the output quality. Start with the suggested values and adjust based on testing:

| Parameter | Suggested Start | Range to Explore | Effect |
|---|---|---|---|
| FFT size | 4096 | 2048-8192 | Frequency resolution vs latency |
| Hop size | 1024 | 512-2048 | Temporal resolution |
| Peak prominence threshold | 8 dB | 4-15 dB | Sensitivity to tonal components |
| Max simultaneous voices | 8 | 4-16 | Complexity of output |
| Noise floor window | 3 seconds | 1-10 seconds | Adaptability to changing environments |
| Frequency smoothing (alpha) | 0.2 | 0.05-0.5 | Stability vs responsiveness |
| Track birth frames | 3 | 1-5 | How quickly new tones appear |
| Track death frames | 3 | 2-8 | How quickly tones fade out |
| Envelope ramp time | 50 ms | 10-200 ms | Smoothness of tone transitions |
| Welch segment count | ~100 | 50-200 | Snapshot stability (5s at 4096/2048) |

### 6.4 What to Avoid

- **Do not attempt true ANC in the browser.** The latency is too high and you have no phase control over the speaker-to-ear path. Frame this as a creative/artistic tool, not a noise cancellation product.
- **Do not use ScriptProcessorNode.** It is deprecated and runs on the main thread, causing audio dropouts.
- **Do not use CQT for the initial prototype.** Standard FFT is simpler, faster, and sufficient. Add CQT later if musical pitch mapping becomes important.
- **Do not skip the noise floor estimator.** Without it, the system will respond to noise fluctuations and produce chaotic output in real environments.
- **Do not exceed 16 simultaneous oscillators in the browser.** Each Web Audio OscillatorNode has overhead. Above 16, consider rendering to a single buffer via OfflineAudioContext or an AudioWorklet-based synthesizer.

---

## References and Further Reading

- Smith, J.O. *Spectral Audio Signal Processing*. Available online: https://ccrma.stanford.edu/~jos/sasp/
- De Cheveigne, A., Kawahara, H. "YIN, a fundamental frequency estimator for speech and music." JASA 2002.
- Mauch, M., Dixon, S. "pYIN: A fundamental frequency estimator using probabilistic threshold distributions." ICASSP 2014.
- Welch, P.D. "The use of fast Fourier transform for the estimation of power spectra." IEEE Trans. Audio and Electroacoustics, 1967.
- Web Audio API Specification: https://www.w3.org/TR/webaudio/
- MDN Web Audio API documentation: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- Oboe (Android audio): https://github.com/google/oboe
- Apple Accelerate/vDSP: https://developer.apple.com/documentation/accelerate/vdsp
