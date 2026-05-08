/**
 * StereoWidth - global Pan-mode + width control.
 *
 * Two pan modes the user can switch between:
 *
 *   mode = 'lr'        — Hard L/R panning. Each keyboard voice
 *                         inherits the L/R routing of the drone slot
 *                         it sounds (legacy v1 behaviour). Width still
 *                         drives a bus-wide M/S crossfeed for both
 *                         drones and voices.
 *
 *   mode = 'voicepan'  — Oberheim-style "Voice Pan". Each voice gets
 *                         a random pan in [-width, +width] at noteOn;
 *                         live voices ramp to fresh randoms when the
 *                         slider moves. Width=0 collapses voices to
 *                         center; width=1 is full random spread.
 *
 * Bus crossfeed (always applied, independent of mode):
 *   through = (1 + width) / 2
 *   cross   = (1 - width) / 2
 *   out_L = through·L + cross·R
 *   out_R = through·R + cross·L
 * Sits AFTER the analyzer split-off so the lissajous never sees it.
 *
 * Lissajous behaviour follows mode:
 *   - In 'lr' the audio path is clean enough to read directly.
 *   - In 'voicepan' the analyzer signal is smeared by random pans, so
 *     the scope renders from the synth round-robin instead (rank-based
 *     L/R distribution — see synthStereoDataRoundRobin).
 */

const VALID_MODES = new Set(['lr', 'voicepan']);

class StereoWidth {
  constructor({ width = 1, mode = 'lr' } = {}) {
    this.width = Math.max(0, Math.min(1, width));
    this.mode = VALID_MODES.has(mode) ? mode : 'lr';
    this._listeners = new Set();
  }

  setWidth(v) {
    const next = Math.max(0, Math.min(1, v));
    if (next === this.width) return;
    this.width = next;
    this._notify({ kind: 'width' });
  }

  setMode(m) {
    if (!VALID_MODES.has(m) || m === this.mode) return;
    this.mode = m;
    this._notify({ kind: 'mode' });
  }

  /** Returns the four crossfeed gain coefficients for the current width. */
  gains() {
    const through = (1 + this.width) / 2;
    const cross = (1 - this.width) / 2;
    return { through, cross };
  }

  /** Random pan in [-width, +width] — used per voice spawn / live re-randomize. */
  randomPan() {
    return (Math.random() * 2 - 1) * this.width;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(info) {
    for (const fn of this._listeners) {
      try { fn(this, info); } catch (e) { console.error('stereoWidth listener error', e); }
    }
  }
}

export const stereoWidth = new StereoWidth();
export default StereoWidth;
