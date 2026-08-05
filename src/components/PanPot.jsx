import { useRef, useState } from 'react';

// Rotary pan dial — port of the iOS PanPot (PanPot.swift). 270° track
// with the gap at the bottom; the value arc always grows out of
// twelve-o'clock (right pans sweep clockwise, left pans counter-
// clockwise) with the orb riding the arc's end. Drag is relative and
// two-axis like the old PanCell: right OR up pans right, left OR down
// pans left; tap (no drag) bounces side ↔ center.

const PAN_EPS = 0.01;
// 40/1.75 pt of travel per pan unit → ~45.7px sweeps the full −1…+1.
const PX_PER_UNIT = 40 / 1.75;

// Angles measured in degrees clockwise from 12-o'clock.
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

function PanPot({ pan = 0, index = 0, color, muted = false, size = 30, onChange, label }) {
  const dragRef = useRef(null);
  const lastSideRef = useRef(null);
  const [tracking, setTracking] = useState(false);

  const strokeW = Math.max(3, size * 0.1);
  const orbSize = Math.max(7, size * (7 / 30));
  const orbR = orbSize / 2;
  const c = size / 2;
  const r = size / 2 - orbR; // orb center rides the arc circle

  // A click jumps the whole distance, so it asks the owner to GLIDE there
  // ({ glide: true }) rather than snap — App runs it over PERFORM's recall
  // glide time. A drag is already continuous and passes no flag.
  const cycle = () => {
    if (Math.abs(pan) > PAN_EPS) {
      lastSideRef.current = pan < 0 ? -1 : 1;
      onChange?.(0, { glide: true });
    } else {
      const defaultSide = index % 2 === 0 ? -1 : 1;
      onChange?.(lastSideRef.current != null ? -lastSideRef.current : defaultSide,
        { glide: true });
    }
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan, dragging: false };
  };
  const handlePointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.dragging && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    if (!d.dragging) { d.dragging = true; setTracking(true); }
    // Right OR up = pan right, left OR down = pan left.
    let next = Math.max(-1, Math.min(1, d.startPan + (dx - dy) / PX_PER_UNIT));
    if (Math.abs(next) < 0.08) next = 0;
    else if (next > 0.92) next = 1;
    else if (next < -0.92) next = -1;
    onChange?.(next);
  };
  const handlePointerEnd = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    setTracking(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d && !d.dragging) cycle();
  };

  // Dimming is a COLOR shift, never an opacity change: the orb rides on
  // top of the track ring (and the arc crosses it), so a translucent
  // knob lets what's behind bleed through. Mixing the voice color over
  // black keeps the hue while dropping the level — same idiom as the
  // VerticalFader ball's black backing circle.
  const dim = (pct) => (pct >= 100 ? color : `color-mix(in srgb, ${color} ${pct}%, black)`);
  const arcFill = dim(muted ? 30 : tracking ? 90 : 60);
  const orbFill = dim(muted ? 50 : tracking ? 100 : 90);
  const valueTo = 135 * Math.max(-1, Math.min(1, pan));
  const [orbX, orbY] = polar(c, c, r, valueTo);

  const stateDesc = Math.abs(pan) < PAN_EPS ? 'center'
    : `${pan > 0 ? 'R' : 'L'} ${Math.round(Math.abs(pan) * 100)}%`;

  return (
    <button
      type="button"
      className={`panpot${tracking ? ' tracking' : ''}${muted ? ' muted' : ''}`}
      style={{ width: size, height: size, '--panpot-color': color }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      title={`${label ?? `Voice ${index + 1}`} pan: ${stateDesc} — drag →/↑ = R, ←/↓ = L; click to bounce side ↔ center`}
      aria-label={`${label ?? `Voice ${index + 1}`} pan ${stateDesc}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <path
          d={arcPath(c, c, r, -135, 135)}
          fill="none"
          style={{ stroke: 'rgba(var(--ink-soft-rgb), 0.10)' }}
          strokeWidth={strokeW}
          strokeLinecap="round"
        />
        {Math.abs(pan) > PAN_EPS && (
          <path
            d={arcPath(c, c, r, 0, valueTo)}
            fill="none"
            stroke={arcFill}
            strokeWidth={strokeW}
            strokeLinecap="round"
          />
        )}
        <circle
          cx={orbX}
          cy={orbY}
          r={orbR}
          fill={orbFill}
          className="panpot-orb"
        />
      </svg>
    </button>
  );
}

export default PanPot;
