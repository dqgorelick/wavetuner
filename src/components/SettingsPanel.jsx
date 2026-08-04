import { useState, useEffect, useCallback } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import RoutingPatchBay from './RoutingPatchBay';
import DissonanceMeter from './DissonanceMeter';
import {
  getMovingImpact,
  setMovingImpact,
  MOVING_IMPACT_MIN,
  MOVING_IMPACT_MAX,
} from '../audio/dissonanceSettings';
import {
  getScrubSettings,
  setScrubSetting,
  SCALE_AMOUNT_MIN,
  SCALE_AMOUNT_MAX,
  FINE_LIMIT_MIN,
  FINE_LIMIT_MAX,
} from '../audio/scrubSettings';

/**
 * SettingsPanel - Expandable settings panel from bottom-right.
 *
 * Section order (top → bottom):
 *   audio output → saturation → keyboard (re-press / labels)
 *   → tune button behavior → recall curve → channel routing
 *   → orb row → pan dots → orb drag → color theme → dissonance HUD
 *
 * Deliberately NOT here — these live closer to where they're played:
 *   envelopes + wave/fold      → source knob band trays
 *   stereo mode (LR / stereo)  → mixer bus rows
 *   velocity curve             → MIDI menu
 *   keyboard keys (all/white)  → keyboard tray ("notes" toggle)
 *   octave fill mode           → pinned to "fill" (Tuning's default)
 */
