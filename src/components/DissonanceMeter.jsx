import { useEffect, useRef, useState } from 'react';
import {
  audioFeatures,
  getAuraThreshold,
  setAuraThreshold,
  AURA_THRESHOLD_MIN,
  AURA_THRESHOLD_MAX,
} from '../audio/AudioFeatures';

/**
 * Thin horizontal meter showing Sethares dissonance of the current
 * oscillator set, 0..1. Imperative — reads audioFeatures directly each
 * frame and resizes a fill bar via ref so we don't churn React state
 * at 60 fps. The label updates only when the rounded value changes.
 */
// Map a 0..1 fill value plus a target percentage to a DOM update, using
// the lastRef pattern to skip textContent writes when nothing changed.
// (style.width is cheap to write every frame; textContent isn't.)
function _updateMeter(fillRef, labelRef, lastRef, pct, labelText) {
  const fill = fillRef.current;
  const label = labelRef.current;
  if (fill) fill.style.width = `${pct}%`;
  if (label && pct !== lastRef.current) {
    label.textContent = labelText !== undefined ? labelText : `${pct}`;
    lastRef.current = pct;
  }
}

// Draw the aura-target curve as a function of dissonance, with the
// current dissonance + aura plotted on top so the user can see exactly
// where they sit on the curve. The curve itself is re-rasterized only
// when the threshold changes (rare); the marker dot redraws every
// frame off the live audioFeatures values.
function _drawCurve(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const threshold = getAuraThreshold();
  ctx.clearRect(0, 0, cssW, cssH);

  // Axes: dissonance 0..1 on X, aura-target 0..1 on Y (Y inverted).
  // We map directly to the canvas extents — no padding — so the curve
  // touches the corners and reads as the small inline plot it is.
  const x = (d) => d * (cssW - 1);
  const y = (t) => (1 - t) * (cssH - 1);

  // Faint baseline grid: vertical at threshold, horizontals at .25/.5/.75.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  for (const g of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, y(g));
    ctx.lineTo(cssW, y(g));
    ctx.stroke();
  }
  // Threshold line — a softer gold.
  ctx.strokeStyle = 'rgba(255, 216, 107, 0.45)';
  ctx.beginPath();
  ctx.moveTo(x(threshold) + 0.5, 0);
  ctx.lineTo(x(threshold) + 0.5, cssH);
  ctx.stroke();

  // The aura-target curve: target(d) = 1 / (1 + (d/threshold)²).
  // Sample at ~1 px per step.
  ctx.strokeStyle = '#ffd86b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const steps = Math.max(32, Math.floor(cssW));
  for (let i = 0; i <= steps; i++) {
    const d = i / steps;
    const dr = d / threshold;
    const t = 1 / (1 + dr * dr);
    if (i === 0) ctx.moveTo(x(d), y(t));
    else ctx.lineTo(x(d), y(t));
  }
  ctx.stroke();

  // Live marker: where we are RIGHT NOW on the curve.
  // X = current dissonance, Y on the curve = ceiling at this dissonance;
  // a second small line shows the actual aura level (which lerps toward
  // the ceiling). When the chord is steady, the dot and the aura tick
  // converge.
  const diss = Math.max(0, Math.min(1, audioFeatures.dissonance));
  const dr = diss / threshold;
  const targetCeiling = 1 / (1 + dr * dr);
  const aura = Math.max(0, Math.min(1, audioFeatures.aura));

  // Aura-level horizontal tick (where the meter currently sits).
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x(diss) - 5, y(aura));
  ctx.lineTo(x(diss) + 5, y(aura));
  ctx.stroke();

  // Current-position dot on the ceiling curve.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x(diss), y(targetCeiling), 2.5, 0, Math.PI * 2);
  ctx.fill();
}

