/**
 * Hydra wrapper — boots a hydra-synth instance pointed at our overlay
 * canvas, with the oscilloscope canvas wired in as source slot 0.
 *
 * `makeGlobal: true` is the live-coding default — `src`, `osc`, `s0`,
 * `o0`, etc. land on `window` so user sketches can read like normal
 * Hydra (`src(s0).kaleid(4).out()`). Eval happens via plain `eval()`.
 *
 * Lifecycle:
 *   start({ canvas, sourceCanvas })  — create the synth + bind s0.
 *   eval(code)                        — run a sketch; returns
 *                                       { ok, error? } so the panel
 *                                       can surface compile errors.
 *   hush()                            — Hydra's built-in silence-all.
 *   stop()                            — hush + drop the instance so
 *                                       a future start() rebuilds it.
 *
 * The hydra-synth instance does NOT clean up its WebGL contexts when
 * dropped — the browser handles it on canvas removal. We keep
 * `instance` truthy as a "is running?" gate so re-toggling works.
 */

import HydraSynth from 'hydra-synth';

let instance = null;
let lastError = null;

/**
 * Boot Hydra (idempotent — re-calling with a different canvas rebinds).
 * Must be called from inside the React tree once the canvas refs exist.
 */
export function startHydra({ canvas, sourceCanvas, width, height }) {
  if (instance) {
    // Already running — just re-bind s0 in case the source canvas
    // changed (e.g. oscilloscope DPR-resized).
    if (sourceCanvas && window.s0) {
      try { window.s0.init({ src: sourceCanvas }); } catch (e) { lastError = e; }
    }
    return instance;
  }
  if (!canvas) return null;
  // Match the canvas's backing-store size by default — Hydra's internal
  // render targets size to (width, height), and undersizing causes the
  // visible blur the user noticed when feeding video through it.
  const w = width || canvas.width || 1280;
  const h = height || canvas.height || 720;
  instance = new HydraSynth({
    canvas,
    detectAudio: false,
    enableStreamCapture: false,
    makeGlobal: true,
    width: w,
    height: h,
    autoLoop: true,
  });
  if (sourceCanvas && window.s0) {
    try { window.s0.init({ src: sourceCanvas }); } catch (e) { lastError = e; }
  }
  return instance;
}

/**
 * Eval a sketch string in Hydra's global context. Returns { ok } or
 * { ok: false, error } — the panel renders error.message for compile
 * problems.
 */
export function evalHydra(code) {
  if (!instance) return { ok: false, error: 'Hydra is not running' };
  try {
    (0, eval)(code);
    lastError = null;
    return { ok: true };
  } catch (e) {
    lastError = e;
    return { ok: false, error: e.message || String(e) };
  }
}

/** Hydra's silence-all — stops audio + clears all output buffers. */
export function hushHydra() {
  if (!instance) return;
  try { window.hush?.(); } catch { /* ignore */ }
}

/**
 * Resize Hydra's internal render targets (s0..s3, o0..o3) so feedback
 * effects via o0 stay aligned with the canvas after a window resize.
 * Without this the output buffer keeps its construction-time size and
 * `src(o0)` reads from an old-sized texture, leaving black bars or
 * stretched feedback at the new edges. No-op when Hydra isn't running.
 *
 * `width` and `height` are in backing-store pixels (DPR-multiplied).
 */
export function setHydraResolution(width, height) {
  if (!instance) return;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  try {
    if (typeof instance.setResolution === 'function') {
      instance.setResolution(w, h);
    }
  } catch (e) {
    lastError = e;
    console.warn('Hydra setResolution failed:', e);
  }
}

/**
 * Stop Hydra and drop the instance. Used when the user toggles Hydra
 * mode off — start() rebuilds fresh on next enable.
 */
export function stopHydra() {
  hushHydra();
  instance = null;
}

export function isHydraRunning() {
  return instance !== null;
}

export function getHydraError() {
  return lastError;
}
