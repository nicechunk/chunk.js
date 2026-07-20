import { cross3, normalize3 } from "../core/math.js";
import { createProgram } from "./shader-manager.js";

const SUN_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;

uniform mat4 uViewProjection;
uniform vec3 uCenter;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uRadius;

out vec2 vUv;

void main() {
  vUv = aCorner;
  vec3 p = uCenter + (uRight * aCorner.x + uUp * aCorner.y) * uRadius;
  gl_Position = uViewProjection * vec4(p, 1.0);
}
`;

const SUN_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 uDiscColor;
uniform vec3 uHaloColor;
uniform float uOpacity;

in vec2 vUv;

out vec4 outColor;

void main() {
  float d = length(vUv);
  float disc = 1.0 - smoothstep(0.32, 0.46, d);
  float halo = 1.0 - smoothstep(0.24, 1.0, d);
  float alpha = clamp(disc * 0.9 + halo * 0.34, 0.0, 1.0) * uOpacity;
  if (alpha <= 0.01) discard;
  vec3 color = mix(uHaloColor, uDiscColor, clamp(disc + 0.22, 0.0, 1.0));
  outColor = vec4(color, alpha);
}
`;

export class SunDisc {
  constructor(gl) {
    this.gl = gl;
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.vbo = null;
    this.ibo = null;
    this.indexCount = 6;
    this.byteLength = 8 * 4 + 6 * 2;
  }

  init() {
    if (this.program) return this;
    const gl = this.gl;
    this.program = createProgram(gl, SUN_VERTEX_SHADER, SUN_FRAGMENT_SHADER);
    this.uniforms = collectUniforms(gl, this.program);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return this;
  }

  render({ viewProjection, cameraState, lighting }) {
    if (!this.program) this.init();
    const gl = this.gl;
    const sunDir = lighting.sunDirection;
    const distance = lighting.sunDiscDistance;
    const cameraLocal = [
      Number(cameraState.localOffsetX) || 0,
      Number(cameraState.localOffsetY) || 0,
      Number(cameraState.localOffsetZ) || 0,
    ];
    const center = [
      cameraLocal[0] + sunDir[0] * distance,
      cameraLocal[1] + sunDir[1] * distance,
      cameraLocal[2] + sunDir[2] * distance,
    ];
    const right = normalize3([Math.cos(cameraState.yaw || 0), 0, -Math.sin(cameraState.yaw || 0)]);
    const cp = Math.cos(cameraState.pitch || 0);
    const forward = normalize3([Math.sin(cameraState.yaw || 0) * cp, -Math.sin(cameraState.pitch || 0), Math.cos(cameraState.yaw || 0) * cp]);
    const up = normalize3(cross3(right, forward));

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    gl.uniform3f(this.uniforms.uCenter, center[0], center[1], center[2]);
    gl.uniform3f(this.uniforms.uRight, right[0], right[1], right[2]);
    gl.uniform3f(this.uniforms.uUp, up[0], up[1], up[2]);
    gl.uniform1f(this.uniforms.uRadius, lighting.sunDiscRadius);
    gl.uniform3f(this.uniforms.uDiscColor, lighting.sunDiscColor[0], lighting.sunDiscColor[1], lighting.sunDiscColor[2]);
    gl.uniform3f(this.uniforms.uHaloColor, lighting.sunHaloColor[0], lighting.sunHaloColor[1], lighting.sunHaloColor[2]);
    gl.uniform1f(this.uniforms.uOpacity, lighting.sunDiscOpacity);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    return { drawCalls: 1, triangles: 2, bufferMemory: this.byteLength };
  }

  dispose() {
    const gl = this.gl;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.vbo = null;
    this.ibo = null;
    this.vao = null;
    this.program = null;
  }
}

function collectUniforms(gl, program) {
  const names = ["uViewProjection", "uCenter", "uRight", "uUp", "uRadius", "uDiscColor", "uHaloColor", "uOpacity"];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}
