import { materialDef } from "../world/material-registry.js";
import { MAIN_GAME_SUN_DIRECTION } from "../renderer/lighting.js";

const VERTEX_STRIDE_BYTES = 20;
const POSITION_PACK_SCALE = 1;
const PACKED_COORD_OFFSET = 32768;
const PACKED_COORD_SPAN = 65536;
const MAX_DENSE_LOOKUP_VOXELS = 1_048_576;
const MAX_BAKED_LIGHT_VOXELS = 1_500_000;
const BAKED_LIGHT_VERTEX_FLAG = 0x80;
const MAX_LIGHT_LEVEL = 15;
const GAUSSIAN_CARDINAL_OFFSETS = Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]]);
const GAUSSIAN_DIAGONAL_OFFSETS = Object.freeze([[-1, -1], [1, -1], [-1, 1], [1, 1]]);
const FACE_DEFS = Object.freeze([
  Object.freeze({ normal: [127, 0, 0], delta: [1, 0, 0], shade: 230 }),
  Object.freeze({ normal: [-127, 0, 0], delta: [-1, 0, 0], shade: 182 }),
  Object.freeze({ normal: [0, 127, 0], delta: [0, 1, 0], shade: 255 }),
  Object.freeze({ normal: [0, -127, 0], delta: [0, -1, 0], shade: 130 }),
  Object.freeze({ normal: [0, 0, 127], delta: [0, 0, 1], shade: 206 }),
  Object.freeze({ normal: [0, 0, -127], delta: [0, 0, -1], shade: 190 }),
]);
const MATERIAL_RENDER_INFO = [];

/** Build terrain-compatible GPU meshes without changing NCM3 voxel scale. */
export function createBuildingChunkMeshes(placement, { chunkSize = 16, revision = 1 } = {}) {
  const materialized = placement?.worldVoxels instanceof Map;
  const compact = placement?.compact && placement?.building?.voxels instanceof Map;
  if (!materialized && !compact) throw new Error("A building placement with voxel data is required.");
  const size = positiveInteger(chunkSize, "chunkSize");
  if (size > 16) throw new Error("Building chunkSize cannot exceed the 16-cell greedy mask width.");
  const chunks = new Map();
  const voxelLookup = createPlacementVoxelLookup(placement);
  visitPlacementVoxels(placement, (x, y, z, material) => {
    voxelLookup.set(x, y, z, material);
    const chunkX = Math.floor(x / size);
    const chunkZ = Math.floor(z / size);
    const id = `${chunkX},${chunkZ}`;
    let chunk = chunks.get(id);
    if (!chunk) {
      chunk = { chunkX, chunkZ, minY: y, maxY: y, voxels: [] };
      chunks.set(id, chunk);
    }
    chunk.minY = Math.min(chunk.minY, y);
    chunk.maxY = Math.max(chunk.maxY, y);
    chunk.voxels.push(x, y, z, material);
  });
  const lightSampler = createBuildingLightSampler(placement, voxelLookup);

  const version = Math.max(1, Math.trunc(Number(revision) || 1));
  return [...chunks.values()]
    .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX)
    .map((chunk) => createBuildingChunkState(placement, chunk, size, version, voxelLookup, lightSampler));
}

