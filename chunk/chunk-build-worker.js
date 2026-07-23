import {
  chunkLocalToWorldI32,
  createWorldGeneratorConfig,
  generateBaseChunkProfileFromConfig,
  generateTreeInstancesForChunkFromConfig,
  getBaseBlockAtColumnConfig,
  surfaceBlockAt,
  terrainSurfaceHeight,
  waterLevelAt,
} from "../world/world-generator.js";
import { ChunkState } from "./chunk-state.js";
import { meshChunkOpaqueFast, meshChunkVisual } from "./chunk-mesher.js";
import { compileSurfaceDecorationRules } from "../world/surface-decoration-rules.js";
import { BLOCK_ID, isOpaqueSolidBlock } from "../world/block-registry.js";

let surfaceDecorationRules = compileSurfaceDecorationRules([]);
let surfaceDecorationRulesRevision = 0;
let generatorConfig = null;
let generatorConfigKey = "";
let generatedColumnCache = new Map();
const GENERATED_COLUMN_CACHE_LIMIT = 32768;

self.onmessage = (event) => {
  const task = event.data;
  if (task?.type === "setSurfaceDecorationRules") {
    surfaceDecorationRules = compileSurfaceDecorationRules(task.rules);
    surfaceDecorationRulesRevision = surfaceDecorationRules.rules.length
      ? Math.max(1, Math.trunc(Number(task.revision) || 1))
      : Math.max(0, Math.trunc(Number(task.revision) || 0));
    return;
  }
  if (!task || task.type !== "buildChunk") return;
  const startedAt = performance.now();
  try {
    const options = task.options || {};
    const config = configForTask(task, options);
    const baseStartedAt = performance.now();
    const baseProfile = generateBaseChunkProfileFromConfig(config, task.chunkX, task.chunkZ, { cacheTreeCandidates: true });
    const baseMs = performance.now() - baseStartedAt;
    const treeStartedAt = performance.now();
    const treeInstances = generateTreeInstancesForChunkFromConfig(config, task.chunkX, task.chunkZ, baseProfile);
    const treeMs = performance.now() - treeStartedAt;
    const chunk = new ChunkState({
      chunkX: task.chunkX,
      chunkZ: task.chunkZ,
      chunkSize: options.chunkSize,
      height: options.height,
      minY: options.minY,
      maxBuildY: options.maxBuildY,
      generationVersion: task.generationVersion,
      resourceRuleVersion: task.resourceRuleVersion,
      materialVersion: task.materialVersion,
      worldSeed: config.worldSeed,
      surfaceDecorationRules,
      baseProfile,
      baseBlockResolver: localProfileBlockResolver(config, task, options, baseProfile),
      treeInstances,
    });
    applyPackedChainDeltas(chunk, task.finalDeltas);
    const deltaOverrides = new Map();
    const deltaColumns = new Map();
    appendPackedDeltaOverrides(deltaOverrides, task.finalDeltas, deltaColumns);
    appendPackedDeltaOverrides(deltaOverrides, task.neighborDeltas, deltaColumns);
    const treeDeltaOverrides = new Map();
    appendPackedDeltaOverrides(treeDeltaOverrides, task.finalDeltas);
    appendPackedDeltaOverrides(treeDeltaOverrides, task.treeDeltas);
    const access = {
      getBlockAtWorld: (x, y, z) => deltaOverrides.get(`${x}:${y}:${z}`) ?? generatedBlockAt(config, x, y, z),
      getDeltaAtWorld: (x, y, z) => treeDeltaOverrides.get(`${x}:${y}:${z}`) ?? null,
      getColumnTopAtWorld: (x, z) => deltaAwareGeneratedColumnTop(config, x, z, deltaOverrides, deltaColumns, options),
      getWaterLevelAtWorld: (x, z) => generatedColumnAt(config, x, z).water,
      treeDeltaCandidateCount: treeDeltaOverrides.size,
    };
    const opaqueStartedAt = performance.now();
    const mesh = meshChunkOpaqueFast(chunk, access);
    const opaqueMeshMs = performance.now() - opaqueStartedAt;
    let visualMesh = null;
    let visualMeshMs = 0;
    let visualError = null;
    try {
      const visualStartedAt = performance.now();
      visualMesh = meshChunkVisual(chunk, access);
      visualMeshMs = performance.now() - visualStartedAt;
    } catch (error) {
      visualError = error?.message || String(error);
    }
    const elapsedMs = performance.now() - startedAt;
    const message = {
      type: "chunkBuilt",
      taskId: task.taskId,
      chunkX: task.chunkX,
      chunkZ: task.chunkZ,
      generationVersion: task.generationVersion,
      resourceRuleVersion: task.resourceRuleVersion,
      materialVersion: task.materialVersion,
      taskVersion: task.taskVersion,
      mode: task.mode || "base",
      baseProfile: task.mode === "remesh" ? null : baseProfile,
      treeInstances: task.mode === "remesh" ? null : treeInstances,
      mesh,
      visualMesh,
      visualError,
      visualPending: false,
      elapsedMs,
      timings: {
        baseMs,
        treeMs,
        opaqueMeshMs,
        visualMeshMs,
        elapsedMs,
        surfaceDecorationRulesRevision,
      },
    };
    self.postMessage(message, transferablesForBuild(message));
  } catch (error) {
    self.postMessage({
      type: "chunkBuildError",
      taskId: task.taskId,
      chunkX: task.chunkX,
      chunkZ: task.chunkZ,
      error: error?.message || String(error),
    });
  }
};

