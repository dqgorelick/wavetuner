import { useEffect, useState } from 'react';
import { WAVE_ANCHOR_NAMES } from '../audio/Wave';
import { FOLD_TYPE_IDS, FOLD_TYPES } from '../audio/Fold';
import WaveShapePreview from './WaveShapePreview';

/**
 * WaveControls - per-pool waveform shape + wavefolder controls.
 *
 * UNMOUNTED since 2026-08-04: the shape/fold menu merged into one
 * SourceTrayPanel body with a drone | midi/kbd pool selector, so the
 * two side-by-side copies of this section are gone. Kept as the
 * reference for the full-width layout (preview over label·track·value
 * rows) in case the settings drawer wants it back.
 *
 * Two sliders + a fold-algorithm radio group:
 *   - Shape: 0..3, lerps through sine/triangle/square/saw via the
 *     pool's Wave singleton (drives setPeriodicWave on every running
 *     oscillator in the pool).
 *   - Fold: 0..1, drives the pool's WaveShaperNode curve from
 *     identity (bypass) to a heavy fold.
 *   - Fold type: sine / triangle / buchla — picks which curve the
 *     shared builder bakes (see FOLD_TYPES). A one-line blurb for the
 *     selected algorithm renders under the group.
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

      <WaveShapePreview wave={wave} fold={fold} />

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

      <div className="fold-type-row" role="radiogroup" aria-label={`${title} fold algorithm`}>
        {FOLD_TYPE_IDS.map((id) => (
          <label key={id} className="fold-type-option">
            <input
              type="radio"
              name={`${title}-fold-type`}
              value={id}
              checked={fold.type === id}
              onChange={() => fold.setType(id)}
            />
            <span>{FOLD_TYPES[id].label}</span>
          </label>
        ))}
      </div>
      <p className="fold-type-blurb">{FOLD_TYPES[fold.type].blurb}</p>
    </div>
  );
}
