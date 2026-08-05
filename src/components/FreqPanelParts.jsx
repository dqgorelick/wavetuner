import { useRef, useState } from 'react';
import { DetuneScale, MAX_DETUNE_HZ } from '../audio/StereoMode';
import { FREQ_CEIL } from '../audio/freqRange';

// Shared controls for the frequency / ALL panels — web ports of the
// small iOS pieces that live at the bottom of FrequencyPanel.swift:
// OctaveJogger (− | + rocker pill), FrequencyScrubber (coarse TUNE bar
// + endless FINE TUNE ribbon with detune pair-lines) and DetuneSlider
// (the trim-grammar stereo-detune strip). All drags are RELATIVE and
// self-healing: the base is captured on the first move, pointer capture
// + pointercancel end the gesture, and a bare tap commits nothing.

const COARSE_SPAN_OCTAVES = 2.5; // full-width coarse drag (iOS coarseSpanOctaves)
const FINE_CENTS_PER_WIDTH = 200; // full-width fine drag (iOS fine ribbon)
const FINE_RIDGE_PERIOD = 7; // knurl ridge pitch px — ribbon offset wraps on it
const HZ_MIN = 0.1;
const HZ_MAX = FREQ_CEIL;   // sounding-domain entry needs the transpose headroom
const PAIR_LINE_FULL_HZ = 5; // pair-lines pinned at the edges beyond this

const clampHz = (hz) => Math.max(HZ_MIN, Math.min(HZ_MAX, hz));

export function OctaveJogger({
  vertical = false,
  height = 40,
  onUp,
  onDown,
  upDisabled = false,
  downDisabled = false,
  caption = 'OCTAVE',
  captionAbove = false,
  upLabel = '+',
  downLabel = '−',
}) {
  const pill = (
    <div
      className={`ojog${vertical ? ' vertical' : ''}`}
      style={vertical ? { height: height * 2 + 1 } : { height }}
    >
      {/* Vertical stacks + above −; horizontal reads − | +. */}
      {vertical ? (
        <>
          <button type="button" className="ojog-half" onClick={onUp} disabled={upDisabled} aria-label="Octave up">{upLabel}</button>
          <div className="ojog-sep" aria-hidden="true" />
          <button type="button" className="ojog-half" onClick={onDown} disabled={downDisabled} aria-label="Octave down">{downLabel}</button>
        </>
      ) : (
        <>
          <button type="button" className="ojog-half" onClick={onDown} disabled={downDisabled} aria-label="Octave down">{downLabel}</button>
          <div className="ojog-sep" aria-hidden="true" />
          <button type="button" className="ojog-half" onClick={onUp} disabled={upDisabled} aria-label="Octave up">{upLabel}</button>
        </>
      )}
    </div>
  );
  return (
    <div className="vp-rail">
      {captionAbove && <span className="vp-caption">{caption}</span>}
      {pill}
      {!captionAbove && <span className="vp-caption">{caption}</span>}
    </div>
  );
}

/** Relative horizontal drag on a bar. Calls onDelta(dxTotalPx, width)
 *  every move after 0px of slop (the bars have no tap behavior, so no
 *  slop is needed), onStart() at the first move, onEnd() on release or
 *  cancel. Base-capture is the caller's job inside onStart. */
function useBarDrag({ onStart, onDelta, onEnd }) {
  const dragRef = useRef(null);
  return {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      dragRef.current = {
        pid: e.pointerId,
        startX: e.clientX,
        lastX: e.clientX,
        width: e.currentTarget.getBoundingClientRect().width,
        started: false,
      };
    },
    onPointerMove: (e) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pid) return;
      if (!d.started) {
        d.started = true;
        onStart?.();
      }
      onDelta?.(e.clientX - d.startX, e.clientX - d.lastX, d.width);
      d.lastX = e.clientX;
    },
    onPointerUp: (e) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pid) return;
      dragRef.current = null;
      onEnd?.();
    },
    onPointerCancel: (e) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pid) return;
      dragRef.current = null;
      onEnd?.();
    },
  };
}

/** Coarse + fine tuning bars. `hz` is the NOMINAL frequency for the
 *  thumb readout; drags run on `getHz()` (the live engine value) held
 *  in a ref for the gesture — the rAF-mirrored prop lags a frame and
 *  the engine swallows sub-0.01Hz writes, so per-event math off the
 *  prop would stall slow drags at low frequencies. Commits stream
 *  through onCommit(hz); the engine's smoothing keeps it click-free. */
