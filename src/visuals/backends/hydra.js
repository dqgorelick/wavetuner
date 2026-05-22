/**
 * Hydra visual backend — boots a hydra-synth instance pointed at the
 * overlay canvas, with the oscilloscope canvas wired in as source slot 0.
 *
 * One of two backends behind ../backend.js. Implements the visual-backend
 * contract: startVisuals / stopVisuals / setVisualResolution /
 * setVisualMouse / evalUserCode. AGPL-licensed (hydra-synth) — only
 * bundled in dev / Hydra-flagged builds; the shader backend ships in
 * production builds. See research/ios-port-plan.md §2 for the iOS port.
 *
 * `makeGlobal: true` is the live-coding default — `src`, `osc`, `s0`,
 * `o0`, etc. land on `window` so user sketches can read like normal
 * Hydra (`src(s0).kaleid(4).out()`). Eval happens via plain `eval()`.
 *
 * The hydra-synth instance does NOT clean up its WebGL contexts when
 * dropped — the browser handles it on canvas removal. We keep
 * `instance` truthy as a "is running?" gate so re-toggling works.
 */

import HydraSynth from 'hydra-synth';
import { audioFeatures } from '../../audio/AudioFeatures';
import { BUILTIN_SKETCHES, DEFAULT_SKETCH_ID as HYDRA_DEFAULT_ID } from '../hydraSketches';

// Marker the panel uses to decide whether to render the CodeMirror
// editor + "Yours" list. Hydra supports arbitrary user code; the shader
// backend sets this to `false` and the editor disappears.
export const supportsLiveCode = true;

// Re-exported for callers that need the default at boot. Mirrors the
// shader backend's identically named export — same id string so a
// switched-out build still runs the same default sketch.
export const DEFAULT_SKETCH_ID = HYDRA_DEFAULT_ID;

// Panel uses this to populate its preset picker. `code` is included so
// the editor can seed itself with the source on load (shader backend
// strips the field — Hydra is the only backend with editable code).
export function getSketches() {
  return BUILTIN_SKETCHES.map(({ id, name, description, code }) => ({
    id, name, description, code,
  }));
}

let instance = null;

// vfx params — slider-driven (App owns the React state, pushes here via
// setVfxParams). Exposed to Hydra sketches as `window.vfx` so callbacks
// like `() => vfx.scale` read the live slider value. Defaults match the
// Feedback chromatic preset constants the sketches used to hardcode.
let vfxScale = 1.05;
let vfxBlend = 0.23;

export function setVfxParams(scale, blend) {
  vfxScale = scale;
  vfxBlend = blend;
}

/**
 * Boot Hydra (idempotent — re-calling with a different canvas rebinds).
 * Must be called from inside the React tree once the canvas refs exist.
 */
export function startVisuals({ canvas, sourceCanvas, width, height }) {
  if (instance) {
    // Already running — just re-bind s0 in case the source canvas
    // changed (e.g. oscilloscope DPR-resized).
    if (sourceCanvas && window.s0) {
      // wrap:'clamp' is required because the oscilloscope canvas is
      // sized to the viewport (DPR × display px) — almost never a
      // power-of-2 dimension. WebGL1's default REPEAT wrap on the
      // source texture errors out with "incompatible wrap mode" on
      // non-POT textures, blanking the visuals; clamp-to-edge works
      // for any size and is what we want for a live image source.
      // NOTE: hydra-source.init(opts, params) only forwards `params`
      // (second arg) into regl.texture — `wrap` must live there, not
      // inside the opts object alongside `src`.
      try { window.s0.init({ src: sourceCanvas }, { wrap: 'clamp' }); } catch { /* ignore */ }
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
    // highp eliminates time/coordinate stepping at large values. Paired
    // with the half-float framebuffer patch (see patches/), the feedback
    // chain runs with enough precision to kill the 8-bit color banding
    // that mediump + RGBA8 produced.
    precision: 'highp',
  });
  if (sourceCanvas && window.s0) {
    try { window.s0.init({ src: sourceCanvas }, { wrap: 'clamp' }); } catch { /* ignore */ }
  }
  // Expose audio features under `audio` so sketches can do
  //   .scale(() => 1 + audio.dissonance * 0.5)
  // without any extra setup. The object reference is stable across
  // frames; the scope's animation loop mutates its fields in place.
  window.audio = audioFeatures;
  // Expose vfx slider values on `window.vfx` so sketches read live
  // slider state via `() => vfx.scale` / `() => vfx.blend`. Getters
  // re-read the module state every frame so React updates surface
  // immediately without re-binding the object.
  window.vfx = VIRTUAL_VFX;
  return instance;
}

const VIRTUAL_VFX = Object.freeze({
  get scale() { return vfxScale; },
  get blend() { return vfxBlend; },
});

/**
 * Pick a built-in sketch by id and eval its code. App.jsx calls this at
 * boot with DEFAULT_SKETCH_ID, and the panel's preset clicks route
 * through it so the same call works for both backends. Silently no-ops
 * on unknown ids.
 */
export function selectSketch(id) {
  const sketch = BUILTIN_SKETCHES.find((s) => s.id === id);
  if (!sketch) return;
  evalUserCode(sketch.code);
}

/**
 * Eval a sketch string in Hydra's global context. Returns { ok } or
 * { ok: false, error } — the panel renders error.message for compile
 * problems. Only callable when supportsLiveCode is true.
 */
export function evalUserCode(code) {
  if (!instance) return { ok: false, error: 'Hydra is not running' };
  try {
    (0, eval)(code);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** Silence-all — stops audio + clears all output buffers. */
function hushVisuals() {
  if (!instance) return;
  try { window.hush?.(); } catch { /* ignore */ }
}

/**
 * Resize the backend's internal render targets so feedback effects stay
 * aligned with the canvas after a window resize. Without this the output
 * buffer keeps its construction-time size and `src(o0)` reads from an
 * old-sized texture, leaving black bars or stretched feedback at the new
 * edges. No-op when the backend isn't running.
 *
 * `width` and `height` are in backing-store pixels (DPR-multiplied).
 */
export function setVisualResolution(width, height) {
  if (!instance) return;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  try {
    if (typeof instance.setResolution === 'function') {
      instance.setResolution(w, h);
    }
  } catch (e) {
    console.warn('Hydra setResolution failed:', e);
  }
}

/**
 * Stop the backend and drop the instance. start() rebuilds fresh on
 * next enable.
 */
export function stopVisuals() {
  hushVisuals();
  instance = null;
}
