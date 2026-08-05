import { memo, useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import { droneWave, keyboardWave } from '../audio/Wave';
import { droneFold, keyboardFold, FOLD_TYPES } from '../audio/Fold';
import { noise, NOISE_TYPES, NOISE_TYPE_IDS } from '../audio/Noise';
import { droneEnvelope, keyboardEnvelope, computerKbdEnvelope } from '../audio/Envelope';
import useBusGains, { BUS_MAX } from '../hooks/useBusGains';
import WaveShapePreview from './WaveShapePreview';
import EnvelopeControls from './EnvelopeControls';
import CompactSlider from './CompactSlider';

// Source tray — the settings behind one knob of the SourceKnobBand
// (waves / shape / fold / noise / saturate). It used to float above the
// band as its own boxed panel; it now opens in the side-menu column to
// the right of the console, radio-style with mixer / tuning / perform
// and the frequency / ALL panels, so every menu in the app arrives from
// the same place. Markup follows the column's grammar: a .side-menu-head
// title bar (name + ✕) over a scrolling body.
//
// Reorganized 2026-08-04 to the iOS SourceTray shape (Dan): every menu
// leads with its dial's own parameter, a target selector picks WHICH
// pool the rest of the menu edits (underlined words, radio behavior),
// and the two-up sections put the picture on the left with its levers
// stacked beside it instead of a stack of full-width rows.
//
//   waves     level · envelope (drone | midi | kbd) with the ADSR graph
//             beside its levers
//   shape /   ONE merged "shape and fold" menu — both dials open it —
//   fold      with a drone | midi/kbd pool selector over the wave
//             preview + shape/fold levers, and the fold-character
//             radio spanning underneath
//   noise     level (unlabeled) · color: <character> · route + viz
//   saturate  level 0–100 · style: <character> · viz

const TRAY_TITLES = {
  waves: 'waves',
  shape: 'shape and fold',
  fold: 'shape and fold',
  noise: 'noise',
  saturate: 'saturate',
};

// Drive slider range from the Settings panel, shared with the band's
// saturate dial sweep (SourceKnobBand imports the pair). The menu now
// shows the position on this sweep as a plain 0–100 amount rather than
// the raw multiplier — the dial reads the same number.
export const DRIVE_MIN = 0.5;
export const DRIVE_MAX = 3;

// Saturation styles = the web curve set. Each gets the same one-line
// character fragment the noise colors carry, shown inline after the
// "style" label instead of as a paragraph underneath.
//
// TODO(unify): iOS ships a different vocabulary here — four named
// styles (tape / smooth / crunch / fuzz, each with its own ADAA1 curve)
// plus a separate `punish` macro that pushes extra level-compensated
// drive on top, and its own enabled flag rather than an "off" style.
// Web has five raw curves, no punish. Pick one model and port it both
// ways: the style names + blurbs (SaturationStyle.swift), the punish
// slider (SourceTray.saturateSections), and the amount/enabled split.
const SAT_STYLES = [
  { id: 'off', label: 'off', short: 'bypassed — the chain is out of the way' },
  { id: 'tanh', label: 'soft', short: 'smooth symmetric squash' },
  { id: 'cubic', label: 'cubic', short: 'gentle knee, warm odd harmonics' },
  { id: 'sine', label: 'sine', short: 'sine transfer — folds over at the top' },
  { id: 'hard', label: 'hard', short: 'brick-wall clip, buzzy edges' },
];

// Fold algorithms, in the menu's order with short names (the full
// labels — "Buchla 259" — don't fit a three-up radio row at 310px).
const FOLD_CHOICES = [
  { id: 'triangle', label: 'tri' },
  { id: 'sine', label: 'sine' },
  { id: 'buchla', label: '259' },
];

// Which wave/fold pool the shape-and-fold menu edits. MIDI notes and
// the computer keyboard share one pool on web, so they share one word.
const WAVE_POOLS = [
  { id: 'drone', label: 'drone', wave: droneWave, fold: droneFold },
  { id: 'kbd', label: 'midi/kbd', wave: keyboardWave, fold: keyboardFold },
];

// Which envelope the waves menu edits. Three here, not two: the
// computer keyboard runs its own AR envelope separate from MIDI.
const ENV_POOLS = [
  { id: 'drone', label: 'drone', envelope: droneEnvelope, mode: 'adsr' },
  { id: 'midi', label: 'midi', envelope: keyboardEnvelope, mode: 'adsr' },
  { id: 'kbd', label: 'kbd', envelope: computerKbdEnvelope, mode: 'ar' },
];

/** Underlined-word radio row — the knob labels' grammar as a selector. */
function WordRadio({ options, value, onChange, label }) {
  return (
    <div className="source-tab-row" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`source-tab${value === o.id ? ' active' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Web `shapeLabel` parity with iOS: closest anchor, or the drift between two. */
const SHAPE_NAMES = ['sine', 'tri', 'sq', 'saw'];
function shapeLabel(p) {
  const seg = Math.min(2, Math.floor(p));
  const t = p - seg;
  if (t < 0.05) return SHAPE_NAMES[seg];
  if (t > 0.95) return SHAPE_NAMES[seg + 1];
  return `${SHAPE_NAMES[seg]}→${SHAPE_NAMES[seg + 1]} ${Math.round(t * 100)}%`;
}

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
  const [envPool, setEnvPool] = useState('drone');
  const [wavePool, setWavePool] = useState('drone');
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

  let body = null;
  if (kind === 'waves') {
    // One level row, not two: the drone / kbd / midi bus sliders that
    // used to sit behind these same words read as a duplicate of the
    // waves level right above them (Dan, 2026-08-04), so the words now
    // pick an ENVELOPE only. The per-bus gains keep their engine
    // setters (setDroneBusGain / setKbdBusGain / setMidiBusGain, still
    // polled by useBusGains) but have no UI here for the moment.
    const env = ENV_POOLS.find((p) => p.id === envPool) ?? ENV_POOLS[0];
    body = (
      <div className="settings-section">
        <div className="tune-slider-row">
          <span className="tune-slider-label">Level</span>
          <input
            type="range"
            min="0"
            max={BUS_MAX}
            step="0.01"
            value={bus.waves}
            onChange={(e) => setBusGain('waves', (g) => audioEngine.setWaveBusGain(g))(
              parseFloat(e.target.value) / BUS_MAX,
            )}
            className="tune-slider"
          />
          <span className="tune-slider-value">{Math.round(bus.waves * 100)}</span>
        </div>

        <span className="settings-label tray-section-label">Envelope</span>
        {/* The target radio rides UNDER the curve in the left column,
            not above the whole split — the levers on the right start at
            the section's top that way, and the four of them fit the
            column without it scrolling (Dan, 2026-08-04). */}
        <EnvelopeControls
          envelope={env.envelope}
          mode={env.mode}
          split
          belowGraph={(
            <WordRadio
              options={ENV_POOLS}
              value={envPool}
              onChange={setEnvPool}
              label="Envelope target"
            />
          )}
        />
      </div>
    );
  } else if (kind === 'shape' || kind === 'fold') {
    const pool = WAVE_POOLS.find((p) => p.id === wavePool) ?? WAVE_POOLS[0];
    const { wave, fold } = pool;
    body = (
      <div className="settings-section">
        <span className="settings-label tray-section-label">Wave shape</span>
        <WordRadio
          options={WAVE_POOLS}
          value={wavePool}
          onChange={setWavePool}
          label="Wave pool"
        />

        <div className="tray-split">
          <div className="tray-split-col">
            <WaveShapePreview wave={wave} fold={fold} />
          </div>
          <div className="tray-split-col">
            <CompactSlider
              label="shape"
              value={wave.position}
              max={3}
              readout={shapeLabel(wave.position)}
              onChange={(v) => wave.setPosition(v)}
            />
            <CompactSlider
              label="fold"
              value={fold.amount}
              readout={fold.amount === 0 ? 'off' : `${Math.round(fold.amount * 100)} %`}
              onChange={(v) => fold.setAmount(v)}
            />
          </div>
        </div>

        <span className="settings-label tray-section-label">Fold character</span>
        <div className="fold-type-row" role="radiogroup" aria-label="Fold algorithm">
          {FOLD_CHOICES.map((c) => (
            <label key={c.id} className="fold-type-option">
              <input
                type="radio"
                name="tray-fold-type"
                value={c.id}
                checked={fold.type === c.id}
                onChange={() => fold.setType(c.id)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
        <p className="fold-type-blurb">{FOLD_TYPES[fold.type].blurb}</p>
      </div>
    );
  } else if (kind === 'noise') {
    body = (
      <div className="settings-section">
        {/* No "level" label — the slider IS the level, and the menu is
            already named for the dial it belongs to (iOS parity). */}
        <div className="tune-slider-row no-label">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={noise.level}
            onChange={(e) => noise.setLevel(parseFloat(e.target.value))}
            className="tune-slider"
            aria-label="Noise level"
          />
          <span className="tune-slider-value">
            {noise.level < 0.005 ? 'off' : `${Math.round(noise.level * 100)} %`}
          </span>
        </div>

        {/* The color's character rides in the section label instead of a
            paragraph underneath the radios (Dan, 2026-08-04). */}
        <span className="settings-label tray-section-label">
          color: <em>{NOISE_TYPES[noise.type].short}</em>
        </span>
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

        <label className="fold-type-option tray-check" title="Sum the noise pre-master so it drives the master saturator (iOS parity); unchecked keeps it clean after the chain">
          <input
            type="checkbox"
            checked={!noise.postSaturation}
            onChange={(e) => noise.setPostSaturation(!e.target.checked)}
          />
          <span>saturate noise</span>
        </label>
        <label className="fold-type-option tray-check" title="Feed the noise into the oscilloscope/spectrum tap — off keeps the trace clean">
          <input
            type="checkbox"
            checked={!!noise.showInViz}
            onChange={(e) => noise.setShowInViz(e.target.checked)}
          />
          <span>visualize noise</span>
        </label>
      </div>
    );
  } else if (kind === 'saturate') {
    // The dial's sweep as a plain 0–100 amount. Raising it off zero
    // while the chain is bypassed wakes it (curve off → soft), the same
    // wake-on-raise the dial and the iOS tray use.
    const amount = Math.round(
      Math.max(0, Math.min(1, (saturationDrive - DRIVE_MIN) / (DRIVE_MAX - DRIVE_MIN))) * 100,
    );
    const style = SAT_STYLES.find((s) => s.id === saturationCurve) ?? SAT_STYLES[0];
    body = (
      <div className="settings-section">
        <div className="tune-slider-row no-label">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={amount}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (saturationCurve === 'off' && v > 1) onSaturationCurveChange('tanh');
              onSaturationDriveChange(DRIVE_MIN + (v / 100) * (DRIVE_MAX - DRIVE_MIN));
            }}
            className="tune-slider"
            aria-label="Saturation level"
          />
          <span className="tune-slider-value">
            {saturationCurve === 'off' ? 'off' : amount}
          </span>
        </div>

        <span className="settings-label tray-section-label">
          style: <em>{style.short}</em>
        </span>
        <div className="fold-type-row" role="radiogroup" aria-label="Saturation style">
          {SAT_STYLES.map((s) => (
            <label key={s.id} className="fold-type-option">
              <input
                type="radio"
                name="saturation-style"
                value={s.id}
                checked={saturationCurve === s.id}
                onChange={() => onSaturationCurveChange(s.id)}
              />
              <span>{s.label}</span>
            </label>
          ))}
        </div>

        {/* TODO(unify): iOS's "punish" macro (extra level-compensated
            drive) has no web equivalent yet — it belongs right here,
            under the style row. See the SAT_STYLES note above. */}

        <label className="fold-type-option tray-check" title="Run the oscilloscope's signal through the saturation curve so the squash is visible">
          <input
            type="checkbox"
            checked={!!scopeSaturation}
            onChange={(e) => onScopeSaturationChange?.(e.target.checked)}
          />
          <span>visualize saturation</span>
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
