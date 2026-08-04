/**
 * StereoMode - per-pool pan mode + detune curve.
 *
 * Used independently for the drone pool (`droneStereo`) and keyboard
 * pool (`keyboardStereo`).
 *
 * DRONES are mode-blind (iOS parity, 2026-08-04): every drone always
 * renders as a detuned primary/partner pair under the collapse-pan law,
 * with the detune offset and the partner's gain narrowing with pan
 * width. `mode` is then just a pan PRESET — selecting one batch-glides
 * the per-voice pan dials to that preset's origins:
 *
 * mode = 'lr'      Alternating hard pans (even → L, odd → R) — the
 *                   classic routing. At a hard pan the pair degenerates
 *                   to one clean in-tune oscillator, so the preset
 *                   sounds exactly like the old single-osc L/R mode.
 *
 * mode = 'stereo'  All pans centered: each slot's pair splits hard
 *                   L/R, primary at base + curve[i]·detuneHz/2,
 *                   partner at base − curve[i]·detuneHz/2.
 *
 * KEYBOARD/MIDI voices still gate on the mode (single osc + panner in
 * 'lr', dual-osc merger in 'stereo') — their mode-blind rework is a
 * separate follow-up. That's why `detuneHzAt` keeps the mode gate while
 * the drone engine reads `nominalDetuneHzAt`.
 *
 * detuneHz         Master scale in Hz. PINNED at MAX_DETUNE_HZ since
 *                   2026-08-04 — the ceiling slider is gone and the
 *                   per-voice sliders in the frequency panels are the
 *                   only detune control surface. Kept as a field so the
 *                   legacy-ceiling fold and old patches stay
 *                   expressible (see foldLegacyCeiling).
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

/** The Hz axis every detune surface shares (iOS parity, `DetuneScale`).
 *  With the ceiling pinned at 10 Hz a linear axis would squeeze all the
 *  slow beating everyone actually reaches for into the bottom 10% of
 *  travel, so the axis is log-ish: the bottom half covers 0–1 Hz
 *  (linear — log can't reach 0), the top half 1–10 Hz (log₁₀).
 *
 *  This maps Hz ⇄ display/drag position ONLY; the engine still reads
 *  curve × MAX_DETUNE_HZ. */
export const DetuneScale = {
  /** Hz → axis position [0, 1]. */
  norm(hz) {
    const clamped = Math.max(0, Math.min(MAX_DETUNE_HZ, hz || 0));
    if (clamped <= 1) return clamped * 0.5;
    return 0.5 + 0.5 * Math.log10(clamped);
  },
  /** Axis position [0, 1] → Hz. */
  hz(norm) {
    const clamped = Math.max(0, Math.min(1, norm || 0));
    if (clamped <= 0.5) return clamped * 2;
    return Math.pow(10, (clamped - 0.5) * 2);
  },
  /** Curve value [0, 1] → axis position (curve `v` ⇒ v × MAX_DETUNE_HZ). */
  curveNorm(value) { return DetuneScale.norm((value || 0) * MAX_DETUNE_HZ); },
  /** Axis position → curve value. */
  curveValue(norm) { return DetuneScale.hz(norm) / MAX_DETUNE_HZ; },
};

/** Legacy-patch fold. Patches and shared URLs saved before the ceiling
 *  was pinned stored their own `detuneHz` (default 1); scaling their
 *  curve by ceiling/MAX reproduces the SAME effective per-slot Hz under
 *  the pinned ceiling, so old sessions sound identical and a re-save
 *  writes the folded curve. Derived purely from the stored values, so
 *  re-loading the same patch is idempotent. */
export function foldLegacyCeiling(curve, ceilingHz) {
  const f = Number.isFinite(ceilingHz)
    ? Math.max(0, Math.min(MAX_DETUNE_HZ, ceilingHz)) / MAX_DETUNE_HZ
    : 1;
  return curve.map(v => Math.max(0, Math.min(1, (+v || 0) * f)));
}

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
 * Channel weights for one drone voice under the collapse-pan model —
 * the single pan law since the drone engine went mode-blind.
 * `pan` ∈ [−1, +1] is the per-voice dial; returns [L, R] weight pairs
 * for the primary and partner oscillators.
 *
 * The pair starts split (primary hard L, partner hard R) and the dial
 * slides BOTH oscillators toward the pan side with an equal-power law
 * over the moving half, so every detent reproduces the pre-pan graph
 * exactly: center → [1,0]/[0,1] (classic split), full R → [0,1]/[0,1]
 * (pair collapsed right), full L mirrored. At the extremes the partner
 * has faded to 0 (see panWidth), so a hard pan is bit-identical to the
 * old single-osc 'lr' routing. The old lr balance law (center = mono
 * [1,1] "⊙ both") is gone with the mode gate — center is the split.
 */
