import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import audioEngine from '../audio/AudioEngine';

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

const GlobalDetuneOrb = memo(function GlobalDetuneOrb({ onDragStateChange }) {
  const wrapRef = useRef(null);
  const homeCenterRef = useRef({ x: 0, y: 0 });
  const freqSnapshotRef = useRef(null);
  const volSnapshotRef = useRef(null);
  const startRef = useRef({ x: 0, y: 0 });
  const lastShiftRef = useRef(false);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef(null);
  // Pointermove can fire faster than the display refresh (e.g. 120 Hz trackpads on
  // 60 Hz monitors). Coalesce moves to one applyDrag() per frame — the audio
  // engine fan-out (setAllFrequenciesBatch + Tuning._recompute + listeners) is
  // the same per-call cost regardless of pointer rate, so running it 2× per
  // frame is pure waste. Latest event wins; intermediate ones are dropped.
  const pendingMoveRef = useRef(null);
  const moveRafRef = useRef(0);
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
    pointerIdRef.current = e.pointerId;
    lastShiftRef.current = e.shiftKey;
    // Tell the parent an all-orb drag started so sibling panels (the tuning
    // panel) can freeze their per-row inputs into plain text. This drag moves
    // EVERY oscillator each frame, so without it all N rows re-render as full
    // controlled inputs — the heaviest case.
    onDragStateChange?.(true);
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
  const flushPendingMove = () => {
    moveRafRef.current = 0;
    const p = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (!p || !draggingRef.current) return;
    applyDrag(p.x, p.y, p.shiftKey);
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    pendingMoveRef.current = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
    if (!moveRafRef.current) {
      moveRafRef.current = requestAnimationFrame(flushPendingMove);
    }
  };
  // Single teardown path for every way a drag can end — normal pointerup,
  // pointercancel, lost capture, window blur, tab hidden, Escape, or a click
  // elsewhere. Idempotent (guards on draggingRef) so overlapping signals are
  // harmless. `flush` applies the last queued move so a clean release lands
  // exactly under the cursor; interruptions skip it and rest where they were.
  const endDrag = (flush) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = 0;
    }
    if (flush && pendingMoveRef.current) {
      const p = pendingMoveRef.current;
      applyDrag(p.x, p.y, p.shiftKey);
    }
    pendingMoveRef.current = null;
    const id = pointerIdRef.current;
    pointerIdRef.current = null;
    if (id != null) {
      try { wrapRef.current?.releasePointerCapture?.(id); } catch { /* no-op */ }
    }
    freqSnapshotRef.current = null;
    volSnapshotRef.current = null;
    setGhost(null);
    onDragStateChange?.(false);
  };

  const handlePointerUp = () => endDrag(true);

  // Keep the safety-net listeners (attached once, below) pointing at the
  // current endDrag closure without re-subscribing on every render.
  const endDragRef = useRef(null);
  useEffect(() => { endDragRef.current = endDrag; });

  // Global safety net for a stuck orb: if the gesture is interrupted somewhere
  // we don't receive a pointerup — capture lost, window blur, tab hidden,
  // Escape, or a pointerdown outside the orb — snap the drag closed so the
  // ghost never keeps following the cursor. Each handler no-ops when not
  // dragging, so they're inert outside an active drag.
  useEffect(() => {
    const cancel = () => endDragRef.current?.(false);
    const onVis = () => { if (document.visibilityState === 'hidden') endDragRef.current?.(false); };
    const onKey = (e) => { if (e.key === 'Escape') endDragRef.current?.(false); };
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) endDragRef.current?.(false);
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointerdown', onDown);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointerdown', onDown);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Unmount safety: if the component dies mid-drag, cancel the pending frame
  // and clear the parent's drag flag so the tuning panel doesn't stay frozen.
  useEffect(() => () => {
    if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
    if (draggingRef.current) onDragStateChange?.(false);
  }, [onDragStateChange]);

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
      onPointerCancel={() => endDrag(false)}
      onLostPointerCapture={() => endDrag(false)}
      title="Drag to shift all oscillators — X detunes (preserves beats), Y changes volume. Hold shift for fine-tune."
    >
      <div className="global-detune-orb" />
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

export default GlobalDetuneOrb;
