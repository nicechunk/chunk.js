import { BLOCK_FLAGS } from "../core/constants.js";
import { saturatingAddI32 } from "../core/hash.js";
import { blockDef, blockFlags, blockMaterialIdForFace, BLOCK_ID, MATERIAL_ID, isFluidBlock, isLowVegetationBlock, isOpaqueSolidBlock, isVisualBlock } from "../world/block-registry.js";
import { CACTUS_MODEL_HEIGHT_SCALE, CACTUS_MODEL_MAX_Y, cactusModelPartsForQuarterTurn } from "../world/cactus-model.js";
import { materialDef } from "../world/material-registry.js";
import { chunkLocalToWorldI32, treeInstanceLeafProfile } from "../world/world-generator.js";
import { deltaKey } from "./chunk-delta.js";
import {
  EMPTY_COMPILED_SURFACE_DECORATION_RULES,
  resolveSurfaceDecoration,
  SURFACE_DECORATION_FLAGS,
  SURFACE_DECORATION_ID,
} from "../world/surface-decoration-rules.js";

export const CHUNK_VERTEX_STRIDE_BYTES = 20;
// The scale travels in the packed fourth position component, so finer micro-model
// precision costs no extra vertex bytes or shader instructions.
export const POSITION_PACK_SCALE = 64;

const FACE_DEFS = [
  { name: "px", normal: [127, 0, 0], delta: [1, 0, 0], shade: 230 },
  { name: "nx", normal: [-127, 0, 0], delta: [-1, 0, 0], shade: 182 },
  { name: "py", normal: [0, 127, 0], delta: [0, 1, 0], shade: 255 },
  { name: "ny", normal: [0, -127, 0], delta: [0, -1, 0], shade: 130 },
  { name: "pz", normal: [0, 0, 127], delta: [0, 0, 1], shade: 206 },
  { name: "nz", normal: [0, 0, -127], delta: [0, 0, -1], shade: 190 },
];

const VERTEX_FLAG_SHADOW_UV = 4;
const SHADOW_SURFACE_BIAS = 1.25 / POSITION_PACK_SCALE;
const GRASS_HEIGHT_SCALE = 2;

const FAST_SIDE_FACES = [
  { faceIndex: 0, dx: 1, dz: 0 },
  { faceIndex: 1, dx: -1, dz: 0 },
  { faceIndex: 4, dx: 0, dz: 1 },
  { faceIndex: 5, dx: 0, dz: -1 },
];
const FAST_TRANSPARENT_SIDE_SCAN_DEPTH = 4;

function isGreedyOpaqueBlock(blockId) {
  return blockId !== BLOCK_ID.cactus && isOpaqueSolidBlock(blockId);
}

export function meshChunkOpaque(chunkState, {
  getBlockAtWorld = null,
  getDeltaAtWorld = null,
  treeDeltaCandidateCount = 0,
} = {}) {
  const positions = [];
  const indices = [];
  let blockCount = 0;
  let quadCount = 0;
  const faceGroups = new Map();
  const size = chunkState.chunkSize;
  const minY = chunkState.minY;
  const height = chunkState.height;

  for (let z = 0; z < size; z += 1) {
    for (let y = minY; y < minY + height; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const blockId = chunkState.getFinalBlock(x, y, z);
        if (!isGreedyOpaqueBlock(blockId)) continue;
        blockCount += 1;
        for (let faceIndex = 0; faceIndex < FACE_DEFS.length; faceIndex += 1) {
          const face = FACE_DEFS[faceIndex];
          const nx = x + face.delta[0];
          const ny = y + face.delta[1];
          const nz = z + face.delta[2];
          const neighbor = neighborBlock(chunkState, nx, ny, nz, getBlockAtWorld);
          if (isGreedyOpaqueBlock(neighbor)) continue;
          const shade = faceIndex === 2 ? terrainSunShadowShade(chunkState, x, y, z, getBlockAtWorld, null, face.shade) : null;
          addFaceCell(faceGroups, faceIndex, x, y, z, blockId, shade);
        }
      }
    }
  }

  for (const group of faceGroups.values()) {
    quadCount += appendGreedyGroup(group, positions, indices);
  }
  const cactusModels = appendCactusResourceModels(chunkState, positions, indices);
  blockCount += cactusModels.blocks;
  quadCount += cactusModels.quads;
  quadCount += appendTreeInstanceProxyQuads(chunkState, positions, indices, { getDeltaAtWorld, treeDeltaCandidateCount });

  const vertices = packVertices(positions);
  const vertexCount = vertices.byteLength / CHUNK_VERTEX_STRIDE_BYTES;
  const indexArray = vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  return {
    vertices,
    indices: indexArray,
    vertexCount,
    indexCount: indexArray.length,
    triangleCount: indexArray.length / 3,
    quadCount,
    blockCount,
    vertexStrideBytes: CHUNK_VERTEX_STRIDE_BYTES,
    chunkX: chunkState.chunkX,
    chunkZ: chunkState.chunkZ,
    chunkSize: chunkState.chunkSize,
    height: chunkState.height,
    minY: chunkState.minY,
  };
}

export function meshChunkOpaqueFast(chunkState, {
  getBlockAtWorld = null,
  getDeltaAtWorld = null,
  getColumnTopAtWorld = null,
  treeDeltaCandidateCount = 0,
} = {}) {
  const positions = [];
  const indices = [];
  let blockCount = 0;
  let quadCount = 0;
  const faceGroups = new Map();
  const size = chunkState.chunkSize;
  const minY = chunkState.minY;
  const maxY = minY + chunkState.height - 1;
  const topY = new Int16Array(size * size);
  const topBlock = new Uint16Array(size * size);
  const deltaColumns = finalDeltaColumns(chunkState);
  const solidHeightfieldFastPath = Boolean(chunkState.baseProfile && !deltaColumns.size);
  topY.fill(minY - 1);

  if (chunkState.baseProfile) {
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const column = x + z * size;
        const top = deltaAwareProfileOpaqueColumnTop(chunkState, x, z, maxY, deltaColumns.get(column));
        if (top.y < minY) continue;
        topY[column] = top.y;
        topBlock[column] = top.blockId;
        blockCount += Math.max(1, top.y - minY + 1);
      }
    }
  } else {
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const column = x + z * size;
        for (let y = maxY; y >= minY; y -= 1) {
          const blockId = chunkState.getFinalBlock(x, y, z);
          if (!isGreedyOpaqueBlock(blockId)) continue;
          topY[column] = y;
          topBlock[column] = blockId;
          blockCount += Math.max(1, y - minY + 1);
          break;
        }
      }
    }
  }

  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      const column = x + z * size;
      const yTop = topY[column];
      if (yTop < minY) continue;
      addFaceCell(faceGroups, 2, x, yTop, z, topBlock[column], terrainSunShadowShade(chunkState, x, yTop, z, getBlockAtWorld, getColumnTopAtWorld, FACE_DEFS[2].shade));

      for (const side of FAST_SIDE_FACES) {
        const nx = x + side.dx;
        const nz = z + side.dz;
        const neighborTop = columnTopAt(chunkState, topY, nx, nz, getBlockAtWorld, getColumnTopAtWorld);
        if (solidHeightfieldFastPath) {
          if (neighborTop >= yTop) continue;
          for (let y = Math.max(minY, neighborTop + 1); y <= yTop; y += 1) {
            const blockId = chunkState.getFinalBlock(x, y, z);
            if (isGreedyOpaqueBlock(blockId)) addFaceCell(faceGroups, side.faceIndex, x, y, z, blockId);
          }
          continue;
        }
        const cliffStart = neighborTop < yTop ? neighborTop + 1 : yTop;
        const transparentProfileStart = yTop - FAST_TRANSPARENT_SIDE_SCAN_DEPTH;
        const startY = Math.max(minY, Math.min(cliffStart, transparentProfileStart));
        for (let y = startY; y <= yTop; y += 1) {
          const blockId = chunkState.getFinalBlock(x, y, z);
          if (!isGreedyOpaqueBlock(blockId)) continue;
          if (isGreedyOpaqueBlock(neighborBlock(chunkState, nx, y, nz, getBlockAtWorld))) continue;
          addFaceCell(faceGroups, side.faceIndex, x, y, z, blockId);
        }
      }
    }
  }
  appendOpaqueDeltaFaces(chunkState, faceGroups, getBlockAtWorld, getColumnTopAtWorld);
  for (const group of faceGroups.values()) {
    quadCount += appendGreedyGroup(group, positions, indices);
  }
  const cactusModels = appendCactusResourceModels(chunkState, positions, indices);
  blockCount += cactusModels.blocks;
  quadCount += cactusModels.quads;
  quadCount += appendTreeInstanceProxyQuads(chunkState, positions, indices, { getDeltaAtWorld, treeDeltaCandidateCount });

  const vertices = packVertices(positions);
  const vertexCount = vertices.byteLength / CHUNK_VERTEX_STRIDE_BYTES;
  const indexArray = vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  return {
    vertices,
    indices: indexArray,
    vertexCount,
    indexCount: indexArray.length,
    triangleCount: indexArray.length / 3,
    quadCount,
    blockCount,
    vertexStrideBytes: CHUNK_VERTEX_STRIDE_BYTES,
    chunkX: chunkState.chunkX,
    chunkZ: chunkState.chunkZ,
    chunkSize: chunkState.chunkSize,
    height: chunkState.height,
    minY: chunkState.minY,
    fastHeightfield: true,
  };
}

function profileOpaqueColumnTop(chunkState, localX, localZ, maxY) {
  const profile = chunkState.baseProfile;
  const column = localX + localZ * chunkState.chunkSize;
  const surfaceY = Math.min(maxY, profile.surfaceY[column]);
  const aboveBlock = surfaceY + 1 <= maxY
    ? chunkState.getFinalBlock(localX, surfaceY + 1, localZ)
    : BLOCK_ID.air;
  if (isGreedyOpaqueBlock(aboveBlock) && surfaceY + 1 <= maxY) return { y: surfaceY + 1, blockId: aboveBlock };
  const surfaceBlock = profile.surfaceBlock?.[column] ?? chunkState.getFinalBlock(localX, surfaceY, localZ);
  if (isGreedyOpaqueBlock(surfaceBlock)) return { y: surfaceY, blockId: surfaceBlock };
  for (let y = surfaceY - 1; y >= Math.max(chunkState.minY, surfaceY - 4); y -= 1) {
    const blockId = chunkState.getFinalBlock(localX, y, localZ);
    if (isGreedyOpaqueBlock(blockId)) return { y, blockId };
  }
  return { y: chunkState.minY - 1, blockId: BLOCK_ID.air };
}

function deltaAwareProfileOpaqueColumnTop(chunkState, localX, localZ, maxY, deltas = null) {
  const profileTop = profileOpaqueColumnTop(chunkState, localX, localZ, maxY);
  if (!deltas?.length) return profileTop;
  let candidateY = profileTop.y;
  for (const delta of deltas) {
    if (delta.localY > maxY || delta.localY < chunkState.minY) continue;
    if (isGreedyOpaqueBlock(delta.blockId)) candidateY = Math.max(candidateY, delta.localY);
  }
  for (let y = Math.min(maxY, candidateY); y >= chunkState.minY; y -= 1) {
    const blockId = chunkState.getFinalBlock(localX, y, localZ);
    if (isGreedyOpaqueBlock(blockId)) return { y, blockId };
  }
  return { y: chunkState.minY - 1, blockId: BLOCK_ID.air };
}

function profileWaterY(profile, column) {
  if (!profile?.waterY) return null;
  const water = profile.waterY[column];
  if (water === profile.noWater || water < profile.minY || water >= profile.minY + profile.height) return null;
  return water;
}

export function meshChunkVisual(chunkState, { getBlockAtWorld = null, getColumnTopAtWorld = null, getWaterLevelAtWorld = null } = {}) {
  const positions = [];
  const indices = [];
  let blockCount = 0;
  let quadCount = 0;
  const faceGroups = new Map();
  const waterDepthCache = new WaterDepthFieldSampler(chunkState, getBlockAtWorld, getColumnTopAtWorld, getWaterLevelAtWorld);
  const size = chunkState.chunkSize;
  const minY = chunkState.minY;
  const height = chunkState.height;

  if (chunkState.baseProfile) {
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const column = x + z * size;
        const surface = chunkState.baseProfile.surfaceY[column];
        const water = profileWaterY(chunkState.baseProfile, column);
        const finalSurface = chunkState.getFinalBlock(x, surface, z);
        if (isVisualBlock(finalSurface) && !isFluidBlock(finalSurface) && !isLowVegetationBlock(finalSurface)) {
          blockCount += 1;
          for (let faceIndex = 0; faceIndex < FACE_DEFS.length; faceIndex += 1) {
            const face = FACE_DEFS[faceIndex];
            const neighbor = neighborBlock(chunkState, x + face.delta[0], surface + face.delta[1], z + face.delta[2], getBlockAtWorld);
            if (!visualFaceOccluded(finalSurface, neighbor)) addFaceCell(faceGroups, faceIndex, x, surface, z, finalSurface);
          }
        }
        if (water !== null && water > surface && water >= minY && water < minY + height) {
          const blockId = chunkState.getFinalBlock(x, water, z);
          if (isFluidBlock(blockId)) {
            blockCount += 1;
            if (shouldUseGradientWaterSurface(chunkState, x, water, z, blockId, getBlockAtWorld, waterDepthCache)) {
              quadCount += appendWaterSurfaceQuad(chunkState, x, water, z, blockId, getBlockAtWorld, waterDepthCache, positions, indices);
            } else {
              addFaceCell(faceGroups, 2, x, water, z, blockId, waterSurfaceDepthAoCached(chunkState, x, water, z, blockId, getBlockAtWorld, waterDepthCache));
            }
          }
          continue;
        }
        const vegetationY = surface + 1;
        const profileSurface = unchangedProfileSurfaceBlock(chunkState, chunkState.baseProfile, column, x, surface, z);
        if (profileSurface === BLOCK_ID.air) continue;
        const finalVegetation = chunkState.getFinalBlock(x, vegetationY, z);
        if (isVisualBlock(finalVegetation) && vegetationY >= minY && vegetationY < minY + height) {
          if (isLowVegetationBlock(finalVegetation)) {
            if (!shouldRenderLowVegetation(finalVegetation, chunkState, x, vegetationY, z)) continue;
            blockCount += 1;
            quadCount += appendLowVegetationShadow(x, vegetationY, z, finalVegetation, chunkState, positions, indices);
            quadCount += appendLowVegetationQuads(x, vegetationY, z, finalVegetation, chunkState, positions, indices);
          }
        }
      }
    }
    const deltaVisual = appendVisualDeltaGeometry(chunkState, faceGroups, positions, indices, getBlockAtWorld, waterDepthCache);
    blockCount += deltaVisual.blocks;
    quadCount += deltaVisual.quads;
    quadCount += appendTerrainProjectionShadowsProfile(chunkState, positions, indices, getColumnTopAtWorld);
    quadCount += appendTreeInstanceShadowQuads(chunkState, positions, indices);
    quadCount += appendGroundDetailLayerProfile(chunkState, positions, indices, getBlockAtWorld);
  } else {
    for (let z = 0; z < size; z += 1) {
      for (let y = minY; y < minY + height; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const blockId = chunkState.getFinalBlock(x, y, z);
          if (!isVisualBlock(blockId)) continue;
          if (isLowVegetationBlock(blockId)) {
            if (!shouldRenderLowVegetation(blockId, chunkState, x, y, z)) continue;
            blockCount += 1;
            quadCount += appendLowVegetationShadow(x, y, z, blockId, chunkState, positions, indices);
            quadCount += appendLowVegetationQuads(x, y, z, blockId, chunkState, positions, indices);
            continue;
          }
          blockCount += 1;
          if (isFluidBlock(blockId)) {
            const above = neighborBlock(chunkState, x, y + 1, z, getBlockAtWorld);
            if (!isFluidBlock(above) && !isOpaqueSolidBlock(above)) {
              if (shouldUseGradientWaterSurface(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache)) {
                quadCount += appendWaterSurfaceQuad(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache, positions, indices);
              } else {
                addFaceCell(faceGroups, 2, x, y, z, blockId, waterSurfaceDepthAoCached(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache));
              }
            }
            continue;
          }
          for (let faceIndex = 0; faceIndex < FACE_DEFS.length; faceIndex += 1) {
            const face = FACE_DEFS[faceIndex];
            const nx = x + face.delta[0];
            const ny = y + face.delta[1];
            const nz = z + face.delta[2];
            const neighbor = neighborBlock(chunkState, nx, ny, nz, getBlockAtWorld);
            if (visualFaceOccluded(blockId, neighbor)) continue;
            addFaceCell(faceGroups, faceIndex, x, y, z, blockId);
          }
        }
      }
    }
    quadCount += appendTerrainProjectionShadows(chunkState, positions, indices, getBlockAtWorld, getColumnTopAtWorld);
    quadCount += appendTreeInstanceShadowQuads(chunkState, positions, indices);
    quadCount += appendGroundDetailLayer(chunkState, positions, indices, getBlockAtWorld);
  }

  const cactusShadows = appendCactusResourceShadows(chunkState, positions, indices);
  blockCount += cactusShadows.blocks;
  quadCount += cactusShadows.quads;

  for (const group of faceGroups.values()) {
    quadCount += appendGreedyGroup(group, positions, indices);
  }

  const vertices = packVertices(positions);
  const vertexCount = vertices.byteLength / CHUNK_VERTEX_STRIDE_BYTES;
  const indexArray = vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  return {
    vertices,
    indices: indexArray,
    vertexCount,
    indexCount: indexArray.length,
    triangleCount: indexArray.length / 3,
    quadCount,
    blockCount,
    vertexStrideBytes: CHUNK_VERTEX_STRIDE_BYTES,
    chunkX: chunkState.chunkX,
    chunkZ: chunkState.chunkZ,
    chunkSize: chunkState.chunkSize,
    height: chunkState.height,
    minY: chunkState.minY,
    visual: true,
  };
}

