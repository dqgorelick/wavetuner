/**
 * visualShape - JS-side wavetables so the synth-source visualizer modes
 * (standing line, Hilbert) draw the pool's morphed shape instead of a
 * pure sine. See research/waveshaping.md §5.
 *
 * Two flavors, both cached per Wave singleton and lazily rebuilt when
 * that pool's morph position changes:
 *
 * - getShapeTable(wave): IDEALIZED shapes (sharp corners, not
 *   band-limited) for the time-domain line modes — matches the user's
 *   mental model of "square"; the audio-source modes already show the
 *   band-limited reality.
 * - getHilbertTables(wave): a band-limited analytic pair built from the
 *   same Fourier coefficients the audio uses — x = Σ bₙ·sin(nθ),
 *   y = Hilbert(x) = Σ −bₙ·cos(nθ). The Hilbert identity only holds
 *   per-harmonic, so this mode needs the Fourier form; capped at 64
 *   harmonics (visually indistinguishable at scope resolution, keeps a
 *   slider-drag rebuild ~1 ms).
 *
 * Anchor order matches Wave.js: sine → triangle → square → saw.
 * All idealized anchors are odd (zero at phase 0, first peak in the
 * first quarter-cycle) so they stay phase-aligned with the Fourier
 * anchors and with the scope's zero-crossing-centered windowing.
 */

import { shapeCoeffs } from './Wave';

const WT_SIZE = 1024;
const WT_MASK = WT_SIZE - 1;
const HILBERT_HARMONICS = 64;
const TWO_PI = Math.PI * 2;
const INV_TWO_PI = 1 / TWO_PI;

// Idealized anchor shapes at norm ∈ [0, 1). Phase-aligned with the
// sine-series anchors in Wave.js (odd symmetry, rising at 0).
function sampleShapeIdeal(norm, p) {
  const sine = Math.sin(TWO_PI * norm);
  const triangle = norm < 0.25 ? 4 * norm
    : norm < 0.75 ? 2 - 4 * norm
    : 4 * norm - 4;
  const square = norm < 0.5 ? 1 : -1;
  const saw = norm < 0.5 ? 2 * norm : 2 * norm - 2;
  const anchors = [sine, triangle, square, saw];
  const clamped = Math.max(0, Math.min(3, p));
  const seg = Math.min(2, Math.floor(clamped));
  const t = clamped - seg;
  return anchors[seg] * (1 - t) + anchors[seg + 1] * t;
}

function buildShapeTable(p) {
  const wt = new Float32Array(WT_SIZE);
  for (let i = 0; i < WT_SIZE; i++) wt[i] = sampleShapeIdeal(i / WT_SIZE, p);
  return wt;
}

// Band-limited sin-basis + Hilbert (−cos-basis) pair, jointly
// peak-normalized so the analytic envelope keeps a consistent radius.
function buildHilbertTables(p) {
  const coeffs = shapeCoeffs(p);
  const x = new Float32Array(WT_SIZE);
  const y = new Float32Array(WT_SIZE);
  let peak = 0;
  for (let i = 0; i < WT_SIZE; i++) {
    const theta = (i / WT_SIZE) * TWO_PI;
    let sx = 0;
    let sy = 0;
    for (let n = 1; n <= HILBERT_HARMONICS; n++) {
      const c = coeffs[n];
      if (c === 0) continue;
      sx += c * Math.sin(n * theta);
      sy -= c * Math.cos(n * theta);
    }
    x[i] = sx;
    y[i] = sy;
    const ax = Math.abs(sx);
    const ay = Math.abs(sy);
    if (ax > peak) peak = ax;
    if (ay > peak) peak = ay;
  }
  if (peak > 0) {
    const inv = 1 / peak;
    for (let i = 0; i < WT_SIZE; i++) {
      x[i] *= inv;
      y[i] *= inv;
    }
  }
  return { x, y };
}

// Lazy per-Wave caches: rebuilt on first use after the pool's position
// moves. Keyed by the singleton itself so drone/keyboard stay separate.
const shapeCache = new WeakMap();    // wave → { position, table }
const hilbertCache = new WeakMap();  // wave → { position, x, y }

export function getShapeTable(wave) {
  let entry = shapeCache.get(wave);
  if (!entry || entry.position !== wave.position) {
    entry = { position: wave.position, table: buildShapeTable(wave.position) };
    shapeCache.set(wave, entry);
  }
  return entry.table;
}

export function getHilbertTables(wave) {
  let entry = hilbertCache.get(wave);
  if (!entry || entry.position !== wave.position) {
    entry = { position: wave.position, ...buildHilbertTables(wave.position) };
    hilbertCache.set(wave, entry);
  }
  return entry;
}

// Linear-interp lookup at normalized phase ∈ [0, 1). Caller keeps norm
// in range (the synth loops step it and wrap manually).
export function wtLookup(table, norm) {
  const idxF = norm * WT_SIZE;
  const idxI = Math.floor(idxF);
  const frac = idxF - idxI;
  const i0 = idxI & WT_MASK;
  const i1 = (i0 + 1) & WT_MASK;
  return table[i0] + (table[i1] - table[i0]) * frac;
}

// Same lookup addressed in radians (any real number) — for callers that
// already have a phase in θ form (drawStatic's 2π·f·t + rel).
export function wtLookupRad(table, theta) {
  let norm = theta * INV_TWO_PI;
  norm -= Math.floor(norm);
  return wtLookup(table, norm);
}
