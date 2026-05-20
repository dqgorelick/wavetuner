import { useEffect, useState } from 'react';
import EnvelopeGraph from './EnvelopeGraph';

/**
 * EnvelopeControls - one Ableton-style ADSR panel for a single
 * Envelope instance.
 *
 * Two are mounted side-by-side in SettingsPanel (drone + keyboard).
 * The component subscribes to the envelope's onChange so external
 * mutations (e.g. URL state restore) keep the sliders in sync, but
 * user interaction goes envelope.set* → onChange → setState round-
 * trip via the same path.
 *
 * Time sliders use a sqrt-ms curve: slider value t ∈ [0, 1] maps to
 * ms = 1 + 9999 × t² (so 1 ms..10 s with fine control near the bottom
 * where most musical envelopes live).
 */

const MIN_MS = 1;
const MAX_MS = 10000;

function tToMs(t) {
  const c = Math.max(0, Math.min(1, t));
  return MIN_MS + (MAX_MS - MIN_MS) * c * c;
}

function msToT(ms) {
  const c = (Math.max(MIN_MS, Math.min(MAX_MS, ms)) - MIN_MS) / (MAX_MS - MIN_MS);
  return Math.sqrt(c);
}

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export default function EnvelopeControls({ title, envelope, mode = 'adsr' }) {
  const [, setTick] = useState(0);

  // Re-render whenever the envelope's values change (URL restore, the
  // other panel mounted on the same envelope, programmatic updates).
  useEffect(() => envelope.onChange(() => setTick(n => n + 1)), [envelope]);

  const attackMs = envelope.attack * 1000;
  const decayMs = envelope.decay * 1000;
  const releaseMs = envelope.release * 1000;
  const isAR = mode === 'ar';

  // In AR mode the graph should show 0 → peak → flat plateau → 0
  // (no decay slump). Feeding decay=0 / sustain=1 to the preview gives
  // that shape without teaching EnvelopeGraph a new code path.
  const graphDecay = isAR ? 0 : envelope.decay;
  const graphSustain = isAR ? 1 : envelope.sustain;

  return (
    <div className="settings-section envelope-section">
      <label className="settings-label">{title}</label>
      <EnvelopeGraph
        attack={envelope.attack}
        decay={graphDecay}
        sustain={graphSustain}
        release={envelope.release}
      />

      <div className="tune-slider-row">
        <span className="tune-slider-label">Attack</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={msToT(attackMs)}
          onChange={(e) => envelope.setAttack(tToMs(parseFloat(e.target.value)) / 1000)}
          className="tune-slider"
        />
        <span className="tune-slider-value">{formatMs(attackMs)}</span>
      </div>

      {!isAR && (
        <div className="tune-slider-row">
          <span className="tune-slider-label">Decay</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.001"
            value={msToT(decayMs)}
            onChange={(e) => envelope.setDecay(tToMs(parseFloat(e.target.value)) / 1000)}
            className="tune-slider"
          />
          <span className="tune-slider-value">{formatMs(decayMs)}</span>
        </div>
      )}

      {!isAR && (
        <div className="tune-slider-row">
          <span className="tune-slider-label">Sustain</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={envelope.sustain}
            onChange={(e) => envelope.setSustain(parseFloat(e.target.value))}
            className="tune-slider"
          />
          <span className="tune-slider-value">{Math.round(envelope.sustain * 100)} %</span>
        </div>
      )}

      <div className="tune-slider-row">
        <span className="tune-slider-label">Release</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={msToT(releaseMs)}
          onChange={(e) => envelope.setRelease(tToMs(parseFloat(e.target.value)) / 1000)}
          className="tune-slider"
        />
        <span className="tune-slider-value">{formatMs(releaseMs)}</span>
      </div>
    </div>
  );
}
