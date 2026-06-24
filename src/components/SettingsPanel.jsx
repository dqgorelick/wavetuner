import { useState, useEffect, useCallback } from 'react';
import audioEngine from '../audio/AudioEngine';
import { droneEnvelope, keyboardEnvelope, computerKbdEnvelope } from '../audio/Envelope';
import { droneWave, keyboardWave } from '../audio/Wave';
import { droneFold, keyboardFold } from '../audio/Fold';
import { droneStereo, keyboardStereo } from '../audio/StereoMode';
import EnvelopeControls from './EnvelopeControls';
import WaveControls from './WaveControls';
import StereoModeControls from './StereoModeControls';
import RoutingPatchBay from './RoutingPatchBay';
import SpectrumAnalyzer from './SpectrumAnalyzer';
import DissonanceMeter from './DissonanceMeter';

/**
 * SettingsPanel - Expandable settings panel from bottom-right.
 *
 * Section order (top → bottom):
 *   audio output → midi input
 *   → drone stereo → keyboard stereo → drone env → keyboard env
 *   → drone wave (with shape preview) → keyboard wave (with preview)
 *   → keyboard (keys/octaves/velocity) → tune button behavior
 *   → channel routing → color theme
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
  velocityCurve,
  onVelocityCurveChange,
  theme,
  onThemeChange,
  kbdKeyMode,
  onKbdKeyModeChange,
  kbdFillMode,
  onKbdFillModeChange,
  saturationCurve,
  onSaturationCurveChange,
  saturationDrive,
  onSaturationDriveChange,
  kbdRepressMode,
  onKbdRepressModeChange,
  showKbdLabels,
  onShowKbdLabelsChange,
}) {
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [maxChannels, setMaxChannels] = useState(2);
  const [needsPermission, setNeedsPermission] = useState(false);

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

      <StereoModeControls title="Drone stereo" stereoMode={droneStereo} slotCount={oscillatorCount} />
      <StereoModeControls title="Keyboard stereo" stereoMode={keyboardStereo} slotCount={oscillatorCount} />

      <EnvelopeControls title="Drone envelope" envelope={droneEnvelope} />
      <EnvelopeControls title="MIDI envelope" envelope={keyboardEnvelope} />
      <EnvelopeControls
        title="Computer keyboard envelope (AR)"
        envelope={computerKbdEnvelope}
        mode="ar"
      />

      <WaveControls title="Drone wave" wave={droneWave} fold={droneFold} />
      <WaveControls title="Keyboard wave" wave={keyboardWave} fold={keyboardFold} />

      <div className="settings-section">
        <label className="settings-label">Keyboard</label>
        <label className="settings-sublabel">Octaves</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${kbdFillMode === 'jump' ? 'on' : 'off'}`}
            onClick={() => onKbdFillModeChange?.('jump')}
            aria-pressed={kbdFillMode === 'jump'}
            title="Octaves jump cleanly between drone notes"
          >
            jump
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${kbdFillMode === 'fill' ? 'on' : 'off'}`}
            onClick={() => onKbdFillModeChange?.('fill')}
            aria-pressed={kbdFillMode === 'fill'}
            title="Every key has a drone — fill octaves"
          >
            fill
          </button>
        </div>
        {/* TODO: revisit keyboard ordering. Today, white-only mode shifts
            the drone→key mapping so consecutive white keys play consecutive
            scale degrees (ascending). This matches the playing-style
            intent for diatonic systems, but loses the property that a
            given QWERTY key always plays the same drone slot. An
            alternative mode — "fixed semitone mapping" where blacks just
            go silent without re-indexing whites — could live here as a
            third option. For now we ship the ascending behavior; if
            users miss the semitone-fixed mode, surface it as a setting. */}
        <label className="settings-sublabel">Keys</label>
        <div className="settings-toggle-row">
          <button
            type="button"
            className={`settings-toggle-btn ${kbdKeyMode === 'chromatic' ? 'on' : 'off'}`}
            onClick={() => onKbdKeyModeChange?.('chromatic')}
            aria-pressed={kbdKeyMode === 'chromatic'}
            title="Every key plays — black + white"
          >
            all
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${kbdKeyMode === 'white-only' ? 'on' : 'off'}`}
            onClick={() => onKbdKeyModeChange?.('white-only')}
            aria-pressed={kbdKeyMode === 'white-only'}
            title="Only white keys play"
          >
            white
          </button>
        </div>
        <label className="settings-sublabel">Velocity curve</label>
        <select
          className="settings-select"
          value={velocityCurve || 'linear'}
          onChange={(e) => onVelocityCurveChange?.(e.target.value)}
        >
          <option value="linear">Linear (default)</option>
          <option value="soft">Soft — quieter touches feel quieter</option>
          <option value="hard">Hard — flatten dynamics</option>
          <option value="fixed">Fixed — ignore velocity</option>
        </select>
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

      <div className="settings-section settings-section-analyzer">
        <SpectrumAnalyzer />
      </div>

      <div className="settings-section settings-section-analyzer">
        <DissonanceMeter />
      </div>
    </div>
  );
}
