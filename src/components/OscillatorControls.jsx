import { memo, useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import audioEngine from '../audio/AudioEngine';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const OSCILLATOR_COLORS = [
  '#ff4136',
  '#2ecc40',
  '#0074d9',
  '#ffdc00',
  '#bb8fce',
  '#85c1e9',
  '#82e0aa',
  '#f8b500',
  '#e74c3c',
  '#1abc9c',
];

function freqToNote(freq) {
  if (freq <= 0) return { note: '--', octave: 0, cents: 0 };
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midiNote = Math.round(69 + semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - (midiNote - 69)) * 100);
  const noteIndex = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;
  return { note: NOTE_NAMES[noteIndex], octave, cents };
}

function getOscillatorLabel(index) {
  return `${index + 1}`;
}

function formatFreq(freq) {
  // Always show two decimals so small freq changes are visible.
  if (freq >= 10000) return `${(freq / 1000).toFixed(1)}k`; // "12.3k"
  if (freq >= 1000) return `${(freq / 1000).toFixed(2)}k`;  // "1.23k"
  return freq.toFixed(2);                                    // "144.32", "44.00", "0.12"
}

// Horizontal drag on a per-osc fader fine-tunes that osc's frequency.
// 1/2500 ≈ one octave per 2500px of drag — matches the shift-drag (fine-tune)
// sensitivity on the spectrum bar so the fader can be used for precise nudges.
const FADER_FREQ_OCTAVES_PER_PX = 1 / 2500;

// Global "all" orb: 2D drag handle. X shifts all oscillator frequencies
// additively (preserves inter-osc beat frequencies). Y shifts all oscillator
// volumes additively (does not touch the master fader). Shift-key = fine-tune
// on both axes. Home orb stays put; a ghost follows the cursor anywhere on
// screen. On release the ghost disappears and the shifts persist.
const DETUNE_HZ_PER_PX = 1;
const DETUNE_FINE_HZ_PER_PX = 0.1;
const DETUNE_VOL_PCT_PER_PX = 0.5;       // volume is on a 0-100 scale
const DETUNE_FINE_VOL_PCT_PER_PX = 0.1;
const DETUNE_ORB_SIZE = 22;               // home orb diameter — keep in sync with .global-detune-orb width/height in App.css
const DETUNE_GHOST_SIZE = 35;             // matches FSB ghost (DOT_SIZE)

// Shrink an orb-to-orb line so its endpoints sit on the circle edges, not
// at the centers. Returns null if the circles overlap (nothing to draw).
function detuneOrbOffsetLine(x1, y1, x2, y2, r1, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length <= r1 + r2) return null;
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: x1 + ux * r1,
    y1: y1 + uy * r1,
    x2: x2 - ux * r2,
    y2: y2 - uy * r2,
  };
}

