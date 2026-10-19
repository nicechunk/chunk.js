import { createProgram } from "./shader-manager.js";
import { createSurfaceDecorationPreviewMesh, POSITION_PACK_SCALE } from "../chunk/chunk-mesher.js";

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
const FOUNDATION_MAX_TERRAIN_CELLS = 4_096;
const FOUNDATION_DYNAMIC_CACHE_FRAMES = 300;
const PICKUP_GEOMETRY_CACHE_LIMIT = 64;

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
    this.pickupGeometry = new Map();
    this.pickupByteLength = 0;
    this.renderFrame = 0;
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
    if (!gl || !this.program) {
      return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength + this.foundationByteLength + this.pickupByteLength };
    }
    this.renderFrame += 1;
    if (!overlays?.length) {
      this.pruneFoundationGeometry();
      return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength + this.foundationByteLength + this.pickupByteLength };
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
      if (overlay?.shape === "surface-decoration") {
        const color = overlay.fillColor;
        if (!Array.isArray(color) || color.length !== 4 || !color.every(Number.isFinite) || color[3] <= 0.001
          || ![overlay.worldX,overlay.worldY,overlay.worldZ].every(Number.isFinite)) continue;
        const geometry = this.getPickupGeometry(overlay.decoration);
        if (!geometry) continue;
        gl.bindVertexArray(geometry.vao);
        gl.uniform3f(this.uniforms.uBoxOrigin, overlay.worldX-origin.worldX, overlay.worldY-origin.worldY, overlay.worldZ-origin.worldZ);
        gl.uniform3f(this.uniforms.uBoxSize, 1, 1, 1);
        gl.uniform4fv(this.uniforms.uColor, color);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1, -1);
        gl.drawElements(gl.TRIANGLES, geometry.count, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        drawCalls++;triangles+=geometry.count/3;
        continue;
      }
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
    this.pruneFoundationGeometry();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    return { drawCalls, triangles, bufferMemory: this.byteLength + this.foundationByteLength + this.pickupByteLength };
  }

  getPickupGeometry(decoration) {
    // Only verified pebble descriptors reach this optional path. Reuse the
    // exact world mesher and its packing grid, never approximate with a cube.
    if (!Number.isInteger(decoration?.decorationId) || decoration.decorationId < 100 || decoration.decorationId > 107
      || !Number.isInteger(decoration.variantHash)) return null;
    const key=[decoration.decorationId,decoration.variantHash,decoration.surfaceBlockId,decoration.variant,decoration.flags].join(':');
    const cached=this.pickupGeometry.get(key);
    if(cached){this.pickupGeometry.delete(key);this.pickupGeometry.set(key,cached);return cached;}
    const mesh=createSurfaceDecorationPreviewMesh(decoration);
    if (!mesh.indices.length) return null;
    const positions=new Float32Array(mesh.vertices.length*3);
    for(let i=0;i<mesh.vertices.length;i++)for(let axis=0;axis<3;axis++)positions[i*3+axis]=Math.round(mesh.vertices[i].p[axis]*POSITION_PACK_SCALE)/POSITION_PACK_SCALE;
    const indices=new Uint16Array(mesh.indices),gl=this.gl;
    let vao=null,vbo=null,ibo=null;
    try {
      vao=gl.createVertexArray();vbo=gl.createBuffer();ibo=gl.createBuffer();
      if(!vao||!vbo||!ibo)throw new Error('Pickup overlay allocation failed');
      gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,positions,gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
      const geometry={vao,vbo,ibo,count:indices.length,bytes:positions.byteLength+indices.byteLength};
      this.pickupGeometry.set(key,geometry);this.pickupByteLength+=geometry.bytes;
      while(this.pickupGeometry.size>PICKUP_GEOMETRY_CACHE_LIMIT){const first=this.pickupGeometry.keys().next().value,old=this.pickupGeometry.get(first);this.deletePickupGeometry(old);this.pickupGeometry.delete(first);}
      return geometry;
    } catch {
      if(vao)gl.deleteVertexArray(vao);if(vbo)gl.deleteBuffer(vbo);if(ibo)gl.deleteBuffer(ibo);
      return null;
    } finally {gl.bindVertexArray(null);}
  }

  deletePickupGeometry(geometry) {
    this.gl.deleteBuffer(geometry.vbo);this.gl.deleteBuffer(geometry.ibo);this.gl.deleteVertexArray(geometry.vao);
    this.pickupByteLength-=geometry.bytes;
  }

  renderFoundation(foundation, origin) {
    const gl = this.gl;
    const geometry = this.getFoundationGeometry(foundation);
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
    if (foundation.xray) gl.disable(gl.DEPTH_TEST);
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
    if (foundation.xray) gl.enable(gl.DEPTH_TEST);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return { drawCalls, triangles };
  }

  getFoundationGeometry(foundation) {
    const terrain = foundation.terrain;
    const key = terrain
      ? `terrain:${foundation.geometryKey}`
      : `flat:${foundation.width}x${foundation.depth}`;
    const revision = terrain?.revision ?? key;
    const cached = this.foundationGeometry.get(key);
    if (cached?.revision === revision) {
      cached.lastUsedFrame = this.renderFrame;
      return cached;
    }
    if (cached) this.deleteFoundationGeometry(key, cached);
    const data = terrain
      ? buildTerrainFoundationGeometry(terrain)
      : buildFoundationGeometry(foundation.width, foundation.depth);
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    const geometry = { vao, vbo, revision, lastUsedFrame: this.renderFrame, ...data };
    this.foundationGeometry.set(key, geometry);
    this.foundationByteLength += data.vertices.byteLength;
    return geometry;
  }

  pruneFoundationGeometry() {
    for (const [key, geometry] of this.foundationGeometry) {
      if (!key.startsWith("terrain:")) continue;
      if (this.renderFrame - geometry.lastUsedFrame <= FOUNDATION_DYNAMIC_CACHE_FRAMES) continue;
      this.deleteFoundationGeometry(key, geometry);
    }
  }

  deleteFoundationGeometry(key, geometry) {
    const gl = this.gl;
    if (geometry?.vbo) gl.deleteBuffer(geometry.vbo);
    if (geometry?.vao) gl.deleteVertexArray(geometry.vao);
    this.foundationByteLength = Math.max(0, this.foundationByteLength - (geometry?.vertices?.byteLength || 0));
    this.foundationGeometry.delete(key);
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    for(const geometry of this.pickupGeometry.values())this.deletePickupGeometry(geometry);
    this.pickupGeometry.clear();
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

export function buildTerrainFoundationGeometry({ columns, rows, cellSize, heights, width, depth }) {
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
  const tileHeight = (column, row) => heights[row * columns + column];
  const lineY = (height) => height + 0.008;

  begin("fill");
  forEachTerrainTile(columns, rows, cellSize, (column, row, x0, z0, x1, z1) => {
    const y = tileHeight(column, row);
    quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]);
  });
  end("fill");

  begin("glow");
  const glow = FOUNDATION_GLOW_WIDTH;
  forEachTerrainTile(columns, rows, cellSize, (column, row, x0, z0, x1, z1) => {
    const y = tileHeight(column, row) - 0.004;
    if (row === 0) quad([x0, y, -glow], [x0, y, glow], [x1, y, glow], [x1, y, -glow]);
    if (row === rows - 1) quad([x0, y, depth - glow], [x0, y, depth + glow], [x1, y, depth + glow], [x1, y, depth - glow]);
    if (column === 0) quad([-glow, y, z0], [-glow, y, z1], [glow, y, z1], [glow, y, z0]);
    if (column === columns - 1) quad([width - glow, y, z0], [width - glow, y, z1], [width + glow, y, z1], [width + glow, y, z0]);
  });
  end("glow");

  begin("walls");
  forEachTerrainTile(columns, rows, cellSize, (column, row, x0, z0, x1, z1) => {
    const y = tileHeight(column, row);
    const floorY = y - FOUNDATION_WALL_HEIGHT;
    if (row === 0) quad([x0, floorY, z0], [x1, floorY, z0], [x1, y, z0], [x0, y, z0]);
    if (row === rows - 1) quad([x1, floorY, z1], [x0, floorY, z1], [x0, y, z1], [x1, y, z1]);
    if (column === 0) quad([x0, floorY, z1], [x0, floorY, z0], [x0, y, z0], [x0, y, z1]);
    if (column === columns - 1) quad([x1, floorY, z0], [x1, floorY, z1], [x1, y, z1], [x1, y, z0]);
    if (column + 1 < columns) {
      const neighborY = tileHeight(column + 1, row);
      if (neighborY !== y) appendTerrainStepWall(quad, "x", x1, z0, z1, y, neighborY);
    }
    if (row + 1 < rows) {
      const neighborY = tileHeight(column, row + 1);
      if (neighborY !== y) appendTerrainStepWall(quad, "z", z1, x0, x1, y, neighborY);
    }
  });
  end("walls");

  begin("grid");
  forEachTerrainTile(columns, rows, cellSize, (column, row, x0, z0, x1, z1) => {
    const y = lineY(tileHeight(column, row));
    line([x0, y, z0], [x1, y, z0]);
    line([x0, y, z0], [x0, y, z1]);
    if (row === rows - 1) line([x0, y, z1], [x1, y, z1]);
    if (column === columns - 1) line([x1, y, z0], [x1, y, z1]);
  });
  end("grid");

  begin("edges");
  forEachTerrainTile(columns, rows, cellSize, (column, row, x0, z0, x1, z1) => {
    const y = lineY(tileHeight(column, row));
    if (row === 0) line([x0, y, z0], [x1, y, z0]);
    if (row === rows - 1) line([x0, y, z1], [x1, y, z1]);
    if (column === 0) line([x0, y, z0], [x0, y, z1]);
    if (column === columns - 1) line([x1, y, z0], [x1, y, z1]);
    if (column + 1 < columns) {
      const neighborY = lineY(tileHeight(column + 1, row));
      if (neighborY !== y) {
        line([x1, Math.min(y, neighborY), z0], [x1, Math.max(y, neighborY), z0]);
        line([x1, Math.min(y, neighborY), z1], [x1, Math.max(y, neighborY), z1]);
      }
    }
    if (row + 1 < rows) {
      const neighborY = lineY(tileHeight(column, row + 1));
      if (neighborY !== y) {
        line([x0, Math.min(y, neighborY), z1], [x0, Math.max(y, neighborY), z1]);
        line([x1, Math.min(y, neighborY), z1], [x1, Math.max(y, neighborY), z1]);
      }
    }
  });
  end("edges");

  begin("measure");
  const measureY = Math.max(...heights) + 0.02;
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

