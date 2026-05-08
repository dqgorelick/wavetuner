import { useEffect, useState } from 'react';
import { WAVE_ANCHOR_NAMES } from '../audio/Wave';

/**
 * WaveControls - per-pool waveform shape + wavefolder controls.
 *
 * Two sliders:
 *   - Shape: 0..3, lerps through sine/triangle/saw/square via the
 *     pool's Wave singleton (drives setPeriodicWave on every running
 *     oscillator in the pool).
 *   - Fold: 0..1, drives the pool's WaveShaperNode curve from
 *     identity (bypass) to a heavy sine fold.
 *
 * Subscribes to both modules' onChange so external mutations (URL
 * restore, programmatic) keep the readouts in sync.
 */

function shapeLabel(p) {
  // Identify the closest anchor and indicate fractional drift.
  const seg = Math.min(2, Math.floor(p));
  const t = p - seg;
  if (t < 0.05) return WAVE_ANCHOR_NAMES[seg];
  if (t > 0.95) return WAVE_ANCHOR_NAMES[seg + 1];
  return `${WAVE_ANCHOR_NAMES[seg]} → ${WAVE_ANCHOR_NAMES[seg + 1]} ${Math.round(t * 100)}%`;
}

export default function WaveControls({ title, wave, fold }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const u1 = wave.onChange(() => setTick(n => n + 1));
    const u2 = fold.onChange(() => setTick(n => n + 1));
    return () => { u1(); u2(); };
  }, [wave, fold]);

  return (
    <div className="settings-section">
      <label className="settings-label">{title}</label>

      <div className="tune-slider-row">
        <span className="tune-slider-label">Shape</span>
        <input
          type="range"
          min="0"
          max="3"
          step="0.01"
          value={wave.position}
          onChange={(e) => wave.setPosition(parseFloat(e.target.value))}
          className="tune-slider"
        />
        <span className="tune-slider-value">{shapeLabel(wave.position)}</span>
      </div>

      <div className="tune-slider-row">
        <span className="tune-slider-label">Fold</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={fold.amount}
          onChange={(e) => fold.setAmount(parseFloat(e.target.value))}
          className="tune-slider"
        />
        <span className="tune-slider-value">
          {fold.amount === 0 ? 'off' : `${Math.round(fold.amount * 100)} %`}
        </span>
      </div>
    </div>
  );
}
