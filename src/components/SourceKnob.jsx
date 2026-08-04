import { useRef, useState } from 'react';

// Source dial — web port of the iOS SourceDial (SourceDial.swift).
// 270° track with the gap at the bottom; the value arc grows clockwise
// from the track's left end (7-o'clock). Center shows a compact
// readout, the name sits below. Drag is relative and two-axis like
// PanPot / the iOS knob: right OR up raises, left OR down lowers.
// A lift that never left the tap slop is a tap → onSelect (opens the
// source's tray), matching the iOS knob-tap-opens-tray behavior.

// Matches the iOS SourceDial dragTravel: 140px of travel sweeps the
// full 0..1 range.
const DRAG_TRAVEL = 140;
const TAP_SLOP = 3;
// Air between a link line's end and the circle it points at.
const LINK_AIR = 3;

function polar(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, fromDeg, toDeg) {
  const [x1, y1] = polar(cx, cy, r, fromDeg);
  const [x2, y2] = polar(cx, cy, r, toDeg);
  const sweep = toDeg - fromDeg;
  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const dir = sweep >= 0 ? 1 : 0;
  return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${large} ${dir} ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}

/**
 * @param value    normalized 0..1 dial position
 * @param readout  short string drawn in the dial center ("64", "TRI")
 * @param label    name under the dial; also the tray-open tap target
 * @param dimmed   render at low opacity (source off / muted)
 * @param selected this source's tray is open — underline the label
 * @param size     circle diameter in px (SourceKnobBand.dialGeometry)
 * @param slot     column width the dial is centered in; the leftover is
 *                 the air between neighbors, so the gap scales with the
 *                 dial instead of being a fixed flex gap
 * @param linkNext draw the wave-engine link line across the gap to the
 *                 dial on the right
 * @param onChange (nextValue 0..1) from drag / wheel
 * @param onSelect tap on knob or label — toggle the source tray
 */
function SourceKnob({
  value = 0,
  readout = '',
  label,
  title,
  dimmed = false,
  selected = false,
  size = 46,
  slot = 60,
  linkNext = false,
  onChange,
  onSelect,
}) {
  const dragRef = useRef(null);
  const [tracking, setTracking] = useState(false);

  const strokeW = Math.max(3, size * 0.09);
  const c = size / 2;
  const r = size / 2 - strokeW / 2 - 1;
  const clamped = Math.max(0, Math.min(1, value));
  const valueTo = -135 + 270 * clamped;

  const handlePointerDown = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = { startX: e.clientX, startY: e.clientY, startValue: clamped, dragging: false };
  };
  const handlePointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.dragging && Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) return;
    if (!d.dragging) { d.dragging = true; setTracking(true); }
    // Right OR up = raise, left OR down = lower (matches PanPot + iOS).
    const next = Math.max(0, Math.min(1, d.startValue + (dx - dy) / DRAG_TRAVEL));
    onChange?.(next);
  };
  const handlePointerEnd = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    setTracking(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d && !d.dragging) onSelect?.();
  };
  const handleWheel = (e) => {
    if (!onChange) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(1, clamped - e.deltaY / 600));
    onChange(next);
  };

  return (
    <div
      className={`source-knob${dimmed ? ' dimmed' : ''}${selected ? ' selected' : ''}${tracking ? ' tracking' : ''}`}
      style={{ width: slot }}
    >
      <button
        type="button"
        className="source-knob-face"
        style={{ width: size, height: size }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
        title={title ?? label}
        aria-label={`${label}: ${readout}`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <path
            d={arcPath(c, c, r, -135, 135)}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={strokeW}
            strokeLinecap="round"
          />
          {clamped > 0.004 && (
            <path
              d={arcPath(c, c, r, -135, valueTo)}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeW}
              strokeLinecap="round"
              className="source-knob-arc"
            />
          )}
        </svg>
        <span className="source-knob-readout">{readout}</span>
      </button>
      <button
        type="button"
        className="source-knob-label"
        onClick={() => onSelect?.()}
        aria-pressed={selected}
        title={title ?? label}
      >
        {label}
      </button>
      {linkNext && (
        // Both circles are centered in their slots, so the bare gap
        // between their edges is (slot - size); the line spans it minus
        // a little air at each end (connected, not touching).
        <span
          className="source-knob-link"
          aria-hidden="true"
          style={{
            top: size / 2,
            left: (slot + size) / 2 + LINK_AIR,
            width: Math.max(3, slot - size - 2 * LINK_AIR),
          }}
        />
      )}
    </div>
  );
}

export default SourceKnob;
