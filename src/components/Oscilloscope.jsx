import { useEffect, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';

// Kept in sync with the palette used by FrequencySpectrumBar / OscillatorControls.
const OSCILLATOR_COLORS = [
  '#ff4136', '#2ecc40', '#0074d9', '#ffdc00', '#bb8fce',
  '#85c1e9', '#82e0aa', '#f8b500', '#e74c3c', '#1abc9c',
];

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
  const fadeZone = 0.1;

  // Target fundamental (lowest active freq). Fallback chain.
  let targetFundamental = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    if (isActive(i) && freqs[i] < targetFundamental) targetFundamental = freqs[i];
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
  // Live master gain (incl. user volume, count clip-scale, and any
  // fade ramp). Scales both the wave's amplitude AND the stroke
  // alphas so the static trace shrinks + fades with master volume and
  // disappears cleanly during pause/fade-out.
  const masterMultiplier = audioEngine.getCurrentMasterGain();
  // 'wave' keeps individuals at ±0.22·h (aggregate up to 1.75× that).
  // 'beating' renders only the aggregate and gets ~1.5× the amplitude so
  // it's the dominant feature of the strip.
  const ampScale = (mode === 'beating' ? height * 0.33 : height * 0.22) * masterMultiplier;

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

  let volSum = 0;
  let maxVol = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (!isActive(i)) continue;
    volSum += renderVolumes[i];
    if (renderVolumes[i] > maxVol) maxVol = renderVolumes[i];
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

  // Anchor to the lowest-freq active oscillator so its trace stays
  // visually pinned (zero crossing at window center). Every other osc's
  // rendered phase is taken relative to the anchor, so the aggregate's
  // beat envelope evolves in real time and lines up with what you hear.
  // relPhases[k] = phases[k] - (freqs[k] / freqs[anchor]) * phases[anchor]
  // — anchor gets 0, others get their actual phase offset vs. the anchor.
  let anchorIdx = -1;
  for (let i = 0; i < freqs.length; i++) {
    if (isActive(i) && (anchorIdx === -1 || freqs[i] < freqs[anchorIdx])) {
      anchorIdx = i;
    }
  }
  const anchorFreq = anchorIdx >= 0 ? freqs[anchorIdx] : 0;
  const anchorPhase = anchorIdx >= 0 ? (phases[anchorIdx] || 0) : 0;
  const relPhases = new Array(freqs.length);
  for (let k = 0; k < freqs.length; k++) {
    relPhases[k] = anchorFreq > 0
      ? (phases[k] || 0) - (freqs[k] / anchorFreq) * anchorPhase
      : 0;
  }
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
    for (let k = 0; k < freqs.length; k++) {
      if (!isActive(k)) continue;
      const v = renderVolumes[k];
      const f = freqs[k];
      const color = OSCILLATOR_COLORS[k % OSCILLATOR_COLORS.length];
      ctx.globalAlpha = Math.min(1, v / fadeZone) * masterMultiplier;
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
        const amp = v * Math.sin(TWO_PI * f * t + relPhases[k]) * synthNorm * edgeWindow(p, edgeFade);
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
  const drawAggPath = () => {
    ctx.beginPath();
    for (let i = 0; i < samples; i++) {
      const p = i / (samples - 1);
      const t = p * windowSec - windowHalf;
      let sum = 0;
      for (let k = 0; k < freqs.length; k++) {
        if (!isActive(k)) continue;
        sum += renderVolumes[k] * Math.sin(TWO_PI * freqs[k] * t + relPhases[k]);
      }
      const x = traceOffsetX + p * traceWidth;
      const y = centerY - sum * synthNorm * ampScale * aggHeightScale * edgeWindow(p, edgeFade);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  ctx.globalAlpha = aggAlpha * masterMultiplier;
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
  // Live master gain — reflects the user's master-volume slider, the
  // count-based clip scale, AND any fadeIn/fadeOut/pause ramp on
  // masterGainNode.gain. Reading it live (vs. computing a target) means
  // the synth visually tracks the real audio through every transition.
  const masterScale = audioEngine.getCurrentMasterGain();

  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const TWO_PI = Math.PI * 2;

  for (let k = 0; k < freqs.length; k++) {
    const muted = audioEngine.isMuted(k);
    const amp = (muted ? 0 : (volumes[k] || 0)) * masterScale;
    if (amp <= 0) continue;
    const f = freqs[k];
    if (!(f > 0)) continue;

    const channels = routingMap[k] || [];
    const goesLeft = channels.includes(0);
    const goesRight = channels.includes(1);
    if (!goesLeft && !goesRight) continue;

    // Sample s represents the signal at
    //   currentTime − (N−1−s + sampleOffsetBackward) / sampleRate.
    // With sampleOffsetBackward = 0 the buffer ends at currentTime;
    // with sampleOffsetBackward = τ the whole buffer is τ samples in
    // the past (used by mode 3's Takens phase-space embedding for a
    // τ-delayed copy of the signal). phases[k] is the phase at
    // currentTime, so the phase at output-sample s is
    //   θ_s = phases[k] − (N−1−s + sampleOffsetBackward) · dθ.
    // We advance sinθ/cosθ with a rotation recurrence instead of calling
    // Math.sin N times per oscillator.
    const dTheta = TWO_PI * f / sampleRate;
    let theta = (phases[k] || 0) - (N - 1 + sampleOffsetBackward) * dTheta;
    // Wrap to [-π, π) before starting to keep the recurrence accurate.
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
  const masterScale = audioEngine.getCurrentMasterGain();

  const X = new Float32Array(bufferSize);
  const Y = new Float32Array(bufferSize);
  const TWO_PI = Math.PI * 2;

  for (let k = 0; k < freqs.length; k++) {
    const muted = audioEngine.isMuted(k);
    const amp = (muted ? 0 : (volumes[k] || 0)) * masterScale;
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
  lineScale, r, g, b, timeData1, timeData2
) {
  const dataLen = timeData1.length;
  // Render only the most recent XY_RENDER_N samples, not the full
  // analyzer buffer. calibratePhases benefits from the full 8192-sample
  // buffer (finer LSQ conditioning), but the visual Lissajous density
  // is set by the rendered window: more samples → more per-frame line
  // segments + more frame-to-frame window overlap → heavier trail
  // accumulation. 2048 samples (~46 ms at 44.1 kHz) matches the
  // previous density.
  const XY_RENDER_N = 2048;
  const renderStart = Math.max(0, dataLen - XY_RENDER_N);

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
  const sampleStep = Math.round(1 + complexity * 7);
  const colorWidth = (20 + complexity * 10) * lineScale;
  const whiteWidth = (5 + complexity * 3) * lineScale;
  const smoothingFactor = 0.6 + complexity * 0.3;

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

      if (vizMode === 0) {
        // ── MODE 0: single centered synth XY scope ────────────────────
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, usableHeight);
        const scopeSize = Math.max(0, Math.min(width, usableHeight) * 0.95);
        const scopeX = (width - scopeSize) / 2;
        const scopeY = (usableHeight - scopeSize) / 2;
        const { L, R } = synthStereoData(2048, sampleRate);
        drawXY(ctx, scopeSize, scopeX, scopeY, lineScale, r, g, b, L, R);

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

        // Both eyes show the full L/R synth mix — identical traces
        // left and right.
        const { L, R } = synthStereoData(2048, sampleRate);
        drawXY(ctx, eyeSize, leftEyeX, eyesTop, lineScale, r, g, b, L, R);
        drawXY(ctx, eyeSize, rightEyeX, eyesTop, lineScale, r, g, b, L, R);

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
        const scopeSize = Math.max(0, Math.min(width, usableHeight) * 0.95 * 0.6);
        const scopeX = (width - scopeSize) / 2;
        const scopeY = (usableHeight - scopeSize) / 2;
        const { X, Y } = synthHilbertData(2048, sampleRate);
        drawXY(ctx, scopeSize, scopeX, scopeY, lineScale, r, g, b, X, Y);
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
