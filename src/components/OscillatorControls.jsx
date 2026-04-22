import { memo, useEffect, useRef, useState, useMemo } from 'react';
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

function getOscillatorLabel(index) {
  return `${index + 1}`;
}

function formatFreq(freq) {
  // Always show two decimals so small freq changes are visible.
  if (freq >= 10000) return `${(freq / 1000).toFixed(1)}k`; // "12.3k"
  if (freq >= 1000) return `${(freq / 1000).toFixed(2)}k`;  // "1.23k"
  return freq.toFixed(2);                                    // "144.32", "44.00", "0.12"
}

// Horizontal drag on a per-osc fader fine-tunes that osc's frequency.
// 1/500 ≈ one octave per 500px of drag, comparable in feel to shift-drag on the spectrum bar.
const FADER_FREQ_OCTAVES_PER_PX = 1 / 500;

const MasterVolumeFader = memo(function MasterVolumeFader({ volume }) {
  const ref = useRef(null);
  const draggingRef = useRef(false);

  const setFromY = (clientY) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relY = clientY - rect.top;
    const v = 1 - Math.max(0, Math.min(1, relY / rect.height));
    audioEngine.setMasterVolume(v);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    draggingRef.current = true;
    setFromY(e.clientY);
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    setFromY(e.clientY);
  };
  const handlePointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  };

  const fillPct = volume * 100;

  return (
    <div
      ref={ref}
      className="volume-fader master-fader"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="volume-fader-fill" style={{ height: `${fillPct}%` }} />
      <div className="volume-fader-thumb" style={{ bottom: `${fillPct}%` }} />
    </div>
  );
});

const MasterAllCol = memo(function MasterAllCol({ masterVolume, onAllOctave, isPaused, onPlayPause }) {
  return (
    <div className="osc-col osc-all-col">
      <div className="osc-col-readout osc-all-col-label">
        <span className="freq-hz">ALL</span>
      </div>

      <div className="osc-octave-buttons">
        <button
          className="osc-octave-btn"
          onClick={() => onAllOctave(2)}
          title="Double all frequencies (up an octave)"
          aria-label="Double all frequencies"
        >×2</button>
        <button
          className="osc-octave-btn"
          onClick={() => onAllOctave(0.5)}
          title="Halve all frequencies (down an octave)"
          aria-label="Halve all frequencies"
        >/2</button>
      </div>

      <MasterVolumeFader volume={masterVolume} />

      <button
        className="osc-all-playpause"
        onClick={onPlayPause}
        title={isPaused ? 'Play (Space)' : 'Pause (Space)'}
        aria-label={isPaused ? 'Play' : 'Pause'}
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
    </div>
  );
});

const VolumeFader = memo(function VolumeFader({ oscIndex, volume, color, isMuted }) {
  const ref = useRef(null);
  const draggingRef = useRef(false);
  const lastXRef = useRef(0);

  const setFromY = (clientY) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relY = clientY - rect.top;
    const v = 1 - Math.max(0, Math.min(1, relY / rect.height));
    audioEngine.setVolume(oscIndex, v);
  };

  const applyHorizontalFreqDelta = (deltaX) => {
    if (deltaX === 0) return;
    const cur = audioEngine.getFrequency(oscIndex);
    const next = Math.max(0.1, Math.min(20000, cur * 2 ** (deltaX * FADER_FREQ_OCTAVES_PER_PX)));
    audioEngine.setFrequency(oscIndex, next);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    draggingRef.current = true;
    lastXRef.current = e.clientX;
    setFromY(e.clientY);
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    setFromY(e.clientY);
    const deltaX = e.clientX - lastXRef.current;
    lastXRef.current = e.clientX;
    applyHorizontalFreqDelta(deltaX);
  };
  const handlePointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  };

  const fillPct = isMuted ? 0 : volume;

  return (
    <div
      ref={ref}
      className={`volume-fader ${isMuted ? 'muted' : ''}`}
      style={{ '--fader-color': color }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="volume-fader-fill" style={{ height: `${fillPct}%` }} />
      <div className="volume-fader-thumb" style={{ bottom: `${fillPct}%` }} />
    </div>
  );
});

const OscillatorCol = memo(function OscillatorCol({ index, label, color, isMuted, isActive, onMuteToggle, freq, volume }) {
  const noteInfo = freqToNote(freq);
  const centsStr = noteInfo.cents >= 0 ? `+${noteInfo.cents}` : `${noteInfo.cents}`;

  const shiftOctave = (factor) => {
    const cur = audioEngine.getFrequency(index);
    const next = Math.max(0.1, Math.min(20000, cur * factor));
    audioEngine.setFrequency(index, next);
  };

  return (
    <div
      className={`osc-col ${isMuted ? 'muted' : ''} ${isActive ? 'active' : ''}`}
      style={{ '--row-color': color }}
    >
      <div className="osc-col-readout">
        <span className="freq-hz">{formatFreq(freq)}</span>
        <span className="freq-note-cents">
          <span className="freq-note">{noteInfo.note}{noteInfo.octave}</span>
          <span className="freq-cents">{centsStr}</span>
        </span>
      </div>

      <div className="osc-octave-buttons">
        <button
          className="osc-octave-btn"
          onClick={() => shiftOctave(2)}
          title="Double frequency (up an octave)"
          aria-label="Double frequency"
        >×2</button>
        <button
          className="osc-octave-btn"
          onClick={() => shiftOctave(0.5)}
          title="Halve frequency (down an octave)"
          aria-label="Halve frequency"
        >/2</button>
      </div>

      <VolumeFader oscIndex={index} volume={volume} color={color} isMuted={isMuted} />

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
    </div>
  );
});

