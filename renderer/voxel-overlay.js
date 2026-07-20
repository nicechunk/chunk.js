import { createProgram } from "./shader-manager.js";

const OVERLAY_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;

uniform mat4 uViewProjection;
uniform vec3 uBoxOrigin;
uniform vec3 uBoxSize;

void main() {
  vec3 p = uBoxOrigin + aPosition * uBoxSize;
  gl_Position = uViewProjection * vec4(p, 1.0);
}
`;

const OVERLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec4 uColor;

out vec4 outColor;

void main() {
  outColor = uColor;
}
`;

const CUBE_VERTICES = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  1, 1, 0,
  0, 1, 0,
  0, 0, 1,
  1, 0, 1,
  1, 1, 1,
  0, 1, 1,
]);

const CUBE_TRIANGLE_INDICES = new Uint16Array([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  3, 6, 2, 3, 7, 6,
  1, 2, 6, 1, 6, 5,
  0, 4, 7, 0, 7, 3,
]);

const CUBE_LINE_INDICES = new Uint16Array([
  0, 1, 1, 2, 2, 3, 3, 0,
  4, 5, 5, 6, 6, 7, 7, 4,
  0, 4, 1, 5, 2, 6, 3, 7,
]);
const DEBUG_SPHERE_SEGMENTS = 48;
const DEBUG_SPHERE_GEOMETRY = buildDebugSphereGeometry(DEBUG_SPHERE_SEGMENTS);
const FOUNDATION_MAX_GRID_LINES_PER_AXIS = 64;
const FOUNDATION_GLOW_WIDTH = 0.13;
const FOUNDATION_WALL_HEIGHT = 0.24;
const FOUNDATION_MEASURE_OFFSET = 0.42;
const FOUNDATION_MEASURE_TICK = 0.16;

export class VoxelOverlay {
  constructor(gl) {
    this.gl = gl;
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.vbo = null;
    this.triangleIbo = null;
    this.lineIbo = null;
    this.sphereVao = null;
    this.sphereVbo = null;
    this.sphereLineIbo = null;
    this.foundationGeometry = new Map();
    this.foundationByteLength = 0;
    this.byteLength = 0;
  }

  init() {
    const gl = this.gl;
    if (!gl || this.program) return this;
    this.program = createProgram(gl, OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER);
    this.uniforms = {
      uViewProjection: gl.getUniformLocation(this.program, "uViewProjection"),
      uBoxOrigin: gl.getUniformLocation(this.program, "uBoxOrigin"),
      uBoxSize: gl.getUniformLocation(this.program, "uBoxSize"),
      uColor: gl.getUniformLocation(this.program, "uColor"),
    };
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.triangleIbo = gl.createBuffer();
    this.lineIbo = gl.createBuffer();
    this.sphereVao = gl.createVertexArray();
    this.sphereVbo = gl.createBuffer();
    this.sphereLineIbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, CUBE_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triangleIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CUBE_TRIANGLE_INDICES, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CUBE_LINE_INDICES, gl.STATIC_DRAW);
    gl.bindVertexArray(this.sphereVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sphereVbo);
    gl.bufferData(gl.ARRAY_BUFFER, DEBUG_SPHERE_GEOMETRY.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sphereLineIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, DEBUG_SPHERE_GEOMETRY.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    this.byteLength = CUBE_VERTICES.byteLength
      + CUBE_TRIANGLE_INDICES.byteLength
      + CUBE_LINE_INDICES.byteLength
      + DEBUG_SPHERE_GEOMETRY.vertices.byteLength
      + DEBUG_SPHERE_GEOMETRY.indices.byteLength;
    return this;
  }

