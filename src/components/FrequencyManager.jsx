import { useCallback, useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import {
  nearestRatio,
  extendOctaves,
  offsetToOpacity,
  EXACT_CENTS_TOLERANCE,
} from '../audio/jiRatios';
import palette, { useTheme } from '../theme/palette';
import { isEditableTarget } from '../hooks/keyboardUtils';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function freqToNote(freq) {
  if (!Number.isFinite(freq) || freq <= 0) return { note: '--', octave: 0, cents: 0 };
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midi = Math.round(69 + semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - (midi - 69)) * 100);
  const idx = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { note: NOTE_NAMES[idx], octave, cents };
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
function CellInput({ value, onCommit, format, parse, className, title, disabled, style }) {
  const [buffer, setBuffer] = useState('');
  const [focused, setFocused] = useState(false);
  const [edited, setEdited] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const display = focused ? buffer : format(value);

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

function FrequencyRow({ slot, oscillatorCount }) {
  const hz = audioEngine.initialized ? audioEngine.getFrequency(slot) : 0;
  const anchorHz = audioEngine.initialized
    ? audioEngine.getFrequency(frequencyManager.anchorSlot)
    : 0;
  const isAnchor = frequencyManager.isAnchor(slot);
  const lockedRatio = frequencyManager.getRatio(slot); // {n,d} or null
  const limit = frequencyManager.limit;
  const color = palette.oscColor(slot, oscillatorCount);

  // The displayed ratio is either the locked one (if present), or the
  // nearest candidate in the current limit set. The anchor is always
  // exactly 1/1.
  let ratioInfo = null;
  if (isAnchor) {
    ratioInfo = { n: 1, d: 1, offsetCents: 0, halfGapPos: 50, halfGapNeg: 50 };
  } else if (anchorHz > 0 && hz > 0) {
    const nearest = nearestRatio(hz / anchorHz, limit);
    if (nearest) {
      const ext = extendOctaves(nearest.n, nearest.d, nearest.octave);
      ratioInfo = {
        n: ext.n,
        d: ext.d,
        offsetCents: nearest.offsetCents,
        halfGapPos: nearest.halfGapPos,
        halfGapNeg: nearest.halfGapNeg,
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
  const centsLabel = note.cents === 0
    ? '0¢'
    : `${note.cents > 0 ? '+' : ''}${note.cents}¢`;

  const handleAnchorClick = useCallback(() => {
    frequencyManager.setAnchorSlot(slot);
  }, [slot]);

  const handleHzCommit = useCallback((hz) => {
    frequencyManager.setSlotHz(slot, hz);
  }, [slot]);

  const handleRatioCommit = useCallback(({ n, d }) => {
    frequencyManager.setSlotRatio(slot, n, d);
  }, [slot]);

  const handleOctave = useCallback((factor) => {
    if (!audioEngine.initialized) return;
    const cur = audioEngine.getFrequency(slot);
    if (!Number.isFinite(cur) || cur <= 0) return;
    const next = Math.max(0.1, Math.min(20000, cur * factor));
    audioEngine.setFrequency(slot, next);
  }, [slot]);

  return (
    <div className="freq-rail-row" style={{ '--osc-color': color }}>
      <button
        type="button"
        className={`freq-rail-marker${isAnchor ? ' anchor' : ''}`}
        onClick={handleAnchorClick}
        title={isAnchor ? 'Anchor slot (1/1)' : `Set slot ${slot + 1} as anchor`}
        aria-pressed={isAnchor}
      >
        D{slot + 1}
      </button>
      <CellInput
        value={hz}
        format={formatHz}
        parse={parseHz}
        onCommit={handleHzCommit}
        className="freq-rail-hz"
        title="Frequency in Hz"
      />
      <CellInput
        value={ratioInfo ? { n: ratioInfo.n, d: ratioInfo.d } : null}
        format={(r) => (r && r.d === 1 ? `${r.n}` : r ? `${r.n}/${r.d}` : '')}
        parse={parseRatio}
        onCommit={handleRatioCommit}
        className={`freq-rail-ratio${ratioExact ? ' exact' : ''}${lockedRatio ? ' locked' : ''}`}
        style={{ opacity: ratioOpacity }}
        title={isAnchor
          ? 'Anchor is always 1/1'
          : lockedRatio
            ? 'Locked ratio'
            : 'Nearest JI ratio (type to lock)'}
        disabled={isAnchor}
      />
      <div
        className="freq-rail-note"
        title={`${note.note}${note.octave} ${centsLabel}`}
      >
        <span className="freq-rail-note-name">{note.note}{note.octave}</span>
        <span className="freq-rail-note-cents">{centsLabel}</span>
      </div>
      <button
        type="button"
        className="freq-rail-octave-btn"
        onClick={() => handleOctave(0.5)}
        title="Down an octave"
        aria-label={`Octave down slot ${slot + 1}`}
      >↓</button>
      <button
        type="button"
        className="freq-rail-octave-btn"
        onClick={() => handleOctave(2)}
        title="Up an octave"
        aria-label={`Octave up slot ${slot + 1}`}
      >↑</button>
    </div>
  );
}

function RootField() {
  const rootHz = audioEngine.initialized
    ? audioEngine.getFrequency(frequencyManager.anchorSlot)
    : 0;
  const note = freqToNote(rootHz);
  const centsLabel = note.cents === 0
    ? '0¢'
    : `${note.cents > 0 ? '+' : ''}${note.cents}¢`;
  const handleCommit = useCallback((hz) => {
    frequencyManager.setRootHz(hz);
  }, []);
  const shiftOctave = useCallback((factor) => {
    if (!audioEngine.initialized) return;
    const cur = audioEngine.getFrequency(frequencyManager.anchorSlot);
    if (!Number.isFinite(cur) || cur <= 0) return;
    frequencyManager.setRootHz(cur * factor);
  }, []);
  return (
    <div className="freq-rail-root">
      <label className="freq-rail-root-label">Root</label>
      <CellInput
        value={rootHz}
        format={formatHz}
        parse={parseHz}
        onCommit={handleCommit}
        className="freq-rail-root-input"
        title="Root frequency — typing here transposes every slot proportionally"
      />
      {/* Empty placeholder occupying the ratio column so the note
          column-aligns with the per-slot notes below. */}
      <span aria-hidden="true" />
      <div
        className="freq-rail-note"
        title={`${note.note}${note.octave} ${centsLabel}`}
      >
        <span className="freq-rail-note-name">{note.note}{note.octave}</span>
        <span className="freq-rail-note-cents">{centsLabel}</span>
      </div>
      <button
        type="button"
        className="freq-rail-octave-btn"
        onClick={() => shiftOctave(0.5)}
        title="Halve root (down an octave) — transposes every slot"
        aria-label="Halve root frequency"
      >/2</button>
      <button
        type="button"
        className="freq-rail-octave-btn"
        onClick={() => shiftOctave(2)}
        title="Double root (up an octave) — transposes every slot"
        aria-label="Double root frequency"
      >×2</button>
    </div>
  );
}

function SaveSlotChip({ slot }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slot.name);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = useCallback(() => {
    const next = draft.trim();
    if (next && next !== slot.name) frequencyManager.renameSlot(slot.id, next);
    else setDraft(slot.name);
    setEditing(false);
  }, [draft, slot.id, slot.name]);

  const handleRecall = useCallback(() => {
    if (editing) return;
    frequencyManager.recallSlot(slot.id);
  }, [editing, slot.id]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    frequencyManager.deleteSlot(slot.id);
  }, [slot.id]);

  return (
    <div className="freq-rail-slot" title="Click to recall (glide). Double-click to rename.">
      {editing ? (
        <input
          ref={inputRef}
          className="freq-rail-slot-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') { setDraft(slot.name); setEditing(false); }
          }}
        />
      ) : (
        <button
          type="button"
          className="freq-rail-slot-name"
          onClick={handleRecall}
          onDoubleClick={() => { setDraft(slot.name); setEditing(true); }}
        >
          {slot.name}
        </button>
      )}
      <button
        type="button"
        className="freq-rail-slot-delete"
        onClick={handleDelete}
        title="Delete this save"
        aria-label={`Delete ${slot.name}`}
      >
        ×
      </button>
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
    const bump = () => setVersion((v) => v + 1);
    const unsubA = audioEngine.addFrequencyListener(bump);
    const unsubB = frequencyManager.onChange(bump);
    frequencyManager.ensureInitialSnapshot();
    return () => { unsubA(); unsubB(); };
  }, []);
  useEffect(() => {
    frequencyManager.ensureInitialSnapshot();
  });
}

