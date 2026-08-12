import { useRef, useState } from 'react';
import { useTheme } from '../theme/palette';

// Stroke-drawn chevron matching the iOS SF Symbol (chevron.left/right,
// size 8 medium) — the text guillemets rendered too small and sat too
// close to the ball.
function XyChevron({ dir }) {
  return (
    <svg className={`vfader-chevron ${dir}`} viewBox="0 0 8 13" aria-hidden="true">
      <polyline
        points={dir === 'left' ? '6.2,1.4 1.8,6.5 6.2,11.6' : '1.8,1.4 6.2,6.5 1.8,11.6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Vertical level fader — port of the iOS VerticalFader. A thin capsule
// track with a colored fill rising from the bottom and a black-backed
// ball at the fill top. Drag is RELATIVE (delta from the value at
// touch-down, never a jump to the pointer). With `onXStart`/`onXDelta`
// wired, horizontal drag simultaneously drives a second parameter
// (the voice's frequency fine-tune) — the XY mode; chevrons beside the
// ball advertise it. Muting dims the fill but keeps its height so a
// muted voice can still be re-leveled.

// Ball diameter, and therefore the inset at each end of its travel: the
// ball's CENTER runs [r, height − r] so its outer edge lands flush with
// the track's cap at both extremes (Dan, 2026-08-04 — at full level the
// ball used to hang half its body above the track). The floor was
// already inset this way by the old max(0, …) clamp; this makes the
// ceiling match. The fill rises to the ball's center, so the two stay
// joined, and the ALL lane's unity tick still falls exactly at 50%.
const BALL_SIZE = 20;

function VerticalFader({
  value = 0, // 0..1 fraction of track height
  color,
  muted = false,
  unityTick = false, // 13×1 white tick at half height (ALL fader: half = unity)
  onValue, // (frac 0..1) vertical drag
  onXStart, // optional: called once when a drag commits; return baseline
  onXDelta, // optional: (baseline, dxFrac in widths — unbounded) horizontal drag
  ariaLabel,
}) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [active, setActive] = useState(false);
  // simple theme: no ball and no XY chevrons — the fader is just the two
  // rounded lines (track + fill), and the fill's cap is the indicator.
  // Without a ball there are no end insets either: the fill runs the
  // track's full height so 0 is empty and 1 is flush with the top.
  const simple = useTheme() === 'simple';

  const xy = !!(onXStart && onXDelta);
  // The simple theme's crossbar handle (see below). Hoisted because the
  // root carries a class for it: the fill squares off its top cap under
  // the crossbar so the two read as one T, not a bar resting on a
  // rounded line. Faders without a crossbar keep the round cap — there
  // the cap IS the indicator.
  const xcap = simple && xy && !muted;

  const handlePointerDown = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const rect = rootRef.current.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startValue: value,
      xBaseline: null,
      rect,
      dragging: false,
    };
  };
  const handlePointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.dragging && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    if (!d.dragging) {
      d.dragging = true;
      setActive(true);
      if (xy) d.xBaseline = onXStart();
    }
    // Travel is the track less the ball's two end insets, so the ball
    // tracks the pointer 1:1 all the way to both stops. (No ball in the
    // simple theme, so the fill runs — and the drag maps — full-height.)
    const h = Math.max(1, d.rect.height - (simple ? 0 : BALL_SIZE));
    onValue?.(Math.max(0, Math.min(1, d.startValue - dy / h)));
    if (xy && d.xBaseline != null) {
      // UNCLAMPED, iOS parity (VerticalFader.swift's xyChanged, which reads
      // translation.width raw): the lane width sets the RATE — one lane
      // travelled = one freqRange — it is not a stop. The old ±1 clamp made
      // the tune die ~20px out of the lane while the finger kept going
      // (Dan, 2026-08-04). The consumer owns the value's own limits.
      const w = Math.max(24, d.rect.width);
      onXDelta(d.xBaseline, dx / w);
    }
  };
  const handlePointerEnd = (e) => {
    dragRef.current = null;
    setActive(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const frac = Math.max(0, Math.min(1, value));
  const pct = frac * 100;
  // Ball center (and the fill's top) along the inset travel.
  const centerY = simple
    ? `${pct}%`
    : `calc(${BALL_SIZE / 2}px + (100% - ${BALL_SIZE}px) * ${frac})`;

  return (
    <div
      ref={rootRef}
      className={`vfader${active ? ' active' : ''}${muted ? ' muted' : ''}${xcap ? ' has-xcap' : ''}`}
      style={{ '--vfader-color': color, '--vfader-ball': `${BALL_SIZE}px` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className="vfader-track" />
      <div className="vfader-fill" style={{ height: centerY }} />
      {unityTick && <div className="vfader-unity" />}
      {/* simple's XY affordance: a short crossbar riding the fill's cap.
          The theme's grammar everywhere else — pan needle, master
          crossbar — is "a tick crossing a line is the handle you drag",
          so a T-shaped cap says this handle moves sideways too. Only on
          faders that HAVE an X axis (the ALL bus fader stays a bare
          line), and gone while muted, like the chevrons it replaces. */}
      {xcap && (
        <div className="vfader-xcap" style={{ bottom: `calc(${centerY} - 1px)` }} />
      )}
      {!simple && (
        <div className="vfader-ball-slot" style={{ bottom: `calc(${centerY} - ${BALL_SIZE / 2}px)` }}>
          {xy && !muted && <XyChevron dir="left" />}
          <div className="vfader-ball" />
          {xy && !muted && <XyChevron dir="right" />}
        </div>
      )}
    </div>
  );
}

export default VerticalFader;
