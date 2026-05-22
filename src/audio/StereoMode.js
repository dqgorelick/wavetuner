/**
 * StereoMode - per-pool pan mode + detune curve.
 *
 * Used independently for the drone pool (`droneStereo`) and keyboard
 * pool (`keyboardStereo`).
 *
 * mode = 'lr'      Hard L/R panning. Drones route per the engine's
 *                   routing map; keyboard voices inherit the slot's
 *                   L/R routing. Detune curve is ignored in this mode
 *                   — drones play clean tuning.
 *
 * mode = 'stereo'  Each drone is split into two oscillators: primary
 *                   plays base + curve[i]·detuneHz/2 → L, partner
 *                   plays base − curve[i]·detuneHz/2 → R. Keyboard
 *                   voices inherit the same per-slot detune amount
 *                   (single osc, panned center).
 *
 * detuneHz         Master scale in Hz, range [0, MAX_DETUNE_HZ]. Acts
 *                   as both the Y-axis ceiling for the curve display
 *                   and the multiplier applied to curve values.
 *
 * detuneCurve      Array of normalized [0, 1] values, one per drone
 *                   slot. Resized via resizeCurve(n) when the engine
 *                   adds/removes slots so the array length always
 *                   matches the live drone count. Final detune for
 *                   slot i (Hz) = detuneCurve[i] × detuneHz.
 */

const VALID_MODES = new Set(['lr', 'stereo']);
const MAX_DETUNE_HZ = 10;

/**
 * Smooth random curve in [0, 1] with N samples. Perlin-style: random
 * key values placed every K slots, smoothstep-interpolated between, so
 * neighboring slots have similar values rather than independent noise.
 * Looks "gentle" — most slots are mid-amplitude with a few peaks and
 * valleys, instead of jagged white noise.
 */
export function smoothRandomCurve(n) {
  if (n <= 0) return [];
  if (n === 1) return [Math.random()];
  // K = how many slots per random key point. Lower = more variation
  // (more peaks across the curve), higher = gentler. ~3 slots per key
  // point gives 2-3 humps over a typical 4-12 drone setup.
  const K = 3;
  const keyCount = Math.ceil(n / K) + 2;
  const seeds = [];
  for (let i = 0; i < keyCount; i++) seeds.push(Math.random());

  const out = [];
  for (let i = 0; i < n; i++) {
    const x = i / K;
    const i0 = Math.floor(x);
    const f = x - i0;
    const v0 = seeds[i0];
    const v1 = seeds[i0 + 1] ?? v0;
    // Cubic smoothstep — C¹-continuous, no kinks.
    const s = f * f * (3 - 2 * f);
    out.push(v0 * (1 - s) + v1 * s);
  }
  return out;
}

class StereoMode {
  constructor({ mode = 'lr', detuneHz = 0, detuneCurve = [] } = {}) {
    this.mode = VALID_MODES.has(mode) ? mode : 'lr';
    this.detuneHz = Math.max(0, Math.min(MAX_DETUNE_HZ, detuneHz));
    this.detuneCurve = detuneCurve.map(v => Math.max(0, Math.min(1, v)));
    this._listeners = new Set();
  }

  setMode(m) {
    if (!VALID_MODES.has(m) || m === this.mode) return;
    this.mode = m;
    this._notify({ kind: 'mode' });
  }

  setDetuneHz(v) {
    const next = Math.max(0, Math.min(MAX_DETUNE_HZ, v));
    if (next === this.detuneHz) return;
    this.detuneHz = next;
    this._notify({ kind: 'detune' });
  }

  /** Set one slot's curve value [0, 1]. Caller passes a slot index in
   *  [0, detuneCurve.length). Out-of-range writes are silently dropped
   *  so a stray drag past the edge can't grow the array. */
  setDetuneCurveAt(i, value) {
    if (i < 0 || i >= this.detuneCurve.length) return;
    const next = Math.max(0, Math.min(1, value));
    if (Math.abs(next - this.detuneCurve[i]) < 1e-4) return;
    this.detuneCurve[i] = next;
    this._notify({ kind: 'curve' });
  }

  /** Replace the entire curve. Length must match the current drone
   *  count or the call is dropped — use resizeCurve() to add/remove
   *  slots safely. */
  setDetuneCurve(arr) {
    if (!Array.isArray(arr) || arr.length !== this.detuneCurve.length) return;
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      const next = Math.max(0, Math.min(1, arr[i]));
      if (Math.abs(next - this.detuneCurve[i]) >= 1e-4) {
        this.detuneCurve[i] = next;
        changed = true;
      }
    }
    if (changed) this._notify({ kind: 'curve' });
  }

  /** Replace the curve with a fresh smooth-random curve at the current
   *  length. Fires 'curve' so audio retunes immediately. No-op if the
   *  curve is empty (engine hasn't initialized yet). */
  randomizeCurve() {
    if (this.detuneCurve.length === 0) return;
    this.detuneCurve = smoothRandomCurve(this.detuneCurve.length);
    this._notify({ kind: 'curve' });
  }

  /** Splice out the curve entry at `index`, shifting higher slots down
   *  by 1. Used when an arbitrary slot is removed (vs resizeCurve, which
   *  always truncates the tail). Fires 'curve' so audio retunes. */
  removeCurveAt(index) {
    if (index < 0 || index >= this.detuneCurve.length) return;
    this.detuneCurve.splice(index, 1);
    this._notify({ kind: 'curve' });
  }

  /** Resize the curve to N slots. New slots default to 1.0 (full curve
   *  weight) so a freshly-added drone picks up the master detune scale
   *  immediately — adjust the master Hz to control how prominent it is.
   *  Excess slots are truncated. Fires 'curve' if anything changed. */
  resizeCurve(n) {
    const target = Math.max(0, Math.floor(n));
    if (target === this.detuneCurve.length) return;
    if (target > this.detuneCurve.length) {
      while (this.detuneCurve.length < target) this.detuneCurve.push(1);
    } else {
      this.detuneCurve.length = target;
    }
    this._notify({ kind: 'curve' });
  }

  /** Final detune (Hz) for slot i, applying the curve × master scale.
   *  Returns 0 in lr mode — caller doesn't have to branch on mode. */
  detuneHzAt(i) {
    if (this.mode !== 'stereo') return 0;
    return (this.detuneCurve[i] || 0) * this.detuneHz;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(info) {
    for (const fn of this._listeners) {
      try { fn(this, info); } catch (e) { console.error('stereoMode listener error', e); }
    }
  }
}

// Defaults:
//   - Drone stays in 'lr' (preserves the legacy hard-pan look that users
//     expect on first load). Master detune 0.5 Hz — subtle warmth on the
//     held bed without obvious beating.
//   - Computer keyboard starts in 'stereo' so pressing a key gives the
//     dual-osc L≠R width by default — that's the more interesting voice
//     setup. Master detune 1.5 Hz — keyboard voices are transient so the
//     spread reads clearly even at gentle widths.
//   - MIDI also starts in 'stereo' with the same detune as kbd, but is
//     a separate StereoMode instance so the mixer can toggle MIDI's pan
//     mode independently from the computer keyboard.
export const droneStereo = new StereoMode({ detuneHz: 1 });
export const keyboardStereo = new StereoMode({ mode: 'stereo', detuneHz: 1.5 });
export const midiStereo = new StereoMode({ mode: 'stereo', detuneHz: 1.5 });

/** Pick the StereoMode instance that owns a given voice source. */
export function stereoForSource(source) {
  return source === 'midi' ? midiStereo : keyboardStereo;
}

export default StereoMode;
