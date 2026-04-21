import { useEffect, useMemo, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';

const OSCILLATOR_COLORS = [
  '#ff4136', '#2ecc40', '#0074d9', '#ffdc00', '#bb8fce',
  '#85c1e9', '#82e0aa', '#f8b500', '#e74c3c', '#1abc9c',
];

const FREQ_MIN = 0.1;
const FREQ_MAX = 20000;
const DOT_SIZE = 20;
const BAR_LINE_HEIGHT = 16;
const BAR_H_PADDING = 16;
const DOT_GAP = 10;

const PADDING_RATIO = 0.15;
const MIN_LOG_SPAN = 0.5;
const ZOOM_EASE = 0.18;

const SENSITIVITY_NORMAL = 0.5;
const SENSITIVITY_FINE = 0.1;

const ABSOLUTE_LOG_MIN = Math.log2(FREQ_MIN);
const ABSOLUTE_LOG_MAX = Math.log2(FREQ_MAX);

// Adaptive tick density. Each level defines "nice" mantissas across every decade.
// At runtime, pick/fade levels so ~TARGET_TICK_COUNT ticks are on screen for any zoom.
const TICK_LEVELS = [
  { perDecade: 1, mantissas: [1] },
  { perDecade: 3, mantissas: [1, 2, 5] },
  { perDecade: 9, mantissas: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  {
    perDecade: 19,
    mantissas: [1, 1.1, 1.2, 1.3, 1.5, 1.7, 2, 2.3, 2.5, 2.8, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8],
  },
];
const TARGET_TICK_COUNT = 10;

function tickOpacityForRatio(ratio) {
  if (ratio < 0.3) return 0;
  if (ratio < 0.7) return (ratio - 0.3) / 0.4;      // fade in
  if (ratio < 1.5) return 1;                         // plateau
  if (ratio < 3.0) return 1 - (ratio - 1.5) / 1.5;   // fade out
  return 0;
}

const LOG2_10 = Math.log2(10);

function computeTicks(logMin, logMax) {
  const log10Min = logMin / LOG2_10;
  const log10Max = logMax / LOG2_10;
  const log10Span = log10Max - log10Min;
  if (log10Span <= 0) return [];

  // Max opacity across all levels that include this freq.
  const tickMap = new Map();
  for (const level of TICK_LEVELS) {
    const count = level.perDecade * log10Span;
    const opacity = tickOpacityForRatio(count / TARGET_TICK_COUNT);
    if (opacity <= 0) continue;

    const decadeStart = Math.floor(log10Min);
    const decadeEnd = Math.ceil(log10Max);
    for (let d = decadeStart; d <= decadeEnd; d++) {
      const decadeBase = 10 ** d;
      for (const m of level.mantissas) {
        const freq = m * decadeBase;
        if (freq < FREQ_MIN || freq > FREQ_MAX) continue;
        const log2Freq = Math.log2(freq);
        if (log2Freq < logMin || log2Freq > logMax) continue;
        const existing = tickMap.get(freq) || 0;
        if (opacity > existing) tickMap.set(freq, opacity);
      }
    }
  }
  return Array.from(tickMap, ([freq, opacity]) => ({ freq, opacity }));
}

const SHIFT_SYMBOL_TO_INDEX = {
  '!': 0, '@': 1, '#': 2, '$': 3, '%': 4,
  '^': 5, '&': 6, '*': 7, '(': 8, ')': 9,
};

function formatTick(freq) {
  const short = (n) => n.toFixed(2).replace(/\.?0+$/, '');
  if (freq >= 1000) return short(freq / 1000) + 'k';
  return short(freq);
}

const DOT_CENTER_Y = DOT_SIZE / 2;
const BAR_TOP_Y = DOT_SIZE + DOT_GAP;
const TOTAL_HEIGHT = BAR_TOP_Y + BAR_LINE_HEIGHT + 4;

function freqToFraction(freq, logMin, logMax) {
  const clamped = Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
  return (Math.log2(clamped) - logMin) / (logMax - logMin);
}

function computeTargetRange(freqs) {
  const valid = freqs
    .filter((f) => f > 0)
    .map((f) => Math.max(FREQ_MIN, Math.min(FREQ_MAX, f)));
  if (valid.length === 0) {
    return { logMin: ABSOLUTE_LOG_MIN, logMax: ABSOLUTE_LOG_MAX };
  }
  const logs = valid.map((f) => Math.log2(f));
  const logLo = Math.min(...logs);
  const logHi = Math.max(...logs);
  const innerSpan = Math.max(logHi - logLo, MIN_LOG_SPAN);
  const center = (logLo + logHi) / 2;
  const totalSpan = innerSpan / (1 - 2 * PADDING_RATIO);
  const paddedMin = center - totalSpan / 2;
  const paddedMax = center + totalSpan / 2;
  return {
    logMin: Math.max(ABSOLUTE_LOG_MIN, paddedMin),
    logMax: Math.min(ABSOLUTE_LOG_MAX, paddedMax),
  };
}

// Compact arrangement of N ghost circles around a cursor: 1 center, 2 horizontal,
// 3+ regular polygon at radius R. Total extent stays ≤ 2R + DOT_SIZE.
const GHOST_RING_RADIUS = 7;
function ghostOffset(i, total) {
  if (total <= 1) return { dx: 0, dy: 0 };
  if (total === 2) {
    return { dx: (i === 0 ? -1 : 1) * GHOST_RING_RADIUS, dy: 0 };
  }
  const angle = -Math.PI / 2 + (2 * Math.PI * i) / total;
  return {
    dx: GHOST_RING_RADIUS * Math.cos(angle),
    dy: GHOST_RING_RADIUS * Math.sin(angle),
  };
}

// Shrink a line segment so each endpoint lies on the circumference of a circle
// centered at the original endpoint, rather than the center. If the circles
// overlap, return null so no line is rendered.
function offsetLine(x1, y1, x2, y2, r1, r2) {
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

// Anchored dots (dragging / grabbed) stay pinned at their true freq position and
// push the rest out of the way. Non-anchored pairs split the overlap 50/50.
// Re-sorts each pass so dots can "flow around" an anchor moving through them.
function resolveCollisions(targetsPx, dotSize, anchoredSet) {
  const minGap = dotSize * 0.85;
  const resolved = [...targetsPx];
  if (resolved.length < 2) return resolved;

  for (let iter = 0; iter < 20; iter++) {
    const sorted = resolved.map((_, i) => i).sort((a, b) => resolved[a] - resolved[b]);
    let moved = false;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const gap = resolved[b] - resolved[a];
      if (gap < minGap) {
        const overlap = minGap - gap;
        const aAnchored = anchoredSet.has(a);
        const bAnchored = anchoredSet.has(b);
        if (aAnchored && bAnchored) continue; // both pinned — can't resolve
        if (aAnchored) resolved[b] += overlap;
        else if (bAnchored) resolved[a] -= overlap;
        else {
          resolved[a] -= overlap / 2;
          resolved[b] += overlap / 2;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return resolved;
}

export default function FrequencySpectrumBar({ oscillatorCount = 4, fineTuneEnabled = false }) {
  const [barWidth, setBarWidth] = useState(500 - 2 * BAR_H_PADDING);
  const [frequencies, setFrequencies] = useState(() => Array(oscillatorCount).fill(440));
  const [muted, setMuted] = useState(() => Array(oscillatorCount).fill(false));
  const [draggingDots, setDraggingDots] = useState(() => new Set());
  const [grabbedOscs, setGrabbedOscs] = useState(() => new Set());
  const [ghosts, setGhosts] = useState({}); // { [pointerId]: { index, x, y } } during drag
  const [grabCursor, setGrabCursor] = useState(null); // { x, y } in container coords while grabbed
  const [range, setRange] = useState({ logMin: ABSOLUTE_LOG_MIN, logMax: ABSOLUTE_LOG_MAX });
  const [shiftHeld, setShiftHeld] = useState(false);

  const containerRef = useRef(null);
  const dragRef = useRef({});
  const rangeRef = useRef(range);
  const barWidthRef = useRef(barWidth);
  const grabbedRef = useRef(grabbedOscs);
  const fineTuneRef = useRef(fineTuneEnabled);
  const shiftRef = useRef(shiftHeld);
  const lastGrabXRef = useRef(null); // tracks cursor X between grab-driven frames
  const mousePosRef = useRef({ x: 0, y: 0 }); // latest client-space cursor, always tracked

  useEffect(() => { barWidthRef.current = barWidth; }, [barWidth]);
  useEffect(() => { grabbedRef.current = grabbedOscs; }, [grabbedOscs]);
  useEffect(() => { fineTuneRef.current = fineTuneEnabled; }, [fineTuneEnabled]);
  useEffect(() => { shiftRef.current = shiftHeld; }, [shiftHeld]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setBarWidth(Math.max(100, entry.contentRect.width - 2 * BAR_H_PADDING));
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Auto-zoom runs continuously — even during drag/grab — so the spectrum extends
  // to follow freqs pushed toward the padded edges. Incremental delta-based interaction
  // below avoids the cursor-position feedback loop that would otherwise be a problem.
  useEffect(() => {
    let rafId;
    const tick = () => {
      if (audioEngine.initialized) {
        try {
          const f = audioEngine.getAllFrequencies();
          const m = audioEngine.getAllMutedStates();
          if (f.length >= oscillatorCount && m.length >= oscillatorCount) {
            const newFreqs = f.slice(0, oscillatorCount);
            setFrequencies(newFreqs);
            setMuted(m.slice(0, oscillatorCount));

            const target = computeTargetRange(newFreqs);
            const cur = rangeRef.current;
            const nextMin = cur.logMin + (target.logMin - cur.logMin) * ZOOM_EASE;
            const nextMax = cur.logMax + (target.logMax - cur.logMax) * ZOOM_EASE;
            if (
              Math.abs(nextMin - cur.logMin) > 0.0001 ||
              Math.abs(nextMax - cur.logMax) > 0.0001
            ) {
              rangeRef.current = { logMin: nextMin, logMax: nextMax };
              setRange(rangeRef.current);
            }
          }
        } catch {
          // ignore
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(rafId);
  }, [oscillatorCount]);

  const freqXs = useMemo(
    () => frequencies.map((f) => BAR_H_PADDING + freqToFraction(f, range.logMin, range.logMax) * barWidth),
    [frequencies, barWidth, range.logMin, range.logMax]
  );
  const anchored = useMemo(() => {
    const s = new Set(draggingDots);
    for (const g of grabbedOscs) s.add(g);
    return s;
  }, [draggingDots, grabbedOscs]);
  const dotXs = useMemo(
    () => resolveCollisions(freqXs, DOT_SIZE, anchored),
    [freqXs, anchored]
  );

  const getSensitivity = () =>
    (fineTuneRef.current || shiftRef.current) ? SENSITIVITY_FINE : SENSITIVITY_NORMAL;

  const toggleGrab = (index) => {
    setGrabbedOscs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const releaseAllGrabs = () => {
    setGrabbedOscs((prev) => (prev.size === 0 ? prev : new Set()));
  };

  const handlePointerDown = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current[e.pointerId] = {
      index,
      containerLeft: rect.left,
      containerTop: rect.top,
      startX: e.clientX,
      lastX: e.clientX,
      didDrag: false,
    };
    setDraggingDots((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
    setGhosts((prev) => ({
      ...prev,
      [e.pointerId]: { index, x: e.clientX - rect.left, y: e.clientY - rect.top },
    }));
  };

  const handlePointerMove = (e) => {
    const drag = dragRef.current[e.pointerId];
    if (!drag) return;
    e.preventDefault();
    if (!drag.didDrag && Math.abs(e.clientX - drag.startX) > 2) {
      drag.didDrag = true;
    }
    if (drag.didDrag) {
      // Incremental: per-frame delta × current sensitivity × current log-per-px.
      // Keeps sensitivity changes (shift/fine-tune) from retroactively scaling
      // the accumulated motion, and lets auto-zoom run continuously.
      const delta = e.clientX - drag.lastX;
      if (delta !== 0) {
        const r = rangeRef.current;
        const logDelta =
          (delta / barWidthRef.current) * (r.logMax - r.logMin) * getSensitivity();
        const curFreq = audioEngine.getFrequency(drag.index);
        const newFreq = Math.max(
          FREQ_MIN,
          Math.min(FREQ_MAX, curFreq * 2 ** logDelta)
        );
        audioEngine.setFrequency(drag.index, newFreq);
      }
      drag.lastX = e.clientX;
    }
    const x = e.clientX - drag.containerLeft;
    const y = e.clientY - drag.containerTop;
    setGhosts((prev) => ({ ...prev, [e.pointerId]: { index: drag.index, x, y } }));
  };

  const handlePointerUp = (e, cancelled = false) => {
    const drag = dragRef.current[e.pointerId];
    if (!drag) return;
    const { index, didDrag } = drag;
    delete dragRef.current[e.pointerId];
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }

    if (!didDrag && !cancelled) {
      toggleGrab(index);
    } else if (didDrag && !cancelled) {
      releaseAllGrabs();
    }

    setDraggingDots((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    setGhosts((prev) => {
      const next = { ...prev };
      delete next[e.pointerId];
      return next;
    });
  };

  // Always-on cursor tracking. Uses pointermove so it continues to fire even when
  // a dot's pointermove handler calls preventDefault (which would suppress mousemove).
  // Pointer events bubble to document during setPointerCapture, so this listener
  // sees every cursor movement — during drag, grab, or idle.
  useEffect(() => {
    const onPointerMove = (e) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };

      if (grabbedRef.current.size === 0) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setGrabCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });

      if (lastGrabXRef.current === null) {
        lastGrabXRef.current = e.clientX;
        return;
      }
      const delta = e.clientX - lastGrabXRef.current;
      lastGrabXRef.current = e.clientX;
      if (delta === 0) return;

      const r = rangeRef.current;
      const logDelta =
        (delta / barWidthRef.current) * (r.logMax - r.logMin) * getSensitivity();
      const factor = 2 ** logDelta;
      for (const idx of grabbedRef.current) {
        const cur = audioEngine.getFrequency(idx);
        const next = Math.max(FREQ_MIN, Math.min(FREQ_MAX, cur * factor));
        audioEngine.setFrequency(idx, next);
      }
    };
    document.addEventListener('pointermove', onPointerMove);
    return () => document.removeEventListener('pointermove', onPointerMove);
  }, []);

  // On transitions in the grab set: reset anchors on N→0, seed ghost on 0→N
  // so the ghost is visible immediately after a keyboard grab (even without mouse motion).
  useEffect(() => {
    if (grabbedOscs.size === 0) {
      setGrabCursor(null);
      lastGrabXRef.current = null;
      return;
    }
    if (lastGrabXRef.current === null) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setGrabCursor({
          x: mousePosRef.current.x - rect.left,
          y: mousePosRef.current.y - rect.top,
        });
      }
      lastGrabXRef.current = mousePosRef.current.x;
    }
  }, [grabbedOscs]);

  // Click-outside to release grabs.
  useEffect(() => {
    if (grabbedOscs.size === 0) return;
    const handleClick = (e) => {
      const container = containerRef.current;
      if (container && container.contains(e.target)) return;
      releaseAllGrabs();
    };
    // Defer attachment so the click that toggled grab on doesn't immediately release.
    const id = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', handleClick);
    };
  }, [grabbedOscs]);

  // Keyboard: 1-9/0 toggle grab; shift+digit (or shifted symbol) mutes; Esc releases.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Shift') {
        setShiftHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        releaseAllGrabs();
        return;
      }
      if (e.key >= '0' && e.key <= '9') {
        const index = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
        if (index < oscillatorCount) {
          if (e.shiftKey) {
            audioEngine.toggleMute(index);
          } else {
            toggleGrab(index);
          }
        }
        return;
      }
      if (SHIFT_SYMBOL_TO_INDEX[e.key] !== undefined) {
        const index = SHIFT_SYMBOL_TO_INDEX[e.key];
        if (index < oscillatorCount) audioEngine.toggleMute(index);
      }
    };
    const handleKeyUp = (e) => {
      if (e.key === 'Shift') setShiftHeld(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, [oscillatorCount]);

  const visibleTicks = useMemo(
    () => computeTicks(range.logMin, range.logMax),
    [range.logMin, range.logMax]
  );

  return (
    <div
      className="freq-spectrum-bar"
      ref={containerRef}
      style={{ height: TOTAL_HEIGHT }}
    >
      <div
        className="fsb-track"
        style={{
          left: BAR_H_PADDING,
          top: BAR_TOP_Y,
          width: barWidth,
          height: BAR_LINE_HEIGHT,
        }}
      >
        {visibleTicks.map(({ freq, opacity }) => {
          const x = freqToFraction(freq, range.logMin, range.logMax) * barWidth;
          return (
            <div key={freq} className="fsb-tick" style={{ left: x, opacity }}>
              <span className="fsb-tick-label">{formatTick(freq)}</span>
            </div>
          );
        })}
        {frequencies.map((f, i) => {
          const x = freqToFraction(f, range.logMin, range.logMax) * barWidth;
          const isActive = draggingDots.has(i) || grabbedOscs.has(i);
          const color = OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length];
          return (
            <div
              key={i}
              className={`fsb-freq-marker ${muted[i] ? 'muted' : ''} ${isActive ? 'active' : ''}`}
              style={{ left: x, background: color, '--marker-color': color }}
            />
          );
        })}
      </div>

      <svg className="fsb-lines" width="100%" height={TOTAL_HEIGHT} style={{ overflow: 'visible' }}>
        {frequencies.map((_, i) => {
          const color = OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length];
          const isActive = draggingDots.has(i) || grabbedOscs.has(i);
          const opacity = muted[i] ? 0.15 : (isActive ? 0.6 : 0.35);
          const seg = offsetLine(dotXs[i], DOT_CENTER_Y, freqXs[i], BAR_TOP_Y, DOT_SIZE / 2, 0);
          if (!seg) return null;
          return (
            <line
              key={`dot2bar-${i}`}
              x1={seg.x1}
              y1={seg.y1}
              x2={seg.x2}
              y2={seg.y2}
              stroke={color}
              strokeOpacity={opacity}
              strokeWidth={isActive ? 1.5 : 1}
            />
          );
        })}
        {Object.entries(ghosts).map(([pid, g]) => {
          const color = OSCILLATOR_COLORS[g.index % OSCILLATOR_COLORS.length];
          const seg = offsetLine(dotXs[g.index], DOT_CENTER_Y, g.x, g.y, DOT_SIZE / 2, DOT_SIZE / 2);
          if (!seg) return null;
          return (
            <line
              key={`ghost-${pid}`}
              x1={seg.x1}
              y1={seg.y1}
              x2={seg.x2}
              y2={seg.y2}
              stroke={color}
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          );
        })}
        {grabCursor &&
          Array.from(grabbedOscs).map((idx, i, arr) => {
            const color = OSCILLATOR_COLORS[idx % OSCILLATOR_COLORS.length];
            const { dx, dy } = ghostOffset(i, arr.length);
            const seg = offsetLine(
              dotXs[idx], DOT_CENTER_Y,
              grabCursor.x + dx, grabCursor.y + dy,
              DOT_SIZE / 2, DOT_SIZE / 2
            );
            if (!seg) return null;
            return (
              <line
                key={`grab-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                stroke={color}
                strokeOpacity={0.5}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            );
          })}
      </svg>

      {frequencies.map((_, i) => {
        const color = OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length];
        const isDragging = draggingDots.has(i);
        const isGrabbed = grabbedOscs.has(i);
        const classes = ['fsb-dot'];
        if (muted[i]) classes.push('muted');
        if (isDragging) classes.push('dragging');
        else if (isGrabbed) classes.push('grabbed');
        return (
          <div
            key={i}
            className={classes.join(' ')}
            style={{
              left: dotXs[i] - DOT_SIZE / 2,
              top: DOT_CENTER_Y - DOT_SIZE / 2,
              width: DOT_SIZE,
              height: DOT_SIZE,
              '--dot-color': color,
            }}
            onPointerDown={(e) => handlePointerDown(e, i)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={(e) => handlePointerUp(e, true)}
          />
        );
      })}

      {frequencies.map((_, i) => {
        const color = OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length];
        return (
          <div
            key={`label-${i}`}
            className={`fsb-dot-label ${muted[i] ? 'muted' : ''}`}
            style={{ left: dotXs[i], top: -2, color }}
          >
            {i + 1}
          </div>
        );
      })}

      {Object.entries(ghosts).map(([pid, g]) => {
        const color = OSCILLATOR_COLORS[g.index % OSCILLATOR_COLORS.length];
        return (
          <div
            key={`ghost-${pid}`}
            className="fsb-ghost"
            style={{
              left: g.x - DOT_SIZE / 2,
              top: g.y - DOT_SIZE / 2,
              width: DOT_SIZE,
              height: DOT_SIZE,
              '--dot-color': color,
            }}
          />
        );
      })}

      {grabCursor &&
        Array.from(grabbedOscs).map((idx, i, arr) => {
          const color = OSCILLATOR_COLORS[idx % OSCILLATOR_COLORS.length];
          const { dx, dy } = ghostOffset(i, arr.length);
          return (
            <div
              key={`grab-ghost-${idx}`}
              className="fsb-ghost"
              style={{
                left: grabCursor.x - DOT_SIZE / 2 + dx,
                top: grabCursor.y - DOT_SIZE / 2 + dy,
                width: DOT_SIZE,
                height: DOT_SIZE,
                '--dot-color': color,
              }}
            />
          );
        })}
    </div>
  );
}
