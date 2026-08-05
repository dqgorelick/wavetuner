import { memo, useEffect, useState } from 'react';
import frequencyManager from '../audio/FrequencyManager';
import conductor from '../audio/GenerativeConductor';

// The five fixed save slots, keyed by their Roman-numeral name.
const NUMERALS = ['I', 'II', 'III', 'IV', 'V'];

// Transport + save-slot bar. The centered group holds [undo] [redo] · [I][II]
// [III][IV]; saving/selecting all happens on the slots themselves. When a slot
// is SELECTED, a [Launch] [🗑] cluster appears pinned to the right of the pill
// (mirrors the drone tray's mute-all button) — both act on the selected slot.
//
// Slot model:
//   • Empty slot (+)  → click SAVES the current state here.
//   • Filled slot     → click SELECTS it (return markers, silent preview).
//                       Click again DESELECTS. Launch commits; 🗑 deletes.
// onEnsurePlaying: resumes playback if paused (master or drone-only pause) —
// GO and the generative transition call it first so committing to a save is
// audible even from a paused session.
function CaptureBar({ onEnsurePlaying }) {
  const [, setV] = useState(0);
  const [canLaunch, setCanLaunch] = useState(false);
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setV((v) => v + 1); });
    };
    const off = frequencyManager.onChange(bump);
    return () => { if (raf) cancelAnimationFrame(raf); off(); };
  }, []);

  const stagedId = frequencyManager.stagedSlotId;

  // Orb drags, fader moves and transpose drags mutate audioEngine directly
  // (they don't fire the manager's onChange), so poll while a slot is staged
  // to keep Launch's lit state live. The manager's dirtiness check covers
  // every in-scope param — freq, volume, on/off and transpose — so GO lights
  // whenever launching would change something the parameter lock tracks.
  useEffect(() => {
    if (stagedId == null) return undefined;
    let raf = 0;
    let last = 0;
    // 15 Hz — this only lights a button, and stagedIsDirty() walks every
    // tracked parameter against the staged snapshot.
    const tick = (ts) => {
      raf = requestAnimationFrame(tick);
      const now = typeof ts === 'number' ? ts : performance.now();
      if (now - last < 1000 / 15 - 1.5) return;
      last = now;
      setCanLaunch(frequencyManager.stagedIsDirty());
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); setCanLaunch(false); };
  }, [stagedId]);

  const slots = frequencyManager.getSlots();
  const byName = (n) => slots.find((s) => s.name === n) || null;
  // At least one save the bar displays (stored slots can include invisible
  // ones — old sessions, patch imports). No visible save → nothing the
  // transition button could travel to, so it hides.
  const hasVisibleSave = NUMERALS.some((n) => byName(n));
  // Empty recall scope → recalling applies nothing, so filled numerals go inert
  // (dashed, non-performing). Empty (+) slots stay active — saving always works.
  const recallEmpty = frequencyManager.getRecallScope().length === 0;

  const clickSlot = (numeral) => {
    const slot = byName(numeral);
    if (!slot) {
      // Empty slot → save the current state here, then select it.
      const newId = frequencyManager.saveCurrent({ name: numeral });
      if (newId) frequencyManager.stageSlot(newId);
      return;
    }
    // Filled slot → toggle selection. Second click deselects; launching is the
    // separate Launch button so a big audible commit is never an accidental
    // double-tap. A deselect releases the markers but lets any in-flight
    // glides FINISH — freezing them mid-glide would strand voices off every
    // save (deselecting during a GO / generative transition).
    if (frequencyManager.stagedSlotId === slot.id) frequencyManager.clearStaged({ finishGlides: true });
    else frequencyManager.stageSlot(slot.id);
  };

  const deleteSelected = () => {
    if (stagedId != null) frequencyManager.deleteSlot(stagedId);
  };

  return (
    <div className="capture-bar" role="group" aria-label="Undo, redo and save slots">
      <div className="cap-center">
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
          const inert = filled && recallEmpty;
          const state = filled ? (staged ? 'staged' : 'filled') : 'empty';
          // Held kbd/MIDI notes captured with this save (HELD_NOTES.md §2) —
          // surfaced in the hover title only. Capture-only for now (recall
          // doesn't apply them yet).
          const heldCount = filled
            ? (frequencyManager.getSlotHeldNotes(slot.id)?.length || 0)
            : 0;
          return (
            <div key={n} className={`cap-slot-wrap ${state}${inert ? ' inert' : ''}`}>
              <button
                type="button"
                className="cap-slot-main"
                onClick={() => clickSlot(n)}
                disabled={inert}
                title={filled
                  ? (inert
                      ? 'No parameters selected — pick at least one in the tuning menu to recall'
                      : (staged ? `Deselect save ${n}` : `Select save ${n} (preview)`)
                        + (heldCount ? ` — holds ${heldCount} played note${heldCount === 1 ? '' : 's'}` : ''))
                  : `Save current state to slot ${n}`}
                aria-label={filled ? `Save slot ${n}` : `Save current state to slot ${n}`}
                aria-pressed={staged}
              >
                {filled ? n : (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Actions float just outside the pill's right edge (absolute), only
          while a slot is selected — so they never push the centered transport.
          Launch lights only once a tracked parameter has moved off the save. */}
      {(stagedId != null || hasVisibleSave) && (
        <div className="cap-actions">
          {stagedId != null && (
            <button
              type="button"
              className="cap-launch"
              onClick={() => { onEnsurePlaying?.(); frequencyManager.launchAll(); }}
              disabled={!canLaunch}
              title={canLaunch
                ? 'Go — glide every tracked parameter back to the selected save'
                : 'Change a tracked parameter (pitch, volume, on/off, transpose), then Go to glide back to the save'}
              aria-label="Go to selected save"
            >
              GO
            </button>
          )}
          {hasVisibleSave && (
          <button
            type="button"
            className="cap-launch"
            onClick={() => { onEnsurePlaying?.(); conductor.transition(); }}
            title={stagedId != null && canLaunch
              ? 'Generative transition to the selected save (see the Transition panel)'
              : 'Generative transition — picks a random save the voices aren’t on and travels there'}
            aria-label="Generative transition"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z" />
            </svg>
          </button>
          )}
          {stagedId != null && (
          <button
            type="button"
            className="cap-x"
            onClick={deleteSelected}
            title="Delete selected save"
            aria-label="Delete selected save"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(CaptureBar);
