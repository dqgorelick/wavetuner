import { useEffect, useMemo, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';
import tuning from '../audio/Tuning';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { OFFSET_TO_LETTER } from '../hooks/useComputerKeyboard';
import palette from '../theme/palette';

// Standard piano-keyboard layout within an octave.
//   Whites at semitone offsets 0,2,4,5,7,9,11
//   Blacks at 1,3,6,8,10
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_OFFSETS = [1, 3, 6, 8, 10];

// For each black-key offset, the index of the white key it visually
// follows (within an octave). C# follows white#0 (C); D# follows white#1
// (D); F# follows white#3 (F); etc.
const BLACK_AFTER_WHITE = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };

// Black key as a fraction of one white key's width. Real pianos are ~0.6;
// 0.6 reads cleanly at our key sizes.
const BLACK_KEY_WIDTH_FRAC = 0.6;
// Where the black key's left edge sits inside the preceding white key,
// expressed as a fraction of the white key's width. 0.7 places the black
// key straddling the white-to-white boundary at ~70% across the lower
// white key.
const BLACK_KEY_LEFT_OFFSET = 0.7;

// Default v1 mapping until the picker (phase 6) lands: chromatic + fill.
// Every key fires; degree = (midi - root) mod N, octave = floor of same.
function midiToDegreeOctave(midi) {
  return tuning.degreeAndOctaveForMidi(midi);
}

/**
 * On-screen piano keyboard. Two octaves wide, starting at the supplied
 * keyboardOctave (so keyboardOctave=4 means the lowest key is C4 = MIDI 60).
 *
 * Each key shows a small color dot reflecting which drone slot supplies
 * its current scale degree. Keys glow while a voice is sounding; glow
 * opacity is driven directly from the voice's gain-node value via a
 * per-frame DOM update (no React state on the hot path — same pattern
 * the existing oscilloscope uses).
 */
