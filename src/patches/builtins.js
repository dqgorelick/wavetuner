// Built-in patches shipped with Wavetuner. Read-only — the panel routes
// "Save"/"Rename"/"Delete" only at user-source patches, and the storage
// layer never writes anything with source !== 'user'.

import { PATCH_SCHEMA } from './schema.js';

const BUILTIN_TIMESTAMP = '2026-05-07T00:00:00.000Z';

// Reproducible factory baseline: two beating pairs an octave apart, the
// "interesting demo" config the random startup is trying to approximate.
// First two unmuted, last two muted — matches AudioEngine's fresh-boot
// mutedStates so loading Default never produces a sudden volume jump.
const DEFAULT_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_default',
  name: 'Default',
  author: 'Wavetuner',
  description: 'Two beating pairs, an octave apart. The starting point.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  frequencies: [100, 102, 200, 203],
  snapshot: {
    volumes: [0.5, 0.5, 0.5, 0.5],
    muted:   [false, false, true, true],
    routing: { 0: [0], 1: [1], 2: [0], 3: [1] },
  },
};

// La Monte Young's Well-Tuned Piano. 12 ratios in chromatic order starting
// from D♯ = 1/1. anchorHz of 297.9894 puts the 1/1 at D♯4 — at this anchor
// A (189/128) lands at exactly 440 Hz, which is presumably why Young chose it.
//
// Ratios are stored chromatically rather than ascending-by-pitch on purpose:
// in WTP, G♯ < G and C♯ < C, so the chromatic sequence isn't monotonic. The
// loader doesn't care about order (oscillators sort themselves on the
// spectrum bar) but a human reading the ratios list expects D♯, E, F, F♯…
const WTP_RATIOS = [
  { name: '1/1',       value: 1,                cents: 0 },
  { name: '567/512',   value: 567 / 512,        cents: 1200 * Math.log2(567 / 512) },
  { name: '9/8',       value: 9 / 8,            cents: 1200 * Math.log2(9 / 8) },
  { name: '147/128',   value: 147 / 128,        cents: 1200 * Math.log2(147 / 128) },
  { name: '21/16',     value: 21 / 16,          cents: 1200 * Math.log2(21 / 16) },
  { name: '1323/1024', value: 1323 / 1024,      cents: 1200 * Math.log2(1323 / 1024) },
  { name: '189/128',   value: 189 / 128,        cents: 1200 * Math.log2(189 / 128) },
  { name: '3/2',       value: 3 / 2,            cents: 1200 * Math.log2(3 / 2) },
  { name: '49/32',     value: 49 / 32,          cents: 1200 * Math.log2(49 / 32) },
  { name: '7/4',       value: 7 / 4,            cents: 1200 * Math.log2(7 / 4) },
  { name: '441/256',   value: 441 / 256,        cents: 1200 * Math.log2(441 / 256) },
  { name: '63/32',     value: 63 / 32,          cents: 1200 * Math.log2(63 / 32) },
];

const WTP_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_wtp',
  name: 'Well-Tuned Piano',
  author: 'La Monte Young',
  description: 'D♯ = 1/1. 7-limit just-intonation ratios. A lands at 440 Hz.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  ratios: WTP_RATIOS,
  anchorHz: 297.9894,
  rootMidi: 39, // D♯1 — pitch-class anchor for future keyboard mapping
};

export const BUILTIN_PATCHES = [DEFAULT_PATCH, WTP_PATCH];
