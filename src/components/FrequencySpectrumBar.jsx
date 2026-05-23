import { memo, useEffect, useMemo, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import palette, { useTheme } from '../theme/palette';
import { isEditableTarget } from '../hooks/keyboardUtils';
import GlobalDetuneOrb from './GlobalDetuneOrb';

const FREQ_MIN = 0.1;
const FREQ_MAX = 20000;
const DOT_SIZE = 35;
const BAR_LINE_HEIGHT = 30;
const BAR_H_PADDING = 16;
const DOT_GAP = 14;

const PADDING_RATIO = 0.15;
const MIN_LOG_SPAN = 0.5;
const ZOOM_EASE = 0.25;

const SENSITIVITY_NORMAL = 0.5;
const SENSITIVITY_FINE = 0.1;

// Grab mode: vertical cursor motion adjusts volume. Scalar is in range-units / screen-height.
// Times getSensitivity() → normal ≈ 1 range/screen, fine ≈ 0.2 range/screen.
const GRAB_VOL_SCALAR = 2;

// Edge auto-pan: while dragging or grabbing, holding the pointer in the outer
// EDGE_ZONE of the *canvas* continuously drifts frequency toward that edge.
// The canvas is the centered min(viewport, CANVAS_MAX_WIDTH) region — same
// horizontal frame as the on-screen keyboard tray — so on wide displays the
// dragging area doesn't sprawl to the screen edges. Pulling toward the
// canvas edge scrolls the spectrum regardless of where the (narrower) bar
// sits inside it.
// Rate ramps linearly from 0 at the zone boundary to MAX_EDGE_PAN_RATE at the
// canvas edge, in octaves/sec. dt is clamped so a backgrounded tab can't jump.
// Zone width = 10% of canvas width = min(10vw, EDGE_ZONE_MAX_PX).
const CANVAS_MAX_WIDTH = 1200;
const EDGE_ZONE_FRAC = 0.10;
const EDGE_ZONE_MAX_PX = 120;
const MAX_EDGE_PAN_RATE = 2.0;
const MAX_EDGE_PAN_DT = 0.1;

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

function computeEdgeRate(clientX) {
  const vw = window.innerWidth;
  const canvasWidth = Math.min(vw, CANVAS_MAX_WIDTH);
  const canvasLeft = Math.max(0, (vw - CANVAS_MAX_WIDTH) / 2);
  const canvasRight = canvasLeft + canvasWidth;
  const zone = Math.min(EDGE_ZONE_FRAC * canvasWidth, EDGE_ZONE_MAX_PX);
  if (zone <= 0) return 0;
  if (clientX < canvasLeft + zone) {
    const depth = Math.min(1, (canvasLeft + zone - clientX) / zone);
    return -depth * MAX_EDGE_PAN_RATE;
  }
  if (clientX > canvasRight - zone) {
    const depth = Math.min(1, (clientX - (canvasRight - zone)) / zone);
    return depth * MAX_EDGE_PAN_RATE;
  }
  return 0;
}

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

// Edge-pan vector arrow that appears beside an actively-dragged/grabbed orb
// while the pointer is in the edge zone. Anchored on the OPPOSITE side from
// the push direction so the arrow stays on-screen when the orb itself is at
// the very edge of a small viewport: pushing right → arrow on the orb's
// left, pointing right.
const EDGE_ARROW_MAX_LEN = 60;
const EDGE_ARROW_ORB_GAP = DOT_SIZE / 2 + 2;
const EDGE_ARROW_HEAD = 7;

function renderEdgeArrow(key, x, y, edgeRate, color) {
  if (!edgeRate) return null;
  const magnitude = Math.min(1, Math.abs(edgeRate) / MAX_EDGE_PAN_RATE);
  if (magnitude <= 0) return null;
  const direction = edgeRate > 0 ? 1 : -1;
  const len = EDGE_ARROW_MAX_LEN * magnitude;
  const tipX = x - direction * EDGE_ARROW_ORB_GAP;
  const tailX = tipX - direction * len;
  const headBackX = tipX - direction * EDGE_ARROW_HEAD;
  const headHalf = EDGE_ARROW_HEAD * 0.75;
  return (
    <g key={key} className="fsb-edge-arrow">
      <line
        x1={tailX}
        y1={y}
        x2={tipX}
        y2={y}
        stroke={color}
        strokeWidth={3}
        strokeOpacity={0.95}
        strokeLinecap="round"
      />
      <polygon
        points={`${tipX},${y} ${headBackX},${y - headHalf} ${headBackX},${y + headHalf}`}
        fill={color}
      />
    </g>
  );
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

// Dots collision-resolve so they don't visually overlap. Muted dots
// participate too — they're rendered (dimmed) and need to push the
// visible orbs aside instead of stacking under them.
function resolveCollisions(targetsPx, dotSize) {
  const minGap = dotSize * 0.85;
  const resolved = [...targetsPx];
  if (resolved.length < 2) return resolved;

  for (let iter = 0; iter < 20; iter++) {
    const sorted = resolved
      .map((_, i) => i)
      .sort((a, b) => resolved[a] - resolved[b]);
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

function FrequencySpectrumBar({
  oscillatorCount = 4,
  fineTuneEnabled = false,
  onActiveChange,
  extraActive,
  // When true (e.g. the keyboard tray is open), grabbing or starting a
  // drag on a muted orb does NOT auto-unmute it. The orbs in this mode
  // serve primarily as a tuning interface for the keyboard, so we
  // shouldn't surprise-restart drone playback when the user nudges one.
  suppressAutoUnmute = false,
  // Side-adornment hooks: the "all" orb sits to the left, +/- oscillator
  // count buttons to the right of the spectrum-bar pill.
  onOscillatorCountChange,
  maxOscillators = 10,
  // Keybind-labels toggle — the "?" button on the right rail flips
  // whether the on-screen piano shows its Z/X/letter caption overlay.
  // State is owned by App; the bar only renders the button.
  showKbdLabels = false,
  onShowKbdLabelsChange,
}) {
  // Subscribe to theme changes so JSX re-renders when the user flips
  // palette in settings — every osc-color lookup below reads live from
  // the palette singleton.
  useTheme();
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
  // Refs to each orb / label DOM element so the keyboard-voice rAF loop
  // can flip a `kbd-active` class and toggle bubble states without
  // round-tripping through React state.
  const dotElsRef = useRef([]);
  const labelElsRef = useRef([]);
  const rangeRef = useRef(range);
  const barWidthRef = useRef(barWidth);
  const grabbedRef = useRef(grabbedOscs);
  const fineTuneRef = useRef(fineTuneEnabled);
  const shiftRef = useRef(shiftHeld);
  const lastGrabXRef = useRef(null); // tracks cursor X between grab-driven frames
  const lastGrabYRef = useRef(null); // tracks cursor Y between grab-driven frames (volume)
  const mousePosRef = useRef({ x: 0, y: 0 }); // latest client-space cursor, always tracked
  const grabEdgeRateRef = useRef(0); // octaves/sec drift for grabbed oscs, set from cursor X
  const lastEdgePanTimeRef = useRef(null); // performance.now() of previous edge-pan tick

  useEffect(() => { barWidthRef.current = barWidth; }, [barWidth]);
  useEffect(() => { grabbedRef.current = grabbedOscs; }, [grabbedOscs]);
  useEffect(() => { fineTuneRef.current = fineTuneEnabled; }, [fineTuneEnabled]);
  useEffect(() => { shiftRef.current = shiftHeld; }, [shiftHeld]);

  // Keyboard-voice glow loop. Each frame: ask the voice manager which
  // voices are sounding, group them by drone slot (via tuning), and
  // imperatively flip a `kbd-active` class on the matching orb + label
  // for octave-0 voices. ±1 / ±2 voices light up small bubbles flanking
  // the label (IG-photo style — far-octave lit while the in-between
  // bubble stays dim if there's nothing playing closer in).
  //
  // Direct DOM mutation rather than React state because envelope amps
  // change every audio block and a setState rerender on each tick would
  // thrash the spectrum bar's draggable elements.
  useEffect(() => {
    const ACTIVE_THRESHOLD = 0.05; // env amp below this counts as silent
    let raf = null;
    const tick = () => {
      const voices = keyboardVoiceManager.getActiveVoices();
      // slot → Map(octave → maxAmpAtThatOctave)
      const slotOctAmps = new Map();
      for (const v of voices) {
        if (v.slot < 0) continue;
        let octs = slotOctAmps.get(v.slot);
        if (!octs) { octs = new Map(); slotOctAmps.set(v.slot, octs); }
        const cur = octs.get(v.octave) || 0;
        if (v.amp > cur) octs.set(v.octave, v.amp);
      }

      const dots = dotElsRef.current;
      const labels = labelElsRef.current;
      const totalSlots = Math.max(dots.length, labels.length);
      const MAX_OCT = 5;
      for (let i = 0; i < totalSlots; i++) {
        const octs = slotOctAmps.get(i);

        // Orb / label "kbd-active" fires when ANY octave of this slot's
        // scale degree is sounding — exact pitch or octaves above /
        // below. The bubble columns already show *which* specific
        // octaves are active; the orb itself just signals "this slot
        // is being played."
        let maxAmp = 0;
        if (octs) {
          for (const a of octs.values()) {
            if (a > maxAmp) maxAmp = a;
          }
        }
        const slotActive = maxAmp > ACTIVE_THRESHOLD;

        // Skip while user is actively dragging/grabbing — those states
        // have their own dim styling and shouldn't flicker on retrigger.
        const dot = dots[i];
        if (dot) {
          const interacting = dot.classList.contains('dragging') ||
                              dot.classList.contains('grabbed');
          dot.classList.toggle('kbd-active', !interacting && slotActive);
        }

        const label = labels[i];
        if (!label) continue;
        label.classList.toggle('kbd-active', slotActive);

        // For each side: a bubble at distance `n` is
        //   'on'  if octave (sign·n) is currently sounding
        //   'dim' if any further-out octave on this side is sounding
        //         (so n is an "in-between" placeholder, IG-pagination
        //         style)
        //   ''    (hidden) otherwise
        const updateSide = (sign) => {
          // Pre-compute active flags up to MAX_OCT so we can answer
          // "is anything further than n active" in one pass.
          const active = new Array(MAX_OCT + 1).fill(false); // index 1..MAX_OCT
          let maxActive = 0;
          for (let n = 1; n <= MAX_OCT; n++) {
            const a = (octs && octs.get(sign * n)) || 0;
            if (a > ACTIVE_THRESHOLD) {
              active[n] = true;
              if (n > maxActive) maxActive = n;
            }
          }
          for (let n = 1; n <= MAX_OCT; n++) {
            const oct = sign * n;
            const sel = oct > 0 ? `+${oct}` : `${oct}`;
            const el = label.querySelector(`[data-octave="${sel}"]`);
            if (!el) continue;
            if (active[n])       el.dataset.state = 'on';
            else if (n < maxActive) el.dataset.state = 'dim';
            else                 el.dataset.state = '';
          }
        };
        updateSide(-1);
        updateSide(1);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, []);

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
          // Edge auto-pan: drift toward the edge for any drag/grab pointer in the zone.
          // Done before reading frequencies so this frame's render sees the new values.
          let anyEdgePan = false;
          for (const pid in dragRef.current) {
            if (dragRef.current[pid].edgeRate) { anyEdgePan = true; break; }
          }
          if (grabbedRef.current.size > 0 && grabEdgeRateRef.current) anyEdgePan = true;

          if (anyEdgePan) {
            const now = performance.now();
            const dt = lastEdgePanTimeRef.current === null
              ? 0
              : Math.min(MAX_EDGE_PAN_DT, (now - lastEdgePanTimeRef.current) / 1000);
            lastEdgePanTimeRef.current = now;
            if (dt > 0) {
              const sens = (fineTuneRef.current || shiftRef.current) ? SENSITIVITY_FINE : SENSITIVITY_NORMAL;
              for (const pid in dragRef.current) {
                const d = dragRef.current[pid];
                if (!d.edgeRate) continue;
                const cur = audioEngine.getFrequency(d.index);
                const next = Math.max(FREQ_MIN, Math.min(FREQ_MAX, cur * 2 ** (d.edgeRate * dt * sens)));
                if (next !== cur) audioEngine.setFrequency(d.index, next);
              }
              if (grabbedRef.current.size > 0 && grabEdgeRateRef.current) {
                const factor = 2 ** (grabEdgeRateRef.current * dt * sens);
                for (const idx of grabbedRef.current) {
                  const cur = audioEngine.getFrequency(idx);
                  const next = Math.max(FREQ_MIN, Math.min(FREQ_MAX, cur * factor));
                  if (next !== cur) audioEngine.setFrequency(idx, next);
                }
              }
            }
          } else {
            lastEdgePanTimeRef.current = null;
          }

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
        if (!suppressAutoUnmute && !audioEngine.paused && audioEngine.isMuted(index)) {
          audioEngine.unmuteOscillator(index);
        }
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
    // Selecting a muted osc with the mouse unmutes it — UNLESS the
    // keyboard tray is up (then the orbs are a tuning UI for the
    // keyboard and shouldn't kick the drone back on by surprise), and
    // never when the drone bus is paused (a paused drone shouldn't be
    // restarted by a stray click). Drag-confirm in handlePointerMove
    // applies its own unmute rule that overrides suppressAutoUnmute.
    if (!suppressAutoUnmute && !audioEngine.paused && audioEngine.isMuted(index)) {
      audioEngine.unmuteOscillator(index);
    }
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
      [e.pointerId]: { index, x: e.clientX - rect.left, y: e.clientY - rect.top, edgeRate: 0 },
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
      // Confirmed drag: unmute the orb regardless of suppressAutoUnmute
      // (i.e. even when the keyboard tray is up), but ONLY while the drone
      // bus is playing — a drag with drones paused shouldn't surprise-restart
      // playback. Tap-only interactions still go through toggleGrab and
      // honor suppressAutoUnmute as before.
      if (!audioEngine.paused && audioEngine.isMuted(drag.index)) {
        audioEngine.unmuteOscillator(drag.index);
      }
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
      drag.edgeRate = computeEdgeRate(e.clientX);
    } else {
      drag.edgeRate = 0;
    }
    const x = e.clientX - drag.containerLeft;
    const y = e.clientY - drag.containerTop;
    setGhosts((prev) => ({
      ...prev,
      [e.pointerId]: { index: drag.index, x, y, edgeRate: drag.edgeRate || 0 },
    }));
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
      const rate = computeEdgeRate(e.clientX);
      setGrabCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top, edgeRate: rate });
      grabEdgeRateRef.current = rate;

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
      grabEdgeRateRef.current = 0;
      return;
    }
    if (lastGrabXRef.current === null) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setGrabCursor({
          x: mousePosRef.current.x - rect.left,
          y: mousePosRef.current.y - rect.top,
          edgeRate: 0,
        });
      }
      lastGrabXRef.current = mousePosRef.current.x;
      lastGrabYRef.current = mousePosRef.current.y;
    }
  }, [grabbedOscs]);

  // Click-anywhere-but-a-dot to release grabs. Clicks on a dot have their own
  // toggle behavior (via pointerup → toggleGrab); clicks on the bar background,
  // ticks, or anywhere else in the document should release the grab.
  useEffect(() => {
    if (grabbedOscs.size === 0) return;
    const handleClick = (e) => {
      if (e.target.closest && e.target.closest('.fsb-dot')) return;
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
      if (isEditableTarget(e.target)) return;
      // Bail on Cmd/Ctrl/Alt so OS-level chords (Cmd+Tab, Cmd+1, etc.)
      // don't trigger grabs or mute toggles.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
    <>
      <div className="orb-backdrop" />
      {/* Viewport-spanning dotted lines marking where edge auto-pan engages.
          Only shown during an active drag or grab — otherwise they're visual
          noise. CSS positions them at the 1200px canvas inset (matching the
          keyboard tray); see computeEdgeRate() for the matching JS math. */}
      {(draggingDots.size > 0 || grabbedOscs.size > 0) && (
        <>
          <div className="fsb-edge-zone-line fsb-edge-zone-line-left" aria-hidden="true" />
          <div className="fsb-edge-zone-line fsb-edge-zone-line-right" aria-hidden="true" />
        </>
      )}
      <div className="fsb-row" style={{ height: TOTAL_HEIGHT }}>
      <div className="fsb-side fsb-side-left">
        <GlobalDetuneOrb />
      </div>
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
          const isActive = draggingDots.has(i) || grabbedOscs.has(i) || extraActive?.has(i);
          const color = palette.oscColor(i, oscillatorCount);
          return (
            <div
              key={i}
              className={`fsb-freq-marker ${muted[i] ? 'muted' : ''} ${isActive ? 'active' : ''}`}
              style={{ left: x, background: color, '--marker-color': color }}
            />
          );
        })}
      </div>


      {(() => {
        const homeY = DOT_CENTER_Y;
        const homeR = DOT_SIZE / 2;
        const ghostYOffset = 0;
        const ghostR = DOT_SIZE / 2;
        return (
          <svg className="fsb-lines" width="100%" height={TOTAL_HEIGHT} style={{ overflow: 'visible' }}>
            {frequencies.map((_, i) => {
              // Lines stay visible for muted orbs too — same opacity treatment
              // as unmuted, since the line just maps the orb to its position on
              // the spectrum bar (it's not a "playing" signifier).
              const color = palette.oscColor(i, oscillatorCount);
              const isActive = draggingDots.has(i) || grabbedOscs.has(i);
              const opacity = isActive ? 0.6 : 0.35;
              const seg = offsetLine(dotXs[i], homeY, freqXs[i], BAR_TOP_Y, homeR, 0);
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
              const color = palette.oscColor(g.index, oscillatorCount);
              const seg = offsetLine(
                dotXs[g.index], homeY,
                g.x, g.y + ghostYOffset,
                homeR, ghostR
              );
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
                />
              );
            })}
            {grabCursor &&
              Array.from(grabbedOscs).map((idx, i, arr) => {
                const color = palette.oscColor(idx, oscillatorCount);
                const { dx, dy } = ghostOffset(i, arr.length);
                const seg = offsetLine(
                  dotXs[idx], homeY,
                  grabCursor.x + dx, grabCursor.y + dy + ghostYOffset,
                  homeR, ghostR
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
                  />
                );
              })}
            {Object.entries(ghosts).map(([pid, g]) =>
              renderEdgeArrow(
                `drag-arrow-${pid}`,
                g.x,
                g.y + ghostYOffset,
                g.edgeRate,
                palette.oscColor(g.index, oscillatorCount)
              )
            )}
            {grabCursor &&
              Array.from(grabbedOscs).map((idx, i, arr) => {
                const { dx, dy } = ghostOffset(i, arr.length);
                return renderEdgeArrow(
                  `grab-arrow-${idx}`,
                  grabCursor.x + dx,
                  grabCursor.y + dy + ghostYOffset,
                  grabCursor.edgeRate,
                  palette.oscColor(idx, oscillatorCount)
                );
              })}
          </svg>
        );
      })()}

      {frequencies.map((_, i) => {
        const color = palette.oscColor(i, oscillatorCount);
        const isDragging = draggingDots.has(i);
        const isGrabbed = grabbedOscs.has(i);
        // "Boosted" = externally marked active (fader fine-tune selection)
        // while the dot is not currently being dragged/grabbed
        // from the bar. Gives the home orb the same bright, glowy treatment
        // the drag ghost has — so the user can see which osc they're
        // affecting from another control.
        const isBoosted = !isDragging && !isGrabbed && extraActive?.has(i);
        const classes = ['fsb-dot'];
        if (muted[i]) classes.push('muted');
        if (isDragging) classes.push('dragging');
        else if (isGrabbed) classes.push('grabbed');
        if (isBoosted) classes.push('boosted');
        return (
          <div
            key={i}
            ref={(el) => { dotElsRef.current[i] = el; }}
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

      {frequencies.map((f, i) => {
        const color = palette.oscColor(i, oscillatorCount);
        const isActive = draggingDots.has(i) || grabbedOscs.has(i);
        return (
          <div
            key={`label-${i}`}
            ref={(el) => { labelElsRef.current[i] = el; }}
            className={`fsb-dot-label ${muted[i] ? 'muted' : ''} ${isActive ? 'active-freq' : ''}`}
            style={{ left: dotXs[i], top: -2, color }}
          >
            {/* Octave columns flanking the number. Vertical stacks of
                up to 5 bubbles per side. Looked up by `data-octave`
                from the rAF tick. Order chosen so flex-direction:
                column places the closest-to-root bubble where the user
                wants it: TOP of left col (-1) and BOTTOM of right col
                (+1). */}
            <span className="fsb-octave-col fsb-octave-col-left">
              <span className="fsb-octave-bubble" data-octave="-1" />
              <span className="fsb-octave-bubble" data-octave="-2" />
              <span className="fsb-octave-bubble" data-octave="-3" />
              <span className="fsb-octave-bubble" data-octave="-4" />
              <span className="fsb-octave-bubble" data-octave="-5" />
            </span>
            <span className="fsb-label-text">
              {isActive ? formatActiveFreq(f) : i + 1}
            </span>
            <span className="fsb-octave-col fsb-octave-col-right">
              <span className="fsb-octave-bubble" data-octave="+5" />
              <span className="fsb-octave-bubble" data-octave="+4" />
              <span className="fsb-octave-bubble" data-octave="+3" />
              <span className="fsb-octave-bubble" data-octave="+2" />
              <span className="fsb-octave-bubble" data-octave="+1" />
            </span>
          </div>
        );
      })}

      {Object.entries(ghosts).map(([pid, g]) => {
        const color = palette.oscColor(g.index, oscillatorCount);
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
          const color = palette.oscColor(idx, oscillatorCount);
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
      <div className="fsb-side fsb-side-right">
        <button
          type="button"
          className="fsb-count-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount - 1)}
          disabled={oscillatorCount <= 2}
          title="Remove oscillator"
          aria-label="Remove oscillator"
        >−</button>
        <button
          type="button"
          className="fsb-count-btn"
          onClick={() => onOscillatorCountChange?.(oscillatorCount + 1)}
          disabled={oscillatorCount >= maxOscillators}
          title="Add oscillator"
          aria-label="Add oscillator"
        >+</button>
        <button
          type="button"
          className={`fsb-count-btn fsb-help-btn${showKbdLabels ? ' is-active' : ''}`}
          onClick={() => onShowKbdLabelsChange?.(!showKbdLabels)}
          aria-pressed={showKbdLabels}
          title={showKbdLabels ? 'Hide keybind labels on the piano' : 'Show keybind labels on the piano'}
          aria-label="Toggle keybind labels"
        >?</button>
      </div>
      </div>
    </>
  );
}

export default memo(FrequencySpectrumBar);
