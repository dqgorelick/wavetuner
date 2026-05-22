/**
 * Visual backend — public surface for whichever rendering implementation
 * is active. Two backends live under ./backends/:
 *
 *   - hydra.js  — current default. AGPL (hydra-synth), full live-coding.
 *   - shader.js — stub for now; gains a real WebGL2 pipeline in step 3.
 *                 AGPL-free, 3 preset sketches, mirrors the iOS Metal API.
 *
 * Contract (kept minimal so adding the shader backend later is mechanical):
 *
 *   startVisuals({ canvas, sourceCanvas, width, height }) → instance | null
 *   stopVisuals()                                          → void
 *   setVisualResolution(width, height)                     → void
 *   setVfxParams(scale, blend)                             → void
 *   selectSketch(id)                                       → void
 *   getSketches()                                          → [{id, name, description, code?}]
 *   evalUserCode(code)                                     → { ok, error? }
 *   supportsLiveCode                                       → boolean
 *   DEFAULT_SKETCH_ID                                      → string
 *
 * `@visual-backend` is a Vite alias resolved at build time — see
 * vite.config.js. VITE_VISUAL_BACKEND=hydra (default) or =shader picks
 * the implementation; the unselected file is tree-shaken from the bundle.
 */

export {
  startVisuals,
  stopVisuals,
  setVisualResolution,
  setVfxParams,
  evalUserCode,
  selectSketch,
  getSketches,
  supportsLiveCode,
  DEFAULT_SKETCH_ID,
} from '@visual-backend';
