/**
 * Shader visual backend — pure WebGL2, no hydra-synth dependency.
 *
 * Renders three preset sketches that share one chromatic + feedback
 * fragment shader. The Chromatic preset skips the extra feedback layer;
 * Feedback chromatic and Mouse feedback both enable it. The two
 * sliders in the panel (`Feedback scale` / `Feedback blend`) drive its
 * uniforms via setVfxParams. Mouse-drag on the scope updates the same
 * sliders, so the Mouse-feedback preset still reads as drag-controlled.
 *
 * Pipeline per frame:
 *   1. Upload the oscilloscope canvas pixels into the s0 texture.
 *   2. Render the effect to the default framebuffer (the overlay canvas).
 *   3. Copy the canvas back into the o0 texture for next frame's feedback.
 *
 * One texture for o0 + a same-frame copy after draw is sound because the
 * shader reads o0 BEFORE we copy this frame's output into it — no read/
 * write hazard within a frame.
 *
 * The GLSL math is reimplemented from first principles (sine, smoothstep-
 * blended hash noise, simple UV transforms). It does NOT vendor any code
 * from hydra-synth, which keeps this backend AGPL-free.
 */

// Live-coding requires a JS-evaluable DSL; the shader backend ships
// three fixed presets and exposes no editor.
export const supportsLiveCode = false;

export const DEFAULT_SKETCH_ID = 'builtin_chromatic';

// Sketch metadata. Order matters — the panel renders them in this order.
// `useExtraFeedback` gates the second feedback layer; vfx slider values
// drive its uniforms when on. Chromatic leaves the layer off so the
// sliders only affect the feedback presets, matching the Hydra DSL.
const SKETCHES = [
  {
    id: 'builtin_chromatic',
    name: 'Chromatic',
    description: 'RGB-split lissajous with noise-modulated feedback.',
    useExtraFeedback: false,
  },
  {
    id: 'builtin_feedback_chromatic',
    name: 'Feedback chromatic',
    description: 'Chromatic + extra feedback layer driven by the Feedback sliders.',
    useExtraFeedback: true,
  },
  {
    id: 'builtin_mouse_feedback',
    name: 'Mouse feedback',
    description: 'Same shape — drag the scope to scrub the Feedback sliders.',
    useExtraFeedback: true,
  },
];

export function getSketches() {
  return SKETCHES.map(({ id, name, description }) => ({ id, name, description }));
}

let currentSketch = SKETCHES[0];

let gl = null;
let canvasRef = null;
let sourceCanvasRef = null;
let program = null;
let quadVAO = null;
let s0Texture = null;
let o0Texture = null;
let uniforms = {};
let rafHandle = 0;
let startTimeMs = 0;
// vfx params — slider-driven (App owns the React state, pushes here via
// setVfxParams). Defaults match the Feedback-chromatic preset values so
// the visuals show a noticeable effect on first load.
let vfxScale = 1.05;
let vfxBlend = 0.23;
let texWidth = 0;
let texHeight = 0;

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_s0;
uniform sampler2D u_o0;
uniform float u_time;
uniform float u_extraScale;
uniform float u_extraBlend;

in vec2 v_uv;
out vec4 fragColor;

// Hydra's osc, reimplemented: RGB-phase-shifted sine along x.
vec4 osc(vec2 st, float freq, float sync, float offset) {
  float r = sin((st.x - offset * 2.0 / freq + u_time * sync) * freq) * 0.5 + 0.5;
  float g = sin((st.x + u_time * sync) * freq) * 0.5 + 0.5;
  float b = sin((st.x + offset / freq + u_time * sync) * freq) * 0.5 + 0.5;
  return vec4(r, g, b, 1.0);
}

// 3D hash-based smooth value noise. Approximates Hydra's simplex noise
// at the small modulation amounts the sketches use (0.01) without
// vendoring any code from hydra-synth's tree.
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash3(i);
  float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  ) * 2.0 - 1.0;
}
vec4 sampleNoise(vec2 st, float scale, float offset) {
  float n = valueNoise3(vec3(st * scale, u_time * offset));
  return vec4(vec3(n), 1.0);
}

// Hydra primitives: modulate (UV displacement), scaleSt (UV zoom around
// 0.5, 0.5), colorize (multiply tint, negative tint inverts), addLayer
// (the (c0+c1)*amt + c0*(1-amt) blend).
vec2 modulate(vec2 st, vec4 c0, float amount) {
  return st + c0.xy * amount;
}
vec2 scaleSt(vec2 st, float amount) {
  return (st - vec2(0.5)) * (1.0 / amount) + vec2(0.5);
}
vec4 colorize(vec4 c, float r, float g, float b) {
  vec4 tint = vec4(r, g, b, 1.0);
  vec4 pos = step(0.0, tint);
  return mix((1.0 - c) * abs(tint), c * tint, pos);
}
vec4 addLayer(vec4 c0, vec4 c1, float amount) {
  return (c0 + c1) * amount + c0 * (1.0 - amount);
}

