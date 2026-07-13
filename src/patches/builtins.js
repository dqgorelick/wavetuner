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

// === Harmonium Song ===========================================
// Captured live (2026-07-07). Four slow drone voices tuned by ear —
// roughly a low fundamental with octave, twelfth, and double octave —
// long harmonium-style attack/release, glide transitions. The piece
// lives in the I–V save slots: five scenes over the same held root,
// recalled in sequence. Frequencies keep full capture precision on
// purpose; the slow beating between near-harmonics is the sound.
const HARMONIUM_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_harmonium',
  name: 'Harmonium Song',
  author: 'Wavetuner',
  description: 'Slow harmonium-cello drones over a held root. Play the I–V slots in order.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  frequencies: [58.73140903320258, 117.03542755937607, 176.39093327039484, 235.0705136096429],
  saveSlots: [
    {
      id: 'builtin_harmonium_slot_1',
      name: 'I',
      createdAt: 1783388169678,
      snapshot: {
        frequencies: [58.73140903320258, 117.03951535314154, 176.38433954268, 235.0682634807969],
        volumes: [0.65, 0.6863023246924959, 0.49, 0.541226406917551],
        mutes: [false, false, false, false],
        transpose: 0,
        slotRatios: [],
        anchorSlot: 0,
        tuningSystem: '5-limit',
        heldNotes: [],
        notesNominal: true,
      },
    },
    {
      id: 'builtin_harmonium_slot_2',
      name: 'II',
      createdAt: 1783388621337,
      snapshot: {
        frequencies: [58.73140903320258, 117.03951535314154, 176.38433954268, 264.56167645460073],
        volumes: [0.65, 0.6863023246924959, 0.49, 0.5287367431909799],
        mutes: [false, false, false, false],
        transpose: 0,
        slotRatios: [],
        anchorSlot: 0,
        tuningSystem: '5-limit',
        heldNotes: [],
        notesNominal: true,
      },
    },
    {
      id: 'builtin_harmonium_slot_3',
      name: 'III',
      createdAt: 1783388668669,
      snapshot: {
        frequencies: [58.73140903320258, 77.79857962151574, 195.78559967383566, 295.7177084384997],
        volumes: [0.65, 0.6863023246924959, 0.49, 0.5287367431909799],
        mutes: [false, false, false, false],
        transpose: 0,
        slotRatios: [],
        anchorSlot: 0,
        tuningSystem: '5-limit',
        heldNotes: [],
        notesNominal: true,
      },
    },
    {
      id: 'builtin_harmonium_slot_4',
      name: 'IV',
      createdAt: 1783388699277,
      snapshot: {
        frequencies: [58.73140903320258, 88.17893271594846, 220.57927553592558, 264.05812285856945],
        volumes: [0.65, 0.6863023246924959, 0.49, 0.5287367431909799],
        mutes: [false, false, false, false],
        transpose: 0,
        slotRatios: [],
        anchorSlot: 0,
        tuningSystem: '5-limit',
        heldNotes: [],
        notesNominal: true,
      },
    },
    {
      id: 'builtin_harmonium_slot_5',
      name: 'V',
      createdAt: 1783388729614,
      snapshot: {
        frequencies: [58.73140903320258, 98.59645711116337, 196.78351614204632, 296.5308524104669],
        volumes: [0.65, 0.6863023246924959, 0.49, 0.5287367431909799],
        mutes: [false, false, false, false],
        transpose: 0,
        slotRatios: [],
        anchorSlot: 0,
        tuningSystem: '5-limit',
        heldNotes: [],
        notesNominal: true,
      },
    },
  ],
  snapshot: {
    volumes: [0.65, 0.69, 0.49, 0.54],
    muted:   [false, false, false, false],
    routing: { 0: [0, 1], 1: [0, 1], 2: [0, 1], 3: [0, 1] },
    envelope: {
      drone:    { attack: 1.999, decay: 0.2, sustain: 0.79, release: 2.008 },
      keyboard: { attack: 0.1,   decay: 1,   sustain: 0.4,  release: 0.3 },
    },
    stereo: {
      drone:    { mode: 'stereo', detuneHz: 1.4, curve: [0.18, 0.31, 1, 1] },
      keyboard: { mode: 'stereo', detuneHz: 1.5, curve: [0.79, 0.76, 1, 1] },
    },
    transitionMode: 'glide',
  },
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

// Pluck-style keyboard envelope (fast attack, medium decay, low
// sustain, medium release) over a quiet stereo drone bed. Four
// oscillators spanning ~C2–G3 — wide enough that the keyboard scale
// gives a usable two-octave-ish playable range. Captured live.
const PLUCKS_PATCH = {
  schema: PATCH_SCHEMA,
  id: 'builtin_plucks',
  name: 'Plucks',
  author: 'Wavetuner',
  description: 'Pluck keyboard envelope over a soft drone bed. Fast attack, medium decay.',
  source: 'builtin',
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  frequencies: [67.27, 134.74, 201.23, 100.38],
  snapshot: {
    volumes: [0.40, 0.80, 0.25, 0.55],
    muted:   [false, false, false, false],
    routing: { 0: [0], 1: [1], 2: [0], 3: [1] },
    envelope: {
      drone:    { attack: 0.300, decay: 0.200, sustain: 0.70, release: 0.500 },
      keyboard: { attack: 0.023, decay: 0.489, sustain: 0.40, release: 0.373 },
    },
    stereo: {
      drone:    { mode: 'lr',     detuneHz: 0.5 },
      keyboard: { mode: 'stereo', detuneHz: 3 },
    },
  },
};

export const BUILTIN_PATCHES = [
  DEFAULT_PATCH,
  HARMONIUM_PATCH,
  PLUCKS_PATCH,
  WTP_PATCH,
];