function createBuildingChunkState(placement, chunk, chunkSize, version, voxelLookup, lightSampler) {
  const opaqueGroups = new Map();
  const visualGroups = new Map();
  const chunkWorldX = chunk.chunkX * chunkSize;
  const chunkWorldZ = chunk.chunkZ * chunkSize;
  const collisionHeight = chunk.maxY - chunk.minY + 1;
  const collisionMask = new Uint32Array(Math.ceil((chunkSize * chunkSize * collisionHeight) / 32));
  let opaqueBlockCount = 0;
  let visualBlockCount = 0;
  let collisionBlockCount = 0;
  for (let offset = 0; offset < chunk.voxels.length; offset += 4) {
    const x = chunk.voxels[offset];
    const y = chunk.voxels[offset + 1];
    const z = chunk.voxels[offset + 2];
    const renderMaterial = materialRenderInfo(chunk.voxels[offset + 3]);
    const groups = renderMaterial.visual ? visualGroups : opaqueGroups;
    if (renderMaterial.visual) visualBlockCount += 1;
    else opaqueBlockCount += 1;
    const localX = x - chunkWorldX;
    const localZ = z - chunkWorldZ;
    if (renderMaterial.colliding) {
      const bitIndex = collisionBitIndex(localX, y - chunk.minY, localZ, chunkSize);
      const bit = 1 << (bitIndex & 31);
      const wordIndex = bitIndex >>> 5;
      if (!(collisionMask[wordIndex] & bit)) {
        collisionMask[wordIndex] |= bit;
        collisionBlockCount += 1;
      }
    }
    for (let faceIndex = 0; faceIndex < FACE_DEFS.length; faceIndex += 1) {
      const face = FACE_DEFS[faceIndex];
      const neighborMaterial = voxelLookup.get(
        x + face.delta[0],
        y + face.delta[1],
        z + face.delta[2],
      );
      if (buildingFaceOccluded(renderMaterial.visual, neighborMaterial)) continue;
      const light = lightSampler.faceLight(x, y, z, faceIndex);
      addFaceCell(groups, faceIndex, localX, y, localZ, renderMaterial.layer, light);
    }
  }

  const mesh = packBuildingMesh(opaqueGroups, chunk, chunkSize, placement, opaqueBlockCount, false);
  const visualMesh = visualGroups.size
    ? packBuildingMesh(visualGroups, chunk, chunkSize, placement, visualBlockCount, true)
    : null;
  return {
    id: `building:${placement.id}:${chunk.chunkX},${chunk.chunkZ}`,
    buildingId: placement.id,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    chunkSize,
    minY: chunk.minY,
    height: collisionHeight,
    collisionMask,
    collisionBlockCount,
    mesh,
    visualMesh,
    meshVersion: version,
    visualMeshVersion: visualMesh ? version : -1,
    version,
    gpuUploaded: false,
    visualGpuUploaded: false,
    building: true,
    regionBatchEligible: false,
    frustumCullEligible: true,
    frustumBounds: buildingChunkFrustumBounds(chunk, chunkSize),
  };
}

function buildingChunkFrustumBounds(chunk, chunkSize) {
  const height = chunk.maxY - chunk.minY + 1;
  const padding = 0.25;
  const width = chunkSize + padding * 2;
  const paddedHeight = height + padding * 2;
  return Object.freeze({
    centerX: chunk.chunkX * chunkSize + chunkSize * 0.5,
    centerY: chunk.minY + height * 0.5,
    centerZ: chunk.chunkZ * chunkSize + chunkSize * 0.5,
    radius: Math.hypot(width, paddedHeight, width) * 0.5,
  });
}

function packBuildingMesh(groups, chunk, chunkSize, placement, blockCount, visual) {
  let faceCellCount = 0;
  for (const group of groups.values()) faceCellCount += group.cellCount;
  const writer = new PackedMeshWriter(Math.min(1_048_576, Math.max(320, faceCellCount * 8)));
  for (const group of groups.values()) appendGreedyGroup(group, writer);
  const { vertices, indices, vertexCount, quadCount } = writer.finish();
  return Object.freeze({
    vertices,
    indices,
    vertexCount,
    indexCount: indices.length,
    triangleCount: indices.length / 3,
    quadCount,
    blockCount,
    vertexStrideBytes: VERTEX_STRIDE_BYTES,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    chunkSize,
    minY: placement.bounds.minY,
    height: placement.bounds.height,
    building: true,
    visual,
  });
}

function materialRenderInfo(materialId) {
  const id = Math.trunc(Number(materialId));
  let cached = MATERIAL_RENDER_INFO[id];
  if (cached) return cached;
  const definition = materialDef(id);
  const shaderType = definition.shaderType;
  const visual = shaderType === "transparent" || shaderType === "fluid" || shaderType === "cutout";
  const lightTransmission = shaderType === "transparent"
    ? clamp(1 - ((definition.baseColor?.[3] ?? 255) / 255) * 0.72, 0.28, 0.86)
    : (shaderType === "opaque" ? 0 : 1);
  cached = Object.freeze({
    layer: definition.textureLayer,
    visual,
    colliding: shaderType === "opaque" || shaderType === "transparent",
    lightTransmission,
    lightCost: shaderType === "opaque"
      ? 255
      : (shaderType === "transparent" ? 1 + Math.round((1 - lightTransmission) * 6) : 1),
    verticalLightCost: shaderType === "transparent"
      ? Math.max(1, Math.round((1 - lightTransmission) * 5))
      : 0,
  });
  MATERIAL_RENDER_INFO[id] = cached;
  return cached;
}