function forEachTerrainTile(columns, rows, cellSize, visit) {
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = column * cellSize;
      const z0 = row * cellSize;
      visit(column, row, x0, z0, x0 + cellSize, z0 + cellSize);
    }
  }
}

function appendTerrainStepWall(quad, axis, coordinate, start, end, firstY, secondY) {
  const low = Math.min(firstY, secondY);
  const high = Math.max(firstY, secondY);
  if (axis === "x") {
    quad([coordinate, low, start], [coordinate, low, end], [coordinate, high, end], [coordinate, high, start]);
  } else {
    quad([start, low, coordinate], [end, low, coordinate], [end, high, coordinate], [start, high, coordinate]);
  }
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
  let y = Number(overlay.worldY);
  const z = Number(overlay.worldZ);
  const width = Math.trunc(Number(overlay.width));
  const depth = Math.trunc(Number(overlay.depth));
  if (![x, y, z].every(Number.isFinite)
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(depth)
    || width < 1 || depth < 1 || width > 0xffff_ffff || depth > 0xffff_ffff) return null;
  const terrain = normalizeFoundationTerrain(overlay, width, depth);
  if (terrain) y = terrain.baseY;
  return {
    x,
    y,
    z,
    width,
    depth,
    preview: overlay.preview === true,
    grid: overlay.grid !== false,
    xray: overlay.xray === true,
    geometryKey: normalizedGeometryKey(overlay.geometryKey, x, z, width, depth),
    terrain,
    fillColor: normalizeColor(overlay.fillColor, [0.08, 0.48, 1.0, 0.24]),
    gridColor: normalizeColor(overlay.gridColor, [0.48, 0.84, 1.0, 0.55]),
    edgeColor: normalizeColor(overlay.edgeColor ?? overlay.lineColor, [0.72, 0.96, 1.0, 0.96]),
    glowColor: normalizeColor(overlay.glowColor, [0.12, 0.68, 1.0, 0.30]),
  };
}

