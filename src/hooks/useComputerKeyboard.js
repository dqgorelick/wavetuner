import { useEffect, useRef } from 'react';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { isEditableTarget } from './keyboardUtils';

/**
 * Ableton-style computer-keyboard input.
 *
 *   White keys (semitones from root): A=0  S=2  D=4  F=5  G=7  H=9  J=11  K=12  L=14
 *   Black keys                      : W=1  E=3  T=6  Y=8  U=10 O=13 P=15
 *   Z = octave down,  X = octave up
 *
 * MIDI math follows the standard "C(n) = MIDI 12·(n+1)" convention, so
 * keyboardOctave=4 means the lowest key on the on-screen keyboard is
 * MIDI 60 (C4). Stays in sync with OnScreenKeyboard via the same formula.
 */

const KEY_TO_OFFSET = {
  a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11, k: 12, l: 14,
  w: 1, e: 3, t: 6, y: 8, u: 10, o: 13, p: 15,
};

// Computer-keyboard hits don't carry real velocity, so we substitute a
// fixed value at noteOn time. 0.5 is calibrated for safe polyphony:
// √N × 0.5 stays at or below unity for N ≤ 4 voices (random-phase
// summation), so typical chording doesn't push the bus past clip.
// Real MIDI controllers can hit 1.0, but they DON'T do it on every
// note — dynamic play averages much lower. The fixed-velocity nature
// of computer keyboard is what makes it stack worse than typical MIDI
// play, so we compensate by pinning it lower.
const COMPUTER_KEY_VELOCITY = 0.5;

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

export default function useComputerKeyboard({ enabled, keyboardOctave, setKeyboardOctave }) {
  // Refs let the keydown closure see latest values without us having
  // to re-attach listeners on every render.
  const enabledRef = useRef(enabled);
  const octaveRef = useRef(keyboardOctave);
  // Per-key bookkeeping: which lowercase letter currently holds which
  // MIDI note. Lets keyup release the *exact* midi that keydown fired,
  // even after a Z/X octave shift in between (the held note keeps
  // sounding at its original pitch and gets released cleanly).
  const heldNotes = useRef(new Map());

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { octaveRef.current = keyboardOctave; }, [keyboardOctave]);

  // Toggling off mid-play should silence any held letters — otherwise
  // they'd be stuck (no keyup will reach noteOff once the listener is
  // gated off below).
  useEffect(() => {
    if (enabled) return;
    for (const midi of heldNotes.current.values()) {
      keyboardVoiceManager.noteOff(midi);
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
        setKeyboardOctave((o) => Math.max(0, o - 1));
        e.preventDefault();
        return;
      }
      if (key === 'x') {
        setKeyboardOctave((o) => Math.min(8, o + 1));
        e.preventDefault();
        return;
      }

      const offset = KEY_TO_OFFSET[key];
      if (offset === undefined) return;
      // Guard against the rare desync where the OS dropped a keyup
      // (e.g. window blurred while held) — re-pressing should not
      // double-trigger.
      if (heldNotes.current.has(key)) return;

      const midi = (octaveRef.current + 1) * 12 + offset;
      heldNotes.current.set(key, midi);
      keyboardVoiceManager.noteOn(midi, COMPUTER_KEY_VELOCITY);
      e.preventDefault();
    };

    const handleKeyUp = (e) => {
      const key = e.key.toLowerCase();
      const midi = heldNotes.current.get(key);
      if (midi === undefined) return;
      heldNotes.current.delete(key);
      keyboardVoiceManager.noteOff(midi);
    };

    // Window blur (alt-tab, focus loss) can swallow keyups → stuck
    // notes. Release everything on blur as a safety net.
    const handleBlur = () => {
      for (const midi of heldNotes.current.values()) {
        keyboardVoiceManager.noteOff(midi);
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
      for (const midi of heldNotes.current.values()) {
        keyboardVoiceManager.noteOff(midi);
      }
      heldNotes.current.clear();
    };
  }, [setKeyboardOctave]);
}
