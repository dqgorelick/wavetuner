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
 *   [oct row · hold] │ [keys] │ [MIDI label / on-off]
 */
export default function KeyboardTray({
  isOpen,
  kbdHoldOn,
  onKbdHoldToggle,
}) {
  // keyboardOctave=4 means the lowest computer-key (Q/A row) plays
  // C4 (MIDI 60), following the standard MIDI = (octave + 1) * 12
  // convention. The on-screen keyboard renders an extra octave BELOW
  // that range so the user can click an octave lower with the mouse
  // — see OnScreenKeyboard for the visual-start offset.
  const [keyboardOctave, setKeyboardOctave] = useState(4);

  // Always-on listener; the audio engine's keyboard-enabled flag (set
  // by the MIDI on/off button on the tray's right rail) gates voice
  // spawning inside KeyboardVoiceManager.noteOn, so we don't need a
  // separate gate here.
  useComputerKeyboard({
    enabled: true,
    keyboardOctave,
    setKeyboardOctave,
  });

  // Always render so the slide-in/out animation has a stable element
  // to transition. The `open` class drives `translateY(0)`; when
  // closed the strip is parked under the viewport edge via the base
  // .kbd-tray rule. aria-hidden gates assistive tech.
  return (
    <div
      className={`kbd-tray${isOpen ? ' open' : ''}`}
      role="region"
      aria-label="Keyboard"
      aria-hidden={!isOpen}>
      <div className="kbd-tray-left">
        <div className="kbd-tray-octave-row">
          <span className="kbd-octave-label">oct {keyboardOctave}</span>
          <button
            type="button"
            className="kbd-octave-btn kbd-octave-shift"
            onClick={() => setKeyboardOctave((o) => Math.max(0, o - 1))}
            aria-label="Octave down"
            title="Octave down (Z)"
          >
            <span className="kbd-octave-arrow">↓</span>
            <span className="kbd-octave-key">Z</span>
          </button>
          <button
            type="button"
            className="kbd-octave-btn kbd-octave-shift"
            onClick={() => setKeyboardOctave((o) => Math.min(8, o + 1))}
            aria-label="Octave up"
            title="Octave up (X)"
          >
            <span className="kbd-octave-arrow">↑</span>
            <span className="kbd-octave-key">X</span>
          </button>
        </div>
        <div className="kbd-hold-row">
          <span className="kbd-hold-caption">hold</span>
          <button
            type="button"
            className={`kbd-hold-btn ${kbdHoldOn ? 'on' : 'off'}`}
            onClick={onKbdHoldToggle}
            aria-pressed={!!kbdHoldOn}
            title="Hold notes — each key press toggles its note on/off"
          >
            {kbdHoldOn ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
      <div className="kbd-tray-keys">
        <OnScreenKeyboard
          keyboardOctave={keyboardOctave}
          octaveCount={4}
        />
      </div>
    </div>
  );
}
