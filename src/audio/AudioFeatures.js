import keyboardVoiceManager from './KeyboardVoiceManager';
import { SATURATION_CURVES } from './AudioEngine';

/**
 * Per-frame audio features for visualizer reactivity.
 *
 * Two sources of truth:
 *   1. Engine state (frequencyValues, volumeValues, etc.) — used to
 *      PREDICT amplitudes that hit the saturator. Knows about voices
 *      before any nonlinear stages.
 *   2. Post-everything FFT (analyserNode1) — measures what listener
 *      hears: wave shape + folder + saturation all baked in. Used for
 *      dissonance, centroid, flux, loudness, beating.
 *
 * Exposed on window.audio so Hydra sketches can read them via callbacks:
 *
 *   osc(40, 0.1)
 *     .scale(() => 1 + audio.dissonance * 0.5)
 *     .modulate(noise(3), () => audio.flux * 5)
 *     .out()
 *
 * Use 1 to 1 mapping in sketches — every feature is normalized so
 * `audio.X * K` is predictable across all of them. Centroid is the
 * exception: it's in Hz so a sketch should divide by a reference
 * frequency (e.g. audio.centroid / 1000).
 */

// Sethares dissonance curve: d(x) = e^(-Ax) - e^(-Bx) where x is the
// frequency difference scaled by critical bandwidth. Peaks near x ≈ 0.22.
const _A = 3.5;
const _B = 5.75;
const _PEAK = Math.exp(-_A * 0.221) - Math.exp(-_B * 0.221);

function _criticalBandwidth(f) {
  return 1.72 * Math.pow(f, 0.65);
}

function _pairwiseDissonance(f1, f2, a1, a2) {
  const fMin = Math.min(f1, f2);
  const cb = _criticalBandwidth(fMin);
  const x = Math.abs(f1 - f2) / cb;
  const d = Math.exp(-_A * x) - Math.exp(-_B * x);
  return Math.min(a1, a2) * d / _PEAK;
}

// Saturation curve mirrored from /public/soft-limiter-worklet.js so we
// can predict how much the master is being squashed without tapping the
// audio thread.
function _saturationAmount(amp, curve, drive) {
  if (amp <= 0 || curve === SATURATION_CURVES.off) return 0;
  const x = amp * drive;
  if (x <= 0) return 0;
  let out;
  if (curve === SATURATION_CURVES.tanh) {
    out = Math.tanh(x);
  } else if (curve === SATURATION_CURVES.cubic) {
    out = x >= 1 ? 1 : 1.5 * x - 0.5 * x * x * x;
  } else if (curve === SATURATION_CURVES.sine) {
    out = x >= 1 ? 1 : Math.sin(x * Math.PI * 0.5);
  } else if (curve === SATURATION_CURVES.hard) {
    out = x >= 1 ? 1 : x;
  } else {
    return 0;
  }
  const reduction = 1 - out / x;
  return reduction > 0 ? reduction : 0;
}

export const audioFeatures = {
  // Voice-sum prediction — what's about to hit the saturator. Sum of
  // audible voice amplitudes (drones + keyboard) post-bus-gain. Useful
  // for "how hard are we driving the master" reactivity. Pairs with
  // `saturation` below.
  amp: 0,
  // 0..1. Fraction of `amp` the soft-limiter worklet is absorbing.
  saturation: 0,

  // ── FFT-derived (captures wave shape + folder + saturation) ─────────
  // 0..1 (sqrt-compressed). Sethares dissonance over FFT peak partials,
  // so the actual harmonic content the listener hears drives the value.
  dissonance: 0,
  consonance: 1,
  // Slowest sub-30 Hz beat among FFT peak pairs. Hz.
  beating: 0,
  // Spectral centroid in Hz — "brightness." Where the FFT energy
  // centers. Dark drones ~150 Hz; bright saws / folded waves > 1 kHz.
  centroid: 0,
  // 0..1. Spectral flux: how much the spectrum changed since last
  // frame. High during onsets, low during steady state. Good for
  // triggering visual pulses on note attacks.
  flux: 0,
  // 0..1. RMS-like loudness from FFT energy. Tracks the actual heard
  // level (post-saturator), unlike `amp` which is the pre-saturator
  // prediction.
  loudness: 0,
  // 0..1. Spectral entropy normalized by log2(N) — "how busy the scope
  // looks." Pure sine ≈ 0 (energy in one bin), noise ≈ 1 (energy
  // spread). Harmonic chords sit mid; folded / inharmonic content
  // sits high. Different from dissonance: a pristine saw chord has
  // low dissonance but high density (many partials drawing busy
  // lissajous lines).
  density: 0,
  // 0..1. "Holy light" meta-parameter. Slowly charges when notes are
  // consonant AND audible; gracefully decays when dissonance rises or
  // the voices fade. Asymmetric one-pole filter with separate attack /
  // release time constants — slower to build than to fade so it reads
  // as an emanation rather than a level meter.
  aura: 0,

  // Diagnostics.
  tick: 0,
  pairs: 0,
  voices: 0,
};

