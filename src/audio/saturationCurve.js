/**
 * Saturation styles + the sample-level transfer function.
 *
 * The master saturator itself lives in /public/soft-limiter-worklet.js,
 * which has to stay dependency-free (audioWorklet.addModule loads it
 * raw), so the curve math is necessarily written twice. This module is
 * the main-thread copy: the tray's style radios read `SAT_STYLES`, and
 * SaturationPreview draws `saturate()` so the picture in the menu is the
 * same curve the audio thread is running. Keep the two in step.
 */

// Each style gets the same one-line character fragment the noise colors
// carry, shown inline after the "style" label in the tray.
//
// TODO(unify): iOS ships a different vocabulary here — four named
// styles (tape / smooth / crunch / fuzz, each with its own ADAA1 curve)
// plus a separate `punish` macro that pushes extra level-compensated
// drive on top, and its own enabled flag rather than an "off" style.
// Web has five raw curves, no punish. Pick one model and port it both
// ways: the style names + blurbs (SaturationStyle.swift), the punish
// slider (SourceTray.saturateSections), and the amount/enabled split.
export const SAT_STYLES = [
  { id: 'off', label: 'off', short: 'bypassed — the chain is out of the way' },
  { id: 'tanh', label: 'soft', short: 'smooth symmetric squash' },
  { id: 'cubic', label: 'cubic', short: 'gentle knee, warm odd harmonics' },
  { id: 'sine', label: 'sine', short: 'sine transfer — folds over at the top' },
  { id: 'hard', label: 'hard', short: 'brick-wall clip, buzzy edges' },
];

const HALF_PI = Math.PI / 2;

/**
 * One sample through the master curve. `drive` is the pre-curve gain
 * (the worklet's AudioParam); 'off' is a true bypass, so drive does not
 * apply there — same as the worklet's early-out.
 */
export function saturate(x, style, drive = 1) {
  if (style === 'off') return x;
  const d = x * drive;
  switch (style) {
    case 'tanh':
      return Math.tanh(d);
    case 'cubic':
      if (d >= 1) return 1;
      if (d <= -1) return -1;
      return 1.5 * d - 0.5 * d * d * d;
    case 'sine':
      if (d >= 1) return 1;
      if (d <= -1) return -1;
      return Math.sin(d * HALF_PI);
    case 'hard':
      return Math.max(-1, Math.min(1, d));
    default:
      return x;
  }
}
