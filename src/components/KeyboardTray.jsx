import { useEffect, useState } from 'react';
import OnScreenKeyboard from './OnScreenKeyboard';
import useComputerKeyboard from '../hooks/useComputerKeyboard';
import tuning from '../audio/Tuning';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiToNoteName(midi) {
  const oct = Math.floor(midi / 12) - 1;
  const idx = ((midi % 12) + 12) % 12;
  return `${NOTE_NAMES[idx]}${oct}`;
}

function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function formatHz(f) {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k`;
  return f.toFixed(0);
}

// Mirrors the visible-MIDI range in OnScreenKeyboard so the range readout
// matches exactly what the player sees on-screen. Inclusive of low MIDI,
// exclusive of high (matches the keyboard's [start, end) loop).
function visibleMidiRange(kbdRoot, octaveCount) {
  const VISIBLE_TOP_OFFSET_ZOOM_1 = 17;
  const sidePad = octaveCount <= 1 ? 0 : (octaveCount - 1) * 6;
  const startMidi = octaveCount <= 1 ? kbdRoot : kbdRoot - sidePad;
  const endMidi = octaveCount <= 1
    ? kbdRoot + VISIBLE_TOP_OFFSET_ZOOM_1
    : kbdRoot + 12 + sidePad;
  return { startMidi, endMidi };
}

// Log-scale 20Hz–20kHz reference window for positioning the keyboard's
// visible span inside the mini range bar.
const RANGE_BAR_HZ_MIN = 20;
const RANGE_BAR_HZ_MAX = 20000;
const RANGE_BAR_LOG_MIN = Math.log2(RANGE_BAR_HZ_MIN);
const RANGE_BAR_LOG_MAX = Math.log2(RANGE_BAR_HZ_MAX);
function logFracHz(f) {
  const clamped = Math.max(RANGE_BAR_HZ_MIN, Math.min(RANGE_BAR_HZ_MAX, f));
  return (Math.log2(clamped) - RANGE_BAR_LOG_MIN) / (RANGE_BAR_LOG_MAX - RANGE_BAR_LOG_MIN);
}

// Round a frequency to its nearest equal-temperament MIDI note. Used to
// snap the keyboard's root to the current lowest drone — we want a
// playable MIDI integer, not the drone's microtonal frequency itself
// (the drones retain their exact freq via the tuning module's pitch
// resolution; this is just where the keyboard's letter row starts).
function freqToMidi(freq) {
  if (!Number.isFinite(freq) || freq <= 0) return null;
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

// Snap a candidate kbdRoot into the same range the Z/X buttons clamp to,
// so initial alignment and user transposition share the same envelope.
function clampRoot(midi) {
  return Math.max(12, Math.min(108, midi | 0));
}

// The lowest drone often sits at 50–130 Hz (≈ MIDI 31–48), which makes
// the QWERTY letter row play sub-bass notes. Bump up by octaves until
// the root lands at or above C3 (MIDI 48) so the keyboard is in a
// playable range while staying in the same pitch class as the bass
// drone.
const PLAYABLE_FLOOR_MIDI = 48;
function snapToPlayableRoot(midi) {
  let r = midi;
  while (r < PLAYABLE_FLOOR_MIDI && r <= 96) r += 12;
  return clampRoot(r);
}

// Snap to the nearest C MIDI (any octave). Used by white-only mode so
// the QWERTY layout's chromatic offsets [0, 2, 4, 5, 7, 9, 11] line up
// with actual piano white keys — only true when kbdRoot is itself a C.
// Picks whichever C is closer; ties round up. The result is also passed
// through snapToPlayableRoot so the playable-floor invariant holds.
function snapToNearestC(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const candidateDown = midi - pc;
  const candidateUp = candidateDown + 12;
  const snapped = (midi - candidateDown) <= (candidateUp - midi)
    ? candidateDown
    : candidateUp;
  return snapToPlayableRoot(snapped);
}

/**
 * Keyboard tray that rolls up from the bottom of the viewport. When open,
 * the wrapper gets a `kbd-tray-open` class so the existing bottom-anchored
 * elements (freq spectrum bar, oscillator controls) shift up by the
 * tray's height — see App.css.
 *
 * Layout:
 *   [kbd hold · voices · root] │ [keys] │ [midi hold]
 *
 * Each rail's hold button drives a different source in the voice
 * manager: the left rail controls the computer keyboard (expressive
 * mode, hold-on by default), the right rail controls MIDI input
 * (press-and-hold, off by default).
 *
 * Z/X transpose the keyboard's lowest-letter MIDI note (`kbdRoot`) by
 * `oscillatorCount` semitones — one "scale octave" worth in the current
 * tuning. Stored as a MIDI number rather than an octave index so the
 * step size can vary with the drone count without losing the player's
 * current position when N changes.
 */
export default function KeyboardTray({
  isOpen,
  kbdHoldOn,
  onKbdHoldToggle,
  midiHoldOn,
  onMidiHoldToggle,
  kbdVoiceCount,
  onKbdVoiceCountChange,
  oscillatorCount = 12,
  showKeyLabels = false,
  // The 'notes' toggle mirrors kbdKeyMode owned by App: 'white-only' =
  // 7 (diatonic), 'chromatic' = 12. Same state shown here and in
  // SettingsPanel → Keys; either surface flips the same flag.
  kbdKeyMode = 'chromatic',
  onKbdKeyModeChange,
}) {
  // MIDI note that letter offset 0 ('A') triggers. Seeded from the
  // current lowest drone if tuning has spun up (typical after audio
  // init); falls back to C4 (60) for first paint before the engine is
  // ready. Clamped to a range that keeps every offset (0..15) within
  // valid MIDI.
  // The visual root is always snapped to the nearest C (in both
  // chromatic and white-only modes). kbdRoot only controls the
  // ON-SCREEN keyboard's visual layout — audio mapping is anchored to
  // the SORTED drone list (letter A always plays sorted[0], regardless
  // of kbdRoot). Anchoring to C means the on-screen keys read as a
  // familiar C-major piano stripe whether the bass drone is at C, Ab,
  // or anywhere else, and the white-only key filter (which requires
  // kbdRoot to be a C to correctly silence piano blacks) always works.
  const [kbdRoot, setKbdRoot] = useState(() => {
    const lowest = tuning.sortedFrequencies[0];
    const midi = freqToMidi(lowest);
    if (midi == null) return 60;
    return snapToNearestC(midi);
  });
  // Number of visible piano octaves. Default 1 — the letter row plus a
  // five-key "peek" up to the E above (offset +16). Each step above 1
  // adds one full octave of context BELOW the letter row.
  const [keyboardZoom, setKeyboardZoom] = useState(1);
  const clampZoom = (n) => Math.max(1, Math.min(6, n | 0));
  // Z/X transpose step. In white-only mode we force the step to 12
  // (one chromatic octave) so kbdRoot stays anchored to a C — the
  // QWERTY layout's offsets [0, 2, 4, 5, 7, 9, 11] only hit real piano
  // whites when the root is itself a C. Stepping by anything else
  // (e.g. the scale size 7) would slide kbdRoot off a C and the
  // "7 keys = white keys" invariant would break.
  const stepSize = kbdKeyMode === 'white-only'
    ? 12
    : Math.max(1, oscillatorCount | 0);
  const shiftRoot = (delta) =>
    setKbdRoot((r) => clampRoot(r + delta));

  // Keep the keyboard's visual root aligned with the nearest C to the
  // lowest drone's pitch. Fires once on mount and on every tuning
  // change (drone count, scale, ordering). User Z/X transposition is
  // intentionally overwritten here — the alignment wins on every scale
  // event so a drone change re-centers the visual on a familiar C.
  useEffect(() => {
    const align = () => {
      const lowest = tuning.sortedFrequencies[0];
      const midi = freqToMidi(lowest);
      if (midi == null) return;
      setKbdRoot(snapToNearestC(midi));
    };
    align();
    return tuning.onChange(align);
  }, []);

  // Always-on listener; the audio engine's keyboard-enabled flag (set
  // by the MIDI on/off button on the tray's right rail) gates voice
  // spawning inside KeyboardVoiceManager.noteOn, so we don't need a
  // separate gate here.
  useComputerKeyboard({
    enabled: true,
    kbdRoot,
    setKbdRoot,
    stepSize,
  });

  const clampVoices = (n) => Math.max(1, Math.min(8, n | 0));

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
        {(() => {
          const { startMidi, endMidi } = visibleMidiRange(kbdRoot, keyboardZoom);
          const lowHz = midiToHz(startMidi);
          const highHz = midiToHz(endMidi - 1);
          const leftPct = logFracHz(lowHz) * 100;
          const rightPct = logFracHz(highHz) * 100;
          const widthPct = Math.max(1, rightPct - leftPct);
          return (
            <div
              className="kbd-range-row"
              title={`Keyboard range: ${lowHz.toFixed(1)} Hz – ${highHz.toFixed(1)} Hz`}
            >
              <span className="kbd-range-text">
                {formatHz(lowHz)}hz <span className="kbd-range-sep">↔</span> {formatHz(highHz)}hz
              </span>
              <div className="kbd-range-bar" aria-hidden="true">
                <div
                  className="kbd-range-bar-fill"
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })()}
        <div className="kbd-tray-octave-row" title={`Current root: ${midiToNoteName(kbdRoot)}`}>
          <span className="kbd-hold-caption">range</span>
          <div className="kbd-row-controls">
            <button
              type="button"
              className="kbd-octave-btn kbd-octave-shift"
              onClick={() => shiftRoot(-stepSize)}
              aria-label="Transpose down"
              title={`Transpose down ${stepSize} semitones (Z)`}
            >
              <span className="kbd-octave-arrow">↓</span>
              {showKeyLabels && <span className="kbd-octave-key">Z</span>}
            </button>
            <button
              type="button"
              className="kbd-octave-btn kbd-octave-shift"
              onClick={() => shiftRoot(stepSize)}
              aria-label="Transpose up"
              title={`Transpose up ${stepSize} semitones (X)`}
            >
              <span className="kbd-octave-arrow">↑</span>
              {showKeyLabels && <span className="kbd-octave-key">X</span>}
            </button>
          </div>
        </div>
        <div className="kbd-hold-row">
          <span className="kbd-hold-caption">zoom</span>
          <div className="kbd-row-controls">
            <button
              type="button"
              className="kbd-octave-btn"
              onClick={() => setKeyboardZoom((z) => clampZoom(z + 1))}
              aria-label="Zoom out — show more octaves"
              title={`Zoom out (more octaves visible) — currently ${keyboardZoom}`}
              disabled={keyboardZoom >= 6}
            >
              −
            </button>
            <button
              type="button"
              className="kbd-octave-btn"
              onClick={() => setKeyboardZoom((z) => clampZoom(z - 1))}
              aria-label="Zoom in — show fewer octaves"
              title={`Zoom in (fewer octaves visible) — currently ${keyboardZoom}`}
              disabled={keyboardZoom <= 1}
            >
              +
            </button>
          </div>
        </div>
        {/* Notes — 7 (diatonic / white keys only) vs 12 (chromatic / all
            keys). Mirrors kbdKeyMode in App; toggling here is instant
            (keyboard playback changes immediately). Load also writes
            this state to match its system's recommended size. */}
        <div className="kbd-hold-row">
          <span className="kbd-hold-caption">notes</span>
          <div className="kbd-row-controls">
            <button
              type="button"
              className={`kbd-octave-btn${kbdKeyMode === 'white-only' ? ' is-active' : ''}`}
              onClick={() => onKbdKeyModeChange?.('white-only')}
              aria-pressed={kbdKeyMode === 'white-only'}
              title="Diatonic — only white keys play (7 notes per octave)"
            >
              7
            </button>
            <button
              type="button"
              className={`kbd-octave-btn${kbdKeyMode === 'chromatic' ? ' is-active' : ''}`}
              onClick={() => onKbdKeyModeChange?.('chromatic')}
              aria-pressed={kbdKeyMode === 'chromatic'}
              title="Chromatic — every key plays (12 notes per octave)"
            >
              12
            </button>
          </div>
        </div>
      </div>
      <div className="kbd-tray-keys">
        <OnScreenKeyboard
          kbdRoot={kbdRoot}
          octaveCount={keyboardZoom}
          showKeyLabels={showKeyLabels}
        />
      </div>
      <div className="kbd-tray-right">
        <div className="kbd-hold-row">
          <span className="kbd-hold-caption">voice count</span>
          <div className="kbd-voice-pill">
            <button
              type="button"
              className="kbd-voice-btn"
              onClick={() => onKbdVoiceCountChange?.(clampVoices((kbdVoiceCount ?? 2) - 1))}
              aria-label="Fewer voices"
              title="Fewer keyboard voices"
              disabled={(kbdVoiceCount ?? 2) <= 1}
            >
              −
            </button>
            <span className="kbd-voice-num" aria-live="polite">
              {kbdVoiceCount ?? 2}
            </span>
            <button
              type="button"
              className="kbd-voice-btn"
              onClick={() => onKbdVoiceCountChange?.(clampVoices((kbdVoiceCount ?? 2) + 1))}
              aria-label="More voices"
              title="More keyboard voices"
              disabled={(kbdVoiceCount ?? 2) >= 8}
            >
              +
            </button>
          </div>
        </div>
        <div className="kbd-hold-row">
          <span className="kbd-hold-caption">hold</span>
          <div className="kbd-row-controls">
            <button
              type="button"
              className={`kbd-hold-btn ${kbdHoldOn ? 'on' : 'off'}`}
              onClick={onKbdHoldToggle}
              aria-pressed={!!kbdHoldOn}
              title="Computer-keyboard hold — release a key during its ramp to freeze that level"
            >
              {kbdHoldOn ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
        <div className="kbd-hold-row">
          <span className="kbd-hold-caption">midi hold</span>
          <div className="kbd-row-controls">
            <button
              type="button"
              className={`kbd-hold-btn ${midiHoldOn ? 'on' : 'off'}`}
              onClick={onMidiHoldToggle}
              aria-pressed={!!midiHoldOn}
              title="MIDI hold — latch played notes until re-pressed"
            >
              {midiHoldOn ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
