import { useEffect, useState } from 'react';
import { stereoWidth } from '../audio/StereoWidth';

/**
 * WidthControls - Pan-mode toggle + width slider.
 *
 *   L/R         — keyboard voices inherit the drone slot's L/R
 *                  routing (legacy hard pan). Width controls bus M/S
 *                  narrowing for both pools.
 *
 *   Voice Pan   — Oberheim-style. Each voice gets a fresh random pan
 *                  in [-width, +width] at noteOn; live voices ramp to
 *                  fresh randoms on slider drag. Width also controls
 *                  the drone bus crossfeed.
 *
 * Lissajous follows the mode: clean audio in L/R, synth round-robin
 * in Voice Pan (since the audio is smeared by random pans).
 */
export default function WidthControls() {
  const [, setTick] = useState(0);
  useEffect(() => stereoWidth.onChange(() => setTick(n => n + 1)), []);

  return (
    <div className="settings-section">
      <label className="settings-label">Pan mode</label>

      <div className="settings-toggle-row">
        <button
          type="button"
          className={`settings-toggle-btn ${stereoWidth.mode === 'lr' ? 'on' : 'off'}`}
          onClick={() => stereoWidth.setMode('lr')}
          aria-pressed={stereoWidth.mode === 'lr'}
          title="Hard L/R panning inherited from drone routing"
        >
          L/R
        </button>
        <button
          type="button"
          className={`settings-toggle-btn ${stereoWidth.mode === 'voicepan' ? 'on' : 'off'}`}
          onClick={() => stereoWidth.setMode('voicepan')}
          aria-pressed={stereoWidth.mode === 'voicepan'}
          title="Per-voice random panning (Oberheim-style)"
        >
          Voice Pan
        </button>
      </div>

      <div className="tune-slider-row">
        <span className="tune-slider-label">Width</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={stereoWidth.width}
          onChange={(e) => stereoWidth.setWidth(parseFloat(e.target.value))}
          className="tune-slider"
        />
        <span className="tune-slider-value">
          {stereoWidth.width === 0 ? 'mono' : `${Math.round(stereoWidth.width * 100)} %`}
        </span>
      </div>
    </div>
  );
}
