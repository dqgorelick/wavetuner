import { useMemo } from 'react';
import { saturate } from '../audio/saturationCurve';

/**
 * SaturationPreview — the saturate menu's picture, drawn in the same
 * grammar as WaveShapePreview: one cycle, stroke only, no fill.
 *
 * A unit sine goes in (the dim ghost) and the master curve's output
 * comes back (the bright trace), so the two together show the squash
 * directly: soft rounds the peaks, hard flattens them into a plateau,
 * sine folds over at the very top. A sine rather than the live signal
 * on purpose — the master saturator sits after the whole mix, so
 * "the current waveform" is a moving sum of every voice and reads as
 * noise here, while a fixed reference makes the difference BETWEEN the
 * styles legible as you click across the radios.
 *
 * The ±1 dashed rails are the ceiling the curve is defending: below
 * drive 1 the trace sits inside them untouched, above it the trace
 * presses into them and the ghost is what's being given up.
 */

const SAMPLES = 240;
const VB_W = 320;
const VB_H = 84;
// Vertical window a little past ±1 so the rails sit inside the box.
const Y_RANGE = 1.22;

function yFor(v) {
  return (VB_H / 2) - (v / Y_RANGE) * (VB_H / 2);
}

function pathFor(fn) {
  let d = '';
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / (SAMPLES - 1);
    const x = t * VB_W;
    const y = yFor(fn(Math.sin(t * Math.PI * 2)));
    d += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

export default function SaturationPreview({ style, drive }) {
  const ghost = useMemo(() => pathFor((s) => s), []);
  const trace = useMemo(
    () => pathFor((s) => saturate(s, style, drive)),
    [style, drive],
  );

  const yTop = yFor(1);
  const yBot = yFor(-1);

  return (
    <svg
      className="tray-viz sat-preview"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Saturation shape: ${style}, drive ${drive.toFixed(2)}`}
    >
      <line x1="0" y1={yTop} x2={VB_W} y2={yTop} className="sat-preview-rail" />
      <line x1="0" y1={yBot} x2={VB_W} y2={yBot} className="sat-preview-rail" />
      <line x1="0" y1={VB_H / 2} x2={VB_W} y2={VB_H / 2} className="tray-viz-grid" />
      <path d={ghost} className="sat-preview-ghost" />
      <path d={trace} className="sat-preview-trace" />
    </svg>
  );
}
