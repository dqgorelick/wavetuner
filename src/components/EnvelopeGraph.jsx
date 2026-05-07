/**
 * EnvelopeGraph - small SVG preview of an ADSR envelope.
 *
 * Four anchor points: start (0,0) → attack peak → sustain plateau →
 * release end. Time params get a sqrt-ms x-mapping so a 30 ms attack
 * doesn't disappear next to a 2 s release on the same axis. The
 * sustain segment has no time component; it gets a fixed visual pad
 * (~25% of the available width) so the plateau is legible.
 */

const W = 280;
const H = 80;
const PAD_X = 4;
const PAD_TOP = 6;
const PAD_BOTTOM = 4;

// Sqrt-ms mapping. Same shape used by the slider so the graph and the
// sliders agree visually.
function timeWeight(seconds) {
  return Math.sqrt(Math.max(0, seconds));
}

export default function EnvelopeGraph({ attack, decay, sustain, release }) {
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  // Allocate horizontal space proportional to sqrt(time). Sustain pad
  // is a fixed fraction so a flat sustain segment is always visible.
  const SUSTAIN_FRAC = 0.25;
  const timeBudget = innerW * (1 - SUSTAIN_FRAC);
  const wA = timeWeight(attack);
  const wD = timeWeight(decay);
  const wR = timeWeight(release);
  const wTotal = Math.max(0.001, wA + wD + wR);

  const xA = PAD_X + (wA / wTotal) * timeBudget;
  const xD = xA + (wD / wTotal) * timeBudget;
  const xS = xD + innerW * SUSTAIN_FRAC;
  const xR = xS + (wR / wTotal) * timeBudget;

  const yBase = PAD_TOP + innerH;
  const yPeak = PAD_TOP;
  const ySustain = PAD_TOP + innerH * (1 - sustain);

  const points = [
    [PAD_X, yBase],
    [xA, yPeak],
    [xD, ySustain],
    [xS, ySustain],
    [xR, yBase],
  ];

  const polyline = points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const fillPath =
    `M ${PAD_X} ${yBase} ` +
    points.slice(1).map(p => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') +
    ` Z`;

  return (
    <svg
      className="envelope-graph"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={fillPath} className="envelope-graph-fill" />
      <polyline points={polyline} className="envelope-graph-line" />
    </svg>
  );
}
