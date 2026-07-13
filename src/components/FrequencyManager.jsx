import { useCallback, useEffect, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import {
  nearestRatio,
  extendOctaves,
  offsetToOpacity,
  EXACT_CENTS_TOLERANCE,
  TUNING_SYSTEMS,
  SUPPORTED_SYSTEMS,
  getSystem,
} from '../audio/jiRatios';
import palette, { useTheme } from '../theme/palette';
import { isEditableTarget } from '../hooks/keyboardUtils';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_TO_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Recall-glide slider mapping. The slider runs a normalized 0..1 position;
// a logarithmic curve maps it to 0..10 s so the low end (where small
// differences matter most) gets the bulk of the travel. The formula passes
// exactly through (0 → 0 s) and (1 → 10 s); a higher base skews more
// resolution toward short glides.
const GLIDE_MAX_S = 10;
const GLIDE_CURVE_BASE = 200;
const glidePosToSec = (pos) =>
  ((GLIDE_CURVE_BASE ** Math.max(0, Math.min(1, pos)) - 1) / (GLIDE_CURVE_BASE - 1)) * GLIDE_MAX_S;
const glideSecToPos = (sec) => {
  const clamped = Math.max(0, Math.min(GLIDE_MAX_S, sec));
  return Math.log((clamped / GLIDE_MAX_S) * (GLIDE_CURVE_BASE - 1) + 1) / Math.log(GLIDE_CURVE_BASE);
};
// Timing readout: milliseconds under 1 s, seconds (2 decimals) at/above 1 s.
const formatTiming = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

// Parameter-lock chips shown in the capture-scope panel. Held keyboard/MIDI
// notes are always tracked and have no chip — recalls just include the
// played chord.
const SCOPE_PARAMS = [
  { key: 'freq', label: 'freq', title: 'Frequency / pitch (and its markers on the spectrum)' },
  { key: 'vol', label: 'vol', title: 'Per-voice volume' },
  { key: 'onoff', label: 'on/off', title: 'Per-voice on/off (mute)' },
  { key: 'transpose', label: 'transpose', title: 'Global transpose (the master pitch offset) — recalls slide it over the glide timing' },
];

function freqToNote(freq) {
  if (!Number.isFinite(freq) || freq <= 0) return { note: '--', octave: 0, cents: 0, midi: 0 };
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midi = Math.round(69 + semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - (midi - 69)) * 100);
  const idx = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { note: NOTE_NAMES[idx], octave, cents, midi };
}