function normalizeFoundationTerrain(overlay, width, depth) {
  const columns = Math.trunc(Number(overlay.terrainColumns));
  const rows = Math.trunc(Number(overlay.terrainRows));
  const cellSize = Number(overlay.terrainCellSize);
  const source = overlay.surfaceHeights;
  const arrayLike = Array.isArray(source) || ArrayBuffer.isView(source);
  if (!arrayLike
    || !Number.isSafeInteger(columns) || !Number.isSafeInteger(rows)
    || columns < 1 || rows < 1 || columns * rows > FOUNDATION_MAX_TERRAIN_CELLS
    || !Number.isFinite(cellSize) || cellSize <= 0
    || Math.abs(columns * cellSize - width) > 0.001
    || Math.abs(rows * cellSize - depth) > 0.001
    || source.length !== columns * rows) return null;
  const absoluteHeights = new Float32Array(source.length);
  let baseY = Infinity;
  for (let index = 0; index < source.length; index += 1) {
    const height = Number(source[index]);
    if (!Number.isFinite(height)) return null;
    absoluteHeights[index] = height;
    baseY = Math.min(baseY, height);
  }
  if (!Number.isFinite(baseY)) return null;
  const heights = new Float32Array(absoluteHeights.length);
  for (let index = 0; index < absoluteHeights.length; index += 1) {
    heights[index] = absoluteHeights[index] - baseY;
  }
  return {
    columns,
    rows,
    cellSize,
    width,
    depth,
    heights,
    baseY,
    revision: normalizedGeometryRevision(overlay.geometryRevision, absoluteHeights),
  };
}

function normalizedGeometryKey(value, x, z, width, depth) {
  const fallback = `${x}:${z}:${width}:${depth}`;
  const key = String(value ?? fallback).trim();
  return (key || fallback).slice(0, 256);
}

function normalizedGeometryRevision(value, heights) {
  const explicit = String(value ?? "").trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < heights.length; index += 1) {
    hash ^= Math.round(heights[index] * 1_000);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const contentRevision = `${heights.length}:${hash.toString(16).padStart(8, "0")}`;
  return explicit ? `${explicit.slice(0, 220)}:${contentRevision}` : contentRevision;
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
