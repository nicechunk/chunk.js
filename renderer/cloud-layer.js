import { normalizeSeedBytes, hashCoord3 } from "../core/hash.js";
import { applyLightingUniforms } from "./lighting.js";
import { createProgram } from "./shader-manager.js";

const CLOUD_VERTEX_STRIDE_FLOATS = 10;
const DEFAULT_CLOUD_RADIUS = 2200;
const DEFAULT_CLOUD_CELL_SIZE = 128;
const CLOUD_DENSITY_THRESHOLD = 202;
const CLOUD_EDGE_FADE_START = 0.56;

const CLOUD_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;

uniform mat4 uViewProjection;
uniform vec3 uCameraOrigin;

out vec3 vNormal;
out vec4 vColor;
out float vFogDepth;

void main() {
  vec3 p = aPosition - uCameraOrigin;
  gl_Position = uViewProjection * vec4(p, 1.0);
  vNormal = aNormal;
  vColor = aColor;
  vFogDepth = max(0.0, gl_Position.w);
}
`;

const CLOUD_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyLightColor;
uniform vec3 uGroundLightColor;
uniform vec3 uFogColor;
uniform vec2 uFogNearFar;
uniform vec4 uLightParams;

in vec3 vNormal;
in vec4 vColor;
in float vFogDepth;

out vec4 outColor;

void main() {
  vec3 normal = normalize(vNormal);
  float sun = max(dot(normal, normalize(uSunDirection)), 0.0);
  float topLight = smoothstep(-0.62, 0.78, normal.y);
  float hemiUp = normal.y * 0.5 + 0.5;
  vec3 ambient = uSkyLightColor * uLightParams.x;
  vec3 hemi = mix(uGroundLightColor, uSkyLightColor, hemiUp) * uLightParams.z;
  vec3 direct = uSunColor * (smoothstep(0.08, 0.82, sun) * uLightParams.y);
  vec3 color = vColor.rgb * (ambient + hemi + direct + topLight * 0.22) * uLightParams.w;
  vec3 shadow = vec3(0.62, 0.69, 0.80);
  vec3 whiteCap = vec3(1.20, 1.18, 1.10);
  color = mix(color * shadow, color * whiteCap, topLight);
  color = mix(color, vec3(1.0, 1.0, 1.0), 0.30);
  float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, vFogDepth);
  outColor = vec4(mix(color, uFogColor, fog * 0.62), min(vColor.a, 0.990));
}
`;

export class CloudLayer {
  constructor(gl, options = {}) {
    this.gl = gl;
    this.seed = normalizeSeedBytes(options.seed ?? "nicechunk-clouds-v1");
    this.radius = Number(options.radius ?? DEFAULT_CLOUD_RADIUS);
    this.cellSize = Number(options.cellSize ?? DEFAULT_CLOUD_CELL_SIZE);
    this.baseHeight = Number(options.baseHeight ?? 226);
    this.followCamera = options.followCamera !== false;
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.vbo = null;
    this.ibo = null;
    this.indexCount = 0;
    this.indexType = gl.UNSIGNED_SHORT;
    this.triangleCount = 0;
    this.byteLength = 0;
  }

  init() {
    if (this.program) return this;
    const gl = this.gl;
    this.program = createProgram(gl, CLOUD_VERTEX_SHADER, CLOUD_FRAGMENT_SHADER);
    this.uniforms = collectCloudUniforms(gl, this.program);
    const mesh = buildCloudMesh(this.seed, this.radius, this.cellSize, this.baseHeight);
    this.indexCount = mesh.indices.length;
    this.triangleCount = mesh.indices.length / 3;
    this.indexType = mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    this.byteLength = mesh.vertices.byteLength + mesh.indices.byteLength;
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    const stride = CLOUD_VERTEX_STRIDE_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return this;
  }

  render({ viewProjection, cameraOrigin, lighting }) {
    if (!this.program) this.init();
    if (!this.indexCount) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    // Clouds are visual-only sky coverage. Keep the cloud disk centered on the
    // viewer so it reaches the sky edge instead of ending at a chunk-like world
    // radius. This also keeps clouds in the sky when the player climbs high.
    const originX = this.followCamera ? 0 : (cameraOrigin.worldX || 0);
    const originY = this.followCamera ? 0 : (cameraOrigin.worldY || 0);
    const originZ = this.followCamera ? 0 : (cameraOrigin.worldZ || 0);
    gl.uniform3f(this.uniforms.uCameraOrigin, originX, originY, originZ);
    applyLightingUniforms(gl, this.uniforms, lighting);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    gl.bindVertexArray(null);
    return { drawCalls: 1, triangles: this.triangleCount, bufferMemory: this.byteLength };
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
    this.indexCount = 0;
  }
}