  render({ viewProjection, origin, overlays = [] } = {}) {
    const gl = this.gl;
    if (!gl || !this.program || !overlays?.length) {
      return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength + this.foundationByteLength };
    }
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let drawCalls = 0;
    let triangles = 0;
    for (const overlay of overlays) {
      if (overlay?.shape === "foundation") {
        const foundation = normalizeFoundationOverlay(overlay);
        if (!foundation) continue;
        const stats = this.renderFoundation(foundation, origin);
        drawCalls += stats.drawCalls;
        triangles += stats.triangles;
        continue;
      }
      if (overlay?.shape === "sphere") {
        const sphere = normalizeOverlaySphere(overlay);
        if (!sphere || sphere.lineColor[3] <= 0.001) continue;
        gl.bindVertexArray(this.sphereVao);
        gl.uniform3f(this.uniforms.uBoxOrigin, sphere.x - origin.worldX, sphere.y - origin.worldY, sphere.z - origin.worldZ);
        gl.uniform3f(this.uniforms.uBoxSize, sphere.radius, sphere.radius, sphere.radius);
        gl.uniform4fv(this.uniforms.uColor, sphere.lineColor);
        gl.drawElements(gl.LINES, DEBUG_SPHERE_GEOMETRY.indices.length, gl.UNSIGNED_SHORT, 0);
        drawCalls += 1;
        continue;
      }
      const box = normalizeOverlayBox(overlay);
      if (!box) continue;
      gl.bindVertexArray(this.vao);
      gl.uniform3f(this.uniforms.uBoxOrigin, box.x - origin.worldX, box.y - origin.worldY, box.z - origin.worldZ);
      gl.uniform3f(this.uniforms.uBoxSize, box.sx, box.sy, box.sz);
      if (box.fillColor[3] > 0.001) {
        gl.uniform4fv(this.uniforms.uColor, box.fillColor);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triangleIbo);
        gl.drawElements(gl.TRIANGLES, CUBE_TRIANGLE_INDICES.length, gl.UNSIGNED_SHORT, 0);
        drawCalls += 1;
        triangles += CUBE_TRIANGLE_INDICES.length / 3;
      }
      if (box.lineColor[3] > 0.001) {
        gl.uniform4fv(this.uniforms.uColor, box.lineColor);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIbo);
        gl.drawElements(gl.LINES, CUBE_LINE_INDICES.length, gl.UNSIGNED_SHORT, 0);
        drawCalls += 1;
      }
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    return { drawCalls, triangles, bufferMemory: this.byteLength + this.foundationByteLength };
  }

  renderFoundation(foundation, origin) {
    const gl = this.gl;
    const geometry = this.getFoundationGeometry(foundation.width, foundation.depth);
    if (!geometry) return { drawCalls: 0, triangles: 0 };
    gl.bindVertexArray(geometry.vao);
    gl.uniform3f(
      this.uniforms.uBoxOrigin,
      foundation.x - origin.worldX,
      foundation.y - origin.worldY,
      foundation.z - origin.worldZ,
    );
    gl.uniform3f(this.uniforms.uBoxSize, 1, 1, 1);
    let drawCalls = 0;
    let triangles = 0;

    if (foundation.fillColor[3] > 0.001) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4fv(this.uniforms.uColor, foundation.fillColor);
      gl.drawArrays(gl.TRIANGLES, geometry.fill.first, geometry.fill.count);
      drawCalls += 1;
      triangles += geometry.fill.count / 3;
    }
    if (foundation.glowColor[3] > 0.001) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.uniform4fv(this.uniforms.uColor, foundation.glowColor);
      gl.drawArrays(gl.TRIANGLES, geometry.glow.first, geometry.glow.count);
      drawCalls += 1;
      triangles += geometry.glow.count / 3;
    }
    if (foundation.preview && foundation.glowColor[3] > 0.001) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4fv(this.uniforms.uColor, [
        foundation.glowColor[0],
        foundation.glowColor[1],
        foundation.glowColor[2],
        foundation.glowColor[3] * 0.72,
      ]);
      gl.drawArrays(gl.TRIANGLES, geometry.walls.first, geometry.walls.count);
      drawCalls += 1;
      triangles += geometry.walls.count / 3;
    }
    if (foundation.grid && foundation.gridColor[3] > 0.001) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4fv(this.uniforms.uColor, foundation.gridColor);
      gl.drawArrays(gl.LINES, geometry.grid.first, geometry.grid.count);
      drawCalls += 1;
    }
    if (foundation.edgeColor[3] > 0.001) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.uniform4fv(this.uniforms.uColor, foundation.edgeColor);
      gl.drawArrays(gl.LINES, geometry.edges.first, geometry.edges.count);
      drawCalls += 1;
      if (foundation.preview) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.LINES, geometry.measure.first, geometry.measure.count);
        drawCalls += 1;
      }
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return { drawCalls, triangles };
  }

  getFoundationGeometry(width, depth) {
    const key = `${width}x${depth}`;
    const cached = this.foundationGeometry.get(key);
    if (cached) return cached;
    const data = buildFoundationGeometry(width, depth);
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    const geometry = { vao, vbo, ...data };
    this.foundationGeometry.set(key, geometry);
    this.foundationByteLength += data.vertices.byteLength;
    return geometry;
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.triangleIbo) gl.deleteBuffer(this.triangleIbo);
    if (this.lineIbo) gl.deleteBuffer(this.lineIbo);
    if (this.sphereVbo) gl.deleteBuffer(this.sphereVbo);
    if (this.sphereLineIbo) gl.deleteBuffer(this.sphereLineIbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.sphereVao) gl.deleteVertexArray(this.sphereVao);
    for (const geometry of this.foundationGeometry.values()) {
      if (geometry.vbo) gl.deleteBuffer(geometry.vbo);
      if (geometry.vao) gl.deleteVertexArray(geometry.vao);
    }
    this.foundationGeometry.clear();
    this.foundationByteLength = 0;
    if (this.program) gl.deleteProgram(this.program);
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.vbo = null;
    this.triangleIbo = null;
    this.lineIbo = null;
    this.sphereVao = null;
    this.sphereVbo = null;
    this.sphereLineIbo = null;
  }
}