export function FreqScrubber({ hz, getHz, color, onCommit, detuneMarkerHz = 0 }) {
  const baseRef = useRef(hz);
  const liveRef = useRef(hz);
  // Endless ribbon offset — accumulates drag px, wrapped on the ridge
  // period so the pattern never runs out; NEVER animated (iOS rule).
  const [ribbon, setRibbon] = useState(0);

  const live = () => (getHz ? getHz() : hz);
  const coarse = useBarDrag({
    onStart: () => { baseRef.current = live(); },
    onDelta: (dxTotal, _dxStep, width) => {
      const next = baseRef.current * Math.pow(2, (dxTotal / width) * COARSE_SPAN_OCTAVES);
      onCommit(clampHz(next));
    },
  });
  const fine = useBarDrag({
    onStart: () => { liveRef.current = live(); },
    onDelta: (_dxTotal, dxStep, width) => {
      // Per-event delta accumulated on the gesture's own value — the
      // endless wheel has no meaningful absolute position.
      const cents = (dxStep / width) * FINE_CENTS_PER_WIDTH;
      liveRef.current = clampHz(liveRef.current * Math.pow(2, cents / 1200));
      onCommit(liveRef.current);
      setRibbon((r) => (r + dxStep) % FINE_RIDGE_PERIOD);
    },
  });

  // Coarse thumb: absolute log2 readout over the audible range.
  const thumbFrac = Math.max(0, Math.min(1,
    Math.log2(Math.max(hz, HZ_MIN) / 20) / Math.log2(HZ_MAX / 20)));

  // Pair-lines: the L/R pair's ±d/2 offsets, linear with the edges
  // pinned at PAIR_LINE_FULL_HZ of effective (pan-narrowed) detune.
  const pairFrac = Math.max(0, Math.min(1, detuneMarkerHz / PAIR_LINE_FULL_HZ));
  const showPair = detuneMarkerHz > 0.005;

  return (
    <div className="fscrub" style={{ '--vp-color': color }}>
      <div className="fscrub-unit">
        <div className="fscrub-bar" {...coarse} data-testid="freqCoarse">
          <div className="fscrub-knurl" aria-hidden="true" />
          <div className="fscrub-thumb" style={{ left: `calc(${(thumbFrac * 100).toFixed(2)}% - ${(thumbFrac * 14).toFixed(1)}px)` }} />
        </div>
        <span className="vp-caption">TUNE</span>
      </div>
      <div className="fscrub-unit">
        <div className="fscrub-bar fine" {...fine} data-testid="freqFine">
          <div
            className="fscrub-knurl"
            style={{ backgroundPositionX: `${ribbon}px` }}
            aria-hidden="true"
          />
          <div className="fscrub-tick" aria-hidden="true" />
          {showPair && (
            <>
              <div className="fscrub-pair" style={{ left: `calc(50% - ${(pairFrac * 46).toFixed(1)}%)` }} />
              <div className="fscrub-pair" style={{ left: `calc(50% + ${(pairFrac * 46).toFixed(1)}%)` }} />
            </>
          )}
        </div>
        <span className="vp-caption">FINE TUNE</span>
      </div>
    </div>
  );
}

/** Stereo-detune trim slider — ABSOLUTE tap/drag positioning, with end
 *  snaps (tap the left end = clean off, right end = the full 10 Hz
 *  ceiling). This is now the ONLY place per-voice detune is dialled in:
 *  the settings ceiling slider is gone and the ceiling is pinned at
 *  MAX_DETUNE_HZ, so the travel runs on the log-ish DetuneScale (bottom
 *  half = 0–1 Hz). `value` stays the engine's curve weight [0, 1];
 *  effective detune = value × MAX_DETUNE_HZ. */
export function DetuneSlider({ value, onChange, testid = 'panelDetune' }) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  // Display position, not the raw curve weight — everything below (fill,
  // handle, drag math) is in axis space.
  const pos = DetuneScale.curveNorm(value);

  const setFromClientX = (clientX) => {
    const rect = rootRef.current.getBoundingClientRect();
    const usable = rect.width - 32; // handle width
    if (usable <= 0) return;
    let p = (clientX - rect.left - 16) / usable;
    p = Math.max(0, Math.min(1, p));
    if (p < 0.02) p = 0;
    if (p > 0.98) p = 1;
    onChange(DetuneScale.curveValue(p));
  };

  return (
    <div
      ref={rootRef}
      className="vp-detune"
      data-testid={testid}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        dragRef.current = e.pointerId;
        setFromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragRef.current !== e.pointerId) return;
        setFromClientX(e.clientX);
      }}
      onPointerUp={(e) => { if (dragRef.current === e.pointerId) dragRef.current = null; }}
      onPointerCancel={(e) => { if (dragRef.current === e.pointerId) dragRef.current = null; }}
      role="slider"
      aria-label="Stereo detune"
      aria-valuemin={0}
      aria-valuemax={MAX_DETUNE_HZ}
      aria-valuenow={Number((value * MAX_DETUNE_HZ).toFixed(2))}
      aria-valuetext={`${(value * MAX_DETUNE_HZ).toFixed(2)} Hz`}
    >
      <div className="vp-detune-fill" style={{ width: `calc(16px + ${(pos * 100).toFixed(1)}% - ${(pos * 32).toFixed(1)}px)` }} />
      <div className="vp-detune-handle" style={{ left: `calc(${(pos * 100).toFixed(1)}% - ${(pos * 32).toFixed(1)}px)` }} />
    </div>
  );
}