function createBuildingLightSampler(placement, voxelLookup) {
  const bounds = placement.bounds;
  const bakedSky = bakeBuildingSkyLight(bounds, voxelLookup);
  const fallbackSky = bakedSky ? null : new Map();
  const rawFaceLightCaches = FACE_DEFS.map(() => new Map());
  return {
    faceLight(x, y, z, faceIndex) {
      const center = rawFaceLight(x, y, z, faceIndex);
      if (center === null) return 0;
      let sunTotal = ((center >>> 4) & 0x0f) * 4;
      let skyTotal = (center & 0x0f) * 4;
      let weightTotal = 4;
      let edgeDetected = false;
      for (const [uOffset, vOffset] of GAUSSIAN_CARDINAL_OFFSETS) {
        const sample = offsetFaceLight(x, y, z, faceIndex, uOffset, vOffset);
        if (sample === null) continue;
        sunTotal += ((sample >>> 4) & 0x0f) * 2;
        skyTotal += (sample & 0x0f) * 2;
        weightTotal += 2;
        edgeDetected ||= sample !== center;
      }
      if (!edgeDetected) return center;
      for (const [uOffset, vOffset] of GAUSSIAN_DIAGONAL_OFFSETS) {
        const sample = offsetFaceLight(x, y, z, faceIndex, uOffset, vOffset);
        if (sample === null) continue;
        sunTotal += (sample >>> 4) & 0x0f;
        skyTotal += sample & 0x0f;
        weightTotal += 1;
      }
      const sunLevel = Math.round(sunTotal / weightTotal);
      const skyLevel = Math.round(skyTotal / weightTotal);
      return (sunLevel << 4) | skyLevel;
    },
  };

  // Blur only across exposed coplanar faces, so softness never leaks through a wall.
  function offsetFaceLight(x, y, z, faceIndex, uOffset, vOffset) {
    if (faceIndex <= 1) return rawFaceLight(x, y + vOffset, z + uOffset, faceIndex);
    if (faceIndex <= 3) return rawFaceLight(x + uOffset, y, z + vOffset, faceIndex);
    return rawFaceLight(x + uOffset, y + vOffset, z, faceIndex);
  }

  function rawFaceLight(x, y, z, faceIndex) {
    const cache = rawFaceLightCaches[faceIndex];
    const key = voxelLookup.key(x, y, z);
    if (key < 0) return null;
    if (cache.has(key)) return cache.get(key);
    const materialId = voxelLookup.get(x, y, z);
    const face = FACE_DEFS[faceIndex];
    const neighborMaterial = materialId
      ? voxelLookup.get(x + face.delta[0], y + face.delta[1], z + face.delta[2])
      : 0;
    if (!materialId || buildingFaceOccluded(materialRenderInfo(materialId).visual, neighborMaterial)) {
      cache.set(key, null);
      return null;
    }
    const adjacentX = x + face.delta[0];
    const adjacentY = y + face.delta[1];
    const adjacentZ = z + face.delta[2];
    const skyLevel = bakedSky
      ? bakedSky.levelAt(adjacentX, adjacentY, adjacentZ)
      : fallbackSkyLightLevel(adjacentX, adjacentY, adjacentZ, bounds, voxelLookup, fallbackSky);
    const sunFacing = face.delta[0] * MAIN_GAME_SUN_DIRECTION[0]
      + face.delta[1] * MAIN_GAME_SUN_DIRECTION[1]
      + face.delta[2] * MAIN_GAME_SUN_DIRECTION[2];
    const sunLevel = sunFacing > 0.0001
      ? quantizedLightLevel(traceFaceSunlight(x, y, z, face, bounds, voxelLookup))
      : MAX_LIGHT_LEVEL;
    const light = (sunLevel << 4) | skyLevel;
    cache.set(key, light);
    return light;
  }
}