const GlobalDetuneOrb = memo(function GlobalDetuneOrb() {
  const wrapRef = useRef(null);
  const homeCenterRef = useRef({ x: 0, y: 0 });
  const freqSnapshotRef = useRef(null);
  const volSnapshotRef = useRef(null);
  const startRef = useRef({ x: 0, y: 0 });
  const lastShiftRef = useRef(false);
  const draggingRef = useRef(false);
  const [ghost, setGhost] = useState(null); // { x, y } viewport coords while dragging; null at rest

  // Re-snapshot current audio state and reset the drag origin to the current
  // cursor position. Used on pointerdown and whenever the shift modifier
  // toggles mid-drag — rebasing carries the accumulated detune forward so the
  // sensitivity flip doesn't produce a discontinuity.
  const rebase = (clientX, clientY) => {
    freqSnapshotRef.current = audioEngine.getAllFrequencies().slice();
    volSnapshotRef.current = audioEngine.getAllVolumes().slice();
    startRef.current = { x: clientX, y: clientY };
  };

  const applyDrag = (clientX, clientY, shiftKey) => {
    if (shiftKey !== lastShiftRef.current) {
      rebase(clientX, clientY);
      lastShiftRef.current = shiftKey;
    }

    const fs = freqSnapshotRef.current;
    const vs = volSnapshotRef.current;
    if (!fs || !vs) return;

    const hzPerPx = shiftKey ? DETUNE_FINE_HZ_PER_PX : DETUNE_HZ_PER_PX;
    const volPerPx = shiftKey ? DETUNE_FINE_VOL_PCT_PER_PX : DETUNE_VOL_PCT_PER_PX;

    const dx = clientX - startRef.current.x;
    const dy = clientY - startRef.current.y;

    // Hz shift: clamp to keep every osc in [0.001, 20000]. Clamping the shift
    // (not per-osc) preserves the beats — otherwise one osc would stall at the
    // floor while the rest kept moving.
    let fMin = fs[0], fMax = fs[0];
    for (let i = 1; i < fs.length; i++) {
      if (fs[i] < fMin) fMin = fs[i];
      if (fs[i] > fMax) fMax = fs[i];
    }
    const hzShift = Math.max(0.001 - fMin, Math.min(20000 - fMax, dx * hzPerPx));

    // Volume shift on 0-100 scale. Dragging up (dy < 0) raises volumes.
    let vMin = vs[0], vMax = vs[0];
    for (let i = 1; i < vs.length; i++) {
      if (vs[i] < vMin) vMin = vs[i];
      if (vs[i] > vMax) vMax = vs[i];
    }
    const volShift = Math.max(0 - vMin, Math.min(100 - vMax, -dy * volPerPx));

    // Batched: single currentTime read inside AudioEngine so every osc lands
    // at exactly the same audio moment. Any per-call currentTime jitter was a
    // candidate for beat drift during fast drags.
    const newFreqs = new Array(fs.length);
    for (let i = 0; i < fs.length; i++) newFreqs[i] = fs[i] + hzShift;
    audioEngine.setAllFrequenciesBatch(newFreqs);

    const newVols = new Array(vs.length);
    for (let i = 0; i < vs.length; i++) newVols[i] = (vs[i] + volShift) / 100;
    audioEngine.setAllVolumesBatch(newVols);

    setGhost({ x: clientX, y: clientY });
  };

  const handlePointerDown = (e) => {
    if (!audioEngine.initialized) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    draggingRef.current = true;
    lastShiftRef.current = e.shiftKey;
    // Snapshot the home orb's viewport center so the tether line anchors to
    // the resting position (not the cursor) even though the ghost is in a
    // portal that escapes our transformed ancestor.
    const orbEl = wrapRef.current?.querySelector('.global-detune-orb');
    if (orbEl) {
      const r = orbEl.getBoundingClientRect();
      homeCenterRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    rebase(e.clientX, e.clientY);
    setGhost({ x: e.clientX, y: e.clientY });
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    applyDrag(e.clientX, e.clientY, e.shiftKey);
  };
  const handlePointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    freqSnapshotRef.current = null;
    volSnapshotRef.current = null;
    setGhost(null);
  };

  const isDragging = ghost !== null;

  // Tether segment: dashed line from the home orb's edge to the ghost's edge.
  // Matches the spectrum-bar ghost tether visually (dashed, same stroke
  // pattern) so the "all" orb drag feels consistent with per-osc drags.
  const tetherSeg = isDragging
    ? detuneOrbOffsetLine(
        homeCenterRef.current.x,
        homeCenterRef.current.y,
        ghost.x,
        ghost.y,
        DETUNE_ORB_SIZE / 2,
        DETUNE_GHOST_SIZE / 2,
      )
    : null;

  return (
    <div
      ref={wrapRef}
      className={`global-detune-orb-wrap ${isDragging ? 'dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      title="Drag to shift all oscillators — X detunes (preserves beats), Y changes volume. Hold shift for fine-tune."
    >
      <div className="global-detune-orb" />
      <span className="global-detune-orb-label">all</span>
      {/* Ghost + tether portaled to body — escapes the osc-controls-panel's
          transform containing block so position:fixed tracks the viewport. */}
      {isDragging && createPortal(
        <div className="global-detune-portal-root">
          {tetherSeg && Number.isFinite(tetherSeg.x1) && Number.isFinite(tetherSeg.y1) && (
            <svg
              className="global-detune-tether"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <line
                x1={tetherSeg.x1}
                y1={tetherSeg.y1}
                x2={tetherSeg.x2}
                y2={tetherSeg.y2}
                stroke="rgba(240, 244, 255, 0.95)"
                strokeOpacity={0.55}
                strokeWidth={1}
              />
            </svg>
          )}
          <div
            className="global-detune-orb-ghost"
            style={{
              left: ghost.x - DETUNE_GHOST_SIZE / 2,
              top: ghost.y - DETUNE_GHOST_SIZE / 2,
              width: DETUNE_GHOST_SIZE,
              height: DETUNE_GHOST_SIZE,
            }}
          />
        </div>,
        document.body
      )}
    </div>
  );
});

const MasterVolumeFader = memo(function MasterVolumeFader({ volume }) {
  const ref = useRef(null);
  const draggingRef = useRef(false);

  const setFromY = (clientY) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relY = clientY - rect.top;
    const v = 1 - Math.max(0, Math.min(1, relY / rect.height));
    audioEngine.setMasterVolume(v);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    draggingRef.current = true;
    setFromY(e.clientY);
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    setFromY(e.clientY);
  };
  const handlePointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  };

  const fillPct = volume * 100;

  return (
    <div
      ref={ref}
      className="volume-fader master-fader"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="volume-fader-fill" style={{ height: `${fillPct}%` }} />
      <div className="volume-fader-thumb" style={{ bottom: `calc(${fillPct}% - 2px)` }} />
    </div>
  );
});

// Right-side "MORE" column — only visible in expanded mode. Holds osc count
// ±, settings, help, save, and the chevron-down to collapse back to simple.
const MoreCol = memo(function MoreCol({
  oscillatorCount,
  onOscillatorCountChange,
  onSettingsToggle,
  isSettingsOpen,
  onShowHelp,
  onShare,
  onCollapse,
}) {
  return (
    <div className="osc-col osc-more-col">
      <div className="osc-col-readout osc-more-col-label">
        <span className="freq-hz">MORE</span>
      </div>

      <div className="osc-octave-buttons">
        <button
          className="osc-more-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount + 1)}
          disabled={oscillatorCount >= maxOscillators}
          title="Add oscillator"
          aria-label="Add oscillator"
        >+</button>
        <button
          className="osc-more-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount - 1)}
          disabled={oscillatorCount <= 2}
          title="Remove oscillator"
          aria-label="Remove oscillator"
        >−</button>
      </div>

      <div className="osc-more-stack">
        <button
          className={`osc-more-btn icon-btn ${isSettingsOpen ? 'active' : ''}`}
          onClick={onSettingsToggle}
          title="Settings"
          aria-label="Settings"
        >
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
          </svg>
        </button>
        <button
          className="osc-more-btn icon-btn"
          onClick={onShowHelp}
          title="Help / Controls"
          aria-label="Help"
        >
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" />
          </svg>
        </button>
        <button
          className="osc-more-btn icon-btn"
          onClick={onShare}
          title="Save / Share"
          aria-label="Save"
        >
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
          </svg>
        </button>
      </div>

      <button
        className="osc-more-chevron"
        onClick={onCollapse}
        title="Collapse (hide controls)"
        aria-label="Collapse"
      >
        <svg viewBox="0 0 24 24" className="button-icon">
          <path d="M7.41 18.59L12 14l4.59 4.59L18 17.17l-6-6-6 6zm0-7L12 7l4.59 4.59L18 10.17l-6-6-6 6z"
                transform="rotate(180 12 12)" />
        </svg>
      </button>
    </div>
  );
});

const MasterAllCol = memo(function MasterAllCol({ masterVolume, onAllOctave, isPaused, onPlayPause }) {
  return (
    <div className="osc-col osc-all-col">
      <div className="osc-col-readout osc-all-col-label">
        <span className="freq-hz">ALL</span>
      </div>

      <div className="osc-octave-buttons">
        <button
          className="osc-octave-btn"
          onClick={() => onAllOctave(2)}
          title="Double all frequencies (up an octave)"
          aria-label="Double all frequencies"
        >×2</button>
        <button
          className="osc-octave-btn"
          onClick={() => onAllOctave(0.5)}
          title="Halve all frequencies (down an octave)"
          aria-label="Halve all frequencies"
        >/2</button>
      </div>

      <MasterVolumeFader volume={masterVolume} />

      <button
        className="osc-all-playpause"
        onClick={onPlayPause}
        title={isPaused ? 'Play (Space)' : 'Pause (Space)'}
        aria-label={isPaused ? 'Play' : 'Pause'}
      >
        {isPaused ? (
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="button-icon">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        )}
      </button>
    </div>
  );
});

const VolumeFader = memo(function VolumeFader({ oscIndex, volume, color, isMuted, onFineTuningChange }) {
  const ref = useRef(null);
  const draggingRef = useRef(false);
  const lastXRef = useRef(0);

  const setFromY = (clientY) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relY = clientY - rect.top;
    const v = 1 - Math.max(0, Math.min(1, relY / rect.height));
    audioEngine.setVolume(oscIndex, v);
  };

  const applyHorizontalFreqDelta = (deltaX) => {
    if (deltaX === 0) return;
    const cur = audioEngine.getFrequency(oscIndex);
    const next = Math.max(0.1, Math.min(20000, cur * 2 ** (deltaX * FADER_FREQ_OCTAVES_PER_PX)));
    audioEngine.setFrequency(oscIndex, next);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    draggingRef.current = true;
    lastXRef.current = e.clientX;
    onFineTuningChange?.(oscIndex, true);
    setFromY(e.clientY);
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    setFromY(e.clientY);
    const deltaX = e.clientX - lastXRef.current;
    lastXRef.current = e.clientX;
    applyHorizontalFreqDelta(deltaX);
  };
  const handlePointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onFineTuningChange?.(oscIndex, false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  };

  const fillPct = isMuted ? 0 : volume;

  return (
    <div
      ref={ref}
      className={`volume-fader ${isMuted ? 'muted' : ''}`}
      style={{ '--fader-color': color }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="volume-fader-fill" style={{ height: `${fillPct}%` }} />
      <div className="volume-fader-thumb" style={{ bottom: `calc(${fillPct}% - 2px)` }} />
    </div>
  );
});

const OscillatorCol = memo(function OscillatorCol({ index, label, color, isMuted, isActive, onMuteToggle, freq, volume }) {
  const noteInfo = freqToNote(freq);
  const centsStr = noteInfo.cents >= 0 ? `+${noteInfo.cents}` : `${noteInfo.cents}`;

  const shiftOctave = (factor) => {
    const cur = audioEngine.getFrequency(index);
    const next = Math.max(0.1, Math.min(20000, cur * factor));
    audioEngine.setFrequency(index, next);
  };

  return (
    <div
      className={`osc-col ${isMuted ? 'muted' : ''} ${isActive ? 'active' : ''}`}
      style={{ '--row-color': color }}
    >
      <div className="osc-col-readout">
        <span className="freq-hz">{formatFreq(freq)}</span>
        <span className="freq-note-cents">
          <span className="freq-note">{noteInfo.note}{noteInfo.octave}</span>
          <span className="freq-cents">{centsStr}</span>
        </span>
      </div>

      <div className="osc-octave-buttons">
        <button
          className="osc-octave-btn"
          onClick={() => shiftOctave(2)}
          title="Double frequency (up an octave)"
          aria-label="Double frequency"
        >×2</button>
        <button
          className="osc-octave-btn"
          onClick={() => shiftOctave(0.5)}
          title="Halve frequency (down an octave)"
          aria-label="Halve frequency"
        >/2</button>
      </div>

      <VolumeFader oscIndex={index} volume={volume} color={color} isMuted={isMuted} />

      <div
        className={`osc-mute-indicator ${!isMuted ? 'unmuted' : ''}`}
        style={{ '--dot-color': color }}
        title={isMuted ? 'Click to unmute' : 'Click to mute'}
        onClick={() => onMuteToggle(index)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onMuteToggle(index)}
      >
        {label}
      </div>
    </div>
  );
});

function OscillatorControls({
  oscillatorCount = 2,
  maxOscillators = 10,
  onShare,
  onSettingsToggle,
  isSettingsOpen,
  onShowHelp,
  fineTuneEnabled = false,
  onFineTuneToggle,
  onOscillatorCountChange,
  activeOscs,
  uiMode = 'simple',
  onModeChange,
  tuneVarianceHz = 0,
  tuneGlideSec = 1.0,
  onFineTuningChange,
}) {
  const createInitialArray = (defaultValue, length) => Array(length).fill(defaultValue);

  const [mutedOscillators, setMutedOscillators] = useState(() => createInitialArray(false, oscillatorCount));
  const [frequencies, setFrequencies] = useState(() => createInitialArray(60, oscillatorCount));
  const [volumes, setVolumes] = useState(() => createInitialArray(50, oscillatorCount));
  const [masterVolume, setMasterVolume] = useState(() => audioEngine.getMasterVolume?.() ?? 1);
  const [isPaused, setIsPaused] = useState(false);
  const [isTuning, setIsTuning] = useState(false);
  // Tracked separately from frequencies/volumes because the bottom-row
  // mute buttons append an L/R/LR suffix derived from routing (only
  // shown when the output is plain stereo — for >2 output channels we
  // omit the suffix since there's no single letter that fits).
  const [routingMap, setRoutingMap] = useState(() => audioEngine.getRoutingMap?.() ?? {});
  const [maxChannels, setMaxChannels] = useState(() => audioEngine.getMaxOutputChannels?.() ?? 2);

  const handleTune = () => {
    if (!audioEngine.initialized) return;
    const targets = audioEngine.computeJustIntonationTargets(tuneVarianceHz);
    setIsTuning(true);
    audioEngine.glideToFrequencies(targets, Math.round(tuneGlideSec * 1000), () => {
      setIsTuning(false);
    });
  };

  useEffect(() => {
    setMutedOscillators((prev) => {
      const arr = [...prev];
      while (arr.length < oscillatorCount) arr.push(false);
      return arr.slice(0, oscillatorCount);
    });
    setFrequencies((prev) => {
      const arr = [...prev];
      while (arr.length < oscillatorCount) arr.push(60);
      return arr.slice(0, oscillatorCount);
    });
    setVolumes((prev) => {
      const arr = [...prev];
      while (arr.length < oscillatorCount) arr.push(50);
      return arr.slice(0, oscillatorCount);
    });
  }, [oscillatorCount]);

  const oscillators = useMemo(() => {
    return Array.from({ length: oscillatorCount }, (_, i) => ({
      index: i,
      label: getOscillatorLabel(i),
      color: OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length],
    }));
  }, [oscillatorCount]);

  // Single horizontally-scrolling row at all widths — mirrors the mobile layout
  // on desktop too so the master ALL column lines up the same way everywhere.
  const rows = useMemo(() => [oscillators], [oscillators]);

  useEffect(() => {
    let animationId;
    const arraysEqual = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const routingMapsEqual = (a, b) => {
      if (!a || !b) return a === b;
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      for (const k of aKeys) {
        if (!(k in b)) return false;
        const av = a[k] || [];
        const bv = b[k] || [];
        if (!arraysEqual(av, bv)) return false;
      }
      return true;
    };
    const sync = () => {
      if (audioEngine.initialized) {
        try {
          const freqs = audioEngine.getAllFrequencies();
          const vols = audioEngine.getAllVolumes();
          const muted = audioEngine.getAllMutedStates();
          if (freqs.length >= oscillatorCount && vols.length >= oscillatorCount && muted.length >= oscillatorCount) {
            const nf = freqs.slice(0, oscillatorCount);
            const nv = vols.slice(0, oscillatorCount);
            const nm = muted.slice(0, oscillatorCount);
            setFrequencies((prev) => (arraysEqual(prev, nf) ? prev : nf));
            setVolumes((prev) => (arraysEqual(prev, nv) ? prev : nv));
            setMutedOscillators((prev) => (arraysEqual(prev, nm) ? prev : nm));
          }
          const mv = audioEngine.getMasterVolume?.() ?? 1;
          setMasterVolume((prev) => (prev === mv ? prev : mv));
          const nr = audioEngine.getRoutingMap?.() ?? {};
          setRoutingMap((prev) => (routingMapsEqual(prev, nr) ? prev : nr));
          const nc = audioEngine.getMaxOutputChannels?.() ?? 2;
          setMaxChannels((prev) => (prev === nc ? prev : nc));
        } catch {
          // ignore
        }
      }
      animationId = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(animationId);
  }, [oscillatorCount]);

  const handlePlayPause = () => {
    if (!audioEngine.initialized) return;
    audioEngine.togglePlayPause();
    setIsPaused(audioEngine.paused);
  };

  const shiftAllOctaves = (factor) => {
    for (let i = 0; i < oscillatorCount; i++) {
      const cur = audioEngine.getFrequency(i);
      const next = Math.max(0.1, Math.min(20000, cur * factor));
      audioEngine.setFrequency(i, next);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        if (!audioEngine.initialized) return;
        audioEngine.togglePlayPause();
        setIsPaused(audioEngine.paused);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleMuteToggle = (index) => {
    if (!audioEngine.initialized) return;
    audioEngine.toggleMute(index);
  };

  if (uiMode === 'fullscreen') return null;

  const isExpanded = uiMode === 'expanded';

  const shiftOscOctave = (index, factor) => {
    const cur = audioEngine.getFrequency(index);
    const next = Math.max(0.1, Math.min(20000, cur * factor));
    audioEngine.setFrequency(index, next);
  };


  return (
    <div className="osc-controls-panel">
      <div className="osc-grid-wrap" style={{ '--cols': oscillatorCount }}>
        {/* Collapsible upper rows — smoothly transition between 0fr and 1fr */}
        <div className={`expanded-collapsible ${isExpanded ? 'open' : ''}`}>
          <div className="expanded-inner">
            {/* Readout row: freq + note (per-osc only; ALL holds detune orb, MORE empty) */}
            <div className="osc-grid-row readout-row">
              <div className="grid-cell grid-empty osc-all-col">
                <GlobalDetuneOrb />
              </div>
              {oscillators.map((osc) => {
                const f = frequencies[osc.index] ?? 60;
                const noteInfo = freqToNote(f);
                const cents = noteInfo.cents >= 0 ? `+${noteInfo.cents}` : `${noteInfo.cents}`;
                const muted = mutedOscillators[osc.index] || false;
                return (
                  <div
                    key={`r-${osc.index}`}
                    className={`grid-cell readout-cell ${muted ? 'muted' : ''}`}
                    style={{ '--row-color': osc.color }}
                  >
                    <span className="freq-hz">{formatFreq(f)}</span>
                    <span className="freq-note-cents">
                      <span className="freq-note">{noteInfo.note}{noteInfo.octave}</span>
                      <span className="freq-cents">{cents}</span>
                    </span>
                  </div>
                );
              })}
              <div className="grid-cell osc-more-col osc-tune-cell">
                <button
                  type="button"
                  className="osc-tune-btn"
                  onClick={handleTune}
                  disabled={isTuning}
                  title="Tune to just-intonation ratios (configure in settings)"
                  aria-label="Tune"
                >
                  {isTuning ? '…' : 'tune'}
                </button>
              </div>
            </div>

            {/* Octave row: ALL ×2 / /2 | per-osc ×2 / /2 | MORE + / − */}
            <div className="osc-grid-row octave-row">
              <div className="grid-cell octave-cell osc-all-col">
                <button className="osc-octave-btn" onClick={() => shiftAllOctaves(2)} title="All ×2" aria-label="All ×2">×2</button>
                <button className="osc-octave-btn" onClick={() => shiftAllOctaves(0.5)} title="All /2" aria-label="All /2">/2</button>
              </div>
              {oscillators.map((osc) => (
                <div
                  key={`o-${osc.index}`}
                  className="grid-cell octave-cell"
                  style={{ '--row-color': osc.color }}
                >
                  <button className="osc-octave-btn" onClick={() => shiftOscOctave(osc.index, 2)}>×2</button>
                  <button className="osc-octave-btn" onClick={() => shiftOscOctave(osc.index, 0.5)}>/2</button>
                </div>
              ))}
              <div className="grid-cell octave-cell osc-more-col">
                <button
                  className="osc-octave-btn"
                  onClick={() => onOscillatorCountChange?.(oscillatorCount + 1)}
                  disabled={oscillatorCount >= maxOscillators}
                  title="Add oscillator"
                  aria-label="Add oscillator"
                >+</button>
                <button
                  className="osc-octave-btn"
                  onClick={() => onOscillatorCountChange?.(oscillatorCount - 1)}
                  disabled={oscillatorCount <= 2}
                  title="Remove oscillator"
                  aria-label="Remove oscillator"
                >−</button>
              </div>
            </div>

            {/* Fader row: master | per-osc | MORE icon stack (settings/save) */}
            <div className="osc-grid-row fader-row">
              <div className="grid-cell fader-cell osc-all-col">
                <MasterVolumeFader volume={masterVolume} />
              </div>
              {oscillators.map((osc) => {
                const muted = mutedOscillators[osc.index] || false;
                const isActive = activeOscs?.has(osc.index) || false;
                return (
                  <div
                    key={`f-${osc.index}`}
                    className={`grid-cell fader-cell ${muted ? 'muted' : ''} ${isActive ? 'active' : ''}`}
                    style={{ '--row-color': osc.color }}
                  >
                    <VolumeFader
                      oscIndex={osc.index}
                      volume={volumes[osc.index] ?? 50}
                      color={osc.color}
                      isMuted={muted}
                      onFineTuningChange={onFineTuningChange}
                    />
                  </div>
                );
              })}
              <div className="grid-cell fader-cell osc-more-col">
                <div className="osc-more-stack">
                  <button
                    className={`osc-more-btn icon-btn ${isSettingsOpen ? 'active' : ''}`}
                    onClick={onSettingsToggle}
                    title="Settings"
                    aria-label="Settings"
                  >
                    <svg viewBox="0 0 24 24" className="button-icon">
                      <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                    </svg>
                  </button>
                  <button className="osc-more-btn icon-btn" onClick={onShare} title="Save / Share" aria-label="Save">
                    <svg viewBox="0 0 24 24" className="button-icon">
                      <path d="M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom row — always rendered. Play/pause, per-osc mute cells, expand/collapse chevron. */}
        <div className="osc-grid-row bottom-row">
          <button
            className={`grid-cell bottom-cell bottom-play ${isPaused ? 'paused' : ''}`}
            onClick={handlePlayPause}
            title={isPaused ? 'Play (Space)' : 'Pause (Space)'}
            aria-label={isPaused ? 'Play' : 'Pause'}
          >
            {isPaused ? (
              <svg viewBox="0 0 24 24" className="button-icon">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="button-icon">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            )}
          </button>
          {oscillators.map((osc) => {
            const muted = mutedOscillators[osc.index] || false;
            // Only annotate routing when the output is plain stereo —
            // for multichannel setups (>2) a single letter isn't
            // expressive enough so we just drop the suffix.
            let channelSuffix = '';
            if (maxChannels === 2) {
              const channels = routingMap[osc.index] || [];
              const onL = channels.includes(0);
              const onR = channels.includes(1);
              if (onL && onR) channelSuffix = 'LR';
              else if (onL) channelSuffix = 'L';
              else if (onR) channelSuffix = 'R';
            }
            return (
              <button
                key={`m-${osc.index}`}
                className={`grid-cell bottom-cell bottom-mute ${muted ? 'muted' : ''}`}
                style={{ '--cell-color': osc.color }}
                onClick={() => handleMuteToggle(osc.index)}
                title={muted ? 'Unmute' : 'Mute'}
                aria-pressed={!muted}
              >
                {osc.label}
                {channelSuffix && (
                  <span className="bottom-mute-channel">{channelSuffix}</span>
                )}
              </button>
            );
          })}
          <button
            className="grid-cell bottom-cell bottom-chevron"
            onClick={() => onModeChange?.(isExpanded ? 'simple' : 'expanded')}
            title={isExpanded ? 'Collapse controls' : 'Expand controls'}
            aria-label={isExpanded ? 'Collapse controls' : 'Expand controls'}
            aria-expanded={isExpanded}
          >
            <svg viewBox="0 0 24 24" className={`button-icon double-chevron ${isExpanded ? 'flipped' : ''}`}>
              <path d="M7.41 18.59L12 14l4.59 4.59L18 17.17l-6-6-6 6z" transform="translate(0 -3)" />
              <path d="M7.41 11.59L12 7l4.59 4.59L18 10.17l-6-6-6 6z" transform="translate(0 5)" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(OscillatorControls);
