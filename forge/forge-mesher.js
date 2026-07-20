import {
  FORGE_APPEARANCE_GRID,
  FORGE_COMPONENT_GRID,
  FORGE_FIXED_SCALE,
  canonicalizeForgeDesign,
  forgeVoxelIndex,
  quantizeForgeValue,
} from "./forge-core.js";

export const FORGE_RENDER_POSITION_SCALE = FORGE_FIXED_SCALE * 2;
export const FORGE_MESH_VERTEX_STRIDE_BYTES = 16;
export const FORGE_MESH_MATERIAL_LAYER_OFFSET = 9;
export const FORGE_MESH_MATERIAL_LAYER_NONE = 255;

const FORGE_FACE_MASK_OCCUPIED = 0x1000;
const FORGE_FACE_MASK_PAINTED = 0x2000;

export function buildForgeCuboidMesh(cuboids = []) {
  const builder = createMeshBuilder();
  const pickBounds = [];
  for (let index = 0; index < cuboids.length; index += 1) {
    const cuboid = normalizeCuboid(cuboids[index], index);
    const firstIndex = builder.indices.length;
    builder.componentIndex = index;
    appendCuboid(builder, cuboid.minP, cuboid.maxP, cuboid.color444, FORGE_MESH_MATERIAL_LAYER_NONE);
    pickBounds.push({
      id: cuboid.id,
      index,
      min: cuboid.minP.map((value) => value / FORGE_RENDER_POSITION_SCALE),
      max: cuboid.maxP.map((value) => value / FORGE_RENDER_POSITION_SCALE),
      firstIndex,
      indexCount: builder.indices.length - firstIndex,
      userData: cuboid.userData,
    });
  }
  return finishMesh(builder, pickBounds);
}

export function buildForgeDesignMesh(input, { componentMaterialLayers = [] } = {}) {
  const design = canonicalizeForgeDesign(input);
  const builder = createMeshBuilder();
  const pickBounds = [];
  if (design.appearance) {
    const firstIndex = builder.indices.length;
    const firstVertex = builder.vertices.length;
    builder.componentIndex = 0;
    appendAppearance(builder, design.appearance);
    const halfP = design.appearance.dimsQ;
    const bounds = appendedVertexBounds(builder.vertices, firstVertex, halfP.map((value) => -value), halfP);
    pickBounds.push({
      id: "appearance",
      index: 0,
      min: bounds.minP.map((value) => value / FORGE_RENDER_POSITION_SCALE),
      max: bounds.maxP.map((value) => value / FORGE_RENDER_POSITION_SCALE),
      firstIndex,
      indexCount: builder.indices.length - firstIndex,
      userData: { kind: "appearance" },
    });
  } else {
    for (let index = 0; index < design.components.length; index += 1) {
      const component = design.components[index];
      const firstIndex = builder.indices.length;
      const firstVertex = builder.vertices.length;
      builder.componentIndex = index;
      appendComponent(builder, component, normalizeMaterialLayer(componentMaterialLayers[index]));
      const envelopeMinP = component.offsetQ.map((value, axis) => value * 2 - component.dimsQ[axis]);
      const envelopeMaxP = component.offsetQ.map((value, axis) => value * 2 + component.dimsQ[axis]);
      const bounds = appendedVertexBounds(builder.vertices, firstVertex, envelopeMinP, envelopeMaxP);
      pickBounds.push({
        id: `component-${index}`,
        index,
        min: bounds.minP.map((value) => value / FORGE_RENDER_POSITION_SCALE),
        max: bounds.maxP.map((value) => value / FORGE_RENDER_POSITION_SCALE),
        firstIndex,
        indexCount: builder.indices.length - firstIndex,
        userData: { kind: "component", resourceId: component.resourceId },
      });
    }
  }
  return finishMesh(builder, pickBounds);
}

export function forgeMeshColorRgba(color444, alpha = 255) {
  const value = Number(color444) & 0xfff;
  return [((value >> 8) & 15) * 17, ((value >> 4) & 15) * 17, (value & 15) * 17, clampByte(alpha)];
}