export function buildCloudDebugAsset(options = {}) {
  const seed = normalizeSeedBytes(options.seed ?? "nicechunk-clouds-v1");
  const radius = Number(options.radius ?? 520);
  const cellSize = Number(options.cellSize ?? DEFAULT_CLOUD_CELL_SIZE);
  const baseHeight = Number(options.baseHeight ?? 0);
  const mesh = buildCloudMesh(seed, radius, cellSize, baseHeight);
  return {
    id: "cloud_layer",
    name: "cloud layer clustered puffs",
    category: "sky visual",
    description: "Clouds use a merged mesh in fixed sky coordinates. They are visual only and do not participate in collision or gameplay calculations.",
    vertexFormat: "float10-color",
    vertices: mesh.vertices,
    indices: mesh.indices,
    stride: CLOUD_VERTEX_STRIDE_FLOATS,
    triangleCount: mesh.indices.length / 3,
    vertexCount: mesh.vertices.length / CLOUD_VERTEX_STRIDE_FLOATS,
    collision: false,
  };
}

function buildCloudMesh(seed, radius, cellSize, baseHeight) {
  const vertices = [];
  const indices = [];
  const cells = Math.ceil(radius / cellSize);
  for (let cz = -cells; cz <= cells; cz += 1) {
    for (let cx = -cells; cx <= cells; cx += 1) {
      const roll = hashCoord3(seed, cx, 0, cz, 3101) & 255;
      if (roll < CLOUD_DENSITY_THRESHOLD) continue;
      const centerX = cx * cellSize + signedNoise(seed, cx, cz, 3102) * cellSize * 0.26;
      const centerZ = cz * cellSize + signedNoise(seed, cx, cz, 3103) * cellSize * 0.26;
      const radial = Math.hypot(centerX, centerZ);
      if (radial > radius) continue;
      const edgeFade = clamp01((radius - radial) / Math.max(1, radius * (1 - CLOUD_EDGE_FADE_START)));
      if (edgeFade <= 0.015) continue;
      const distance01 = clamp01(radial / Math.max(1, radius));
      const horizon01 = Math.pow(distance01, 1.12);
      const y = baseHeight - horizon01 * 118 + signedNoise(seed, cx, cz, 3104) * mix(13, 3, horizon01);
      const puffCount = 3 + (hashCoord3(seed, cx, 1, cz, 3105) % 4);
      const warm = unitNoise(seed, cx + puffCount * 29, cz - puffCount * 31, 3124);
      const baseColor = [0.985 + warm * 0.030, 0.992 + warm * 0.014, 1.0, 0.94];
      const perspectiveScale = mix(1.08, 0.28, horizon01);
      const spreadX = (34 + puffCount * 5) * perspectiveScale;
      const spreadZ = (28 + puffCount * 5) * perspectiveScale;
      for (let puff = 0; puff < puffCount; puff += 1) {
        const px = centerX + signedNoise(seed, cx + puff * 17, cz - puff * 19, 3111) * spreadX;
        const py = y + signedNoise(seed, cx - puff * 23, cz + puff * 13, 3113) * 7;
        const pz = centerZ + signedNoise(seed, cx + puff * 29, cz + puff * 31, 3112) * spreadZ;
        const sx = (30 + unitNoise(seed, cx + puff * 7, cz, 3121) * 32) * perspectiveScale;
        const sy = (8 + unitNoise(seed, cx, cz + puff * 11, 3122) * 10) * mix(1.0, 0.48, horizon01);
        const sz = (26 + unitNoise(seed, cx - puff * 5, cz + puff * 3, 3123) * 30) * perspectiveScale;
        const light = 0.88 + unitNoise(seed, cx + puff * 41, cz - puff * 43, 3125) * 0.16;
        const horizonFade = 1.0 - smoothstep(0.68, 1.0, distance01) * 0.82;
        const alpha = (0.91 + unitNoise(seed, cx - puff * 37, cz + puff * 47, 3126) * 0.08) * edgeFade * horizonFade;
        const color = [baseColor[0] * light, baseColor[1] * light, baseColor[2], alpha];
        appendBox(vertices, indices, px, py, pz, sx, sy, sz, color);
      }
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: indices.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
  };
}

function appendBox(vertices, indices, cx, cy, cz, sx, sy, sz, color) {
  const x0 = cx - sx * 0.5;
  const x1 = cx + sx * 0.5;
  const y0 = cy - sy * 0.5;
  const y1 = cy + sy * 0.5;
  const z0 = cz - sz * 0.5;
  const z1 = cz + sz * 0.5;
  const faces = [
    { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]] },
    { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
    { n: [0, 1, 0], p: [[x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [0, -1, 0], p: [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]] },
    { n: [0, 0, 1], p: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]] },
    { n: [0, 0, -1], p: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]] },
  ];
  for (const face of faces) {
    const offset = vertices.length / CLOUD_VERTEX_STRIDE_FLOATS;
    for (const p of face.p) vertices.push(p[0], p[1], p[2], face.n[0], face.n[1], face.n[2], color[0], color[1], color[2], color[3]);
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
}

function unitNoise(seed, x, z, salt) {
  return (hashCoord3(seed, x, 0, z, salt) & 65535) / 65535;
}

function signedNoise(seed, x, z, salt) {
  return unitNoise(seed, x, z, salt) * 2 - 1;
}

function mix(a, b, t) {
  return a + (b - a) * clamp01(t);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / Math.max(0.000001, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function collectCloudUniforms(gl, program) {
  const names = [
    "uViewProjection",
    "uCameraOrigin",
    "uSunDirection",
    "uSunColor",
    "uSkyLightColor",
    "uGroundLightColor",
    "uFogColor",
    "uFogNearFar",
    "uLightParams",
  ];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}
