import { createProgram } from "./shader-manager.js";

const SKY_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;

out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const SKY_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 uTopColor;
uniform vec3 uMidColor;
uniform vec3 uHorizonColor;
uniform float uCameraPitch;

in vec2 vUv;

out vec4 outColor;

void main() {
  float y = clamp(vUv.y, 0.0, 1.0);
  float horizon = clamp(0.36 + uCameraPitch * 0.055, 0.28, 0.48);
  float mid = pow(smoothstep(horizon - 0.04, 1.20, y), 1.04);
  vec3 sky = mix(uMidColor, uTopColor, mid * 0.88);

  // Keep the skyline soft and white like the reference image instead of a hard
  // clear-color cutoff. This is a single fullscreen pass, so it is cheaper than
  // adding extra horizon geometry.
  float horizonBand = 1.0 - smoothstep(horizon - 0.13, horizon + 0.70, y);
  float lowerMist = 1.0 - smoothstep(0.0, horizon + 0.26, y);
  vec3 color = mix(sky, uHorizonColor, clamp(horizonBand * 0.78 + lowerMist * 0.36, 0.0, 1.0));

  float vignette = smoothstep(0.95, 0.12, distance(vUv, vec2(0.5, 0.58)));
  color += vec3(0.018, 0.028, 0.040) * vignette;
  outColor = vec4(color, 1.0);
}
`;

export class SkyGradient {
  constructor(gl) {
    this.gl = gl;
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.vbo = null;
    this.byteLength = 6 * 2 * 4;
  }

  init() {
    if (this.program) return this;
    const gl = this.gl;
    this.program = createProgram(gl, SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER);
    this.uniforms = collectUniforms(gl, this.program);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      3, -1,
      -1, 3,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    return this;
  }

  render({ cameraState, lighting }) {
    if (!this.program) this.init();
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform3f(this.uniforms.uTopColor, 0.025, 0.300, 0.820);
    gl.uniform3f(this.uniforms.uMidColor, 0.22, 0.76, 0.98);
    gl.uniform3f(this.uniforms.uHorizonColor, lighting?.fogColor?.[0] ?? 0.92, lighting?.fogColor?.[1] ?? 0.98, lighting?.fogColor?.[2] ?? 1.0);
    gl.uniform1f(this.uniforms.uCameraPitch, Number(cameraState?.pitch) || 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return { drawCalls: 1, triangles: 1, bufferMemory: this.byteLength };
  }

  dispose() {
    const gl = this.gl;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.vbo = null;
    this.vao = null;
    this.program = null;
  }
}

function collectUniforms(gl, program) {
  const names = ["uTopColor", "uMidColor", "uHorizonColor", "uCameraPitch"];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}
