import { useEffect, useMemo, useState } from 'react';
import { noise, NOISE_TYPES } from '../audio/Noise';

/**
 * NoiseSpectrumPreview — the noise menu's picture, in the same grammar
 * as WaveShapePreview (shape/fold) and EnvelopeGraph (ADSR): a small
 * static SVG that redraws off the module's onChange.
 *
 * What it plots: energy in dB against a log-frequency axis, 20 Hz →
 * 20 kHz, with everything UNDER the curve filled — the fill is the
 * energy. Only the COLOR moves it: brown −6 dB/oct, pink −3, white
 * flat. The three colors are RMS-matched at bake time (see normalizeRms
 * in Noise.js), so they're drawn pivoting about the geometric middle of
 * the axis rather than sharing a left edge: equal area, different
 * slant, which is what you hear when you switch between them at a fixed
 * level.
 *
 * The chart is drawn at full level always (Dan, 2026-08-05) — it's a
 * picture of the color's character, not of how loud the source happens
 * to be right now, and the slider underneath already says that. Letting
 * the level slide it meant the chart went blank exactly when you were
 * reaching for it.
 *
 * There is no cutoff to draw here — none of the three colors is a
 * filtered source (Noise.js bakes the color into the buffer itself), so
 * a knee would be a lie. If a filter ever lands on the noise bus, this
 * is where its corner belongs.
 */

const VB_W = 320;
const VB_H = 84;
const PAD_X = 1;
const PAD_Y = 1;

const F_MIN = 20;
const F_MAX = 20000;
const OCTAVES = Math.log2(F_MAX / F_MIN); // ~9.97
// Geometric middle of the axis — the pivot every color's line crosses.
const F_PIVOT = Math.sqrt(F_MIN * F_MAX); // ~632 Hz

// Vertical window, in dB relative to the pivot. ±33 fits brown
// (−6 dB/oct over ~±5 octaves = ±30 dB) with a hair of air.
const DB_TOP = 33;
const DB_SPAN = 66;

const SAMPLES = 48;

function xForOctave(o) {
  return PAD_X + (o / OCTAVES) * (VB_W - PAD_X * 2);
}

function yForDb(db) {
  const t = (DB_TOP - db) / DB_SPAN; // 0 at top, 1 at bottom
  const y = PAD_Y + t * (VB_H - PAD_Y * 2);
  return Math.max(PAD_Y, Math.min(VB_H - PAD_Y, y));
}

function buildPaths(slopeDb) {
  const pts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const o = (i / (SAMPLES - 1)) * OCTAVES;
    // Straight line in log-f, but sampled rather than drawn end-to-end
    // so the clamp in yForDb reads as a flat shoulder where a steep
    // color runs off the top or bottom of the window.
    const db = slopeDb * (o - Math.log2(F_PIVOT / F_MIN));
    pts.push([xForOctave(o), yForDb(db)]);
  }
  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
    .join(' ');
  const floor = VB_H - PAD_Y;
  const fill = `${line} L ${pts[pts.length - 1][0].toFixed(2)} ${floor} L ${pts[0][0].toFixed(2)} ${floor} Z`;
  return { line, fill };
}

// Decade markers. No text: the SVG stretches to the column width
// (preserveAspectRatio="none") and labels would smear with it.
const GRID_HZ = [100, 1000, 10000];

export default function NoiseSpectrumPreview() {
  const [, setTick] = useState(0);
  useEffect(() => noise.onChange(() => setTick((n) => n + 1)), []);

  const { type } = noise;
  const slopeDb = NOISE_TYPES[type]?.slopeDb ?? 0;
  const { line, fill } = useMemo(() => buildPaths(slopeDb), [slopeDb]);

  return (
    <svg
      className="tray-viz noise-spectrum"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${type} noise spectrum, ${slopeDb} dB per octave`}
    >
      {GRID_HZ.map((hz) => {
        const x = xForOctave(Math.log2(hz / F_MIN));
        return (
          <line
            key={hz}
            x1={x}
            y1={PAD_Y}
            x2={x}
            y2={VB_H - PAD_Y}
            className="tray-viz-grid"
          />
        );
      })}
      <path d={fill} className="noise-spectrum-fill" />
      <path d={line} className="noise-spectrum-line" />
    </svg>
  );
}
