import { useEffect, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import palette from '../theme/palette';

// Synth-buffer length policy for the XY / Hilbert / face scopes.
// - At low frequencies, we want a long buffer so the trace visibly
//   drifts frame-to-frame (the "playhead" feel below ~130 Hz).
// - At high frequencies, we want a short buffer so the figure shows
//   only a handful of cycles instead of dozens of overlapping copies
//   that smear from sub-pixel jitter and accumulated phase noise.
// Adaptive N = clamp(target_cycles × sampleRate / highestFreq, MIN, MAX).
// Sized off the HIGHEST active freq so a multi-kHz pair gets a short
// buffer regardless of any bass present — bass will visualize as a
// near-DC offset rather than a full cycle, but trying to do both
// well is impossible (long enough for bass = treble smears 20+ cycles).
// Rounded to a multiple of N_STEP so dragging an orb across the cap
// boundary doesn't make N (and therefore the figure) breathe.
// See research/oscilloscope-frequency-adaptive.md for the full diagnosis.
const VIZ_BUF_MIN_N = 128;
const VIZ_BUF_MAX_N = 2048;
const VIZ_BUF_N_STEP = 32;

function adaptiveBufferSize(highestActiveFreq, sampleRate, targetCycles) {
  if (!(highestActiveFreq > 0)) return VIZ_BUF_MAX_N;
  const ideal = (targetCycles * sampleRate) / highestActiveFreq;
  const stepped = Math.round(ideal / VIZ_BUF_N_STEP) * VIZ_BUF_N_STEP;
  return Math.max(VIZ_BUF_MIN_N, Math.min(VIZ_BUF_MAX_N, stepped));
}

// Highest-frequency component currently sounding (drone or keyboard).
// Returns 0 if nothing is making sound — caller falls back to
// VIZ_BUF_MAX_N. Drones that are muted contribute 0 gain so they're
// excluded; keyboard voices include release tails (still on screen).
function highestActiveFreq() {
  let highest = 0;
  const freqs = audioEngine.getAllFrequencies();
  for (let i = 0; i < freqs.length; i++) {
    if (audioEngine.isMuted(i)) continue;
    const f = freqs[i];
    if (f > highest) highest = f;
  }
  const voices = keyboardVoiceManager.getVoicesForSynth();
  for (const v of voices) {
    if (v.freq > highest) highest = v.freq;
  }
  return highest;
}

// ── Hilbert FIR (windowed-sinc, 33 taps centered) ─────────────────────
// Used by the "Audio" source path of the Hilbert visualizer to compute
// the 90°-phase-shifted partner of the analyzer's mono signal. The
// ideal Hilbert kernel has h[k] = 2/(πk) for odd k, zero for even k.
// Hamming-windowing tapers the tails so the truncation doesn't ripple
// in the response. 33 taps gives a usable approximation across the
// audible range; longer kernels widen the dead-band near DC + Nyquist
// but cost more per sample. At 8192 input samples × ~16 nonzero taps,
// total cost is ~130k mults/frame — sub-millisecond.
const HILBERT_FIR = (() => {
  const L = 33;
  const center = (L - 1) / 2;
  const h = new Float32Array(L);
  for (let n = 0; n < L; n++) {
    const k = n - center;
    if (k === 0 || k % 2 === 0) {
      h[n] = 0;
      continue;
    }
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (L - 1));
    h[n] = (2 / (Math.PI * k)) * win;
  }
  // Pre-extract the nonzero (odd-k) tap indices + values for a tighter
  // inner loop — skips half the multiplies that would otherwise hit a
  // guaranteed zero.
  const taps = [];
  for (let n = 0; n < L; n++) {
    if (h[n] !== 0) taps.push({ offset: n - center, coef: h[n] });
  }
  return { center, taps };
})();

// Apply the FIR Hilbert transform to `input`, writing into `output`.
// Output[i] approximates the Hilbert-transformed input at sample i.
// Edge samples (within ±center of the buffer ends) get zero-padded
// context, so the very first / last 16 samples are slightly attenuated.
// We slice out only the buffer's middle region for visualization
// downstream, so this edge dimming is invisible.
function hilbertTransform(input, output) {
  const { taps } = HILBERT_FIR;
  const N = input.length;
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (const { offset, coef } of taps) {
      const idx = i + offset;
      if (idx >= 0 && idx < N) sum += coef * input[idx];
    }
    output[i] = sum;
  }
}

// Reusable scratch buffers for analyzer-mode Hilbert. Resized on demand
// so each frame doesn't allocate.
let _hilbertMono = null;
let _hilbertImag = null;
function ensureHilbertScratch(n) {
  if (!_hilbertMono || _hilbertMono.length !== n) {
    _hilbertMono = new Float32Array(n);
    _hilbertImag = new Float32Array(n);
  }
  return { mono: _hilbertMono, imag: _hilbertImag };
}

// Window function that ramps amplitude to 0 at the left/right edges so
// traces terminate at a single point on the center axis rather than
// hard-cutting. `p` is the sample's normalized position in [0, 1].
function edgeWindow(p, fadeFrac) {
  if (p < fadeFrac) return p / fadeFrac;
  if (p > 1 - fadeFrac) return (1 - p) / fadeFrac;
  return 1;
}

