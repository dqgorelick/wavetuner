import { memo, useEffect, useMemo, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import palette, { useTheme } from '../theme/palette';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function freqToNote(freq) {
  if (freq <= 0) return { note: '--', octave: 0, cents: 0 };
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midiNote = Math.round(69 + semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - (midiNote - 69)) * 100);
  const noteIndex = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;
  return { note: NOTE_NAMES[noteIndex], octave, cents };
}

function formatFreq(freq) {
  if (freq >= 10000) return `${(freq / 1000).toFixed(1)}k`;
  if (freq >= 1000) return `${(freq / 1000).toFixed(2)}k`;
  return freq.toFixed(2);
}

function FullscreenFreqList({
  oscillatorCount,
  isPaused = false,
  onPausedChange,
}) {
  useTheme(); // re-render when theme flips
  const [frequencies, setFrequencies] = useState(() => Array(oscillatorCount).fill(440));
  const [muted, setMuted] = useState(() => Array(oscillatorCount).fill(false));

  useEffect(() => {
    let raf;
    const arraysEqual = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const tick = () => {
      if (audioEngine.initialized) {
        try {
          const f = audioEngine.getAllFrequencies();
          const m = audioEngine.getAllMutedStates();
          if (f.length >= oscillatorCount && m.length >= oscillatorCount) {
            const nf = f.slice(0, oscillatorCount);
            const nm = m.slice(0, oscillatorCount);
            setFrequencies((prev) => (arraysEqual(prev, nf) ? prev : nf));
            setMuted((prev) => (arraysEqual(prev, nm) ? prev : nm));
          }
        } catch { /* ignore */ }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [oscillatorCount]);

  // Rank-by-frequency for animated reordering. ranks[i] = sorted position
  // of oscillator i. Each row uses a stable React key (osc index) and is
  // positioned absolutely by rank — when frequencies cross, only the
  // top values change, the CSS transition handles the visual swap.
  const ranks = useMemo(() => {
    const idx = frequencies.map((_, i) => i);
    idx.sort((a, b) => (frequencies[a] - frequencies[b]) || (a - b));
    const out = new Array(frequencies.length);
    idx.forEach((origIdx, sortedPos) => { out[origIdx] = sortedPos; });
    return out;
  }, [frequencies]);

  const handlePlayPause = () => {
    if (!audioEngine.initialized) return;
    audioEngine.togglePlayPause();
    onPausedChange?.(audioEngine.paused);
  };

  return (
    <div className="fullscreen-freq-list">
      <div
        className="ff-rows"
        style={{ '--ff-row-count': frequencies.length }}
      >
        {frequencies.map((f, i) => {
          const note = freqToNote(f);
          const cents = note.cents >= 0 ? `+${note.cents}` : `${note.cents}`;
          const color = palette.oscColor(i, oscillatorCount);
          const isMuted = muted[i];
          return (
            <button
              key={i}
              className={`ff-row ${isMuted ? 'muted' : ''}`}
              style={{ '--osc-color': color, '--ff-row-rank': ranks[i] }}
              onClick={() => audioEngine.toggleMute(i)}
              title={isMuted
                ? `Unmute drone ${i + 1}`
                : `Mute drone ${i + 1}`}
            >
              <span className="ff-freq">{formatFreq(f)}</span>
              <span className="ff-sep">—</span>
              <span className="ff-note">{note.note}{note.octave}<span className="ff-cents">{cents}</span></span>
            </button>
          );
        })}
      </div>

      <div className="ff-footer">
        <button
          type="button"
          className={`ff-footer-btn ${isPaused ? 'paused' : ''}`}
          onClick={handlePlayPause}
          aria-label={isPaused ? 'Play drone' : 'Pause drone'}
          title={isPaused ? 'Play drone (Space)' : 'Pause drone (Space)'}
        >
          {isPaused ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export default memo(FullscreenFreqList);