export default function DissonanceMeter() {
  // Threshold is stored 0..1 (same units as dissonance) but the slider
  // shows 1..100 to match the meter's 0..100% display.
  const [threshold, setThreshold] = useState(() => getAuraThreshold());
  const handleThreshold = (e) => {
    const pct = parseFloat(e.target.value);
    const v = pct / 100;
    setThreshold(v);
    setAuraThreshold(v);
  };
  // Refs for each meter row's fill + label, plus last-displayed values
  // so we skip DOM text writes when unchanged.
  const refs = {
    ampFill: useRef(null), ampLabel: useRef(null), lastAmp: useRef(-1),
    satFill: useRef(null), satLabel: useRef(null), lastSat: useRef(-1),
    loudFill: useRef(null), loudLabel: useRef(null), lastLoud: useRef(-1),
    dissFill: useRef(null), dissLabel: useRef(null), lastDiss: useRef(-1),
    beat: useRef(null), lastBeat: useRef(-1),
    centFill: useRef(null), centLabel: useRef(null), lastCent: useRef(-1),
    fluxFill: useRef(null), fluxLabel: useRef(null), lastFlux: useRef(-1),
    auraFill: useRef(null), auraLabel: useRef(null), lastAura: useRef(-1),
    densFill: useRef(null), densLabel: useRef(null), lastDens: useRef(-1),
  };
  // Canvas ref for the aura curve + marker viz under the threshold slider.
  const curveCanvasRef = useRef(null);

  useEffect(() => {
    let raf = null;
    const tick = () => {
      _updateMeter(refs.ampFill, refs.ampLabel, refs.lastAmp,
        Math.round(Math.min(1, audioFeatures.amp) * 100));
      _updateMeter(refs.satFill, refs.satLabel, refs.lastSat,
        Math.round(audioFeatures.saturation * 100));
      _updateMeter(refs.loudFill, refs.loudLabel, refs.lastLoud,
        Math.round(audioFeatures.loudness * 100));
      _updateMeter(refs.dissFill, refs.dissLabel, refs.lastDiss,
        Math.round(audioFeatures.dissonance * 100));
      // Beat Hz — separate label inside the dissonance row.
      const beat = refs.beat.current;
      const b = audioFeatures.beating;
      const bRounded = b < 10 ? Math.round(b * 10) / 10 : Math.round(b);
      if (beat && bRounded !== refs.lastBeat.current) {
        beat.textContent = b > 0 ? `${bRounded} Hz` : '—';
        refs.lastBeat.current = bRounded;
      }
      // Centroid — display in Hz/kHz, bar scaled by log to a 200 Hz–8 kHz
      // range that covers most musical content.
      const cent = audioFeatures.centroid;
      const centBarPct = cent > 0
        ? Math.round(Math.max(0, Math.min(1, (Math.log2(cent / 200)) / Math.log2(8000 / 200))) * 100)
        : 0;
      const centLabel = cent <= 0
        ? '—'
        : cent >= 1000
          ? `${(cent / 1000).toFixed(1)} kHz`
          : `${Math.round(cent)} Hz`;
      _updateMeter(refs.centFill, refs.centLabel, refs.lastCent, centBarPct, centLabel);
      _updateMeter(refs.fluxFill, refs.fluxLabel, refs.lastFlux,
        Math.round(audioFeatures.flux * 100));
      _updateMeter(refs.densFill, refs.densLabel, refs.lastDens,
        Math.round(audioFeatures.density * 100));
      _updateMeter(refs.auraFill, refs.auraLabel, refs.lastAura,
        Math.round(audioFeatures.aura * 100));
      _drawCurve(curveCanvasRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
    // refs is a stable object of useRef calls — no deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dissonance-meter">
      <div
        className="dissonance-meter-row"
        title="Sum of audible voice amplitudes (drones + keyboard) post-bus-gain. Predicts the input level to the saturator."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Amplitude</span>
          <span className="dissonance-meter-value" ref={refs.ampLabel}>0</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill amp" ref={refs.ampFill} />
        </div>
      </div>
      <div
        className="dissonance-meter-row"
        title="Soft-limiter compression on the predicted peak amplitude. 0% = saturator passing through cleanly; rises as the master is driven into the curve's knee."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Saturation</span>
          <span className="dissonance-meter-value" ref={refs.satLabel}>0</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill sat" ref={refs.satFill} />
        </div>
      </div>
      <div
        className="dissonance-meter-row"
        title="RMS-like loudness from the post-everything FFT (after wave shape, folder, and saturation). Matches what the listener actually hears."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Loudness</span>
          <span className="dissonance-meter-value" ref={refs.loudLabel}>0</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill loud" ref={refs.loudFill} />
        </div>
      </div>
      <div
        className="dissonance-meter-row"
        title="Sethares sensory dissonance computed from the post-everything FFT — includes wave shape, folder, and saturation harmonics. Lower = consonant, higher = rough/beating."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Dissonance</span>
          <span className="dissonance-meter-value" ref={refs.dissLabel}>0</span>
          <span className="dissonance-meter-beat" ref={refs.beat}>—</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill" ref={refs.dissFill} />
        </div>
      </div>
      <div
        className="dissonance-meter-row"
        title="Spectral centroid — where the FFT energy centers. 'Brightness.' Dark drones around 150 Hz; bright saws and folded waves above 1 kHz."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Centroid</span>
          <span className="dissonance-meter-value cent" ref={refs.centLabel}>—</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill cent" ref={refs.centFill} />
        </div>
      </div>
      <div
        className="dissonance-meter-row"
        title="Spectral flux — how much the spectrum just changed. Spikes on note attacks and slider moves; settles to near-zero in steady state."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Flux</span>
          <span className="dissonance-meter-value" ref={refs.fluxLabel}>0</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill flux" ref={refs.fluxFill} />
        </div>
      </div>
      <div
        className="dissonance-meter-row"
        title="Density (spectral entropy) — how busy the scope looks. Pure sine ≈ 0; harmonic chord mid; folded / inharmonic / many-voice content high. Independent of dissonance."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Density</span>
          <span className="dissonance-meter-value" ref={refs.densLabel}>0</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill dens" ref={refs.densFill} />
        </div>
      </div>
      <div
        className="dissonance-meter-row"
        title="Aura — slow-charging 'holy light' meta-parameter. Builds when notes are consonant and audible; decays when dissonance rises or voices fade. Attack ~4s, release ~1s."
      >
        <div className="dissonance-meter-head">
          <span className="dissonance-meter-label">Aura</span>
          <span className="dissonance-meter-value" ref={refs.auraLabel}>0</span>
        </div>
        <div className="dissonance-meter-track">
          <div className="dissonance-meter-fill aura" ref={refs.auraFill} />
        </div>
        <div
          className="dissonance-meter-slider-row"
          title="Aura threshold — the dissonance value at which the aura's ceiling crosses 50%. Lower = stricter (only pristine intervals charge); higher = more permissive."
        >
          <span className="dissonance-meter-slider-label">Threshold</span>
          <input
            type="range"
            min={Math.round(AURA_THRESHOLD_MIN * 100)}
            max={Math.round(AURA_THRESHOLD_MAX * 100)}
            step={1}
            value={Math.round(threshold * 100)}
            onChange={handleThreshold}
            className="dissonance-meter-slider"
          />
          <span className="dissonance-meter-slider-value">{Math.round(threshold * 100)}</span>
        </div>
        <canvas
          ref={curveCanvasRef}
          className="dissonance-meter-curve"
          title="Aura ceiling vs dissonance. Vertical gold line = threshold. White dot = current ceiling at your current dissonance; horizontal tick = actual aura value (lerps toward the dot)."
        />
      </div>
    </div>
  );
}
