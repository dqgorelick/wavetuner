import { useEffect, useRef } from 'react';
import { audioFeatures } from '../audio/AudioFeatures';

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

export default function DissonanceMeter() {
  // Refs for each meter row's fill + label, plus last-displayed values
  // so we skip DOM text writes when unchanged.
  const refs = {
    ampFill: useRef(null), ampLabel: useRef(null), lastAmp: useRef(-1),
    satFill: useRef(null), satLabel: useRef(null), lastSat: useRef(-1),
    dissFill: useRef(null), dissLabel: useRef(null), lastDiss: useRef(-1),
    beat: useRef(null), lastBeat: useRef(-1),
    centFill: useRef(null), centLabel: useRef(null), lastCent: useRef(-1),
    fluxFill: useRef(null), fluxLabel: useRef(null), lastFlux: useRef(-1),
    auraFill: useRef(null), auraLabel: useRef(null), lastAura: useRef(-1),
    densFill: useRef(null), densLabel: useRef(null), lastDens: useRef(-1),
  };

  useEffect(() => {
    let raf = null;
    const tick = () => {
      _updateMeter(refs.ampFill, refs.ampLabel, refs.lastAmp,
        Math.round(Math.min(1, audioFeatures.amp) * 100));
      _updateMeter(refs.satFill, refs.satLabel, refs.lastSat,
        Math.round(audioFeatures.saturation * 100));
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
      </div>
    </div>
  );
}