export function buildDebugVisualModelAssets() {
  const assets = [
    previewMeshAsset({
      id: "grass_tuft",
      name: "micro voxel grass tuft",
      category: "ground detail",
      description: "A low-density micro voxel grass tuft merged into the visual chunk without collision.",
      build: (vertices, indices) => appendGrassTuft(vertices, indices, 0.5, 0.03, 0.5, 0.17, 0.27 * GRASS_HEIGHT_SCALE, materialDef(blockDef(BLOCK_ID.grassPlant).materialId).textureLayer, 226, 0x6c8f1a2b, BLOCK_ID.grassPlant),
    }),
    previewMeshAsset({
      id: "micro_sprout_patch",
      name: "micro sprout patch",
      category: "ground detail",
      description: "A lightweight grass accent using a few tiny voxel blades to enrich ground detail.",
      build: (vertices, indices) => appendMicroSproutPatch(vertices, indices, 0.5, 0.032, 0.5, 0x3c94b6d1, BLOCK_ID.grassPlant),
    }),
    previewMeshAsset({
      id: "micro_flower_sprig",
      name: "micro flower sprig",
      category: "ground detail",
      description: "A tiny voxel flower accent sparsely distributed across grass surfaces.",
      build: (vertices, indices) => appendMicroFlowerSprig(vertices, indices, 0.5, 0.032, 0.5, 0xf0a14c75),
    }),
    previewMeshAsset({
      id: "dry_grass_tuft",
      name: "dry grass tuft",
      category: "ground detail",
      description: "A micro voxel dry-grass tuft for sand and dry-soil visual layers.",
      build: (vertices, indices) => appendGrassTuft(vertices, indices, 0.5, 0.03, 0.5, 0.16, 0.24 * GRASS_HEIGHT_SCALE, materialDef(blockDef(BLOCK_ID.dryGrass).materialId).textureLayer, 222, 0x9e341a77, BLOCK_ID.dryGrass),
    }),
    previewMeshAsset({
      id: "micro_cactus",
      name: "voxel cactus resource",
      category: "resource model",
      description: "The five-cuboid cactus silhouette used by canonical cactus resource blocks.",
      build: (vertices, indices) => appendVoxelCactus(vertices, indices, 0, 0, 0, 0x41df13ac),
    }),
    previewMeshAsset({
      id: "voxel_bush",
      name: "voxel bush",
      category: "ground detail",
      description: "A volumetric voxel bush assembled from a small set of leaf clusters without visual-layer collision.",
      build: (vertices, indices) => appendVoxelBush(vertices, indices, 0.5, 0.03, 0.5, 0x2a7d5e19, BLOCK_ID.bush),
    }),
    previewMeshAsset({
      id: "voxel_snow_bush",
      name: "snow-covered voxel bush",
      category: "ground detail",
      description: "An evergreen voxel bush with separate snow caps that preserve a readable winter silhouette.",
      build: (vertices, indices) => appendVoxelBush(vertices, indices, 0.5, 0.03, 0.5, 0x7b34c1e2, BLOCK_ID.snowBush),
    }),
    previewMeshAsset({
      id: "voxel_dead_bush",
      name: "voxel dead bush",
      category: "ground detail",
      description: "A volumetric dead-bush and dry-branch voxel model replacing the old flat plant.",
      build: (vertices, indices) => appendDryShrub(vertices, indices, 0, 0, 0, 0xc38a2d77, BLOCK_ID.deadBush),
    }),
    previewMeshAsset({
      id: "voxel_thorn",
      name: "forked voxel thorn",
      category: "ground detail",
      description: "A dry forked shrub with pointed thorn offshoots instead of a generic vegetation cube.",
      build: (vertices, indices) => appendDryShrub(vertices, indices, 0, 0, 0, 0x19e47c83, BLOCK_ID.thorn),
    }),
    previewMeshAsset({
      id: "voxel_reed_cluster",
      name: "voxel reed cluster",
      category: "ground detail",
      description: "A waterside voxel reed cluster assembled from multiple slender stalks and seed heads.",
      build: (vertices, indices) => appendReedCluster(vertices, indices, 0.5, 0.03, 0.5, 0x61c8e3aa),
    }),
    previewMeshAsset({
      id: "swamp_grass_tuft",
      name: "swamp grass tuft",
      category: "ground detail",
      description: "Low voxel swamp grass used by wetland and muddy-ground resource rules.",
      build: (vertices, indices) => appendGrassTuft(vertices, indices, 0.5, 0.03, 0.5, 0.16, 0.25 * GRASS_HEIGHT_SCALE, materialDef(blockDef(BLOCK_ID.swampGrass).materialId).textureLayer, 218, 0x38e26a5d, BLOCK_ID.swampGrass),
    }),
    previewMeshAsset({
      id: "cotton_plant",
      name: "cotton plant",
      category: "ground detail",
      description: "A low-poly forked cotton plant using the baked grass and white-flower material layers.",
      build: (vertices, indices) => appendCottonPlant(vertices, indices, 0, 0, 0, 0xc0770a51),
    }),
    previewMeshAsset({
      id: "white_flower_clump",
      name: "white flower clump",
      category: "ground detail",
      description: "Voxel stems, centers, and petals generated at low density and uploaded with grass geometry.",
      build: (vertices, indices) => appendFlowerClump(vertices, indices, 0, 0, 0, 0xf13b9a61, false),
    }),
    previewMeshAsset({
      id: "warm_flower_clump",
      name: "warm flower clump",
      category: "ground detail",
      description: "A warm-toned voxel flower assembled from existing sand and snow layers.",
      build: (vertices, indices) => appendFlowerClump(vertices, indices, 0, 0, 0, 0xb68d4c2f, true),
    }),
    previewMeshAsset({
      id: "red_flower_clump",
      name: "red flower clump",
      category: "ground detail",
      description: "A red voxel flower sharing the same three-view blueprint as the white, yellow, blue, and pink variants.",
      build: (vertices, indices) => appendFlowerClump(vertices, indices, 0, 0, 0, 0x3bc1e2f0, "red"),
    }),
    previewMeshAsset({
      id: "blue_flower_clump",
      name: "blue flower clump",
      category: "ground detail",
      description: "A blue voxel flower merged into the visual chunk at low density.",
      build: (vertices, indices) => appendFlowerClump(vertices, indices, 0, 0, 0, 0x6a91c8d4, "blue"),
    }),
    previewMeshAsset({
      id: "pink_flower_clump",
      name: "pink flower clump",
      category: "ground detail",
      description: "A pink voxel flower merged into the visual chunk at low density.",
      build: (vertices, indices) => appendFlowerClump(vertices, indices, 0, 0, 0, 0xd17a43b2, "pink"),
    }),
    previewMeshAsset({
      id: "micro_pebble_cluster",
      name: "micro pebble cluster",
      category: "ground detail",
      description: "Low voxel pebbles and soil fragments that add visual breakup without collision.",
      build: (vertices, indices) => appendPebbleCluster(vertices, indices, 0, 0, 0, 0x57c2d35b, BLOCK_ID.gravel),
    }),
    previewMeshAsset({
      id: "micro_moss_patch",
      name: "micro moss patch",
      category: "ground detail",
      description: "A ground-hugging voxel moss patch for moist resource zones without visual-layer collision.",
      build: (vertices, indices) => appendMicroGroundPatch(vertices, indices, 0.5, 0.03, 0.5, 0.18, materialDef(blockDef(BLOCK_ID.moss).materialId).textureLayer, 222, 0x74b2c153, BLOCK_ID.moss),
    }),
    previewMeshAsset({
      id: "voxel_lichen",
      name: "voxel lichen patch",
      category: "ground detail",
      description: "Overlapping irregular lichen patches that hug rock and snow surfaces without becoming a block slab.",
      build: (vertices, indices) => appendMicroGroundPatch(vertices, indices, 0.5, 0.03, 0.5, 0.18, materialDef(blockDef(BLOCK_ID.lichen).materialId).textureLayer, 224, 0x51d8a73c, BLOCK_ID.lichen),
    }),
    previewMeshAsset({
      id: "voxel_vine",
      name: "segmented voxel vine",
      category: "ground detail",
      description: "Bent segmented vine stems with side leaves, merged into the visual chunk as low-cost geometry.",
      build: (vertices, indices) => appendVineCluster(vertices, indices, 0.5, 0.03, 0.5, 0x8c27f4d1),
    }),
    previewMeshAsset({
      id: "micro_mushroom",
      name: "micro mushroom",
      category: "ground detail",
      description: "A low-probability voxel mushroom for wetlands and forests without visual-layer collision.",
      build: (vertices, indices) => appendMicroMushroom(vertices, indices, 0.5, 0.03, 0.5, 0x9a81d7f0),
    }),
    previewMeshAsset({
      id: "voxel_glow_mycelium",
      name: "glowing mycelium cluster",
      category: "ground detail",
      description: "A two-cap luminous mushroom cluster rooted in an irregular emissive mycelium patch.",
      build: (vertices, indices) => appendMicroMushroom(vertices, indices, 0.5, 0.03, 0.5, 0x64be91f3, BLOCK_ID.glowMycelium),
    }),
    previewMeshAsset({
      id: "voxel_seaweed",
      name: "voxel seaweed",
      category: "ground detail",
      description: "A volumetric underwater voxel plant cluster without visual-layer collision.",
      build: (vertices, indices) => appendAquaticPlantCluster(vertices, indices, 0.5, 0.03, 0.5, 0x77b416e5, BLOCK_ID.seaweed),
    }),
    previewMeshAsset({
      id: "voxel_aquatic_plant",
      name: "broadleaf aquatic plant",
      category: "ground detail",
      description: "Bent broad underwater leaves with side shoots, distinct from the taller seaweed silhouette.",
      build: (vertices, indices) => appendAquaticPlantCluster(vertices, indices, 0.5, 0.03, 0.5, 0xd3815a6e, BLOCK_ID.aquaticPlant),
    }),
    previewMeshAsset({
      id: "broadleaf_tree_proxy",
      name: "broadleaf tree proxy",
      category: "tree proxy",
      description: "A whole-tree proxy built from a small number of boxes to avoid rendering leaves block by block.",
      build: (vertices, indices) => appendTreeInstanceProxyQuads({
        chunkX: 0,
        chunkZ: 0,
        chunkSize: 16,
        treeInstances: [{ x: 0, z: 0, baseY: 0, trunkHeight: 4, pine: false }],
      }, vertices, indices),
    }),
    previewMeshAsset({
      id: "pine_tree_proxy",
      name: "pine tree proxy",
      category: "tree proxy",
      description: "A pine proxy with three canopy box layers sourced from the same runtime model as the game.",
      build: (vertices, indices) => appendTreeInstanceProxyQuads({
        chunkX: 0,
        chunkZ: 0,
        chunkSize: 16,
        treeInstances: [{ x: 0, z: 0, baseY: 0, trunkHeight: 5, pine: true }],
      }, vertices, indices),
    }),
    previewMeshAsset({
      id: "snowy_cedar_tree_proxy",
      name: "snowy cedar tree proxy",
      category: "tree proxy",
      description: "A snowy cedar proxy for elevations above the snowline, adding low-cost snow coverage to the pine canopy.",
      build: (vertices, indices) => appendTreeInstanceProxyQuads({
        chunkX: 0,
        chunkZ: 0,
        chunkSize: 16,
        treeInstances: [{ x: 0, z: 0, baseY: 0, trunkHeight: 5, pine: true, snowy: true, variantSeed: 0x7a31c9d5 }],
      }, vertices, indices),
    }),
  ];
  for (const blockId of RESOURCE_DROP_MODEL_BLOCK_IDS) {
    assets.push(createResourceDropPreviewMesh({ blockId }));
  }
  return assets;
}

const RESOURCE_DROP_PREVIEW_CACHE_LIMIT = 48;
const resourceDropPreviewCache = new Map();
const RESOURCE_DROP_MODEL_DEFS = Object.freeze({
  [BLOCK_ID.lava]: resourceDropModel("lava", "molten lava sample", "A stepped molten sample with a dark basalt crust instead of a fluid cube.", 0xa7d4132c, appendMoltenResourceSample),
  [BLOCK_ID.ice]: resourceDropModel("ice", "ice crystal cluster", "A compact cluster of translucent ice shards grown from one fractured base.", 0x1ce5a7d2, appendIceCrystalCluster),
  [BLOCK_ID.toxicWater]: resourceDropModel("toxic_water", "toxic fluid sample", "A shallow toxic pool with raised bubbles, rendered from the baked emissive fluid layer.", 0x70c1c5a9, appendToxicResourceSample),
  [BLOCK_ID.coral]: resourceDropModel("coral", "branching coral sample", "A low-cost branching coral colony with highlighted living tips.", 0xc04a15e1, (vertices, indices, hash) => appendCoralResourceCluster(vertices, indices, hash, false)),
  [BLOCK_ID.deadCoral]: resourceDropModel("dead_coral", "weathered coral sample", "A broken, desaturated coral skeleton with an asymmetric branch profile.", 0xdeadc045, (vertices, indices, hash) => appendCoralResourceCluster(vertices, indices, hash, true)),
  [BLOCK_ID.reed]: resourceDropModel("reed", "reed bundle", "The same slender stalk and seed-head geometry used by Chunk.js vegetation.", 0x61c8e3aa, (vertices, indices, hash) => appendReedCluster(vertices, indices, 0.5, 0.03, 0.5, hash)),
  [BLOCK_ID.vine]: resourceDropModel("vine", "segmented vine bundle", "The same bent segmented stems and side leaves used by Chunk.js vegetation.", 0x8c27f4d1, (vertices, indices, hash) => appendVineCluster(vertices, indices, 0.5, 0.03, 0.5, hash)),
  [BLOCK_ID.dryGrass]: resourceDropModel("dry_grass", "dry grass bundle", "A five-blade dry grass bundle built from the world vegetation mesh.", 0x9e341a77, appendDryGrassResourceBundle),
  [BLOCK_ID.deadBush]: resourceDropModel("dead_bush", "dead shrub bundle", "The same forked dry-shrub geometry used by Chunk.js surface vegetation.", 0xc38a2d77, (vertices, indices, hash) => appendDryShrub(vertices, indices, 0, 0, 0, hash, BLOCK_ID.deadBush)),
  [BLOCK_ID.thorn]: resourceDropModel("thorn", "thorn branch bundle", "A pointed forked thorn silhouette with no flat billboard or full cube.", 0x19e47c83, (vertices, indices, hash) => appendDryShrub(vertices, indices, 0, 0, 0, hash, BLOCK_ID.thorn)),
  [BLOCK_ID.deadWood]: resourceDropModel("dead_wood", "broken deadwood", "A stepped fallen branch with a fork and exposed broken end.", 0xd34d700d, appendDeadWoodResource),
  [BLOCK_ID.giantRoot]: resourceDropModel("giant_root", "giant root crown", "A compact stump crown with five low radial roots.", 0x610a7e21, appendGiantRootResource),
});

export const RESOURCE_DROP_MODEL_BLOCK_IDS = Object.freeze(
  Object.keys(RESOURCE_DROP_MODEL_DEFS).map(Number).sort((left, right) => left - right),
);

export function hasResourceDropPreviewModel(blockId) {
  return Boolean(RESOURCE_DROP_MODEL_DEFS[Math.trunc(Number(blockId))]);
}

export function createResourceDropPreviewMesh({ blockId, variantHash = 0 } = {}) {
  const normalizedBlockId = Math.trunc(Number(blockId));
  const definition = RESOURCE_DROP_MODEL_DEFS[normalizedBlockId];
  if (!definition) return emptyResourceDropPreviewMesh(normalizedBlockId);
  const hash = (Math.trunc(Number(variantHash)) >>> 0) || definition.seed;
  const cacheKey = `${normalizedBlockId}:${hash}`;
  const cached = resourceDropPreviewCache.get(cacheKey);
  if (cached) return cached;
  const mesh = previewMeshAsset({
    id: `resource_drop_${definition.id}`,
    name: definition.name,
    category: "resource drop model",
    description: definition.description,
    build: (vertices, indices) => definition.build(vertices, indices, hash),
  });
  resourceDropPreviewCache.set(cacheKey, mesh);
  if (resourceDropPreviewCache.size > RESOURCE_DROP_PREVIEW_CACHE_LIMIT) {
    resourceDropPreviewCache.delete(resourceDropPreviewCache.keys().next().value);
  }
  return mesh;
}

function resourceDropModel(id, name, description, seed, build) {
  return Object.freeze({ id, name, description, seed: seed >>> 0, build });
}

function emptyResourceDropPreviewMesh(blockId) {
  return {
    id: `resource_drop_unknown_${Number.isFinite(blockId) ? blockId : 0}`,
    name: "unknown resource drop",
    category: "resource drop model",
    description: "No registered resource-drop model.",
    vertexFormat: "chunk-object",
    vertices: [],
    indices: [],
    layers: [],
    quadCount: 0,
    triangleCount: 0,
    vertexCount: 0,
    collision: false,
  };
}

function neighborBlock(chunkState, localX, localY, localZ, getBlockAtWorld) {
  if (localX >= 0 && localZ >= 0 && localX < chunkState.chunkSize && localZ < chunkState.chunkSize && localY >= chunkState.minY && localY < chunkState.minY + chunkState.height) {
    return chunkState.getFinalBlock(localX, localY, localZ);
  }
  if (!getBlockAtWorld) return BLOCK_ID.air;
  return getBlockAtWorld(
    chunkLocalToWorldI32(chunkState.chunkX, localX, chunkState.chunkSize),
    localY,
    chunkLocalToWorldI32(chunkState.chunkZ, localZ, chunkState.chunkSize),
  );
}

function waterSurfaceDepthAo(chunkState, x, y, z, blockId, getBlockAtWorld) {
  if (!isFluidBlock(blockId) || blockId === BLOCK_ID.lava) return FACE_DEFS[2].shade;
  return new WaterDepthFieldSampler(chunkState, getBlockAtWorld).getAo(x, y, z, blockId);
}

function waterSurfaceDepthAoCached(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache) {
  if (waterDepthCache?.getAo) return waterDepthCache.getAo(x, y, z, blockId);
  if (!waterDepthCache) return waterSurfaceDepthAo(chunkState, x, y, z, blockId, getBlockAtWorld);
  const key = `${blockId}:${x}:${y}:${z}`;
  const cached = waterDepthCache.get(key);
  if (cached !== undefined) return cached;
  const ao = waterSurfaceDepthAo(chunkState, x, y, z, blockId, getBlockAtWorld);
  waterDepthCache.set(key, ao);
  return ao;
}

function shouldUseGradientWaterSurface(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache) {
  const center = waterSurfaceDepthAoCached(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache);
  for (const [dx, dz] of WATER_GRADIENT_NEIGHBORS) {
    const nx = x + dx;
    const nz = z + dz;
    const other = neighborBlock(chunkState, nx, y, nz, getBlockAtWorld);
    if (!sameWaterSurfaceFamily(blockId, other)) continue;
    const above = neighborBlock(chunkState, nx, y + 1, nz, getBlockAtWorld);
    if (isFluidBlock(above) || isOpaqueSolidBlock(above)) continue;
    const neighborAo = waterSurfaceDepthAoCached(chunkState, nx, y, nz, blockId, getBlockAtWorld, waterDepthCache);
    if (Math.abs(neighborAo - center) >= WATER_GRADIENT_AO_DELTA) return true;
  }
  return false;
}

function appendWaterSurfaceQuad(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache, vertices, indices) {
  const face = FACE_DEFS[2];
  const material = materialDef(blockDef(blockId).materialId);
  const vertexOffset = vertices.length;
  const corners = quadCorners(2, y + 1, x, z, 1, 1);
  const uvs = quadUvs(2, corners);
  for (let i = 0; i < 4; i += 1) {
    const corner = corners[i];
    vertices.push({
      p: corner,
      n: face.normal,
      uv: uvs[i],
      layer: material.textureLayer,
      ao: waterCornerDepthAo(chunkState, corner[0], y, corner[2], blockId, getBlockAtWorld, waterDepthCache),
      flags: 0,
    });
  }
  indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset, vertexOffset + 2, vertexOffset + 3);
  return 1;
}

function waterCornerDepthAo(chunkState, gridX, y, gridZ, blockId, getBlockAtWorld, waterDepthCache) {
  let total = 0;
  let count = 0;
  for (let dz = -1; dz <= 0; dz += 1) {
    for (let dx = -1; dx <= 0; dx += 1) {
      const cellX = gridX + dx;
      const cellZ = gridZ + dz;
      const other = neighborBlock(chunkState, cellX, y, cellZ, getBlockAtWorld);
      if (!sameWaterSurfaceFamily(blockId, other)) continue;
      const above = neighborBlock(chunkState, cellX, y + 1, cellZ, getBlockAtWorld);
      if (isFluidBlock(above) || isOpaqueSolidBlock(above)) continue;
      total += waterSurfaceDepthAoCached(chunkState, cellX, y, cellZ, blockId, getBlockAtWorld, waterDepthCache);
      count += 1;
    }
  }
  if (count <= 0) return waterSurfaceDepthAoCached(chunkState, gridX, y, gridZ, blockId, getBlockAtWorld, waterDepthCache);
  return Math.round(total / count);
}

