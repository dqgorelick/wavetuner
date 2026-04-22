import { memo, useEffect, useState } from 'react';
import audioEngine from '../audio/AudioEngine';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OSCILLATOR_COLORS = [
  '#ff4136', '#2ecc40', '#0074d9', '#ffdc00', '#bb8fce',
  '#85c1e9', '#82e0aa', '#f8b500', '#e74c3c', '#1abc9c',
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

function formatFreq(freq) {
  if (freq >= 10000) return `${(freq / 1000).toFixed(1)}k`;
  if (freq >= 1000) return `${(freq / 1000).toFixed(2)}k`;
  return freq.toFixed(2);
}

function FullscreenFreqList({ oscillatorCount, selectedOscs, onToggleSelect }) {
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

  return (
    <div className="fullscreen-freq-list">
      {frequencies.map((f, i) => {
        const note = freqToNote(f);
        const cents = note.cents >= 0 ? `+${note.cents}` : `${note.cents}`;
        const color = OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length];
        const isSelected = selectedOscs?.has(i);
        const isMuted = muted[i];
        return (
          <button
            key={i}
            className={`ff-row ${isSelected ? 'selected' : ''} ${isMuted ? 'muted' : ''}`}
            style={{ '--osc-color': color }}
            onClick={() => onToggleSelect?.(i)}
            title={`Toggle highlight osc ${i + 1}`}
          >
            <span className="ff-freq">{formatFreq(f)}</span>
            <span className="ff-sep">—</span>
            <span className="ff-note">{note.note}{note.octave}<span className="ff-cents">{cents}</span></span>
          </button>
        );
      })}
    </div>
  );
}

export default memo(FullscreenFreqList);
