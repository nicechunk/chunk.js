import { createProgram } from "./shader-manager.js";
import { aabbIntersectsCameraFrustum, prepareCameraFrustum } from "./frustum.js";

const SHADOW_VERTEX_STRIDE_FLOATS = 6;
const SHADOW_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aAlpha;

uniform mat4 uViewProjection;

out vec2 vUv;
out float vAlpha;

void main() {
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
  vUv = aUv;
  vAlpha = aAlpha;
}
`;

const SHADOW_FRAGMENT_SHADER = `#version 300 es
precision highp float;


in vec2 vUv;
in float vAlpha;

out vec4 outColor;

void main() {
  vec2 uv = vUv;
  float ellipse = dot(uv * vec2(0.76, 1.05), uv * vec2(0.76, 1.05));
  float core = 1.0 - smoothstep(0.08, 0.52, ellipse);
  float soft = 1.0 - smoothstep(0.26, 1.0, ellipse);
  float alpha = (core * 0.22 + soft * 0.78) * vAlpha;
  if (alpha < 0.012) discard;
  outColor = vec4(0.018, 0.025, 0.016, alpha);
}
`;

export class ProjectedShadowLayer {
  constructor(gl, options = {}) {
    this.gl = gl;
    this.maxCasters = Number.isFinite(options.maxCasters) ? Math.max(0, Math.trunc(options.maxCasters)) : 8;
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.vbo = null;
    this.vertexCapacity = 0;
    this.byteLength = 0;
    this.casterSelection = new ShadowCasterSelection(this.maxCasters);
    this.vertexData = new Float32Array(this.maxCasters * 6 * SHADOW_VERTEX_STRIDE_FLOATS);
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

  render({ viewProjection, origin, lighting, casters = [], cameraState = null }) {
    if (!casters.length) return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength };
    if (!this.program) this.init();
    const selected = this.casterSelection.select(casters, origin, lighting, cameraState);
    if (!selected.length) return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength };
    for (let index = 0; index < selected.length; index++) writeShadowQuad(this.vertexData, index * 36, selected[index]);
    const vertexCount = selected.length * 6;
    const gl = this.gl;
    this.ensureCapacity(vertexCount);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertexData, 0, vertexCount * SHADOW_VERTEX_STRIDE_FLOATS);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);
    return { drawCalls: 1, triangles: selected.length * 2, bufferMemory: this.byteLength };
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

// Select by the projected quad rather than body visibility. A body outside the
// view may still cast into it. Only the nearest relevant bounded set proceeds to
// vertex construction, and equal priorities retain input order.
export class ShadowCasterSelection {
  constructor(maxCasters = 8) { this.maxCasters = maxCasters; this.selected = []; this.scratch = {}; }
  select(casters, origin, lighting, cameraState = null) {
    const selected = this.selected;
    this.activeCount = 0;
    const frustum = cameraState ? prepareCameraFrustum(cameraState) : null;
    for (const caster of casters) {
      const next = shadowDescriptor(caster, origin, lighting, this.scratch);
      if (!next) continue;
      if (frustum && !aabbIntersectsCameraFrustum(next, cameraState, frustum)) continue;
      const eyeX = (cameraState?.worldX ?? origin.worldX) + (cameraState?.localOffsetX || 0);
      const eyeY = (cameraState?.worldY ?? origin.worldY) + (cameraState?.localOffsetY || 0);
      const eyeZ = (cameraState?.worldZ ?? origin.worldZ) + (cameraState?.localOffsetZ || 0);
      next.priority = (next.cx + origin.worldX - eyeX) ** 2 + (next.cy + origin.worldY - eyeY) ** 2 + (next.cz + origin.worldZ - eyeZ) ** 2;
      let at = this.activeCount;
      while (at > 0 && next.priority < selected[at - 1].priority) at--;
      if (at >= this.maxCasters) continue;
      const slot = this.activeCount < this.maxCasters ? (selected[this.activeCount] ?? {}) : selected[this.maxCasters - 1];
      for (let index = Math.min(this.activeCount, this.maxCasters - 1); index > at; index--) selected[index] = selected[index - 1];
      Object.assign(slot, next); selected[at] = slot;
      this.activeCount = Math.min(this.maxCasters, this.activeCount + 1);
    }
    selected.length = this.activeCount;
    return selected;
  }
}

function shadowDescriptor(caster, origin, lighting, out) {
  if (caster?.castShadow === false) return null;
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
    const worldX = Math.trunc(caster.worldX || 0) + (caster.localOffsetX || 0);
    const worldY = Math.trunc(caster.worldY || 0) + (caster.localOffsetY || 0);
    const worldZ = Math.trunc(caster.worldZ || 0) + (caster.localOffsetZ || 0);
    const shadowWorldY = Number.isFinite(caster.shadowWorldY) ? caster.shadowWorldY : Math.floor(worldY);
    const elevation = Math.max(0, worldY - shadowWorldY);
    const height = Number(caster.shadowCasterHeight ?? caster.height ?? 4.38) || 4.38;
    const fade = 1 - smoothstep(2.2, 8.0, elevation);
    if (fade <= 0.015) return null;
    const halfW = Math.max(0.18, Number(caster.shadowRadiusX ?? 0.46) || 0.46) * (1 + Math.min(0.26, elevation * 0.035));
    const halfL = Math.max(0.32, Number(caster.shadowRadiusZ ?? 0.42) || 0.42) + height * 0.095 * slope + elevation * 0.18;
    const offset = Math.min(3.6, halfL * 0.42 + elevation * 0.12);
    const centerX = worldX - origin.worldX + dirX * offset;
    const centerY = shadowWorldY - origin.worldY + 0.060;
    const centerZ = worldZ - origin.worldZ + dirZ * offset;
    const alpha = (Number(caster.shadowAlpha ?? 0.42) || 0.42) * fade;
    const extentX = Math.abs(rightX * halfW) + Math.abs(dirX * halfL), extentZ = Math.abs(rightZ * halfW) + Math.abs(dirZ * halfL);
    Object.assign(out, { caster, cx: centerX, cy: centerY, cz: centerZ, rightX, rightZ, dirX, dirZ, halfW, halfL, alpha,
      minX: centerX + origin.worldX - extentX, maxX: centerX + origin.worldX + extentX,
      minY: centerY + origin.worldY, maxY: centerY + origin.worldY,
      minZ: centerZ + origin.worldZ - extentZ, maxZ: centerZ + origin.worldZ + extentZ });
    return out;
}

function writeShadowQuad(out, base, { cx, cy, cz, rightX, rightZ, dirX, dirZ, halfW, halfL, alpha }) {
  const x0 = cx - rightX * halfW + dirX * halfL, z0 = cz - rightZ * halfW + dirZ * halfL;
  const x1 = cx + rightX * halfW + dirX * halfL, z1 = cz + rightZ * halfW + dirZ * halfL;
  const x2 = cx + rightX * halfW - dirX * halfL, z2 = cz + rightZ * halfW - dirZ * halfL;
  const x3 = cx - rightX * halfW - dirX * halfL, z3 = cz - rightZ * halfW - dirZ * halfL;
  writeShadowVertex(out, base, x0, cy, z0, -1, 1, alpha);
  writeShadowVertex(out, base + 6, x1, cy, z1, 1, 1, alpha);
  writeShadowVertex(out, base + 12, x2, cy, z2, 1, -1, alpha);
  writeShadowVertex(out, base + 18, x0, cy, z0, -1, 1, alpha);
  writeShadowVertex(out, base + 24, x2, cy, z2, 1, -1, alpha);
  writeShadowVertex(out, base + 30, x3, cy, z3, -1, -1, alpha);
}
function writeShadowVertex(out, base, x, y, z, u, v, alpha) {
  out[base] = x; out[base + 1] = y; out[base + 2] = z; out[base + 3] = u; out[base + 4] = v; out[base + 5] = alpha;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.000001, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function collectUniforms(gl, program) {
  const names = ["uViewProjection"];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}