export function dronePanWeights(pan) {
  const p = Math.max(-1, Math.min(1, pan || 0));
  const q = Math.max(0, p) * (Math.PI / 2);   // rightward dial travel
  const r = Math.max(0, -p) * (Math.PI / 2);  // leftward dial travel
  return {
    primary: [Math.cos(q), Math.sin(q)],
    partner: [Math.sin(r), Math.cos(r)],
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
  /** `newSlotHz` — the detune a freshly-added slot gets (see
   *  resizeCurve). Under the pinned ceiling this is what used to be the
   *  pool's default master Hz, so adding a drone still lands on the
   *  same gentle beating it always did. */
  constructor({ mode = 'lr', newSlotHz = 1, detuneCurve = [] } = {}) {
    this.mode = VALID_MODES.has(mode) ? mode : 'lr';
    // Pinned — there is no ceiling control anymore. Legacy ceilings are
    // folded into the curve at load (foldLegacyCeiling).
    this.detuneHz = MAX_DETUNE_HZ;
    this.newSlotValue = Math.max(0, Math.min(1, newSlotHz / MAX_DETUNE_HZ));
    this.detuneCurve = detuneCurve.map(v => Math.max(0, Math.min(1, v)));
    this._listeners = new Set();
  }

  setMode(m) {
    if (!VALID_MODES.has(m) || m === this.mode) return;
    this.mode = m;
    this._notify({ kind: 'mode' });
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
   *  curve is empty (engine hasn't initialized yet).
   *
   *  The raw smooth values are uniform on the DISPLAY axis (DetuneScale),
   *  not on the curve value — under the pinned 10 Hz ceiling uniform
   *  curve values would average 5 Hz of beating. `maxHz` caps the top of
   *  that axis: the startup seed passes the pool's own newSlotHz so a
   *  fresh load keeps its familiar gentle spread, while an explicit
   *  RANDOM press spans the full ceiling. */
  randomizeCurve(maxHz = MAX_DETUNE_HZ) {
    if (this.detuneCurve.length === 0) return;
    const top = DetuneScale.norm(maxHz);
    this.detuneCurve = smoothRandomCurve(this.detuneCurve.length)
      .map(n => DetuneScale.curveValue(n * top));
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

  /** Resize the curve to N slots. New slots default to `newSlotValue`
   *  (the pool's newSlotHz under the pinned ceiling — 1 Hz for drones,
   *  1.5 Hz for keyboard voices) so a freshly-added drone picks up an
   *  audible-but-gentle detune; the voice's own panel slider takes it
   *  from there. Excess slots are truncated. Fires 'curve' if anything
   *  changed. */
  resizeCurve(n) {
    const target = Math.max(0, Math.floor(n));
    if (target === this.detuneCurve.length) return;
    if (target > this.detuneCurve.length) {
      while (this.detuneCurve.length < target) this.detuneCurve.push(this.newSlotValue);
    } else {
      this.detuneCurve.length = target;
    }
    this._notify({ kind: 'curve', structural: true });
  }

  /** Final detune (Hz) for slot i, applying the curve × master scale.
   *  Returns 0 in lr mode — the KEYBOARD/MIDI pools still gate their
   *  detune on the mode (and their lr voices would apply the FULL
   *  offset, not the half-spread — see KeyboardVoiceManager
   *  _reapplyVoiceDetune). The mode-blind drone engine must NOT use
   *  this — it reads nominalDetuneHzAt. */
  detuneHzAt(i) {
    if (this.mode !== 'stereo') return 0;
    return (this.detuneCurve[i] || 0) * this.detuneHz;
  }

  /** Curve × master scale for slot i in EVERY mode — the mode-blind
   *  read (iOS `detuneHzAt`). The drone engine narrows this by pan
   *  width per voice, so it fades to 0 at a hard pan on its own. */
  nominalDetuneHzAt(i) {
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
//     expect on first load). New slots detune 1 Hz — subtle warmth on
//     the held bed without obvious beating.
//   - Computer keyboard starts in 'stereo' so pressing a key gives the
//     dual-osc L≠R width by default — that's the more interesting voice
//     setup. New slots detune 1.5 Hz — keyboard voices are transient so
//     the spread reads clearly even at gentle widths.
//   - MIDI starts in 'stereo' as a separate StereoMode instance so the
//     mixer can toggle MIDI's pan mode independently from the computer
//     keyboard. Its own detuneCurve is unused — MIDI voices read
//     keyboardStereo's curve via the proxy below.
export const droneStereo = new StereoMode({ newSlotHz: 1 });
export const keyboardStereo = new StereoMode({ mode: 'stereo', newSlotHz: 1.5 });
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
