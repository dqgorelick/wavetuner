/**
 * Noise - looped-buffer noise source (pink / white / brown).
 *
 * Web Audio has no native noise node, so each color is baked into a
 * 2-second stereo AudioBuffer (independent samples per channel for a
 * wide, decorrelated image) and played through a looping
 * AudioBufferSourceNode. Buffers are generated lazily per color and
 * cached for the life of the AudioContext.
 *
 *   white — flat spectrum, plain uniform random
 *   pink  — −3 dB/oct, Paul Kellett's 7-pole economy filter
 *   brown — −6 dB/oct, leaky integrator over white
 *
 * Colors are RMS-matched at bake time so switching between them keeps
 * roughly constant loudness (white would otherwise read much louder
 * than brown at equal peak).
 *
 * This module is the UI-facing state singleton (level + color +
 * onChange), mirroring Wave/Fold: AudioEngine subscribes and owns the
 * actual nodes — see _applyNoise / _startNoiseSource there.
 */

export const NOISE_TYPES = {
  pink: {
    id: 'pink',
    label: 'Pink',
    blurb: 'Equal energy per octave — the classic warm hiss.',
  },
  white: {
    id: 'white',
    label: 'White',
    blurb: 'Flat spectrum — bright, airy static.',
  },
  brown: {
    id: 'brown',
    label: 'Brown',
    blurb: 'Low-weighted rumble, like distant surf.',
  },
};

export const NOISE_TYPE_IDS = Object.keys(NOISE_TYPES);
export const DEFAULT_NOISE_TYPE = 'pink';

const BUFFER_SECONDS = 2;
// Target RMS per channel after normalization. 0.15 at full level sits
// in the same loudness ballpark as a couple of unity drones.
const TARGET_RMS = 0.15;

function fillWhite(data) {
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
}

// Paul Kellett's "economy" pink filter (refined version), run over
// fresh white samples. State starts at zero; the ~1k-sample warmup
// transient is inaudible inside a 2s loop.
function fillPink(data) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
}

// Leaky integrator: each step drifts toward the new white sample but
// the 1/1.02 leak keeps it bounded (a true random walk would wander
// off scale over 2 seconds).
function fillBrown(data) {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last;
  }
}

const FILLERS = { white: fillWhite, pink: fillPink, brown: fillBrown };

function normalizeRms(data) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / data.length) || 1;
  // RMS-match, but never let brown/pink's slow peaks clip.
  const scale = Math.min(TARGET_RMS / rms, 0.95 / (peak || 1));
  for (let i = 0; i < data.length; i++) data[i] *= scale;
}

const bufferCache = new WeakMap(); // AudioContext → { type: AudioBuffer }

export function getNoiseBuffer(audioContext, type) {
  const id = NOISE_TYPES[type] ? type : DEFAULT_NOISE_TYPE;
  let perCtx = bufferCache.get(audioContext);
  if (!perCtx) {
    perCtx = {};
    bufferCache.set(audioContext, perCtx);
  }
  if (perCtx[id]) return perCtx[id];
  const length = Math.round(audioContext.sampleRate * BUFFER_SECONDS);
  const buffer = audioContext.createBuffer(2, length, audioContext.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    FILLERS[id](data);
    normalizeRms(data);
  }
  perCtx[id] = buffer;
  return buffer;
}

class Noise {
  constructor({ level = 0, type = DEFAULT_NOISE_TYPE } = {}) {
    this.level = Math.max(0, Math.min(1, level));
    this.type = NOISE_TYPES[type] ? type : DEFAULT_NOISE_TYPE;
    // iOS noisePostSaturation parity: false (default) = noise is summed
    // pre-master and passes THROUGH the master saturator; true = it
    // joins after the chain and stays clean however hard the saturator
    // is driven. Engine crossfades the two routes on change.
    this.postSaturation = false;
    // Feed noise into the pre-master analyser tap so the scope/spectrum
    // draw it. Default off — broadband noise fuzzes the trace and
    // everything else reading the analysers.
    this.showInViz = false;
    this._listeners = new Set();
  }

  setLevel(v) {
    const next = Math.max(0, Math.min(1, v));
    if (next === this.level) return;
    this.level = next;
    this._notify();
  }

  setType(t) {
    if (!NOISE_TYPES[t] || t === this.type) return;
    this.type = t;
    this._notify();
  }

  setPostSaturation(v) {
    const next = !!v;
    if (next === this.postSaturation) return;
    this.postSaturation = next;
    this._notify();
  }

  setShowInViz(v) {
    const next = !!v;
    if (next === this.showInViz) return;
    this.showInViz = next;
    this._notify();
  }

  /** Square-law level → gain so the bottom half of the dial isn't all hiss. */
  gainValue() {
    return this.level * this.level;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (e) { console.error('noise listener error', e); }
    }
  }
}

export const noise = new Noise({ level: 0 });

export default Noise;