// Static synthesized view — per-oscillator colored sines (additive bloom)
// with the XY-scope's cycling color tinting the aggregate composite line.
// All synthesis uses `freqs[]` + the tweened `renderVolumes` so mute/
// unmute and freq tweaks animate smoothly.
function drawStatic(
  ctx, width, height, lineScale, r, g, b,
  renderVolumes, smoothedWindow, mode, targetPeriods, options = {}
) {
  // lineWidthScale:    multiplier on the base stroke widths for both
  //                    the per-osc colored lines and the aggregate
  //                    composite. User-controlled via a settings slider.
  // outlineThickness:  extra radius (in CSS pixels, pre-lineScale) of a
  //                    colored outer pass drawn UNDER the white-core
  //                    aggregate — matches the XY scope's neon-tube
  //                    look. 0 means just the white core (current
  //                    behavior); > 0 adds the colored glow halo.
  const { lineWidthScale = 1, outlineThickness = 0 } = options;
  // Clearing is the caller's responsibility — drawScope wipes the whole
  // bottom strip (including the reserved orb/UI area) each frame.

  const freqs = audioEngine.getAllFrequencies();
  const volumes = audioEngine.volumeValues || [];
  const phases = audioEngine.getAllPhases();
  // Keyboard voices contribute alongside drones — same standing-wave
  // model, just with envelope-driven amp instead of a tweened slider.
  // Each voice already carries its own phase + smoothed freq from
  // keyboardVoiceManager.updatePhases() in drawScope, so we just read
  // them. The keyboard pool's bus gain (kbd-on/off + volume) is folded
  // in via getKeyboardEffectiveGain() below so muting the kbd bus
  // hides voices visually too.
  const voices = keyboardVoiceManager.getVoicesForSynth();
  const kbdEffectiveGain = audioEngine.getKeyboardEffectiveGain
    ? audioEngine.getKeyboardEffectiveGain()
    : 1;

  // Tween each oscillator's render volume toward its target so mute /
  // unmute / volume changes reshape the trace smoothly.
  const initial = renderVolumes.length === 0;
  while (renderVolumes.length < freqs.length) renderVolumes.push(0);
  const smooth = 0.15;
  for (let i = 0; i < freqs.length; i++) {
    const muted = audioEngine.isMuted(i);
    const target = (freqs[i] > 0 && volumes[i] > 0 && !muted) ? volumes[i] : 0;
    if (initial) {
      renderVolumes[i] = target;
    } else {
      renderVolumes[i] += (target - renderVolumes[i]) * smooth;
      if (Math.abs(renderVolumes[i] - target) < 1e-4) renderVolumes[i] = target;
    }
  }

  const visThreshold = 0.005;
  const isActive = (i) => freqs[i] > 0 && renderVolumes[i] > visThreshold;
  // Voice-side amp is already envelope-shaped (release tail fades it
  // out) and bus-gated — multiply by kbdEffectiveGain so the kbd-off
  // toggle hides voices instantly. Threshold matches drone path.
  const voiceAmp = (v) => v.amp * kbdEffectiveGain;
  const isVoiceActive = (v) => v.freq > 0 && voiceAmp(v) > visThreshold;
  const fadeZone = 0.1;

  // Target fundamental (lowest active freq across drones AND voices).
  // Including voices means a low-pitched key + high drones still picks
  // a window long enough to show the keyboard's slowest cycle.
  let targetFundamental = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    if (isActive(i) && freqs[i] < targetFundamental) targetFundamental = freqs[i];
  }
  for (const v of voices) {
    if (isVoiceActive(v) && v.freq < targetFundamental) targetFundamental = v.freq;
  }
  if (!isFinite(targetFundamental)) {
    for (const f of freqs) if (f > 0 && f < targetFundamental) targetFundamental = f;
  }
  if (!isFinite(targetFundamental)) targetFundamental = 100;

  // Periods to display is now user-controlled via the settings slider
  // (staticPeriods). The smoothing on `periods` below still tweens
  // between old and new values so slider drags glide instead of snap.
  if (smoothedWindow.fundamental === 0) {
    smoothedWindow.fundamental = targetFundamental;
    smoothedWindow.periods = targetPeriods;
  } else {
    const winSmooth = 0.1;
    smoothedWindow.fundamental +=
      (targetFundamental - smoothedWindow.fundamental) * winSmooth;
    smoothedWindow.periods +=
      (targetPeriods - smoothedWindow.periods) * winSmooth;
  }
  const fundamental = smoothedWindow.fundamental;
  const periods = smoothedWindow.periods;

  const periodSec = 1 / fundamental;
  const windowSec = periods * periodSec;
  const windowHalf = windowSec / 2;

  // Trace width is capped at 1.5× the FrequencySpectrumBar's width (which
  // is `min(500, viewport - 40)` — see .freq-spectrum-bar in App.css).
  // Clamped again so it never overflows the canvas itself.
  const spectrumWidth = Math.min(500, Math.max(100, width - 40));
  const traceWidth = Math.min(width - 20, spectrumWidth * 1.5);
  const traceOffsetX = (width - traceWidth) / 2;
  const centerY = height * 0.5;
  // Per-pool effective gain (master × pool bus) folds into each pool's
  // *contribution amount* below, so spacebar (pauses droneBusGain) fades
  // drone contributions out while leaving keyboard voices visible, and
  // toggling the keyboard bus does the inverse. Master fade-out
  // (routing/device changes) drops both since master is in both pool
  // gains.
  const droneScale = audioEngine.getDroneEffectiveGain();
  const kbdScale = kbdEffectiveGain;
  // 'wave' keeps individuals at ±0.22·h (aggregate up to 1.75× that).
  // 'beating' renders only the aggregate and gets ~1.5× the amplitude so
  // it's the dominant feature of the strip. NB: ampScale is just
  // height — pool gains are multiplied into each per-osc contribution
  // separately so drones and voices can fade independently.
  const ampScale = mode === 'beating' ? height * 0.33 : height * 0.22;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(traceOffsetX, centerY);
  ctx.lineTo(traceOffsetX + traceWidth, centerY);
  ctx.stroke();

  // Individual per-oscillator lines are thin; the aggregate composite is
  // drawn thicker and white. In 'beating' mode (no individuals) we use a
  // thinner aggregate so the longer 30-period waveform stays legible.
  const indivWidth = 2 * lineScale * lineWidthScale;
  const aggWidth = (mode === 'beating' ? indivWidth * 1.1 : indivWidth * 2);
  const aggOuterWidth = aggWidth + outlineThickness * 2 * lineScale;
  const TWO_PI = Math.PI * 2;

  // Per-pool contribution amount = the effective amplitude this source
  // adds to the audio output (= slot volume × pool bus gain × master).
  // volSum / maxVol are computed in this gained space so the aggregate
  // normalization correctly accounts for both pools' loudness.
  const droneContrib = (i) => renderVolumes[i] * droneScale;
  const voiceContrib = (v) => v.amp * kbdScale;

  let volSum = 0;
  let maxVol = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (!isActive(i)) continue;
    const c = droneContrib(i);
    volSum += c;
    if (c > maxVol) maxVol = c;
  }
  for (const v of voices) {
    if (!isVoiceActive(v)) continue;
    const c = voiceContrib(v);
    volSum += c;
    if (c > maxVol) maxVol = c;
  }

  // In 'wave' mode each individual line peaks at ±ampScale (normalized by
  // maxVol so line height is stable across osc count), and the aggregate
  // is clamped to 1.75× that via aggHeightScale.
  // In 'beating' mode there are no individual lines — the aggregate is
  // the whole show — so we normalize it by volSum instead, which
  // guarantees its peak fits ±ampScale regardless of osc count.
  const synthNorm = mode === 'beating'
    ? (volSum > 0 ? 1 / volSum : 1)
    : (maxVol > 0 ? 1 / maxVol : 1);

  // Only cap in wave mode — in beating mode the aggregate's synthNorm
  // already normalizes its peak to ±1.
  const AGG_MAX_RATIO = 1.75;
  const aggHeightScale = mode === 'wave' && volSum > 0
    ? Math.min(1, (AGG_MAX_RATIO * maxVol) / volSum)
    : 1;
  const aggAlpha = Math.min(1, volSum / fadeZone);
  const edgeFade = 0.15;

  const samples = Math.min(1600, Math.max(256, Math.floor(traceWidth)));

  // Anchor to the lowest-freq active source (drone OR voice) so its
  // trace stays visually pinned (zero crossing at window center).
  // Every other source's rendered phase is taken relative to the
  // anchor, so the aggregate's beat envelope evolves in real time
  // and lines up with what you hear.
  //   relPhase = sourcePhase − (sourceFreq / anchorFreq) × anchorPhase
  let anchorFreq = 0;
  let anchorPhase = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (!isActive(i)) continue;
    if (anchorFreq === 0 || freqs[i] < anchorFreq) {
      anchorFreq = freqs[i];
      anchorPhase = phases[i] || 0;
    }
  }
  for (const v of voices) {
    if (!isVoiceActive(v)) continue;
    if (anchorFreq === 0 || v.freq < anchorFreq) {
      anchorFreq = v.freq;
      anchorPhase = v.phase || 0;
    }
  }
  const relPhases = new Array(freqs.length);
  for (let k = 0; k < freqs.length; k++) {
    relPhases[k] = anchorFreq > 0
      ? (phases[k] || 0) - (freqs[k] / anchorFreq) * anchorPhase
      : 0;
  }
  const relVoicePhase = (v) =>
    anchorFreq > 0 ? v.phase - (v.freq / anchorFreq) * anchorPhase : 0;
  // Temporal smoothing on these phases happens upstream in
  // calibratePhases (which caps the LSQ blend alpha so frame-to-frame
  // LSQ noise gets averaged across a few frames). That smoothing
  // benefits the synth XY too, so we don't do a second pass here.

  // Sample the composite (renderVol-weighted sum of sines) at sample i,
  // optionally with a time-phase offset `dt` in seconds. Used by every
  // aggregate variant.
  // ── per-oscillator colored layer (wave mode only) ─────────────────────
  if (mode === 'wave') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Drones first.
    const totalCount = freqs.length;
    for (let k = 0; k < freqs.length; k++) {
      if (!isActive(k)) continue;
      const c = droneContrib(k);
      const f = freqs[k];
      const color = palette.oscColor(k, totalCount);
      ctx.globalAlpha = Math.min(1, renderVolumes[k] / fadeZone) * droneScale;
      ctx.beginPath();
      ctx.lineWidth = indivWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.shadowBlur = 14 * lineScale;
      ctx.shadowColor = color;
      for (let i = 0; i < samples; i++) {
        const p = i / (samples - 1);
        const t = p * windowSec - windowHalf;
        const amp = c * Math.sin(TWO_PI * f * t + relPhases[k]) * synthNorm * edgeWindow(p, edgeFade);
        const x = traceOffsetX + p * traceWidth;
        const y = centerY - amp * ampScale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Then keyboard voices. Each voice borrows the color of the drone
    // slot at its scale degree, so a kbd note at degree 1 reads as
    // "the same color as the drone playing degree 1." Voices outside
    // the current scale (degree < 0) fall back to white.
    for (const v of voices) {
      if (!isVoiceActive(v)) continue;
      const c = voiceContrib(v);
      // Use the slot the voice is bound to (set at noteOn) rather than
      // resolving via degree — keeps the trace color stable when a
      // mid-press orb drag reorders the scale.
      const color = v.slot >= 0
        ? palette.oscColor(v.slot, totalCount)
        : 'rgba(255, 255, 255, 0.85)';
      ctx.globalAlpha = Math.min(1, v.amp / fadeZone) * kbdScale;
      ctx.beginPath();
      ctx.lineWidth = indivWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.shadowBlur = 14 * lineScale;
      ctx.shadowColor = typeof color === 'string' ? color : '#fff';
      const rp = relVoicePhase(v);
      for (let i = 0; i < samples; i++) {
        const p = i / (samples - 1);
        const t = p * windowSec - windowHalf;
        const amp = c * Math.sin(TWO_PI * v.freq * t + rp) * synthNorm * edgeWindow(p, edgeFade);
        const x = traceOffsetX + p * traceWidth;
        const y = centerY - amp * ampScale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── aggregate composite line ───────────────────────────────────────────
  // Two-pass when outlineThickness > 0: a colored outer pass (widened by
  // the outline radius, with a matching-color shadow blur for the neon
  // halo) drawn first, then the white core on top. Mirrors the XY
  // scope's colored-glow-over-white-core look so the static wave reads
  // as part of the same visual language.
  // Pre-compute relative phases for keyboard voices once so the
  // per-sample loop just reads them — same shape as relPhases for
  // drones. Skipped voices are filtered out here, not inside the loop.
  const activeVoices = [];
  for (const v of voices) {
    if (!isVoiceActive(v)) continue;
    activeVoices.push({
      freq: v.freq,
      contrib: voiceContrib(v),
      relPhase: relVoicePhase(v),
    });
  }

  const drawAggPath = () => {
    ctx.beginPath();
    for (let i = 0; i < samples; i++) {
      const p = i / (samples - 1);
      const t = p * windowSec - windowHalf;
      let sum = 0;
      for (let k = 0; k < freqs.length; k++) {
        if (!isActive(k)) continue;
        sum += droneContrib(k) * Math.sin(TWO_PI * freqs[k] * t + relPhases[k]);
      }
      for (const av of activeVoices) {
        sum += av.contrib * Math.sin(TWO_PI * av.freq * t + av.relPhase);
      }
      const x = traceOffsetX + p * traceWidth;
      const y = centerY - sum * synthNorm * ampScale * aggHeightScale * edgeWindow(p, edgeFade);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  // aggAlpha already incorporates per-pool gain via volSum (which is
  // in contribution-space) — no extra master multiplier needed here.
  ctx.globalAlpha = aggAlpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (outlineThickness > 0) {
    ctx.lineWidth = aggOuterWidth;
    ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;
    ctx.shadowBlur = Math.max(outlineThickness, 4) * lineScale;
    ctx.shadowColor = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 0.8)`;
    drawAggPath();
  }

  ctx.lineWidth = aggWidth;
  ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
  ctx.shadowBlur = 8 * lineScale;
  ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
  drawAggPath();

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

// Produce (L, R) Float32Arrays matching what the analyzer would yield if
// the audio graph were noiseless and phase were perfectly known —
// i.e. synthesized directly from each oscillator's phase accumulator,
// target frequency, volume, routing map and the master clip-scale. Used
// for the side-by-side synthesized XY scope so the comparison against
// the real analyzer output is apples-to-apples (same N, same
// sampleRate, same amplitude scaling).
function synthStereoData(N, sampleRate, sampleOffsetBackward = 0) {
  const freqs = audioEngine.getAllFrequencies();
  const phases = audioEngine.getAllPhases();
  const volumes = audioEngine.volumeValues || [];
  const routingMap = audioEngine.getRoutingMap();
  // Partner oscillator data — second osc per drone, audible on R only
  // in 'stereo' mode. In 'lr' mode `audible` is false and the partner
  // contributes nothing to the synth output.
  const partners = audioEngine.getDronePartnerData
    ? audioEngine.getDronePartnerData()
    : [];
  // Per-pool effective gain: drones see master × droneBusGain (so they
  // fade with spacebar/pause), keyboard sees master × keyboardBusGain
  // (so they fade with the keyboard volume slider / on-off toggle).
  // Reading the live values means the synth visually tracks every
  // transition — pause ramp, master volume drag, etc.
  const droneScale = audioEngine.getDroneEffectiveGain();
  const keyboardScale = audioEngine.getKeyboardEffectiveGain();

  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const TWO_PI = Math.PI * 2;

  // Helper to render one running osc into L/R via the rotation recurrence.
  // Avoids calling Math.sin per sample. goesLeft/Right control which
  // channels accumulate.
  const renderOsc = (f, phase, amp, goesLeft, goesRight) => {
    const dTheta = TWO_PI * f / sampleRate;
    let theta = (phase || 0) - (N - 1 + sampleOffsetBackward) * dTheta;
    theta -= TWO_PI * Math.floor((theta + Math.PI) / TWO_PI);
    let sinT = Math.sin(theta);
    let cosT = Math.cos(theta);
    const sinD = Math.sin(dTheta);
    const cosD = Math.cos(dTheta);
    for (let s = 0; s < N; s++) {
      const v = amp * sinT;
      if (goesLeft) L[s] += v;
      if (goesRight) R[s] += v;
      const newSin = sinT * cosD + cosT * sinD;
      const newCos = cosT * cosD - sinT * sinD;
      sinT = newSin;
      cosT = newCos;
    }
  };

  for (let k = 0; k < freqs.length; k++) {
    const muted = audioEngine.isMuted(k);
    const amp = (muted ? 0 : (volumes[k] || 0)) * droneScale;
    if (amp <= 0) continue;
    const f = freqs[k];
    if (!(f > 0)) continue;

    const partner = partners[k];
    const stereoMode = partner && partner.audible;

    if (stereoMode) {
      // Each drone is two oscillators in stereo mode: primary goes L
      // only, partner goes R only. Routing map is bypassed.
      renderOsc(f, phases[k], amp, true, false);
      if (partner.freq > 0) {
        renderOsc(partner.freq, partner.phase, amp, false, true);
      }
    } else {
      // L/R mode: primary follows routingMap; partner silent.
      const channels = routingMap[k] || [];
      const goesLeft = channels.includes(0);
      const goesRight = channels.includes(1);
      if (!goesLeft && !goesRight) continue;
      renderOsc(f, phases[k], amp, goesLeft, goesRight);
    }
  }

  // Keyboard voices — same recurrence, with equal-power L/R split
  // matching StereoPannerNode's behavior so a v.pan = 0 voice splits
  // 0.707/0.707 across L and R (not 0.5/0.5), and full L/R lands at
  // 1/0 and 0/1.
  const voices = keyboardVoiceManager.getVoicesForSynth();
  for (const v of voices) {
    const f = v.freq;
    if (!(f > 0)) continue;
    const amp = v.amp * keyboardScale;
    if (amp <= 0) continue;

    const panAngle = (v.pan + 1) * Math.PI / 4; // [-1,1] → [0, π/2]
    const lAmp = Math.cos(panAngle) * amp;
    const rAmp = Math.sin(panAngle) * amp;

    const dTheta = TWO_PI * f / sampleRate;
    let theta = v.phase - (N - 1 + sampleOffsetBackward) * dTheta;
    theta -= TWO_PI * Math.floor((theta + Math.PI) / TWO_PI);
    let sinT = Math.sin(theta);
    let cosT = Math.cos(theta);
    const sinD = Math.sin(dTheta);
    const cosD = Math.cos(dTheta);

    for (let s = 0; s < N; s++) {
      L[s] += lAmp * sinT;
      R[s] += rAmp * sinT;
      const newSin = sinT * cosD + cosT * sinD;
      const newCos = cosT * cosD - sinT * sinD;
      sinT = newSin;
      cosT = newCos;
    }
  }

  return { L, R };
}

// Hilbertscope — plots the analytic signal (x, ĥ) in the complex plane,
// where ĥ is the Hilbert transform (90° phase shift) of x. For a pure
// sine x = amp·sin(θ), the Hilbert partner is −amp·cos(θ), so each
// oscillator traces a perfect circle of radius = its amplitude,
// rotating at its own frequency. A mix of N oscillators composes
// rotating vectors into epicycle / Fourier-drawing figures. Vector
// magnitude = instantaneous envelope; vector angle = instantaneous
// phase. Output fits the same [-1, 1] envelope as synthStereoData
// (same masterScale-based count clipping), so drawXY's mapping works
// as-is.
function synthHilbertData(bufferSize, sampleRate) {
  const freqs = audioEngine.getAllFrequencies();
  const phases = audioEngine.getAllPhases();
  const volumes = audioEngine.volumeValues || [];
  const droneScale = audioEngine.getDroneEffectiveGain();
  const keyboardScale = audioEngine.getKeyboardEffectiveGain();

  const X = new Float32Array(bufferSize);
  const Y = new Float32Array(bufferSize);
  const TWO_PI = Math.PI * 2;

  for (let k = 0; k < freqs.length; k++) {
    const muted = audioEngine.isMuted(k);
    const amp = (muted ? 0 : (volumes[k] || 0)) * droneScale;
    if (amp <= 0) continue;
    const f = freqs[k];
    if (!(f > 0)) continue;

    const dTheta = TWO_PI * f / sampleRate;
    let theta = (phases[k] || 0) - (bufferSize - 1) * dTheta;
    theta -= TWO_PI * Math.floor((theta + Math.PI) / TWO_PI);
    let sinT = Math.sin(theta);
    let cosT = Math.cos(theta);
    const sinD = Math.sin(dTheta);
    const cosD = Math.cos(dTheta);

    for (let s = 0; s < bufferSize; s++) {
      // x = signal = amp·sin(θ); y = Hilbert(x) = −amp·cos(θ).
      X[s] += amp * sinT;
      Y[s] -= amp * cosT;
      const newSin = sinT * cosD + cosT * sinD;
      const newCos = cosT * cosD - sinT * sinD;
      sinT = newSin;
      cosT = newCos;
    }
  }

  // Keyboard voices — Hilbert is mono (analytic of the L+R mix), so
  // panning is irrelevant: each voice contributes the full amp regardless
  // of where it lands in the stereo field.
  const voices = keyboardVoiceManager.getVoicesForSynth();
  for (const v of voices) {
    const f = v.freq;
    if (!(f > 0)) continue;
    const amp = v.amp * keyboardScale;
    if (amp <= 0) continue;

    const dTheta = TWO_PI * f / sampleRate;
    let theta = v.phase - (bufferSize - 1) * dTheta;
    theta -= TWO_PI * Math.floor((theta + Math.PI) / TWO_PI);
    let sinT = Math.sin(theta);
    let cosT = Math.cos(theta);
    const sinD = Math.sin(dTheta);
    const cosD = Math.cos(dTheta);

    for (let s = 0; s < bufferSize; s++) {
      X[s] += amp * sinT;
      Y[s] -= amp * cosT;
      const newSin = sinT * cosD + cosT * sinD;
      const newCos = cosT * cosD - sinT * sinD;
      sinT = newSin;
      cosT = newCos;
    }
  }

  return { X, Y };
}

// X-Y (Lissajous) scope — draws stereo time-domain data with left channel
// on X and right channel on Y, adaptive sampling + smoothing, colored line
// over glow over white core. Fade-persistent clearing is the caller's
// responsibility (so side-by-side scopes can share a single fade pass
// instead of stacking alpha).
function drawXY(
  ctx,
  scopeSize, scopeOffsetX, scopeOffsetY,
  lineScale, r, g, b, timeData1, timeData2,
  options = {}
) {
  // source='audio' means the input is the analyzer's actual post-FX
  // signal (fold + shape). The complexity-based smoothing below was
  // tuned for synth mode where direction-change count ≈ "many oscs";
  // applied to a folded signal it averages adjacent samples 90% and
  // erases the fold's harmonics. Audio mode uses fixed minimal
  // smoothing so the fold/shape detail survives the render.
  // lineWidthScale / outlineScale: user multipliers from the Hydra
  // panel — 1.0 leaves the figure looking like the original.
  // rotation: 0 = square (L on X, R on Y), +1 = diamond rotated +45°,
  // −1 = diamond rotated −45° (mirror diamond). Both diamond modes
  // scale by 1/√2 so the rotated unit square fits the same scopeSize;
  // the sign flips which direction L=R maps to. Mono content (L=R)
  // draws vertically in either diamond direction, but asymmetric
  // lissajous figures mirror across the vertical axis between the two.
  const {
    source = 'synth',
    lineWidthScale = 1,
    outlineScale = 1,
    rotation = 0,
  } = options;
  const cx = scopeOffsetX + scopeSize / 2;
  const cy = scopeOffsetY + scopeSize / 2;
  const rotated = rotation === 1 || rotation === -1;
  const rotSign = rotation === -1 ? -1 : 1;
  const dataLen = timeData1.length;
  // Render the entire incoming buffer. The synth helpers now produce
  // exactly the desired length per frame (adaptive on freq via
  // adaptiveBufferSize), so we don't need to re-trim here. Cap at
  // VIZ_BUF_MAX_N as a defensive ceiling for callers that pass in
  // longer buffers.
  const renderStart = Math.max(0, dataLen - VIZ_BUF_MAX_N);

  let sampleStep, smoothingFactor, colorWidth, whiteWidth;
  if (source === 'audio') {
    // Walk every sample, lightly bind successive points just for visual
    // continuity. Line widths fixed at the synth-mode "low complexity"
    // baseline — wider strokes would re-blob the fold detail we're
    // trying to expose.
    sampleStep = 1;
    smoothingFactor = 0.2;
    colorWidth = 18 * lineScale;
    whiteWidth = 4 * lineScale;
  } else {
    // Direction-change count over the head of the rendered window = rough
    // frequency proxy. Drives adaptive sample step, line width, and
    // smoothing so high-frequency content renders cleanly without a hard
    // performance hit.
    let directionChanges = 0;
    let prevDiff = 0;
    const scanEnd = Math.min(dataLen, renderStart + 256);
    for (let i = renderStart + 2; i < scanEnd; i++) {
      const diff = timeData1[i] - timeData1[i - 1];
      if ((diff > 0 && prevDiff < 0) || (diff < 0 && prevDiff > 0)) {
        directionChanges++;
      }
      prevDiff = diff;
    }
    const complexity = Math.min(directionChanges / 50, 1);
    sampleStep = Math.round(1 + complexity * 7);
    colorWidth = (20 + complexity * 10) * lineScale;
    whiteWidth = (5 + complexity * 3) * lineScale;
    smoothingFactor = 0.6 + complexity * 0.3;
  }
  // Apply the user multipliers from the Hydra panel. lineWidthScale
  // affects the white core stroke; outlineScale affects the colored
  // outer/glow stroke. Both default to 1 so the look matches pre-
  // slider rendering.
  whiteWidth *= lineWidthScale;
  colorWidth *= outlineScale;

  const strokePath = (color, lw, blur, glowColor) => {
    ctx.beginPath();
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.shadowBlur = blur;
    ctx.shadowColor = glowColor;
    let prevX = null;
    let prevY = null;
    for (let i = renderStart; i < dataLen; i += sampleStep) {
      let x1 = ((timeData1[i] + 1) / 2) * scopeSize + scopeOffsetX;
      let y1 = ((timeData2[i] + 1) / 2) * scopeSize + scopeOffsetY;
      if (rotated) {
        // Rotate ±45° around (cx, cy) and scale 1/√2 in one matrix:
        //   (dx', dy') = ((dx - s·dy)/2, (s·dx + dy)/2)
        // s = +1 rotates one way, s = −1 the other. Done in screen
        // coords so stroke widths and shadow blur stay isotropic
        // (ctx.rotate + ctx.scale would shrink them by 1/√2 too).
        const dx = x1 - cx;
        const dy = y1 - cy;
        x1 = cx + (dx - rotSign * dy) / 2;
        y1 = cy + (rotSign * dx + dy) / 2;
      }
      if (prevX !== null && prevY !== null) {
        x1 = prevX * smoothingFactor + x1 * (1 - smoothingFactor);
        y1 = prevY * smoothingFactor + y1 * (1 - smoothingFactor);
      }
      if (i === renderStart) ctx.moveTo(x1, y1); else ctx.lineTo(x1, y1);
      prevX = x1;
      prevY = y1;
    }
    ctx.stroke();
  };

  const col = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 1)`;
  const glowCol = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 0.8)`;
  strokePath(col, colorWidth, 25 * lineScale, glowCol);
  strokePath('rgba(255, 255, 255, 1)', whiteWidth, 10 * lineScale, 'rgba(255, 255, 255, 0.6)');

  ctx.shadowBlur = 0;
}

/**
 * Oscilloscope component - Canvas-based visualization
 * Uses refs and imperative animation loop to avoid React re-render overhead
 */
export default function Oscilloscope({
  uiMode = 'simple',
  staticMode = 'beating',
  staticPeriods = 10,
  staticLineWidth = 1.0,
  staticOutlineThickness = 0,
  vizMode = 0,
  vizCycles = 13,
  // Lissajous-specific multipliers (vizMode 0). Sliders in the Hydra
  // panel drive these; defaults of 1 preserve the look from before
  // those sliders existed.
  vizScale = 1,
  vizLineWidth = 1,
  vizOutline = 1,
  // Lissajous rotation: 0 = square (axis-aligned L/R), +1 = diamond
  // (+45°), −1 = mirror diamond (−45°). Diamond modes scale by 1/√2
  // so the figure stays within the original scope bounds.
  vizRotation = 0,
}) {
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const dimensionsRef = useRef({ width: 0, height: 0, scaleX: 1, scaleY: 1 });

  const uiModeRef = useRef(uiMode);
  useEffect(() => {
    uiModeRef.current = uiMode;
  }, [uiMode]);
  const staticModeRef = useRef(staticMode);
  useEffect(() => {
    staticModeRef.current = staticMode;
  }, [staticMode]);
  const staticPeriodsRef = useRef(staticPeriods);
  useEffect(() => {
    staticPeriodsRef.current = staticPeriods;
  }, [staticPeriods]);
  const staticLineWidthRef = useRef(staticLineWidth);
  useEffect(() => {
    staticLineWidthRef.current = staticLineWidth;
  }, [staticLineWidth]);
  const staticOutlineRef = useRef(staticOutlineThickness);
  useEffect(() => {
    staticOutlineRef.current = staticOutlineThickness;
  }, [staticOutlineThickness]);
  const vizScaleRef = useRef(vizScale);
  useEffect(() => { vizScaleRef.current = vizScale; }, [vizScale]);
  const vizLineWidthRef = useRef(vizLineWidth);
  useEffect(() => { vizLineWidthRef.current = vizLineWidth; }, [vizLineWidth]);
  const vizOutlineRef = useRef(vizOutline);
  useEffect(() => { vizOutlineRef.current = vizOutline; }, [vizOutline]);
  const vizRotationRef = useRef(vizRotation);
  useEffect(() => { vizRotationRef.current = vizRotation; }, [vizRotation]);

  // Visualizer mode (controlled by parent via prop):
  //   0 — single centered synthesized XY scope (circle)
  //   1 — tall standing-wave (1D static line)
  //   2 — face: two synth XY "eyes" + 1D "mouth" beneath
  //   3 — Hilbertscope: plots (signal, Hilbert-transform) per sample —
  //       each osc traces a circle, composite is a Fourier epicycle.
  const vizModeRef = useRef(vizMode);
  useEffect(() => {
    vizModeRef.current = vizMode;
  }, [vizMode]);
  // User-controlled "trace cycles" — the synth buffer length per frame
  // tracks this × sampleRate / lowest-active-freq, clamped. Higher =
  // more history (richer drift at low freqs), lower = crisper figures
  // at high freqs. See research/oscilloscope-frequency-adaptive.md §5.
  const vizCyclesRef = useRef(vizCycles);
  useEffect(() => {
    vizCyclesRef.current = vizCycles;
  }, [vizCycles]);

  // Per-oscillator rendered amplitude, tweened toward the real (muted-or-not)
  // volume each frame so mute/unmute fades the static trace instead of
  // snapping it.
  const renderVolumesRef = useRef([]);
  // Smoothed fundamental + periods, tweened toward targets so zoom and
  // mute transitions glide rather than snap.
  const smoothedWindowRef = useRef({ fundamental: 0, periods: 0 });
  // Smoothed bottom-reserved pixels. The target changes with uiMode and
  // we tween so the layout glides in sync with the CSS panel animation
  // (which uses a 0.3 s cubic-bezier transition on .orb-backdrop.height).
  const smoothedBottomRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Resize handler. Sizes the backing store at devicePixelRatio so the
    // render stays crisp on HiDPI / Retina displays, while keeping the CSS
    // size and all drawing coordinates in CSS pixels via setTransform.
    const resizeCanvas = () => {
      const cssWidth = window.innerWidth;
      const cssHeight = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = cssHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dimensionsRef.current = {
        width: cssWidth,
        height: cssHeight,
        scaleX: cssWidth / 1024,
        scaleY: cssHeight / 1024
      };
    };
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Pre-calculate constants for color cycling
    const TWO_PI = 2 * Math.PI;
    const PHASE_OFFSET = TWO_PI / 3;
    const CYCLE_TIME = 20 * 60 * 1000;
    
    // Animation loop - runs independently of React
    // Matches original: iterates all points, no sampling
    const drawScope = () => {
      animationFrameRef.current = requestAnimationFrame(drawScope);

      if (!audioEngine.initialized) return;

      // Advance per-oscillator phase accumulators once per frame so the
      // static waveform draws the actual audio phase (and therefore the
      // real beat pattern), not an idealized all-phases-aligned snapshot.
      audioEngine.updatePhases();
      // Same advance for keyboard voices so their contributions in the
      // synth XY / Hilbert paths render in the right phase relationship
      // with the drone.
      keyboardVoiceManager.updatePhases();
      // Then rebase the accumulator from what the analyzer actually
      // sees, eliminating drift from Web Audio start-phase uncertainty
      // and freq-smoothing approximation. Oscillators routed only to
      // output channels > 1 stay on the accumulator (no analyzer to
      // measure them from).
      audioEngine.calibratePhases();

      const { width, height, scaleX, scaleY } = dimensionsRef.current;

      // Calculate color based on 20-minute cycle.
      const position = (Date.now() % CYCLE_TIME) / CYCLE_TIME;
      const angle = position * TWO_PI;
      const r = Math.sin(angle) * 127 + 128;
      const g = Math.sin(angle + PHASE_OFFSET) * 127 + 128;
      const b = Math.sin(angle + PHASE_OFFSET * 2) * 127 + 128;
      const lineScale = Math.min(scaleX, scaleY);

      // Bottom-reserved strip follows uiMode — simple: ~top-of-orbs
      // (135 px), expanded: full orb-backdrop + panel (~340 px),
      // fullscreen: thin bar (60 px). Tweened to match the CSS
      // panel-expand animation.
      const uiMode = uiModeRef.current;
      const targetBottom = uiMode === 'expanded' ? 340
        : uiMode === 'fullscreen' ? 60
        : 135;
      if (smoothedBottomRef.current === null) {
        smoothedBottomRef.current = targetBottom;
      } else {
        smoothedBottomRef.current +=
          (targetBottom - smoothedBottomRef.current) * 0.12;
      }
      const BOTTOM_RESERVED = Math.round(smoothedBottomRef.current);
      const usableHeight = Math.max(0, height - BOTTOM_RESERVED);
      const staticStyle = staticModeRef.current;
      const sampleRate = audioEngine.audioContext
        ? audioEngine.audioContext.sampleRate
        : 44100;

      // Opaque clear of the reserved bottom strip every frame so the
      // orbs / controls always have a clean backdrop regardless of
      // what mode the visualizer is in.
      ctx.fillStyle = 'rgba(0, 0, 0, 1)';
      ctx.fillRect(0, usableHeight, width, height - usableHeight);

      const vizMode = vizModeRef.current;

      // Adaptive synth-buffer length — driven by the highest active
      // freq + the user's "cycles" slider. Computed once per frame so
      // every mode that consumes synth buffers gets the same N this
      // tick. See research/oscilloscope-frequency-adaptive.md.
      const synthN = adaptiveBufferSize(
        highestActiveFreq(),
        sampleRate,
        vizCyclesRef.current
      );

      // Per-mode source policy:
      //   0 (Circle), 2 (Face)  → 'audio'  (analyzer's actual signal,
      //                            so wavefolding + setPeriodicWave
      //                            shapes show through visibly)
      //   3 (Hilbert)           → 'synth'  (the per-osc circles +
      //                            Fourier-epicycle interpretation only
      //                            holds for pure sines; the FIR
      //                            audio path is technically valid but
      //                            visually less informative)
      //   1 (Standing line)     → synth, baked into drawStatic
      //
      // Pulls a stereo (L, R) pair appropriate for the source.
      // 'audio' returns subarray views of the analyzer's time-domain
      // buffer (post-master, post-fold, post-shape — the actual sound).
      // 'synth' returns freshly-synthesized pure-sine arrays from osc
      // phase. Both are length-bounded by synthN so the viz density
      // stays consistent across sources.
      const getXY = (source) => {
        if (source === 'audio') {
          // Read the analyzer directly. In 'stereo' mode (drone or
          // keyboard) the same signal goes to both channels, so the
          // lissajous collapses to a diagonal — that's an accurate
          // reading of what's playing. Detune still shows up as
          // beating in either L or R individually.
          const L = audioEngine.getTimeDataLeft();
          const R = audioEngine.getTimeDataRight();
          if (!L || !R) return { L: new Float32Array(0), R: new Float32Array(0) };
          const start = Math.max(0, L.length - synthN);
          return { L: L.subarray(start), R: R.subarray(start) };
        }
        return synthStereoData(synthN, sampleRate);
      };

      // Hilbert path is synth-only by policy. The audio variant
      // (FIR-transformed mono) is left available below in case we
      // expose it again later, but the call site picks 'synth'.
      const getHilbertXY = (source) => {
        if (source === 'audio') {
          const L = audioEngine.getTimeDataLeft();
          const R = audioEngine.getTimeDataRight();
          if (!L || !R) return { X: new Float32Array(0), Y: new Float32Array(0) };
          const N = L.length;
          const { mono, imag } = ensureHilbertScratch(N);
          for (let i = 0; i < N; i++) mono[i] = (L[i] + R[i]) * 0.5;
          hilbertTransform(mono, imag);
          const start = Math.max(0, N - synthN);
          return { X: mono.subarray(start), Y: imag.subarray(start) };
        }
        return synthHilbertData(synthN, sampleRate);
      };

      if (vizMode === 0) {
        // ── MODE 0: single centered XY scope ──────────────────────────
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, usableHeight);
        // vizScale is the user's overall-zoom multiplier on the figure.
        // 1 = legacy 95%-fit; 0.5 = half size; 1.5 = pushes to fill.
        const scopeSize = Math.max(0, Math.min(width, usableHeight) * 0.95 * vizScaleRef.current);
        const scopeX = (width - scopeSize) / 2;
        const scopeY = (usableHeight - scopeSize) / 2;
        const { L, R } = getXY('audio');
        drawXY(ctx, scopeSize, scopeX, scopeY, lineScale, r, g, b, L, R, {
          source: 'audio',
          lineWidthScale: vizLineWidthRef.current,
          outlineScale: vizOutlineRef.current,
          rotation: vizRotationRef.current,
        });

      } else if (vizMode === 1) {
        // ── MODE 1: tall standing wave filling the scope region ──────
        // Colored aggregate + narrower stroke so it reads as part of
        // the scope's visual language rather than a separate readout.
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.fillRect(0, 0, width, usableHeight);
        if (staticStyle !== 'off') {
          drawStatic(
            ctx, width, usableHeight, lineScale, r, g, b,
            renderVolumesRef.current, smoothedWindowRef.current,
            staticStyle, staticPeriodsRef.current,
            {
              lineWidthScale: staticLineWidthRef.current,
              outlineThickness: staticOutlineRef.current,
            }
          );
        }

      } else if (vizMode === 2) {
        // ── MODE 2: face (two eyes + mouth) ───────────────────────────
        // Layout goals:
        // 1. Eye span never narrower than the mouth — on a narrow
        //    viewport we don't want a wide mouth hanging off the face.
        //    Enforced by passing the eye-span width to drawStatic (so
        //    its internal traceWidth math is bounded by that) and
        //    translating the mouth horizontally to sit under the eyes.
        // 2. The whole face (eyes + gap + mouth) is vertically centered
        //    in the usable area, so empty space ends up equally above
        //    and below instead of stacking all at the bottom.
        // 3. Gaps and mouth height scale off eyeSize so proportions
        //    stay consistent across screen sizes.
        const eyeSize = Math.max(
          0,
          Math.min(width * 0.35, usableHeight * 0.42)
        );
        const eyeGap = eyeSize * 0.1;
        const totalEyesWidth = eyeSize * 2 + eyeGap;
        const eyesOffsetX = (width - totalEyesWidth) / 2;
        const leftEyeX = eyesOffsetX;
        const rightEyeX = eyesOffsetX + eyeSize + eyeGap;

        // Mouth horizontal bounds track the eye span exactly.
        const mouthWidth = totalEyesWidth;
        const mouthOffsetX = eyesOffsetX;

        const mouthGap = Math.max(12, Math.round(eyeSize * 0.15));
        const mouthHeight = Math.max(
          0,
          Math.min(
            Math.round(eyeSize * 0.5),
            usableHeight - eyeSize - mouthGap - 20
          )
        );

        // Center vertically. Clamp to a 10-px top margin so the eyes
        // never touch the viewport edge.
        const totalFaceHeight = eyeSize + mouthGap + mouthHeight;
        const eyesTop = Math.max(
          10,
          Math.round((usableHeight - totalFaceHeight) / 2)
        );
        const mouthTop = eyesTop + eyeSize + mouthGap;

        // Fade-clear everything above the mouth (includes the eye
        // region + gap so trails bleeding into the gap fade out too).
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, mouthTop);
        // Opaque clear of the mouth region + below — static wave has
        // no persistence.
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.fillRect(0, mouthTop, width, usableHeight - mouthTop);

        // Both eyes show the full L/R mix — identical traces left and
        // right. Source switches between synth (clean sines) and audio
        // (post-master analyzer buffer) per the Visualizer setting.
        const { L, R } = getXY('audio');
        const xyOpts = {
          source: 'audio',
          lineWidthScale: vizLineWidthRef.current,
          outlineScale: vizOutlineRef.current,
          rotation: vizRotationRef.current,
        };
        drawXY(ctx, eyeSize, leftEyeX, eyesTop, lineScale, r, g, b, L, R, xyOpts);
        drawXY(ctx, eyeSize, rightEyeX, eyesTop, lineScale, r, g, b, L, R, xyOpts);

        // Mouth: white-line static wave, constrained to the eye span
        // so it can never be wider than the eyes above it.
        if (staticStyle !== 'off' && mouthHeight > 0) {
          ctx.save();
          ctx.translate(mouthOffsetX, mouthTop);
          drawStatic(
            ctx, mouthWidth, mouthHeight, lineScale, r, g, b,
            renderVolumesRef.current, smoothedWindowRef.current,
            staticStyle, staticPeriodsRef.current,
            {
              lineWidthScale: staticLineWidthRef.current,
              outlineThickness: staticOutlineRef.current,
            }
          );
          ctx.restore();
        }

      } else if (vizMode === 3) {
        // ── MODE 3: Hilbertscope ─────────────────────────────────────
        // Analytic-signal plot: each osc traces a circle, composite is
        // a Fourier epicycle. Reuses drawXY for visual consistency.
        // Sized smaller than the other XY scopes because the analytic
        // envelope sums osc amplitudes, so multi-osc figures naturally
        // fill more of the [-1, 1] box than the L/R-stereo modes do.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, usableHeight);
        const scopeSize = Math.max(0, Math.min(width, usableHeight) * 0.95 * 0.6 * vizScaleRef.current);
        const scopeX = (width - scopeSize) / 2;
        const scopeY = (usableHeight - scopeSize) / 2;
        const { X, Y } = getHilbertXY('synth');
        drawXY(ctx, scopeSize, scopeX, scopeY, lineScale, r, g, b, X, Y, {
          source: 'synth',
          lineWidthScale: vizLineWidthRef.current,
          outlineScale: vizOutlineRef.current,
          rotation: vizRotationRef.current,
        });
      }
    };

    // Start animation loop
    drawScope();
    
    // Cleanup
    return () => {
      window.removeEventListener('resize', resizeCanvas);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);
  
  return (
    <div className="oscilloscope-container">
      <canvas ref={canvasRef} id="scope" />
    </div>
  );
}
