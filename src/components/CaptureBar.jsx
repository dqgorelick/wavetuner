import { memo, useEffect, useState } from 'react';
import frequencyManager from '../audio/FrequencyManager';

// The four fixed capture slots, keyed by their Roman-numeral name. Capture
// (the scan button by the spectrum) fills these; the numerals only recall.
const NUMERALS = ['I', 'II', 'III', 'IV'];

// Transport + capture-slot bar: [undo] [redo] · [I] [II] [III] [IV] · [✕].
// It sits to the right of the play button (rendered by OscillatorControls) so
// the whole thing reads as one bottom bar. Self-subscribes to the manager.
function CaptureBar() {
  const [, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setV((v) => v + 1); });
    };
    const off = frequencyManager.onChange(bump);
    return () => { if (raf) cancelAnimationFrame(raf); off(); };
  }, []);

  const slots = frequencyManager.getSlots();
  const byName = (n) => slots.find((s) => s.name === n) || null;
  const stagedId = frequencyManager.stagedSlotId;

  // Filled slot: first click stages it (return markers appear); a second click
  // (already staged) recalls every voice at once. Empty slots do nothing.
  const clickSlot = (numeral) => {
    const slot = byName(numeral);
    if (!slot) return;
    if (frequencyManager.stagedSlotId === slot.id) frequencyManager.launchAll();
    else frequencyManager.stageSlot(slot.id);
  };

  return (
    <div className="capture-bar" role="group" aria-label="Undo, redo and capture slots">
      <button
        type="button"
        className="cap-bar-btn ghost"
        onClick={() => frequencyManager.undo()}
        disabled={!frequencyManager.canUndo()}
        title="Undo (glides back)"
        aria-label="Undo"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
        </svg>
      </button>
      <button
        type="button"
        className="cap-bar-btn ghost"
        onClick={() => frequencyManager.redo()}
        disabled={!frequencyManager.canRedo()}
        title="Redo (glides forward)"
        aria-label="Redo"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 14 5-5-5-5" />
          <path d="M20 9H10a6 6 0 0 0 0 12h3" />
        </svg>
      </button>

      <span className="cap-bar-sep" aria-hidden="true" />

      {NUMERALS.map((n) => {
        const slot = byName(n);
        const filled = !!slot;
        const staged = filled && stagedId === slot.id;
        return (
          <button
            key={n}
            type="button"
            className={`cap-slot ${filled ? (staged ? 'staged' : 'filled') : 'empty'}`}
            onClick={() => clickSlot(n)}
            disabled={!filled}
            title={filled
              ? (staged ? `Recall save ${n}` : `Stage save ${n}`)
              : `Save slot ${n} — empty (use Capture to fill)`}
            aria-label={`Save slot ${n}`}
            aria-pressed={staged}
          >
            {n}
          </button>
        );
      })}

      <span className="cap-bar-sep" aria-hidden="true" />

      <button
        type="button"
        className="cap-x"
        onClick={() => frequencyManager.clearStaged()}
        disabled={stagedId == null}
        title="Deselect — leave save-state mode"
        aria-label="Deselect save state"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export default memo(CaptureBar);
