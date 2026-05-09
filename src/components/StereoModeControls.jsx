import { useEffect, useState } from 'react';
import CurveEditor from './CurveEditor';

/**
 * StereoModeControls — pan-mode toggle, master detune slider, and
 * per-slot detune curve editor for one pool.
 *
 * Used twice in SettingsPanel: once bound to droneStereo, once to
 * keyboardStereo. The two pools have independent state.
 *
 *   L/R     — drones route to a single channel (defaults odd→L,
 *              even→R; patch bay can override). Keyboard voices
 *              hard-pan ±1 based on the slot's drone routing.
 *              Detune curve has no effect in this mode.
 *
 *   Stereo  — each drone is split into two oscillators, primary at
 *              base + curve[i]·detuneHz/2 → L, partner at base −
 *              curve[i]·detuneHz/2 → R. Keyboard voices inherit the
 *              detune amount from their bound slot.
 *
 * The curve editor is always visible so the user can shape the curve
 * before flipping into stereo mode.
 */
export default function StereoModeControls({ title, stereoMode, slotCount }) {
  const [, setTick] = useState(0);
  useEffect(() => stereoMode.onChange(() => setTick(n => n + 1)), [stereoMode]);

  return (
    <div className="settings-section">
      <label className="settings-label">{title}</label>

      <div className="settings-toggle-row">
        <button
          type="button"
          className={`settings-toggle-btn ${stereoMode.mode === 'lr' ? 'on' : 'off'}`}
          onClick={() => stereoMode.setMode('lr')}
          aria-pressed={stereoMode.mode === 'lr'}
          title="Hard L/R panning"
        >
          L/R
        </button>
        <button
          type="button"
          className={`settings-toggle-btn ${stereoMode.mode === 'stereo' ? 'on' : 'off'}`}
          onClick={() => stereoMode.setMode('stereo')}
          aria-pressed={stereoMode.mode === 'stereo'}
          title="Two oscillators per drone — one shifted up on L, one down on R"
        >
          Stereo
        </button>
      </div>

      <div
        className="tune-slider-row"
        title="Master detune scale in Hz. Curve nodes are relative [0..1] — actual detune per slot = node × this slider."
      >
        <span className="tune-slider-label">Detune</span>
        <input
          type="range"
          min="0"
          max="10"
          step="0.1"
          value={stereoMode.detuneHz}
          onChange={(e) => stereoMode.setDetuneHz(parseFloat(e.target.value))}
          className="tune-slider"
        />
        <span className="tune-slider-value">{stereoMode.detuneHz.toFixed(1)} Hz</span>
      </div>

      <CurveEditor stereoMode={stereoMode} slotCount={slotCount} label="Per-slot curve" />
    </div>
  );
}
