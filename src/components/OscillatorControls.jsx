import { useEffect, useState, useMemo } from 'react';
import audioEngine from '../audio/AudioEngine';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const OSCILLATOR_COLORS = [
  '#ff4136',
  '#2ecc40',
  '#0074d9',
  '#ffdc00',
  '#bb8fce',
  '#85c1e9',
  '#82e0aa',
  '#f8b500',
  '#e74c3c',
  '#1abc9c',
];

function freqToNote(freq) {
  if (freq <= 0) return { note: '--', octave: 0, cents: 0 };
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midiNote = Math.round(69 + semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - (midiNote - 69)) * 100);
  const noteIndex = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;
  return { note: NOTE_NAMES[noteIndex], octave, cents };
}

function getOscillatorLabel(index, routingMap = {}, outputChannels = 2) {
  const num = index + 1;
  const outputs = routingMap[index] ?? [index % 2];
  const outputList = Array.isArray(outputs) ? outputs : [outputs];
  if (outputChannels <= 2 && outputList.length === 1) {
    const channelLabel = outputList[0] === 0 ? 'L' : 'R';
    return `${num}→${channelLabel}`;
  }
  return `${num}`;
}

function VolumeGauge({ volume, color, isMuted }) {
  const bars = 5;
  const filledBars = isMuted ? 0 : Math.ceil((volume / 100) * bars);
  return (
    <div className={`volume-gauge ${isMuted ? 'muted' : ''}`}>
      {Array.from({ length: bars }, (_, i) => {
        const barIndex = bars - 1 - i;
        const isFilled = barIndex < filledBars;
        return (
          <div
            key={i}
            className={`gauge-bar ${isFilled ? 'filled' : ''}`}
            style={{
              backgroundColor: isFilled ? color : 'transparent',
              borderColor: color,
            }}
          />
        );
      })}
    </div>
  );
}

function OscillatorRow({ index, label, color, isMuted, onMuteToggle, freq, volume }) {
  const noteInfo = freqToNote(freq);
  const centsStr = noteInfo.cents >= 0 ? `+${noteInfo.cents}` : `${noteInfo.cents}`;

  return (
    <div
      className={`osc-row ${isMuted ? 'muted' : ''}`}
      style={{ '--row-color': color }}
    >
      <div
        className={`osc-mute-indicator ${!isMuted ? 'unmuted' : ''}`}
        style={{ '--dot-color': color }}
        title={isMuted ? 'Click to unmute' : 'Click to mute'}
        onClick={() => onMuteToggle(index)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onMuteToggle(index)}
      >
        {label}
      </div>

      <VolumeGauge volume={volume} color={color} isMuted={isMuted} />

      <div className="freq-readout">
        <span className="freq-hz">{freq.toFixed(1)}Hz</span>
        <span className="freq-note" style={{ color }}>{noteInfo.note}{noteInfo.octave}</span>
        <span className="freq-cents">{centsStr}¢</span>
      </div>
    </div>
  );
}

export default function OscillatorControls({
  oscillatorCount = 2,
  routingMap = {},
  onShare,
  onSettingsToggle,
  isSettingsOpen,
  onShowHelp,
  fineTuneEnabled = false,
  onFineTuneToggle,
}) {
  const outputChannels = audioEngine.outputChannelCount || 2;
  const createInitialArray = (defaultValue, length) => Array(length).fill(defaultValue);

  const [mutedOscillators, setMutedOscillators] = useState(() => createInitialArray(false, oscillatorCount));
  const [frequencies, setFrequencies] = useState(() => createInitialArray(60, oscillatorCount));
  const [volumes, setVolumes] = useState(() => createInitialArray(50, oscillatorCount));
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    setMutedOscillators((prev) => {
      const arr = [...prev];
      while (arr.length < oscillatorCount) arr.push(false);
      return arr.slice(0, oscillatorCount);
    });
    setFrequencies((prev) => {
      const arr = [...prev];
      while (arr.length < oscillatorCount) arr.push(60);
      return arr.slice(0, oscillatorCount);
    });
    setVolumes((prev) => {
      const arr = [...prev];
      while (arr.length < oscillatorCount) arr.push(50);
      return arr.slice(0, oscillatorCount);
    });
  }, [oscillatorCount]);

  const oscillators = useMemo(() => {
    return Array.from({ length: oscillatorCount }, (_, i) => ({
      index: i,
      label: getOscillatorLabel(i, routingMap, outputChannels),
      color: OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length],
    }));
  }, [oscillatorCount, routingMap, outputChannels]);

  useEffect(() => {
    let animationId;
    const sync = () => {
      if (audioEngine.initialized) {
        try {
          const freqs = audioEngine.getAllFrequencies();
          const vols = audioEngine.getAllVolumes();
          const muted = audioEngine.getAllMutedStates();
          if (freqs.length >= oscillatorCount && vols.length >= oscillatorCount && muted.length >= oscillatorCount) {
            setFrequencies(freqs.slice(0, oscillatorCount));
            setVolumes(vols.slice(0, oscillatorCount));
            setMutedOscillators(muted.slice(0, oscillatorCount));
          }
        } catch {
          // ignore
        }
      }
      animationId = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(animationId);
  }, [oscillatorCount]);

  const handlePlayPause = () => {
    if (!audioEngine.initialized) return;
    audioEngine.togglePlayPause();
    setIsPaused(audioEngine.paused);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        if (!audioEngine.initialized) return;
        audioEngine.togglePlayPause();
        setIsPaused(audioEngine.paused);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleMuteToggle = (index) => {
    if (!audioEngine.initialized) return;
    audioEngine.toggleMute(index);
  };

  return (
    <>
      <div className="osc-controls-panel">
        <div className="osc-controls-wrapper">
          {oscillators.map((osc) => (
            <OscillatorRow
              key={osc.index}
              index={osc.index}
              label={osc.label}
              color={osc.color}
              isMuted={mutedOscillators[osc.index] || false}
              onMuteToggle={handleMuteToggle}
              freq={frequencies[osc.index] ?? 60}
              volume={volumes[osc.index] ?? 50}
            />
          ))}
        </div>
      </div>

      <div className="osc-panel">
        <div className="control-toggles">
          <button
            className={`control-toggle icon-button ${isPaused ? '' : 'active'}`}
            onClick={handlePlayPause}
            title={isPaused ? 'Play (Space)' : 'Pause (Space)'}
          >
            {isPaused ? (
              <svg viewBox="0 0 24 24" className="button-icon">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="button-icon">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            )}
          </button>

          <button
            className={`control-toggle ${fineTuneEnabled ? 'active' : ''}`}
            onClick={onFineTuneToggle}
            aria-pressed={fineTuneEnabled}
            title="Fine tune mode for precise adjustments (hold Shift)"
          >
            Fine Tune
          </button>

          <button
            className="control-toggle icon-button"
            onClick={onShare}
            title="Save/Share Formula"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path d="M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
            </svg>
          </button>

          <button
            className={`control-toggle icon-button ${isSettingsOpen ? 'active' : ''}`}
            onClick={onSettingsToggle}
            title="Settings"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
          </button>

          <button
            className="control-toggle icon-button"
            onClick={onShowHelp}
            title="Help / Controls"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
