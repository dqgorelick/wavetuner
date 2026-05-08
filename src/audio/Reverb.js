/**
 * Reverb - convolution reverb with three room presets and a wet/dry mix.
 *
 * Sits at the END of the audio chain, AFTER the analyzer split-off, so
 * the visualizer always sees the dry signal. Wet signal goes through a
 * ConvolverNode loaded with a procedurally-generated IR (decaying
 * stereo noise, RMS-normalized so room sizes feel similarly loud).
 *
 * Three room presets:
 *   - 'room'      : small intimate space, ~0.6 s tail, fast decay
 *   - 'hall'      : medium concert hall,  ~1.8 s tail
 *   - 'cathedral' : long diffuse space,   ~4.0 s tail, slow decay
 *
 * The wet/dry crossfade is equal-power (cos / sin) so perceived
 * loudness stays roughly constant across the slider.
 *
 * Singleton with onChange — AudioEngine subscribes to rebuild the IR
 * (on room change) or update the gain mix (on wet change).
 */

const ROOM_PRESETS = {
  room:      { duration: 0.6, decay: 4.0 },
  hall:      { duration: 1.8, decay: 3.0 },
  cathedral: { duration: 4.0, decay: 2.0 },
};

export const ROOM_NAMES = Object.keys(ROOM_PRESETS);

/**
 * Generate a stereo impulse response: per-channel decorrelated noise
 * with `Math.exp(-decay * t)` envelope. RMS-normalized to a fixed
 * target so all rooms perceive at similar wet loudness.
 */
function buildRoomIR(ctx, room) {
  const preset = ROOM_PRESETS[room] || ROOM_PRESETS.room;
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(preset.duration * sampleRate));
  const ir = ctx.createBuffer(2, length, sampleRate);
  const FADE_TAIL = 0.05; // smooth the final 5% to zero so the IR ends cleanly

  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // exp decay × hard tail-fade at the very end so the IR truly
      // lands on zero (avoids a click on convolution boundaries).
      const env = Math.exp(-preset.decay * t)
                * (t > 1 - FADE_TAIL ? (1 - t) / FADE_TAIL : 1);
      const sample = (Math.random() * 2 - 1) * env;
      data[i] = sample;
      energy += sample * sample;
    }
  }
  // RMS-normalize. Target 0.1 → modest convolved output level so the
  // wet path stays in healthy headroom range when wet=1.
  const rms = Math.sqrt(energy / (2 * length));
  const targetRMS = 0.1;
  if (rms > 0) {
    const norm = targetRMS / rms;
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] *= norm;
    }
  }
  return ir;
}

class Reverb {
  constructor({ room = 'room', wet = 0 } = {}) {
    this.room = ROOM_PRESETS[room] ? room : 'room';
    this.wet = Math.max(0, Math.min(1, wet));
    this._listeners = new Set();
  }

  setRoom(name) {
    if (!ROOM_PRESETS[name] || name === this.room) return;
    this.room = name;
    this._notify({ kind: 'room' });
  }

  setWet(v) {
    const next = Math.max(0, Math.min(1, v));
    if (next === this.wet) return;
    this.wet = next;
    this._notify({ kind: 'wet' });
  }

  /** Equal-power crossfade gains for the current wet position. */
  gains() {
    const phase = this.wet * Math.PI * 0.5;
    return { dry: Math.cos(phase), wet: Math.sin(phase) };
  }

  /** Build a fresh AudioBuffer IR for the current room + given context. */
  buildIR(ctx) {
    return buildRoomIR(ctx, this.room);
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(info) {
    for (const fn of this._listeners) {
      try { fn(this, info); } catch (e) { console.error('reverb listener error', e); }
    }
  }
}

export const reverb = new Reverb();
export default Reverb;
