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
import { ensureRenderSections,buildRenderSection } from "./render-sections.js";
import { meshChunkOpaqueFast, meshChunkVisual } from "./chunk-mesher.js";
import { compileSurfaceDecorationRules } from "../world/surface-decoration-rules.js";
import { BLOCK_ID, isOpaqueSolidBlock, blockFlags } from "../world/block-registry.js";
import { BLOCK_FLAGS } from "../core/constants.js";

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
    const baseProfile = task.baseProfile || generateBaseChunkProfileFromConfig(config, task.chunkX, task.chunkZ, { cacheTreeCandidates: true });
    const baseMs = performance.now() - baseStartedAt;
    const treeStartedAt = performance.now();
    const treeInstances = task.treeInstances || generateTreeInstancesForChunkFromConfig(config, task.chunkX, task.chunkZ, baseProfile);
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
      shadows: options.shadows,
    });
    chunk.pickedSurfaceColumns = task.pickedSurfaceColumns || [];
    applyPackedChainDeltas(chunk, task.finalDeltas);
    const deltaOverrides = new Map();
    const deltaColumns = new Map();
    appendPackedDeltaOverrides(deltaOverrides, task.finalDeltas, deltaColumns);
    appendPackedDeltaOverrides(deltaOverrides, task.neighborDeltas, deltaColumns);
    appendPackedDeltaOverrides(deltaOverrides, task.lightingDeltas, deltaColumns);
    const treeDeltaOverrides = new Map();
    appendPackedDeltaOverrides(treeDeltaOverrides, task.finalDeltas);
    appendPackedDeltaOverrides(treeDeltaOverrides, task.treeDeltas);
    const access = {
      generatedTerrain: true,
      generatedSurfaceAtWorld: (x,z) => generatedColumnAt(config,x,z).surface,
      noLocalLightSources: config.generationVersion===5
        && !baseProfile.surfaceBlock?.some(id => blockFlags(id) & BLOCK_FLAGS.EMISSIVE)
        && !Array.from(deltaOverrides.values()).some(id => blockFlags(id) & BLOCK_FLAGS.EMISSIVE),
      getBlockAtWorld: (x, y, z) => deltaOverrides.get(`${x}:${y}:${z}`) ?? generatedBlockAt(config, x, y, z),
      getDeltaAtWorld: (x, y, z) => treeDeltaOverrides.get(`${x}:${y}:${z}`) ?? null,
      getColumnTopAtWorld: (x,z) => capturedColumnTop(task.columnTopHalo,x,z) ?? deltaAwareGeneratedColumnTop(config,x,z,deltaOverrides,deltaColumns,options),
      getWaterLevelAtWorld: (x, z) => generatedColumnAt(config, x, z).water,
      treeDeltaCandidateCount: treeDeltaOverrides.size,
      neighborDeltas: unpackPackedDeltas(task.neighborDeltas),
    };
    if(task.sectionIndex !== undefined || options.renderSections) {
      const sections=ensureRenderSections(chunk);
      const jobs=task.sectionJobs ?? (task.sectionIndex!==undefined
        ? [{sectionIndex:task.sectionIndex,sectionRevision:task.sectionRevision,visualOnly:task.visualOnly}]
        : [...sections.keys()].map(sectionIndex=>({sectionIndex})));
      if (task.progressiveSections === true) {
        const preferredY = Number.isFinite(task.preferredSectionY) ? task.preferredSectionY
          : baseProfile.surfaceY.reduce((sum, y) => sum + y, 0) / baseProfile.surfaceY.length;
        jobs.sort((a, b) => Math.abs(sections.get(a.sectionIndex).originY + 8 - preferredY)
          - Math.abs(sections.get(b.sectionIndex).originY + 8 - preferredY) || a.sectionIndex - b.sectionIndex);
        for (let sequence = 0; sequence < jobs.length; sequence++) {
          const job = jobs[sequence];
          const result = { sectionIndex: job.sectionIndex, sectionRevision: job.sectionRevision,
            ...buildRenderSection(chunk, sections.get(job.sectionIndex), access, { visualOnly: Boolean(job.visualOnly) }) };
          // Only the clone is transferred. The profile used by later sections
          // remains owned by this Worker until the task reaches its terminal.
          const response = { type: "chunkProgress", taskId: task.taskId, chunkX: task.chunkX, chunkZ: task.chunkZ,
            mode: task.mode || "base", taskVersion: task.taskVersion, materialVersion: task.materialVersion,
            progressSequence: sequence, completedSections: sequence + 1, totalSections: jobs.length,
            baseProfile: sequence === 0 && task.mode === "base" ? structuredClone(baseProfile) : null,
            treeInstances: sequence === 0 && task.mode === "base" ? treeInstances : null,
            sectionResults: [result], elapsedMs: performance.now() - startedAt };
          self.postMessage(response, transferablesForBuild(response));
        }
        self.postMessage({ type: "chunkBuilt", taskId: task.taskId, chunkX: task.chunkX, chunkZ: task.chunkZ,
          mode: task.mode || "base", taskVersion: task.taskVersion, materialVersion: task.materialVersion,
          progressComplete: true, progressMessageCount: jobs.length, visualPending: false,
          elapsedMs: performance.now() - startedAt });
        return;
      }
      const results=jobs.map(job=>({sectionIndex:job.sectionIndex,sectionRevision:job.sectionRevision,
        ...buildRenderSection(chunk,sections.get(job.sectionIndex),access,{visualOnly:Boolean(job.visualOnly)})}));
      const response={type:"chunkBuilt",taskId:task.taskId,chunkX:task.chunkX,chunkZ:task.chunkZ,mode:task.mode||"base",taskVersion:task.taskVersion,materialVersion:task.materialVersion,
        sectionRevision:task.sectionRevision,baseProfile:task.mode==="base"?baseProfile:null,treeInstances:task.mode==="base"?treeInstances:null,
        ...(task.sectionIndex!==undefined&&results.length===1?results[0]:{sectionResults:results}),visualPending:false,elapsedMs:performance.now()-startedAt};
      self.postMessage(response,transferablesForBuild(response));return;
    }
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
  const transfer = [];
  for(const result of message.sectionResults ?? [message]) for(const mesh of [result.mesh,result.visualMesh]) if(mesh)transfer.push(mesh.vertices.buffer,mesh.indices.buffer);
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

function unpackPackedDeltas(packed) {
  if(!packed)return [];
  if(!(packed instanceof Int32Array))return packed;
  const values=[];for(let i=0;i<packed.length;i+=4)values.push({worldX:packed[i],worldY:packed[i+1],worldZ:packed[i+2],blockId:packed[i+3]});return values;
}

function capturedColumnTop(halo,x,z) {
  if(!halo)return null;const lx=x-halo.originX,lz=z-halo.originZ;
  if(halo.columns) {
    if(!halo.columnMap){halo.columnMap=new Map();for(let i=0;i<halo.columns.length;i+=3)halo.columnMap.set(`${halo.columns[i]}:${halo.columns[i+1]}`,halo.columns[i+2]);}
    return halo.columnMap.get(`${x}:${z}`)??null;
  }
  return lx>=0&&lz>=0&&lx<halo.width&&lz<halo.width?halo.tops[lx+lz*halo.width]:null;
}
