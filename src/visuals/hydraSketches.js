/**
 * Default Hydra sketch — runs automatically the moment Hydra mode is
 * enabled, and seeds the CodeMirror editor on first open. The user-
 * facing preset list was removed; saved sketches live in localStorage
 * under "Yours" instead.
 */

export const BUILTIN_SKETCHES = [
  {
    id: 'builtin_chromatic',
    name: 'Chromatic',
    description: 'RGB-split lissajous with low-frequency feedback noise. The default boot sketch.',
    code: `src(s0).color(1, 0, 0)
  .modulate(osc(9, 0.04, 1), 0.01)
  .add(src(s0).color(0, 1, 0)
       .modulate(osc(10, 0.1, 1), 0.01)
      )
  .add(src(s0).color(0, 0, 1)
       .modulate(osc(11, -0.1, 1), 0.01)
      )
  .add(src(o0)
       .modulate(noise(4, 0.1), 0.01)
       , 0.4)
.out(o0)`,
  },
  {
    id: 'builtin_mouse_feedback',
    name: 'Mouse feedback',
    description: 'Chromatic RGB-split with feedback whose scale follows mouse.x and blend follows mouse.y.',
    code: `src(s0).color(1, 0, 0)
  .modulate(osc(9, 0.04, 1), 0.01)
  .add(src(s0).color(0, 1, 0)
       .modulate(osc(10, 0.1, 1), 0.01)
      )
  .add(src(s0).color(0, 0, 1)
       .modulate(osc(11, -0.1, 1), 0.01)
      )
  .add(src(o0)
       .add(src(o0).scale(() => 3*mouse.x/width)),
       () => mouse.y/height
      )
  .add(src(o0)
       .modulate(noise(4, 0.1), 0.01)
       , 0.4)
.out(o0)`,
  },
];

export const DEFAULT_SKETCH_ID = 'builtin_chromatic';