void main() {
  vec2 st = v_uv;

  // RGB-split: three reads of s0 each tinted to one channel and
  // UV-displaced by an oscillating gradient at slightly different
  // frequencies — produces the chromatic-aberration shimmer.
  vec4 cR = colorize(
    texture(u_s0, modulate(st, osc(st, 9.0,  0.04, 1.0), 0.01)),
    1.0, 0.0, 0.0
  );
  vec4 cG = colorize(
    texture(u_s0, modulate(st, osc(st, 10.0,  0.1, 1.0), 0.01)),
    0.0, 1.0, 0.0
  );
  vec4 cB = colorize(
    texture(u_s0, modulate(st, osc(st, 11.0, -0.1, 1.0), 0.01)),
    0.0, 0.0, 1.0
  );

  vec4 result = addLayer(addLayer(cR, cG, 1.0), cB, 1.0);

  // Feedback_chromatic / Mouse_feedback only. extraBlend == 0 (chromatic)
  // skips the layer entirely — addLayer(c0, c1, 0) collapses to c0.
  if (u_extraBlend > 0.0) {
    vec4 extra = addLayer(
      texture(u_o0, st),
      texture(u_o0, scaleSt(st, u_extraScale)),
      1.0
    );
    result = addLayer(result, extra, u_extraBlend);
  }

  // Always-on noise-modulated feedback at blend 0.4 — gives the visuals
  // their drifting low-frequency wobble.
  vec4 noiseFeedback = texture(u_o0, modulate(st, sampleNoise(st, 4.0, 0.1), 0.01));
  result = addLayer(result, noiseFeedback, 0.4);

  fragColor = result;
}`;

function compileShader(type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

function linkProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`Program link failed: ${log}`);
  }
  return p;
}

function createTexture() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

// Ensure the o0 texture has storage matching the canvas size. Re-runs on
// resize; cheap when size is unchanged (we gate it).
function ensureTexStorage(w, h) {
  if (w === texWidth && h === texHeight) return;
  texWidth = w;
  texHeight = h;
  gl.bindTexture(gl.TEXTURE_2D, o0Texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

function render(timeMs) {
  if (!gl || !canvasRef) return;
  rafHandle = requestAnimationFrame(render);

  const w = canvasRef.width;
  const h = canvasRef.height;
  if (w === 0 || h === 0) return;
  ensureTexStorage(w, h);

  // 1. Upload the live oscilloscope pixels into s0.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s0Texture);
  if (sourceCanvasRef && sourceCanvasRef.width > 0 && sourceCanvasRef.height > 0) {
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvasRef
    );
  }

  // 2. Render the effect to the on-screen canvas.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s0Texture);
  gl.uniform1i(uniforms.u_s0, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, o0Texture);
  gl.uniform1i(uniforms.u_o0, 1);
  gl.uniform1f(uniforms.u_time, (timeMs - startTimeMs) / 1000);

  // Sliders drive the feedback uniforms; chromatic preset skips the
  // layer entirely by zeroing them out at the binding site.
  const useFb = currentSketch.useExtraFeedback;
  gl.uniform1f(uniforms.u_extraScale, useFb ? vfxScale : 0);
  gl.uniform1f(uniforms.u_extraBlend, useFb ? vfxBlend : 0);

  gl.bindVertexArray(quadVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // 3. Capture this frame's output as next frame's feedback. The shader
  // already finished sampling o0 (last frame's pixels) before this copy,
  // so there's no read/write hazard.
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, o0Texture);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
}

export function setVfxParams(scale, blend) {
  vfxScale = scale;
  vfxBlend = blend;
}

export function selectSketch(id) {
  const found = SKETCHES.find((s) => s.id === id);
  if (found) currentSketch = found;
}

export function startVisuals({ canvas, sourceCanvas } = {}) {
  if (gl || !canvas) return null;
  gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
  if (!gl) {
    console.warn('[visuals] WebGL2 not available — visuals disabled');
    return null;
  }
  canvasRef = canvas;
  sourceCanvasRef = sourceCanvas;

  // Flip uploaded canvas textures vertically. The oscilloscope canvas
  // stores pixels top-down (row 0 = top), but GL's texture coordinate
  // (0, 0) is bottom-left — sampling it raw inverts the visual. Setting
  // this once makes every subsequent texImage2D from a canvas source
  // upload upright. copyTexSubImage2D (used for the o0 feedback path)
  // is unaffected; it's a framebuffer-to-texture copy that keeps GL's
  // bottom-left convention end-to-end.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
  program = linkProgram(vs, fs);
  uniforms = {
    u_s0: gl.getUniformLocation(program, 'u_s0'),
    u_o0: gl.getUniformLocation(program, 'u_o0'),
    u_time: gl.getUniformLocation(program, 'u_time'),
    u_extraScale: gl.getUniformLocation(program, 'u_extraScale'),
    u_extraBlend: gl.getUniformLocation(program, 'u_extraBlend'),
  };

  // Fullscreen quad — two triangles in NDC. Stays bound via the VAO for
  // every draw; we only call drawArrays after that.
  quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  s0Texture = createTexture();
  o0Texture = createTexture();
  texWidth = 0;
  texHeight = 0;

  startTimeMs = performance.now();
  rafHandle = requestAnimationFrame(render);
  return { gl };
}

export function stopVisuals() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = 0;
  if (gl) {
    if (program) gl.deleteProgram(program);
    if (quadVAO) gl.deleteVertexArray(quadVAO);
    if (s0Texture) gl.deleteTexture(s0Texture);
    if (o0Texture) gl.deleteTexture(o0Texture);
  }
  gl = null;
  canvasRef = null;
  sourceCanvasRef = null;
  program = null;
  quadVAO = null;
  s0Texture = null;
  o0Texture = null;
  texWidth = 0;
  texHeight = 0;
}

export function setVisualResolution(/* width, height */) {
  // No-op — the render loop reads canvasRef.width/height directly and
  // ensures the o0 texture matches each frame. The canvas itself is
  // sized by HydraOverlay's ResizeObserver, which already updates
  // canvas.width/height before we read them here.
}

export function evalUserCode() {
  return { ok: false, error: 'Live coding is not available in the shader build.' };
}