function OscillatorControls({
  oscillatorCount = 2,
  onShare,
  onSettingsToggle,
  isSettingsOpen,
  onShowHelp,
  fineTuneEnabled = false,
  onFineTuneToggle,
  onOscillatorCountChange,
  activeOscs,
}) {
  const createInitialArray = (defaultValue, length) => Array(length).fill(defaultValue);

  const [mutedOscillators, setMutedOscillators] = useState(() => createInitialArray(false, oscillatorCount));
  const [frequencies, setFrequencies] = useState(() => createInitialArray(60, oscillatorCount));
  const [volumes, setVolumes] = useState(() => createInitialArray(50, oscillatorCount));
  const [masterVolume, setMasterVolume] = useState(() => audioEngine.getMasterVolume?.() ?? 1);
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
      label: getOscillatorLabel(i),
      color: OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length],
    }));
  }, [oscillatorCount]);

  // Single horizontally-scrolling row at all widths — mirrors the mobile layout
  // on desktop too so the master ALL column lines up the same way everywhere.
  const rows = useMemo(() => [oscillators], [oscillators]);

  useEffect(() => {
    let animationId;
    const arraysEqual = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const sync = () => {
      if (audioEngine.initialized) {
        try {
          const freqs = audioEngine.getAllFrequencies();
          const vols = audioEngine.getAllVolumes();
          const muted = audioEngine.getAllMutedStates();
          if (freqs.length >= oscillatorCount && vols.length >= oscillatorCount && muted.length >= oscillatorCount) {
            const nf = freqs.slice(0, oscillatorCount);
            const nv = vols.slice(0, oscillatorCount);
            const nm = muted.slice(0, oscillatorCount);
            setFrequencies((prev) => (arraysEqual(prev, nf) ? prev : nf));
            setVolumes((prev) => (arraysEqual(prev, nv) ? prev : nv));
            setMutedOscillators((prev) => (arraysEqual(prev, nm) ? prev : nm));
          }
          const mv = audioEngine.getMasterVolume?.() ?? 1;
          setMasterVolume((prev) => (prev === mv ? prev : mv));
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

  const shiftAllOctaves = (factor) => {
    for (let i = 0; i < oscillatorCount; i++) {
      const cur = audioEngine.getFrequency(i);
      const next = Math.max(0.1, Math.min(20000, cur * factor));
      audioEngine.setFrequency(i, next);
    }
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
      <div className="top-right-cluster">
        <button
          className={`control-toggle icon-button ${isSettingsOpen ? 'active' : ''}`}
          onClick={onSettingsToggle}
          title="Settings"
          aria-label="Settings"
        >
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
          </svg>
        </button>
        <button
          className="control-toggle icon-button"
          onClick={onShowHelp}
          title="Help / Controls"
          aria-label="Help"
        >
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" />
          </svg>
        </button>
        <button
          className="control-toggle icon-button"
          onClick={onShare}
          title="Save/Share Formula"
          aria-label="Save"
        >
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
          </svg>
        </button>
      </div>

      <div className="osc-controls-panel">
        <div className="osc-controls-wrapper">
          {rows.map((row, rowIdx) => (
            <div key={rowIdx} className="osc-fader-row-wrap">
              {rowIdx === 0 && (
                <MasterAllCol
                  masterVolume={masterVolume}
                  onAllOctave={shiftAllOctaves}
                  isPaused={isPaused}
                  onPlayPause={handlePlayPause}
                />
              )}
              <div className="osc-fader-row">
                {row.map((osc) => (
                  <OscillatorCol
                    key={osc.index}
                    index={osc.index}
                    label={osc.label}
                    color={osc.color}
                    isMuted={mutedOscillators[osc.index] || false}
                    isActive={activeOscs?.has(osc.index) || false}
                    onMuteToggle={handleMuteToggle}
                    freq={frequencies[osc.index] ?? 60}
                    volume={volumes[osc.index] ?? 50}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="osc-count-bar">
        <button
          className="osc-count-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount - 1)}
          disabled={oscillatorCount <= 2}
          title="Remove oscillator"
          aria-label="Remove oscillator"
        >
          −
        </button>
        <span className="osc-count-label">{oscillatorCount}</span>
        <button
          className="osc-count-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount + 1)}
          disabled={oscillatorCount >= 10}
          title="Add oscillator"
          aria-label="Add oscillator"
        >
          +
        </button>
      </div>
    </>
  );
}

export default memo(OscillatorControls);