function bakeBuildingSkyLight(bounds, voxelLookup) {
  const width = positiveInteger(bounds.width, "placement width") + 2;
  const height = positiveInteger(bounds.height, "placement height") + 2;
  const depth = positiveInteger(bounds.depth, "placement depth") + 2;
  const volume = width * height * depth;
  if (!Number.isSafeInteger(volume) || volume > MAX_BAKED_LIGHT_VOXELS) return null;

  const minX = bounds.minX - 1;
  const minY = bounds.minY - 1;
  const minZ = bounds.minZ - 1;
  const layerSize = width * depth;
  const light = new Uint8Array(volume);
  const traversalCost = new Uint8Array(volume);
  const buckets = Array.from({ length: MAX_LIGHT_LEVEL + 1 }, () => []);
  const indexAt = (localX, localY, localZ) => localX + localZ * width + localY * layerSize;

  for (let localZ = 0; localZ < depth; localZ += 1) {
    const worldZ = minZ + localZ;
    for (let localX = 0; localX < width; localX += 1) {
      const worldX = minX + localX;
      let verticalLight = MAX_LIGHT_LEVEL;
      for (let localY = height - 1; localY >= 0; localY -= 1) {
        const materialId = voxelLookup.get(worldX, minY + localY, worldZ);
        const renderInfo = materialId ? materialRenderInfo(materialId) : null;
        const index = indexAt(localX, localY, localZ);
        const cost = renderInfo?.lightCost ?? 1;
        traversalCost[index] = cost;
        if (cost === 255) {
          verticalLight = 0;
          continue;
        }
        if (renderInfo?.verticalLightCost) {
          verticalLight = Math.max(0, verticalLight - renderInfo.verticalLightCost);
        }
        if (!verticalLight) continue;
        light[index] = verticalLight;
        buckets[verticalLight].push(index);
      }
    }
  }

  for (let level = MAX_LIGHT_LEVEL; level > 1; level -= 1) {
    const bucket = buckets[level];
    for (let cursor = 0; cursor < bucket.length; cursor += 1) {
      const index = bucket[cursor];
      if (light[index] !== level) continue;
      const localY = Math.floor(index / layerSize);
      const inLayer = index - localY * layerSize;
      const localZ = Math.floor(inLayer / width);
      const localX = inLayer - localZ * width;
      if (localX > 0) spreadSkyLight(index - 1, level);
      if (localX + 1 < width) spreadSkyLight(index + 1, level);
      if (localZ > 0) spreadSkyLight(index - width, level);
      if (localZ + 1 < depth) spreadSkyLight(index + width, level);
      if (localY > 0) spreadSkyLight(index - layerSize, level);
      if (localY + 1 < height) spreadSkyLight(index + layerSize, level);
    }
  }

  return {
    levelAt(worldX, worldY, worldZ) {
      const localX = worldX - minX;
      const localY = worldY - minY;
      const localZ = worldZ - minZ;
      if (localX < 0 || localX >= width || localY < 0 || localY >= height || localZ < 0 || localZ >= depth) {
        return MAX_LIGHT_LEVEL;
      }
      return light[indexAt(localX, localY, localZ)];
    },
  };

  function spreadSkyLight(index, sourceLevel) {
    const cost = traversalCost[index];
    if (cost === 255) return;
    const nextLevel = sourceLevel - cost;
    if (nextLevel <= light[index] || nextLevel <= 0) return;
    light[index] = nextLevel;
    buckets[nextLevel].push(index);
  }
}

