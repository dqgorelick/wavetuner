import { useState, useEffect, useCallback } from 'react';
import audioEngine from '../audio/AudioEngine';
import RoutingPatchBay from './RoutingPatchBay';

/**
 * SettingsPanel - Expandable settings panel from bottom-right
 * Contains audio device selection, oscillator count controls, and routing patch bay
 */
export default function SettingsPanel({
  isOpen,
  onClose,
  oscillatorCount,
  onOscillatorCountChange,
  routingMap,
  onRoutingChange,
  onDeviceChange,
  staticMode,
  onStaticModeChange,
  tuneVarianceHz,
  onTuneVarianceChange,
  tuneGlideSec,
  onTuneGlideChange,
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

  const handleIncrement = () => {
    if (oscillatorCount < 10) {
      onOscillatorCountChange(oscillatorCount + 1);
    }
  };

  const handleDecrement = () => {
    if (oscillatorCount > 2) {
      onOscillatorCountChange(oscillatorCount - 1);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-panel">
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

      <div className="settings-section tune-section">
        <label className="settings-label">Tune</label>
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
        <label className="settings-label">Oscillators</label>
        <div className="oscillator-count-controls">
          <button
            className="count-button"
            onClick={handleDecrement}
            disabled={oscillatorCount <= 2}
          >
            −
          </button>
          <span className="count-display">{oscillatorCount}</span>
          <button
            className="count-button"
            onClick={handleIncrement}
            disabled={oscillatorCount >= 10}
          >
            +
          </button>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Static waveform</label>
        <select
          className="settings-select"
          value={staticMode}
          onChange={(e) => onStaticModeChange(e.target.value)}
        >
          <option value="beating">Beating (aggregate, ~15 periods)</option>
          <option value="wave">Wave (individuals + aggregate, 3 periods)</option>
          <option value="off">Off</option>
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
    </div>
  );
}