// Always expose on window so devtools can inspect (and Hydra sketches
// not booted through startVisuals can still reference `audio.dissonance`).
// The per-second tick log is opt-in via `?audioLog=1` or by setting
// `window.__AUDIO_LOG = true` — otherwise it floods the console
// (especially under Vite HMR, which re-evaluates this module on every
// edit and would otherwise pile up duplicate intervals).
if (typeof window !== 'undefined') {
  window.audio = audioFeatures;
  // Clear any prior interval left over from a previous HMR pass before
  // deciding whether to start a new one.
  if (window.__audioLogInterval) {
    clearInterval(window.__audioLogInterval);
    window.__audioLogInterval = null;
  }
  const wantLog = (() => {
    try {
      if (window.__AUDIO_LOG === true) return true;
      const q = new URLSearchParams(window.location.search);
      return q.get('audioLog') === '1';
    } catch { return false; }
  })();
  if (wantLog) {
    let lastTick = 0;
    window.__audioLogInterval = setInterval(() => {
      const dt = audioFeatures.tick - lastTick;
      lastTick = audioFeatures.tick;
      // eslint-disable-next-line no-console
      console.log(
        `[audio] tick+${dt}/s amp=${audioFeatures.amp.toFixed(3)} sat=${audioFeatures.saturation.toFixed(3)} loud=${audioFeatures.loudness.toFixed(3)} diss=${audioFeatures.dissonance.toFixed(3)} dens=${audioFeatures.density.toFixed(3)} aura=${audioFeatures.aura.toFixed(3)} cent=${audioFeatures.centroid.toFixed(0)}Hz flux=${audioFeatures.flux.toFixed(3)} pairs=${audioFeatures.pairs} beat=${audioFeatures.beating.toFixed(2)}Hz`
      );
    }, 1000);
    audioFeatures.__log = window.__audioLogInterval;
  }
}

// FFT scratch buffers. Allocated once on first call; reused every frame
// to avoid per-frame allocations (which would tax JSC's GC).
let _fftBuf = null;     // dB values from getFloatFrequencyData
let _prevLin = null;    // previous frame's linear amps, for flux