// Tuning panel — the per-slot scale editor (Root above, rows below)
// plus the Align / Save / Undo / Redo actions and save-slot chips.
// Lives in the left-stack alongside the mixer; toggled by the TUNING
// button in OscillatorControls.
export function TuningPanel({ oscillatorCount, onAlign, isAligning }) {
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

  const canUndo = frequencyManager.canUndo();
  const canRedo = frequencyManager.canRedo();
  const slots = frequencyManager.getSlots();
  const anchorSlot = frequencyManager.anchorSlot;
  const anchorColor = palette.oscColor(anchorSlot, oscillatorCount);
  const handleUndo = useCallback(() => { frequencyManager.undo(); }, []);
  const handleRedo = useCallback(() => { frequencyManager.redo(); }, []);
  // Save button removed for now (the user wanted a less crowded action
  // row). frequencyManager.saveCurrent() is still on the singleton so
  // it can be re-wired to a future trigger / shortcut without changes.

  return (
    <>
      <div
        className="tuning-panel"
        role="region"
        aria-label="Tuning"
        style={{ '--anchor-idx': anchorSlot, '--anchor-color': anchorColor }}
      >
        <RootField />
        <div className="tuning-rows">
          {Array.from({ length: oscillatorCount }, (_, i) => (
            <FrequencyRow key={i} slot={i} oscillatorCount={oscillatorCount} />
          ))}
        </div>
        {slots.length > 0 && (
          <div className="freq-rail-slots" role="list" aria-label="Saved states">
            {slots.map((s) => (
              <SaveSlotChip key={s.id} slot={s} />
            ))}
          </div>
        )}
      </div>
      {/* Action buttons render OUTSIDE the panel — as a sibling in the
          .left-stack flex column they appear directly below the panel
          without the panel's background or padding. */}
      <div className="tuning-actions">
        <button
          type="button"
          className="freq-rail-action"
          onClick={onAlign}
          disabled={isAligning || !onAlign}
          title="Align — glide every drone to its nearest JI ratio (variance + glide time in Settings)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
          </svg>
          <span>Align</span>
        </button>
        <button
          type="button"
          className="freq-rail-action"
          onClick={handleUndo}
          disabled={!canUndo}
          title={canUndo ? 'Undo last change' : 'Nothing to undo'}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
          </svg>
          <span>Undo</span>
        </button>
        <button
          type="button"
          className="freq-rail-action"
          onClick={handleRedo}
          disabled={!canRedo}
          title={canRedo ? 'Redo' : 'Nothing to redo'}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 14l5-5-5-5" />
            <path d="M20 9H10a6 6 0 0 0 0 12h3" />
          </svg>
          <span>Redo</span>
        </button>
      </div>
    </>
  );
}