function applyPackedChainDeltas(chunk, packed) {
  if (!packed?.length) return;
  if (!(packed instanceof Int32Array)) {
    chunk.applyChainDelta(packed, { protectUntilSnapshot: false });
    return;
  }
  const deltas = new Array(Math.floor(packed.length / 4));
  for (let offset = 0, index = 0; offset + 3 < packed.length; offset += 4, index += 1) {
    deltas[index] = {
      worldX: packed[offset],
      worldY: packed[offset + 1],
      worldZ: packed[offset + 2],
      blockId: packed[offset + 3],
    };
  }
  chunk.applyChainDelta(deltas, { protectUntilSnapshot: false });
}

function appendPackedDeltaOverrides(target, packed, columns = null) {
  if (!packed?.length) return;
  if (!(packed instanceof Int32Array)) {
    for (const delta of packed) appendDeltaOverride(target, columns, delta.worldX, delta.worldY, delta.worldZ, delta.blockId);
    return;
  }
  for (let offset = 0; offset + 3 < packed.length; offset += 4) {
    appendDeltaOverride(target, columns, packed[offset], packed[offset + 1], packed[offset + 2], packed[offset + 3]);
  }
}

function appendDeltaOverride(target, columns, worldX, worldY, worldZ, blockId) {
  const x = Math.trunc(worldX);
  const y = Math.trunc(worldY);
  const z = Math.trunc(worldZ);
  const id = Math.trunc(blockId);
  target.set(`${x}:${y}:${z}`, id);
  if (!columns) return;
  const key = `${x}:${z}`;
  let values = columns.get(key);
  if (!values) {
    values = [];
    columns.set(key, values);
  }
  values.push({ y, blockId: id });
}

function deltaAwareGeneratedColumnTop(config, worldX, worldZ, deltaOverrides, deltaColumns, options) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  const columnDeltas = deltaColumns.get(`${x}:${z}`);
  const generatedTop = generatedColumnAt(config, x, z).surface;
  if (!columnDeltas?.length) return generatedTop;

  let candidateY = generatedTop;
  for (const delta of columnDeltas) {
    if (isTerrainMeshBlock(delta.blockId)) candidateY = Math.max(candidateY, delta.y);
  }
  const minY = Math.trunc(options.minY);
  const maxY = Math.trunc(options.maxBuildY ?? (minY + Math.trunc(options.height) - 1));
  for (let y = Math.min(maxY, candidateY); y >= minY; y -= 1) {
    const blockId = deltaOverrides.get(`${x}:${y}:${z}`) ?? generatedBlockAt(config, x, y, z);
    if (isTerrainMeshBlock(blockId)) return y;
  }
  return minY - 1;
}

function isTerrainMeshBlock(blockId) {
  return blockId !== BLOCK_ID.cactus && isOpaqueSolidBlock(blockId);
}

function transferablesForBuild(message) {
  const transfer = [message.mesh.vertices.buffer, message.mesh.indices.buffer];
  if (message.visualMesh) transfer.push(message.visualMesh.vertices.buffer, message.visualMesh.indices.buffer);
  const profile = message.baseProfile;
  if (profile) {
    for (const field of ["surfaceY", "waterY", "surfaceBlock"]) {
      if (profile[field]?.buffer) transfer.push(profile[field].buffer);
    }
  }
  return transfer;
}

function configForTask(task, options) {
  const key = [
    task.worldSeed,
    task.generationVersion,
    task.resourceRuleVersion,
    options.chunkSize,
    options.height,
    options.minY,
    options.maxBuildY,
    options.seaLevel,
    options.maxTerrainHeight,
  ].join(":");
  if (generatorConfig && key === generatorConfigKey) return generatorConfig;
  generatorConfigKey = key;
  generatorConfig = createWorldGeneratorConfig({
    ...options,
    worldSeed: task.worldSeed,
    generationVersion: task.generationVersion,
    resourceRuleVersion: task.resourceRuleVersion,
  });
  generatedColumnCache = new Map();
  return generatorConfig;
}

function generatedColumnAt(config, worldX, worldZ) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  const key = `${x},${z}`;
  const cached = generatedColumnCache.get(key);
  if (cached) return cached;
  const surface = terrainSurfaceHeight(config, x, z);
  const column = { surface, water: waterLevelAt(config, x, z, surface), surfaceBlock: undefined };
  if (generatedColumnCache.size >= GENERATED_COLUMN_CACHE_LIMIT) {
    const oldest = generatedColumnCache.keys().next().value;
    generatedColumnCache.delete(oldest);
  }
  generatedColumnCache.set(key, column);
  return column;
}

function generatedBlockAt(config, worldX, worldY, worldZ) {
  const column = generatedColumnAt(config, worldX, worldZ);
  if (column.surfaceBlock === undefined) column.surfaceBlock = surfaceBlockAt(config, Math.trunc(worldX), Math.trunc(worldZ), column.surface);
  return getBaseBlockAtColumnConfig(config, worldX, worldY, worldZ, column.surface, column.water, column.surfaceBlock);
}

function localProfileBlockResolver(config, task, options, profile) {
  return (localX, localY, localZ) => {
    const x = Math.trunc(localX);
    const z = Math.trunc(localZ);
    const worldX = chunkLocalToWorldI32(task.chunkX, x, options.chunkSize);
    const worldZ = chunkLocalToWorldI32(task.chunkZ, z, options.chunkSize);
    const columnIndex = x + z * options.chunkSize;
    const surface = profile.surfaceY[columnIndex];
    const storedWater = profile.waterY[columnIndex];
    const water = storedWater === profile.noWater ? null : storedWater;
    return getBaseBlockAtColumnConfig(config, worldX, localY, worldZ, surface, water, profile.surfaceBlock?.[columnIndex]);
  };
}