// Aura state — last-tick timestamp for the dt-based one-pole.
let _auraLastT = 0;
// Time constants in seconds. ATTACK > RELEASE so the "holy light"
// glow builds gradually but doesn't linger forever once the chord
// goes rough.
const AURA_ATTACK_TAU = 4.0;
const AURA_RELEASE_TAU = 1.2;
// Smooth amplitude gate on the PREDICTIVE amp reading (voice-sum,
// post-bus-gain) — fades the aura's target between 0 and 1 as audible
// level moves through this range. Uses `amp` rather than `loudness`
// because amp is reliably > 0 whenever voices are audible, regardless
// of FFT bin distribution. Typical drone configurations land amp at
// ~1.0–2.0, so anything above the knee gives full gate.
const AURA_AMP_FLOOR = 0.05;
const AURA_AMP_KNEE = 0.5;
// Dissonance threshold for the aura's target ceiling. This is the
// dissonance value at which the aura's max possible value crosses 0.5
// — below it the ceiling rises toward 1.0; above it the ceiling falls
// but always stays > 0 (smooth tail, no hard cutoff). The slider in
// the meter writes here; persisted in localStorage. See _auraTarget()
// for the exact curve.
// All three are in the same units as `audioFeatures.dissonance`
// (0..1, displayed as 0..100%). Default 0.6 ⇒ "60% threshold."
const AURA_THRESHOLD_DEFAULT = 0.6;
const AURA_THRESHOLD_MIN = 0.01;
const AURA_THRESHOLD_MAX = 1.0;
let _auraThreshold = AURA_THRESHOLD_DEFAULT;
if (typeof window !== 'undefined') {
  try {
    const saved = parseFloat(localStorage.getItem('auraThreshold'));
    if (Number.isFinite(saved)) {
      _auraThreshold = Math.max(AURA_THRESHOLD_MIN, Math.min(AURA_THRESHOLD_MAX, saved));
    }
  } catch { /* ignore */ }
}
export function getAuraThreshold() { return _auraThreshold; }
export function setAuraThreshold(v) {
  if (!Number.isFinite(v)) return;
  _auraThreshold = Math.max(AURA_THRESHOLD_MIN, Math.min(AURA_THRESHOLD_MAX, v));
  try { localStorage.setItem('auraThreshold', String(_auraThreshold)); } catch { /* ignore */ }
}
export { AURA_THRESHOLD_MIN, AURA_THRESHOLD_MAX, AURA_THRESHOLD_DEFAULT };

// Cap on how many FFT peaks we feed into the pairwise dissonance loop.
// Each frame: C(N,2) pairs. 30 → 435 pairs. Way under our budget.
const MAX_PEAKS = 30;

// Reused peak arrays (parallel — avoids object allocations).
const _peakF = new Float32Array(MAX_PEAKS);
const _peakA = new Float32Array(MAX_PEAKS);

/**
 * Recompute features. Call once per animation frame.
 */
