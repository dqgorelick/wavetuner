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
  // Empty recall scope → recalling a slot applies nothing, so the numerals go
  // inert (dashed, non-performing).
  const recallEmpty = frequencyManager.getRecallScope().length === 0;

  // Filled slot: first click stages it (return markers appear); a second click
  // (already staged) recalls every voice at once. Empty slots do nothing.
  const clickSlot = (numeral) => {
    const slot = byName(numeral);
    if (!slot) return;
    if (frequencyManager.stagedSlotId === slot.id) frequencyManager.launchAll();
    else frequencyManager.stageSlot(slot.id);
  };
  const deleteSlot = (slot) => frequencyManager.deleteSlot(slot.id);

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
        // Delete only appears once the slot is loaded (staged/launched) — you
        // must select a slot before its ✕ shows, so a stray tap can't wipe an
        // unopened save.
        const canDelete = staged && !recallEmpty;
        const state = filled ? (staged ? 'staged' : 'filled') : 'empty';
        return (
          <div
            key={n}
            className={`cap-slot-wrap ${state}${recallEmpty ? ' inert' : ''}`}
          >
            <button
              type="button"
              className="cap-slot-main"
              onClick={() => clickSlot(n)}
              disabled={!filled || recallEmpty}
              title={recallEmpty
                ? 'No parameters selected — pick at least one in the tuning menu to recall'
                : filled
                  ? (staged ? `Recall save ${n}` : `Stage save ${n}`)
                  : `Save slot ${n} — empty (use Capture to fill)`}
              aria-label={`Save slot ${n}`}
              aria-pressed={staged}
            >
              {n}
            </button>
            {/* Always reserve the delete column's width so the numeral stays
                centered whether or not the ✕ is present — a filled/active slot
                shouldn't shift its label. */}
            {canDelete ? (
              <button
                type="button"
                className="cap-slot-del"
                onClick={() => deleteSlot(slot)}
                tabIndex={-1}
                title={`Clear save ${n}`}
                aria-label={`Clear save ${n}`}
              >
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            ) : (
              // Not yet loaded: this column is a transparent extension of the
              // load button so clicking the reserved ✕ area still stages the
              // slot instead of hitting a dead zone.
              <button
                type="button"
                className="cap-slot-spacer"
                onClick={() => clickSlot(n)}
                disabled={!filled || recallEmpty}
                tabIndex={-1}
                aria-hidden="true"
              />
            )}
          </div>
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