function appendComponent(builder, component, materialLayer) {
  const grid = FORGE_COMPONENT_GRID;
  const sizes = [grid.x, grid.y, grid.z];
  const paint = componentPaintLookup(component);
  const maxGreedySpan = component.resourceId === "cloth" ? 2 : Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const axes = tangentAxes(axis);
    const width = sizes[axes[0]];
    const height = sizes[axes[1]];
    for (const side of [0, 1]) {
      for (let layer = 0; layer < sizes[axis]; layer += 1) {
        const mask = new Uint16Array(width * height);
        for (let v = 0; v < height; v += 1) {
          for (let u = 0; u < width; u += 1) {
            const cell = [0, 0, 0];
            cell[axis] = layer;
            cell[axes[0]] = u;
            cell[axes[1]] = v;
            if (!component.solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) continue;
            const neighbor = [...cell];
            neighbor[axis] += side ? 1 : -1;
            if (insideGrid(neighbor, sizes) && component.solid[forgeVoxelIndex(neighbor[0], neighbor[1], neighbor[2])]) continue;
            const plane = side ? layer + 1 : layer;
            const key = faceCellKey(axis, side, plane, u, v);
            const painted = paint.has(key);
            const color444 = painted ? paint.get(key) : component.color444;
            mask[u + width * v] = FORGE_FACE_MASK_OCCUPIED
              | (painted ? FORGE_FACE_MASK_PAINTED : 0)
              | color444;
          }
        }
        greedyMask(mask, width, height, (u0, v0, u1, v1, value) => {
          appendGridQuad(builder, {
            axis,
            side,
            plane: layer + (side ? 1 : 0),
            u0,
            u1,
            v0,
            v1,
            grid: sizes,
            dimsQ: component.dimsQ,
            offsetQ: component.offsetQ,
            color444: value & 0xfff,
            materialLayer: value & FORGE_FACE_MASK_PAINTED
              ? FORGE_MESH_MATERIAL_LAYER_NONE
              : materialLayer,
          });
        }, maxGreedySpan);
      }
    }
  }
}

function appendAppearance(builder, appearance) {
  const sizes = [FORGE_APPEARANCE_GRID.x, FORGE_APPEARANCE_GRID.y, FORGE_APPEARANCE_GRID.z];
  for (const quad of appearance.quads) {
    appendGridQuad(builder, {
      ...quad,
      grid: sizes,
      dimsQ: appearance.dimsQ,
      offsetQ: [0, 0, 0],
      materialLayer: FORGE_MESH_MATERIAL_LAYER_NONE,
    });
  }
}

function appendGridQuad(builder, {
  axis,
  side,
  plane,
  u0,
  u1,
  v0,
  v1,
  grid,
  dimsQ,
  offsetQ,
  color444,
  materialLayer = FORGE_MESH_MATERIAL_LAYER_NONE,
}) {
  const axes = tangentAxes(axis);
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  min[axis] = max[axis] = gridBoundaryP(offsetQ[axis], dimsQ[axis], grid[axis], plane);
  min[axes[0]] = gridBoundaryP(offsetQ[axes[0]], dimsQ[axes[0]], grid[axes[0]], u0);
  max[axes[0]] = gridBoundaryP(offsetQ[axes[0]], dimsQ[axes[0]], grid[axes[0]], u1);
  min[axes[1]] = gridBoundaryP(offsetQ[axes[1]], dimsQ[axes[1]], grid[axes[1]], v0);
  max[axes[1]] = gridBoundaryP(offsetQ[axes[1]], dimsQ[axes[1]], grid[axes[1]], v1);
  appendAxisQuad(builder, axis, side, min, max, color444, materialLayer);
}

function appendCuboid(builder, min, max, color444, materialLayer) {
  appendAxisQuad(builder, 0, 1, min, max, color444, materialLayer);
  appendAxisQuad(builder, 0, 0, min, max, color444, materialLayer);
  appendAxisQuad(builder, 1, 1, min, max, color444, materialLayer);
  appendAxisQuad(builder, 1, 0, min, max, color444, materialLayer);
  appendAxisQuad(builder, 2, 1, min, max, color444, materialLayer);
  appendAxisQuad(builder, 2, 0, min, max, color444, materialLayer);
}

