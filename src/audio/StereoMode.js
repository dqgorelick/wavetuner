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
// Exported: the orb detune flash normalizes its spread angle against this
// (full slider = ±90°), so the dial and the display share one ceiling.
export const MAX_DETUNE_HZ = 10;

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

/**
 * Channel weights for one drone voice under the collapse-pan model.
 * `pan` ∈ [−1, +1] is the per-voice dial; returns [L, R] weight pairs
 * for the primary and partner oscillators.
 *
 * In 'stereo' mode the pair starts split (primary hard L, partner hard
 * R) and the dial slides BOTH oscillators toward the pan side with an
 * equal-power law over the moving half, so every detent reproduces the
 * pre-pan graph exactly: center → [1,0]/[0,1] (classic split), full
 * R → [0,1]/[0,1] (pair collapsed right), full L mirrored.
 *
 * In 'lr' mode there is one audible oscillator and the dial is a
 * balance knob: the on-side stays at 1 while the opposite side
 * attenuates, so center reproduces the legacy ⊙ "both" state ([1,1])
 * and the extremes reproduce hard L/R. Partner weights are parked at
 * [0,1] (its gain is 0 in lr; parked-on-R matches the legacy wiring so
 * a mode flip only has to ramp gains, not re-place the image).
 */
export function dronePanWeights(pan, mode) {
  const p = Math.max(-1, Math.min(1, pan || 0));
  const q = Math.max(0, p) * (Math.PI / 2);   // rightward dial travel
  const r = Math.max(0, -p) * (Math.PI / 2);  // leftward dial travel
  if (mode === 'stereo') {
    return {
      primary: [Math.cos(q), Math.sin(q)],
      partner: [Math.sin(r), Math.cos(r)],
    };
  }
  return {
    primary: [Math.cos(q), Math.cos(r)],
    partner: [0, 1],
  };
}

/**
 * How much of the stereo character survives at this pan position:
 * 1 at center → 0 at the extremes. Scales BOTH the effective detune
 * (so a hard-panned voice converges on its true orb frequency) and the
 * partner oscillator's gain (so the pair degenerates to a single clean
 * oscillator at the extreme — never two identical-frequency oscs
 * summing with arbitrary phase).
 */
export function panWidth(pan) {
  return 1 - Math.abs(Math.max(-1, Math.min(1, pan || 0)));
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
    // index → listeners can tell a single-slot edit (curve-editor drag)
    // from a whole-curve replace; the orb flash uses it to pick which
    // voice swaps its number for the Hz readout.
    this._notify({ kind: 'curve', index: i });
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
    // structural: the slot count changed, not the user's detune intent —
    // audio listeners still retune, but UI flashes should stay quiet.
    this._notify({ kind: 'curve', structural: true });
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
    this._notify({ kind: 'curve', structural: true });
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
//   - MIDI starts in 'stereo' as a separate StereoMode instance so the
//     mixer can toggle MIDI's pan mode independently from the computer
//     keyboard. Its own detuneHz/detuneCurve fields are unused — there
//     is only one "Keyboard stereo" detune control in Settings, and MIDI
//     voices read keyboardStereo's curve + master Hz via the proxy below.
export const droneStereo = new StereoMode({ detuneHz: 1 });
export const keyboardStereo = new StereoMode({ mode: 'stereo', detuneHz: 1.5 });
export const midiStereo = new StereoMode({ mode: 'stereo' });

/** Pick the StereoMode-like object that drives a given voice source.
 *  kbd voices use keyboardStereo directly (mode + detune both come from
 *  the "Keyboard stereo" panel). MIDI voices get a proxy that takes its
 *  pan mode from midiStereo (so the mixer's MIDI stereo toggle is
 *  independent) but its detune amount from keyboardStereo — so the
 *  Settings panel's keyboard detune drives both kbd and MIDI together. */
export function stereoForSource(source) {
  if (source !== 'midi') return keyboardStereo;
  return {
    get mode() { return midiStereo.mode; },
    detuneHzAt(i) {
      if (midiStereo.mode !== 'stereo') return 0;
      return (keyboardStereo.detuneCurve[i] || 0) * keyboardStereo.detuneHz;
    },
  };
}

export default StereoMode;