export default function SettingsPanel({
  isOpen,
  onClose,
  oscillatorCount,
  routingMap,
  onRoutingChange,
  onDeviceChange,
  tuneVarianceHz,
  onTuneVarianceChange,
  tuneGlideSec,
  onTuneGlideChange,
  theme,
  onThemeChange,
  saturationCurve,
  onSaturationCurveChange,
  saturationDrive,
  onSaturationDriveChange,
  kbdRepressMode,
  onKbdRepressModeChange,
  showKbdLabels,
  onShowKbdLabelsChange,
  orbsBelow,
  onOrbsBelowChange,
  panDots,
  onPanDotsChange,
  orbDragMode,
  onOrbDragModeChange,
}) {
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [maxChannels, setMaxChannels] = useState(2);
  const [needsPermission, setNeedsPermission] = useState(false);
  // Dissonance HUD — moving-voice impact (0..1), persisted in dissonanceSettings.
  const [movingImpact, setMovingImpactState] = useState(() => getMovingImpact());
  // iOS-ramp feel knobs — scrubSettings owns/persists them; this is a display
  // copy so the sliders re-render (the module hands back one live object).
  const [scrub, setScrub] = useState(() => ({ ...getScrubSettings() }));
  const updateScrub = (key, value) => {
    setScrubSetting(key, value);
    setScrub({ ...getScrubSettings() });
  };
  // Recall easing curve — mirrors frequencyManager (which owns/persists it).
  const [recallCurve, setRecallCurve] = useState(() => frequencyManager.recallCurve);

  // Enumerate audio output devices
  const enumerateDevices = useCallback(async (requestPermission = false) => {
    try {
      // If requesting permission, do it first
      if (requestPermission) {
        try {
          console.log('Requesting audio permission...');
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
          console.log('Permission granted, re-enumerating devices...');
        } catch (permErr) {
          console.warn('Permission denied:', permErr);
          alert('Permission denied. Please allow microphone access to see device names.');
          return;
        }
      }

      // Enumerate devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

      console.log('Audio outputs:', audioOutputs);

      // Check if we have meaningful labels (not just empty strings or generic names)
      const hasLabels = audioOutputs.some(d => d.label && d.label.length > 0 && !d.label.startsWith('Output'));
      setNeedsPermission(!hasLabels && audioOutputs.length > 0);

      setAudioDevices(audioOutputs);

      // Set default device if not already set
      if (!selectedDevice && audioOutputs.length > 0) {
        setSelectedDevice(audioOutputs[0].deviceId);
      }
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err);
      setAudioDevices([{ deviceId: 'default', label: 'Default Output', kind: 'audiooutput' }]);
    }
  }, [selectedDevice]);

  // Enumerate on open
  useEffect(() => {
    if (isOpen) {
      enumerateDevices(false);
    }
  }, [isOpen, enumerateDevices]);

  const handleRequestPermission = async () => {
    await enumerateDevices(true);
  };

  // Get max channels when device changes
  useEffect(() => {
    const updateMaxChannels = async () => {
      if (audioEngine.initialized) {
        const channels = audioEngine.getMaxOutputChannels();
        setMaxChannels(channels);
      }
    };
    updateMaxChannels();
  }, [selectedDevice]);

  const handleDeviceSelect = async (e) => {
    const deviceId = e.target.value;
    setSelectedDevice(deviceId);
    await onDeviceChange(deviceId);

    // Update max channels after device change (with small delay for setSinkId to complete)
    setTimeout(() => {
      const channels = audioEngine.getMaxOutputChannels();
      console.log('Updated max channels:', channels);
      setMaxChannels(channels);
    }, 100);
  };

  return (
    <div
      className={`settings-panel${isOpen ? ' open' : ''}`}
      aria-hidden={!isOpen}
    >
      <div className="settings-header">
        <h3>Settings</h3>
        <button className="settings-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <div className="settings-section">
        <label className="settings-label">Audio Output</label>
        <select
          className="settings-select"
          value={selectedDevice}
          onChange={handleDeviceSelect}
        >
          {audioDevices.length === 0 ? (
            <option value="">Loading devices...</option>
          ) : (
            audioDevices.map(device => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Output ${device.deviceId.slice(0, 8)}`}
              </option>
            ))
          )}
        </select>
        {needsPermission && (
          <button
            type="button"
            className="permission-button"
            onClick={handleRequestPermission}
          >
            Grant permission for device names
          </button>
        )}
        <span className="settings-info">{maxChannels} channels available</span>
      </div>

      <div className="settings-section">
        <label className="settings-label">Saturation</label>
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
            min="0.5"
            max="3"
            step="0.05"
            value={saturationDrive}
            onChange={(e) => onSaturationDriveChange(parseFloat(e.target.value))}
            className="tune-slider"
            disabled={saturationCurve === 'off'}
          />
          <span className="tune-slider-value">{saturationDrive.toFixed(2)}×</span>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Keyboard</label>
        <label className="settings-sublabel">Re-press behavior (hold on)</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${kbdRepressMode === 'toggle' ? 'on' : 'off'}`}
            onClick={() => onKbdRepressModeChange?.('toggle')}
            aria-pressed={kbdRepressMode === 'toggle'}
            title="Re-pressing a held note releases it"
          >
            toggle
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${kbdRepressMode === 'restart' ? 'on' : 'off'}`}
            onClick={() => onKbdRepressModeChange?.('restart')}
            aria-pressed={kbdRepressMode === 'restart'}
            title="Re-pressing releases the held note AND starts a fresh ramp"
          >
            restart
          </button>
        </div>
        <label className="settings-sublabel">Key labels</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${showKbdLabels ? 'on' : 'off'}`}
            onClick={() => onShowKbdLabelsChange?.(true)}
            aria-pressed={!!showKbdLabels}
            title="Show the QWERTY letter that triggers each key"
          >
            show
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${!showKbdLabels ? 'on' : 'off'}`}
            onClick={() => onShowKbdLabelsChange?.(false)}
            aria-pressed={!showKbdLabels}
            title="Hide the QWERTY letter overlay"
          >
            hide
          </button>
        </div>
      </div>

      <div className="settings-section tune-section">
        <label className="settings-label">Tune button behavior</label>
        <div className="tune-slider-row">
          <span className="tune-slider-label">Detune</span>
          <input
            type="range"
            min="0"
            max="5"
            step="0.1"
            value={tuneVarianceHz}
            onChange={(e) => onTuneVarianceChange(parseFloat(e.target.value))}
            className="tune-slider"
          />
          <span className="tune-slider-value">±{tuneVarianceHz.toFixed(1)} Hz</span>
        </div>

        <div className="tune-slider-row">
          <span className="tune-slider-label">Glide</span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={tuneGlideSec}
            onChange={(e) => onTuneGlideChange(parseFloat(e.target.value))}
            className="tune-slider"
          />
          <span className="tune-slider-value">{tuneGlideSec.toFixed(2)} s</span>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Recall curve</label>
        <select
          className="settings-select"
          value={recallCurve}
          onChange={(e) => {
            const id = e.target.value;
            frequencyManager.setRecallCurve(id);
            setRecallCurve(id);
          }}
          title="Easing curve applied when a saved snapshot is recalled."
        >
          {frequencyManager.recallCurveOptions.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>

      <div className="settings-section routing-section">
        <label className="settings-label">Channel Routing</label>
        <RoutingPatchBay
          oscillatorCount={oscillatorCount}
          outputChannels={maxChannels}
          routingMap={routingMap}
          onRoutingChange={onRoutingChange}
        />
      </div>

      {/* Tuning-system picker lives in the TuningPanel header. */}

      <div className="settings-section">
        <label className="settings-label">Orb row</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${!orbsBelow ? 'on' : 'off'}`}
            onClick={() => onOrbsBelowChange?.(false)}
            aria-pressed={!orbsBelow}
            title="Orbs float above the spectrum line (classic web layout)"
          >
            above spectrum
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${orbsBelow ? 'on' : 'off'}`}
            onClick={() => onOrbsBelowChange?.(true)}
            aria-pressed={orbsBelow}
            title="Orbs hang below the spectrum line on short arms, numbers beneath, Hz readout on top (matches iOS)"
          >
            below spectrum
          </button>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Pan dots</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${panDots ? 'on' : 'off'}`}
            onClick={() => onPanDotsChange?.(true)}
            aria-pressed={!!panDots}
            title="Each orb wears a small indicator on its rim showing where the voice sits in the stereo field (left horizon → top → right horizon)"
          >
            always
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${!panDots ? 'on' : 'off'}`}
            onClick={() => onPanDotsChange?.(false)}
            aria-pressed={!panDots}
            title="Show the rim indicator only while a pan is being changed, then fade it out"
          >
            on change
          </button>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Orb drag</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${orbDragMode === 'linear' ? 'on' : 'off'}`}
            onClick={() => onOrbDragModeChange?.('linear')}
            aria-pressed={orbDragMode === 'linear'}
            title="Linear: a pixel of horizontal drag is worth the same pitch anywhere. Vertical does nothing."
          >
            linear
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${orbDragMode === 'precision' ? 'on' : 'off'}`}
            onClick={() => onOrbDragModeChange?.('precision')}
            aria-pressed={orbDragMode === 'precision'}
            title="Scrub: pull the pointer away from the bar to slow the drag down (½ → 1/5 → 1/20), like scrubbing a video."
          >
            pull for precision
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${orbDragMode === 'ios' ? 'on' : 'off'}`}
            onClick={() => onOrbDragModeChange?.('ios')}
            aria-pressed={orbDragMode === 'ios'}
            title="iOS scaling: vertical position is the speed dial — 1× at the grab, faster as you raise the orb above it (up to 4×), finer as you pull below (down to the fine limit)."
          >
            ios scaling
          </button>
        </div>
        {/* Grab mode (click an orb so it follows the cursor) sits out of all
            three — its vertical axis still rides the voice's level. */}
        {orbDragMode === 'ios' && (
          <>
            <div
              className="tune-slider-row"
              title="Strength of the ramp: 0× is flat (no scaling at all), 1× is the tuned curve, 2× exaggerates both ends."
            >
              <span className="tune-slider-label">Scale amount</span>
              <input
                type="range"
                min={SCALE_AMOUNT_MIN}
                max={SCALE_AMOUNT_MAX}
                step="0.05"
                value={scrub.scaleAmount}
                onChange={(e) => updateScrub('scaleAmount', parseFloat(e.target.value))}
                className="tune-slider"
              />
              <span className="tune-slider-value">{scrub.scaleAmount.toFixed(2)}×</span>
            </div>
            <div
              className="tune-slider-row"
              title="Slowest drag speed at a full pull DOWN, as a fraction of full speed — the speed at the grab stays 1×. 1× means no fine zone at all."
            >
              <span className="tune-slider-label">Fine limit</span>
              <input
                type="range"
                min={FINE_LIMIT_MIN}
                max={FINE_LIMIT_MAX}
                step="0.01"
                value={scrub.fineLimit}
                onChange={(e) => updateScrub('fineLimit', parseFloat(e.target.value))}
                className="tune-slider"
              />
              <span className="tune-slider-value">{scrub.fineLimit.toFixed(2)}×</span>
            </div>
          </>
        )}
      </div>

      <div className="settings-section">
        <label className="settings-label">Color theme</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${theme === 'duo' ? 'on' : 'off'}`}
            onClick={() => onThemeChange?.('duo')}
            aria-pressed={theme === 'duo'}
            title="Sparse two-accent palette (blue + orange + white)"
          >
            duo
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${theme === 'classic' ? 'on' : 'off'}`}
            onClick={() => onThemeChange?.('classic')}
            aria-pressed={theme === 'classic'}
            title="Original 12-color rainbow palette"
          >
            classic
          </button>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Dissonance HUD</label>
        <div
          className="tune-slider-row"
          title="How much the voice you're dragging counts toward the consonance curve. 0% = ignored (shows where it can land against the others); 100% = counts like any other voice."
        >
          <span className="tune-slider-label">Moving voice impact</span>
          <input
            type="range"
            min={MOVING_IMPACT_MIN}
            max={MOVING_IMPACT_MAX}
            step="0.01"
            value={movingImpact}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setMovingImpactState(v);
              setMovingImpact(v);
            }}
            className="tune-slider"
          />
          <span className="tune-slider-value">{Math.round(movingImpact * 100)}%</span>
        </div>
      </div>

      <div className="settings-section settings-section-analyzer">
        <DissonanceMeter />
      </div>
    </div>
  );
}