export default function OnScreenKeyboard({ keyboardOctave = 4, octaveCount = 2 }) {
  const containerRef = useRef(null);
  const keyRefs = useRef(new Map()); // midi → element
  const leftArrowRef = useRef(null);
  const rightArrowRef = useRef(null);
  // Tracks which midi note is currently held by each pointer so that
  // dragging across keys legato-triggers and pointer-up releases the
  // right voice even after a finger has left the originating key.
  const pointerHeld = useRef(new Map()); // pointerId → midi

  // Build the static key layout: list of every key in the visible range,
  // tagged with whether it's black + where it should be positioned.
  // Standard MIDI convention: C(n) = MIDI 12·(n+1), so octave 4 → C4 = 60.
  //
  // The on-screen keyboard's VISUAL start sits one octave BELOW the
  // computer-key mapping so the mouse can reach an octave lower than
  // QWERTY can. The computer-key hook still uses (keyboardOctave + 1)
  // * 12 as its base, so the labeled keys appear in the second octave
  // from the left.
  const letterStartMidi = (keyboardOctave + 1) * 12;
  const startMidi = letterStartMidi - 12;
  const totalWhites = octaveCount * WHITE_OFFSETS.length;

  const { whites, blacks } = useMemo(() => {
    const whites = [];
    const blacks = [];
    for (let oct = 0; oct < octaveCount; oct++) {
      for (let i = 0; i < WHITE_OFFSETS.length; i++) {
        whites.push({
          midi: startMidi + oct * 12 + WHITE_OFFSETS[i],
          whiteIndex: oct * WHITE_OFFSETS.length + i,
        });
      }
      for (const off of BLACK_OFFSETS) {
        const whiteAfter = BLACK_AFTER_WHITE[off] + oct * WHITE_OFFSETS.length;
        blacks.push({
          midi: startMidi + oct * 12 + off,
          whiteAfter,
        });
      }
    }
    return { whites, blacks };
  }, [startMidi, octaveCount]);

  // Per-key color update — sets BOTH the small dot's background AND a
  // `--key-color` CSS variable on the key element itself. The CSS
  // activation overlay (.osk-key::after) reads that variable so a
  // playing key lights up in its drone slot's color rather than a
  // generic white glow. Using imperative DOM updates keeps React out
  // of the per-frame hot path. Refresh runs on tuning AND palette
  // changes so a theme flip recolors every key without remount.
  useEffect(() => {
    const refresh = () => {
      const count = audioEngine.getOscillatorCount();
      const updateOne = (midi) => {
        const el = keyRefs.current.get(midi);
        if (!el) return;
        const dot = el.querySelector('.key-dot');
        const dao = midiToDegreeOctave(midi); // null if mapping silences this key
        const slot = dao ? tuning.droneSlotForDegree(dao.degree) : -1;
        if (!dao || slot < 0) {
          if (dot) dot.classList.remove('is-drone');
          el.style.removeProperty('--key-color');
          el.classList.add('silent');
          return;
        }
        el.classList.remove('silent');
        const color = palette.oscColor(slot, count);
        el.style.setProperty('--key-color', color);
        if (dot) {
          dot.style.background = color;
          dot.classList.toggle('is-drone', dao.octave === 0);
        }
      };
      for (const w of whites) updateOne(w.midi);
      for (const b of blacks) updateOne(b.midi);
    };
    refresh();
    const unsubTune = tuning.onChange(refresh);
    const unsubPalette = palette.onChange(refresh);
    return () => { unsubTune(); unsubPalette(); };
  }, [whites, blacks]);

  // Per-frame glow update from the voice manager. Direct DOM mutation —
  // a setState in rAF would re-render React 60×/s for envelope curves.
  // Also tracks any voices whose midi falls OUTSIDE the visible range
  // and surfaces them on the off-screen arrow indicators (left for
  // notes below startMidi, right for notes at or above the upper edge).
  useEffect(() => {
    const visibleStart = startMidi;
    const visibleEnd = startMidi + octaveCount * 12; // exclusive
    let raf = null;
    // Visual amp normalization: with TAP_VELOCITY=0.5 and keyboard
    // envelope sustain≈0.4, a held note's gain.value sits near 0.2.
    // Driving --glow-alpha straight from that pegs the visual at 20%
    // of its range — keys read as dim. Boost so sustain hits ≈1.0
    // and momentary peaks clamp at 1. Audio is unaffected; this
    // multiplier only scales the CSS variable.
    const VISUAL_AMP_GAIN = 5;
    const toGlow = (amp) => Math.min(1, amp * VISUAL_AMP_GAIN);
    const tick = () => {
      const voices = keyboardVoiceManager.getActiveVoices();
      const count = audioEngine.getOscillatorCount();
      const ampByMidi = new Map();
      let leftAmp = 0, leftColor = null;
      let rightAmp = 0, rightColor = null;

      for (const v of voices) {
        const cur = ampByMidi.get(v.midiNote) || 0;
        if (v.amp > cur) ampByMidi.set(v.midiNote, v.amp);

        if (v.midiNote < visibleStart) {
          if (v.amp > leftAmp) {
            leftAmp = v.amp;
            leftColor = v.slot >= 0 ? palette.oscColor(v.slot, count) : null;
          }
        } else if (v.midiNote >= visibleEnd) {
          if (v.amp > rightAmp) {
            rightAmp = v.amp;
            rightColor = v.slot >= 0 ? palette.oscColor(v.slot, count) : null;
          }
        }
      }

      // Apply per-key glow.
      for (const [midi, el] of keyRefs.current.entries()) {
        const amp = ampByMidi.get(midi) || 0;
        el.style.setProperty('--glow-alpha', toGlow(amp).toFixed(3));
      }

      // Off-screen arrow indicators.
      const left = leftArrowRef.current;
      if (left) {
        left.style.setProperty('--arrow-alpha', toGlow(leftAmp).toFixed(3));
        if (leftColor) left.style.setProperty('--arrow-color', leftColor);
      }
      const right = rightArrowRef.current;
      if (right) {
        right.style.setProperty('--arrow-alpha', toGlow(rightAmp).toFixed(3));
        if (rightColor) right.style.setProperty('--arrow-color', rightColor);
      }

      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [startMidi, octaveCount]);

  // Pointer handlers — pointerdown on a key triggers noteOn; pointerup or
  // pointer leaving the keyboard area triggers noteOff. Dragging from
  // one key to another performs legato (releases the previous, triggers
  // the next).
  // Fixed velocity matches the computer-keyboard tray: pointer taps
  // don't carry real velocity, so we send a moderate value that keeps
  // polyphonic stacking within bus headroom.
  const TAP_VELOCITY = 0.5;
  const handlePointerDown = (e, midi) => {
    if (!audioEngine.isInitialized) return;
    e.preventDefault();
    const id = e.pointerId;
    const prev = pointerHeld.current.get(id);
    if (prev !== undefined && prev !== midi) {
      keyboardVoiceManager.noteOff(prev);
    }
    pointerHeld.current.set(id, midi);
    keyboardVoiceManager.noteOn(midi, TAP_VELOCITY);
    // Intentionally NOT calling setPointerCapture — pointer capture
    // would prevent pointerenter from firing on neighboring keys, which
    // would break drag-to-glissando.
  };
  const handlePointerEnter = (e, midi) => {
    // Only re-trigger when a button is held.
    if (e.buttons === 0) return;
    const id = e.pointerId;
    const prev = pointerHeld.current.get(id);
    if (prev === midi) return;
    if (prev !== undefined) keyboardVoiceManager.noteOff(prev);
    pointerHeld.current.set(id, midi);
    keyboardVoiceManager.noteOn(midi, TAP_VELOCITY);
  };
  const handlePointerUp = (e) => {
    const id = e.pointerId;
    const midi = pointerHeld.current.get(id);
    if (midi !== undefined) {
      keyboardVoiceManager.noteOff(midi);
      pointerHeld.current.delete(id);
    }
  };

  const setKeyRef = (midi) => (el) => {
    if (el) keyRefs.current.set(midi, el);
    else keyRefs.current.delete(midi);
  };

  return (
    <>
      {/* Off-screen indicators: light up in the slot color when a voice
          plays outside the visible range. Rendered as siblings of `.osk`
          so they sit in the side-padding gutters of `.kbd-tray-keys`
          (outside the actual keys area). */}
      <span ref={leftArrowRef} className="osk-arrow osk-arrow-left" aria-hidden="true" />
      <span ref={rightArrowRef} className="osk-arrow osk-arrow-right" aria-hidden="true" />
      <div
        ref={containerRef}
        className="osk"
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{ '--white-count': totalWhites }}
      >
      {whites.map((w) => {
        // Always show the computer-keyboard letter overlay. The CSS
        // tones it down so it sits quietly under the active glow.
        const letter = OFFSET_TO_LETTER[w.midi - letterStartMidi];
        return (
          <div
            key={w.midi}
            ref={setKeyRef(w.midi)}
            className="osk-key osk-white"
            style={{ left: `calc(${w.whiteIndex} * (100% / var(--white-count)))` }}
            onPointerDown={(e) => handlePointerDown(e, w.midi)}
            onPointerEnter={(e) => handlePointerEnter(e, w.midi)}
          >
            {letter && <span className="key-letter">{letter}</span>}
            <span className="key-dot" />
          </div>
        );
      })}
      {blacks.map((b) => {
        const letter = OFFSET_TO_LETTER[b.midi - letterStartMidi];
        return (
          <div
            key={b.midi}
            ref={setKeyRef(b.midi)}
            className="osk-key osk-black"
            style={{
              left: `calc((${b.whiteAfter} + ${BLACK_KEY_LEFT_OFFSET}) * (100% / var(--white-count)))`,
              width: `calc(${BLACK_KEY_WIDTH_FRAC} * (100% / var(--white-count)))`,
            }}
            onPointerDown={(e) => handlePointerDown(e, b.midi)}
            onPointerEnter={(e) => handlePointerEnter(e, b.midi)}
          >
            {letter && <span className="key-letter">{letter}</span>}
            <span className="key-dot" />
          </div>
        );
      })}
      </div>
    </>
  );
}
