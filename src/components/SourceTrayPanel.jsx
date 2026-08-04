import { memo, useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import { droneWave, keyboardWave } from '../audio/Wave';
import { droneFold, keyboardFold, FOLD_TYPES, FOLD_TYPE_IDS } from '../audio/Fold';
import { noise, NOISE_TYPES, NOISE_TYPE_IDS } from '../audio/Noise';
import { droneEnvelope, keyboardEnvelope, computerKbdEnvelope } from '../audio/Envelope';
import useBusGains, { BUS_MAX } from '../hooks/useBusGains';
import WaveControls from './WaveControls';
import EnvelopeControls from './EnvelopeControls';

// Source tray — the settings behind one knob of the SourceKnobBand
// (waves / shape / fold / noise / saturate). It used to float above the
// band as its own boxed panel; it now opens in the side-menu column to
// the right of the console, radio-style with mixer / tuning / perform
// and the frequency / ALL panels, so every menu in the app arrives from
// the same place. Markup follows the column's grammar: a .side-menu-head
// title bar (name + ✕) over a scrolling body.

const TRAY_TITLES = {
  waves: 'waves',
  shape: 'shape',
  fold: 'fold',
  noise: 'noise',
  saturate: 'saturate',
};

// Drive slider range from the Settings panel, shared with the band's
// saturate dial sweep (SourceKnobBand imports the pair).
export const DRIVE_MIN = 0.5;
export const DRIVE_MAX = 3;

// Tabs inside the waves tray — one bus level + envelope per source.
const SOURCE_TABS = [
  { id: 'drone', label: 'drone' },
  { id: 'kbd', label: 'kbd' },
  { id: 'midi', label: 'midi' },
];

function SourceTrayPanel({
  kind,
  onClose,
  saturationCurve,
  saturationDrive,
  onSaturationCurveChange,
  onSaturationDriveChange,
  scopeSaturation,
  onScopeSaturationChange,
}) {
  const [sourceTab, setSourceTab] = useState('drone');
  // Re-render tick for the singleton modules (wave / fold / noise).
  const [, setTick] = useState(0);
  useEffect(() => {
    const subs = [droneWave, keyboardWave, droneFold, keyboardFold, noise]
      .map((m) => m.onChange(() => setTick((n) => n + 1)));
    return () => subs.forEach((u) => u());
  }, []);
  const [bus, setBusGain] = useBusGains();
  // Switching trays swaps the body under a column that keeps its scroll
  // offset — start every tray at its title bar.
  const panelRef = useRef(null);
  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: 'start' });
  }, [kind]);

  const busSliderRow = (label, key, setter) => (
    <div className="tune-slider-row">
      <span className="tune-slider-label">{label}</span>
      <input
        type="range"
        min="0"
        max={BUS_MAX}
        step="0.01"
        value={bus[key]}
        onChange={(e) => setBusGain(key, setter)(parseFloat(e.target.value) / BUS_MAX)}
        className="tune-slider"
      />
      <span className="tune-slider-value">{Math.round(bus[key] * 100)}</span>
    </div>
  );

  // Waves tray = the wave-generator level plus a tabbed source strip:
  // drone / kbd / midi each own a bus level and an envelope, and only
  // the selected one is mounted so three ADSR panels never stack.
  const SOURCE_TAB_BODIES = {
    drone: (
      <>
        {busSliderRow('Level', 'drone', (g) => audioEngine.setDroneBusGain(g))}
        <EnvelopeControls title="Drone envelope" envelope={droneEnvelope} />
      </>
    ),
    kbd: (
      <>
        {busSliderRow('Level', 'kbd', (g) => audioEngine.setKbdBusGain(g))}
        <EnvelopeControls
          title="Computer keyboard envelope (AR)"
          envelope={computerKbdEnvelope}
          mode="ar"
        />
      </>
    ),
    midi: (
      <>
        {busSliderRow('Level', 'midi', (g) => audioEngine.setMidiBusGain(g))}
        <EnvelopeControls title="MIDI envelope" envelope={keyboardEnvelope} />
      </>
    ),
  };

  let body = null;
  if (kind === 'waves') {
    body = (
      <div className="settings-section">
        {busSliderRow('Waves', 'waves', (g) => audioEngine.setWaveBusGain(g))}
        <div className="source-tab-row" role="tablist" aria-label="Source">
          {SOURCE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={sourceTab === t.id}
              className={`source-tab${sourceTab === t.id ? ' active' : ''}`}
              onClick={() => setSourceTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="source-tab-body" role="tabpanel" aria-label={`${sourceTab} settings`}>
          {SOURCE_TAB_BODIES[sourceTab]}
        </div>
      </div>
    );
  } else if (kind === 'shape') {
    body = (
      <div className="source-tray-cols">
        <WaveControls title="Drone wave" wave={droneWave} fold={droneFold} />
        <WaveControls title="Keyboard wave" wave={keyboardWave} fold={keyboardFold} />
      </div>
    );
  } else if (kind === 'fold') {
    const foldSliderRow = (label, fold) => (
      <div className="tune-slider-row">
        <span className="tune-slider-label">{label}</span>
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
    );
    body = (
      <div className="settings-section">
        {foldSliderRow('Drone', droneFold)}
        {foldSliderRow('Keyboard', keyboardFold)}
        <div className="fold-type-row" role="radiogroup" aria-label="Fold algorithm">
          {FOLD_TYPE_IDS.map((id) => (
            <label key={id} className="fold-type-option">
              <input
                type="radio"
                name="band-fold-type"
                value={id}
                checked={droneFold.type === id}
                onChange={() => { droneFold.setType(id); keyboardFold.setType(id); }}
              />
              <span>{FOLD_TYPES[id].label}</span>
            </label>
          ))}
        </div>
        <p className="fold-type-blurb">{FOLD_TYPES[droneFold.type].blurb}</p>
      </div>
    );
  } else if (kind === 'noise') {
    body = (
      <div className="settings-section">
        <div className="tune-slider-row">
          <span className="tune-slider-label">Level</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={noise.level}
            onChange={(e) => noise.setLevel(parseFloat(e.target.value))}
            className="tune-slider"
          />
          <span className="tune-slider-value">
            {noise.level < 0.005 ? 'off' : `${Math.round(noise.level * 100)} %`}
          </span>
        </div>
        <div className="fold-type-row" role="radiogroup" aria-label="Noise color">
          {NOISE_TYPE_IDS.map((id) => (
            <label key={id} className="fold-type-option">
              <input
                type="radio"
                name="noise-color"
                value={id}
                checked={noise.type === id}
                onChange={() => noise.setType(id)}
              />
              <span>{NOISE_TYPES[id].label}</span>
            </label>
          ))}
        </div>
        <p className="fold-type-blurb">{NOISE_TYPES[noise.type].blurb}</p>
        <label className="fold-type-option" title="Sum the noise pre-master so it drives the master saturator (iOS parity); unchecked keeps it clean after the chain">
          <input
            type="checkbox"
            checked={!noise.postSaturation}
            onChange={(e) => noise.setPostSaturation(!e.target.checked)}
          />
          <span>saturate noise</span>
        </label>
        <label className="fold-type-option" title="Feed the noise into the oscilloscope/spectrum tap — off keeps the trace clean">
          <input
            type="checkbox"
            checked={!!noise.showInViz}
            onChange={(e) => noise.setShowInViz(e.target.checked)}
          />
          <span>show in oscilloscope</span>
        </label>
      </div>
    );
  } else if (kind === 'saturate') {
    body = (
      <div className="settings-section">
        <select
          className="settings-select"
          value={saturationCurve}
          onChange={(e) => onSaturationCurveChange(e.target.value)}
        >
          <option value="off">Off (bypass)</option>
          <option value="tanh">Soft (tanh)</option>
          <option value="cubic">Cubic</option>
          <option value="sine">Sine</option>
          <option value="hard">Hard clip</option>
        </select>
        <div className="tune-slider-row">
          <span className="tune-slider-label">Drive</span>
          <input
            type="range"
            min={DRIVE_MIN}
            max={DRIVE_MAX}
            step="0.05"
            value={saturationDrive}
            onChange={(e) => onSaturationDriveChange(parseFloat(e.target.value))}
            className="tune-slider"
            disabled={saturationCurve === 'off'}
          />
          <span className="tune-slider-value">{saturationDrive.toFixed(2)}×</span>
        </div>
        <label className="fold-type-option" title="Run the oscilloscope's signal through the saturation curve so the squash is visible">
          <input
            type="checkbox"
            checked={!!scopeSaturation}
            onChange={(e) => onScopeSaturationChange?.(e.target.checked)}
          />
          <span>show in oscilloscope</span>
        </label>
      </div>
    );
  }

  const title = TRAY_TITLES[kind] ?? kind;
  return (
    <div className="source-tray-panel" ref={panelRef} role="group" aria-label={`${title} settings`}>
      <div className="side-menu-head">
        <span className="side-menu-title">{title}</span>
        <button
          type="button"
          className="side-menu-close"
          onClick={onClose}
          aria-label={`Close ${title} settings`}
        >
          ✕
        </button>
      </div>
      <div className="source-tray-body">{body}</div>
    </div>
  );
}

export default memo(SourceTrayPanel);
