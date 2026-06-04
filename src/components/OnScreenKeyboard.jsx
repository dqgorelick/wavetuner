import { useEffect, useMemo, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';
import tuning from '../audio/Tuning';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { OFFSET_TO_LETTER } from '../hooks/useComputerKeyboard';
import palette from '../theme/palette';

// Which semitone offsets within a kbdRoot-anchored octave read as black
// keys. Used purely for visual styling — every key is now an equal-width
// column, but blacks are drawn shorter + darker so the piano stripe
// pattern still reads.
const BLACK_OFFSET_SET = new Set([1, 3, 6, 8, 10]);

// Default v1 mapping until the picker (phase 6) lands: chromatic + fill.
// Every key fires; degree = (midi - root) mod N, octave = floor of same.
function midiToDegreeOctave(midi) {
  return tuning.degreeAndOctaveForMidi(midi);
}

/**
 * On-screen piano keyboard. Two octaves wide, starting at the supplied
 * kbdRoot (the MIDI note the lowest computer-key letter triggers — e.g.
 * 60 = C4 by default).
 *
 * Each key shows a small color dot reflecting which drone slot supplies
 * its current scale degree. Keys glow while a voice is sounding; glow
 * opacity is driven directly from the voice's gain-node value via a
 * per-frame DOM update (no React state on the hot path — same pattern
 * the existing oscilloscope uses).
 */
export default function OnScreenKeyboard({ kbdRoot = 60, octaveCount = 2, showKeyLabels = false, keyMode = 'chromatic' }) {
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
  //
  // Zoom levels:
  //   octaveCount=1 (min): show kbdRoot up through the E one octave
  //     above (offset +16) — that's the letter octave plus a 5-key
  //     "peek" of the next octave. Letter row sits at the bottom edge.
  //   octaveCount>=2: letter octave is centered, with (octaveCount-1)
  //     full octaves of context split evenly above and below. At zoom
  //     2 that's ½ octave on each side, at zoom 3 a full octave each
  //     side, zoom 4 = 1½ octaves each side, etc.
  //
  // White/black pattern is anchored at `kbdRoot` (the QWERTY 'A' key)
  // rather than at the visible-range start: 'A' is always drawn as a
  // visual C-key, regardless of the actual pitch class the scale maps
  // it to. The frequencies the keys produce still come from the
  // tuning/scale module — only the standard piano *appearance* is
  // pinned to the kbdRoot anchor.
  const VISIBLE_TOP_OFFSET_ZOOM_1 = 17;  // exclusive — high E peek above kbdRoot
  const letterStartMidi = kbdRoot;
  const sidePad = octaveCount <= 1 ? 0 : (octaveCount - 1) * 6;
  let startMidi = octaveCount <= 1 ? kbdRoot : kbdRoot - sidePad;
  let endMidi = octaveCount <= 1
    ? kbdRoot + VISIBLE_TOP_OFFSET_ZOOM_1
    : kbdRoot + 12 + sidePad;
  // Never leave a black note hanging at either edge. At octaveCount=2
  // the natural start lands on F# (-6 = black); even-numbered higher
  // zooms repeat the problem. Mirror on the right for safety, though
  // 11+sidePad currently always lands on a white. Extending by one
  // semitone is enough since blacks never sit adjacent.
  if (octaveCount > 1) {
    const startOff = ((startMidi - kbdRoot) % 12 + 12) % 12;
    if (BLACK_OFFSET_SET.has(startOff)) startMidi -= 1;
    const lastOff = ((endMidi - 1 - kbdRoot) % 12 + 12) % 12;
    if (BLACK_OFFSET_SET.has(lastOff)) endMidi += 1;
  }

  const { keys, totalKeys, totalWhites } = useMemo(() => {
    const visibleStart = startMidi;
    const visibleEnd = endMidi;
    // Every visible semitone gets its own equal-width column. The
    // chromatic index is just the offset from visibleStart, so all dots
    // above the keys end up evenly spaced. White vs black is a styling
    // tag anchored to kbdRoot (so the QWERTY 'A' key always appears as
    // a visual C, regardless of which pitch the scale maps it to).
    //
    // For each white key we also record whether the adjacent semitones
    // (above and below) are visible blacks. Those flags drive the
    // piano-shaped "T" each white renders as: the bottom strip extends
    // half a column into every adjacent black so adjacent whites read
    // as a single continuous surface beneath the blacks.
    //
    // For the white-only DIATONIC layout (used when keyMode==='white-only'),
    // we also track each key's running whiteIndex — the count of whites
    // seen so far. Whites get equal-width columns based on totalWhites;
    // blacks are overlaid on top, centered at the SEAM between the two
    // adjacent whites (i.e. at the whiteIndex of the next white).
    const keys = [];
    let whiteCounter = 0;
    for (let midi = visibleStart; midi < visibleEnd; midi++) {
      const off = ((midi - kbdRoot) % 12 + 12) % 12;
      const isBlack = BLACK_OFFSET_SET.has(off);
      // For each visible side:
      //   ext{Left,Right}      — adjacent IS a visible black → widen
      //                          the bottom strip by 0.5 col into it.
      //   topSeam{Left,Right}  — adjacent IS a visible white (E/F,
      //                          B/C boundary) → shrink the own-column
      //                          edge by 0.5px so the seam line runs
      //                          all the way through, matching the
      //                          bottom strip's gap.
      // The two flags are mutually exclusive: a side is either black,
      // white, or off-screen.
      let extLeft = false;
      let extRight = false;
      let topSeamLeft = false;
      let topSeamRight = false;
      if (!isBlack) {
        const leftMidi = midi - 1;
        const rightMidi = midi + 1;
        if (leftMidi >= visibleStart) {
          const leftOff = ((leftMidi - kbdRoot) % 12 + 12) % 12;
          const leftIsBlack = BLACK_OFFSET_SET.has(leftOff);
          extLeft = leftIsBlack;
          topSeamLeft = !leftIsBlack;
        }
        if (rightMidi < visibleEnd) {
          const rightOff = ((rightMidi - kbdRoot) % 12 + 12) % 12;
          const rightIsBlack = BLACK_OFFSET_SET.has(rightOff);
          extRight = rightIsBlack;
          topSeamRight = !rightIsBlack;
        }
      }
      keys.push({
        midi,
        chromaticIndex: midi - visibleStart,
        isBlack,
        extLeft,
        extRight,
        topSeamLeft,
        topSeamRight,
        // For diatonic mode: whites get their own index 0..totalWhites-1;
        // blacks get the index of the NEXT white (so the black's center
        // sits at that white's left edge, straddling both adjacent whites).
        whiteIndex: whiteCounter,
      });
      if (!isBlack) whiteCounter++;
    }
    return { keys, totalKeys: keys.length, totalWhites: whiteCounter };
  }, [startMidi, endMidi, kbdRoot]);

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
      for (const k of keys) updateOne(k.midi);
    };
    refresh();
    const unsubTune = tuning.onChange(refresh);
    const unsubPalette = palette.onChange(refresh);
    return () => { unsubTune(); unsubPalette(); };
  }, [keys]);

  // Per-frame glow update from the voice manager. Direct DOM mutation —
  // a setState in rAF would re-render React 60×/s for envelope curves.
  // Also tracks any voices whose midi falls OUTSIDE the visible range
  // and surfaces them on the off-screen arrow indicators (left for
  // notes below startMidi, right for notes at or above the upper edge).
  useEffect(() => {
    const visibleStart = startMidi;
    const visibleEnd = endMidi; // exclusive — matches the layout loop
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
  }, [startMidi, endMidi]);

  // Pointer handlers — pointerdown on a key triggers noteOn; pointerup
  // freezes (when kbd hold is on) or releases (when off). Dragging from
  // one key to another performs legato (releases the previous, triggers
  // the next).
  //
  // Mouse/touch input uses the same source: 'kbd' as the computer
  // keyboard, so it gets the long expressive ramp, the AR envelope,
  // and the freeze-on-release-or-tap-to-toggle-off semantics. The
  // velocity arg is ignored for kbd voices (peak is always 1.0; the
  // player dials it down by how long they hold).
  const releasePrev = (prev) => {
    // Drag-off semantics: leaving a key during a drag releases it even
    // when hold is on. Otherwise dragging across keys with hold-on
    // would accumulate latched voices and bury the glissando feel
    // under a chord stack. The voice's release ramp captures wherever
    // the attack got to, so a quick brush yields a quick taper.
    if (prev === undefined) return;
    keyboardVoiceManager.releaseNote(prev, 'kbd');
  };
  const handlePointerDown = (e, midi) => {
    if (!audioEngine.isInitialized) return;
    e.preventDefault();
    const id = e.pointerId;
    const prev = pointerHeld.current.get(id);
    if (prev !== undefined && prev !== midi) releasePrev(prev);
    pointerHeld.current.set(id, midi);
    keyboardVoiceManager.noteOn(midi, 1, { source: 'kbd' });
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
    releasePrev(prev);
    pointerHeld.current.set(id, midi);
    keyboardVoiceManager.noteOn(midi, 1, { source: 'kbd' });
  };
  const handlePointerUp = (e) => {
    const id = e.pointerId;
    const midi = pointerHeld.current.get(id);
    if (midi !== undefined) {
      // Tap release follows keyup rules: freeze at the reached level if
      // kbd hold is on, otherwise normal release.
      if (keyboardVoiceManager.getHold('kbd')) {
        keyboardVoiceManager.freezeNote(midi, 'kbd');
      } else {
        keyboardVoiceManager.noteOff(midi, { source: 'kbd' });
      }
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
        className={`osk${keyMode === 'white-only' ? ' osk-diatonic' : ''}`}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{ '--key-count': totalKeys, '--white-count': totalWhites }}
      >
      {keys.map((k) => {
        // Optional QWERTY-key letter overlay (toggled in Settings). Off
        // by default so the keyboard stays uncluttered for play; the CSS
        // tones it down so it sits quietly under the active glow when on.
        const letter = showKeyLabels
          ? OFFSET_TO_LETTER[k.midi - letterStartMidi]
          : null;

        // Two layouts:
        //   chromatic mode — every semitone is an equal-width column;
        //     whites use a clip-path to widen their bottom strip into
        //     adjacent black columns, producing the piano "T" shape.
        //   white-only mode — whites are equal-width per WHITE-key
        //     count (7 per octave). Blacks are overlaid on top,
        //     narrower (≈60% of a white), centered at the seam between
        //     the two whites they sit between. Whites are simple
        //     rectangles — no clip-path needed since blacks already
        //     cover the top portion where they overlap.
        let keyStyle;
        let shapeStyle = null;
        if (keyMode === 'white-only') {
          if (k.isBlack) {
            // whiteIndex marks the next white's index; the black sits
            // centered at that white's left edge.
            keyStyle = {
              left: `calc(${k.whiteIndex} * (100% / var(--white-count)) - 30% / var(--white-count))`,
              width: `calc(60% / var(--white-count))`,
            };
          } else {
            keyStyle = {
              left: `calc(${k.whiteIndex} * (100% / var(--white-count)))`,
              width: `calc(100% / var(--white-count))`,
              '--own-center': '50%',
            };
          }
        } else if (k.isBlack) {
          // chromatic, black: one chromatic column wide at top 62%.
          keyStyle = {
            left: `calc(${k.chromaticIndex} * (100% / var(--key-count)))`,
          };
        } else {
          // chromatic, white: widen into adjacent visible blacks via
          // clip-path so the bottom strip reads as continuous piano
          // surface. The 0.5px shrinkage on each bottom corner leaves
          // a 1px gap with the next white's clip-path, which the dark
          // tray bg shows through as a seam line.
          const leftExt = k.extLeft ? 0.5 : 0;
          const rightExt = k.extRight ? 0.5 : 0;
          const widthCols = 1 + leftExt + rightExt;
          const leftCols = k.chromaticIndex - leftExt;
          const ownStartPct = (leftExt / widthCols) * 100;
          const ownEndPct = ((leftExt + 1) / widthCols) * 100;
          const ownCenterPct = (ownStartPct + ownEndPct) / 2;
          const ownStartStr = k.topSeamLeft
            ? `calc(${ownStartPct.toFixed(4)}% + 0.5px)`
            : `${ownStartPct.toFixed(4)}%`;
          const ownEndStr = k.topSeamRight
            ? `calc(${ownEndPct.toFixed(4)}% - 0.5px)`
            : `${ownEndPct.toFixed(4)}%`;
          keyStyle = {
            left: `calc(${leftCols} * (100% / var(--key-count)))`,
            width: `calc(${widthCols} * (100% / var(--key-count)))`,
            '--own-center': `${ownCenterPct.toFixed(4)}%`,
          };
          shapeStyle = {
            clipPath: `polygon(${ownStartStr} 0%, ${ownEndStr} 0%, ${ownEndStr} 62%, calc(100% - 0.5px) 62%, calc(100% - 0.5px) 100%, calc(0% + 0.5px) 100%, calc(0% + 0.5px) 62%, ${ownStartStr} 62%)`,
          };
        }

        return (
          <div
            key={k.midi}
            ref={setKeyRef(k.midi)}
            className={`osk-key ${k.isBlack ? 'osk-black' : 'osk-white'}`}
            style={keyStyle}
            onPointerDown={(e) => handlePointerDown(e, k.midi)}
            onPointerEnter={(e) => handlePointerEnter(e, k.midi)}
          >
            <div className="osk-key-shape" style={shapeStyle} />
            {letter && <span className="key-letter">{letter}</span>}
            <span className="key-dot" />
          </div>
        );
      })}
      </div>
    </>
  );
}