function buildFoundationGeometry(width, depth) {
  const vertices = [];
  const ranges = {};
  const begin = (name) => {
    ranges[name] = { first: vertices.length / 3, count: 0 };
  };
  const end = (name) => {
    ranges[name].count = vertices.length / 3 - ranges[name].first;
  };
  const triangle = (a, b, c) => vertices.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => {
    triangle(a, b, c);
    triangle(a, c, d);
  };
  const line = (a, b) => vertices.push(...a, ...b);
  const y = 0;
  const lineY = 0.008;

  begin("fill");
  quad([0, y, 0], [0, y, depth], [width, y, depth], [width, y, 0]);
  end("fill");

  begin("glow");
  const glow = FOUNDATION_GLOW_WIDTH;
  quad([-glow, y - 0.004, -glow], [-glow, y - 0.004, glow], [width + glow, y - 0.004, glow], [width + glow, y - 0.004, -glow]);
  quad([-glow, y - 0.004, depth - glow], [-glow, y - 0.004, depth + glow], [width + glow, y - 0.004, depth + glow], [width + glow, y - 0.004, depth - glow]);
  quad([-glow, y - 0.004, glow], [-glow, y - 0.004, depth - glow], [glow, y - 0.004, depth - glow], [glow, y - 0.004, glow]);
  quad([width - glow, y - 0.004, glow], [width - glow, y - 0.004, depth - glow], [width + glow, y - 0.004, depth - glow], [width + glow, y - 0.004, glow]);
  end("glow");

  begin("walls");
  const wallY = FOUNDATION_WALL_HEIGHT;
  quad([0, y, 0], [width, y, 0], [width, wallY, 0], [0, wallY, 0]);
  quad([width, y, depth], [0, y, depth], [0, wallY, depth], [width, wallY, depth]);
  quad([0, y, depth], [0, y, 0], [0, wallY, 0], [0, wallY, depth]);
  quad([width, y, 0], [width, y, depth], [width, wallY, depth], [width, wallY, 0]);
  end("walls");

  begin("grid");
  const gridStepX = Math.max(1, Math.ceil(width / FOUNDATION_MAX_GRID_LINES_PER_AXIS));
  const gridStepZ = Math.max(1, Math.ceil(depth / FOUNDATION_MAX_GRID_LINES_PER_AXIS));
  for (let x = gridStepX; x < width; x += gridStepX) line([x, lineY, 0], [x, lineY, depth]);
  for (let z = gridStepZ; z < depth; z += gridStepZ) line([0, lineY, z], [width, lineY, z]);
  end("grid");

  begin("edges");
  line([0, lineY, 0], [width, lineY, 0]);
  line([width, lineY, 0], [width, lineY, depth]);
  line([width, lineY, depth], [0, lineY, depth]);
  line([0, lineY, depth], [0, lineY, 0]);
  line([0, wallY, 0], [width, wallY, 0]);
  line([width, wallY, 0], [width, wallY, depth]);
  line([width, wallY, depth], [0, wallY, depth]);
  line([0, wallY, depth], [0, wallY, 0]);
  line([0, lineY, 0], [0, wallY, 0]);
  line([width, lineY, 0], [width, wallY, 0]);
  line([width, lineY, depth], [width, wallY, depth]);
  line([0, lineY, depth], [0, wallY, depth]);
  end("edges");

  begin("measure");
  const measureY = lineY + 0.012;
  const zMeasure = depth + FOUNDATION_MEASURE_OFFSET;
  line([0, measureY, zMeasure], [width, measureY, zMeasure]);
  line([0, measureY, zMeasure - FOUNDATION_MEASURE_TICK], [0, measureY, zMeasure + FOUNDATION_MEASURE_TICK]);
  line([width, measureY, zMeasure - FOUNDATION_MEASURE_TICK], [width, measureY, zMeasure + FOUNDATION_MEASURE_TICK]);
  const xMeasure = width + FOUNDATION_MEASURE_OFFSET;
  line([xMeasure, measureY, 0], [xMeasure, measureY, depth]);
  line([xMeasure - FOUNDATION_MEASURE_TICK, measureY, 0], [xMeasure + FOUNDATION_MEASURE_TICK, measureY, 0]);
  line([xMeasure - FOUNDATION_MEASURE_TICK, measureY, depth], [xMeasure + FOUNDATION_MEASURE_TICK, measureY, depth]);
  end("measure");

  return { vertices: new Float32Array(vertices), ...ranges };
}