function appendAxisQuad(builder, axis, side, min, max, color444, materialLayer) {
  const x0 = min[0]; const x1 = max[0];
  const y0 = min[1]; const y1 = max[1];
  const z0 = min[2]; const z1 = max[2];
  let corners;
  if (axis === 0 && side) corners = [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]];
  else if (axis === 0) corners = [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]];
  else if (axis === 1 && side) corners = [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]];
  else if (axis === 1) corners = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
  else if (side) corners = [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]];
  else corners = [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]];
  const normal = [0, 0, 0];
  normal[axis] = side ? 127 : -127;
  appendQuad(builder, corners, normal, color444, materialLayer);
}

function appendQuad(builder, corners, normal, color444, materialLayer) {
  const base = builder.vertices.length;
  for (const point of corners) {
    for (const value of point) {
      if (value < -32768 || value > 32767) throw new RangeError("Forge render coordinates exceed packed Int16 range.");
    }
    builder.vertices.push({ point, normal, color444, materialLayer, componentIndex: builder.componentIndex });
  }
  builder.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function appendedVertexBounds(vertices, firstVertex, fallbackMinP, fallbackMaxP) {
  if (firstVertex >= vertices.length) return { minP: [...fallbackMinP], maxP: [...fallbackMaxP] };
  const minP = [Infinity, Infinity, Infinity];
  const maxP = [-Infinity, -Infinity, -Infinity];
  for (let index = firstVertex; index < vertices.length; index += 1) {
    const point = vertices[index].point;
    for (let axis = 0; axis < 3; axis += 1) {
      minP[axis] = Math.min(minP[axis], point[axis]);
      maxP[axis] = Math.max(maxP[axis], point[axis]);
    }
  }
  return { minP, maxP };
}

function createMeshBuilder() {
  return { vertices: [], indices: [], componentIndex: 0 };
}

function finishMesh(builder, pickBounds) {
  const data = new Uint8Array(builder.vertices.length * FORGE_MESH_VERTEX_STRIDE_BYTES);
  const view = new DataView(data.buffer);
  for (let index = 0; index < builder.vertices.length; index += 1) {
    const vertex = builder.vertices[index];
    const offset = index * FORGE_MESH_VERTEX_STRIDE_BYTES;
    view.setInt16(offset, vertex.point[0], true);
    view.setInt16(offset + 2, vertex.point[1], true);
    view.setInt16(offset + 4, vertex.point[2], true);
    view.setInt8(offset + 6, vertex.normal[0]);
    view.setInt8(offset + 7, vertex.normal[1]);
    view.setInt8(offset + 8, vertex.normal[2]);
    view.setUint8(offset + FORGE_MESH_MATERIAL_LAYER_OFFSET, vertex.materialLayer);
    const color = forgeMeshColorRgba(vertex.color444);
    view.setUint8(offset + 10, color[0]);
    view.setUint8(offset + 11, color[1]);
    view.setUint8(offset + 12, color[2]);
    view.setUint8(offset + 13, color[3]);
    view.setUint16(offset + 14, vertex.componentIndex, true);
  }
  const indices = builder.vertices.length > 65535 ? new Uint32Array(builder.indices) : new Uint16Array(builder.indices);
  return {
    vertices: data,
    indices,
    positionScale: FORGE_RENDER_POSITION_SCALE,
    vertexStrideBytes: FORGE_MESH_VERTEX_STRIDE_BYTES,
    vertexCount: builder.vertices.length,
    indexCount: indices.length,
    triangleCount: indices.length / 3,
    byteLength: data.byteLength + indices.byteLength,
    pickBounds,
  };
}

function normalizeCuboid(input = {}, index) {
  const id = String(input.id ?? `cuboid-${index}`);
  let minP;
  let maxP;
  if (input.minP && input.maxP) {
    minP = packedVector(input.minP);
    maxP = packedVector(input.maxP);
  } else {
    const centerQ = input.centerQ ? integerVector(input.centerQ) : floatVector(input.center ?? input.position ?? [0, 0, 0]).map((value) => quantizeForgeValue(value));
    const sizeQ = input.sizeQ ? integerVector(input.sizeQ) : floatVector(input.size ?? input.dimensions ?? [1, 1, 1]).map((value) => quantizeForgeValue(value));
    if (sizeQ.some((value) => value <= 0)) throw new RangeError(`Cuboid ${id} sizes must be positive.`);
    minP = centerQ.map((value, axis) => value * 2 - sizeQ[axis]);
    maxP = centerQ.map((value, axis) => value * 2 + sizeQ[axis]);
  }
  if (minP.some((value, axis) => value >= maxP[axis])) throw new RangeError(`Cuboid ${id} bounds are empty.`);
  return {
    id,
    minP,
    maxP,
    color444: normalizeRenderColor(input.color444 ?? input.color ?? 0x888),
    userData: input.userData ?? null,
  };
}

function componentPaintLookup(component) {
  const lookup = new Map();
  for (const quad of component.paintQuads) {
    for (let v = quad.v0; v < quad.v1; v += 1) {
      for (let u = quad.u0; u < quad.u1; u += 1) lookup.set(faceCellKey(quad.axis, quad.side, quad.plane, u, v), quad.color444);
    }
  }
  return lookup;
}

function faceCellKey(axis, side, plane, u, v) {
  return `${axis}:${side}:${plane}:${u}:${v}`;
}

function greedyMask(mask, width, height, append, maxSpan = Number.POSITIVE_INFINITY) {
  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      const value = mask[u + width * v];
      if (!value) continue;
      let runWidth = 1;
      while (runWidth < maxSpan && u + runWidth < width && mask[u + runWidth + width * v] === value) runWidth += 1;
      let runHeight = 1;
      scan: while (runHeight < maxSpan && v + runHeight < height) {
        for (let x = 0; x < runWidth; x += 1) if (mask[u + x + width * (v + runHeight)] !== value) break scan;
        runHeight += 1;
      }
      for (let y = 0; y < runHeight; y += 1) {
        for (let x = 0; x < runWidth; x += 1) mask[u + x + width * (v + y)] = 0;
      }
      append(u, v, u + runWidth, v + runHeight, value);
    }
  }
}

