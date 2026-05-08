// Built-in patches shipped with Wavetuner. Read-only — the panel routes
// "Save"/"Rename"/"Delete" only at user-source patches, and the storage
// layer never writes anything with source !== 'user'.
//
// All chromatic/diatonic patches anchor at C4 = 261.6256 Hz, 1/1 = C, so
// loading them produces a recognizable C-rooted scale across the
// oscillator bank. WTP is the exception (D♯-rooted, see comment near it).

import { PATCH_SCHEMA } from './schema.js';

const BUILTIN_TIMESTAMP = '2026-05-07T00:00:00.000Z';
const C4_HZ = 261.6256;

// Cents → ratio. Used by the irrational tunings (12-TET, meantone, well-
// temperaments) where ratios aren't expressible as small integers.
const fromCents = (cents) => 2 ** (cents / 1200);
// Cents from a JI ratio, for stamping the cents field on each entry.
const ratioCents = (n, d) => 1200 * Math.log2(n / d);

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

// === 12-TET ====================================================
// Modern Western standard. Each semitone = 2^(1/12); A4 lands on 440.

const ET12_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const ET12_RATIOS = ET12_NAMES.map((name, i) => ({
  name,
  value: 2 ** (i / 12),
  cents: i * 100,
}));

const ET12_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_12tet',
  name: 'Equal Temperament',
  author: 'Modern standard',
  description: '12 evenly-spaced semitones; the modern Western default tuning.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  ratios: ET12_RATIOS,
  anchorHz: C4_HZ,
  rootMidi: 60,
};

// === Ptolemy's Diatonic (5-limit JI) ===========================
// 7 notes from small-integer ratios — the canonical "pure" major scale.

const PTOLEMY_RATIOS = [
  { name: '1/1',  value: 1,      cents: 0 },
  { name: '9/8',  value: 9 / 8,  cents: ratioCents(9, 8) },
  { name: '5/4',  value: 5 / 4,  cents: ratioCents(5, 4) },
  { name: '4/3',  value: 4 / 3,  cents: ratioCents(4, 3) },
  { name: '3/2',  value: 3 / 2,  cents: ratioCents(3, 2) },
  { name: '5/3',  value: 5 / 3,  cents: ratioCents(5, 3) },
  { name: '15/8', value: 15 / 8, cents: ratioCents(15, 8) },
];

const PTOLEMY_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_ptolemy',
  name: "Ptolemy's Diatonic",
  author: 'Claudius Ptolemy, ~150 CE',
  description: 'Classic 5-limit just intonation — 7 pure small-integer ratios.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  ratios: PTOLEMY_RATIOS,
  anchorHz: C4_HZ,
  rootMidi: 60,
};

// === Pythagorean Chromatic (3-limit JI) ========================
// 12 notes built from stacked pure 3:2 fifths. Wolf interval lives
// between G♯ and E♭.

const PYTHAGOREAN_RATIOS = [
  { name: '1/1',       value: 1,           cents: 0 },
  { name: '2187/2048', value: 2187 / 2048, cents: ratioCents(2187, 2048) },
  { name: '9/8',       value: 9 / 8,       cents: ratioCents(9, 8) },
  { name: '32/27',     value: 32 / 27,     cents: ratioCents(32, 27) },
  { name: '81/64',     value: 81 / 64,     cents: ratioCents(81, 64) },
  { name: '4/3',       value: 4 / 3,       cents: ratioCents(4, 3) },
  { name: '729/512',   value: 729 / 512,   cents: ratioCents(729, 512) },
  { name: '3/2',       value: 3 / 2,       cents: ratioCents(3, 2) },
  { name: '6561/4096', value: 6561 / 4096, cents: ratioCents(6561, 4096) },
  { name: '27/16',     value: 27 / 16,     cents: ratioCents(27, 16) },
  { name: '16/9',      value: 16 / 9,      cents: ratioCents(16, 9) },
  { name: '243/128',   value: 243 / 128,   cents: ratioCents(243, 128) },
];

const PYTHAGOREAN_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_pythagorean',
  name: 'Pythagorean Chromatic',
  author: 'Pythagorean tradition',
  description: 'Stacked pure fifths — bright wide thirds and one wolf interval at G♯–E♭.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  ratios: PYTHAGOREAN_RATIOS,
  anchorHz: C4_HZ,
  rootMidi: 60,
};

// === Quarter-comma Meantone (Aron, 1523) =======================
// Renaissance keyboard tuning. Every fifth tempered narrow by 1/4
// syntonic comma so each major third is the pure 5/4. Cost: one
// painfully out-of-tune wolf fifth (G♯–E♭).

const MEANTONE_TABLE = [
  { name: 'C',  cents: 0.000 },
  { name: 'C♯', cents: 76.049 },
  { name: 'D',  cents: 193.157 },
  { name: 'E♭', cents: 310.265 },
  { name: 'E',  cents: 386.314 },
  { name: 'F',  cents: 503.422 },
  { name: 'F♯', cents: 579.471 },
  { name: 'G',  cents: 696.578 },
  { name: 'G♯', cents: 772.627 },
  { name: 'A',  cents: 889.735 },
  { name: 'B♭', cents: 1006.843 },
  { name: 'B',  cents: 1082.892 },
];
const MEANTONE_RATIOS = MEANTONE_TABLE.map(({ name, cents }) => ({
  name, cents, value: fromCents(cents),
}));

const MEANTONE_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_meantone_qc',
  name: 'Quarter-comma Meantone',
  author: 'Pietro Aron, 1523',
  description: 'Pure 5/4 thirds in eight keys at the cost of one wolf fifth.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  ratios: MEANTONE_RATIOS,
  anchorHz: C4_HZ,
  rootMidi: 60,
};

// === Vallotti (~1779) ==========================================
// 18th-c. well-temperament. Six fifths (F-C-G-D-A-E-B) tempered
// narrow by 1/6 Pythagorean comma; the rest pure. Most balanced of
// the historical well-temperaments.

const VALLOTTI_TABLE = [
  { name: 'C',  cents: 0.000 },
  { name: 'C♯', cents: 94.135 },
  { name: 'D',  cents: 196.090 },
  { name: 'E♭', cents: 298.045 },
  { name: 'E',  cents: 392.180 },
  { name: 'F',  cents: 501.955 },
  { name: 'F♯', cents: 592.180 },
  { name: 'G',  cents: 698.045 },
  { name: 'G♯', cents: 796.090 },
  { name: 'A',  cents: 894.135 },
  { name: 'B♭', cents: 1000.000 },
  { name: 'B',  cents: 1090.225 },
];
const VALLOTTI_RATIOS = VALLOTTI_TABLE.map(({ name, cents }) => ({
  name, cents, value: fromCents(cents),
}));

const VALLOTTI_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_vallotti',
  name: 'Vallotti',
  author: 'F.A. Vallotti, ~1779',
  description: 'Balanced 18th-century well-temperament — every key playable with subtle character.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  ratios: VALLOTTI_RATIOS,
  anchorHz: C4_HZ,
  rootMidi: 60,
};

// === La Monte Young — Well-Tuned Piano ========================
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

export const BUILTIN_PATCHES = [
  DEFAULT_PATCH,
  ET12_PATCH,
  PTOLEMY_PATCH,
  PYTHAGOREAN_PATCH,
  MEANTONE_PATCH,
  VALLOTTI_PATCH,
  WTP_PATCH,
];
