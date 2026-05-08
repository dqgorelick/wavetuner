import { useEffect, useState } from 'react';
import { reverb, ROOM_NAMES } from '../audio/Reverb';

/**
 * ReverbControls - room selector + wet/dry slider for the master-bus
 * convolution reverb. Sits AFTER the analyzer so the visualizer always
 * shows dry signal; the reverb is purely a listening effect.
 */

const ROOM_LABELS = {
  room: 'Room — small + intimate',
  hall: 'Hall — medium + diffuse',
  cathedral: 'Cathedral — long + airy',
};

export default function ReverbControls() {
  const [, setTick] = useState(0);
  useEffect(() => reverb.onChange(() => setTick(n => n + 1)), []);

  return (
    <div className="settings-section">
      <label className="settings-label">Reverb</label>

      <select
        className="settings-select"
        value={reverb.room}
        onChange={(e) => reverb.setRoom(e.target.value)}
      >
        {ROOM_NAMES.map((name) => (
          <option key={name} value={name}>{ROOM_LABELS[name] || name}</option>
        ))}
      </select>

      <div className="tune-slider-row">
        <span className="tune-slider-label">Wet</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={reverb.wet}
          onChange={(e) => reverb.setWet(parseFloat(e.target.value))}
          className="tune-slider"
        />
        <span className="tune-slider-value">
          {reverb.wet === 0 ? 'dry' : `${Math.round(reverb.wet * 100)} %`}
        </span>
      </div>
    </div>
  );
}