function gridBoundaryP(offsetQ, dimsQ, cells, coordinate) {
  return offsetQ * 2 - dimsQ + Math.round(coordinate * dimsQ * 2 / cells);
}

function normalizeRenderColor(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xfff) return value;
  let rgb = value;
  if (typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value)) rgb = Number.parseInt(value.slice(1), 16);
  if (!Number.isInteger(rgb) || rgb < 0 || rgb > 0xffffff) throw new RangeError("Forge render colors must be rgb444, #rrggbb, or 24-bit RGB.");
  const r = Math.round(((rgb >> 16) & 255) * 15 / 255);
  const g = Math.round(((rgb >> 8) & 255) * 15 / 255);
  const b = Math.round((rgb & 255) * 15 / 255);
  return (r << 8) | (g << 4) | b;
}

function normalizeMaterialLayer(value) {
  const layer = Number(value);
  return Number.isInteger(layer) && layer >= 0 && layer < FORGE_MESH_MATERIAL_LAYER_NONE
    ? layer
    : FORGE_MESH_MATERIAL_LAYER_NONE;
}

function packedVector(value) {
  const out = integerVector(value);
  if (out.some((entry) => entry < -32768 || entry > 32767)) throw new RangeError("Packed forge coordinates must fit Int16.");
  return out;
}

function integerVector(value) {
  const values = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value).slice(0, 3) : [value?.x, value?.y, value?.z];
  if (values.length !== 3 || values.some((entry) => !Number.isInteger(Number(entry)))) throw new TypeError("Forge vectors require three integers.");
  return values.map(Number);
}

function floatVector(value) {
  const values = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value).slice(0, 3) : [value?.x, value?.y, value?.z];
  if (values.length !== 3 || values.some((entry) => !Number.isFinite(Number(entry)))) throw new TypeError("Forge vectors require three finite values.");
  return values.map(Number);
}

function tangentAxes(axis) {
  return [0, 1, 2].filter((value) => value !== axis);
}

function insideGrid(cell, sizes) {
  return cell[0] >= 0 && cell[1] >= 0 && cell[2] >= 0 && cell[0] < sizes[0] && cell[1] < sizes[1] && cell[2] < sizes[2];
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}
