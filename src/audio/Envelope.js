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
   */
  applyNoteOn(gainParam, ctx, peak = 1) {
    const t = ctx.currentTime;
    const sustainLevel = peak * this.sustain;
    gainParam.cancelScheduledValues(t);
    gainParam.setValueAtTime(0, t);
    gainParam.linearRampToValueAtTime(peak, t + this.attack);
    gainParam.linearRampToValueAtTime(sustainLevel, t + this.attack + this.decay);
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
export const droneEnvelope = new Envelope({
  attack: 0.3,
  decay: 0.2,
  sustain: 0.7,
  release: 0.5,
});
export const keyboardEnvelope = new Envelope({
  attack: 0.03,
  decay: 0.2,
  sustain: 0.7,
  release: 0.3,
});

export default Envelope;
