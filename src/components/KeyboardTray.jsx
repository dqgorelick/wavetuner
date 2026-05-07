import { useState } from 'react';
import OnScreenKeyboard from './OnScreenKeyboard';
import useComputerKeyboard from '../hooks/useComputerKeyboard';

/**
 * Keyboard tray that rolls up from the bottom of the viewport. When open,
 * the wrapper gets a `kbd-tray-open` class so the existing bottom-anchored
 * elements (freq spectrum bar, oscillator controls) shift up by the
 * tray's height — see App.css.
 *
 * Layout:
 *   [octave shift / labels] │ [arrows + dots row + keys] │ [mapping picker]
 *
 * The on/off and hide buttons that used to live on the right side of
 * the tray are now in the OscillatorControls strip above (the bottom-
 * row "keyboard" play/stop button gates input + audio; the readout-row
 * "more / less" button hides/shows this tray).
 */
export default function KeyboardTray({
  isOpen,
  kbdKeyMode,
  onKbdKeyModeChange,
  kbdFillMode,
  onKbdFillModeChange,
}) {
  // keyboardOctave=4 means the lowest visible key is C4 (MIDI 60),
  // following the standard MIDI = (octave + 1) * 12 convention. Same
  // formula in the on-screen keyboard and the computer-key hook.
  const [keyboardOctave, setKeyboardOctave] = useState(4);
  // Purely visual: when on, overlays Ableton-style letter labels on each
  // key and surfaces Z/X markers next to the octave arrows.
  const [labelsOn, setLabelsOn] = useState(false);

  // Always-on listener; the audio engine's keyboard-enabled flag (set
  // by the bottom-row keyboard play/stop button) gates voice spawning
  // inside KeyboardVoiceManager.noteOn, so we don't need a separate
  // gate here.
  useComputerKeyboard({
    enabled: true,
    keyboardOctave,
    setKeyboardOctave,
  });

  if (!isOpen) {
    // Tray hidden — the open affordance lives in OscillatorControls
    // (the more / less button). The hook still mounts so the
    // computer-keyboard listener stays active even when the tray is
    // collapsed (input is gated by the engine, not by the tray).
    return null;
  }

  return (
    <div className="kbd-tray" role="region" aria-label="Keyboard">
      <div className="kbd-tray-left">
        <div className="kbd-tray-octave-row">
          <button
            type="button"
            className="kbd-octave-btn"
            onClick={() => setKeyboardOctave((o) => Math.max(0, o - 1))}
            aria-label="Octave down"
            title={labelsOn ? 'Octave down (Z)' : 'Octave down'}
          >
            {labelsOn ? '◀Z' : '◀'}
          </button>
          <span className="kbd-octave-label">oct {keyboardOctave}</span>
          <button
            type="button"
            className="kbd-octave-btn"
            onClick={() => setKeyboardOctave((o) => Math.min(8, o + 1))}
            aria-label="Octave up"
            title={labelsOn ? 'Octave up (X)' : 'Octave up'}
          >
            {labelsOn ? 'X▶' : '▶'}
          </button>
        </div>
        <button
          type="button"
          className={`kbd-labels-toggle ${labelsOn ? 'on' : 'off'}`}
          onClick={() => setLabelsOn((v) => !v)}
          aria-pressed={labelsOn}
          title="Show computer-keyboard letters on each key"
        >
          ⌨ labels
        </button>
      </div>
      <div className="kbd-tray-keys">
        <OnScreenKeyboard
          keyboardOctave={keyboardOctave}
          octaveCount={4}
          labelsOn={labelsOn}
        />
      </div>
      <div className="kbd-tray-right">
        <div className="kbd-tray-mapping-row">
          <span className="kbd-tray-mapping-label">keys:</span>
          <button
            type="button"
            className={`kbd-tray-mapping-btn ${kbdKeyMode === 'chromatic' ? 'on' : 'off'}`}
            onClick={() => onKbdKeyModeChange('chromatic')}
            aria-pressed={kbdKeyMode === 'chromatic'}
          >
            all
          </button>
          <button
            type="button"
            className={`kbd-tray-mapping-btn ${kbdKeyMode === 'white-only' ? 'on' : 'off'}`}
            onClick={() => onKbdKeyModeChange('white-only')}
            aria-pressed={kbdKeyMode === 'white-only'}
          >
            white
          </button>
        </div>
        <div className="kbd-tray-mapping-row">
          <span className="kbd-tray-mapping-label">octaves:</span>
          <button
            type="button"
            className={`kbd-tray-mapping-btn ${kbdFillMode === 'jump' ? 'on' : 'off'}`}
            onClick={() => onKbdFillModeChange('jump')}
            aria-pressed={kbdFillMode === 'jump'}
          >
            jump
          </button>
          <button
            type="button"
            className={`kbd-tray-mapping-btn ${kbdFillMode === 'fill' ? 'on' : 'off'}`}
            onClick={() => onKbdFillModeChange('fill')}
            aria-pressed={kbdFillMode === 'fill'}
          >
            fill
          </button>
        </div>
      </div>
    </div>
  );
}
