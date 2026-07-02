import { memo, useEffect, useState } from 'react';
import frequencyManager from '../audio/FrequencyManager';

const NUMERALS = ['I', 'II', 'III', 'IV'];

// Capture = the single save gesture (scan-frame icon), docked above the voice
// steppers at the right of the spectrum. It saves the current state into the
// lowest empty slot (I→II→III→IV); if a slot is currently staged it OVERWRITES
// that slot instead. Disabled when there's nowhere to save (all full + none
// selected). The numeral buttons never save — they only recall.
function CaptureButton() {
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
  const used = new Set(slots.map((s) => s.name));
  const stagedId = frequencyManager.stagedSlotId;
  const stagedSlot = stagedId != null ? slots.find((s) => s.id === stagedId) : null;
  const nextEmpty = NUMERALS.find((n) => !used.has(n)) || null;
  // Overwrite the staged slot if one is selected; otherwise fill the next empty.
  const target = stagedSlot ? stagedSlot.name : nextEmpty;

  const capture = () => {
    if (!target) return;
    const existing = slots.find((s) => s.name === target);
    // "Overwrite" = delete then re-save under the same numeral (per the plan).
    if (existing) frequencyManager.deleteSlot(existing.id);
    const newId = frequencyManager.saveCurrent({ name: target });
    // Auto-select the slot we just captured, so its return markers are armed
    // and the next capture overwrites it in place (deselect first for a new slot).
    if (newId) frequencyManager.stageSlot(newId);
  };

  return (
    <button
      type="button"
      className="capture-btn"
      onClick={capture}
      disabled={!target}
      title={stagedSlot
        ? `Overwrite save ${stagedSlot.name} with the current state`
        : (nextEmpty ? `Capture current state to save ${nextEmpty}` : 'All slots full — select one to overwrite')}
      aria-label="Capture current state"
    >
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8" />
        <path d="M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8" />
        <path d="M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16" />
        <path d="M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16" />
      </svg>
    </button>
  );
}

export default memo(CaptureButton);