function buildDebugSphereGeometry(segments) {
  const vertices = [];
  const indices = [];
  const appendCircle = (axis) => {
    const start = vertices.length / 3;
    for (let index = 0; index < segments; index += 1) {
      const angle = index / segments * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      if (axis === "xy") vertices.push(c, s, 0);
      else if (axis === "xz") vertices.push(c, 0, s);
      else vertices.push(0, c, s);
      indices.push(start + index, start + ((index + 1) % segments));
    }
  };
  appendCircle("xy");
  appendCircle("xz");
  appendCircle("yz");
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

function normalizeOverlayBox(overlay) {
  if (!overlay) return null;
  const x = Number(overlay.worldX);
  const y = Number(overlay.worldY);
  const z = Number(overlay.worldZ);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const expand = Math.max(0, Number(overlay.expand) || 0);
  const size = Math.max(0.001, Number(overlay.size) || 1);
  const sizeX = Math.max(0.001, Number(overlay.sizeX) || size);
  const sizeY = Math.max(0.001, Number(overlay.sizeY) || size);
  const sizeZ = Math.max(0.001, Number(overlay.sizeZ) || size);
  return {
    x: x - expand,
    y: y - expand,
    z: z - expand,
    sx: sizeX + expand * 2,
    sy: sizeY + expand * 2,
    sz: sizeZ + expand * 2,
    fillColor: normalizeColor(overlay.fillColor, [1, 1, 1, 0]),
    lineColor: normalizeColor(overlay.lineColor ?? overlay.color, [1, 1, 1, 0.65]),
  };
}

function normalizeOverlaySphere(overlay) {
  const x = Number(overlay.centerX ?? overlay.worldX);
  const y = Number(overlay.centerY ?? overlay.worldY);
  const z = Number(overlay.centerZ ?? overlay.worldZ);
  const radius = Number(overlay.radius);
  if (![x, y, z, radius].every(Number.isFinite) || radius <= 0) return null;
  return {
    x,
    y,
    z,
    radius,
    lineColor: normalizeColor(overlay.lineColor ?? overlay.color, [0.25, 0.92, 1, 0.78]),
  };
}

function normalizeFoundationOverlay(overlay) {
  const x = Number(overlay.worldX);
  const y = Number(overlay.worldY);
  const z = Number(overlay.worldZ);
  const width = Math.trunc(Number(overlay.width));
  const depth = Math.trunc(Number(overlay.depth));
  if (![x, y, z].every(Number.isFinite)
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(depth)
    || width < 1 || depth < 1 || width > 0xffff_ffff || depth > 0xffff_ffff) return null;
  return {
    x,
    y,
    z,
    width,
    depth,
    preview: overlay.preview === true,
    grid: overlay.grid !== false,
    fillColor: normalizeColor(overlay.fillColor, [0.08, 0.48, 1.0, 0.24]),
    gridColor: normalizeColor(overlay.gridColor, [0.48, 0.84, 1.0, 0.55]),
    edgeColor: normalizeColor(overlay.edgeColor ?? overlay.lineColor, [0.72, 0.96, 1.0, 0.96]),
    glowColor: normalizeColor(overlay.glowColor, [0.12, 0.68, 1.0, 0.30]),
  };
}

function normalizeColor(value, fallback) {
  if (!Array.isArray(value) || value.length < 4) return fallback;
  return [
    clamp01(value[0]),
    clamp01(value[1]),
    clamp01(value[2]),
    clamp01(value[3]),
  ];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