function fallbackSkyLightLevel(x, y, z, bounds, voxelLookup, cache) {
  const key = `${x},${y},${z}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const start = [x + 0.5, y + 0.5, z + 0.5];
  const directions = [
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let visibility = 0;
  for (const direction of directions) {
    visibility = Math.max(visibility, traceVoxelTransmission(start, direction, bounds, voxelLookup));
    if (visibility >= 0.999) break;
  }
  const level = quantizedLightLevel(visibility);
  cache.set(key, level);
  return level;
}

function traceFaceSunlight(x, y, z, face, bounds, voxelLookup) {
  const start = [
    x + 0.5 + face.delta[0] * 0.50001,
    y + 0.5 + face.delta[1] * 0.50001,
    z + 0.5 + face.delta[2] * 0.50001,
  ];
  return traceVoxelTransmission(start, MAIN_GAME_SUN_DIRECTION, bounds, voxelLookup);
}

function traceVoxelTransmission(start, direction, bounds, voxelLookup) {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return 0;
  const dx = direction[0] / length;
  const dy = direction[1] / length;
  const dz = direction[2] / length;
  let cellX = Math.floor(start[0]);
  let cellY = Math.floor(start[1]);
  let cellZ = Math.floor(start[2]);
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const stepZ = Math.sign(dz);
  const deltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const deltaY = stepY ? Math.abs(1 / dy) : Infinity;
  const deltaZ = stepZ ? Math.abs(1 / dz) : Infinity;
  let nextX = firstBoundaryDistance(start[0], cellX, dx, stepX);
  let nextY = firstBoundaryDistance(start[1], cellY, dy, stepY);
  let nextZ = firstBoundaryDistance(start[2], cellZ, dz, stepZ);
  const maxSteps = bounds.width + bounds.height + bounds.depth + 6;
  let transmission = 1;

  for (let step = 0; step < maxSteps; step += 1) {
    if (!insideBounds(cellX, cellY, cellZ, bounds)) return transmission;
    const materialId = voxelLookup.get(cellX, cellY, cellZ);
    if (materialId) {
      const materialTransmission = materialRenderInfo(materialId).lightTransmission;
      if (!(materialTransmission > 0)) return 0;
      transmission *= materialTransmission;
      if (transmission < 1 / 30) return 0;
    }
    const next = Math.min(nextX, nextY, nextZ);
    if (!Number.isFinite(next)) return transmission;
    const epsilon = 1e-9;
    if (nextX <= next + epsilon) {
      cellX += stepX;
      nextX += deltaX;
    }
    if (nextY <= next + epsilon) {
      cellY += stepY;
      nextY += deltaY;
    }
    if (nextZ <= next + epsilon) {
      cellZ += stepZ;
      nextZ += deltaZ;
    }
  }
  return 0;
}

function firstBoundaryDistance(position, cell, direction, step) {
  if (step > 0) return (cell + 1 - position) / direction;
  if (step < 0) return (position - cell) / -direction;
  return Infinity;
}

function insideBounds(x, y, z, bounds) {
  return x >= bounds.minX && x <= bounds.maxX
    && y >= bounds.minY && y <= bounds.maxY
    && z >= bounds.minZ && z <= bounds.maxZ;
}

function quantizedLightLevel(value) {
  return Math.round(clamp(value, 0, 1) * MAX_LIGHT_LEVEL);
}

export function buildingChunkHasCollisionAt(chunk, worldX, worldY, worldZ) {
  const mask = chunk?.collisionMask;
  const size = Math.trunc(Number(chunk?.chunkSize));
  const minY = Math.trunc(Number(chunk?.minY));
  const height = Math.trunc(Number(chunk?.height));
  const chunkX = Math.trunc(Number(chunk?.chunkX));
  const chunkZ = Math.trunc(Number(chunk?.chunkZ));
  const x = Math.floor(Number(worldX));
  const y = Math.floor(Number(worldY));
  const z = Math.floor(Number(worldZ));
  if (!(mask instanceof Uint32Array) || !Number.isInteger(size) || size <= 0
    || !Number.isInteger(minY) || !Number.isInteger(height) || height <= 0
    || !Number.isInteger(chunkX) || !Number.isInteger(chunkZ)
    || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)) return false;
  const localX = x - chunkX * size;
  const localY = y - minY;
  const localZ = z - chunkZ * size;
  if (localX < 0 || localX >= size || localY < 0 || localY >= height || localZ < 0 || localZ >= size) return false;
  const bitIndex = collisionBitIndex(localX, localY, localZ, size);
  return Boolean(mask[bitIndex >>> 5] & (1 << (bitIndex & 31)));
}

export function buildingChunkCollisionTopAt(chunk, worldX, worldZ, maxBlockY = Infinity) {
  const mask = chunk?.collisionMask;
  const size = Math.trunc(Number(chunk?.chunkSize));
  const minY = Math.trunc(Number(chunk?.minY));
  const height = Math.trunc(Number(chunk?.height));
  const chunkX = Math.trunc(Number(chunk?.chunkX));
  const chunkZ = Math.trunc(Number(chunk?.chunkZ));
  const x = Math.floor(Number(worldX));
  const z = Math.floor(Number(worldZ));
  if (!(mask instanceof Uint32Array) || !Number.isInteger(size) || size <= 0
    || !Number.isInteger(minY) || !Number.isInteger(height) || height <= 0
    || !Number.isInteger(chunkX) || !Number.isInteger(chunkZ)
    || !Number.isSafeInteger(x) || !Number.isSafeInteger(z)) return -Infinity;
  const localX = x - chunkX * size;
  const localZ = z - chunkZ * size;
  if (localX < 0 || localX >= size || localZ < 0 || localZ >= size) return -Infinity;
  const cap = Number.isFinite(maxBlockY) ? Math.floor(maxBlockY) : minY + height - 1;
  const maxLocalY = Math.min(height - 1, cap - minY);
  for (let localY = maxLocalY; localY >= 0; localY -= 1) {
    const bitIndex = collisionBitIndex(localX, localY, localZ, size);
    if (mask[bitIndex >>> 5] & (1 << (bitIndex & 31))) return minY + localY + 1;
  }
  return -Infinity;
}

function collisionBitIndex(localX, localY, localZ, chunkSize) {
  return ((localY * chunkSize) + localZ) * chunkSize + localX;
}

function buildingFaceOccluded(currentVisual, neighborMaterialId) {
  if (!neighborMaterialId) return false;
  if (currentVisual) return true;
  return !materialRenderInfo(neighborMaterialId).visual;
}

function addFaceCell(groups, faceIndex, x, y, z, layer, light) {
  let plane;
  let u;
  let v;
  if (faceIndex === 0) {
    plane = x + 1; u = z; v = y;
  } else if (faceIndex === 1) {
    plane = x; u = z; v = y;
  } else if (faceIndex === 2) {
    plane = y + 1; u = x; v = z;
  } else if (faceIndex === 3) {
    plane = y; u = x; v = z;
  } else if (faceIndex === 4) {
    plane = z + 1; u = x; v = y;
  } else {
    plane = z; u = x; v = y;
  }
  if (!Number.isInteger(u) || u < 0 || u >= 16) throw new Error("Building face exceeds the greedy mask width.");
  const key = faceGroupKey(faceIndex, plane, layer, light);
  let group = groups.get(key);
  if (!group) {
    group = {
      faceIndex,
      face: FACE_DEFS[faceIndex],
      plane,
      layer,
      ao: FACE_DEFS[faceIndex].shade,
      flags: BAKED_LIGHT_VERTEX_FLAG | (light << 8),
      rows: new Map(),
      minV: v,
      maxV: v,
      cellCount: 0,
    };
    groups.set(key, group);
  }
  const bit = 1 << u;
  const row = group.rows.get(v) ?? 0;
  if (row & bit) return;
  group.rows.set(v, row | bit);
  group.minV = Math.min(group.minV, v);
  group.maxV = Math.max(group.maxV, v);
  group.cellCount += 1;
}

function faceGroupKey(faceIndex, plane, layer, light) {
  const packedPlane = packedPosition(plane) + PACKED_COORD_OFFSET;
  const textureLayer = positiveUint16(layer);
  const geometryKey = (textureLayer * FACE_DEFS.length + faceIndex) * PACKED_COORD_SPAN + packedPlane;
  return geometryKey * 256 + light;
}

function appendGreedyGroup(group, writer) {
  for (let v = group.minV; v <= group.maxV; v += 1) {
    let row = group.rows.get(v) ?? 0;
    while (row) {
      const u = lowestSetBitIndex(row);
      const width = contiguousWidth(row, u);
      const runMask = (((1 << width) - 1) << u) & 0xffff;
      let height = 1;
      while (((group.rows.get(v + height) ?? 0) & runMask) === runMask) height += 1;
      for (let offset = 0; offset < height; offset += 1) {
        const rowV = v + offset;
        const remaining = ((group.rows.get(rowV) ?? 0) & ~runMask) & 0xffff;
        if (remaining) group.rows.set(rowV, remaining);
        else group.rows.delete(rowV);
      }
      writer.appendQuad(group, u, v, width, height);
      row = group.rows.get(v) ?? 0;
    }
  }
}

function lowestSetBitIndex(mask) {
  return 31 - Math.clz32(mask & -mask);
}

function contiguousWidth(mask, start) {
  let width = 0;
  while (start + width < 16 && (mask & (1 << (start + width)))) width += 1;
  return width;
}

class PackedMeshWriter {
  constructor(initialCapacity) {
    const capacity = Math.max(320, Math.ceil(initialCapacity / VERTEX_STRIDE_BYTES) * VERTEX_STRIDE_BYTES);
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(this.bytes.buffer);
    this.vertexCount = 0;
    this.quadCount = 0;
  }

  appendQuad(group, u, v, width, height) {
    this.ensureBytes(4 * VERTEX_STRIDE_BYTES);
    const p = group.plane;
    const w = width;
    const h = height;
    if (group.faceIndex === 0) {
      this.writeVertex(group, p, v, u);
      this.writeVertex(group, p, v + h, u);
      this.writeVertex(group, p, v + h, u + w);
      this.writeVertex(group, p, v, u + w);
    } else if (group.faceIndex === 1) {
      this.writeVertex(group, p, v, u + w);
      this.writeVertex(group, p, v + h, u + w);
      this.writeVertex(group, p, v + h, u);
      this.writeVertex(group, p, v, u);
    } else if (group.faceIndex === 2) {
      this.writeVertex(group, u, p, v + h);
      this.writeVertex(group, u + w, p, v + h);
      this.writeVertex(group, u + w, p, v);
      this.writeVertex(group, u, p, v);
    } else if (group.faceIndex === 3) {
      this.writeVertex(group, u, p, v);
      this.writeVertex(group, u + w, p, v);
      this.writeVertex(group, u + w, p, v + h);
      this.writeVertex(group, u, p, v + h);
    } else if (group.faceIndex === 4) {
      this.writeVertex(group, u + w, v, p);
      this.writeVertex(group, u + w, v + h, p);
      this.writeVertex(group, u, v + h, p);
      this.writeVertex(group, u, v, p);
    } else {
      this.writeVertex(group, u, v, p);
      this.writeVertex(group, u, v + h, p);
      this.writeVertex(group, u + w, v + h, p);
      this.writeVertex(group, u + w, v, p);
    }
    this.quadCount += 1;
  }

  writeVertex(group, x, y, z) {
    const offset = this.vertexCount * VERTEX_STRIDE_BYTES;
    const normal = group.face.normal;
    this.view.setInt16(offset, packedPosition(x), true);
    this.view.setInt16(offset + 2, packedPosition(y), true);
    this.view.setInt16(offset + 4, packedPosition(z), true);
    this.view.setInt16(offset + 6, POSITION_PACK_SCALE, true);
    this.view.setInt8(offset + 8, normal[0]);
    this.view.setInt8(offset + 9, normal[1]);
    this.view.setInt8(offset + 10, normal[2]);
    this.view.setUint8(offset + 11, group.ao);
    if (group.faceIndex === 2 || group.faceIndex === 3) {
      this.view.setUint16(offset + 12, positiveUint16(x), true);
      this.view.setUint16(offset + 14, positiveUint16(z), true);
    } else if (group.faceIndex === 0 || group.faceIndex === 1) {
      this.view.setUint16(offset + 12, positiveUint16(z), true);
      this.view.setUint16(offset + 14, positiveUint16(y), true);
    } else {
      this.view.setUint16(offset + 12, positiveUint16(x), true);
      this.view.setUint16(offset + 14, positiveUint16(y), true);
    }
    this.view.setUint16(offset + 16, group.layer, true);
    this.view.setUint16(offset + 18, group.flags, true);
    this.vertexCount += 1;
  }

  ensureBytes(additionalBytes) {
    const required = this.vertexCount * VERTEX_STRIDE_BYTES + additionalBytes;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  finish() {
    const vertices = this.bytes.slice(0, this.vertexCount * VERTEX_STRIDE_BYTES);
    const indices = this.vertexCount > 65535
      ? new Uint32Array(this.quadCount * 6)
      : new Uint16Array(this.quadCount * 6);
    for (let quad = 0; quad < this.quadCount; quad += 1) {
      const vertex = quad * 4;
      const offset = quad * 6;
      indices[offset] = vertex;
      indices[offset + 1] = vertex + 1;
      indices[offset + 2] = vertex + 2;
      indices[offset + 3] = vertex;
      indices[offset + 4] = vertex + 2;
      indices[offset + 5] = vertex + 3;
    }
    return { vertices, indices, vertexCount: this.vertexCount, quadCount: this.quadCount };
  }
}

function createPlacementVoxelLookup(placement) {
  const bounds = placement.bounds;
  const width = positiveInteger(bounds.width, "placement width");
  const height = positiveInteger(bounds.height, "placement height");
  const depth = positiveInteger(bounds.depth, "placement depth");
  const layerSize = width * depth;
  const volume = layerSize * height;
  const denseEnough = volume <= MAX_DENSE_LOOKUP_VOXELS
    && volume <= Math.max(65_536, placement.voxelCount * 8);
  const dense = denseEnough ? new Uint16Array(volume) : null;
  const sparse = dense ? null : new Map();
  const indexOf = (x, y, z) => (x - bounds.minX)
    + (z - bounds.minZ) * width
    + (y - bounds.minY) * layerSize;
  const inBounds = (x, y, z) => x >= bounds.minX && x <= bounds.maxX
    && y >= bounds.minY && y <= bounds.maxY
    && z >= bounds.minZ && z <= bounds.maxZ;
  return {
    set(x, y, z, materialId) {
      const material = Math.trunc(Number(materialId));
      if (!Number.isInteger(material) || material <= 0 || material > 0xffff) {
        throw new Error("Building material ID exceeds the voxel lookup range.");
      }
      const index = indexOf(x, y, z);
      if (dense) dense[index] = material;
      else sparse.set(index, material);
    },
    get(x, y, z) {
      if (!inBounds(x, y, z)) return 0;
      const index = indexOf(x, y, z);
      return dense ? dense[index] : (sparse.get(index) ?? 0);
    },
    key(x, y, z) {
      return inBounds(x, y, z) ? indexOf(x, y, z) : -1;
    },
  };
}

function visitPlacementVoxels(placement, visitor) {
  if (placement.worldVoxels instanceof Map) {
    for (const voxel of placement.worldVoxels.values()) visitor(voxel.x, voxel.y, voxel.z, voxel.material);
    return;
  }
  const turn = placement.quarterTurns;
  const sizeX = placement.building.size.x;
  const sizeZ = placement.building.size.z;
  const originX = placement.origin.x;
  const originY = placement.origin.y;
  const originZ = placement.origin.z;
  for (const voxel of placement.building.voxels.values()) {
    let rotatedX = voxel.x;
    let rotatedZ = voxel.z;
    if (turn === 1) {
      rotatedX = sizeZ - 1 - voxel.z;
      rotatedZ = voxel.x;
    } else if (turn === 2) {
      rotatedX = sizeX - 1 - voxel.x;
      rotatedZ = sizeZ - 1 - voxel.z;
    } else if (turn === 3) {
      rotatedX = voxel.z;
      rotatedZ = sizeX - 1 - voxel.x;
    }
    visitor(originX + rotatedX, originY + voxel.y, originZ + rotatedZ, voxel.material);
  }
}

function packedPosition(value) {
  const packed = Math.round(value * POSITION_PACK_SCALE);
  if (packed < -32768 || packed > 32767) throw new Error("Building vertex exceeds the renderer coordinate range.");
  return packed;
}

function positiveUint16(value) {
  return Math.trunc(value) & 0xffff;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return number;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
