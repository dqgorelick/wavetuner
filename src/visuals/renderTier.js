/**
 * renderTier — one source of truth for how hard the two full-viewport
 * render pipelines are allowed to work.
 *
 * Two things dominate the app's continuous cost once the audio graph and
 * the consonance field are accounted for, and both scale with exactly
 * these two numbers:
 *
 *   1. The oscilloscope's 2D canvas — a full-viewport trail fill plus two
 *      wide round-joined polyline strokes, every frame.
 *   2. The shader overlay — that whole canvas uploaded into a GL texture
 *      and run through a fragment pass, every frame.
 *
 * Cost is (pixels) x (frames), so the tier sets both: a DPR cap for the
 * backing stores and a frame-rate cap for the loops. They are read live —
 * the scope and shader loops call maxFrameMs() each frame, and the canvas
 * sizers call dprCap() on every resize — so flipping the tier in settings
 * takes effect without remounting anything.
 *
 * Tiers mirror the existing vizQuality setting:
 *   'pretty'      — DPR 2, 60 fps. What every platform used to run.
 *   'performance' — DPR 1.5, 30 fps. ~44% fewer pixels per frame and half
 *                   the frames: roughly a third of the fill, stroke,
 *                   texture-upload and fragment work. The default on
 *                   phone-sized viewports, where this was cooking the
 *                   device; one tap in settings restores 'pretty'.
 *   'off'         — same caps as 'performance' (it renders the cheap
 *                   timeline visualizer rather than nothing at all).
 *
 * DPR is capped rather than scaled: at DPR 3 the difference between a
 * 1.5x and a 2x backing store on a phone screen is not resolvable, but it
 * is 1.8x the fragment and upload work.
 */

const TIERS = {
  pretty: { dpr: 2, fps: 60 },
  performance: { dpr: 1.5, fps: 30 },
  off: { dpr: 1.5, fps: 30 },
};

let _tier = TIERS.pretty;
const _listeners = new Set();

/** Set the active tier by vizQuality name. Unknown names fall back to 'pretty'. */
export function setRenderTier(quality) {
  const next = TIERS[quality] || TIERS.pretty;
  if (next === _tier) return;
  _tier = next;
  for (const fn of _listeners) {
    try { fn(_tier); } catch (e) { console.error('renderTier listener error', e); }
  }
}

/**
 * Subscribe to tier changes. Loops that read the caps every frame don't need
 * this; anything that CACHES a result of dprCap() (a sized backing store, a
 * curve that only repaints when its inputs move) does — otherwise it keeps
 * the old resolution until something else happens to invalidate it.
 * Returns an unsubscribe.
 */
export function onRenderTierChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** DPR ceiling for canvas backing stores. */
export function dprCap() {
  return Math.min(window.devicePixelRatio || 1, _tier.dpr);
}

/**
 * Minimum milliseconds between rendered frames. The 1.5 ms tolerance keeps
 * a genuine 60 Hz display from dropping every other frame to timer jitter
 * at the 60 fps cap.
 */
export function maxFrameMs() {
  return 1000 / _tier.fps - 1.5;
}

/** True when this viewport should default to the cheaper tier. */
export function prefersPerformanceTier() {
  return typeof window !== 'undefined'
    && window.matchMedia('(max-width: 768px)').matches;
}
