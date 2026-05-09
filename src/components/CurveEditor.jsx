import { useEffect, useRef, useState, useMemo } from 'react';

/**
 * CurveEditor — per-slot detune curve, X-band-EQ style.
 *
 * One node per drone slot positioned at integer X. Drag a node up/down
 * to set that slot's normalized [0, 1] curve value. Drag across the
 * canvas to "sweep" — every X column the pointer crosses gets its
 * value set to the pointer's Y. Catmull-rom smoothing for the visual
 * line; node Y values are still the source of truth used by the
 * audio engine.
 *
 * Y axis: 0 (bottom) → master detune Hz (top, settable via the slider
 * elsewhere in the panel). The component just renders 0..1 and labels
 * the ceiling with the master Hz scale.
 */

const W = 280;
const H = 90;
const PAD_X = 14;
const PAD_Y = 8;
const NODE_R = 4;

function catmullRomPath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  // Centripetal catmull-rom with α = 0.5; collapses to cubic Bézier
  // segments between each pair of interior points. Endpoint duplication
  // anchors the curve to the first and last node.
  const p = [points[0], ...points, points[points.length - 1]];
  let d = `M ${p[1].x} ${p[1].y}`;
  for (let i = 1; i < p.length - 2; i++) {
    const p0 = p[i - 1], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

export default function CurveEditor({ stereoMode, slotCount, label = 'Detune curve' }) {
  const [, setTick] = useState(0);
  useEffect(() => stereoMode.onChange(() => setTick(n => n + 1)), [stereoMode]);

  const svgRef = useRef(null);
  const draggingRef = useRef(null); // { kind: 'node' | 'sweep', slotIdx? }

  const innerW = W - 2 * PAD_X;
  const innerH = H - 2 * PAD_Y;

  const xForSlot = useMemo(() => (i) => {
    if (slotCount <= 1) return PAD_X + innerW / 2;
    return PAD_X + (i / (slotCount - 1)) * innerW;
  }, [slotCount, innerW]);
  const yForValue = (v) => PAD_Y + (1 - v) * innerH;
  const valueForY = (y) => Math.max(0, Math.min(1, 1 - (y - PAD_Y) / innerH));
  const slotForX = (x) => {
    if (slotCount <= 1) return 0;
    return Math.max(0, Math.min(slotCount - 1,
      Math.round(((x - PAD_X) / innerW) * (slotCount - 1))));
  };

  // Read the live curve. Pad to slotCount in case StereoMode hasn't
  // resized yet (transient on count change).
  const values = [];
  for (let i = 0; i < slotCount; i++) values.push(stereoMode.detuneCurve[i] || 0);

  const points = values.map((v, i) => ({ x: xForSlot(i), y: yForValue(v) }));
  const pathD = catmullRomPath(points);
  // Closed area below the line for a soft visual fill.
  const areaD = pathD
    ? `${pathD} L ${PAD_X + innerW} ${PAD_Y + innerH} L ${PAD_X} ${PAD_Y + innerH} Z`
    : '';

  const setFromPointer = (clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;
    const slot = slotForX(x);
    const value = valueForY(y);
    stereoMode.setDetuneCurveAt(slot, value);
  };

  const onPointerDown = (e, slotIdx = null) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (svg && e.pointerId !== undefined) svg.setPointerCapture(e.pointerId);
    draggingRef.current = slotIdx === null
      ? { kind: 'sweep' }
      : { kind: 'node', slotIdx };
    setFromPointer(e.clientX, e.clientY);
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    setFromPointer(e.clientX, e.clientY);
  };
  const onPointerUp = (e) => {
    const svg = svgRef.current;
    if (svg && e.pointerId !== undefined) {
      try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    draggingRef.current = null;
  };

  const ceilingHz = stereoMode.detuneHz.toFixed(1);

  return (
    <div className="curve-editor">
      <div className="curve-editor-header">
        <span className="curve-editor-label">{label}</span>
        <div className="curve-editor-header-right">
          <span className="curve-editor-ceiling">0 — {ceilingHz} Hz</span>
          <button
            type="button"
            className="curve-editor-random"
            onClick={() => stereoMode.randomizeCurve()}
            title="Generate a new smooth random curve (gentle Perlin-style — adjacent slots stay similar)"
          >
            random
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="curve-editor-svg"
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={(e) => onPointerDown(e, null)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Frame */}
        <rect
          x={PAD_X}
          y={PAD_Y}
          width={innerW}
          height={innerH}
          className="curve-editor-frame"
        />
        {/* Mid gridline at y=0.5 for orientation */}
        <line
          x1={PAD_X}
          x2={PAD_X + innerW}
          y1={PAD_Y + innerH / 2}
          y2={PAD_Y + innerH / 2}
          className="curve-editor-mid"
        />
        {/* X gridlines per slot */}
        {points.map((_, i) => (
          <line
            key={`g${i}`}
            x1={xForSlot(i)}
            x2={xForSlot(i)}
            y1={PAD_Y}
            y2={PAD_Y + innerH}
            className="curve-editor-vgrid"
          />
        ))}
        {/* Filled area under curve */}
        {areaD && <path d={areaD} className="curve-editor-area" />}
        {/* Smoothed curve line */}
        {pathD && <path d={pathD} className="curve-editor-line" />}
        {/* Draggable nodes */}
        {points.map((pt, i) => (
          <circle
            key={`n${i}`}
            cx={pt.x}
            cy={pt.y}
            r={NODE_R}
            className="curve-editor-node"
            onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, i); }}
          />
        ))}
      </svg>
    </div>
  );
}
