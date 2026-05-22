/**
 * Envelope - per-pool ADSR scheduler.
 *
 * One class, two singleton instances exported below: `droneEnvelope`
 * (used by AudioEngine.muteOscillator/unmuteOscillator) and
 * `keyboardEnvelope` (used by KeyboardVoiceManager.noteOn/Off). They
 * share scheduling code; only the four numbers (A/D/S/R) and listener
 * sets differ.
 *
 * applyNoteOn schedules 0 → peak → peak·sustain on a gain node.
 * applyNoteOff ramps current → 0 over R and returns the absolute end
 * time so the keyboard pool can schedule osc.stop() while the drone
 * pool just observes (drones run continuously).
 *
 * retargetSustain is for live UI control: the panel calls onChange when
 * sustain moves, and held drones / non-released keyboard voices glide
 * to the new peak·sustain target via setTargetAtTime.
 */

const RETARGET_TAU = 0.05;

class Envelope {
  constructor({ attack = 0.03, decay = 0.2, sustain = 0.7, release = 0.3 } = {}) {
    this.attack = attack;
    this.decay = decay;
    this.sustain = sustain;
    this.release = release;
    this._listeners = new Set();
  }

  setAttack(seconds)  { this.attack  = Math.max(0.001, seconds); this._notify(); }
  setDecay(seconds)   { this.decay   = Math.max(0.001, seconds); this._notify(); }
  setSustain(amp)     { this.sustain = Math.max(0, Math.min(1, amp)); this._notify(); }
  setRelease(seconds) { this.release = Math.max(0.001, seconds); this._notify(); }

  /** Subscribe to value changes. Returns an unsubscribe fn. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (e) { console.error('envelope listener error', e); }
    }
  }

  /**
   * Schedule a fresh attack→decay→sustain on `gainParam` (an AudioParam).
   * `peak` is the velocity-scaled target the attack ramps up to; the
   * sustain segment then holds at peak·sustain until applyNoteOff or
   * retargetSustain is called.
   *
   * `attackOverride` (seconds) lets a caller substitute a longer attack
   * time without mutating the envelope's own value — used by the
   * computer-keyboard source so its expressive ramp doesn't bleed into
   * MIDI play through the shared singleton.
   *
   * When `mode === 'ar'`, the decay→sustain segment is omitted: gain
   * ramps 0 → peak over attack and then stays at peak. Used by the kbd
   * source so the ramp-up plateau matches the level the player reaches,
   * with no slump to a sustain factor.
   */
  applyNoteOn(gainParam, ctx, peak = 1, attackOverride = null, mode = 'adsr') {
    const t = ctx.currentTime;
    const attack = attackOverride !== null ? Math.max(0.001, attackOverride) : this.attack;
    gainParam.cancelScheduledValues(t);
    gainParam.setValueAtTime(0, t);
    gainParam.linearRampToValueAtTime(peak, t + attack);
    if (mode !== 'ar') {
      const sustainLevel = peak * this.sustain;
      gainParam.linearRampToValueAtTime(sustainLevel, t + attack + this.decay);
    }
  }

  /**
   * Snap an in-progress attack to "held at current gain". Cancels any
   * remaining scheduled ramps and pins the value at whatever it reads
   * right now — no sustain multiplication, no glide. Used by the kbd
   * source on keyup so the note keeps sounding at exactly the level the
   * player dialed in. Returns the captured gain so the caller can store
   * it on the voice (for visualizer reads / re-trigger comparisons).
   */
  freezeToCurrent(gainParam, ctx) {
    const t = ctx.currentTime;
    const cur = gainParam.value;
    gainParam.cancelScheduledValues(t);
    gainParam.setValueAtTime(cur, t);
    return cur;
  }

  /**
   * Ramp `gainParam` from its current value to 0 over `release`.
   * Returns the absolute time the release lands on 0 — keyboard pool
   * uses it to schedule osc.stop(); drone pool ignores the return.
   */
  applyNoteOff(gainParam, ctx) {
    const t = ctx.currentTime;
    const cur = gainParam.value;
    gainParam.cancelScheduledValues(t);
    gainParam.setValueAtTime(cur, t);
    gainParam.linearRampToValueAtTime(0, t + this.release);
    return t + this.release;
  }

  /**
   * Glide a held node's gain toward peak·sustain. Used after a sustain
   * slider change so already-sounding notes follow the new envelope
   * shape live. Caller decides whether the node is eligible (e.g.
   * skip muted drones, skip released keyboard voices).
   */
  retargetSustain(gainParam, ctx, peak) {
    const t = ctx.currentTime;
    const target = peak * this.sustain;
    gainParam.cancelScheduledValues(t);
    gainParam.setValueAtTime(gainParam.value, t);
    gainParam.setTargetAtTime(target, t, RETARGET_TAU);
  }
}

// Per-pool defaults: drones lean toward longer A/R for swell-y character;
// keyboard leans snappier for playability. Both user-tunable from the
// Settings panel.
//
// Drones don't actually have a meaningful envelope segment — they run
// continuously — so `sustain` here is just the steady-state level
// multiplier applied at every drone gain target site (_droneTargetGain
// et al). Holding it at 1.0 means the slider's 0..1 value lands
// directly at the per-drone gain node; multi-drone summing is handled
// downstream by droneCountScale, and absolute level is bounded by the
// master + post-master saturator. Previously 0.7 to bake in headroom,
// but that meant "slider 1.0" never reached unity loudness — the per-
// source bus knobs in the Mixer then had to compensate, which was a
// double accounting of headroom. The fair geometry is sustain=1.0
// here, no HEADROOM in droneCountScale, master fader for level.
export const droneEnvelope = new Envelope({
  attack: 0.3,
  decay: 0.2,
  sustain: 1.0,
  release: 0.5,
});
// MIDI-keyboard envelope — full ADSR, velocity-sensitive sustain.
export const keyboardEnvelope = new Envelope({
  attack: 0.1,
  decay: 1.0,
  sustain: 0.4,
  release: 0.3,
});
// Computer-keyboard envelope — only attack and release are used (the
// AR mode in applyNoteOn skips decay/sustain). The kbd source runs
// expressively: long attack ramp the player rides, then freezeNote on
// keyup pins the reached level until released. `release` here is what
// noteOff and voice-stealing within the kbd cap fade over.
export const computerKbdEnvelope = new Envelope({
  attack: 2.0,
  decay: 0.001,
  sustain: 1.0,
  release: 0.7,
});

export default Envelope;
