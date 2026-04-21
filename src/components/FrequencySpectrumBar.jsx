import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
const ZOOM_EASE = 0.25;

const SENSITIVITY_NORMAL = 0.5;
const SENSITIVITY_FINE = 0.1;

// Grab mode: vertical cursor motion adjusts volume. Scalar is in range-units / screen-height.
// Times getSensitivity() → normal ≈ 1 range/screen, fine ≈ 0.2 range/screen.
const GRAB_VOL_SCALAR = 2;

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

// Two-decimal readout for the "active" label that appears below a dragged/grabbed dot.
function formatActiveFreq(freq) {
  if (freq >= 10000) return `${(freq / 1000).toFixed(1)}k`;
  if (freq >= 1000) return `${(freq / 1000).toFixed(2)}k`;
  return freq.toFixed(2);
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

// All dots collision-resolve equally. Activation (dragging/grabbed) is purely
// a CSS/state concern — positions don't snap when an orb becomes active.
function resolveCollisions(targetsPx, dotSize) {
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
        resolved[a] -= overlap / 2;
        resolved[b] += overlap / 2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return resolved;
}

function FrequencySpectrumBar({ oscillatorCount = 4, fineTuneEnabled = false, onActiveChange }) {
  const [barWidth, setBarWidth] = useState(500 - 2 * BAR_H_PADDING);
  const [frequencies, setFrequencies] = useState(() => Array(oscillatorCount).fill(440));
  const [muted, setMuted] = useState(() => Array(oscillatorCount).fill(false));
  const [draggingDots, setDraggingDots] = useState(() => new Set());
  const [grabbedOscs, setGrabbedOscs] = useState(() => new Set());
  const [ghosts, setGhosts] = useState({}); // { [pointerId]: { index, x, y } } during drag
  const [grabCursor, setGrabCursor] = useState(null); // { x, y } in container coords while grabbed
  const [range, setRange] = useState({ logMin: ABSOLUTE_LOG_MIN, logMax: ABSOLUTE_LOG_MAX });
  const [shiftHeld, setShiftHeld] = useState(false);
  const [activeOrder, setActiveOrder] = useState([]); // indices sorted by first-activation

  const containerRef = useRef(null);
  const dragRef = useRef({});
  const rangeRef = useRef(range);
  const barWidthRef = useRef(barWidth);
  const grabbedRef = useRef(grabbedOscs);
  const fineTuneRef = useRef(fineTuneEnabled);
  const shiftRef = useRef(shiftHeld);
  const lastGrabXRef = useRef(null); // tracks cursor X between grab-driven frames
  const lastGrabYRef = useRef(null); // tracks cursor Y between grab-driven frames (volume)
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
    const arraysEqual = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const tick = () => {
      if (audioEngine.initialized) {
        try {
          const f = audioEngine.getAllFrequencies();
          const m = audioEngine.getAllMutedStates();
          if (f.length >= oscillatorCount && m.length >= oscillatorCount) {
            const newFreqs = f.slice(0, oscillatorCount);
            const newMuted = m.slice(0, oscillatorCount);
            setFrequencies((prev) => (arraysEqual(prev, newFreqs) ? prev : newFreqs));
            setMuted((prev) => (arraysEqual(prev, newMuted) ? prev : newMuted));

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
  const dotXs = useMemo(
    () => resolveCollisions(freqXs, DOT_SIZE),
    [freqXs]
  );

  const getSensitivity = () =>
    (fineTuneRef.current || shiftRef.current) ? SENSITIVITY_FINE : SENSITIVITY_NORMAL;

  const toggleGrab = (index) => {
    setGrabbedOscs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else {
        next.add(index);
        if (audioEngine.isMuted(index)) audioEngine.unmuteOscillator(index);
      }
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
    // Selecting a muted osc with the mouse unmutes it.
    if (audioEngine.isMuted(index)) audioEngine.unmuteOscillator(index);
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current[e.pointerId] = {
      index,
      containerLeft: rect.left,
      containerTop: rect.top,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
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
    const totalDx = e.clientX - drag.startX;
    const totalDy = e.clientY - drag.startY;
    if (!drag.didDrag && (totalDx * totalDx + totalDy * totalDy) > 4) {
      drag.didDrag = true;
    }
    if (drag.didDrag) {
      const deltaX = e.clientX - drag.lastX;
      const deltaY = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (deltaX !== 0 || deltaY !== 0) {
        const sens = getSensitivity();
        if (deltaX !== 0) {
          const r = rangeRef.current;
          const logDelta =
            (deltaX / barWidthRef.current) * (r.logMax - r.logMin) * sens;
          const curFreq = audioEngine.getFrequency(drag.index);
          audioEngine.setFrequency(
            drag.index,
            Math.max(FREQ_MIN, Math.min(FREQ_MAX, curFreq * 2 ** logDelta))
          );
        }
        if (deltaY !== 0) {
          const volDelta = (-deltaY / window.innerHeight) * GRAB_VOL_SCALAR * sens;
          const curVol = audioEngine.getVolume(drag.index);
          audioEngine.setVolume(
            drag.index,
            Math.max(0, Math.min(1, curVol + volDelta))
          );
        }
      }
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
      // Snap range to target instead of letting it ease over ~58 frames.
      // The post-release ease was causing 1s of re-renders, which on cold JIT
      // reads as a UI freeze.
      try {
        const f = audioEngine.getAllFrequencies();
        const target = computeTargetRange(f.slice(0, oscillatorCount));
        rangeRef.current = target;
        setRange(target);
      } catch { /* no-op */ }
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
        lastGrabYRef.current = e.clientY;
        return;
      }
      const deltaX = e.clientX - lastGrabXRef.current;
      const deltaY = e.clientY - lastGrabYRef.current;
      lastGrabXRef.current = e.clientX;
      lastGrabYRef.current = e.clientY;
      if (deltaX === 0 && deltaY === 0) return;

      const sens = getSensitivity();
      const r = rangeRef.current;
      const factor = deltaX !== 0
        ? 2 ** ((deltaX / barWidthRef.current) * (r.logMax - r.logMin) * sens)
        : 1;
      const volDelta = deltaY !== 0
        ? (-deltaY / window.innerHeight) * GRAB_VOL_SCALAR * sens
        : 0;

      for (const idx of grabbedRef.current) {
        if (factor !== 1) {
          const cur = audioEngine.getFrequency(idx);
          const next = Math.max(FREQ_MIN, Math.min(FREQ_MAX, cur * factor));
          audioEngine.setFrequency(idx, next);
        }
        if (volDelta !== 0) {
          const curVol = audioEngine.getVolume(idx);
          const nextVol = Math.max(0, Math.min(1, curVol + volDelta));
          audioEngine.setVolume(idx, nextVol);
        }
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
      lastGrabYRef.current = null;
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
      lastGrabYRef.current = mousePosRef.current.y;
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

  // When oscillators are removed, drop any drag/grab state that referenced them
  // before the next render tries to read frequencies[idx] at an out-of-range index.
  useEffect(() => {
    const filterSet = (s) => {
      const next = new Set();
      for (const i of s) if (i < oscillatorCount) next.add(i);
      return next.size === s.size ? s : next;
    };
    setDraggingDots((prev) => filterSet(prev));
    setGrabbedOscs((prev) => filterSet(prev));
    setActiveOrder((prev) => {
      const next = prev.filter((i) => i < oscillatorCount);
      return next.length === prev.length ? prev : next;
    });
    setGhosts((prev) => {
      let changed = false;
      const next = {};
      for (const pid in prev) {
        if (prev[pid].index < oscillatorCount) next[pid] = prev[pid];
        else changed = true;
      }
      return changed ? next : prev;
    });
    for (const pid of Object.keys(dragRef.current)) {
      if (dragRef.current[pid].index >= oscillatorCount) delete dragRef.current[pid];
    }
  }, [oscillatorCount]);

  // Notify parent of the current active set (dragging ∪ grabbed).
  // Bail-out when identical to prior set so we don't force parent re-renders.
  useEffect(() => {
    if (!onActiveChange) return;
    const next = new Set([...draggingDots, ...grabbedOscs]);
    onActiveChange((prev) => {
      if (prev instanceof Set && prev.size === next.size) {
        let same = true;
        for (const v of prev) if (!next.has(v)) { same = false; break; }
        if (same) return prev;
      }
      return next;
    });
  }, [draggingDots, grabbedOscs, onActiveChange]);

  // Reconcile active-order (first-selected-wins) when drag/grab sets change.
  useEffect(() => {
    setActiveOrder((prev) => {
      const activeSet = new Set([...draggingDots, ...grabbedOscs]);
      const filtered = prev.filter((i) => activeSet.has(i));
      const existing = new Set(filtered);
      for (const i of grabbedOscs) {
        if (!existing.has(i)) { filtered.push(i); existing.add(i); }
      }
      for (const i of draggingDots) {
        if (!existing.has(i)) { filtered.push(i); existing.add(i); }
      }
      // Bail if unchanged
      if (filtered.length === prev.length && filtered.every((v, i) => v === prev[i])) {
        return prev;
      }
      return filtered;
    });
  }, [draggingDots, grabbedOscs]);

  // Global safety-net cleanup for drag/grab state — protects against stuck
  // drags when pointerup is lost (browser chrome, right-click, capture drop,
  // pointer leaving the window, Cmd/Alt-Tab, tab switch, minimize, etc).
  useEffect(() => {
    const resetDragOnly = () => {
      const anyDrag = Object.keys(dragRef.current).length > 0;
      if (!anyDrag) return;
      dragRef.current = {};
      setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
      setGhosts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    };
    const releaseAll = () => {
      dragRef.current = {};
      setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
      setGhosts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      setGrabbedOscs((prev) => (prev.size === 0 ? prev : new Set()));
      setShiftHeld(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') releaseAll();
    };
    // If pointer leaves the document entirely (mouse goes off-screen), reset.
    const onPointerLeave = (e) => {
      if (e.relatedTarget === null && e.target === document.documentElement) {
        resetDragOnly();
      }
    };
    // Global pointerup/cancel as a fallback for when the dot never got its own.
    const onDocPointerUp = () => resetDragOnly();
    const onDocPointerCancel = () => resetDragOnly();

    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('pointerup', onDocPointerUp);
    document.addEventListener('pointercancel', onDocPointerCancel);
    return () => {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerCancel);
    };
  }, []);

  // Keyboard: 1-9/0 toggle grab; shift+digit (or shifted symbol) mutes; Esc releases.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Shift') {
        setShiftHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        releaseAllGrabs();
        // Also force-reset any stuck drag state.
        if (Object.keys(dragRef.current).length > 0) {
          dragRef.current = {};
          setDraggingDots((prev) => (prev.size === 0 ? prev : new Set()));
          setGhosts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
        }
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
            className="fsb-ghost fsb-ghost-drag"
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

      {(() => {
        // Greedy stacking: first-selected keeps row 0; each subsequent label takes the
        // lowest row where its X is at least MIN_SEP away from every label already there.
        const MIN_SEP = 55;
        const rowsPlaced = []; // rowsPlaced[r] = array of label X already placed at row r
        const placements = [];
        for (const idx of activeOrder) {
          if (frequencies[idx] === undefined || dotXs[idx] === undefined) continue;
          const x = dotXs[idx];
          let row = 0;
          while (true) {
            if (!rowsPlaced[row]) rowsPlaced[row] = [];
            const collides = rowsPlaced[row].some((ex) => Math.abs(ex - x) < MIN_SEP);
            if (!collides) {
              rowsPlaced[row].push(x);
              placements.push({ idx, row, x });
              break;
            }
            row++;
          }
        }
        return placements.map(({ idx, row, x }) => {
          const color = OSCILLATOR_COLORS[idx % OSCILLATOR_COLORS.length];
          return (
            <div
              key={`active-freq-${idx}`}
              className="fsb-active-freq"
              style={{
                left: x,
                top: BAR_TOP_Y + BAR_LINE_HEIGHT + 6 + row * 16,
                color,
              }}
            >
              {formatActiveFreq(frequencies[idx])}
            </div>
          );
        });
      })()}
    </div>
  );
}

export default memo(FrequencySpectrumBar);