class WaterDepthFieldSampler {
  constructor(chunkState, getBlockAtWorld, getColumnTopAtWorld, getWaterLevelAtWorld) {
    this.chunkState = chunkState;
    this.getBlockAtWorld = getBlockAtWorld;
    this.getColumnTopAtWorld = getColumnTopAtWorld;
    this.getWaterLevelAtWorld = getWaterLevelAtWorld;
    this.cache = new Map();
    this.fastHeightDepth = Boolean(getColumnTopAtWorld && getWaterLevelAtWorld && !chunkHasDeltas(chunkState));
  }

  getAo(localX, y, localZ, blockId) {
    if (!isFluidBlock(blockId) || blockId === BLOCK_ID.lava) return FACE_DEFS[2].shade;
    return waterDepthAoFromDepth(this.depthAt(localX, y, localZ));
  }

  depthAt(localX, y, localZ) {
    const key = `${Math.trunc(localX)}:${Math.trunc(y)}:${Math.trunc(localZ)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const depth = this.fastHeightDepth
      ? this.generatedWaterDepth(localX, y, localZ)
      : this.scannedWaterDepth(localX, y, localZ);
    this.cache.set(key, depth);
    return depth;
  }

  generatedWaterDepth(localX, y, localZ) {
    const worldX = chunkLocalToWorldI32(this.chunkState.chunkX, Math.trunc(localX), this.chunkState.chunkSize);
    const worldZ = chunkLocalToWorldI32(this.chunkState.chunkZ, Math.trunc(localZ), this.chunkState.chunkSize);
    const surface = this.getColumnTopAtWorld(worldX, worldZ);
    const waterLevel = this.getWaterLevelAtWorld(worldX, worldZ, surface);
    if (waterLevel === null || Math.trunc(waterLevel) < Math.trunc(y) || surface >= y) return WATER_DEPTH_MAX_DEPTH;
    return Math.max(1, Math.min(WATER_DEPTH_MAX_DEPTH, Math.trunc(y) - Math.trunc(surface)));
  }

  scannedWaterDepth(localX, y, localZ) {
    const minY = this.chunkState.minY;
    const startY = Math.trunc(y) - 1;
    const stopY = Math.max(minY, Math.trunc(y) - WATER_DEPTH_MAX_DEPTH);
    for (let sy = startY; sy >= stopY; sy -= 1) {
      const blockId = neighborBlock(this.chunkState, localX, sy, localZ, this.getBlockAtWorld);
      if (isFluidBlock(blockId) || blockId === BLOCK_ID.air || isLowVegetationBlock(blockId)) continue;
      return Math.max(1, Math.min(WATER_DEPTH_MAX_DEPTH, Math.trunc(y) - sy));
    }
    return WATER_DEPTH_MAX_DEPTH;
  }
}

function waterDepthAoFromDepth(waterDepth) {
  const clampedDepth = Math.max(1, Math.min(WATER_DEPTH_MAX_DEPTH, Math.trunc(waterDepth || WATER_DEPTH_MAX_DEPTH)));
  const depth = Math.max(0, Math.min(1, (clampedDepth - 1) / Math.max(1, WATER_DEPTH_MAX_DEPTH - 1)));
  const smoothDepth = smooth01(depth);
  const band = Math.round(smoothDepth * WATER_DEPTH_BANDS) / WATER_DEPTH_BANDS;
  return 150 + Math.round(band * 105);
}

function chunkHasDeltas(chunkState) {
  return Boolean(chunkState?.chainDeltas?.size || chunkState?.pendingDeltas?.size);
}

function finalDeltaMap(chunkState) {
  if (typeof chunkState?.getFinalDeltaMap === "function") return chunkState.getFinalDeltaMap();
  const merged = new Map(chunkState?.chainDeltas ?? []);
  for (const [key, delta] of chunkState?.pendingDeltas ?? []) merged.set(key, delta);
  return merged;
}

function finalDeltaColumns(chunkState) {
  const columns = new Map();
  for (const delta of finalDeltaMap(chunkState).values()) {
    if (!delta) continue;
    const column = delta.localX + delta.localZ * chunkState.chunkSize;
    let list = columns.get(column);
    if (!list) {
      list = [];
      columns.set(column, list);
    }
    list.push(delta);
  }
  return columns;
}

function appendOpaqueDeltaFaces(chunkState, faceGroups, getBlockAtWorld, getColumnTopAtWorld) {
  const deltas = finalDeltaMap(chunkState);
  if (!deltas.size) return;
  const candidates = new Set();
  for (const delta of deltas.values()) {
    if (!delta) continue;
    if (isGreedyOpaqueBlock(delta.blockId)) addCandidate(delta.localX, delta.localY, delta.localZ);
    for (const face of FACE_DEFS) {
      const x = delta.localX + face.delta[0];
      const y = delta.localY + face.delta[1];
      const z = delta.localZ + face.delta[2];
      if (!containsCandidate(x, y, z)) continue;
      const adjacentDelta = deltas.get(deltaKey(x, y, z, chunkState.chunkSize));
      if (adjacentDelta && !isGreedyOpaqueBlock(adjacentDelta.blockId)) continue;
      addCandidate(x, y, z);
    }
  }
  const area = chunkState.chunkSize * chunkState.chunkSize;
  for (const key of candidates) {
    const layer = Math.floor(key / area);
    const inLayer = key - layer * area;
    const z = Math.floor(inLayer / chunkState.chunkSize);
    const x = inLayer - z * chunkState.chunkSize;
    const y = chunkState.minY + layer;
    const blockId = chunkState.getFinalBlock(x, y, z);
    if (!isGreedyOpaqueBlock(blockId)) continue;
    for (let faceIndex = 0; faceIndex < FACE_DEFS.length; faceIndex += 1) {
      const face = FACE_DEFS[faceIndex];
      const neighbor = neighborBlock(chunkState, x + face.delta[0], y + face.delta[1], z + face.delta[2], getBlockAtWorld);
      if (isGreedyOpaqueBlock(neighbor)) continue;
      const shade = faceIndex === 2 ? terrainSunShadowShade(chunkState, x, y, z, getBlockAtWorld, getColumnTopAtWorld, face.shade) : null;
      addFaceCell(faceGroups, faceIndex, x, y, z, blockId, shade);
    }
  }

  function addCandidate(x, y, z) {
    if (!containsCandidate(x, y, z)) return;
    candidates.add((y - chunkState.minY) * chunkState.chunkSize * chunkState.chunkSize + z * chunkState.chunkSize + x);
  }

  function containsCandidate(x, y, z) {
    return x >= 0 && z >= 0 && x < chunkState.chunkSize && z < chunkState.chunkSize
      && y >= chunkState.minY && y < chunkState.minY + chunkState.height;
  }
}

function appendVisualDeltaGeometry(chunkState, faceGroups, positions, indices, getBlockAtWorld, waterDepthCache) {
  let blocks = 0;
  let quads = 0;
  for (const delta of finalDeltaMap(chunkState).values()) {
    const { localX: x, localY: y, localZ: z } = delta;
    const blockId = chunkState.getFinalBlock(x, y, z);
    if (!isVisualBlock(blockId)) continue;
    if (isLowVegetationBlock(blockId)) {
      if (!shouldRenderLowVegetation(blockId, chunkState, x, y, z)) continue;
      blocks += 1;
      quads += appendLowVegetationShadow(x, y, z, blockId, chunkState, positions, indices);
      quads += appendLowVegetationQuads(x, y, z, blockId, chunkState, positions, indices);
      continue;
    }
    blocks += 1;
    if (isFluidBlock(blockId)) {
      const above = neighborBlock(chunkState, x, y + 1, z, getBlockAtWorld);
      if (!isFluidBlock(above) && !isOpaqueSolidBlock(above)) {
        if (shouldUseGradientWaterSurface(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache)) {
          quads += appendWaterSurfaceQuad(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache, positions, indices);
        } else {
          addFaceCell(faceGroups, 2, x, y, z, blockId, waterSurfaceDepthAoCached(chunkState, x, y, z, blockId, getBlockAtWorld, waterDepthCache));
        }
      }
      continue;
    }
    for (let faceIndex = 0; faceIndex < FACE_DEFS.length; faceIndex += 1) {
      const face = FACE_DEFS[faceIndex];
      const neighbor = neighborBlock(chunkState, x + face.delta[0], y + face.delta[1], z + face.delta[2], getBlockAtWorld);
      if (!visualFaceOccluded(blockId, neighbor)) addFaceCell(faceGroups, faceIndex, x, y, z, blockId);
    }
  }
  return { blocks, quads };
}

function sameWaterSurfaceFamily(blockId, otherBlockId) {
  if (otherBlockId === blockId) return true;
  return (blockId === BLOCK_ID.water || blockId === BLOCK_ID.swampWater)
    && (otherBlockId === BLOCK_ID.water || otherBlockId === BLOCK_ID.swampWater);
}

const WATER_DEPTH_MAX_DEPTH = 12;
const WATER_DEPTH_BANDS = 6;
const WATER_GRADIENT_AO_DELTA = 10;
const WATER_GRADIENT_NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// Baked heightfield shadows keep mobile runtime cheap: no shadow map pass,
// no extra GPU texture, and no per-frame terrain ray tracing.
const TERRAIN_SHADOW_SUN_DIRECTION = [-0.72, 0.34, 0.62];
const PROJECTED_SHADOW_DIR_XZ = projectedShadowDirection(TERRAIN_SHADOW_SUN_DIRECTION);
const TERRAIN_SHADOW_STEPS = 7;
const TERRAIN_SHADOW_STEP_START = 1.35;
const TERRAIN_SHADOW_STEP_SIZE = 1.85;
const TERRAIN_SHADOW_MAX_SHADE_DROP = 112;
const TERRAIN_SHADOW_BASE_Y = 90;
const TERRAIN_SHADOW_HEIGHT_RANGE = 46;
const TERRAIN_SHADOW_VERTICAL_SEARCH = 28;
const TERRAIN_PROJECTION_SHADOW_MAX_PER_CHUNK = 32;

function previewMeshAsset({ id, name, category, description, build }) {
  const vertices = [];
  const indices = [];
  const quads = build(vertices, indices) || 0;
  const layers = [...new Set(vertices.map((vertex) => vertex.layer).filter((layer) => Number.isFinite(layer)))].sort((a, b) => a - b);
  return {
    id,
    name,
    category,
    description,
    vertexFormat: "chunk-object",
    vertices: vertices.map((vertex) => ({
      p: [...vertex.p],
      n: [...vertex.n],
      uv: [...vertex.uv],
      layer: vertex.layer,
      ao: vertex.ao,
      flags: vertex.flags,
    })),
    indices: [...indices],
    layers,
    quadCount: quads,
    triangleCount: indices.length / 3,
    vertexCount: vertices.length,
    collision: false,
  };
}

function columnTopAt(chunkState, topY, localX, localZ, getBlockAtWorld, getColumnTopAtWorld) {
  if (localX >= 0 && localZ >= 0 && localX < chunkState.chunkSize && localZ < chunkState.chunkSize) {
    return topY[localX + localZ * chunkState.chunkSize];
  }
  const worldX = chunkLocalToWorldI32(chunkState.chunkX, localX, chunkState.chunkSize);
  const worldZ = chunkLocalToWorldI32(chunkState.chunkZ, localZ, chunkState.chunkSize);
  if (getColumnTopAtWorld) return getColumnTopAtWorld(worldX, worldZ);
  if (!getBlockAtWorld) return chunkState.minY - 1;
  for (let y = chunkState.minY + chunkState.height - 1; y >= chunkState.minY; y -= 1) {
    if (isGreedyOpaqueBlock(getBlockAtWorld(worldX, y, worldZ))) return y;
  }
  return chunkState.minY - 1;
}

function terrainSunShadowShade(chunkState, localX, y, localZ, getBlockAtWorld, getColumnTopAtWorld, baseShade = FACE_DEFS[2].shade) {
  const sunY = Math.max(0.08, TERRAIN_SHADOW_SUN_DIRECTION[1]);
  const sunXZ = Math.hypot(TERRAIN_SHADOW_SUN_DIRECTION[0], TERRAIN_SHADOW_SUN_DIRECTION[2]) || 1;
  const dirX = TERRAIN_SHADOW_SUN_DIRECTION[0] / sunXZ;
  const dirZ = TERRAIN_SHADOW_SUN_DIRECTION[2] / sunXZ;
  const slope = sunY / sunXZ;
  const lowSun = 1 - smooth01((sunY - 0.30) / 0.48);
  if (lowSun <= 0.02) return baseShade;

  let occlusion = 0;
  for (let i = 1; i <= TERRAIN_SHADOW_STEPS; i += 1) {
    const distance = TERRAIN_SHADOW_STEP_START + i * TERRAIN_SHADOW_STEP_SIZE;
    const sampleX = Math.floor(localX + 0.5 + dirX * distance);
    const sampleZ = Math.floor(localZ + 0.5 + dirZ * distance);
    const rayY = y + 0.78 + slope * distance;
    const top = terrainShadowColumnTop(chunkState, sampleX, sampleZ, y, getBlockAtWorld, getColumnTopAtWorld);
    if (top + 0.62 < rayY) continue;
    const nearWeight = 1 - (i - 1) / TERRAIN_SHADOW_STEPS;
    const heightWeight = Math.max(0, Math.min(1, (top + 0.62 - rayY) / 3.5));
    occlusion = Math.max(occlusion, nearWeight * (0.48 + heightWeight * 0.52));
    if (occlusion > 0.92) break;
  }

  if (occlusion <= 0.01) return baseShade;
  const heightLift = smooth01((y - TERRAIN_SHADOW_BASE_Y) / TERRAIN_SHADOW_HEIGHT_RANGE);
  const strength = (0.42 + heightLift * 0.22) * lowSun;
  return quantizedShade(Math.max(132, Math.round(baseShade - occlusion * TERRAIN_SHADOW_MAX_SHADE_DROP * strength)));
}

function terrainShadowColumnTop(chunkState, localX, localZ, referenceY, getBlockAtWorld, getColumnTopAtWorld) {
  if (getColumnTopAtWorld) {
    const worldX = chunkLocalToWorldI32(chunkState.chunkX, localX, chunkState.chunkSize);
    const worldZ = chunkLocalToWorldI32(chunkState.chunkZ, localZ, chunkState.chunkSize);
    return getColumnTopAtWorld(worldX, worldZ);
  }
  for (let y = Math.min(chunkState.minY + chunkState.height - 1, referenceY + TERRAIN_SHADOW_VERTICAL_SEARCH); y >= referenceY; y -= 1) {
    if (isGreedyOpaqueBlock(neighborBlock(chunkState, localX, y, localZ, getBlockAtWorld))) return y;
  }
  return chunkState.minY - 1;
}

function appendUnitFace(faceIndex, x, y, z, blockId, vertices, indices) {
  const face = FACE_DEFS[faceIndex];
  const material = materialDef(blockMaterialIdForFace(blockId, faceIndex));
  const cell = greedyCell(faceIndex, x, y, z);
  appendQuad({ faceIndex, face, plane: cell.plane, layer: material.textureLayer }, cell.u, cell.v, 1, 1, vertices, indices);
}

function addFaceCell(faceGroups, faceIndex, x, y, z, blockId, ao = null) {
  const face = FACE_DEFS[faceIndex];
  const material = materialDef(blockMaterialIdForFace(blockId, faceIndex));
  const layer = material.textureLayer;
  const shade = Number.isFinite(ao) ? Math.max(0, Math.min(255, Math.trunc(ao))) : face.shade;
  const cell = greedyCell(faceIndex, x, y, z);
  const groupKey = `${faceIndex}:${cell.plane}:${layer}:${blockId}:${shade}`;
  let group = faceGroups.get(groupKey);
  if (!group) {
    group = { faceIndex, face, plane: cell.plane, layer, blockId, ao: shade, cellsByV: new Map(), minU: cell.u, maxU: cell.u, minV: cell.v, maxV: cell.v };
    faceGroups.set(groupKey, group);
  }
  const row = group.cellsByV.get(cell.v) ?? 0;
  group.cellsByV.set(cell.v, row | (1 << cell.u));
  group.minU = Math.min(group.minU, cell.u);
  group.maxU = Math.max(group.maxU, cell.u);
  group.minV = Math.min(group.minV, cell.v);
  group.maxV = Math.max(group.maxV, cell.v);
}

function greedyCell(faceIndex, x, y, z) {
  switch (faceIndex) {
    case 0: return { plane: x + 1, u: z, v: y };
    case 1: return { plane: x, u: z, v: y };
    case 2: return { plane: y + 1, u: x, v: z };
    case 3: return { plane: y, u: x, v: z };
    case 4: return { plane: z + 1, u: x, v: y };
    default: return { plane: z, u: x, v: y };
  }
}

function appendGreedyGroup(group, vertices, indices) {
  let quads = 0;
  const visited = new Map();
  for (let v = group.minV; v <= group.maxV; v += 1) {
    for (let u = group.minU; u <= group.maxU; u += 1) {
      if (isVisited(visited, u, v) || !hasCell(group, u, v)) continue;
      let width = 1;
      while (hasCell(group, u + width, v) && !isVisited(visited, u + width, v)) width += 1;
      let height = 1;
      grow: while (v + height <= group.maxV) {
        for (let dx = 0; dx < width; dx += 1) {
          if (!hasCell(group, u + dx, v + height) || isVisited(visited, u + dx, v + height)) break grow;
        }
        height += 1;
      }
      const mask = ((1 << width) - 1) << u;
      for (let dy = 0; dy < height; dy += 1) visited.set(v + dy, (visited.get(v + dy) ?? 0) | mask);
      appendQuad(group, u, v, width, height, vertices, indices);
      quads += 1;
    }
  }
  return quads;
}

function appendQuad(group, u, v, width, height, vertices, indices) {
  const vertexOffset = vertices.length;
  const corners = quadCorners(group.faceIndex, group.plane, u, v, width, height);
  const uvs = quadUvs(group.faceIndex, corners);
  for (let i = 0; i < 4; i += 1) {
    vertices.push({ p: corners[i], n: group.face.normal, uv: uvs[i], layer: group.layer, ao: group.ao ?? group.face.shade, flags: 0 });
  }
  indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset, vertexOffset + 2, vertexOffset + 3);
}

function appendLowVegetationQuads(x, y, z, blockId, chunkState, vertices, indices) {
  const hash = lowVegetationHash(blockId, chunkState, x, y, z);
  if (blockId === BLOCK_ID.cactus) return appendVoxelCactus(vertices, indices, x, y, z, hash);
  if (blockId === BLOCK_ID.cotton) return appendCottonPlant(vertices, indices, x, y, z, hash);
  const fixedFlowerVariant = flowerVariantForBlock(blockId);
  if (fixedFlowerVariant) return appendFlowerClump(vertices, indices, x, y, z, hash, fixedFlowerVariant);
  const material = materialDef(blockDef(blockId).materialId);
  const layer = material.textureLayer;
  const ox = (((hash >>> 8) & 31) - 15) / 160;
  const oz = (((hash >>> 13) & 31) - 15) / 160;
  const cx = x + 0.5 + ox;
  const zc = z + 0.5 + oz;
  const height = lowVegetationHeight(blockId, hash);
  const radius = lowVegetationRadius(blockId, hash);
  const y0 = y + 0.035;
  const shade = blockFlags(blockId) & BLOCK_FLAGS.EMISSIVE ? 255 : 228;
  if (blockId === BLOCK_ID.bush || blockId === BLOCK_ID.snowBush) return appendVoxelBush(vertices, indices, cx, y0, zc, hash, blockId);
  if (blockId === BLOCK_ID.deadBush || blockId === BLOCK_ID.thorn) return appendDryShrub(vertices, indices, x, y, z, hash, blockId);
  if (blockId === BLOCK_ID.reed) return appendReedCluster(vertices, indices, cx, y0, zc, hash);
  if (blockId === BLOCK_ID.grassPlant && (hash & 7) <= 2) {
    return appendAssetSheetFlower(vertices, indices, cx, y0, zc, hash, {
      stemLayer: layer,
      ...flowerPalette(flowerVariantFromHash(hash >>> 12), hash),
      scale: 0.62 + ((hash >>> 11) & 3) * 0.04,
    });
  }
  if (blockId === BLOCK_ID.vine) return appendVineCluster(vertices, indices, cx, y0, zc, hash);
  if (blockId === BLOCK_ID.glowMycelium) return appendMicroMushroom(vertices, indices, cx, y0, zc, hash, BLOCK_ID.glowMycelium);
  if (blockId === BLOCK_ID.seaweed || blockId === BLOCK_ID.aquaticPlant) return appendAquaticPlantCluster(vertices, indices, cx, y0, zc, hash, blockId);
  if (blockId === BLOCK_ID.mushroom) return appendMicroMushroom(vertices, indices, cx, y0, zc, hash);
  if (blockId === BLOCK_ID.moss || blockId === BLOCK_ID.lichen) return appendMicroGroundPatch(vertices, indices, cx, y0, zc, radius, layer, shade, hash, blockId);
  return appendGrassTuft(vertices, indices, cx, y0, zc, radius, height, layer, shade, hash, blockId);
}

function appendLowVegetationShadow(x, y, z, blockId, chunkState, vertices, indices) {
  if (blockId === BLOCK_ID.cactus) {
    return appendProjectedShadowQuad(vertices, indices, x + 0.5, y + SHADOW_SURFACE_BIAS, z + 0.5, 0.38, 0.88 * CACTUS_MODEL_HEIGHT_SCALE, CACTUS_MODEL_MAX_Y, 0.34);
  }
  const hash = lowVegetationHash(blockId, chunkState, x, y, z);
  const ox = (((hash >>> 8) & 31) - 15) / 160;
  const oz = (((hash >>> 13) & 31) - 15) / 160;
  const cx = x + 0.5 + ox;
  const zc = z + 0.5 + oz;
  const height = lowVegetationHeight(blockId, hash);
  const radius = lowVegetationRadius(blockId, hash);
  const shadowY = y + SHADOW_SURFACE_BIAS;
  if (blockId === BLOCK_ID.bush || blockId === BLOCK_ID.snowBush) return appendProjectedShadowQuad(vertices, indices, cx, shadowY, zc, 0.46, 0.74, 0.46, 0.32);
  if (blockId === BLOCK_ID.deadBush || blockId === BLOCK_ID.thorn) return appendProjectedShadowQuad(vertices, indices, cx, shadowY, zc, 0.36, 0.56, 0.30, 0.26);
  if (blockId === BLOCK_ID.reed) return appendProjectedShadowQuad(vertices, indices, cx, shadowY, zc, 0.30, 0.72, 0.42, 0.26);
  if (blockId === BLOCK_ID.cotton) return appendProjectedShadowQuad(vertices, indices, cx, shadowY, zc, 0.34, 0.58, 0.58, 0.26);
  if (flowerVariantForBlock(blockId)) return appendProjectedShadowQuad(vertices, indices, cx, shadowY, zc, 0.34, 0.48, 0.48, 0.24);
  return appendProjectedShadowQuad(vertices, indices, cx, shadowY, zc, Math.max(0.18, radius * 1.45), Math.max(0.28, radius * 1.80 + height * 0.55), height, 0.22);
}

function appendGroundDetailShadow(x, y, z, hash, vertices, indices, radius, length, height, alpha = 0.22) {
  const cx = x + 0.5 + ((((hash >>> 10) & 31) - 15) / 150);
  const zc = z + 0.5 + ((((hash >>> 15) & 31) - 15) / 150);
  return appendProjectedShadowQuad(vertices, indices, cx, y + SHADOW_SURFACE_BIAS, zc, radius, length, height, alpha);
}

function appendTerrainProjectionShadowsProfile(chunkState, vertices, indices, getColumnTopAtWorld) {
  if (!chunkState.baseProfile) return 0;
  let quads = 0;
  let emitted = 0;
  const profile = chunkState.baseProfile;
  const size = chunkState.chunkSize;
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      const column = x + z * size;
      const y = profile.surfaceY[column];
      const water = profileWaterY(profile, column);
      if (water !== null && water > y) continue;
      const blockId = unchangedProfileSurfaceBlock(chunkState, profile, column, x, y, z);
      if (!isOpaqueSolidBlock(blockId) || !isGroundDetailSurface(blockId)) continue;
      const strength = terrainProjectionShadowStrength(chunkState, x, y, z, null, getColumnTopAtWorld);
      const worldX = chunkLocalToWorldI32(chunkState.chunkX, x, size);
      const worldZ = chunkLocalToWorldI32(chunkState.chunkZ, z, size);
      if (!shouldEmitTerrainProjectionShadow(worldX, y, worldZ, blockId, strength)) continue;
      quads += appendTerrainProjectionShadowQuad(vertices, indices, x, y + 1 + SHADOW_SURFACE_BIAS, z, strength, blockId);
      emitted += 1;
      if (emitted >= TERRAIN_PROJECTION_SHADOW_MAX_PER_CHUNK) return quads;
    }
  }
  return quads;
}

function appendTerrainProjectionShadows(chunkState, vertices, indices, getBlockAtWorld, getColumnTopAtWorld) {
  let quads = 0;
  let emitted = 0;
  const size = chunkState.chunkSize;
  const minY = chunkState.minY;
  const maxY = minY + chunkState.height - 1;
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let y = maxY; y >= minY; y -= 1) {
        const blockId = chunkState.getFinalBlock(x, y, z);
        if (!isOpaqueSolidBlock(blockId) || !isGroundDetailSurface(blockId)) continue;
        const above = neighborBlock(chunkState, x, y + 1, z, getBlockAtWorld);
        if (isFluidBlock(above) || isOpaqueSolidBlock(above)) break;
        const strength = terrainProjectionShadowStrength(chunkState, x, y, z, getBlockAtWorld, getColumnTopAtWorld);
        const worldX = chunkLocalToWorldI32(chunkState.chunkX, x, size);
        const worldZ = chunkLocalToWorldI32(chunkState.chunkZ, z, size);
        if (!shouldEmitTerrainProjectionShadow(worldX, y, worldZ, blockId, strength)) break;
        quads += appendTerrainProjectionShadowQuad(vertices, indices, x, y + 1 + SHADOW_SURFACE_BIAS, z, strength, blockId);
        emitted += 1;
        break;
      }
      if (emitted >= TERRAIN_PROJECTION_SHADOW_MAX_PER_CHUNK) return quads;
    }
  }
  return quads;
}

function terrainProjectionShadowStrength(chunkState, localX, y, localZ, getBlockAtWorld, getColumnTopAtWorld) {
  const sunY = Math.max(0.08, TERRAIN_SHADOW_SUN_DIRECTION[1]);
  const sunXZ = Math.hypot(TERRAIN_SHADOW_SUN_DIRECTION[0], TERRAIN_SHADOW_SUN_DIRECTION[2]) || 1;
  const dirX = TERRAIN_SHADOW_SUN_DIRECTION[0] / sunXZ;
  const dirZ = TERRAIN_SHADOW_SUN_DIRECTION[2] / sunXZ;
  const slope = sunY / sunXZ;
  let strength = 0;
  for (let i = 1; i <= 4; i += 1) {
    const distance = 0.85 + i * 1.15;
    const sampleX = Math.floor(localX + 0.5 + dirX * distance);
    const sampleZ = Math.floor(localZ + 0.5 + dirZ * distance);
    const rayY = y + 0.42 + slope * distance;
    const top = terrainShadowColumnTop(chunkState, sampleX, sampleZ, y, getBlockAtWorld, getColumnTopAtWorld);
    const over = top + 0.55 - rayY;
    if (over <= 0) continue;
    const near = 1 - (i - 1) / 4;
    strength = Math.max(strength, near * smooth01(over / 3.0));
  }
  return strength;
}

function shouldEmitTerrainProjectionShadow(worldX, y, worldZ, blockId, strength) {
  if (strength < 0.20) return false;
  const hash = detailHash(worldX, y, worldZ, blockId);
  if (strength >= 0.58) return true;
  if (strength >= 0.38) return (hash & 1) === 0;
  return (hash & 3) === 0;
}

function appendTerrainProjectionShadowQuad(vertices, indices, x, y, z, strength, blockId) {
  const hash = detailHash(Math.trunc(x * 17), Math.trunc(y * 13), Math.trunc(z * 19), blockId);
  const jitterX = (((hash >>> 6) & 15) - 7) / 96;
  const jitterZ = (((hash >>> 10) & 15) - 7) / 96;
  const radius = 0.38 + strength * 0.10;
  const length = 0.46 + strength * 0.46;
  const alpha = 0.16 + strength * 0.20;
  return appendProjectedShadowQuad(vertices, indices, x + 0.5 + jitterX, y, z + 0.5 + jitterZ, radius, length, 0.45 + strength, alpha);
}

function appendTreeInstanceShadowQuads(chunkState, vertices, indices) {
  if (!chunkState.treeInstances?.length) return 0;
  let quads = 0;
  for (const tree of chunkState.treeInstances) {
    if (treeInstanceModifiedByDelta(chunkState, tree)) continue;
    const x = worldI32ToChunkAffineLocal(chunkState.chunkX, tree.x, chunkState.chunkSize) + 0.5;
    const z = worldI32ToChunkAffineLocal(chunkState.chunkZ, tree.z, chunkState.chunkSize) + 0.5;
    const trunkHeight = Math.max(2, Number(tree.trunkHeight) || 3.6);
    const canopy = tree.pine ? 1.6 : 2.1;
    const shadowY = tree.baseY + SHADOW_SURFACE_BIAS;
    quads += appendProjectedShadowQuad(vertices, indices, x, shadowY, z, canopy * 0.72, canopy * 1.18 + trunkHeight * 0.22, trunkHeight + canopy, tree.pine ? 0.28 : 0.34);
    quads += appendProjectedShadowQuad(vertices, indices, x + 0.18, shadowY, z - 0.12, canopy * 0.42, canopy * 0.82, trunkHeight * 0.55, 0.18);
  }
  return quads;
}

function shouldRenderLowVegetation(blockId, chunkState, x, y, z) {
  if (!isRenderableLowVegetation(blockId)) return false;
  if (blockId === BLOCK_ID.cactus) return true;
  const roll = lowVegetationHash(blockId, chunkState, x, y, z) & 255;
  switch (blockId) {
    case BLOCK_ID.grassPlant:
    case BLOCK_ID.dryGrass:
    case BLOCK_ID.swampGrass:
      return roll > 220;
    case BLOCK_ID.moss:
    case BLOCK_ID.lichen:
      return roll > 244;
    case BLOCK_ID.mushroom:
      return roll > 248;
    case BLOCK_ID.bush:
    case BLOCK_ID.deadBush:
    case BLOCK_ID.reed:
    case BLOCK_ID.snowBush:
    case BLOCK_ID.thorn:
    case BLOCK_ID.vine:
    case BLOCK_ID.glowMycelium:
    case BLOCK_ID.seaweed:
    case BLOCK_ID.aquaticPlant:
    case BLOCK_ID.cotton:
    case BLOCK_ID.flowerWhite:
    case BLOCK_ID.flowerYellow:
    case BLOCK_ID.flowerRed:
    case BLOCK_ID.flowerBlue:
    case BLOCK_ID.flowerPink:
      return true;
    default:
      return false;
  }
}

function isRenderableLowVegetation(blockId) {
  switch (blockId) {
    case BLOCK_ID.grassPlant:
    case BLOCK_ID.dryGrass:
    case BLOCK_ID.bush:
    case BLOCK_ID.deadBush:
    case BLOCK_ID.cactus:
    case BLOCK_ID.reed:
    case BLOCK_ID.swampGrass:
    case BLOCK_ID.snowBush:
    case BLOCK_ID.thorn:
    case BLOCK_ID.moss:
    case BLOCK_ID.lichen:
    case BLOCK_ID.vine:
    case BLOCK_ID.glowMycelium:
    case BLOCK_ID.mushroom:
    case BLOCK_ID.seaweed:
    case BLOCK_ID.aquaticPlant:
    case BLOCK_ID.cotton:
    case BLOCK_ID.flowerWhite:
    case BLOCK_ID.flowerYellow:
    case BLOCK_ID.flowerRed:
    case BLOCK_ID.flowerBlue:
    case BLOCK_ID.flowerPink:
      return true;
    default:
      return false;
  }
}

function lowVegetationHeight(blockId, hash) {
  const jitter = ((hash >>> 16) & 15) / 15;
  switch (blockId) {
    case BLOCK_ID.moss:
    case BLOCK_ID.lichen:
      return 0.12 + jitter * 0.05;
    case BLOCK_ID.mushroom:
      return 0.20 + jitter * 0.07;
    case BLOCK_ID.grassPlant:
    case BLOCK_ID.dryGrass:
    case BLOCK_ID.swampGrass:
      return (0.22 + jitter * 0.12) * GRASS_HEIGHT_SCALE;
    default:
      return 0.22 + jitter * 0.12;
  }
}

function lowVegetationRadius(blockId, hash) {
  const jitter = ((hash >>> 24) & 15) / 15;
  switch (blockId) {
    case BLOCK_ID.moss:
    case BLOCK_ID.lichen:
      return 0.16 + jitter * 0.04;
    case BLOCK_ID.mushroom:
      return 0.11 + jitter * 0.03;
    default:
      return 0.15 + jitter * 0.06;
  }
}

function lowVegetationHash(blockId, chunkState, x, y, z) {
  let h = 0x811c9dc5;
  h = hashI32(h, chunkLocalToWorldI32(chunkState.chunkX, x, chunkState.chunkSize));
  h = hashI32(h, y);
  h = hashI32(h, chunkLocalToWorldI32(chunkState.chunkZ, z, chunkState.chunkSize));
  h = hashI32(h, blockId * 2654435761);
  h ^= h >>> 16;
  h = Math.imul(h >>> 0, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h >>> 0, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function hashI32(hash, value) {
  const v = Math.trunc(value) | 0;
  hash = Math.imul((hash ^ (v & 255)) >>> 0, 0x01000193) >>> 0;
  hash = Math.imul((hash ^ ((v >>> 8) & 255)) >>> 0, 0x01000193) >>> 0;
  hash = Math.imul((hash ^ ((v >>> 16) & 255)) >>> 0, 0x01000193) >>> 0;
  return Math.imul((hash ^ ((v >>> 24) & 255)) >>> 0, 0x01000193) >>> 0;
}

function appendGroundDetailLayer(chunkState, vertices, indices, getBlockAtWorld) {
  let quads = 0;
  const size = chunkState.chunkSize;
  const minY = chunkState.minY;
  const maxY = minY + chunkState.height - 1;
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let y = maxY; y >= minY; y -= 1) {
        const blockId = chunkState.getFinalBlock(x, y, z);
        if (!hasSurfaceDecorationRule(chunkState, blockId)) continue;
        const above = neighborBlock(chunkState, x, y + 1, z, getBlockAtWorld);
        if (isLowVegetationBlock(above) && shouldRenderLowVegetation(above, chunkState, x, y + 1, z)) break;
        if (above !== BLOCK_ID.air && !isLowVegetationBlock(above)) break;
        quads += appendGroundDetailAt(chunkState, x, y + 1, z, blockId, vertices, indices);
        break;
      }
    }
  }
  return quads;
}

function appendGroundDetailLayerProfile(chunkState, vertices, indices, getBlockAtWorld) {
  let quads = 0;
  const profile = chunkState.baseProfile;
  const size = chunkState.chunkSize;
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      const column = x + z * size;
      const y = profile.surfaceY[column];
      const water = profileWaterY(profile, column);
      if (water !== null && water > y) continue;
      const blockId = unchangedProfileSurfaceBlock(chunkState, profile, column, x, y, z);
      if (!hasSurfaceDecorationRule(chunkState, blockId)) continue;
      const aboveY = y + 1;
      const above = neighborBlock(chunkState, x, aboveY, z, getBlockAtWorld);
      if (isLowVegetationBlock(above) && shouldRenderLowVegetation(above, chunkState, x, aboveY, z)) continue;
      if (above !== BLOCK_ID.air && !isLowVegetationBlock(above)) continue;
      quads += appendGroundDetailAt(chunkState, x, aboveY, z, blockId, vertices, indices);
    }
  }
  return quads;
}

function unchangedProfileSurfaceBlock(chunkState, profile, column, x, y, z) {
  const baseBlockId = profile.surfaceBlock?.[column] ?? chunkState.getBaseBlock(x, y, z);
  return chunkState.getFinalBlock(x, y, z) === baseBlockId ? baseBlockId : BLOCK_ID.air;
}

function appendGroundDetailAt(chunkState, x, y, z, surfaceBlockId, vertices, indices) {
  const worldX = chunkLocalToWorldI32(chunkState.chunkX, x, chunkState.chunkSize);
  const worldZ = chunkLocalToWorldI32(chunkState.chunkZ, z, chunkState.chunkSize);
  const decoration = resolveSurfaceDecoration({
    worldSeed: chunkState.worldSeed,
    worldX,
    surfaceY: y - 1,
    worldZ,
    surfaceBlockId,
    rules: chunkState.surfaceDecorationRules ?? EMPTY_COMPILED_SURFACE_DECORATION_RULES,
  });
  if (!decoration) return 0;
  const hash = decoration.variantHash;
  const shadow = decoration.flags & SURFACE_DECORATION_FLAGS.SHADOW
    ? appendSurfaceDecorationShadow(decoration.decorationId, x, y, z, hash, vertices, indices)
    : 0;
  return shadow + appendSurfaceDecorationModel(decoration, vertices, indices, x, y, z, hash, surfaceBlockId);
}

function appendSurfaceDecorationModel(decoration, vertices, indices, x, y, z, hash, surfaceBlockId) {
  switch (decoration.decorationId) {
    case SURFACE_DECORATION_ID.flowerClump:
      return appendFlowerClump(vertices, indices, x, y, z, hash, flowerVariantFromHash(hash >>> 12));
    case SURFACE_DECORATION_ID.flowerSprig:
      return appendMicroFlowerSprigAt(vertices, indices, x, y, z, hash, flowerVariantFromHash(hash >>> 16));
    case SURFACE_DECORATION_ID.grassSprout:
      return appendMicroSproutPatchAt(vertices, indices, x, y, z, hash, BLOCK_ID.grassPlant);
    case SURFACE_DECORATION_ID.grassTuft:
      return appendGrassTuftAt(vertices, indices, x, y, z, hash, BLOCK_ID.grassPlant);
    case SURFACE_DECORATION_ID.mushroom:
      return appendMicroMushroomAt(vertices, indices, x, y, z, hash);
    case SURFACE_DECORATION_ID.mossPatch:
      return appendMicroGroundPatchAt(vertices, indices, x, y, z, hash, BLOCK_ID.moss);
    case SURFACE_DECORATION_ID.swampGrass:
      return appendGrassTuftAt(vertices, indices, x, y, z, hash, BLOCK_ID.swampGrass);
    case SURFACE_DECORATION_ID.microCactus:
      return appendMicroCactus(vertices, indices, x, y, z, hash);
    case SURFACE_DECORATION_ID.dryShrub:
      return appendDryShrub(vertices, indices, x, y, z, hash, BLOCK_ID.deadBush);
    case SURFACE_DECORATION_ID.dryGrass:
      return appendGrassTuftAt(vertices, indices, x, y, z, hash, BLOCK_ID.dryGrass);
    case SURFACE_DECORATION_ID.lichenPatch:
      return appendMicroGroundPatchAt(vertices, indices, x, y, z, hash, BLOCK_ID.lichen);
    case SURFACE_DECORATION_ID.cotton:
      return appendCottonPlant(vertices, indices, x, y, z, hash);
    case SURFACE_DECORATION_ID.flowerWhite:
      return appendFlowerClump(vertices, indices, x, y, z, hash, "white");
    case SURFACE_DECORATION_ID.flowerYellow:
      return appendFlowerClump(vertices, indices, x, y, z, hash, "yellow");
    case SURFACE_DECORATION_ID.flowerRed:
      return appendFlowerClump(vertices, indices, x, y, z, hash, "red");
    case SURFACE_DECORATION_ID.flowerBlue:
      return appendFlowerClump(vertices, indices, x, y, z, hash, "blue");
    case SURFACE_DECORATION_ID.flowerPink:
      return appendFlowerClump(vertices, indices, x, y, z, hash, "pink");
    case SURFACE_DECORATION_ID.pebbleGray:
    case SURFACE_DECORATION_ID.pebblePale:
    case SURFACE_DECORATION_ID.pebbleSnow:
    case SURFACE_DECORATION_ID.pebbleSand:
    case SURFACE_DECORATION_ID.pebbleDark:
    case SURFACE_DECORATION_ID.pebbleWarm:
    case SURFACE_DECORATION_ID.pebbleMossy:
    case SURFACE_DECORATION_ID.pebbleSalt:
      return appendPebbleCluster(vertices, indices, x, y, z, hash, surfaceBlockId, decoration);
    default:
      return 0;
  }
}

export function createSurfaceDecorationPreviewMesh({
  decorationId,
  variantHash = 0x6a91c8d4,
  surfaceBlockId = BLOCK_ID.grass,
  variant = 0,
  flags = 0,
} = {}) {
  const vertices = [];
  const indices = [];
  const id = Math.max(0, Math.trunc(Number(decorationId) || 0));
  const hash = Math.trunc(Number(variantHash) || 0) >>> 0;
  appendSurfaceDecorationModel(
    { decorationId: id, variant: Math.trunc(Number(variant) || 0), flags },
    vertices,
    indices,
    0,
    0,
    0,
    hash,
    Math.max(BLOCK_ID.air, Math.trunc(Number(surfaceBlockId) || BLOCK_ID.grass)),
  );
  return { vertices, indices };
}

function appendSurfaceDecorationShadow(decorationId, x, y, z, hash, vertices, indices) {
  if (isPebbleDecorationId(decorationId)) {
    return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.18, 0.24, 0.10, 0.14);
  }
  switch (decorationId) {
    case SURFACE_DECORATION_ID.flowerClump: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.34, 0.48, 0.28);
    case SURFACE_DECORATION_ID.flowerSprig: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.25, 0.38, 0.22);
    case SURFACE_DECORATION_ID.flowerWhite:
    case SURFACE_DECORATION_ID.flowerYellow:
    case SURFACE_DECORATION_ID.flowerRed:
    case SURFACE_DECORATION_ID.flowerBlue:
    case SURFACE_DECORATION_ID.flowerPink:
      return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.34, 0.48, 0.48, 0.24);
    case SURFACE_DECORATION_ID.cotton: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.34, 0.58, 0.58, 0.26);
    case SURFACE_DECORATION_ID.grassSprout: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.26, 0.48, 0.32);
    case SURFACE_DECORATION_ID.grassTuft:
    case SURFACE_DECORATION_ID.swampGrass: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.28, 0.60, 0.40);
    case SURFACE_DECORATION_ID.microCactus: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.34, 0.58, 0.32);
    case SURFACE_DECORATION_ID.dryShrub: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.34, 0.48, 0.24);
    case SURFACE_DECORATION_ID.dryGrass: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.26, 0.56, 0.36);
    case SURFACE_DECORATION_ID.mushroom: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.22, 0.30, 0.16);
    default: return appendGroundDetailShadow(x, y, z, hash, vertices, indices, 0.20, 0.28, 0.10);
  }
}

function isPebbleDecorationId(decorationId) {
  return decorationId >= SURFACE_DECORATION_ID.pebbleGray
    && decorationId <= SURFACE_DECORATION_ID.pebbleSalt;
}

function appendGrassTuftAt(vertices, indices, x, y, z, hash, blockId) {
  const material = materialDef(blockDef(blockId).materialId);
  const cx = x + 0.5 + ((((hash >>> 10) & 31) - 15) / 128);
  const zc = z + 0.5 + ((((hash >>> 15) & 31) - 15) / 128);
  const height = (0.16 + ((hash >>> 20) & 15) / 15 * 0.13) * GRASS_HEIGHT_SCALE;
  const radius = 0.12 + ((hash >>> 25) & 15) / 15 * 0.07;
  return appendGrassTuft(vertices, indices, cx, y + 0.032, zc, radius, height, material.textureLayer, 226, hash, blockId);
}

function appendMicroSproutPatchAt(vertices, indices, x, y, z, hash, blockId) {
  const cx = x + 0.5 + ((((hash >>> 11) & 31) - 15) / 130);
  const zc = z + 0.5 + ((((hash >>> 16) & 31) - 15) / 130);
  return appendMicroSproutPatch(vertices, indices, cx, y + 0.030, zc, hash, blockId);
}

function appendMicroFlowerSprigAt(vertices, indices, x, y, z, hash, variant = flowerVariantFromHash(hash)) {
  const cx = x + 0.5 + ((((hash >>> 10) & 31) - 15) / 140);
  const zc = z + 0.5 + ((((hash >>> 15) & 31) - 15) / 140);
  return appendMicroFlowerSprig(vertices, indices, cx, y + 0.030, zc, hash, variant);
}

function appendMicroMushroomAt(vertices, indices, x, y, z, hash) {
  const cx = x + 0.5 + ((((hash >>> 10) & 31) - 15) / 160);
  const zc = z + 0.5 + ((((hash >>> 15) & 31) - 15) / 160);
  return appendMicroMushroom(vertices, indices, cx, y + 0.030, zc, hash);
}

function appendMicroGroundPatchAt(vertices, indices, x, y, z, hash, blockId) {
  const material = materialDef(blockDef(blockId).materialId);
  const cx = x + 0.5 + ((((hash >>> 9) & 31) - 15) / 150);
  const zc = z + 0.5 + ((((hash >>> 14) & 31) - 15) / 150);
  return appendMicroGroundPatch(vertices, indices, cx, y + 0.026, zc, 0.15 + ((hash >>> 21) & 7) / 7 * 0.06, material.textureLayer, 218, hash, blockId);
}

function appendCottonPlant(vertices, indices, x, y, z, hash) {
  const stemLayer = materialDef(MATERIAL_ID.grassPlant).textureLayer;
  const cottonLayer = materialDef(MATERIAL_ID.flowerWhite).textureLayer;
  const cx = x + 0.5 + ((((hash >>> 9) & 31) - 15) / 170);
  const zc = z + 0.5 + ((((hash >>> 14) & 31) - 15) / 170);
  const y0 = y + 0.032;
  const leanX = ((((hash >>> 5) & 7) - 3) / 150);
  const leanZ = ((((hash >>> 18) & 7) - 3) / 150);
  const facing = (hash >>> 22) & 3;
  const topX = cx + leanX;
  const topZ = zc + leanZ;
  const branchX = cx + 0.18 - leanZ * 0.5;
  const branchZ = zc - 0.06 + leanX * 0.5;
  let quads = appendTaperedPrism(
    vertices,
    indices,
    cx,
    y0,
    zc,
    topX,
    y0 + 0.50,
    topZ,
    0.072,
    0.072,
    0.036,
    0.036,
    stemLayer,
    224,
  );
  quads += appendTaperedPrism(
    vertices,
    indices,
    cx,
    y0 + 0.18,
    zc,
    branchX,
    y0 + 0.40,
    branchZ,
    0.054,
    0.054,
    0.028,
    0.028,
    stemLayer,
    216,
  );
  quads += appendFlowerHeadQuad(
    vertices,
    indices,
    cx - 0.10,
    y0 + 0.27,
    zc + 0.01,
    0,
    0,
    0.19,
    0.09,
    facing + 1,
    stemLayer,
    220,
    true,
  );
  quads += appendCottonBoll(vertices, indices, topX, y0 + 0.535, topZ, facing, cottonLayer, 252, 1.0);
  quads += appendCottonBoll(vertices, indices, branchX, y0 + 0.435, branchZ, facing + 1, cottonLayer, 246, 0.92);
  quads += appendCottonBoll(vertices, indices, topX - 0.12, y0 + 0.455, topZ + 0.04, facing + 2, cottonLayer, 249, 0.86);
  return quads;
}

function appendCottonBoll(vertices, indices, cx, cy, cz, facing, layer, shade, scale) {
  const size = 0.15 * scale;
  let quads = appendFlowerHeadQuad(vertices, indices, cx, cy, cz, 0, 0, size, size, facing, layer, shade, true);
  quads += appendFlowerHeadQuad(vertices, indices, cx, cy, cz, 0, 0, size * 0.92, size * 0.92, facing + 1, layer, shade - 5, true, 0.004);
  return quads;
}

function appendFlowerClump(vertices, indices, x, y, z, hash, variant = "white") {
  const grassLayer = materialDef(blockDef(BLOCK_ID.grassPlant).materialId).textureLayer;
  const palette = flowerPalette(variant, hash);
  const cx = x + 0.5 + ((((hash >>> 9) & 31) - 15) / 150);
  const zc = z + 0.5 + ((((hash >>> 14) & 31) - 15) / 150);
  return appendAssetSheetFlower(vertices, indices, cx, y + 0.032, zc, hash, {
    stemLayer: grassLayer,
    petalLayer: palette.petalLayer,
    centerLayer: palette.centerLayer,
    warm: palette.warm,
    scale: 0.92 + ((hash >>> 22) & 3) * 0.035,
  });
}

function appendAssetSheetFlower(vertices, indices, cx, y0, zc, hash, options) {
  const {
    stemLayer,
    petalLayer,
    centerLayer,
    warm = false,
    scale = 1,
  } = options;
  const leanX = ((((hash >>> 7) & 7) - 3) / 180);
  const leanZ = ((((hash >>> 12) & 7) - 3) / 180);
  const sx = scale;
  const sy = scale;
  const topX = cx + leanX;
  const topZ = zc + leanZ;
  let quads = 0;

  // The stem, two leaves, and planar flower head stay in the shared chunk mesh.
  // Four double-sided petals replace six cuboids, cutting flower geometry.
  quads += appendTaperedPrism(vertices, indices, cx, y0, zc, topX, y0 + 0.420 * sy, topZ, 0.060 * sx, 0.060 * sx, 0.038 * sx, 0.038 * sx, stemLayer, 226);
  quads += appendTaperedPrism(vertices, indices, cx, y0 + 0.090 * sy, zc, cx - 0.170 * sx, y0 + 0.165 * sy, zc + 0.035 * sx, 0.070 * sx, 0.080 * sx, 0.018 * sx, 0.035 * sx, stemLayer, 222);
  quads += appendTaperedPrism(vertices, indices, cx, y0 + 0.150 * sy, zc, cx + 0.175 * sx, y0 + 0.230 * sy, zc - 0.030 * sx, 0.070 * sx, 0.080 * sx, 0.018 * sx, 0.035 * sx, stemLayer, 232);

  const flowerY = y0 + 0.455 * sy;
  const petalShade = warm ? 238 : 250;
  const facing = (hash >>> 19) & 3;
  quads += appendFlowerHeadQuad(vertices, indices, topX, flowerY, topZ, -0.112 * sx, 0, 0.132 * sx, 0.108 * sy, facing, petalLayer, petalShade, true);
  quads += appendFlowerHeadQuad(vertices, indices, topX, flowerY, topZ, 0.112 * sx, 0, 0.132 * sx, 0.108 * sy, facing, petalLayer, petalShade - 3, true);
  quads += appendFlowerHeadQuad(vertices, indices, topX, flowerY, topZ, 0, 0.108 * sy, 0.108 * sx, 0.126 * sy, facing, petalLayer, petalShade + 2, true);
  quads += appendFlowerHeadQuad(vertices, indices, topX, flowerY, topZ, 0, -0.108 * sy, 0.108 * sx, 0.126 * sy, facing, petalLayer, petalShade - 5, true);
  quads += appendFlowerHeadQuad(vertices, indices, topX, flowerY, topZ, 0, 0, 0.118 * sx, 0.110 * sy, facing, centerLayer, 255, false, 0.008 * sx);
  return quads;
}

function appendFlowerHeadQuad(vertices, indices, cx, cy, cz, offsetU, offsetY, sizeU, sizeY, facing, layer, shade, doubleSided, depth = 0) {
  const orientation = flowerHeadOrientation(facing);
  const ux = orientation.u[0];
  const uz = orientation.u[2];
  const nx = orientation.normal[0] / 127;
  const nz = orientation.normal[2] / 127;
  const centerX = cx + ux * offsetU + nx * depth;
  const centerY = cy + offsetY;
  const centerZ = cz + uz * offsetU + nz * depth;
  const halfU = sizeU * 0.5;
  const halfY = sizeY * 0.5;
  const points = [
    [centerX - ux * halfU, centerY - halfY, centerZ - uz * halfU],
    [centerX - ux * halfU, centerY + halfY, centerZ - uz * halfU],
    [centerX + ux * halfU, centerY + halfY, centerZ + uz * halfU],
    [centerX + ux * halfU, centerY - halfY, centerZ + uz * halfU],
  ];
  appendFlowerPlaneFace(vertices, indices, points, orientation.normal, layer, shade, false);
  if (doubleSided) appendFlowerPlaneFace(vertices, indices, points, orientation.normal, layer, shade - 10, true);
  return doubleSided ? 2 : 1;
}

function appendFlowerPlaneFace(vertices, indices, points, normal, layer, shade, reverse) {
  const vertexOffset = vertices.length;
  const ao = Math.max(0, Math.min(255, shade));
  const n = reverse ? normal.map((value) => -value) : normal;
  vertices.push(
    { p: points[0], n, uv: [0, 0], layer, ao, flags: 2 },
    { p: points[1], n, uv: [0, 1], layer, ao, flags: 2 },
    { p: points[2], n, uv: [1, 1], layer, ao, flags: 2 },
    { p: points[3], n, uv: [1, 0], layer, ao, flags: 2 },
  );
  if (reverse) indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset, vertexOffset + 2, vertexOffset + 3);
  else indices.push(vertexOffset, vertexOffset + 2, vertexOffset + 1, vertexOffset, vertexOffset + 3, vertexOffset + 2);
}

function flowerHeadOrientation(facing) {
  switch (facing & 3) {
    case 1: return { u: [0, 0, -1], normal: [127, 0, 0] };
    case 2: return { u: [-1, 0, 0], normal: [0, 0, -127] };
    case 3: return { u: [0, 0, 1], normal: [-127, 0, 0] };
    default: return { u: [1, 0, 0], normal: [0, 0, 127] };
  }
}

function appendMicroSproutPatch(vertices, indices, cx, y0, zc, hash, blockId) {
  const layer = materialDef(blockDef(blockId).materialId).textureLayer;
  const count = 2;
  let quads = 0;
  for (let i = 0; i < count; i += 1) {
    const profile = MICRO_GRASS_PROFILES[(i * 3 + ((hash >>> (i + 6)) & 7)) & 7];
    const ox = profile.dx * (0.055 + (((hash >>> (i + 12)) & 3) * 0.012));
    const oz = profile.dz * (0.055 + (((hash >>> (i + 15)) & 3) * 0.012));
    const h = (0.085 + ((hash >>> (i + 23)) & 3) * 0.018) * GRASS_HEIGHT_SCALE;
    const sx = profile.axis === "x" ? 0.092 : 0.052;
    const sz = profile.axis === "z" ? 0.092 : 0.052;
    quads += appendTaperedPrism(
      vertices,
      indices,
      cx + ox,
      y0,
      zc + oz,
      cx + ox + profile.dx * 0.035,
      y0 + h,
      zc + oz + profile.dz * 0.035,
      sx,
      sz,
      sx * 0.20,
      sz * 0.20,
      layer,
      220 + i * 5,
    );
  }
  return quads;
}

function appendMicroFlowerSprig(vertices, indices, cx, y0, zc, hash, variant = flowerVariantFromHash(hash)) {
  const grassLayer = materialDef(blockDef(BLOCK_ID.grassPlant).materialId).textureLayer;
  const palette = flowerPalette(variant, hash);
  return appendAssetSheetFlower(vertices, indices, cx, y0, zc, hash, {
    stemLayer: grassLayer,
    petalLayer: palette.petalLayer,
    centerLayer: palette.centerLayer,
    warm: palette.warm,
    scale: 0.58,
  });
}

function flowerVariantFromHash(hash) {
  const roll = hash & 15;
  if (roll < 4) return "white";
  if (roll < 7) return "yellow";
  if (roll < 10) return "red";
  if (roll < 13) return "pink";
  return "blue";
}

function flowerVariantForBlock(blockId) {
  switch (blockId) {
    case BLOCK_ID.flowerWhite: return "white";
    case BLOCK_ID.flowerYellow: return "yellow";
    case BLOCK_ID.flowerRed: return "red";
    case BLOCK_ID.flowerBlue: return "blue";
    case BLOCK_ID.flowerPink: return "pink";
    default: return null;
  }
}

function flowerPalette(variant, hash) {
  const centerLayer = materialDef(MATERIAL_ID.flowerYellow).textureLayer;
  switch (variant) {
    case true:
    case "yellow":
      return { petalLayer: materialDef(MATERIAL_ID.flowerYellow).textureLayer, centerLayer, warm: true };
    case "red":
      return { petalLayer: materialDef(MATERIAL_ID.flowerRed).textureLayer, centerLayer, warm: true };
    case "blue":
      return { petalLayer: materialDef(MATERIAL_ID.flowerBlue).textureLayer, centerLayer, warm: false };
    case "pink":
      return { petalLayer: materialDef(MATERIAL_ID.flowerPink).textureLayer, centerLayer, warm: false };
    case false:
    case "white":
    default:
      return { petalLayer: materialDef(MATERIAL_ID.flowerWhite).textureLayer, centerLayer, warm: false };
  }
}

function appendGrassTuft(vertices, indices, cx, y0, zc, radius, height, layer, shade, hash, blockId, maxBlades = null) {
  const dry = blockId === BLOCK_ID.dryGrass;
  const wet = blockId === BLOCK_ID.swampGrass || blockId === BLOCK_ID.reed;
  const bladeLimit = maxBlades ?? (dry ? 4 : 5);
  const bladeCount = Math.min(bladeLimit, dry ? 4 : 5);
  let quads = 0;
  const widthScale = Math.max(0.62, radius / 0.18);
  const heightScale = Math.max(0.56, height / 0.30);
  const sway = ((((hash >>> 24) & 15) - 7) / 360);
  for (let q = 0; q < bladeCount; q += 1) {
    const blade = ASSET_SHEET_GRASS_BLADES[q];
    const jitter = ((((hash >>> (q * 3 + 4)) & 7) - 3) / 420);
    const bx = cx + blade.x * widthScale + (blade.axis === "z" ? sway : 0) + jitter;
    const bz = zc + blade.z * widthScale + (blade.axis === "x" ? -sway : 0) - jitter;
    const sy = blade.h * heightScale * (0.90 + (((hash >>> (q + 12)) & 3) * 0.035));
    const sx = (blade.axis === "x" ? blade.w * 1.18 : blade.t) * widthScale;
    const sz = (blade.axis === "z" ? blade.w * 1.18 : blade.t) * widthScale;
    const tone = shade + blade.shade + (dry ? -18 : 0);
    const profileLean = dry ? 2.8 : wet ? 0.78 : 1.55;
    const tipX = bx + (blade.tip?.[0] ?? 0) * widthScale * profileLean + Math.sign(blade.x || 1) * (dry ? 0.020 : 0.006);
    const tipZ = bz + (blade.tip?.[1] ?? 0) * widthScale * profileLean + Math.sign(blade.z || 1) * (dry ? 0.020 : 0.006);
    quads += appendTaperedPrism(vertices, indices, bx, y0, bz, tipX, y0 + sy, tipZ, sx, sz, Math.max(0.012, sx * 0.20), Math.max(0.012, sz * 0.20), layer, tone);
  }
  return quads;
}

const ASSET_SHEET_GRASS_BLADES = [
  { axis: "x", x: -0.205, z: 0.000, w: 0.072, t: 0.050, h: 0.175, shade: -10, tip: [-0.018, 0.000] },
  { axis: "z", x: -0.125, z: 0.050, w: 0.074, t: 0.052, h: 0.255, shade: -3, tip: [0.000, 0.018] },
  { axis: "x", x: -0.045, z: -0.028, w: 0.080, t: 0.054, h: 0.340, shade: 8, tip: [0.018, 0.000] },
  { axis: "z", x: 0.045, z: 0.018, w: 0.072, t: 0.052, h: 0.225, shade: -6, tip: [0.000, -0.018] },
  { axis: "x", x: 0.120, z: -0.036, w: 0.076, t: 0.052, h: 0.292, shade: 4, tip: [0.018, 0.000] },
  { axis: "z", x: 0.205, z: 0.032, w: 0.068, t: 0.048, h: 0.185, shade: -14, tip: [0.000, 0.016] },
  { axis: "x", x: 0.000, z: 0.108, w: 0.066, t: 0.048, h: 0.245, shade: 2, tip: [-0.016, 0.000] },
];

const MICRO_GRASS_PROFILES = [
  { axis: "x", dx: -1.0, dz: 0.0 },
  { axis: "z", dx: 0.0, dz: -1.0 },
  { axis: "x", dx: 1.0, dz: 0.0 },
  { axis: "z", dx: 0.0, dz: 1.0 },
  { axis: "x", dx: -0.6, dz: -0.6 },
  { axis: "z", dx: 0.6, dz: -0.6 },
  { axis: "x", dx: 0.6, dz: 0.6 },
  { axis: "z", dx: -0.6, dz: 0.6 },
];

function appendPebbleCluster(vertices, indices, x, y, z, hash, surfaceBlockId, decoration) {
  const layers = pebbleLayers(decoration?.decorationId, surfaceBlockId);
  const count = 1 + ((hash >>> 18) & 1);
  let quads = 0;
  for (let i = 0; i < count; i += 1) {
    const ox = ((((hash >>> (i * 5 + 3)) & 31) - 15) / 96);
    const oz = ((((hash >>> (i * 5 + 9)) & 31) - 15) / 96);
    const sx = 0.12 + (((hash >>> (i + 21)) & 3) * 0.025);
    const sy = 0.070 + (((hash >>> (i + 24)) & 3) * 0.018);
    const sz = 0.11 + (((hash >>> (i + 27)) & 3) * 0.025);
    const cx = x + 0.5 + ox;
    const cz = z + 0.5 + oz;
    const leanX = ((((hash >>> (i + 7)) & 3) - 1) * 0.008);
    const leanZ = ((((hash >>> (i + 12)) & 3) - 1) * 0.008);
    quads += appendTaperedPrism(
      vertices,
      indices,
      cx,
      y + 0.018,
      cz,
      cx + leanX,
      y + sy,
      cz + leanZ,
      sx,
      sz,
      sx * 0.62,
      sz * 0.62,
      layers.base,
      210 + ((hash >>> i) & 15),
    );
    if (layers.cap !== null) {
      quads += appendMicroCuboid(
        vertices,
        indices,
        cx + leanX,
        y + sy + 0.009,
        cz + leanZ,
        sx * 0.66,
        0.025,
        sz * 0.66,
        layers.cap,
        248,
        { skipBottom: true },
      );
    }
  }
  return quads;
}

function pebbleLayers(decorationId, surfaceBlockId) {
  let baseBlockId = BLOCK_ID.gravel;
  let capBlockId = null;
  switch (decorationId) {
    case SURFACE_DECORATION_ID.pebblePale: baseBlockId = BLOCK_ID.stone; break;
    case SURFACE_DECORATION_ID.pebbleSnow: baseBlockId = BLOCK_ID.frozenSoil; capBlockId = BLOCK_ID.snow; break;
    case SURFACE_DECORATION_ID.pebbleSand: baseBlockId = BLOCK_ID.sand; break;
    case SURFACE_DECORATION_ID.pebbleDark: baseBlockId = BLOCK_ID.basalt; break;
    case SURFACE_DECORATION_ID.pebbleWarm: baseBlockId = surfaceBlockId === BLOCK_ID.clay ? BLOCK_ID.clay : BLOCK_ID.dryDirt; break;
    case SURFACE_DECORATION_ID.pebbleMossy: baseBlockId = BLOCK_ID.stone; capBlockId = BLOCK_ID.moss; break;
    case SURFACE_DECORATION_ID.pebbleSalt: baseBlockId = BLOCK_ID.saltFlat; break;
    default: break;
  }
  return {
    base: materialDef(blockDef(baseBlockId).materialId).textureLayer,
    cap: capBlockId === null ? null : materialDef(blockDef(capBlockId).materialId).textureLayer,
  };
}

function appendMicroCactus(vertices, indices, x, y, z, hash) {
  const layer = materialDef(blockDef(BLOCK_ID.cactus).materialId).textureLayer;
  const cx = x + 0.5 + ((((hash >>> 8) & 31) - 15) / 150);
  const zc = z + 0.5 + ((((hash >>> 13) & 31) - 15) / 150);
  const height = 0.34 + ((hash >>> 20) & 7) / 7 * 0.18;
  const scale = height / CACTUS_MODEL_MAX_Y;
  const parts = cactusModelPartsForQuarterTurn((hash >>> 28) & 3);
  let quads = 0;
  for (const part of parts) {
    quads += appendMicroCuboid(
      vertices,
      indices,
      cx + part.x * scale,
      y + 0.035 + part.y * scale,
      zc + part.z * scale,
      part.sx * scale,
      part.sy * scale,
      part.sz * scale,
      layer,
      part.shade,
      { skipBottom: true },
    );
  }
  return quads;
}

function appendVoxelCactus(vertices, indices, x, y, z, hash) {
  const layer = materialDef(blockDef(BLOCK_ID.cactus).materialId).textureLayer;
  const parts = cactusModelPartsForQuarterTurn((hash >>> 29) & 3);
  let quads = 0;
  for (const part of parts) {
    quads += appendMicroCuboid(
      vertices,
      indices,
      x + 0.5 + part.x,
      y + part.y,
      z + 0.5 + part.z,
      part.sx,
      part.sy,
      part.sz,
      layer,
      part.shade,
      { skipBottom: true, fullTileUv: true },
    );
  }
  return quads;
}

function appendCactusResourceModels(chunkState, vertices, indices) {
  let quads = 0;
  const blocks = visitCactusResourceCells(chunkState, (x, y, z) => {
    const hash = lowVegetationHash(BLOCK_ID.cactus, chunkState, x, y, z);
    quads += appendVoxelCactus(vertices, indices, x, y, z, hash);
  });
  return { blocks, quads };
}

function appendCactusResourceShadows(chunkState, vertices, indices) {
  let quads = 0;
  const blocks = visitCactusResourceCells(chunkState, (x, y, z) => {
    quads += appendProjectedShadowQuad(vertices, indices, x + 0.5, y + SHADOW_SURFACE_BIAS, z + 0.5, 0.38, 0.88 * CACTUS_MODEL_HEIGHT_SCALE, CACTUS_MODEL_MAX_Y, 0.34);
  });
  return { blocks, quads };
}

function visitCactusResourceCells(chunkState, visitor) {
  const seen = new Set();
  let count = 0;
  const visit = (x, y, z) => {
    if (x < 0 || z < 0 || x >= chunkState.chunkSize || z >= chunkState.chunkSize
      || y < chunkState.minY || y >= chunkState.minY + chunkState.height
      || chunkState.getFinalBlock(x, y, z) !== BLOCK_ID.cactus) return;
    const key = `${x}:${y}:${z}`;
    if (seen.has(key)) return;
    seen.add(key);
    count += 1;
    visitor(x, y, z);
  };

  if (chunkState.baseProfile) {
    for (let z = 0; z < chunkState.chunkSize; z += 1) {
      for (let x = 0; x < chunkState.chunkSize; x += 1) {
        const column = x + z * chunkState.chunkSize;
        visit(x, chunkState.baseProfile.surfaceY[column] + 1, z);
      }
    }
    for (const delta of finalDeltaMap(chunkState).values()) {
      visit(delta.localX, delta.localY, delta.localZ);
    }
  } else {
    for (let z = 0; z < chunkState.chunkSize; z += 1) {
      for (let y = chunkState.minY; y < chunkState.minY + chunkState.height; y += 1) {
        for (let x = 0; x < chunkState.chunkSize; x += 1) visit(x, y, z);
      }
    }
  }
  return count;
}

function appendVoxelBush(vertices, indices, cx, y0, zc, hash, blockId) {
  const leafLayer = materialDef(blockDef(blockId === BLOCK_ID.snowBush ? BLOCK_ID.snowBush : BLOCK_ID.bush).materialId).textureLayer;
  const woodLayer = materialDef(blockDef(BLOCK_ID.trunk).materialId).textureLayer;
  const snowLayer = materialDef(blockDef(BLOCK_ID.snow).materialId).textureLayer;
  const berryLayer = materialDef(MATERIAL_ID.flowerRed).textureLayer;
  const leanX = ((((hash >>> 6) & 7) - 3) / 110);
  const leanZ = ((((hash >>> 10) & 7) - 3) / 110);
  let quads = appendTaperedPrism(vertices, indices, cx, y0, zc, cx + leanX, y0 + 0.34, zc + leanZ, 0.105, 0.105, 0.060, 0.060, woodLayer, 194);
  quads += appendTaperedPrism(vertices, indices, cx, y0 + 0.13, zc, cx - 0.18, y0 + 0.31, zc + 0.08, 0.070, 0.070, 0.035, 0.035, woodLayer, 184);
  quads += appendTaperedPrism(vertices, indices, cx, y0 + 0.16, zc, cx + 0.17, y0 + 0.35, zc - 0.07, 0.065, 0.065, 0.032, 0.032, woodLayer, 202);
  for (let i = 0; i < BUSH_LOBES.length; i += 1) {
    const lobe = BUSH_LOBES[i];
    const jitterX = ((((hash >>> (i * 3 + 4)) & 3) - 1) / 120);
    const jitterZ = ((((hash >>> (i * 3 + 13)) & 3) - 1) / 120);
    quads += appendMicroCuboid(vertices, indices, cx + lobe.x + jitterX, y0 + lobe.y, zc + lobe.z + jitterZ, lobe.sx, lobe.sy, lobe.sz, leafLayer, lobe.shade, { skipBottom: true });
  }
  if (blockId === BLOCK_ID.snowBush) {
    quads += appendMicroCuboid(vertices, indices, cx + leanX, y0 + 0.565, zc + leanZ, 0.25, 0.060, 0.25, snowLayer, 250, { skipBottom: true });
    quads += appendMicroCuboid(vertices, indices, cx - 0.16, y0 + 0.425, zc + 0.07, 0.18, 0.050, 0.18, snowLayer, 246, { skipBottom: true });
  } else if ((hash >>> 24) & 1) {
    quads += appendMicroCuboid(vertices, indices, cx + 0.13, y0 + 0.39, zc + 0.13, 0.052, 0.052, 0.052, berryLayer, 248, { skipBottom: true });
  }
  return quads;
}

const BUSH_LOBES = [
  { x: 0.00, y: 0.42, z: 0.00, sx: 0.30, sy: 0.22, sz: 0.29, shade: 228 },
  { x: -0.18, y: 0.34, z: 0.07, sx: 0.23, sy: 0.19, sz: 0.22, shade: 214 },
  { x: 0.17, y: 0.36, z: -0.07, sx: 0.23, sy: 0.20, sz: 0.22, shade: 236 },
  { x: -0.06, y: 0.52, z: -0.11, sx: 0.21, sy: 0.16, sz: 0.20, shade: 242 },
  { x: 0.10, y: 0.48, z: 0.12, sx: 0.20, sy: 0.16, sz: 0.20, shade: 222 },
];

function appendDryShrub(vertices, indices, x, y, z, hash, blockId = BLOCK_ID.deadBush) {
  const layer = materialDef(blockDef(blockId).materialId).textureLayer;
  const cx = x + 0.5 + ((((hash >>> 8) & 31) - 15) / 150);
  const zc = z + 0.5 + ((((hash >>> 13) & 31) - 15) / 150);
  let quads = appendTaperedPrism(vertices, indices, cx, y + 0.025, zc, cx, y + 0.24, zc, 0.095, 0.095, 0.050, 0.050, layer, 194);
  const twigs = blockId === BLOCK_ID.thorn ? 4 : 3 + ((hash >>> 22) & 1);
  for (let i = 0; i < twigs; i += 1) {
    const profile = MICRO_GRASS_PROFILES[(i * 3 + ((hash >>> (i + 4)) & 7)) & 7];
    const h = 0.17 + ((hash >>> (i + 17)) & 7) / 7 * 0.14;
    const midX = cx + profile.dx * 0.10;
    const midZ = zc + profile.dz * 0.10;
    const tipX = cx + profile.dx * (0.20 + i * 0.012);
    const tipZ = zc + profile.dz * (0.20 + i * 0.012);
    const midY = y + 0.15 + h * 0.34;
    const tipY = y + 0.16 + h;
    quads += appendTaperedPrism(vertices, indices, cx, y + 0.10 + i * 0.018, zc, midX, midY, midZ, 0.060, 0.060, 0.042, 0.042, layer, 210 - i * 7);
    quads += appendTaperedPrism(vertices, indices, midX, midY, midZ, tipX, tipY, tipZ, 0.044, 0.044, 0.018, 0.018, layer, 218 - i * 5);
    if ((i & 1) === 0) {
      const forkX = midX - profile.dz * 0.10 + profile.dx * 0.035;
      const forkZ = midZ + profile.dx * 0.10 + profile.dz * 0.035;
      quads += appendTaperedPrism(vertices, indices, midX, midY, midZ, forkX, tipY - 0.045, forkZ, 0.038, 0.038, 0.014, 0.014, layer, 202 - i * 3);
    }
    if (blockId === BLOCK_ID.thorn) {
      quads += appendTaperedPrism(vertices, indices, midX, midY, midZ, midX + profile.dx * 0.075, midY + 0.055, midZ + profile.dz * 0.075, 0.034, 0.034, 0.010, 0.010, layer, 232);
    }
  }
  return quads;
}

function appendReedCluster(vertices, indices, cx, y0, zc, hash) {
  const layer = materialDef(blockDef(BLOCK_ID.reed).materialId).textureLayer;
  const headLayer = materialDef(blockDef(BLOCK_ID.deadBush).materialId).textureLayer;
  const capLayer = materialDef(blockDef(BLOCK_ID.dryGrass).materialId).textureLayer;
  const lean = ((((hash >>> 12) & 7) - 3) / 220);
  let quads = appendGrassTuft(vertices, indices, cx, y0, zc, 0.16, 0.28, layer, 218, hash, BLOCK_ID.reed, 5);
  for (let i = 0; i < ASSET_SHEET_REED_STALKS.length; i += 1) {
    const stalk = ASSET_SHEET_REED_STALKS[i];
    const h = stalk.h + (((hash >>> (i + 18)) & 3) * 0.018);
    const ox = stalk.x + ((((hash >>> (i * 4 + 5)) & 7) - 3) / 260);
    const oz = stalk.z + ((((hash >>> (i * 4 + 9)) & 7) - 3) / 260);
    const topX = cx + ox + lean * stalk.lean;
    const topZ = zc + oz - lean * stalk.lean;
    quads += appendTaperedPrism(vertices, indices, cx + ox, y0, zc + oz, topX, y0 + h, topZ, 0.060, 0.060, 0.040, 0.040, layer, 224 + i * 4);
    quads += appendTaperedPrism(vertices, indices, cx + ox, y0 + h * 0.30, zc + oz, cx + ox + stalk.leafX * 2.2, y0 + h * 0.60, zc + oz + stalk.leafZ * 2.2, 0.060, 0.060, 0.016, 0.016, layer, 214);
    quads += appendMicroCuboid(vertices, indices, topX, y0 + h + 0.125, topZ, 0.105, 0.250, 0.105, headLayer, 232);
    quads += appendTaperedPrism(vertices, indices, topX, y0 + h + 0.25, topZ, topX, y0 + h + 0.34, topZ, 0.052, 0.052, 0.018, 0.018, capLayer, 218);
  }
  return quads;
}

const ASSET_SHEET_REED_STALKS = [
  { x: -0.155, z: 0.030, h: 0.48, leafX: -0.055, leafZ: 0.000, lean: -1 },
  { x: 0.005, z: -0.030, h: 0.70, leafX: 0.000, leafZ: -0.060, lean: 0.4 },
  { x: 0.165, z: 0.045, h: 0.58, leafX: 0.055, leafZ: 0.000, lean: 1 },
];

function appendVineCluster(vertices, indices, cx, y0, zc, hash) {
  const layer = materialDef(blockDef(BLOCK_ID.vine).materialId).textureLayer;
  let quads = 0;
  const count = 2 + ((hash >>> 19) & 1);
  for (let i = 0; i < count; i += 1) {
    const profile = MICRO_GRASS_PROFILES[(i * 2 + ((hash >>> (i + 8)) & 7)) & 7];
    const h = 0.32 + ((hash >>> (i + 22)) & 7) / 7 * 0.28;
    const baseX = cx + profile.dx * 0.045;
    const baseZ = zc + profile.dz * 0.045;
    const midX = cx + profile.dx * 0.11 - profile.dz * 0.025;
    const midZ = zc + profile.dz * 0.11 + profile.dx * 0.025;
    const topX = cx + profile.dx * 0.19 + profile.dz * 0.030;
    const topZ = zc + profile.dz * 0.19 - profile.dx * 0.030;
    quads += appendTaperedPrism(vertices, indices, baseX, y0, baseZ, midX, y0 + h * 0.52, midZ, 0.060, 0.060, 0.045, 0.045, layer, 214 + i * 7);
    quads += appendTaperedPrism(vertices, indices, midX, y0 + h * 0.48, midZ, topX, y0 + h, topZ, 0.046, 0.046, 0.024, 0.024, layer, 226 + i * 4);
    quads += appendTaperedPrism(vertices, indices, midX, y0 + h * 0.42, midZ, midX - profile.dz * 0.13, y0 + h * 0.50, midZ + profile.dx * 0.13, 0.075, 0.060, 0.020, 0.014, layer, 238 - i * 3);
    quads += appendTaperedPrism(vertices, indices, topX, y0 + h * 0.72, topZ, topX + profile.dz * 0.11, y0 + h * 0.80, topZ - profile.dx * 0.11, 0.070, 0.055, 0.018, 0.014, layer, 232);
  }
  return quads;
}

function appendDryGrassResourceBundle(vertices, indices, hash) {
  const layer = materialDef(blockDef(BLOCK_ID.dryGrass).materialId).textureLayer;
  return appendGrassTuft(vertices, indices, 0.5, 0.03, 0.5, 0.20, 0.62, layer, 224, hash, BLOCK_ID.dryGrass, 5);
}

function appendMoltenResourceSample(vertices, indices, hash) {
  const lavaLayer = materialDef(blockDef(BLOCK_ID.lava).materialId).textureLayer;
  const crustLayer = materialDef(blockDef(BLOCK_ID.basalt).materialId).textureLayer;
  const skew = ((((hash >>> 9) & 15) - 7) / 180);
  let quads = appendMicroCuboid(vertices, indices, 0.50, 0.095, 0.50, 0.68, 0.16, 0.54, lavaLayer, 255, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, 0.46 + skew, 0.185, 0.48 - skew, 0.38, 0.12, 0.32, lavaLayer, 255, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, 0.25, 0.145, 0.31, 0.18, 0.18, 0.17, crustLayer, 188, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, 0.73, 0.135, 0.36, 0.16, 0.15, 0.20, crustLayer, 204, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, 0.66, 0.13, 0.70, 0.21, 0.14, 0.16, crustLayer, 176, { skipBottom: true });
  return quads;
}

function appendIceCrystalCluster(vertices, indices, hash) {
  const iceLayer = materialDef(blockDef(BLOCK_ID.ice).materialId).textureLayer;
  const snowLayer = materialDef(blockDef(BLOCK_ID.snow).materialId).textureLayer;
  const lean = ((((hash >>> 11) & 7) - 3) / 85);
  let quads = appendMicroCuboid(vertices, indices, 0.50, 0.065, 0.50, 0.58, 0.11, 0.48, snowLayer, 236, { skipBottom: true });
  quads += appendTaperedPrism(vertices, indices, 0.50, 0.08, 0.50, 0.47 + lean, 0.78, 0.48, 0.28, 0.26, 0.055, 0.050, iceLayer, 250);
  quads += appendTaperedPrism(vertices, indices, 0.35, 0.08, 0.49, 0.27, 0.49, 0.43, 0.20, 0.18, 0.040, 0.035, iceLayer, 232);
  quads += appendTaperedPrism(vertices, indices, 0.65, 0.08, 0.54, 0.74, 0.57, 0.62, 0.21, 0.18, 0.042, 0.035, iceLayer, 242);
  quads += appendTaperedPrism(vertices, indices, 0.52, 0.08, 0.34, 0.54 - lean, 0.40, 0.25, 0.17, 0.15, 0.034, 0.030, iceLayer, 224);
  return quads;
}

function appendToxicResourceSample(vertices, indices, hash) {
  const liquidLayer = materialDef(blockDef(BLOCK_ID.toxicWater).materialId).textureLayer;
  const rimLayer = materialDef(blockDef(BLOCK_ID.moss).materialId).textureLayer;
  const offset = ((((hash >>> 7) & 7) - 3) / 150);
  let quads = appendMicroCuboid(vertices, indices, 0.50, 0.07, 0.50, 0.64, 0.11, 0.52, liquidLayer, 255, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, 0.34 + offset, 0.18, 0.43, 0.13, 0.15, 0.13, liquidLayer, 255, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, 0.56, 0.23, 0.54 - offset, 0.16, 0.22, 0.16, liquidLayer, 255, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, 0.70 - offset, 0.15, 0.35, 0.10, 0.11, 0.10, liquidLayer, 248, { skipBottom: true });
  quads += appendGroundPatchDiamond(vertices, indices, 0.50, 0.018, 0.50, 0.78, 0.66, rimLayer, 178);
  return quads;
}

function appendCoralResourceCluster(vertices, indices, hash, dead) {
  const blockId = dead ? BLOCK_ID.deadCoral : BLOCK_ID.coral;
  const layer = materialDef(blockDef(blockId).materialId).textureLayer;
  const tipLayer = dead ? layer : materialDef(MATERIAL_ID.flowerYellow).textureLayer;
  const branches = dead ? CORAL_BRANCHES.slice(0, 4) : CORAL_BRANCHES;
  const turn = (hash >>> 29) & 3;
  let quads = appendTaperedPrism(vertices, indices, 0.50, 0.03, 0.50, 0.50, dead ? 0.45 : 0.58, 0.50, 0.22, 0.22, 0.09, 0.09, layer, dead ? 206 : 238);
  for (let index = 0; index < branches.length; index += 1) {
    const branch = quarterTurnXZ(branches[index], turn);
    const jitter = ((((hash >>> (index * 4 + 5)) & 7) - 3) / 150);
    const baseY = 0.17 + index * 0.035;
    const tipY = dead ? branch.y * 0.76 : branch.y;
    const endX = 0.5 + branch.x + jitter;
    const endZ = 0.5 + branch.z - jitter;
    quads += appendTaperedPrism(vertices, indices, 0.50, baseY, 0.50, endX, tipY, endZ, 0.13, 0.13, 0.045, 0.045, layer, (dead ? 194 : 226) + index * 4);
    if (!dead && index < 4) {
      quads += appendMicroCuboid(vertices, indices, endX, tipY + 0.025, endZ, 0.085, 0.070, 0.085, tipLayer, 248, { skipBottom: true });
    }
  }
  return quads;
}

const CORAL_BRANCHES = Object.freeze([
  Object.freeze({ x: -0.28, y: 0.48, z: 0.04 }),
  Object.freeze({ x: 0.27, y: 0.52, z: -0.08 }),
  Object.freeze({ x: -0.08, y: 0.66, z: -0.24 }),
  Object.freeze({ x: 0.13, y: 0.60, z: 0.25 }),
  Object.freeze({ x: 0.31, y: 0.43, z: 0.18 }),
]);

function appendDeadWoodResource(vertices, indices, hash) {
  const woodLayer = materialDef(blockDef(BLOCK_ID.deadWood).materialId).textureLayer;
  const exposedLayer = materialDef(blockDef(BLOCK_ID.dryDirt).materialId).textureLayer;
  const bend = ((((hash >>> 8) & 7) - 3) / 90);
  let quads = appendTaperedPrism(vertices, indices, 0.20, 0.11, 0.33, 0.77, 0.28, 0.62 + bend, 0.25, 0.23, 0.18, 0.17, woodLayer, 212, false);
  quads += appendTaperedPrism(vertices, indices, 0.48, 0.20, 0.49, 0.36, 0.48, 0.66, 0.14, 0.13, 0.045, 0.040, woodLayer, 198);
  quads += appendTaperedPrism(vertices, indices, 0.58, 0.23, 0.54, 0.72, 0.47, 0.38, 0.13, 0.12, 0.040, 0.036, woodLayer, 224);
  quads += appendMicroCuboid(vertices, indices, 0.78, 0.285, 0.63 + bend, 0.13, 0.055, 0.13, exposedLayer, 230, { skipBottom: true });
  return quads;
}

function appendGiantRootResource(vertices, indices, hash) {
  const rootLayer = materialDef(blockDef(BLOCK_ID.giantRoot).materialId).textureLayer;
  const turn = (hash >>> 29) & 3;
  let quads = appendMicroCuboid(vertices, indices, 0.50, 0.25, 0.50, 0.34, 0.44, 0.33, rootLayer, 218, { skipBottom: true });
  for (let index = 0; index < ROOT_BRANCHES.length; index += 1) {
    const root = quarterTurnXZ(ROOT_BRANCHES[index], turn);
    const endX = 0.5 + root.x;
    const endZ = 0.5 + root.z;
    quads += appendTaperedPrism(vertices, indices, 0.50, 0.16 + index * 0.012, 0.50, endX, 0.045, endZ, 0.24, 0.22, 0.055, 0.045, rootLayer, 222 - index * 6);
  }
  return quads;
}

const ROOT_BRANCHES = Object.freeze([
  Object.freeze({ x: -0.43, z: -0.08 }),
  Object.freeze({ x: 0.42, z: 0.02 }),
  Object.freeze({ x: -0.12, z: 0.43 }),
  Object.freeze({ x: 0.10, z: -0.42 }),
  Object.freeze({ x: 0.34, z: 0.31 }),
]);

function quarterTurnXZ(point, turns) {
  switch (turns & 3) {
    case 1: return { ...point, x: -point.z, z: point.x };
    case 2: return { ...point, x: -point.x, z: -point.z };
    case 3: return { ...point, x: point.z, z: -point.x };
    default: return point;
  }
}

function appendAquaticPlantCluster(vertices, indices, cx, y0, zc, hash, blockId) {
  const layer = materialDef(blockDef(blockId).materialId).textureLayer;
  let quads = 0;
  const count = blockId === BLOCK_ID.seaweed ? 3 : 2;
  for (let i = 0; i < count; i += 1) {
    const profile = MICRO_GRASS_PROFILES[(i * 3 + ((hash >>> (i + 6)) & 7)) & 7];
    const h = 0.28 + ((hash >>> (i + 18)) & 7) / 7 * 0.24;
    const sx = profile.axis === "x" ? 0.12 : 0.055;
    const sz = profile.axis === "z" ? 0.12 : 0.055;
    const bend = ((((hash >>> (i + 25)) & 7) - 3) / 130);
    const baseX = cx + profile.dx * 0.055;
    const baseZ = zc + profile.dz * 0.055;
    const midX = cx + profile.dx * 0.085 + bend * 0.35;
    const midZ = zc + profile.dz * 0.085 - bend * 0.35;
    const topX = cx + profile.dx * 0.11 + bend;
    const topZ = zc + profile.dz * 0.11 - bend;
    quads += appendTaperedPrism(vertices, indices, baseX, y0, baseZ, midX, y0 + h * 0.58, midZ, sx, sz, sx * 0.76, sz * 0.76, layer, 218 + i * 6);
    quads += appendTaperedPrism(vertices, indices, midX, y0 + h * 0.54, midZ, topX, y0 + h, topZ, sx * 0.78, sz * 0.78, sx * 0.22, sz * 0.22, layer, 234 + i * 4);
    if (blockId === BLOCK_ID.aquaticPlant) {
      quads += appendTaperedPrism(vertices, indices, midX, y0 + h * 0.38, midZ, midX - profile.dz * 0.12, y0 + h * 0.48, midZ + profile.dx * 0.12, sx * 0.70, sz * 0.70, 0.016, 0.016, layer, 230);
    }
  }
  return quads;
}

function appendMicroMushroom(vertices, indices, cx, y0, zc, hash, blockId = BLOCK_ID.mushroom) {
  const stemLayer = materialDef(MATERIAL_ID.flowerWhite).textureLayer;
  const gillLayer = materialDef(blockDef(BLOCK_ID.sand).materialId).textureLayer;
  const capLayer = materialDef(blockDef(blockId).materialId).textureLayer;
  const stemHeight = 0.14 + ((hash >>> 20) & 7) / 7 * 0.06;
  const capShade = blockId === BLOCK_ID.glowMycelium ? 255 : 240;
  let quads = appendMushroomBody(vertices, indices, cx, y0, zc, stemHeight, 1, stemLayer, gillLayer, capLayer, capShade);
  if (blockId === BLOCK_ID.glowMycelium) {
    quads += appendMushroomBody(vertices, indices, cx + 0.13, y0, zc - 0.10, stemHeight * 0.68, 0.66, stemLayer, gillLayer, capLayer, 248);
    quads += appendGroundPatchDiamond(vertices, indices, cx - 0.08, y0 + 0.010, zc + 0.06, 0.26, 0.20, capLayer, 232);
  }
  return quads;
}

function appendMushroomBody(vertices, indices, cx, y0, zc, stemHeight, scale, stemLayer, gillLayer, capLayer, capShade) {
  const stemTop = y0 + stemHeight;
  let quads = appendTaperedPrism(vertices, indices, cx, y0, zc, cx + 0.008 * scale, stemTop, zc - 0.006 * scale, 0.082 * scale, 0.082 * scale, 0.060 * scale, 0.060 * scale, stemLayer, 226);
  quads += appendMicroCuboid(vertices, indices, cx, stemTop + 0.020 * scale, zc, 0.225 * scale, 0.045 * scale, 0.215 * scale, gillLayer, 212);
  quads += appendMicroCuboid(vertices, indices, cx, stemTop + 0.060 * scale, zc, 0.275 * scale, 0.075 * scale, 0.255 * scale, capLayer, capShade, { skipBottom: true });
  quads += appendMicroCuboid(vertices, indices, cx - 0.012 * scale, stemTop + 0.115 * scale, zc + 0.006 * scale, 0.165 * scale, 0.070 * scale, 0.155 * scale, capLayer, capShade + 6, { skipBottom: true });
  return quads;
}

function appendMicroGroundPatch(vertices, indices, cx, y0, zc, radius, layer, shade, hash, blockId) {
  const pieces = blockId === BLOCK_ID.lichen ? 3 : 4;
  let quads = 0;
  for (let i = 0; i < pieces; i += 1) {
    const ox = ((((hash >>> (i * 4 + 5)) & 15) - 7) / 96);
    const oz = ((((hash >>> (i * 4 + 11)) & 15) - 7) / 96);
    const sx = Math.max(0.10, radius * (0.62 + i * 0.12));
    const sz = Math.max(0.10, radius * (0.48 + ((hash >>> (i + 17)) & 3) * 0.08));
    quads += appendGroundPatchDiamond(vertices, indices, cx + ox, y0 + i * 0.002, zc + oz, sx * 1.18, sz * 1.18, layer, shade - i * 5);
  }
  if (blockId === BLOCK_ID.moss) {
    quads += appendTaperedPrism(vertices, indices, cx - 0.06, y0, zc + 0.03, cx - 0.09, y0 + 0.105, zc + 0.04, 0.050, 0.050, 0.014, 0.014, layer, shade + 7);
    quads += appendTaperedPrism(vertices, indices, cx + 0.05, y0, zc - 0.04, cx + 0.08, y0 + 0.085, zc - 0.06, 0.046, 0.046, 0.012, 0.012, layer, shade + 3);
  }
  return quads;
}

function appendTaperedPrism(
  vertices,
  indices,
  baseX,
  baseY,
  baseZ,
  topX,
  topY,
  topZ,
  baseSizeX,
  baseSizeZ,
  topSizeX,
  topSizeZ,
  layer,
  shade,
  skipBottom = true,
) {
  const bx0 = baseX - baseSizeX * 0.5;
  const bx1 = baseX + baseSizeX * 0.5;
  const bz0 = baseZ - baseSizeZ * 0.5;
  const bz1 = baseZ + baseSizeZ * 0.5;
  const tx0 = topX - topSizeX * 0.5;
  const tx1 = topX + topSizeX * 0.5;
  const tz0 = topZ - topSizeZ * 0.5;
  const tz1 = topZ + topSizeZ * 0.5;
  const ao = Math.max(0, Math.min(255, shade));
  const faces = [
    { n: [127, 0, 0], p: [[bx1, baseY, bz1], [tx1, topY, tz1], [tx1, topY, tz0], [bx1, baseY, bz0]] },
    { n: [-127, 0, 0], p: [[bx0, baseY, bz0], [tx0, topY, tz0], [tx0, topY, tz1], [bx0, baseY, bz1]] },
    { n: [0, 0, 127], p: [[bx0, baseY, bz1], [tx0, topY, tz1], [tx1, topY, tz1], [bx1, baseY, bz1]] },
    { n: [0, 0, -127], p: [[bx1, baseY, bz0], [tx1, topY, tz0], [tx0, topY, tz0], [bx0, baseY, bz0]] },
    { n: [0, 127, 0], p: [[tx0, topY, tz1], [tx0, topY, tz0], [tx1, topY, tz0], [tx1, topY, tz1]] },
  ];
  if (!skipBottom) {
    faces.push({ n: [0, -127, 0], p: [[bx0, baseY, bz0], [bx0, baseY, bz1], [bx1, baseY, bz1], [bx1, baseY, bz0]] });
  }
  for (const face of faces) {
    const vertexOffset = vertices.length;
    vertices.push(
      { p: face.p[0], n: face.n, uv: [0, 0], layer, ao, flags: 2 },
      { p: face.p[1], n: face.n, uv: [0, 1], layer, ao, flags: 2 },
      { p: face.p[2], n: face.n, uv: [1, 1], layer, ao, flags: 2 },
      { p: face.p[3], n: face.n, uv: [1, 0], layer, ao, flags: 2 },
    );
    indices.push(vertexOffset, vertexOffset + 2, vertexOffset + 1, vertexOffset, vertexOffset + 3, vertexOffset + 2);
  }
  return faces.length;
}

function appendGroundPatchDiamond(vertices, indices, cx, y, cz, sx, sz, layer, shade) {
  const vertexOffset = vertices.length;
  const ao = Math.max(0, Math.min(255, shade));
  vertices.push(
    { p: [cx - sx * 0.5, y, cz], n: [0, 127, 0], uv: [0, 0.5], layer, ao, flags: 2 },
    { p: [cx, y, cz - sz * 0.5], n: [0, 127, 0], uv: [0.5, 0], layer, ao, flags: 2 },
    { p: [cx + sx * 0.5, y, cz], n: [0, 127, 0], uv: [1, 0.5], layer, ao, flags: 2 },
    { p: [cx, y, cz + sz * 0.5], n: [0, 127, 0], uv: [0.5, 1], layer, ao, flags: 2 },
  );
  indices.push(vertexOffset, vertexOffset + 2, vertexOffset + 1, vertexOffset, vertexOffset + 3, vertexOffset + 2);
  return 1;
}

function appendMicroCuboid(vertices, indices, cx, cy, cz, sx, sy, sz, layer, shade, options = {}) {
  const before = indices.length;
  appendBoxQuads(vertices, indices, cx, cy, cz, sx, sy, sz, layer, Math.max(0, Math.min(255, shade)), options, true);
  return (indices.length - before) / 6;
}

function isGroundDetailSurface(blockId) {
  switch (blockId) {
    case BLOCK_ID.grass:
    case BLOCK_ID.dirt:
    case BLOCK_ID.mud:
    case BLOCK_ID.clay:
    case BLOCK_ID.sand:
    case BLOCK_ID.dryDirt:
    case BLOCK_ID.ash:
    case BLOCK_ID.moss:
    case BLOCK_ID.snow:
    case BLOCK_ID.frozenSoil:
    case BLOCK_ID.stone:
    case BLOCK_ID.gravel:
    case BLOCK_ID.basalt:
    case BLOCK_ID.deepStone:
    case BLOCK_ID.saltFlat:
    case BLOCK_ID.quicksand:
    case BLOCK_ID.shellBed:
      return true;
    default:
      return false;
  }
}

function hasSurfaceDecorationRule(chunkState, blockId) {
  const compiled = chunkState.surfaceDecorationRules ?? EMPTY_COMPILED_SURFACE_DECORATION_RULES;
  return compiled.bySurface?.has(blockId) ?? false;
}

function detailHash(worldX, y, worldZ, surfaceBlockId) {
  let h = 0x9e3779b9;
  h = hashI32(h, worldX);
  h = hashI32(h, y);
  h = hashI32(h, worldZ);
  h = hashI32(h, surfaceBlockId * 2246822519);
  h ^= h >>> 16;
  h = Math.imul(h >>> 0, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h >>> 0, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function appendTreeInstanceProxyQuads(
  chunkState,
  vertices,
  indices,
  { getDeltaAtWorld = null, treeDeltaCandidateCount = 0 } = {},
) {
  if (!chunkState.treeInstances?.length) return 0;
  let quads = 0;
  const leafFaceGroups = new Map();
  for (const tree of chunkState.treeInstances) {
    if (treeInstanceModifiedByDelta(chunkState, tree)) continue;
    const x = worldI32ToChunkAffineLocal(chunkState.chunkX, tree.x, chunkState.chunkSize) + 0.5;
    const z = worldI32ToChunkAffineLocal(chunkState.chunkZ, tree.z, chunkState.chunkSize) + 0.5;
    const trunkLayer = materialDef(blockDef(tree.pine ? BLOCK_ID.pineTrunk : BLOCK_ID.trunk).materialId).textureLayer;
    const leafLayer = materialDef(blockDef(tree.pine ? BLOCK_ID.pineLeaves : BLOCK_ID.leaves).materialId).textureLayer;
    const snowLayer = materialDef(MATERIAL_ID.snow).textureLayer;
    appendBoxQuads(vertices, indices, x, tree.baseY + tree.trunkHeight * 0.5, z, 0.48, tree.trunkHeight, 0.48, trunkLayer, 218, { skipBottom: true });
    quads += 5;
    appendCanonicalTreeLeafFaces(
      chunkState,
      tree,
      leafFaceGroups,
      leafLayer,
      snowLayer,
      getDeltaAtWorld,
      treeDeltaCandidateCount,
    );
  }
  for (const group of leafFaceGroups.values()) quads += appendTreeGreedyGroup(group, vertices, indices);
  return quads;
}

function appendCanonicalTreeLeafFaces(
  chunkState,
  tree,
  faceGroups,
  leafLayer,
  snowLayer,
  getDeltaAtWorld,
  treeDeltaCandidateCount,
) {
  const profile = treeLeafProfileForMesh(chunkState, tree);
  const masks = visibleTreeLeafMasks(chunkState, tree, profile, getDeltaAtWorld, treeDeltaCandidateCount);
  const cells = uniqueTreeLeafWorldCells(tree, profile, masks);
  const occupied = new Set(cells.map(({ worldX, y, worldZ }) => treeWorldCellKey(worldX, y, worldZ)));
  for (const { worldX, y, worldZ } of cells) {
    const localX = worldI32ToChunkAffineLocal(chunkState.chunkX, worldX, chunkState.chunkSize);
    const localZ = worldI32ToChunkAffineLocal(chunkState.chunkZ, worldZ, chunkState.chunkSize);
    for (let faceIndex = 0; faceIndex < FACE_DEFS.length; faceIndex += 1) {
      const face = FACE_DEFS[faceIndex];
      const neighborX = saturatingAddI32(worldX, face.delta[0]);
      const neighborZ = saturatingAddI32(worldZ, face.delta[2]);
      if (occupied.has(treeWorldCellKey(neighborX, y + face.delta[1], neighborZ))) continue;
      const snowTop = Boolean(tree.snowy && faceIndex === 2);
      addTreeFaceCell(faceGroups, faceIndex, localX, y, localZ, snowTop ? snowLayer : leafLayer, snowTop ? 250 : face.shade);
    }
  }
}

function uniqueTreeLeafWorldCells(tree, profile, masks) {
  const cells = [];
  const visited = new Set();
  for (let layerIndex = 0; layerIndex < masks.length; layerIndex += 1) {
    const y = profile.minY + layerIndex;
    const mask = masks[layerIndex] >>> 0;
    if (!mask) continue;
    for (let bit = 0; bit < 25; bit += 1) {
      if (!(mask & (1 << bit))) continue;
      const worldX = saturatingAddI32(tree.x, bit % 5 - 2);
      const worldZ = saturatingAddI32(tree.z, Math.floor(bit / 5) - 2);
      const key = treeWorldCellKey(worldX, y, worldZ);
      if (visited.has(key)) continue;
      visited.add(key);
      cells.push({ worldX, y, worldZ });
    }
  }
  return cells;
}

function treeWorldCellKey(worldX, worldY, worldZ) {
  return `${worldX}:${worldY}:${worldZ}`;
}

function treeLeafProfileForMesh(chunkState, tree) {
  if (Number.isFinite(tree.leafMinY) && Array.isArray(tree.leafMasks)) {
    return { minY: Math.trunc(tree.leafMinY), masks: tree.leafMasks };
  }
  const profile = treeInstanceLeafProfile(chunkState.worldSeed, tree);
  tree.leafMinY = profile.minY;
  tree.leafMasks = profile.masks;
  return profile;
}

function visibleTreeLeafMasks(chunkState, tree, profile, getDeltaAtWorld, treeDeltaCandidateCount) {
  const ownDeltaCount = chunkState.getFinalDeltaMap?.().size ?? 0;
  if (!ownDeltaCount && !treeDeltaCandidateCount) return profile.masks;
  const masks = profile.masks.slice();
  const leafBlockId = tree.pine ? BLOCK_ID.pineLeaves : BLOCK_ID.leaves;
  for (let layerIndex = 0; layerIndex < masks.length; layerIndex += 1) {
    let mask = masks[layerIndex] >>> 0;
    if (!mask) continue;
    const y = profile.minY + layerIndex;
    for (let bit = 0; bit < 25; bit += 1) {
      if (!(mask & (1 << bit))) continue;
      const worldX = saturatingAddI32(tree.x, bit % 5 - 2);
      const worldZ = saturatingAddI32(tree.z, Math.floor(bit / 5) - 2);
      const deltaBlock = explicitTreeDeltaBlockAt(chunkState, worldX, y, worldZ, getDeltaAtWorld);
      if (deltaBlock === null || deltaBlock === leafBlockId) continue;
      mask = (mask & ~(1 << bit)) >>> 0;
    }
    masks[layerIndex] = mask;
  }
  return masks;
}

function addTreeFaceCell(groups, faceIndex, x, y, z, layer, shade) {
  const face = FACE_DEFS[faceIndex];
  const cell = greedyCell(faceIndex, x, y, z);
  const groupKey = `${faceIndex}:${cell.plane}:${layer}:${shade}`;
  let group = groups.get(groupKey);
  if (!group) {
    group = {
      faceIndex,
      face,
      plane: cell.plane,
      layer,
      ao: shade,
      cellsByV: new Map(),
      minU: cell.u,
      maxU: cell.u,
      minV: cell.v,
      maxV: cell.v,
    };
    groups.set(groupKey, group);
  }
  let row = group.cellsByV.get(cell.v);
  if (!row) {
    row = new Set();
    group.cellsByV.set(cell.v, row);
  }
  row.add(cell.u);
  group.minU = Math.min(group.minU, cell.u);
  group.maxU = Math.max(group.maxU, cell.u);
  group.minV = Math.min(group.minV, cell.v);
  group.maxV = Math.max(group.maxV, cell.v);
}

function appendTreeGreedyGroup(group, vertices, indices) {
  const visited = new Map();
  let quads = 0;
  for (let v = group.minV; v <= group.maxV; v += 1) {
    for (let u = group.minU; u <= group.maxU; u += 1) {
      if (treeFaceCellVisited(visited, u, v) || !group.cellsByV.get(v)?.has(u)) continue;
      let width = 1;
      while (group.cellsByV.get(v)?.has(u + width) && !treeFaceCellVisited(visited, u + width, v)) width += 1;
      let height = 1;
      grow: while (v + height <= group.maxV) {
        for (let offset = 0; offset < width; offset += 1) {
          if (!group.cellsByV.get(v + height)?.has(u + offset) || treeFaceCellVisited(visited, u + offset, v + height)) break grow;
        }
        height += 1;
      }
      for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
        let row = visited.get(v + rowOffset);
        if (!row) {
          row = new Set();
          visited.set(v + rowOffset, row);
        }
        for (let columnOffset = 0; columnOffset < width; columnOffset += 1) row.add(u + columnOffset);
      }
      appendQuad(group, u, v, width, height, vertices, indices);
      quads += 1;
    }
  }
  return quads;
}

function treeFaceCellVisited(visited, u, v) {
  return Boolean(visited.get(v)?.has(u));
}

function explicitTreeDeltaBlockAt(chunkState, worldX, worldY, worldZ, getDeltaAtWorld) {
  const localX = worldI32ToChunkAffineLocal(chunkState.chunkX, worldX, chunkState.chunkSize);
  const localZ = worldI32ToChunkAffineLocal(chunkState.chunkZ, worldZ, chunkState.chunkSize);
  if (
    localX >= 0 && localX < chunkState.chunkSize &&
    localZ >= 0 && localZ < chunkState.chunkSize &&
    chunkState.hasDeltaAt?.(localX, worldY, localZ)
  ) {
    return chunkState.getFinalBlock(localX, worldY, localZ);
  }
  const blockId = getDeltaAtWorld?.(worldX, worldY, worldZ);
  return Number.isFinite(blockId) ? Math.trunc(blockId) : null;
}

function treeInstanceModifiedByDelta(chunkState, tree) {
  if (!chunkState || !tree) return false;
  if (typeof chunkState.hasDeltaAt !== "function") return false;
  const localX = worldI32ToChunkAffineLocal(chunkState.chunkX, tree.x, chunkState.chunkSize);
  const localZ = worldI32ToChunkAffineLocal(chunkState.chunkZ, tree.z, chunkState.chunkSize);
  if (localX < 0 || localZ < 0 || localX >= chunkState.chunkSize || localZ >= chunkState.chunkSize) return false;
  const baseY = Math.trunc(tree.baseY);
  const trunkHeight = Math.max(1, Math.trunc(Number(tree.trunkHeight) || 1));
  for (let y = baseY; y < baseY + trunkHeight; y += 1) {
    if (chunkState.hasDeltaAt(localX, y, localZ)) return true;
  }
  return false;
}

function worldI32ToChunkAffineLocal(chunkCoordinate, worldCoordinate, chunkSize) {
  // Geometry is rendered relative to the exact affine chunk origin used by
  // WebGL and frustum bounds. At a non-divisor i32 endpoint several generated
  // local columns may saturate to the same world coordinate; this inverse
  // selects the sole in-domain affine cell and prevents tree/leaf aliases from
  // being emitted in the out-of-domain fringe.
  return Math.trunc(worldCoordinate) - Math.trunc(chunkCoordinate) * Math.trunc(chunkSize);
}

function appendProjectedShadowQuad(vertices, indices, cx, y, cz, radius, length, casterHeight = 0.3, alpha = 0.24) {
  const layer = materialDef(MATERIAL_ID.shadow).textureLayer;
  const dirX = PROJECTED_SHADOW_DIR_XZ[0];
  const dirZ = PROJECTED_SHADOW_DIR_XZ[1];
  const rightX = -dirZ;
  const rightZ = dirX;
  const stretch = 0.18 + Math.max(0, casterHeight) * 0.16;
  const halfW = Math.max(0.08, radius);
  const halfL = Math.max(0.12, length + stretch);
  const offset = Math.min(2.6, Math.max(0.06, halfL * 0.42));
  const centerX = cx + dirX * offset;
  const centerZ = cz + dirZ * offset;
  const shade = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  const p0 = [centerX - rightX * halfW + dirX * halfL, y, centerZ - rightZ * halfW + dirZ * halfL];
  const p1 = [centerX + rightX * halfW + dirX * halfL, y, centerZ + rightZ * halfW + dirZ * halfL];
  const p2 = [centerX + rightX * halfW - dirX * halfL, y, centerZ + rightZ * halfW - dirZ * halfL];
  const p3 = [centerX - rightX * halfW - dirX * halfL, y, centerZ - rightZ * halfW - dirZ * halfL];
  const vertexOffset = vertices.length;
  vertices.push(
    { p: p0, n: [0, 127, 0], uv: [0, 1], layer, ao: shade, flags: VERTEX_FLAG_SHADOW_UV },
    { p: p1, n: [0, 127, 0], uv: [1, 1], layer, ao: shade, flags: VERTEX_FLAG_SHADOW_UV },
    { p: p2, n: [0, 127, 0], uv: [1, 0], layer, ao: shade, flags: VERTEX_FLAG_SHADOW_UV },
    { p: p3, n: [0, 127, 0], uv: [0, 0], layer, ao: shade, flags: VERTEX_FLAG_SHADOW_UV },
  );
  indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset, vertexOffset + 2, vertexOffset + 3);
  indices.push(vertexOffset, vertexOffset + 2, vertexOffset + 1, vertexOffset, vertexOffset + 3, vertexOffset + 2);
  return 2;
}

function appendBoxQuads(vertices, indices, cx, cy, cz, sx, sy, sz, layer, shade, options = {}, defaultFullTileUv = false) {
  const x0 = cx - sx * 0.5;
  const x1 = cx + sx * 0.5;
  const y0 = cy - sy * 0.5;
  const y1 = cy + sy * 0.5;
  const z0 = cz - sz * 0.5;
  const z1 = cz + sz * 0.5;
  const fullTileUv = options.fullTileUv ?? defaultFullTileUv;
  const uvX = fullTileUv ? 1 : sx;
  const uvY = fullTileUv ? 1 : sy;
  const uvZ = fullTileUv ? 1 : sz;
  const faces = [
    { n: [127, 0, 0], p: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]], uv: [[0, 0], [0, uvY], [uvZ, uvY], [uvZ, 0]] },
    { n: [-127, 0, 0], p: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], uv: [[0, 0], [0, uvY], [uvZ, uvY], [uvZ, 0]] },
    { n: [0, 127, 0], p: [[x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1]], uv: [[0, 0], [0, uvZ], [uvX, uvZ], [uvX, 0]] },
    { n: [0, -127, 0], p: [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]], uv: [[0, 0], [0, uvZ], [uvX, uvZ], [uvX, 0]] },
    { n: [0, 0, 127], p: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]], uv: [[0, 0], [0, uvY], [uvX, uvY], [uvX, 0]] },
    { n: [0, 0, -127], p: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]], uv: [[0, 0], [0, uvY], [uvX, uvY], [uvX, 0]] },
  ];
  for (const face of faces) {
    if (options.skipBottom && face.n[1] < 0) continue;
    const vertexOffset = vertices.length;
    for (let i = 0; i < 4; i += 1) vertices.push({ p: face.p[i], n: face.n, uv: face.uv[i], layer, ao: shade, flags: 2 });
    indices.push(vertexOffset, vertexOffset + 2, vertexOffset + 1, vertexOffset, vertexOffset + 3, vertexOffset + 2);
  }
}

function quadCorners(faceIndex, plane, u, v, width, height) {
  if (faceIndex === 0) return [[plane, v, u], [plane, v + height, u], [plane, v + height, u + width], [plane, v, u + width]];
  if (faceIndex === 1) return [[plane, v, u + width], [plane, v + height, u + width], [plane, v + height, u], [plane, v, u]];
  if (faceIndex === 2) return [[u, plane, v + height], [u + width, plane, v + height], [u + width, plane, v], [u, plane, v]];
  if (faceIndex === 3) return [[u, plane, v], [u + width, plane, v], [u + width, plane, v + height], [u, plane, v + height]];
  if (faceIndex === 4) return [[u + width, v, plane], [u + width, v + height, plane], [u, v + height, plane], [u, v, plane]];
  return [[u, v, plane], [u, v + height, plane], [u + width, v + height, plane], [u + width, v, plane]];
}

function quadUvs(faceIndex, corners) {
  return corners.map((corner) => {
    if (faceIndex === 2 || faceIndex === 3) return [corner[0], corner[2]];
    if (faceIndex === 0 || faceIndex === 1) return [corner[2], corner[1]];
    return [corner[0], corner[1]];
  });
}

function packVertices(vertices) {
  const out = new Uint8Array(vertices.length * CHUNK_VERTEX_STRIDE_BYTES);
  const view = new DataView(out.buffer);
  for (let i = 0; i < vertices.length; i += 1) {
    const vertex = vertices[i];
    const offset = i * CHUNK_VERTEX_STRIDE_BYTES;
    view.setInt16(offset, Math.round(vertex.p[0] * POSITION_PACK_SCALE), true);
    view.setInt16(offset + 2, Math.round(vertex.p[1] * POSITION_PACK_SCALE), true);
    view.setInt16(offset + 4, Math.round(vertex.p[2] * POSITION_PACK_SCALE), true);
    view.setInt16(offset + 6, POSITION_PACK_SCALE, true);
    view.setInt8(offset + 8, vertex.n[0]);
    view.setInt8(offset + 9, vertex.n[1]);
    view.setInt8(offset + 10, vertex.n[2]);
    view.setUint8(offset + 11, vertex.ao);
    view.setUint16(offset + 12, positiveUint16(vertex.uv[0]), true);
    view.setUint16(offset + 14, positiveUint16(vertex.uv[1]), true);
    view.setUint16(offset + 16, vertex.layer, true);
    view.setUint16(offset + 18, vertex.flags, true);
  }
  return out;
}

function hasCell(group, u, v) {
  if (u < 0 || u > 30) return false;
  return Boolean((group.cellsByV.get(v) ?? 0) & (1 << u));
}

function isVisited(visited, u, v) {
  if (u < 0 || u > 30) return false;
  return Boolean((visited.get(v) ?? 0) & (1 << u));
}

function positiveUint16(value) {
  return Math.trunc(value) & 0xffff;
}

function quantizedShade(value) {
  return Math.max(0, Math.min(255, Math.round(value / 12) * 12));
}

function smooth01(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function projectedShadowDirection(sunDirection) {
  const x = -(Number(sunDirection?.[0]) || 0);
  const z = -(Number(sunDirection?.[2]) || 0);
  const length = Math.hypot(x, z) || 1;
  return [x / length, z / length];
}

function visualFaceOccluded(blockId, neighbor) {
  if (neighbor === BLOCK_ID.air) return false;
  if (isFluidBlock(blockId)) return isFluidBlock(neighbor) || isGreedyOpaqueBlock(neighbor);
  return isGreedyOpaqueBlock(neighbor) || neighbor === blockId;
}
