import { createProgram } from "./shader-manager.js";

const SHADOW_VERTEX_STRIDE_FLOATS = 6;
const SHADOW_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aAlpha;

uniform mat4 uViewProjection;

out vec2 vUv;
out float vAlpha;
out float vFogDepth;

void main() {
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
  vUv = aUv;
  vAlpha = aAlpha;
  vFogDepth = max(0.0, gl_Position.w);
}
`;

const SHADOW_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 uFogColor;
uniform vec2 uFogNearFar;

in vec2 vUv;
in float vAlpha;
in float vFogDepth;

out vec4 outColor;

void main() {
  vec2 uv = vUv;
  float ellipse = dot(uv * vec2(0.76, 1.05), uv * vec2(0.76, 1.05));
  float core = 1.0 - smoothstep(0.08, 0.52, ellipse);
  float soft = 1.0 - smoothstep(0.26, 1.0, ellipse);
  float alpha = (core * 0.22 + soft * 0.78) * vAlpha;
  if (alpha < 0.012) discard;
  float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, vFogDepth);
  vec3 color = mix(vec3(0.018, 0.025, 0.016), uFogColor * 0.18, fog * 0.34);
  outColor = vec4(color, alpha * (1.0 - fog * 0.45));
}
`;

export class ProjectedShadowLayer {
  constructor(gl, options = {}) {
    this.gl = gl;
    this.maxCasters = Math.max(1, Math.trunc(options.maxCasters ?? 8));
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.vbo = null;
    this.vertexCapacity = 0;
    this.byteLength = 0;
  }

  init() {
    if (this.program) return this;
    const gl = this.gl;
    this.program = createProgram(gl, SHADOW_VERTEX_SHADER, SHADOW_FRAGMENT_SHADER);
    this.uniforms = collectUniforms(gl, this.program);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.ensureCapacity(this.maxCasters * 6);
    const stride = SHADOW_VERTEX_STRIDE_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);
    return this;
  }

  render({ viewProjection, origin, lighting, casters = [] }) {
    if (!casters.length) return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength };
    if (!this.program) this.init();
    const vertices = buildShadowVertices(casters, origin, lighting);
    if (!vertices.length) return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength };
    const gl = this.gl;
    this.ensureCapacity(vertices.length / SHADOW_VERTEX_STRIDE_FLOATS);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    const fog = lighting?.fogColor ?? [0.9, 0.97, 1.0];
    const fogNearFar = lighting?.fogNearFar ?? [96, 340];
    gl.uniform3f(this.uniforms.uFogColor, fog[0], fog[1], fog[2]);
    gl.uniform2f(this.uniforms.uFogNearFar, fogNearFar[0], fogNearFar[1]);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / SHADOW_VERTEX_STRIDE_FLOATS);
    gl.bindVertexArray(null);
    return { drawCalls: 1, triangles: vertices.length / SHADOW_VERTEX_STRIDE_FLOATS / 3, bufferMemory: this.byteLength };
  }

  ensureCapacity(vertexCount) {
    if (vertexCount <= this.vertexCapacity) return;
    const gl = this.gl;
    this.vertexCapacity = Math.max(vertexCount, this.vertexCapacity * 2 || 48);
    this.byteLength = this.vertexCapacity * SHADOW_VERTEX_STRIDE_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.byteLength, gl.DYNAMIC_DRAW);
  }

  dispose() {
    const gl = this.gl;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.vbo = null;
    this.vao = null;
    this.program = null;
    this.vertexCapacity = 0;
    this.byteLength = 0;
  }
}

function buildShadowVertices(casters, origin, lighting) {
  const out = [];
  const sun = lighting?.sunDirection ?? [-0.72, 0.34, 0.62];
  const sunX = Number(sun[0]) || 0;
  const sunY = Math.max(0.16, Math.abs(Number(sun[1]) || 0.34));
  const sunZ = Number(sun[2]) || 0;
  const xz = Math.hypot(sunX, sunZ) || 1;
  const dirX = -sunX / xz;
  const dirZ = -sunZ / xz;
  const rightX = -dirZ;
  const rightZ = dirX;
  const slope = xz / sunY;
  for (const caster of casters) {
    if (caster?.castShadow === false) continue;
    const worldX = Math.trunc(caster.worldX || 0) + (caster.localOffsetX || 0);
    const worldY = Math.trunc(caster.worldY || 0) + (caster.localOffsetY || 0);
    const worldZ = Math.trunc(caster.worldZ || 0) + (caster.localOffsetZ || 0);
    const shadowWorldY = Number.isFinite(caster.shadowWorldY) ? caster.shadowWorldY : Math.floor(worldY);
    const elevation = Math.max(0, worldY - shadowWorldY);
    const height = Number(caster.shadowCasterHeight ?? caster.height ?? 4.38) || 4.38;
    const fade = 1 - smoothstep(2.2, 8.0, elevation);
    if (fade <= 0.015) continue;
    const halfW = Math.max(0.18, Number(caster.shadowRadiusX ?? 0.46) || 0.46) * (1 + Math.min(0.26, elevation * 0.035));
    const halfL = Math.max(0.32, Number(caster.shadowRadiusZ ?? 0.42) || 0.42) + height * 0.095 * slope + elevation * 0.18;
    const offset = Math.min(3.6, halfL * 0.42 + elevation * 0.12);
    const centerX = worldX - origin.worldX + dirX * offset;
    const centerY = shadowWorldY - origin.worldY + 0.060;
    const centerZ = worldZ - origin.worldZ + dirZ * offset;
    const alpha = (Number(caster.shadowAlpha ?? 0.42) || 0.42) * fade;
    appendShadowQuad(out, centerX, centerY, centerZ, rightX, rightZ, dirX, dirZ, halfW, halfL, alpha);
  }
  return new Float32Array(out);
}

function appendShadowQuad(out, cx, cy, cz, rightX, rightZ, dirX, dirZ, halfW, halfL, alpha) {
  const p0 = [cx - rightX * halfW + dirX * halfL, cy, cz - rightZ * halfW + dirZ * halfL, -1, 1, alpha];
  const p1 = [cx + rightX * halfW + dirX * halfL, cy, cz + rightZ * halfW + dirZ * halfL, 1, 1, alpha];
  const p2 = [cx + rightX * halfW - dirX * halfL, cy, cz + rightZ * halfW - dirZ * halfL, 1, -1, alpha];
  const p3 = [cx - rightX * halfW - dirX * halfL, cy, cz - rightZ * halfW - dirZ * halfL, -1, -1, alpha];
  out.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.000001, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function collectUniforms(gl, program) {
  const names = ["uViewProjection", "uFogColor", "uFogNearFar"];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}
