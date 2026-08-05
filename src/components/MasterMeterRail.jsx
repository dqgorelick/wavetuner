import { memo, useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import palette, { useTheme } from '../theme/palette';

// Vertical master meter fader — the web port of the iOS left rail's
// MasterMeterFader (HomeMixerSection.swift): the track IS two side-by-side
// L/R peak meters with slow-decay peak-hold ticks, and a horizontal
// crossbar marks (and drags) the master volume. Same color zones as the
// mixer panel's Main row: green under 0.85, amber to 0.999, red at clip.
//
// mono has no color to spend here — a lit green bar would be the second
// brightest thing on screen, and the orbs are meant to be alone at the
// top. The zones survive as three ink levels instead: a clipped meter
// still reads differently from a quiet one, just by brightness.
function zoneColor(hold) {
  if (palette.theme === 'mono') {
    if (hold >= 0.999) return palette.ink(0.95);
    if (hold >= 0.85) return palette.ink(0.62);
    return palette.ink(0.42);
  }
  if (hold >= 0.999) return 'rgba(248, 81, 73, 0.95)';
  if (hold >= 0.85) return 'rgba(255, 176, 32, 0.9)';
  return 'rgba(74, 222, 128, 0.8)';
}

function MasterMeterRail() {
  useTheme(); // re-render on theme flip so zoneColor re-resolves
  const trackRef = useRef(null);
  const [master, setMaster] = useState(() => audioEngine.getMasterVolume?.() ?? 1);
  const [peaks, setPeaks] = useState({ pL: 0, pR: 0, hL: 0, hR: 0 });

  // rAF meter loop — same decay behavior as the mixer panel's Main row
  // (~1s to fall 50%). State setters short-circuit when the frame's
  // values are unchanged so a silent engine doesn't re-render.
  //
  // Capped at 30 Hz: each peak read copies + scans 16k analyser samples,
  // and a meter reads identically at 30 fps. On 120 Hz ProMotion phones
  // an uncapped loop quadrupled that work for nothing.
  useEffect(() => {
    let raf;
    const METER_MIN_MS = 1000 / 30 - 1.5;
    let lastTs = 0;
    const tick = (ts) => {
      raf = requestAnimationFrame(tick);
      const now = typeof ts === 'number' ? ts : performance.now();
      if (now - lastTs < METER_MIN_MS) return;
      lastTs = now;
      if (!audioEngine.initialized) return;
      try {
        const nextMaster = audioEngine.getMasterVolume();
        setMaster((prev) => (Math.abs(prev - nextMaster) > 0.001 ? nextMaster : prev));
        const { peakL, peakR } = audioEngine.getMasterPeakLevels();
        setPeaks((prev) => {
          // 0.97/frame at 60 fps ≈ 0.941 at 30 fps — same fall time.
          const decay = 0.941;
          const hL = Math.max(prev.hL * decay, peakL);
          const hR = Math.max(prev.hR * decay, peakR);
          if (
            Math.abs(prev.pL - peakL) <= 0.001 &&
            Math.abs(prev.pR - peakR) <= 0.001 &&
            Math.abs(prev.hL - hL) <= 0.001 &&
            Math.abs(prev.hR - hR) <= 0.001
          ) return prev;
          return { pL: peakL, pR: peakR, hL, hR };
        });
      } catch { /* engine mid-teardown */ }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  // Relative drag (iOS DragGesture grammar): remember the volume at
  // pointer-down and move it by the vertical delta, so grabbing the
  // track anywhere doesn't jump the level to that spot.
  const dragRef = useRef(null);
  const handlePointerDown = (e) => {
    const track = trackRef.current;
    if (!track || !audioEngine.initialized) return;
    e.preventDefault();
    track.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startVol: audioEngine.getMasterVolume(),
      height: track.getBoundingClientRect().height || 1,
    };
  };
  const handlePointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = (drag.startY - e.clientY) / drag.height;
    const next = Math.max(0, Math.min(1, drag.startVol + delta));
    audioEngine.setMasterVolume(next);
    setMaster(next);
  };
  const handlePointerEnd = () => { dragRef.current = null; };

  const frac = Math.max(0, Math.min(1, master));
  const bar = (peak, hold, side) => (
    <div className={`master-meter-bar ${side}`}>
      <div
        className="master-meter-fill"
        style={{
          height: `${Math.max(0, Math.min(1, peak)) * 100}%`,
          background: zoneColor(hold),
        }}
      />
      {hold > 0.001 && (
        <div
          className="master-meter-hold"
          style={{
            bottom: `calc(${Math.max(0, Math.min(1, hold)) * 100}% - 1px)`,
            background: zoneColor(hold),
          }}
        />
      )}
    </div>
  );

  return (
    <div
      ref={trackRef}
      className="master-meter-rail"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      role="slider"
      aria-label="Master volume"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Math.round(frac * 100) / 100}
      title="Master volume"
    >
      <div className="master-meter-bars">
        {bar(peaks.pL, peaks.hL, 'L')}
        {bar(peaks.pR, peaks.hR, 'R')}
      </div>
      {/* Volume marker — a horizontal crossbar over the meters (iOS:
          "a level line, not a ball"). */}
      <div
        className="master-meter-cross"
        style={{ bottom: `calc(${frac * 100}% - 1.5px)` }}
      />
    </div>
  );
}

export default memo(MasterMeterRail);
