import { useEffect, useRef } from 'react';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { isEditableTarget } from './keyboardUtils';

/**
 * Ableton-style computer-keyboard input.
 *
 *   White keys (semitones from root): A=0  S=2  D=4  F=5  G=7  H=9  J=11  K=12  L=14  ;=16
 *   Black keys                      : W=1  E=3  T=6  Y=8  U=10 O=13 P=15
 *   Z = transpose down,  X = transpose up
 *
 * The Z/X buttons shift the keyboard's lowest-key MIDI note by `stepSize`
 * semitones — KeyboardTray feeds in the live oscillator count so the
 * shift is one "scale octave" worth (N degrees) rather than always 12.
 * Default kbdRoot is MIDI 60 (C4); stays in sync with OnScreenKeyboard.
 */

const KEY_TO_OFFSET = {
  a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11, k: 12, l: 14, ';': 16,
  w: 1, e: 3, t: 6, y: 8, u: 10, o: 13, p: 15,
};

// Computer-keyboard hits don't carry real velocity, so the kbd source
// in the voice manager substitutes peak=1.0 and the user dials in their
// dynamic via the long-ramp attack: how long they hold the key sets the
// amplitude reached, and keyup freezes that level as the new sustain.
// (See KeyboardVoiceManager.noteOn — the velocity arg is ignored for
// source: 'kbd'.)

// Inverse table: semitone offset → uppercase letter, for the on-screen
// keyboard's labels overlay. Single source of truth for the layout —
// editing KEY_TO_OFFSET above will propagate here.
export const OFFSET_TO_LETTER = (() => {
  const out = {};
  for (const [letter, offset] of Object.entries(KEY_TO_OFFSET)) {
    out[offset] = letter.toUpperCase();
  }
  return out;
})();

export default function useComputerKeyboard({ enabled, kbdRoot, setKbdRoot, stepSize }) {
  // Refs let the keydown closure see latest values without us having
  // to re-attach listeners on every render.
  const enabledRef = useRef(enabled);
  const rootRef = useRef(kbdRoot);
  const stepRef = useRef(stepSize);
  // Per-key bookkeeping: which lowercase letter currently holds which
  // MIDI note. Lets keyup release the *exact* midi that keydown fired,
  // even after a Z/X transpose shift in between (the held note keeps
  // sounding at its original pitch and gets released cleanly).
  const heldNotes = useRef(new Map());

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { rootRef.current = kbdRoot; }, [kbdRoot]);
  useEffect(() => { stepRef.current = stepSize; }, [stepSize]);

  // Toggling off mid-play resolves any held letters as if the user had
  // released them — freeze if hold is on (so the latched chord persists
  // via the kbd hold mechanic), otherwise noteOff. Without this, ramping
  // notes get stuck mid-attack since no keyup will reach below once the
  // listener gate flips.
  useEffect(() => {
    if (enabled) return;
    const holdOn = keyboardVoiceManager.getHold('kbd');
    for (const midi of heldNotes.current.values()) {
      if (holdOn) keyboardVoiceManager.freezeNote(midi, 'kbd');
      else keyboardVoiceManager.noteOff(midi, { source: 'kbd' });
    }
    heldNotes.current.clear();
  }, [enabled]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.repeat) return;
      if (!enabledRef.current) return;
      if (isEditableTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();

      if (key === 'z') {
        const step = Math.max(1, stepRef.current | 0);
        setKbdRoot((r) => Math.max(12, r - step));
        e.preventDefault();
        return;
      }
      if (key === 'x') {
        const step = Math.max(1, stepRef.current | 0);
        setKbdRoot((r) => Math.min(108, r + step));
        e.preventDefault();
        return;
      }

      const offset = KEY_TO_OFFSET[key];
      if (offset === undefined) return;
      // Guard against the rare desync where the OS dropped a keyup
      // (e.g. window blurred while held) — re-pressing should not
      // double-trigger.
      if (heldNotes.current.has(key)) return;

      const midi = rootRef.current + offset;
      heldNotes.current.set(key, midi);
      // Velocity arg is ignored for source: 'kbd' — peak is fixed at 1.0
      // and the user dials it down by releasing during the ramp.
      keyboardVoiceManager.noteOn(midi, 1, { source: 'kbd' });
      e.preventDefault();
    };

    const handleKeyUp = (e) => {
      const key = e.key.toLowerCase();
      const midi = heldNotes.current.get(key);
      if (midi === undefined) return;
      heldNotes.current.delete(key);
      // With kbd hold on, keyup freezes the voice at its reached gain
      // (becomes the new sustain). With hold off, fall back to a normal
      // release ramp from current gain — same captured-from-current
      // shape, just heading to 0 instead of sustain.
      if (keyboardVoiceManager.getHold('kbd')) {
        keyboardVoiceManager.freezeNote(midi, 'kbd');
      } else {
        keyboardVoiceManager.noteOff(midi, { source: 'kbd' });
      }
    };

    // Window blur (alt-tab, focus loss) can swallow keyups → stuck
    // notes. Resolve held keys the same way keyup would so a blurred
    // chord either persists (hold on, frozen) or fades out (hold off).
    const handleBlur = () => {
      const holdOn = keyboardVoiceManager.getHold('kbd');
      for (const midi of heldNotes.current.values()) {
        if (holdOn) keyboardVoiceManager.freezeNote(midi, 'kbd');
        else keyboardVoiceManager.noteOff(midi, { source: 'kbd' });
      }
      heldNotes.current.clear();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      // The ref's Map is stable across renders; we mutate it in place.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const holdOn = keyboardVoiceManager.getHold('kbd');
      for (const midi of heldNotes.current.values()) {
        if (holdOn) keyboardVoiceManager.freezeNote(midi, 'kbd');
        else keyboardVoiceManager.noteOff(midi, { source: 'kbd' });
      }
      heldNotes.current.clear();
    };
  }, [setKbdRoot]);
}
