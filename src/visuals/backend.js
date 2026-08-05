/**
 * Visual backend — public surface for whichever rendering implementation
 * is active. Two backends live under ./backends/:
 *
 *   - shader.js — current default. AGPL-free WebGL2 pipeline, 3 preset
 *                 sketches, mirrors the iOS Metal API. Much cheaper on
 *                 mobile than hydra-synth.
 *   - hydra.js  — opt-in (VITE_VISUAL_BACKEND=hydra). AGPL
 *                 (hydra-synth), full live-coding.
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
 * vite.config.js. VITE_VISUAL_BACKEND=shader (default) or =hydra picks
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
  supportsFeedback,
  consumesAudioFeatures,
  DEFAULT_SKETCH_ID,
} from '@visual-backend';
