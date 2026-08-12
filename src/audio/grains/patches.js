// Built-in granular patches — a straight port of the iOS
// GranularPatch.swift constants, which are themselves exact dumps of the
// Grains desktop standalone's saved state. Values are NOT to be "tidied":
// the crossNotes order in the cello patches looks inverted versus the pairs
// and is deliberate (the engine's per-pair margin clamp maps them onto the
// crossovers the desktop actually ran with).
//
// `sample` is a bundle name without extension; the loader resolves it under
// public/grains/samples/.

/** @typedef {{sample: string, rootNote: number, selStart: number, selEnd: number, gain: number}} GrainsSlot */

export const CELLO_HARMONIUM = {
  name: 'cello harmonium',
  shortName: 'harmonium',
  slots: [
    { sample: 'a_00', rootNote: 57.0, selStart: 0.152244, selEnd: 0.838141, gain: 0.734180 },
    { sample: 'd_00', rootNote: 50.0, selStart: 0.168269, selEnd: 0.839744, gain: 0.779688 },
    { sample: 'g_00', rootNote: 43.0, selStart: 0.177885, selEnd: 0.794872, gain: 1.0 },
    { sample: 'c_00', rootNote: 36.0, selStart: 0.149038, selEnd: 0.794872, gain: 1.0 },
  ],
  mode: 0,
  scan: 0.249969,
  shape: -0.002687,
  jitter: 0.177797,
  dual: true,
  keyFollow: 1.0,
  density: 82.203560,
  primeL: 11,
  primeR: 9,
  dur: 0.418087,
  posNoise: 0.0,
  pitchL: 0,
  pitchR: 0,
  attack: 0.709097,
  decay: 0.198410,
  sustain: 0.749313,
  release: 0.803257,
  crossNotes: [53.25, 47.32, 37.77],
  crossWidth: 7.13,
  morphBlend: 0,
  morphAmount: 0,
  pressureDepth: 0.5,
  timbreDepth: 0,
  masterGain: 1.745406,
};

export const CELLO_GRAINS = {
  name: 'cello grains',
  shortName: 'cello',
  slots: [
    { sample: 'a_02', rootNote: 57.0, selStart: 0.224359, selEnd: 0.698718, gain: 0.734180 },
    { sample: 'd_02', rootNote: 50.0, selStart: 0.169872, selEnd: 0.626603, gain: 0.779688 },
    { sample: 'g_02', rootNote: 43.0, selStart: 0.149038, selEnd: 0.573718, gain: 1.0 },
    { sample: 'c_02', rootNote: 36.0, selStart: 0.197115, selEnd: 0.660256, gain: 1.0 },
  ],
  mode: 0,
  scan: 0.214344,
  shape: -0.002687,
  jitter: 0.177797,
  dual: true,
  keyFollow: 1.0,
  density: 82.203560,
  primeL: 11,
  primeR: 9,
  dur: 0.418087,
  posNoise: 0.0,
  pitchL: 0,
  pitchR: 0,
  attack: 0.709097,
  decay: 0.198410,
  sustain: 0.749313,
  release: 0.074670,
  crossNotes: [53.25, 47.32, 37.77],
  crossWidth: 7.13,
  morphBlend: 0,
  morphAmount: 0,
  pressureDepth: 0.5,
  timbreDepth: 0,
  masterGain: 1.745406,
};

// The daduk samples are RMS-matched at bundle time, so the desktop's saved
// master gain would be meaningless here — see GranularPatch.swift for the
// offline level-matching that produced 1.6, and the −6 dB Dan asked for to
// sit the horn under the cello.
export const DADUK_HORN = {
  name: 'daduk horn',
  shortName: 'daduk',
  slots: [
    { sample: 'daduk_01', rootNote: 71.0, selStart: 0.2552, selEnd: 0.6847, gain: 1.0 },
    { sample: 'daduk_02', rootNote: 64.0, selStart: 0.1959, selEnd: 0.7007, gain: 1.0 },
    { sample: 'daduk_03', rootNote: 55.0, selStart: 0.2087, selEnd: 0.6975, gain: 1.0 },
    { sample: 'daduk_04', rootNote: 48.0, selStart: 0.2071, selEnd: 0.6959, gain: 1.0 },
  ],
  mode: 0,
  scan: 0.472,
  shape: 0,
  jitter: 0.108,
  dual: false,
  keyFollow: 0.5,
  density: 82.203560,
  primeL: 11,
  primeR: 9,
  dur: 0.280,
  posNoise: 0.005,
  pitchL: 0,
  pitchR: 0,
  attack: 0.086,
  decay: 0.200,
  sustain: 0.750,
  release: 1.714,
  crossNotes: [51.5, 59.5, 67.5],
  crossWidth: 6.0,
  morphBlend: 0,
  morphAmount: 0,
  pressureDepth: 0.5,
  timbreDepth: 0,
  masterGain: 0.80,
};

/** Patch order matches the iOS tray's MODE radio: cello · daduk · harmonium. */
export const GRAINS_PATCHES = [CELLO_GRAINS, DADUK_HORN, CELLO_HARMONIUM];

export const DEFAULT_GRAINS_PATCH = CELLO_GRAINS;