export function updateAudioFeatures(audioEngine) {
  audioFeatures.tick++;
  if (!audioEngine || !audioEngine.isInitialized) {
    audioFeatures.amp = 0;
    audioFeatures.saturation = 0;
    audioFeatures.dissonance = 0;
    audioFeatures.consonance = 1;
    audioFeatures.beating = 0;
    audioFeatures.centroid = 0;
    audioFeatures.flux = 0;
    audioFeatures.loudness = 0;
    audioFeatures.density = 0;
    audioFeatures.aura = 0;
    audioFeatures.pairs = 0;
    audioFeatures.voices = 0;
    _auraLastT = 0;
    return;
  }

  // ── Voice-sum prediction (pre-saturator) ────────────────────────────
  // We still want this even with FFT in play, because:
  //   amp + saturation together tell you "we're driving the input to
  //   the saturator with X, and it's eating Y of it." The FFT post-
  //   saturator can't tell you about the saturator's reduction directly.
  const droneScale = audioEngine.getDroneEffectiveGain
    ? audioEngine.getDroneEffectiveGain()
    : 1;
  const kbdScale = audioEngine.getKeyboardEffectiveGain
    ? audioEngine.getKeyboardEffectiveGain()
    : 1;
  // Stereo-mode equal-loudness scaling is applied at each oscillator
  // node by AudioEngine — fold it into the predicted amp so the meter
  // doesn't overstate signal level in stereo mode.
  const droneStereoScale = audioEngine._stereoEqualLoudnessScale
    ? audioEngine._stereoEqualLoudnessScale()
    : 1;
  const droneFreqs = audioEngine.frequencyValues || [];
  const droneVols = audioEngine.volumeValues || [];
  const muted = audioEngine.mutedStates || [];
  const count = audioEngine.oscillatorCount || 0;

  let ampSum = 0;
  let voiceCount = 0;
  for (let i = 0; i < count; i++) {
    if (muted[i]) continue;
    const a = (droneVols[i] || 0) * droneScale * droneStereoScale;
    if (a <= 0) continue;
    if (!(droneFreqs[i] > 0)) continue;
    ampSum += a;
    voiceCount++;
  }
  const kbdVoices = keyboardVoiceManager?.getVoicesForSynth
    ? keyboardVoiceManager.getVoicesForSynth()
    : [];
  for (const v of kbdVoices) {
    const a = (v.amp || 0) * kbdScale;
    if (a <= 0) continue;
    if (!(v.freq > 0)) continue;
    ampSum += a;
    voiceCount++;
  }
  audioFeatures.amp = ampSum;
  audioFeatures.voices = voiceCount;
  audioFeatures.saturation = _saturationAmount(
    ampSum,
    audioEngine.saturationCurve,
    audioEngine.saturationDrive,
  );

  // ── FFT-derived features ────────────────────────────────────────────
  const analyser = audioEngine.analyserNode1;
  if (!analyser || !audioEngine.audioContext) {
    audioFeatures.dissonance = 0;
    audioFeatures.consonance = 1;
    audioFeatures.beating = 0;
    audioFeatures.centroid = 0;
    audioFeatures.flux = 0;
    audioFeatures.loudness = 0;
    audioFeatures.pairs = 0;
    return;
  }
  const N = analyser.frequencyBinCount;
  if (!_fftBuf || _fftBuf.length !== N) {
    _fftBuf = new Float32Array(N);
    _prevLin = new Float32Array(N);
  }
  analyser.getFloatFrequencyData(_fftBuf);

  const sampleRate = audioEngine.audioContext.sampleRate;
  const binHz = sampleRate / (2 * N);

  // Convert dB → linear in place. dB ≤ -100 is treated as silence to
  // keep the spectrum sparse and skip the pow() for inaudible bins.
  // Also accumulate centroid numerator, energy, and flux while we're
  // already walking the buffer — single pass.
  let energy = 0;
  let centNum = 0;
  let centDen = 0;
  let fluxSum = 0;
  const SILENCE_DB = -90;
  for (let i = 0; i < N; i++) {
    const db = _fftBuf[i];
    const a = db > SILENCE_DB ? Math.pow(10, db / 20) : 0;
    _fftBuf[i] = a;
    if (a > 0) {
      const f = i * binHz;
      energy += a * a;
      centNum += f * a;
      centDen += a;
    }
    // Positive spectral flux — only count bins that grew.
    const diff = a - _prevLin[i];
    if (diff > 0) fluxSum += diff * diff;
    _prevLin[i] = a;
  }
  // Loudness via Parseval — but DON'T divide by N. getFloatFrequencyData
  // already normalizes bin amplitudes so a unit sine reads ~0.5 in its
  // bin; dividing energy by N dilutes narrowband content to invisibility
  // even though it's perfectly audible. sqrt(energy) on its own tracks
  // peak amplitude for tonal content and stays bounded for noise too.
  audioFeatures.loudness = Math.min(1, Math.sqrt(energy));
  audioFeatures.centroid = centDen > 0 ? centNum / centDen : 0;
  audioFeatures.flux = Math.min(1, Math.sqrt(fluxSum) * 2);

  // Spectral entropy → "density." Treat the normalized linear FFT as a
  // probability distribution over bins (p_i = a_i / Σa). Shannon entropy
  // H = -Σ p_i·log2(p_i) is 0 when everything is in one bin (pure sine)
  // and log2(N) when uniformly spread (white noise). Normalize by
  // log2(N) so the value lands in [0, 1]. Second pass over _fftBuf —
  // cheap, all reads are sequential.
  let entropy = 0;
  if (centDen > 0) {
    const invSum = 1 / centDen;
    for (let i = 0; i < N; i++) {
      const a = _fftBuf[i];
      if (a > 0) {
        const p = a * invSum;
        entropy -= p * Math.log2(p);
      }
    }
  }
  audioFeatures.density = entropy / Math.log2(N);

  // ── Peak picking + dissonance over peaks ────────────────────────────
  // Local maxima above a noise floor, capped at MAX_PEAKS by amplitude.
  // Replace-min strategy: maintain the top-K peaks in the parallel
  // arrays without allocating, by tracking the current minimum slot.
  const NOISE_FLOOR = 0.003;
  let peakCount = 0;
  let minIdx = 0;
  let minAmp = Infinity;
  for (let i = 1; i < N - 1; i++) {
    const a = _fftBuf[i];
    if (a < NOISE_FLOOR) continue;
    if (a <= _fftBuf[i - 1] || a <= _fftBuf[i + 1]) continue;
    const f = i * binHz;
    if (peakCount < MAX_PEAKS) {
      _peakF[peakCount] = f;
      _peakA[peakCount] = a;
      if (a < minAmp) { minAmp = a; minIdx = peakCount; }
      peakCount++;
    } else if (a > minAmp) {
      _peakF[minIdx] = f;
      _peakA[minIdx] = a;
      // Find the new min.
      minAmp = Infinity;
      for (let k = 0; k < MAX_PEAKS; k++) {
        if (_peakA[k] < minAmp) { minAmp = _peakA[k]; minIdx = k; }
      }
    }
  }

  let totalDiss = 0;
  let pairCount = 0;
  let minBeat = Infinity;
  let sawAnyBeat = false;
  for (let i = 0; i < peakCount; i++) {
    const fi = _peakF[i];
    const ai = _peakA[i];
    for (let j = i + 1; j < peakCount; j++) {
      const fj = _peakF[j];
      const aj = _peakA[j];
      totalDiss += _pairwiseDissonance(fi, fj, ai, aj);
      pairCount++;
      const beat = Math.abs(fi - fj);
      if (beat > 0 && beat < 30 && beat < minBeat) {
        minBeat = beat;
        sawAnyBeat = true;
      }
    }
  }
  audioFeatures.pairs = pairCount;

  // Sqrt compression so small dissonances are readable on a 0..1 bar.
  const compressed = Math.sqrt(Math.min(1, totalDiss));
  audioFeatures.dissonance = compressed;
  audioFeatures.consonance = 1 - compressed;
  audioFeatures.beating = sawAnyBeat ? minBeat : 0;

  // ── Aura — slow meta-parameter ──────────────────────────────────────
  // Target ramps linearly from 1 (at dissonance=0) to 0 (at threshold),
  // then stays 0 above the threshold. Gated by a smooth-stepped
  // loudness floor so voices fading out brings the aura back down.
  // Asymmetric one-pole: attack slower than release so the "holy
  // light" emanates gradually but lifts cleanly when the chord breaks.
  const now = performance.now();
  const dt = _auraLastT > 0 ? Math.max(0, (now - _auraLastT) / 1000) : 0;
  _auraLastT = now;
  const ampGate = audioFeatures.amp <= AURA_AMP_FLOOR
    ? 0
    : audioFeatures.amp >= AURA_AMP_KNEE
      ? 1
      : (audioFeatures.amp - AURA_AMP_FLOOR) / (AURA_AMP_KNEE - AURA_AMP_FLOOR);
  // Sigmoid-style curve: target = 1 / (1 + (diss/threshold)²). Hits
  // 0.5 exactly at the threshold, smoothly tails off above (always
  // > 0, so even rough chords retain a faint aura), and approaches 1
  // as dissonance approaches 0. Lowering the slider tightens the
  // curve (only pristine chords charge high); raising it loosens
  // (most chords get a healthy aura ceiling).
  const dRatio = audioFeatures.dissonance / _auraThreshold;
  const consGain = 1 / (1 + dRatio * dRatio);
  const target = consGain * ampGate;
  // One-pole alpha = 1 - exp(-dt / tau), framerate-independent.
  const tau = target > audioFeatures.aura ? AURA_ATTACK_TAU : AURA_RELEASE_TAU;
  const alpha = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
  audioFeatures.aura += (target - audioFeatures.aura) * alpha;
}