// Exact (unrounded) cents-off from the nearest 12-TET note. Used by
// commit handlers so a "preserve cents" round-trip through the note
// column doesn't accumulate rounding error.
function freqToMidiAndCents(freq) {
  if (!Number.isFinite(freq) || freq <= 0) return { midi: 0, centsExact: 0 };
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midi = Math.round(69 + semitonesFromA4);
  const centsExact = (semitonesFromA4 - (midi - 69)) * 100;
  return { midi, centsExact };
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Parse note names: "C4", "C#4", "Db3", "Bb-1", "b5" (lowercase ok).
// Returns MIDI number or null. Rejects MIDI < 0 or > 127.
function parseNoteName(input) {
  const s = (input || '').trim();
  if (!s) return null;
  const m = s.match(/^([A-Ga-g])([#b])?(-?\d+)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2];
  const octave = parseInt(m[3], 10);
  let pc = LETTER_TO_PC[letter];
  if (acc === '#') pc += 1;
  else if (acc === 'b') pc -= 1;
  const midi = 12 * (octave + 1) + pc;
  if (midi < 0 || midi > 127) return null;
  return midi;
}

// Parse a cents value like "12", "+12", "-30.5", "100c", "100¢".
// Returns the signed number or null. No range clamp here — the commit
// handler decides what to do with values outside ±50.
function parseCentsValue(input) {
  const s = (input || '').trim();
  if (!s) return null;
  const m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*(c|¢|cents?)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function formatCentsValue(cents) {
  if (!Number.isFinite(cents)) return '';
  if (cents === 0) return '0';
  return cents > 0 ? `+${cents}` : `${cents}`;
}

function formatHz(hz) {
  if (!Number.isFinite(hz)) return '';
  if (hz >= 1000) return hz.toFixed(1);
  if (hz >= 100) return hz.toFixed(2);
  return hz.toFixed(3);
}

// Parse "n/d", "n:d", or bare integer "n" → {n, d} | null. Decimals
// are rejected on purpose — the Hz column is for free-Hz entry, the
// Ratio column is for explicit small-integer ratios.
function parseRatio(input) {
  const s = (input || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*[/:]\s*(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (n > 0 && d > 0) return { n, d };
    return null;
  }
  const intMatch = s.match(/^(\d+)$/);
  if (intMatch) {
    const n = parseInt(intMatch[1], 10);
    if (n > 0) return { n, d: 1 };
  }
  return null;
}

function parseHz(input) {
  const s = (input || '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Controlled input that displays the canonical (formatted) value when
// unfocused, switches to a local edit buffer on focus, and commits on
// Enter/blur (Esc reverts). Tabbing through without edits does NOT
// commit — protects ratio locks from accidental focus/blur.
function CellInput({ value, onCommit, format, parse, className, title, disabled, style, frozen }) {
  const [buffer, setBuffer] = useState('');
  const [focused, setFocused] = useState(false);
  const [edited, setEdited] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const display = focused ? buffer : format(value);

  // While an orb is being dragged, the value updates every frame and the
  // user can't interact with the cell anyway. Render a plain <span> instead
  // of a controlled <input> — far cheaper to reconcile across N rows, and
  // it sidesteps React fighting the input's value/focus on each frame.
  if (frozen) {
    return (
      <span
        className={`freq-rail-input freq-rail-input-static${className ? ` ${className}` : ''}`}
        title={title}
        style={style}
      >
        {format(value)}
      </span>
    );
  }

  return (
    <input
      type="text"
      className={`freq-rail-input${invalid ? ' invalid' : ''}${className ? ` ${className}` : ''}`}
      value={display}
      title={title}
      disabled={disabled}
      style={style}
      onFocus={(e) => {
        setBuffer(format(value));
        setFocused(true);
        setEdited(false);
        setInvalid(false);
        requestAnimationFrame(() => {
          try { e.target.select(); } catch { /* ignore */ }
        });
      }}
      onChange={(e) => {
        setBuffer(e.target.value);
        setEdited(true);
        if (invalid) setInvalid(false);
      }}
      onBlur={() => {
        if (!focused) return;
        setFocused(false);
        if (!edited) return;
        const parsed = parse(buffer);
        if (parsed != null) {
          setInvalid(false);
          onCommit(parsed);
        } else if (buffer.trim() !== '') {
          setInvalid(true);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setBuffer(format(value));
          setEdited(false);
          setInvalid(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function FrequencyRow({ slot, oscillatorCount, frozen }) {
  const hz = audioEngine.initialized ? audioEngine.getFrequency(slot) : 0;
  const anchorHz = audioEngine.initialized
    ? audioEngine.getFrequency(frequencyManager.anchorSlot)
    : 0;
  const isAnchor = frequencyManager.isAnchor(slot);
  const lockedRatio = frequencyManager.getRatio(slot); // {n,d} or null
  const tuningSystem = frequencyManager.tuningSystem;
  const color = palette.oscColor(slot, oscillatorCount);

  // The displayed ratio is either the locked one (if present), or the
  // nearest candidate in the current tuning system. The anchor is
  // always exactly 1/1. `label` is what the Ratio column renders —
  // a fraction for rational systems, "100¢" for 12-TET, "n" for the
  // harmonic series.
  let ratioInfo = null;
  if (isAnchor) {
    ratioInfo = {
      n: 1, d: 1, label: '1/1',
      offsetCents: 0, halfGapPos: 50, halfGapNeg: 50,
      kind: 'ji',
    };
  } else if (anchorHz > 0 && hz > 0) {
    const nearest = nearestRatio(hz / anchorHz, tuningSystem);
    if (nearest) {
      // Rational systems extend the (n, d) into the appropriate octave
      // for display. TET candidates have no n/d — use the label as-is.
      let displayN = nearest.n;
      let displayD = nearest.d;
      let label = nearest.label;
      if (displayN != null && displayD != null) {
        const ext = extendOctaves(displayN, displayD, nearest.octave);
        displayN = ext.n;
        displayD = ext.d;
        label = displayD === 1 ? `${displayN}` : `${displayN}/${displayD}`;
      }
      ratioInfo = {
        n: displayN,
        d: displayD,
        label,
        offsetCents: nearest.offsetCents,
        halfGapPos: nearest.halfGapPos,
        halfGapNeg: nearest.halfGapNeg,
        kind: nearest.kind,
      };
    }
  }

  // Locked or anchor → full opacity + underline (drift detection would
  // have already cleared the lock if it didn't match). Otherwise the
  // nearest candidate, gap-based opacity, underline only when exact.
  let ratioOpacity = 1;
  let ratioExact = false;
  if (ratioInfo) {
    if (isAnchor || lockedRatio) {
      ratioExact = true;
    } else {
      ratioOpacity = offsetToOpacity(
        ratioInfo.offsetCents,
        ratioInfo.halfGapPos,
        ratioInfo.halfGapNeg,
      );
      ratioExact = Math.abs(ratioInfo.offsetCents) <= EXACT_CENTS_TOLERANCE;
    }
  }

  const note = freqToNote(hz);
  const noteLabel = `${note.note}${note.octave}`;
  const centsLabel = note.cents === 0
    ? '0¢'
    : `${note.cents > 0 ? '+' : ''}${note.cents}¢`;

  // Marker click toggles mute (mirrors the drone-tray squares). Root
  // reassignment moved to the root-rail radio in the left gutter.
  const isMuted = audioEngine.initialized
    ? !!(audioEngine.mutedStates && audioEngine.mutedStates[slot])
    : false;
  // The staged save would flip this slot's on/off state on GO ('on/off'
  // tracked). Same direction-aware grammar as the drone-tray cells:
  // off→on outlines (.unmute-pending), on→off dims (.mute-pending).
  // Re-renders arrive via useFreqVersion (manager events + the mute poll).
  const stagedMutes = frequencyManager.getStagedMutes();
  const willFlip = stagedMutes != null && slot < stagedMutes.length
    && !!stagedMutes[slot] !== isMuted;
  const pendingClass = !willFlip ? ''
    : isMuted ? ' unmute-pending' : ' mute-pending';
  const handleMarkerClick = useCallback(() => {
    if (audioEngine.initialized && audioEngine.toggleMute) {
      audioEngine.toggleMute(slot);
    }
  }, [slot]);

  // Root radio click — makes this slot the 1/1 reference. Re-uses the
  // FrequencyManager's existing anchor machinery; locked ratios that
  // no longer hold against the new anchor get cleared by the manager.
  const handleRootClick = useCallback(() => {
    frequencyManager.setAnchorSlot(slot);
  }, [slot]);

  // Octave transpose helpers — only rendered on the root row, where
  // they replace the candidate-step rocker. Routes through setRootHz
  // which scales every slot proportionally (locks honored).
  const handleOctave = useCallback((factor) => {
    if (!audioEngine.initialized) return;
    const cur = audioEngine.getFrequency(slot);
    if (!Number.isFinite(cur) || cur <= 0) return;
    frequencyManager.setRootHz(cur * factor);
  }, [slot]);

  const handleHzCommit = useCallback((hz) => {
    frequencyManager.setSlotHz(slot, hz);
  }, [slot]);

  const handleRatioCommit = useCallback(({ n, d }) => {
    frequencyManager.setSlotRatio(slot, n, d);
  }, [slot]);

  const handleStep = useCallback((direction) => {
    frequencyManager.stepSlotRatio(slot, direction);
  }, [slot]);

  // Note column commit: transpose this slot to the typed note, keeping
  // the current cents deviation so users typing a note name don't lose
  // a microtonal offset they set earlier. For the anchor row this routes
  // through setSlotHz → setRootHz, transposing every slot proportionally.
  const handleNoteCommit = useCallback((midi) => {
    if (!audioEngine.initialized) return;
    const cur = audioEngine.getFrequency(slot);
    if (!(cur > 0)) return;
    const { centsExact } = freqToMidiAndCents(cur);
    const newHz = midiToFreq(midi + centsExact / 100);
    frequencyManager.setSlotHz(slot, newHz);
  }, [slot]);

  // Cents column commit: keep the currently-displayed note, set the
  // deviation to the typed cents. Typing values outside ±50 are
  // accepted — they just re-render as a different note + smaller cents.
  const handleCentsCommit = useCallback((cents) => {
    if (!audioEngine.initialized) return;
    const cur = audioEngine.getFrequency(slot);
    if (!(cur > 0)) return;
    const { midi } = freqToMidiAndCents(cur);
    const newHz = midiToFreq(midi + cents / 100);
    frequencyManager.setSlotHz(slot, newHz);
  }, [slot]);

  return (
    <div className="freq-rail-row" style={{ '--osc-color': color }}>
      {/* Root radio — single-select across all rows, rendered as a node on
          a vertical rail in the left gutter (absolutely positioned, so it
          doesn't shift the mute markers). Full circle = this slot is the
          1/1; small dot otherwise. Click to reassign the root. */}
      <button
        type="button"
        className={`freq-rail-root-radio${isAnchor ? ' on' : ''}`}
        onClick={handleRootClick}
        title={isAnchor ? 'Root (1/1)' : `Set slot ${slot + 1} as root`}
        aria-pressed={isAnchor}
        aria-label={`Root selector for slot ${slot + 1}`}
      >
        <span className="freq-rail-root-radio-dot" aria-hidden="true" />
      </button>
      {/* Marker square — toggles mute. Filled (drone-tray "on" style)
          when this slot is audible, outlined when muted. */}
      <button
        type="button"
        className={`freq-rail-marker${!isMuted ? ' anchor' : ''}${pendingClass}`}
        style={{ '--cell-color': color }}
        onClick={handleMarkerClick}
        title={isMuted ? `Unmute slot ${slot + 1}` : `Mute slot ${slot + 1}`}
        aria-pressed={!isMuted}
      >
        {slot + 1}
      </button>
      <CellInput
        value={hz}
        format={formatHz}
        parse={parseHz}
        onCommit={handleHzCommit}
        className="freq-rail-hz"
        title="Frequency in Hz"
        frozen={frozen}
      />
      <CellInput
        value={ratioInfo}
        format={(r) => (r ? r.label : '')}
        parse={parseRatio}
        onCommit={handleRatioCommit}
        className={`freq-rail-ratio${ratioExact ? ' exact' : ''}${lockedRatio ? ' locked' : ''}`}
        style={{ opacity: ratioOpacity }}
        title={isAnchor
          ? 'Anchor is always 1/1'
          : lockedRatio
            ? 'Locked ratio'
            : ratioInfo && ratioInfo.kind === 'tet'
              ? 'Nearest 12-TET note — type a fraction to lock to JI'
              : ratioInfo && ratioInfo.kind === 'harmonic'
                ? 'Nearest harmonic — type a fraction to lock'
                : 'Nearest ratio (type to lock)'}
        disabled={isAnchor}
        frozen={frozen}
      />
      <CellInput
        value={note.midi}
        format={() => noteLabel}
        parse={parseNoteName}
        onCommit={handleNoteCommit}
        className="freq-rail-note-name"
        title={`Note (${noteLabel}) — type e.g. C4, F#3, Bb5`}
        frozen={frozen}
      />
      <CellInput
        value={note.cents}
        format={formatCentsValue}
        parse={parseCentsValue}
        onCommit={handleCentsCommit}
        className="freq-rail-note-cents"
        title={`Cents off ${noteLabel} (${centsLabel}) — type 0 to snap to ET`}
        frozen={frozen}
      />
      {/* Per-row pill in the last column. Two states:
            • Root row: /2 and ×2 — transpose every slot proportionally.
            • Non-root rows: ‹ › chevrons — step this slot through the
              active tuning system's candidates.
          Same .freq-rail-rocker pill styling either way so the column
          stays visually consistent. */}
      {isAnchor ? (
        <div className="freq-rail-rocker" role="group" aria-label="Octave transpose">
          <button
            type="button"
            className="freq-rail-rocker-btn freq-rail-rocker-btn-text"
            onClick={() => handleOctave(0.5)}
            title="Halve root — transpose every slot down an octave"
            aria-label="Down an octave"
          >/2</button>
          <button
            type="button"
            className="freq-rail-rocker-btn freq-rail-rocker-btn-text"
            onClick={() => handleOctave(2)}
            title="Double root — transpose every slot up an octave"
            aria-label="Up an octave"
          >×2</button>
        </div>
      ) : (
        <div className="freq-rail-rocker" role="group" aria-label={`Step slot ${slot + 1}`}>
          <button
            type="button"
            className="freq-rail-rocker-btn"
            onClick={() => handleStep(-1)}
            title="Step to previous candidate in the active tuning system"
            aria-label={`Previous candidate for slot ${slot + 1}`}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="freq-rail-rocker-btn"
            onClick={() => handleStep(1)}
            title="Step to next candidate in the active tuning system"
            aria-label={`Next candidate for slot ${slot + 1}`}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// Shared subscription hook — bumps a counter on every engine /
// manager event so child rows re-read engine state. Both the
// developer freq-rail and the tuning panel use this so they stay in
// lockstep with the underlying FrequencyManager singleton.
function useFreqVersion() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    // Coalesce bumps to one re-render per animation frame. setFrequency
    // fires the listener on every pointermove — up to ~120 Hz on
    // trackpads — but the panel only needs to repaint at display rate.
    // Without this, dragging an orb re-renders all N rows × their inputs
    // 120×/sec, which is the source of the visible UI lag.
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVersion((v) => v + 1);
      });
    };
    const unsubA = audioEngine.addFrequencyListener(bump);
    const unsubB = frequencyManager.onChange(bump);
    frequencyManager.ensureInitialSnapshot();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubA();
      unsubB();
    };
  }, []);
  // Mute changes don't fire the frequency listener (AudioEngine's
  // toggleMute mutates mutedStates directly). Poll the array via rAF
  // and bump version on any diff — mirrors what OscillatorControls
  // already does. ~60Hz on an N=12 array of booleans is negligible.
  useEffect(() => {
    let raf;
    let last = '';
    const tick = () => {
      if (audioEngine.initialized && audioEngine.mutedStates) {
        const sig = audioEngine.mutedStates.join('');
        if (sig !== last) { last = sig; setVersion((v) => v + 1); }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    frequencyManager.ensureInitialSnapshot();
  });
}

// Capture-scope panel (parameter lock). One shared parameter set ("Parameters
// tracked") governs both what a recall applies and what undo/redo tracks, then
// a separate glide timing for Capture and for Undo/Redo. Capture itself always
// stores everything; the scope is a live mask. See PARAMETER_LOCK.md.
function ScopePanel() {
  useFreqVersion();
  const scope = frequencyManager.getRecallScope();
  const recallGlideMs = frequencyManager.recallGlideMs;
  const stepOverlapMs = frequencyManager.stepOverlapMs;
  const undoGlideMs = frequencyManager.undoGlideMs;
  const transitionMode = frequencyManager.transitionMode;

  const timingRow = (label, glideMs, onSet, title = 'Glide/recall timing. 0 = instant snap.') => (
    <div className="scope-timing" title={title}>
      <span className="scope-timing-label">{label}</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={glideSecToPos(glideMs / 1000)}
        onChange={(e) => onSet(glidePosToSec(parseFloat(e.target.value)) * 1000)}
        className="freq-rail-glide-slider"
        style={{ '--glide-fill': `${glideSecToPos(glideMs / 1000) * 100}%` }}
        aria-label={`${label} timing milliseconds`}
      />
      <span className="freq-rail-glide-value">{formatTiming(glideMs)}</span>
    </div>
  );

  return (
    <div className="scope-panel">
      <div className="scope-sec">
        <span className="scope-title">Parameters tracked</span>
        <div className="scope-chips" role="group" aria-label="Parameters tracked">
          {SCOPE_PARAMS.map((p) => {
            const on = scope.includes(p.key);
            return (
              <button
                key={p.key}
                type="button"
                className={`scope-chip${on ? ' on' : ''}`}
                onClick={() => frequencyManager.toggleParam(p.key)}
                aria-pressed={on}
                title={p.title}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="scope-sec">
        <span className="scope-title">Parameter timing</span>
        <div className="scope-timing" title="How launched voices reach their target. Glide bends pitch; the step modes retrigger a fresh note that overlaps the old one. Shift-click a launch dot for the other mode.">
          <span className="scope-timing-label">transition</span>
          <div className="settings-toggle-row">
            <button
              type="button"
              className={`settings-toggle-btn ${transitionMode === 'glide' ? 'on' : 'off'}`}
              onClick={() => frequencyManager.setTransitionMode('glide')}
              aria-pressed={transitionMode === 'glide'}
              title="Pitch bends continuously to the target (portamento)"
            >
              glide
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${transitionMode === 'step' ? 'on' : 'off'}`}
              onClick={() => frequencyManager.setTransitionMode('step')}
              aria-pressed={transitionMode === 'step'}
              title="Retrigger a fresh note at the target (old note overlaps, then releases). GO only re-strikes voices whose pitch changes"
            >
              step
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${transitionMode === 'step-all' ? 'on' : 'off'}`}
              onClick={() => frequencyManager.setTransitionMode('step-all')}
              aria-pressed={transitionMode === 'step-all'}
              title="Same retrigger, but GO re-strikes every staged voice — a full chord re-attack, unchanged pitches included"
            >
              step all
            </button>
          </div>
        </div>
        {timingRow(
          'glide',
          recallGlideMs,
          (ms) => frequencyManager.setRecallGlideMs(ms),
          'Glide/recall timing. 0 = instant snap.',
        )}
        {timingRow(
          'step time',
          stepOverlapMs,
          (ms) => frequencyManager.setStepOverlapMs(ms),
          'Step transitions: how long the old and new notes sound together. 0 = instant handoff.',
        )}
        {timingRow('undo/redo', undoGlideMs, (ms) => frequencyManager.setUndoGlideMs(ms))}
      </div>
    </div>
  );
}

// Global-transpose readout for the tuning menu, sitting to the right of the
// Align button. The value is set by dragging the frequency-label strip on the
// spectrum bar (a DAW-BPM-style master offset). Captures always store it;
// recall/undo move it only when 'transpose' is a tracked parameter. This
// shows the current amount, resets it on click, and exposes the
// snap-to-semitones toggle. Subscribes to the engine so it tracks live drags.
function TransposeControl() {
  const [semi, setSemi] = useState(() => audioEngine.getTransposeSemitones());
  const [snap, setSnap] = useState(() => audioEngine.getTransposeSnap());
  useEffect(() => audioEngine.addTransposeListener(() => {
    setSemi(audioEngine.getTransposeSemitones());
    setSnap(audioEngine.getTransposeSnap());
  }), []);
  const value = semi === 0
    ? '0'
    : `${semi > 0 ? '+' : ''}${snap ? semi.toFixed(0) : semi.toFixed(2)}`;
  return (
    <div
      className="tuning-transpose"
      title="Global transpose — drag the frequency-label strip on the spectrum bar. Saved with captures; recalled only when 'transpose' is a tracked parameter."
    >
      <span className="tuning-ctl-label">transpose</span>
      <button
        type="button"
        className="tuning-ctl-btn tuning-transpose-val"
        onClick={() => audioEngine.setTransposeSemitones(0)}
        title="Click to reset transpose to 0"
      >
        {value} st
      </button>
      <label className="tuning-transpose-snap" title="Snap transpose to whole semitones">
        <input
          type="checkbox"
          checked={snap}
          onChange={(e) => audioEngine.setTransposeSnap(e.target.checked)}
        />
        snap
      </label>
    </div>
  );
}

// Tuning panel — the per-slot scale editor (Root above, rows below)
// plus the Align / Save / Undo / Redo actions and save-slot chips.
// Lives in the left-stack alongside the mixer; toggled by the TUNING
// button in OscillatorControls.
//
// The `tuningSystem` / `onTuningSystemChange` props are wired from
// App.jsx so the parent owns canonical state — but FrequencyManager
// (the singleton) is the source of truth. App's state just mirrors
// it for the dropdown's controlled value.
export function TuningPanel({
  oscillatorCount,
  onOscillatorCountChange,
  maxOscillators = 12,
  onAlign,
  onLoad,
  isAligning,
  tuningSystem,
  onTuningSystemChange,
  // Pending-intent radio for the next Load — 7 (diatonic / white-only)
  // or 12 (chromatic / all keys). Defaults to the active system's
  // recommendedScale; switching systems resets it in App.jsx.
  scaleSize = 7,
  onScaleSizeChange,
  // True while frequencies are changing every frame — an orb drag/grab OR
  // a Load/Align glide. Freezes the per-row Hz/ratio/note inputs into plain
  // text so the storm of updates doesn't thrash N rows × 5 controlled inputs.
  frozen = false,
}) {
  useTheme();
  useFreqVersion();

  // Global undo/redo shortcuts. Cmd on macOS, Ctrl on Windows/Linux —
  // matched by checking either modifier so the same code path works
  // cross-platform. Shift inverts to redo (also accept Ctrl+Y as the
  // Windows-native redo idiom).
  useEffect(() => {
    const onKey = (e) => {
      if (isEditableTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) frequencyManager.redo();
        else frequencyManager.undo();
      } else if (key === 'y' && !e.shiftKey) {
        e.preventDefault();
        frequencyManager.redo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const anchorSlot = frequencyManager.anchorSlot;
  const anchorColor = palette.oscColor(anchorSlot, oscillatorCount);

  const activeSystem = tuningSystem || frequencyManager.tuningSystem;
  const activeSystemDef = getSystem(activeSystem);

  // Freeze the per-row inputs into plain text during ANY freq glide, not
  // just orb-drag / Align (the `frozen` prop). Save-state recall glides
  // through FrequencyManager and never set `isAligning`, so without this
  // every row re-renders its 5 controlled inputs each frame — the recall
  // lag. `isLaunching` covers the staged per-voice launch tween (which
  // doesn't set audioEngine.isGliding). The panel re-renders every glide
  // frame (bump listener), so this read stays current and flips back the
  // frame after the glide ends.
  const effFrozen = frozen || audioEngine.isGliding || frequencyManager.isLaunching;

  return (
    <>
      <div
        className="tuning-panel"
        role="region"
        aria-label="Tuning"
        style={{ '--anchor-idx': anchorSlot, '--anchor-color': anchorColor }}
      >
        <div className="tuning-rows">
          {Array.from({ length: oscillatorCount }, (_, i) => (
            <FrequencyRow key={i} slot={i} oscillatorCount={oscillatorCount} frozen={effFrozen} />
          ))}
        </div>
        {/* TUNINGS: N rocker sits BETWEEN the row list and the system
            row. Right-aligned. Free 2..maxOscillators count; Load
            resizes this to match scaleSize, but the user can nudge it
            after. */}
        <div className="tuning-topbar">
          <span className="tuning-topbar-label">root: #{anchorSlot + 1}</span>
          <div className="tuning-topbar-voices">
            <span className="tuning-topbar-label">voices: {oscillatorCount}</span>
            <div className="tuning-chip-group" role="group" aria-label="Voice count">
              <button
                type="button"
                className="tuning-chip"
                onClick={() => onOscillatorCountChange?.(oscillatorCount - 1)}
                disabled={oscillatorCount <= 2}
                title="Remove the highest tuning"
                aria-label="Remove tuning"
              >−</button>
              <button
                type="button"
                className="tuning-chip"
                onClick={() => onOscillatorCountChange?.(oscillatorCount + 1)}
                disabled={oscillatorCount >= maxOscillators}
                title="Add a tuning"
                aria-label="Add tuning"
              >+</button>
            </div>
          </div>
        </div>
        {/* Footer — system dropdown, scale radio (7/12), and Load all
            on a single line. Load now lives here (not in the action
            row below) because the three controls work as a unit: pick
            a system, pick a scale size, commit. Hint underneath
            surfaces the system's conventional scale size. */}
        <div className="tuning-footer">
          <div className="tuning-system-row">
            <select
              id="tuning-system-select"
              className="tuning-system-select"
              value={activeSystem}
              onChange={(e) => onTuningSystemChange?.(e.target.value)}
              title={activeSystemDef ? activeSystemDef.description : ''}
              aria-label="Tuning system"
            >
              {SUPPORTED_SYSTEMS.map((key) => (
                <option key={key} value={key}>{TUNING_SYSTEMS[key].label}</option>
              ))}
            </select>
            <div className="tuning-chip-group tuning-scale-radio" role="radiogroup" aria-label="Scale size">
              <button
                type="button"
                role="radio"
                className={`tuning-chip${scaleSize === 7 ? ' is-active' : ''}`}
                onClick={() => onScaleSizeChange?.(7)}
                aria-checked={scaleSize === 7}
                title="Load 7-note diatonic (white-key keyboard)"
              >7</button>
              <button
                type="button"
                role="radio"
                className={`tuning-chip${scaleSize === 12 ? ' is-active' : ''}`}
                onClick={() => onScaleSizeChange?.(12)}
                aria-checked={scaleSize === 12}
                title="Load 12-note chromatic (all-keys keyboard)"
              >12</button>
            </div>
            <button
              type="button"
              className="tuning-load-btn"
              onClick={onLoad}
              disabled={isAligning || !onLoad}
              title={`Load — lay voices out as ${activeSystemDef?.label ?? 'the active system'}, ${scaleSize === 12 ? '12-note chromatic' : '7-note diatonic'} (resizes voice count and flips the keyboard notes setting)`}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12" />
                <path d="M7 10l5 5 5-5" />
                <path d="M4 19h16" />
              </svg>
              <span>Load</span>
            </button>
          </div>
        </div>
      </div>
      {/* Controls below the panel — no panel background, but left-inset to
          line up with the panel's content (the "root/voices" topbar). */}
      <div className="tuning-below">
      <div className="tuning-actions">
        <button
          type="button"
          className="freq-rail-action"
          onClick={onAlign}
          disabled={isAligning || !onAlign}
          title="Align — snap every drone to its nearest candidate in the active system (preserves rough shape)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
          </svg>
          <span>Align</span>
        </button>
        <TransposeControl />
      </div>
      {/* Parameter lock (ScopePanel) moved to its own PERFORM panel. */}
      {/* Recall easing curve moved to Settings → "Recall curve". */}
      </div>
    </>
  );
}

// Perform panel — the parameter lock (tracked parameters + transition
// timing) in its own chassis, split out of the tuning menu. Toggled by
// the PERFORM button in the right-side toggle group; renders in the
// left-stack alongside (or without) the tuning panel.
export function PerformPanel() {
  return (
    <div className="perform-panel" role="region" aria-label="Perform">
      <ScopePanel />
    </div>
  );
}

