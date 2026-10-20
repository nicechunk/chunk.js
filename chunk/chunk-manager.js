import { DEFAULT_CHUNK_HEIGHT, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_TERRAIN_HEIGHT, DEFAULT_MESH_BUDGET_MS, DEFAULT_MIN_WORLD_Y, DEFAULT_SEA_LEVEL, DEFAULT_VIEW_DISTANCE } from "../core/constants.js";
import { chunkId, worldToChunk } from "../core/coordinates.js";
import { isBlockingBlock, isOpaqueSolidBlock, blockFlags, BLOCK_ID } from "../world/block-registry.js";
import { BLOCK_FLAGS } from "../core/constants.js";
import { compileSurfaceDecorationRules } from "../world/surface-decoration-rules.js";
import { SUNLIGHT_HORIZONTAL_REACH, SUNLIGHT_VERTICAL_REACH } from "../world/sunlight.js";
import {
  chunkLocalToWorldI32,
  createWorldGeneratorConfig,
  DEFAULT_GENERATION_VERSION,
  DEFAULT_RESOURCE_RULE_VERSION,
  generateBaseChunkProfileFromConfig,
  generateBaseChunkProfileFromConfigSteps,
  generateTreeInstancesForChunkFromConfig,
  generateTreeInstancesForChunkFromConfigSteps,
  getBaseBlockAtColumnConfig,
  getBaseBlockAtConfig,
  getBlockAtConfig,
  getGeneratedTreeBlockAtConfig,
  getGeneratedTreeTrunkBlockAtConfig,
  MAINNET_WORLD_SEED,
  terrainSurfaceHeight,
  treeInstanceBlockAt,
  treeInstanceTrunkBlockAt,
  waterLevelAt,
} from "../world/world-generator.js";
import { CHUNK_BOUNDARY_MASK, ChunkState } from "./chunk-state.js";
import {
  DELTA_PROTOCOL_LIMITS,
  DELTA_RESOURCE_LIMITS,
  deltaKey,
  normalizeDelta,
} from "./chunk-delta.js";
import { meshChunkOpaqueFast, meshChunkVisual } from "./chunk-mesher.js";
import { ensureRenderSections, buildRenderSection, buildRenderSectionSteps, commitRenderSection, updateChunkSectionSummary, sectionRevision, sectionDeltaValues, invalidateRenderSections, prepareRenderSnapshotInvalidation, invalidateSurfaceDecorations } from "./render-sections.js";
import { chunkIntersectsCameraFrustum, prepareCameraFrustum, cameraRenderCenterChunk } from "../renderer/frustum.js";
import { RenderStageStats } from "../debug/stats.js";

const DEFAULT_MAX_BUILD_QUEUE = 768;
const DEFAULT_VISIBILITY_LINGER_FRAMES = 12;
const VISIBILITY_CLEANUP_INTERVAL_FRAMES = 45;
const INITIAL_BUILD_CONCURRENCY = 1;
const WORKER_BUILD_RETRY_BASE_MS = 180;
const WORKER_BUILD_RETRY_MAX_MS = 5000;
const MAX_CONSECUTIVE_WORKER_FAILURES = 3;
const WORKER_TASK_TIMEOUT_MS = 30_000;
const COLLISION_COLUMN_CACHE_LIMIT = 4096;
const MAX_GENERATED_TREE_TRUNK_HEIGHT = 7;
const BUILD_CAMERA_FIELDS = ["worldX","worldY","worldZ","localOffsetX","localOffsetY","localOffsetZ",
  "targetWorldX","targetWorldY","targetWorldZ","targetLocalOffsetX","targetLocalOffsetY","targetLocalOffsetZ",
  "yaw","pitch","fov","aspect","near","far"];
const managerWorldSeeds = new WeakMap();

function isCameraOccluderBlock(blockId) {
  if (blockId === BLOCK_ID.leaves || blockId === BLOCK_ID.pineLeaves) return false;
  return isBlockingBlock(blockId);
}

export const CHUNK_MANAGER_LIMITS = Object.freeze({
  maxViewDistance: 32,
  maxPreloadMargin: 8,
  maxWorkers: 32,
  maxQueuedBuilds: 8192,
  maxVisibilityLingerFrames: 10_000,
});

export class ChunkManager {
  constructor({
    worldSeed = MAINNET_WORLD_SEED,
    chunkSize = DEFAULT_CHUNK_SIZE,
    height = DEFAULT_CHUNK_HEIGHT,
    minY = DEFAULT_MIN_WORLD_Y,
    maxBuildY = undefined,
    viewDistance = DEFAULT_VIEW_DISTANCE,
    preloadMargin = 1,
    seaLevel = DEFAULT_SEA_LEVEL,
    maxTerrainHeight = DEFAULT_MAX_TERRAIN_HEIGHT,
    generationVersion = DEFAULT_GENERATION_VERSION,
    resourceRuleVersion = DEFAULT_RESOURCE_RULE_VERSION,
    materialVersion = 1,
    surfaceDecorationRules = [],
    shadows = true,
    useWorkers = typeof Worker !== "undefined",
    workerCount = defaultWorkerCount(),
    workerUrl = null,
    deferInitialBuilds = false,
    deferContinuousBuildDispatch = false,
    maxQueuedBuilds = DEFAULT_MAX_BUILD_QUEUE,
    visibilityLingerFrames = DEFAULT_VISIBILITY_LINGER_FRAMES,
    maxCachedMeshBytes = 32 * 1024 * 1024,
    maxPredictivePreloadChunks = 0,
  } = {}) {
    this.config = createWorldGeneratorConfig({ worldSeed, chunkSize, height, minY, maxBuildY, seaLevel, maxTerrainHeight, generationVersion, resourceRuleVersion });
    managerWorldSeeds.set(this, this.config.worldSeed);
    Object.defineProperty(this, "worldSeed", {
      enumerable: true,
      get: () => new Uint8Array(managerWorldSeed(this)),
    });
    this.chunkSize = this.config.chunkSize;
    this.height = this.config.height;
    this.minY = this.config.minY;
    this.maxBuildY = this.config.maxBuildY;
    this.viewDistance = boundedManagerInteger(viewDistance, 1, CHUNK_MANAGER_LIMITS.maxViewDistance, "view distance");
    this.preloadMargin = boundedManagerInteger(preloadMargin, 0, CHUNK_MANAGER_LIMITS.maxPreloadMargin, "preload margin");
    this.preloadDistance = this.viewDistance + this.preloadMargin;
    this.maxPredictivePreloadChunks = boundedManagerInteger(maxPredictivePreloadChunks, 0, 4, "predictive preload distance");
    this.prefetchChunkX = 0;
    this.prefetchChunkZ = 0;
    this.seaLevel = this.config.seaLevel;
    this.maxTerrainHeight = this.config.maxTerrainHeight;
    this.generationVersion = this.config.generationVersion;
    this.resourceRuleVersion = this.config.resourceRuleVersion;
    this.materialVersion = materialVersion;
    this.shadows = shadows !== false;
    this.surfaceDecorationRules = compileSurfaceDecorationRules(surfaceDecorationRules);
    this.surfaceDecorationRulesRevision = 0;
    this.surfaceDecorationRulesSignature = decorationRulesSignature(this.surfaceDecorationRules.rules);
    this.chunks = new Map();
    this.reusableMeshes = new Map();
    this.reusableMeshBytes = 0;
    this.reusedMeshChunks = 0;
    this.pickedSurfaceColumnsByChunk = new Map();
    this.maxCachedMeshBytes = boundedManagerInteger(maxCachedMeshBytes, 0, 128 * 1024 * 1024, "reusable mesh byte limit");
    this.centerChunkX = 0;
    this.centerChunkZ = 0;
    this.loadDirX = 0;
    this.loadDirZ = 1;
    this.loadDirectionKey = directionBucketKey(this.loadDirX, this.loadDirZ);
    this.buildCamera = null;
    this.buildFrustum = null;
    this.buildCameraCenter = null;
    this.buildVisibilityCache = new WeakMap();
    this.lastEnsuredRangeKey = "";
    this.lastRebuildMs = 0;
    this.lastWorkerBuildMs = 0;
    this.lastBuildError = null;
    this.staleBuildResults = 0;
    this.sectionBuildVisits = 0;
    this.nearFieldRepairs = 0;
    this.stageStats = new RenderStageStats();
    this.useWorkers = Boolean(useWorkers && typeof Worker !== "undefined");
    this.workerCount = this.useWorkers
      ? boundedManagerInteger(workerCount, 1, CHUNK_MANAGER_LIMITS.maxWorkers, "worker count")
      : 0;
    this.workerUrl = normalizeWorkerUrl(workerUrl);
    this.deferInitialBuilds = Boolean(deferInitialBuilds && this.useWorkers);
    this.continuousBuildDispatch = !Boolean(deferContinuousBuildDispatch && this.useWorkers);
    this.activeBuildLimit = this.deferInitialBuilds ? 0 : Math.min(this.workerCount, INITIAL_BUILD_CONCURRENCY);
    this.maxQueuedBuilds = maxQueuedBuilds;
    this.workers = [];
    this.idleWorkers = [];
    this.buildQueue = [];
    this.buildQueueNeedsSort = false;
    this.lastBuildQueueSortAt = -Infinity;
    this.buildDispatchSerial = 0;
    this.inFlightBuilds = new Map();
    this.settledWorkerTaskIds = new WeakMap();
    this.completedBuilds = [];
    this.progressDrainCursor = 0;
    this.progressiveSectionsCommitted = 0;
    this.workerTaskTimeouts = 0;
    this.cancelledWorkerTasks = 0;
    this.fallbackBuild = null;
    this.fallbackSlices = 0;
    this.fallbackCancelled = 0;
    this.workerBuildFailures = new Map();
    this.consecutiveWorkerFailures = 0;
    this.dispatchScheduled = false;
    this.dispatchTimer = null;
    this.disposed = false;
    this.taskSerial = 1;
    this.renderLogger = null;
    this.supplementalCollisionProvider = null;
    this.collisionColumnTopCache = new Map();
    this.remoteOverlayChunks = new Set();
    this.interestRevision = 0;
    this.visibilityFrame = 0;
    this.lastVisibilityCleanupFrame = 0;
    this.visibilityLingerFrames = boundedManagerInteger(
      visibilityLingerFrames,
      0,
      CHUNK_MANAGER_LIMITS.maxVisibilityLingerFrames,
      "visibility linger frames",
    );
    this.visibleChunkMemory = new Map();
    if (this.useWorkers && !this.deferInitialBuilds) this.initWorkers(Math.min(this.workerCount, INITIAL_BUILD_CONCURRENCY));
  }

  get maxQueuedBuilds() {
    return this._maxQueuedBuilds;
  }

  set maxQueuedBuilds(value) {
    this._maxQueuedBuilds = boundedManagerInteger(
      value,
      1,
      CHUNK_MANAGER_LIMITS.maxQueuedBuilds,
      "maximum queued builds",
    );
  }

  setStageStats(stats) {
    if(stats && typeof stats.record === "function")this.stageStats=stats;
  }

  setRenderLogger(logger) {
    this.renderLogger = logger || null;
  }

  setSupplementalCollisionProvider(provider) {
    this.supplementalCollisionProvider = provider
      && (typeof provider.hasCollisionAtWorld === "function" || typeof provider.collisionTopAtWorld === "function")
      ? provider
      : null;
    return this.supplementalCollisionProvider;
  }

  setSurfaceDecorationRules(rules, { revision = this.surfaceDecorationRulesRevision + 1 } = {}) {
    const compiled = compileSurfaceDecorationRules(rules);
    const signature = decorationRulesSignature(compiled.rules);
    if (signature === this.surfaceDecorationRulesSignature) {
      this.surfaceDecorationRulesRevision = Math.max(this.surfaceDecorationRulesRevision, Math.trunc(Number(revision) || 0));
      return false;
    }
    const surfaces = new Set([...this.surfaceDecorationRules.bySurface.keys(), ...compiled.bySurface.keys()]);
    for (const surface of surfaces) {
      if (JSON.stringify(this.surfaceDecorationRules.bySurface.get(surface)) === JSON.stringify(compiled.bySurface.get(surface))) surfaces.delete(surface);
    }
    this.surfaceDecorationRules = compiled;
    this.surfaceDecorationRulesSignature = signature;
    this.surfaceDecorationRulesRevision = compiled.rules.length
      ? Math.max(1, Math.trunc(Number(revision) || 1))
      : Math.max(0, Math.trunc(Number(revision) || 0));
    for (const worker of [...this.workers]) {
      if (!this.useWorkers) break;
      try {
        worker.postMessage({ type: "setSurfaceDecorationRules", rules: compiled.rules, revision: this.surfaceDecorationRulesRevision });
      } catch (error) {
        this.handleWorkerError(worker, error, { allowRestart: false });
      }
    }
    for (const chunk of this.chunks.values()) {
      chunk.surfaceDecorationRules = compiled;
      invalidateSurfaceDecorations(chunk, { surfaces });
    }
    this.dispatchBuilds();
    return true;
  }

  setPickedSurfaceColumns(chunkX, chunkZ, columns = []) {
    const id = chunkId(chunkX, chunkZ), chunk = this.chunks.get(id);
    const next = [...new Set(columns)].filter(column => Number.isInteger(column) && column >= 0 && column < this.chunkSize * this.chunkSize).sort((a,b) => a-b);
    this.pickedSurfaceColumnsByChunk.set(id,next);
    if (!chunk) return false;
    const previous = new Set(chunk.pickedSurfaceColumns ?? []), current = new Set(next);
    const changed = new Set([...previous, ...current].filter(column => previous.has(column) !== current.has(column)));
    if (!changed.size) return false;
    chunk.pickedSurfaceColumns = next;
    invalidateSurfaceDecorations(chunk, { columns: changed });
    return true;
  }

  updatePlayerPosition(worldX, worldY, worldZ, options = {}) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    if (Number.isFinite(options.directionX) || Number.isFinite(options.directionZ)) this.setLoadDirection(options.directionX, options.directionZ);
    if (coord.chunkX !== this.centerChunkX || coord.chunkZ !== this.centerChunkZ) this.buildQueueNeedsSort = true;
    const maxAhead = this.maxPredictivePreloadChunks;
    const forecast = (value, center) => Number.isFinite(value)
      ? Math.max(center - maxAhead, Math.min(center + maxAhead, Math.floor(value / this.chunkSize))) : center;
    const prefetchX = forecast(options.prefetchWorldX, coord.chunkX);
    const prefetchZ = forecast(options.prefetchWorldZ, coord.chunkZ);
    const nextRangeKey = `${coord.chunkX}:${coord.chunkZ}:${this.preloadDistance}:${prefetchX}:${prefetchZ}`;
    if (prefetchX !== this.prefetchChunkX || prefetchZ !== this.prefetchChunkZ) this.buildQueueNeedsSort = true;
    this.prefetchChunkX = prefetchX;
    this.prefetchChunkZ = prefetchZ;
    this.centerChunkX = coord.chunkX;
    this.centerChunkZ = coord.chunkZ;
    if (nextRangeKey !== this.lastEnsuredRangeKey) {
      this.ensureChunkRange(coord.chunkX, coord.chunkZ, { force: true });
      this.unloadFarChunks(coord.chunkX, coord.chunkZ);
    }
    this.dispatchBuilds();
  }

  ensureChunkRange(centerX = this.centerChunkX, centerZ = this.centerChunkZ, { force = false } = {}) {
    // Keep the complete current ring. Prediction adds identities; it never
    // replaces the current view or shifts the authoritative player center.
    const forecastX = Math.max(centerX - this.maxPredictivePreloadChunks, Math.min(centerX + this.maxPredictivePreloadChunks, this.prefetchChunkX));
    const forecastZ = Math.max(centerZ - this.maxPredictivePreloadChunks, Math.min(centerZ + this.maxPredictivePreloadChunks, this.prefetchChunkZ));
    const rangeKey = `${centerX}:${centerZ}:${this.preloadDistance}:${forecastX}:${forecastZ}`;
    if (!force && rangeKey === this.lastEnsuredRangeKey) {
      this.dispatchBuilds();
      return;
    }
    this.lastEnsuredRangeKey = rangeKey;
    const offsets = buildLoadOffsets(this.preloadDistance, this.loadDirX, this.loadDirZ);
    for (const offset of offsets) {
      // Reserve identities immediately, but do not reconstruct every new base
      // column in this call when Workers are unavailable. The normal dirty
      // scheduler generates near bases progressively under its task budget.
      this.ensureChunk(centerX + offset.dx, centerZ + offset.dz, { deferBase: true });
    }
    if (forecastX !== centerX || forecastZ !== centerZ) for (const offset of offsets) {
      const x = forecastX + offset.dx, z = forecastZ + offset.dz;
      if (Math.max(Math.abs(x - centerX), Math.abs(z - centerZ)) > this.preloadDistance) this.ensureChunk(x, z, { deferBase: true });
    }
    this.dispatchBuilds();
  }

  setLoadDirection(directionX = 0, directionZ = 1) {
    const length = Math.hypot(directionX || 0, directionZ || 0);
    if (length < 0.0001) return;
    this.loadDirX = directionX / length;
    this.loadDirZ = directionZ / length;
    const nextDirectionKey = directionBucketKey(this.loadDirX, this.loadDirZ);
    if (nextDirectionKey !== this.loadDirectionKey) this.buildQueueNeedsSort = true;
    this.loadDirectionKey = nextDirectionKey;
  }

  setBuildCamera(cameraState = null) {
    // This changes task order only. Frustum/radius checks for drawing and all
    // background identities stay intact; turning reprioritizes queued work.
    if(cameraState && this.buildCamera && BUILD_CAMERA_FIELDS.every(key=>Object.is(this.buildCamera[key],cameraState[key])))return;
    if(!cameraState&&!this.buildCamera)return;
    this.buildCamera = cameraState ? Object.fromEntries(BUILD_CAMERA_FIELDS.map(key=>[key,cameraState[key]])) : null;
    this.buildFrustum = cameraState ? prepareCameraFrustum(cameraState) : null;
    this.buildCameraCenter = cameraState ? cameraRenderCenterChunk(cameraState,this.chunkSize) : null;
    this.buildQueueNeedsSort = true;
  }

  chunkInBuildFrustum(chunk) {
    const prior=this.buildVisibilityCache.get(chunk);
    if(prior&&prior.frustum===this.buildFrustum&&prior.mesh===chunk.mesh&&prior.visualMesh===chunk.visualMesh)return prior.visible;
    const visible=chunkIntersectsCameraFrustum(chunk,this.buildCamera,this.buildFrustum);
    this.buildVisibilityCache.set(chunk,{frustum:this.buildFrustum,mesh:chunk.mesh,visualMesh:chunk.visualMesh,visible});
    return visible;
  }

  setBuildConcurrencyLimit(limit = this.workerCount) {
    if (!this.useWorkers) return;
    const requested = boundedManagerInteger(limit, 0, CHUNK_MANAGER_LIMITS.maxWorkers, "worker concurrency limit");
    const next = Math.min(this.workerCount, requested);
    if (next > this.workers.length) this.initWorkers(next);
    if (next === this.activeBuildLimit) return;
    this.activeBuildLimit = next;
    this.dispatchBuilds();
  }

  setContinuousBuildDispatch(enabled = true) {
    const next = Boolean(enabled);
    if (next === this.continuousBuildDispatch) return;
    this.continuousBuildDispatch = next;
    if (next) this.scheduleBuildDispatch();
  }

  setViewDistance(viewDistance, { preloadMargin = this.preloadMargin } = {}) {
    this.viewDistance = boundedManagerInteger(viewDistance, 1, CHUNK_MANAGER_LIMITS.maxViewDistance, "view distance");
    this.preloadMargin = boundedManagerInteger(preloadMargin, 0, CHUNK_MANAGER_LIMITS.maxPreloadMargin, "preload margin");
    this.preloadDistance = this.viewDistance + this.preloadMargin;
    this.lastEnsuredRangeKey = "";
    this.ensureChunkRange(this.centerChunkX, this.centerChunkZ, { force: true });
  }

  ensureChunk(chunkX, chunkZ, { deferBase = false } = {}) {
    if (this.disposed) throw new Error("Cannot use a disposed ChunkManager.");
    const id = chunkId(chunkX, chunkZ);
    let chunk = this.chunks.get(id);
    if (chunk) {
      if(!deferBase&&!this.useWorkers)this.ensureChunkBaseSync(chunk);
      return chunk;
    }
    chunk = new ChunkState({
      chunkX,
      chunkZ,
      chunkSize: this.chunkSize,
      height: this.height,
      minY: this.minY,
      maxBuildY: this.maxBuildY,
      generationVersion: this.generationVersion,
      resourceRuleVersion: this.resourceRuleVersion,
      materialVersion: this.materialVersion,
      worldSeed: this.config.worldSeed,
      surfaceDecorationRules: this.surfaceDecorationRules,
      shadows: this.shadows,
      baseBlocks: null,
      baseBlocksReady: false,
    });
    chunk.prepareRenderSnapshotNeighborhood=(changes)=>this.prepareSnapshotNeighborhood(chunk,changes);
    chunk.pickedSurfaceColumns = [...(this.pickedSurfaceColumnsByChunk.get(id) ?? [])];
    const manager=this;
    chunk.prepareRenderSnapshotInvalidation=function*(next,changes,options) {
      if(chunk.renderSections)return yield* prepareRenderSnapshotInvalidation(chunk,next,changes,options);
      const neighborhood=yield* manager.prepareSnapshotNeighborhood(chunk,changes);
      return {handlesNeighborhood:true,isCurrent:()=>!chunk.renderSections,commit(){neighborhood.commit();}};
    };
    chunk.onRemoteDeltasExpired=(deltas,mask)=>this.markBoundaryNeighborsDirty(chunk,mask,deltas);
    chunk.onRemoteDeltasChanged=()=>{
      if(this.chunks.get(id)===chunk&&chunk.remoteDeltas.size)this.remoteOverlayChunks.add(chunk);
      else this.remoteOverlayChunks.delete(chunk);
    };
    this.chunks.set(id, chunk);
    this.interestRevision++;
    // Rehydration allocates section states. Step it under rebuildDirtyChunks'
    // frame budget rather than restoring an entire returning range in one call.
    if (this.reusableMeshes.has(id)) {
      if (!deferBase && !this.useWorkers) this.restoreReusableMesh(chunk);
      return chunk;
    }
    if (this.useWorkers) {
      this.enqueueBuild(chunk);
    } else if(!deferBase) {
      this.ensureChunkBaseSync(chunk);
    }
    return chunk;
  }

  unloadFarChunks(centerX, centerZ) {
    const limit = this.preloadDistance + 2;
    for (const [id, chunk] of Array.from(this.chunks.entries())) {
      const currentDistance = Math.max(Math.abs(chunk.chunkX - centerX), Math.abs(chunk.chunkZ - centerZ));
      const predictedDistance = this.maxPredictivePreloadChunks > 0 && centerX === this.centerChunkX && centerZ === this.centerChunkZ
        ? Math.max(Math.abs(chunk.chunkX - this.prefetchChunkX), Math.abs(chunk.chunkZ - this.prefetchChunkZ)) : currentDistance;
      if (currentDistance > limit && predictedDistance > limit) {
        const edits=[...chunk.getFinalDeltaMap().values()];
        this.retainReusableMesh(chunk);
        this.chunks.delete(id);
        this.remoteOverlayChunks.delete(chunk);
        if(edits.length)this.markBoundaryNeighborsDirty(chunk,15,edits);
      }
    }
    this.buildQueue = this.buildQueue.filter((task) => this.chunks.has(task.id));
    this.completedBuilds = this.completedBuilds.filter((chunk) => this.chunks.has(chunk.id));
    for (const task of this.inFlightBuilds.values()) {
      if (!this.chunks.has(task.id)) task.cancelled = true;
    }
    this.cancelObsoleteWorkerTasks();
    for (const id of this.workerBuildFailures.keys()) {
      if (!this.chunks.has(id)) this.workerBuildFailures.delete(id);
    }
  }

  reusableMeshNeighborhoodIsClean(chunk) {
    const radius = Math.ceil((this.shadows ? SUNLIGHT_HORIZONTAL_REACH : 8) / this.chunkSize);
    for (let dz=-radius;dz<=radius;dz++) for (let dx=-radius;dx<=radius;dx++) {
      const neighbor=this.chunks.get(chunkId(chunk.chunkX+dx,chunk.chunkZ+dz));
      if (neighbor && (hasDeltas(neighbor) || neighbor.baseBlocks)) return false;
    }
    return true;
  }

  retainReusableMesh(chunk) {
    if (!this.maxCachedMeshBytes || !chunk.baseProfile || !chunk.renderSections || chunk.dirty
      || chunk.reusableBaseVersion !== chunk.version || !this.reusableMeshNeighborhoodIsClean(chunk)) return;
    const sections = [...chunk.renderSections.values()].map(section=>({sectionIndex:section.sectionIndex,mesh:section.mesh,visualMesh:section.visualMesh,visualError:null}));
    if (sections.some(section=>!section.mesh || !section.visualMesh)) return;
    const buffers = new Set();
    for (const section of sections) for (const mesh of [section.mesh,section.visualMesh]) for (const array of [mesh.vertices,mesh.indices]) buffers.add(array.buffer);
    for (const array of [chunk.baseProfile.surfaceY,chunk.baseProfile.waterY,chunk.baseProfile.surfaceBlock]) if (array) buffers.add(array.buffer);
    // Include conservative JS metadata estimates as well as actual retained bytes.
    const bytes = [...buffers].reduce((total,buffer)=>total+buffer.byteLength,0) + sections.length*512 + (chunk.treeInstances?.length??0)*256 + 1024;
    if (bytes > this.maxCachedMeshBytes) return;
    const old = this.reusableMeshes.get(chunk.id);
    if (old) { this.reusableMeshBytes -= old.bytes; this.reusableMeshes.delete(chunk.id); }
    this.reusableMeshes.set(chunk.id,{bytes,sections,baseProfile:chunk.baseProfile,treeInstances:chunk.treeInstances,
      materialVersion:this.materialVersion,rules:this.surfaceDecorationRulesSignature,picked:chunk.pickedSurfaceColumns.join(',')});
    this.reusableMeshBytes += bytes;
    while (this.reusableMeshBytes > this.maxCachedMeshBytes || this.reusableMeshes.size > 768) {
      // Returning identities are reserved before eviction/rehydration. Do not
      // evict the very meshes that the next budgeted rebuild is about to use.
      let id;
      for (const candidate of this.reusableMeshes.keys()) {
        const current=this.chunks.get(candidate);
        if (!current || current.baseBlocksReady) { id=candidate;break; }
      }
      id ??= this.reusableMeshes.keys().next().value;
      this.reusableMeshBytes -= this.reusableMeshes.get(id).bytes;
      this.reusableMeshes.delete(id);
    }
  }

  restoreReusableMesh(chunk) {
    const cached = this.reusableMeshes.get(chunk.id);
    if (!cached) return false;
    this.reusableMeshes.delete(chunk.id);this.reusableMeshBytes-=cached.bytes;
    if (cached.materialVersion !== this.materialVersion || cached.rules !== this.surfaceDecorationRulesSignature
      || cached.picked !== chunk.pickedSurfaceColumns.join(',') || !this.reusableMeshNeighborhoodIsClean(chunk)) return false;
    chunk.setBaseProfile(cached.baseProfile,cached.treeInstances,this.baseBlockResolverForChunk(chunk.chunkX,chunk.chunkZ,cached.baseProfile));
    const sections=ensureRenderSections(chunk);
    for (const result of cached.sections) commitRenderSection(chunk,sections.get(result.sectionIndex),result,undefined,{updateSummary:false});
    updateChunkSectionSummary(chunk);
    chunk.reusableBaseVersion=chunk.version;
    this.reusedMeshChunks++;
    this.completedBuilds.push(chunk);
    return true;
  }

  getVisibleChunks(cameraState = {}) {
    const chunks = [];
    const frame = ++this.visibilityFrame;
    const cameraChunk = visibilityCenterChunk(cameraState, this.chunkSize);
    const frustum = cameraState ? prepareCameraFrustum(cameraState) : null;
    for (const chunk of this.orderedVisibilityCandidates(cameraChunk)) {
      const distance = Math.max(Math.abs(chunk.chunkX - cameraChunk.chunkX), Math.abs(chunk.chunkZ - cameraChunk.chunkZ));
      if (!chunk.mesh) continue;
      if (distance > this.viewDistance) {
        this.visibleChunkMemory.delete(chunk.id);
        continue;
      }
      if (chunkIntersectsCameraFrustum(chunk, cameraState, frustum)) {
        this.visibleChunkMemory.set(chunk.id, frame);
        chunks.push(chunk);
        continue;
      }
      const lastVisibleFrame = this.visibleChunkMemory.get(chunk.id) || 0;
      if (lastVisibleFrame && frame - lastVisibleFrame <= this.visibilityLingerFrames) chunks.push(chunk);
    }
    this.cleanupVisibleChunkMemory(frame);
    return chunks;
  }

  orderedVisibilityCandidates(center) {
    let cached = this.visibilityOrder;
    let current = cached && cached.map === this.chunks && cached.input.length === this.chunks.size
      && cached.x === center.chunkX && cached.z === center.chunkZ
      && cached.dirX === this.loadDirX && cached.dirZ === this.loadDirZ;
    if (current) {
      let index = 0;
      // Retain compatibility with callers replacing members of the public Map,
      // including replacement with another instance at the same coordinates.
      for (const chunk of this.chunks.values()) {
        if (cached.input[index] !== chunk || cached.coordinates[index * 2] !== chunk.chunkX
          || cached.coordinates[index * 2 + 1] !== chunk.chunkZ) { current = false; break; }
        index++;
      }
    }
    if (current) return cached.ordered;
    const input = Array.from(this.chunks.values());
    const priorities = new Map(input.map(chunk => [chunk, chunkPriority(chunk, center, this)]));
    const ordered = input.slice().sort((a, b) => priorities.get(a) - priorities.get(b));
    this.visibilityOrder = { map: this.chunks, input, coordinates: input.flatMap(chunk => [chunk.chunkX, chunk.chunkZ]), ordered, x: center.chunkX, z: center.chunkZ,
      dirX: this.loadDirX, dirZ: this.loadDirZ };
    return ordered;
  }

  cleanupVisibleChunkMemory(frame = this.visibilityFrame) {
    if (frame - this.lastVisibilityCleanupFrame < VISIBILITY_CLEANUP_INTERVAL_FRAMES) return;
    this.lastVisibilityCleanupFrame = frame;
    const expiry = this.visibilityLingerFrames + VISIBILITY_CLEANUP_INTERVAL_FRAMES;
    for (const [id, lastVisibleFrame] of this.visibleChunkMemory.entries()) {
      if (!this.chunks.has(id) || frame - lastVisibleFrame > expiry) this.visibleChunkMemory.delete(id);
    }
  }

  markChunkDirty(id) {
    const chunk = typeof id === "string" ? this.chunks.get(id) : this.chunks.get(chunkId(id.chunkX, id.chunkZ));
    chunk?.markDirty();
  }

  meshAccessForChunk(chunk) {
    return {
      generatedTerrain:Boolean(chunk.baseProfile&&!chunk.baseBlocks),
      generatedSurfaceAtWorld:(x,z)=>terrainSurfaceHeight(this.config,x,z),
      noLocalLightSources:()=>{
        if(this.generationVersion!==5||!chunk.baseProfile||chunk.baseBlocks)return false;
        const radius=Math.ceil(8/this.chunkSize);
        for(let dz=-radius;dz<=radius;dz++)for(let dx=-radius;dx<=radius;dx++) {
          const neighbor=this.chunks.get(chunkId(chunk.chunkX+dx,chunk.chunkZ+dz));
          if(neighbor?.baseBlocks||neighbor?.baseProfile?.surfaceBlock?.some(id=>blockFlags(id)&BLOCK_FLAGS.EMISSIVE))return false;
          if(!neighbor||!hasDeltas(neighbor))continue;
          for(const delta of neighbor.getFinalDeltaMap().values())if(blockFlags(delta.blockId)&BLOCK_FLAGS.EMISSIVE)return false;
        }
        return true;
      },
      getBlockAtWorld:(x,y,z)=>this.getBlockAtWorld(x,y,z),
      getDeltaAtWorld:(x,y,z)=>this.getDeltaAtWorld(x,y,z),
      getColumnTopAtWorld:(x,z)=>this.getOpaqueColumnTopAtWorld(x,z),
      getWaterLevelAtWorld:(x,z,surface)=>this.getWaterLevelAtWorld(x,z,surface),
      getNeighborDeltas:(index)=>this.neighborDeltaValues(chunk.chunkX,chunk.chunkZ,index),
      treeDeltaCandidateCount:this.treeDeltaCandidateCountForChunk(chunk.chunkX,chunk.chunkZ),
    };
  }

  invalidateLightingDependencies(source,deltas) {
    // Both the legacy terrain samples and directional sunlight use this halo.
    // It is separate from the one-cell geometry and tree dependencies.
    const reach=this.shadows?SUNLIGHT_HORIZONTAL_REACH:8;
    const changed=new Set();
    for(const target of this.chunks.values()) {
      if(target===source)continue;
      const minX=target.chunkX*this.chunkSize,minZ=target.chunkZ*this.chunkSize;
      const relevant=deltas.filter(d=>d.worldX>=minX-reach&&d.worldX<minX+this.chunkSize+reach&&d.worldZ>=minZ-reach&&d.worldZ<minZ+this.chunkSize+reach);
      if(!relevant.length)continue;
      if(!target.renderSections) {target.markDirty();changed.add(target);continue;}
      let invalidated = false;
      for(const section of target.renderSections.values()) {
        if(!section.mesh?.vertexCount&&!section.visualMesh?.vertexCount)continue;
        if(section.originY>Math.max(...relevant.map(d=>d.worldY))+4)continue;
        if(!this.shadows&&section.originY+section.height<=Math.min(...relevant.map(d=>d.worldY))-4)continue;
        section.lightRevision++;section.dirty=true;section.visualDirty=true;
        section.dirtyReason="sun-halo";section.oldestDirtyAt??=performance.now();
        invalidated = true;
      }
      if (invalidated) { target.renderInvalidationPending=true;target.markDirty();changed.add(target); }
    }
    return changed;
  }

  captureColumnTopHalo(chunk) {
    const margin=SUNLIGHT_HORIZONTAL_REACH,width=this.chunkSize+2*margin;
    const originX=chunk.chunkX*this.chunkSize-margin,originZ=chunk.chunkZ*this.chunkSize-margin;
    const tops=new Int32Array(width*width);
    for(let z=0;z<width;z++)for(let x=0;x<width;x++)tops[x+z*width]=this.getOpaqueColumnTopAtWorld(originX+x,originZ+z);
    return {originX,originZ,width,tops};
  }

  captureWorkerColumnTopHalo(chunk) {
    // No-shadow lighting no longer reads the height field, even for emitters.
    if(!this.shadows)return {originX:chunk.chunkX*this.chunkSize,originZ:chunk.chunkZ*this.chunkSize,width:0,tops:new Int32Array()};
    // The Worker reconstructs unchanged columns from the same captured seed and
    // generator configuration. Only edited column tops need a main-thread read.
    // Dense/custom base blocks retain the complete snapshot path.
    const margin=SUNLIGHT_HORIZONTAL_REACH,width=this.chunkSize+2*margin;
    const originX=chunk.chunkX*this.chunkSize-margin,originZ=chunk.chunkZ*this.chunkSize-margin;
    const columns=[];
    const radius=Math.ceil(margin/this.chunkSize);
    for(let dz=-radius;dz<=radius;dz++)for(let dx=-radius;dx<=radius;dx++) {
      const neighbor=this.chunks.get(chunkId(chunk.chunkX+dx,chunk.chunkZ+dz));
      if(!neighbor)continue;
      if(neighbor.baseBlocks)return this.captureColumnTopHalo(chunk);
      if(!hasDeltas(neighbor))continue;
      ensureRenderSections(neighbor);
      for(const [column,deltas] of neighbor.renderDeltaColumns) {
        if(!deltas.size)continue;
        const x=neighbor.chunkX*this.chunkSize+column%this.chunkSize;
        const z=neighbor.chunkZ*this.chunkSize+Math.floor(column/this.chunkSize);
        if(x<originX||z<originZ||x>=originX+width||z>=originZ+width)continue;
        columns.push(x,z,this.getOpaqueColumnTopAtWorld(x,z));
      }
    }
    return {originX,originZ,width,tops:new Int32Array(),columns:Int32Array.from(columns)};
  }

  *prepareSnapshotNeighborhood(source,changes) {
    const plans=new Map(),reach=this.shadows?SUNLIGHT_HORIZONTAL_REACH:8,radius=Math.ceil(reach/this.chunkSize);
    for(const delta of changes) {
      for(let dz=-radius;dz<=radius;dz++)for(let dx=-radius;dx<=radius;dx++) {
        if(dx===0&&dz===0)continue;
        const cx=source.chunkX+dx,cz=source.chunkZ+dz,x=delta.worldX-cx*this.chunkSize,z=delta.worldZ-cz*this.chunkSize;
        if(x< -reach||z< -reach||x>=this.chunkSize+reach||z>=this.chunkSize+reach)continue;
        const id=chunkId(cx,cz);let plan=plans.get(id);
        if(!plan)plans.set(id,plan={data:new Set(),light:new Set(),maxY:-Infinity,trees:false});
        const y=delta.localY??delta.worldY;
        if(x>=-1&&z>=-1&&x<=this.chunkSize&&z<=this.chunkSize)for(const sy of [y-1,y,y+1])plan.data.add(Math.floor((sy-this.minY)/16));
        for(const sy of [y-(this.shadows?SUNLIGHT_VERTICAL_REACH:4),y,y+4])plan.light.add(Math.floor((sy-this.minY)/16));
        plan.maxY=Math.max(plan.maxY,y+4);
        plan.trees ||= x>=-6&&z>=-6&&x<this.chunkSize+6&&z<this.chunkSize+6;
        yield;
      }
    }
    return {commit:()=>{
      for(const [id,plan]of plans) {
        const target=this.chunks.get(id);if(!target)continue;
        if(!target.renderSections){target.markDirty();continue;}
        let changed=false;
        const treeSections=plan.trees?new Set((target.treeInstances??[]).map(tree=>Math.floor((tree.baseY-this.minY)/16))):null;
        for(const [index,section]of target.renderSections) {
          const geometry=plan.data.has(index)||treeSections?.has(index);
          if(!geometry&&!plan.light.has(index)&&(!this.shadows||section.originY>plan.maxY))continue;
          if(!geometry&&!section.mesh?.indexCount&&!section.visualMesh?.indexCount)continue;
          if(geometry){section.dataRevision++;section.haloRevision++;}
          section.lightRevision++;section.dirty=true;section.visualDirty=true;section.dirtyReason="atomic-neighbor-snapshot";section.oldestDirtyAt??=performance.now();changed=true;
        }
        if(changed){target.renderInvalidationPending=true;target.markDirty();}
      }
    }};
  }

  enqueueSectionBuilds(chunk) {
    if(!this.useWorkers)return false;
    if(this.inFlightBuilds.get(chunk.buildTaskId)?.progressiveJobs)return false;
    const sections=ensureRenderSections(chunk);
    let queued=false;
    let batch = null;
    for(const section of sections.values()) {
      if(!section.dirty&&(!section.visualDirty||performance.now()<section.visualRetryAt))continue;
      if(section.buildState!=="ready"||this.buildQueue.length>=this.maxQueuedBuilds)continue;
      section.buildState="queued";
      if (!batch || batch.sectionIndices.length >= 4) {
        batch = {id:chunk.id,chunk,sectionIndex:section.sectionIndex,sectionIndices:[],chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,mode:"section",queuedAt:section.oldestDirtyAt??performance.now(),version:chunk.version};
        this.buildQueue.push(batch);
      }
      batch.sectionIndices.push(section.sectionIndex);
      queued=true;
    }
    this.buildQueueNeedsSort ||= queued;
    return queued;
  }

  dispatchSectionBuild(worker,queued,chunk) {
    const selected = [];
    for (const index of queued.sectionIndices ?? [queued.sectionIndex]) {
      const section = chunk.renderSections.get(index);
      if (section && (section.dirty || section.visualDirty)) selected.push(section);
      else if (section) section.buildState = "ready";
    }
    if (!selected.length) return false;
    const section = selected[0];
    const taskId=this.taskSerial++,revision=sectionRevision(section,this.materialVersion),startedAt=performance.now();
    chunk.lastBuildDispatchAt = startedAt;
    const sectionJobs = selected.map(section => ({ sectionIndex: section.sectionIndex, sectionRevision: sectionRevision(section,this.materialVersion), visualOnly: !section.dirty }));
    const task={...queued,sectionIndex:section.sectionIndex,sectionJobs,worker,chunk,version:chunk.version,sectionRevision:revision,materialVersion:this.materialVersion,phase:"chunk",cancelled:false,startedAt};
    for (const item of selected) { item.buildState="building";item.buildTaskId=taskId; }
    this.inFlightBuilds.set(taskId,task);
    // One column snapshot per bounded batch. Every child still carries its own
    // revision, so an edit can reject one result without discarding its siblings.
    const finalDeltas=packedFinalDeltasForWorker(chunk);
    const neighborDeltas=this.neighborDeltasForWorker(chunk.chunkX,chunk.chunkZ);
    const treeDeltas=this.treeNeighborDeltasForWorker(chunk.chunkX,chunk.chunkZ);
    const lightingDeltas=this.visualDeltasForWorker(chunk.chunkX,chunk.chunkZ,this.shadows?SUNLIGHT_HORIZONTAL_REACH:8);
    const columnTopHalo=this.captureWorkerColumnTopHalo(chunk);
    try {
      worker.postMessage({type:"buildChunk",taskId,worldSeed:new Uint8Array(managerWorldSeed(this)),chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,
        generationVersion:this.generationVersion,resourceRuleVersion:this.resourceRuleVersion,materialVersion:this.materialVersion,
        options:this.workerOptions(),mode:"section",taskVersion:task.version,sectionIndex:section.sectionIndex,sectionRevision:revision,
        sectionJobs,
        finalDeltas,neighborDeltas,treeDeltas,lightingDeltas,columnTopHalo,baseProfile:chunk.baseProfile,treeInstances:chunk.treeInstances,
        pickedSurfaceColumns:[...(chunk.pickedSurfaceColumns??[])],
        visualOnly:!section.dirty},[finalDeltas.buffer,neighborDeltas.buffer,treeDeltas.buffer,lightingDeltas.buffer,columnTopHalo.tops.buffer,...(columnTopHalo.columns?[columnTopHalo.columns.buffer]:[])]);
    } catch(error) {this.handleWorkerError(worker,error,{allowRestart:false});}
    return true;
  }

  commitLegacyWorkerMeshes(chunk,message,version) {
    const previous=chunk.visualMesh,previousVersion=chunk.visualMeshVersion;
    chunk.setMeshes(message.mesh,message.visualMesh??null,version);
    if(message.visualError) {
      chunk.visualMesh=previous;chunk.visualMeshVersion=previousVersion;
      chunk.visualBuildError=message.visualError;chunk.dirty=true;
      this.recordWorkerBuildFailure(chunk,message.visualError);
    } else chunk.visualBuildError=null;
  }

  // Snapshot construction itself yields: a large edit map must not become a
  // new indivisible setup cost in the no-Worker path. Internal base profiles
  // are immutable, and copies also isolate legacy callers owning dense arrays.
  *captureSectionBuildInputs(chunk, { workBudget = 128 } = {}) {
    const snapshotManager = Object.create(this);
    const snapshots = new Map();
    snapshotManager.chunks = snapshots;
    snapshotManager.collisionColumnTopCache = new Map();
    managerWorldSeeds.set(snapshotManager, managerWorldSeed(this));
    const radius = Math.ceil((this.shadows ? SUNLIGHT_HORIZONTAL_REACH : 8) / this.chunkSize) + 1;
    let units = 0;
    for (const source of this.chunks.values()) {
      if (Math.abs(source.chunkX - chunk.chunkX) > radius || Math.abs(source.chunkZ - chunk.chunkZ) > radius) continue;
      source.expireRemoteDeltas();
      const snapshot = Object.create(source), final = new Map();
      snapshot.pendingDeltas = new Map();
      snapshot.remoteDeltas = new Map();
      snapshot.chainDeltas = final;
      snapshot.renderDeltaColumns = new Map();
      snapshot.renderDeltaSections = new Map();
      snapshot.renderColumnTops = new Map(source.renderColumnTops ?? []);
      snapshot.renderColumnRevisions = new Map(source.renderColumnRevisions ?? []);
      snapshot.renderSections = source.renderSections
        ? new Map([...source.renderSections].map(([index, section]) => [index, { ...section }])) : null;
      snapshot.baseBlocks = source.baseBlocks?.slice() ?? null;
      snapshot.baseProfile = source.baseProfile && { ...source.baseProfile,
        surfaceY: source.baseProfile.surfaceY.slice(), waterY: source.baseProfile.waterY.slice(),
        surfaceBlock: source.baseProfile.surfaceBlock?.slice() };
      snapshot.treeInstances = [];
      snapshot.pickedSurfaceColumns = [...(source.pickedSurfaceColumns ?? [])];
      for (const tree of source.treeInstances ?? []) {
        snapshot.treeInstances.push({ ...tree, leafMasks: tree.leafMasks?.slice() });
        if (++units >= workBudget) { units = 0; yield { phase: "snapshot-trees", workUnits: workBudget }; }
      }
      for (const map of [source.chainDeltas, source.remoteDeltas, source.pendingDeltas]) for (const [key, delta] of map) {
        final.set(key, { ...delta });
        if (++units >= workBudget) { units = 0; yield { phase: "snapshot-deltas", workUnits: workBudget }; }
      }
      for (const [key, delta] of final) {
        const column = delta.localX + delta.localZ * this.chunkSize;
        const section = Math.floor((delta.localY - source.minY) / 16);
        for (const [map, index] of [[snapshot.renderDeltaColumns, column], [snapshot.renderDeltaSections, section]]) {
          let entries = map.get(index); if (!entries) map.set(index, entries = new Map());
          entries.set(key, delta);
        }
        if (++units >= workBudget) { units = 0; yield { phase: "snapshot-indices", workUnits: workBudget }; }
      }
      snapshot.getFinalDeltaMap = () => final;
      snapshot.expireRemoteDeltas = () => ({ changed: false, boundaryMask: 0 });
      snapshot.hasDeltaAt = (x, y, z) => final.has(deltaKey(x, y, z, source.chunkSize));
      snapshot.getFinalBlock = (x, y, z) => x < 0 || z < 0 || x >= source.chunkSize || z >= source.chunkSize
        || y < source.minY || y >= source.minY + source.height ? BLOCK_ID.air
        : final.get(deltaKey(x, y, z, source.chunkSize))?.blockId ?? snapshot.getBaseBlock(x, y, z);
      snapshots.set(source.id, snapshot);
      yield { phase: "snapshot-column", workUnits: 1 };
    }
    const snapshot = snapshots.get(chunk.id);
    return { chunk: snapshot, access: snapshotManager.meshAccessForChunk(snapshot) };
  }

  cancelFallbackBuild() {
    const job = this.fallbackBuild;
    if (!job) return;
    job.iterator.return?.();
    if (job.section?.buildState === "fallback") job.section.buildState = "ready";
    this.fallbackBuild = null;
    this.fallbackCancelled++;
  }

  fallbackBuildIsCurrent(job) {
    return this.chunks.get(job.chunk.id) === job.chunk && !this.disposed
      && (job.kind === "base" ? !job.chunk.baseBlocksReady
        : job.chunk.baseProfile === job.baseProfile && job.chunk.baseBlocks === job.baseBlocks
          && job.chunk.renderSections?.get(job.section.sectionIndex) === job.section
          && sectionRevision(job.section, this.materialVersion) === job.revision
          && this.surfaceDecorationRulesSignature === job.rules);
  }

  advanceFallbackBuild(deadline, rebuilt) {
    let slices = 0;
    while (slices < 4096 && (!slices || performance.now() < deadline)) {
      if (this.fallbackBuild && !this.fallbackBuildIsCurrent(this.fallbackBuild)) this.cancelFallbackBuild();
      if (!this.fallbackBuild) {
        const center = { chunkX: this.centerChunkX, chunkZ: this.centerChunkZ };
        const dirty = [...this.chunks.values()].filter(chunk => chunk.dirty)
          .sort((a, b) => chunkPriority(a, center, this) - chunkPriority(b, center, this));
        let job = null;
        for (const chunk of dirty) {
          if (chunk.buildState === "error" && !this.prepareWorkerBuildRetry(chunk, performance.now())) continue;
          if (!chunk.baseBlocksReady && this.restoreReusableMesh(chunk)) { rebuilt.push(chunk); continue; }
          if (!chunk.baseBlocksReady) {
            const manager = this;
            job = { chunk, kind: "base", cpuMs: 0, startedAt: performance.now(), iterator: (function* () {
              const profile = yield* generateBaseChunkProfileFromConfigSteps(manager.config, chunk.chunkX, chunk.chunkZ, { cacheTreeCandidates: true, workBudget: 16 });
              const treeInstances = yield* generateTreeInstancesForChunkFromConfigSteps(manager.config, chunk.chunkX, chunk.chunkZ, profile, { workBudget: 16 });
              return { profile, treeInstances };
            })() };
            break;
          }
          const section = [...ensureRenderSections(chunk).values()].filter(section => section.dirty
            || section.visualDirty && performance.now() >= section.visualRetryAt)
            .sort((a, b) => (a.oldestDirtyAt ?? Infinity) - (b.oldestDirtyAt ?? Infinity))[0];
          if (!section) continue;
          const manager = this, sectionInput = { ...section }, visualOnly = !section.dirty;
          job = { chunk, section, kind: "section", baseProfile: chunk.baseProfile, baseBlocks: chunk.baseBlocks,
            rules: this.surfaceDecorationRulesSignature, revision: sectionRevision(section, this.materialVersion),
            cpuMs: 0, startedAt: performance.now(), iterator: (function* () {
              const inputs = yield* manager.captureSectionBuildInputs(chunk);
              return yield* buildRenderSectionSteps(inputs.chunk, sectionInput, inputs.access, { visualOnly, workBudget: 128 });
            })() };
          section.buildState = "fallback";
          break;
        }
        this.fallbackBuild = job;
        if (!job) break;
      }
      const job = this.fallbackBuild, startedAt = performance.now();
      let step;
      try { step = job.iterator.next(); }
      catch (error) {
        this.lastBuildError = error?.message || String(error);
        this.cancelFallbackBuild();
        job.chunk.markBuildError(error);
        this.recordWorkerBuildFailure(job.chunk, error);
        break;
      }
      job.cpuMs += performance.now() - startedAt;
      slices++; this.fallbackSlices++;
      if (!this.fallbackBuildIsCurrent(job)) { this.cancelFallbackBuild(); continue; }
      if (!step.done) continue;
      this.fallbackBuild = null;
      if (job.kind === "base") {
        job.chunk.setBaseProfile(step.value.profile, step.value.treeInstances,
          this.baseBlockResolverForChunk(job.chunk.chunkX, job.chunk.chunkZ, step.value.profile), { retainRenderSections: true });
      } else {
        const result = step.value;
        result.elapsedWallMs = performance.now() - job.startedAt;
        result.elapsedMs = job.cpuMs;
        if (commitRenderSection(job.chunk, job.section, result, job.revision)) rebuilt.push(job.chunk);
        this.sectionBuildVisits += result.voxelVisits;
        this.stageStats.record("mesh-build", job.cpuMs);
        this.logRenderEvent("section-build-cooperative", { chunkId: job.chunk.id, section: job.section.sectionIndex,
          revision: job.revision, elapsedMs: job.cpuMs, elapsedWallMs: result.elapsedWallMs, voxelVisits: result.voxelVisits,
          uniqueVoxelQueries: result.voxelQueries, visualError: result.visualError });
      }
    }
    return slices;
  }

  recoverTimedOutWorkers(now = performance.now()) {
    const expired = new Set();
    for (const task of this.inFlightBuilds?.values() ?? []) {
      if (task.computeReleased) continue;
      const awaitingWorker = !task.progressTerminal || task.receivedProgress.size < (task.progressiveJobs?.length ?? 0);
      if (awaitingWorker && now - (task.lastActivityAt ?? task.startedAt) > WORKER_TASK_TIMEOUT_MS) expired.add(task.worker);
    }
    for (const worker of expired) {
      this.workerTaskTimeouts++;
      this.handleWorkerError(worker, new Error("Chunk Worker task timed out."));
    }
    return expired.size;
  }

  cancelObsoleteWorkerTasks() {
    const cancelled = [...this.inFlightBuilds].filter(([, task]) => task.cancelled && !task.computeReleased);
    if (!cancelled.length) return 0;
    const previousSize = this.workers.length;
    for (const [taskId, task] of cancelled) {
      // The build Worker is synchronous inside one request. Termination, rather
      // than posting an unobservable cancel request, establishes ownership has
      // ended before its slot can be reused.
      this.terminateWorker(task.worker);
      this.workers = this.workers.filter(worker => worker !== task.worker);
      this.idleWorkers = this.idleWorkers.filter(worker => worker !== task.worker);
      task.pendingProgress?.clear();
      task.cancelState = "terminated";
      this.settleWorkerTask(taskId, task);
      this.cancelledWorkerTasks++;
    }
    if (this.useWorkers && !this.disposed && this.workers.length < Math.min(previousSize, this.activeBuildLimit)) {
      this.initWorkers(Math.min(previousSize, this.activeBuildLimit));
    }
    this.scheduleBuildDispatch();
    return cancelled.length;
  }

  rebuildDirtyChunks(budgetMs = DEFAULT_MESH_BUDGET_MS, { synchronousNearField = false, deadline = Infinity } = {}) {
    const start = performance.now();
    this.recoverTimedOutWorkers(start);
    budgetMs = Math.max(0, Math.min(budgetMs, deadline - start));
    if (!this.useWorkers) {
      const rebuilt = this.drainCompletedBuilds();
      this.advanceFallbackBuild(start + budgetMs, rebuilt);
      this.lastRebuildMs = performance.now() - start;
      return [...new Set(rebuilt)];
    }
    const progress = this.drainWorkerProgress(budgetMs);
    const rebuilt = this.drainCompletedBuilds();
    if (budgetMs <= 0 || progress && performance.now() - start >= budgetMs) { this.dispatchBuilds(); return rebuilt; }
    const dirty = Array.from(this.chunks.values())
      .filter((chunk) => chunk.dirty && chunk.buildState !== "queued" && chunk.buildState !== "building")
      .sort((a, b) => Math.max(Math.abs(a.chunkX - this.centerChunkX), Math.abs(a.chunkZ - this.centerChunkZ)) - Math.max(Math.abs(b.chunkX - this.centerChunkX), Math.abs(b.chunkZ - this.centerChunkZ)));
    for (const chunk of dirty) {
      if (!chunk.baseBlocksReady && this.restoreReusableMesh(chunk)) {
        rebuilt.push(chunk);
        if (performance.now()-start >= budgetMs) break;
        continue;
      }
      if (this.useWorkers) {
        if (chunk.buildState === "error" && !this.prepareWorkerBuildRetry(chunk, start)) continue;
        if (chunk.baseBlocksReady && chunk.renderSections) {
          const near=Math.max(Math.abs(chunk.chunkX-this.centerChunkX),Math.abs(chunk.chunkZ-this.centerChunkZ))<=1;
          // A section build is indivisible and can exceed the entire frame
          // budget. Interactive Worker clients keep the committed mesh visible
          // until a revision-checked replacement arrives. Explicit offline
          // callers may still request immediate synchronous compensation.
          if(near && synchronousNearField) {
            const sections=[...chunk.renderSections.values()].filter(section=>section.dirty&&section.mesh).sort((a,b)=>(a.oldestDirtyAt??Infinity)-(b.oldestDirtyAt??Infinity));
            for(const section of sections) {
              const revision=sectionRevision(section,this.materialVersion);
              const result=buildRenderSection(chunk,section,this.meshAccessForChunk(chunk));
              if(commitRenderSection(chunk,section,result,revision)){rebuilt.push(chunk);this.nearFieldRepairs++;}
              if(performance.now()-start>=budgetMs)break;
            }
          }
          this.enqueueRemesh(chunk);
        } else if (chunk.baseBlocksReady) this.enqueueRemesh(chunk);
        else this.enqueueBuild(chunk);
        if (performance.now() - start >= budgetMs) break;
        continue;
      }
    }
    this.lastRebuildMs = performance.now() - start;
    this.dispatchBuilds();
    return rebuilt;
  }

  getBlockAtWorld(worldX, worldY, worldZ) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    const chunk = this.chunks.get(coord.chunkId);
    if (chunk) {
      if (chunk.hasDeltaAt(coord.localX, coord.localY, coord.localZ)) return chunk.getFinalBlock(coord.localX, coord.localY, coord.localZ);
      if (chunk.baseBlocksReady) {
        const base = chunk.getBaseBlock(coord.localX, coord.localY, coord.localZ);
        if (base !== BLOCK_ID.air) return base;
        const loadedTreeBlock = this.getLoadedTreeBlockAtWorld(coord.worldX, coord.worldY, coord.worldZ);
        if (loadedTreeBlock !== null) return loadedTreeBlock;
        return getGeneratedTreeBlockAtConfig(this.config, coord.worldX, coord.worldY, coord.worldZ);
      }
    }
    return getBlockAtConfig(this.config, coord.worldX, coord.worldY, coord.worldZ);
  }

  getDeltaAtWorld(worldX, worldY, worldZ) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    const chunk = this.chunks.get(coord.chunkId);
    if (!chunk?.hasDeltaAt(coord.localX, coord.localY, coord.localZ)) return null;
    return chunk.getFinalBlock(coord.localX, coord.localY, coord.localZ);
  }

  treeDeltaCandidateCountForChunk(chunkX, chunkZ) {
    let count = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const chunk = this.chunks.get(chunkId(chunkX + dx, chunkZ + dz));
        count += chunk?.getFinalDeltaMap?.().size ?? 0;
      }
    }
    return count;
  }

  getOpaqueColumnTopAtWorld(worldX, worldZ) {
    const x = Math.trunc(worldX);
    const z = Math.trunc(worldZ);
    const coord = worldToChunk(x, 0, z, this.chunkSize);
    const chunk = this.chunks.get(coord.chunkId);
    const column=coord.localX+coord.localZ*this.chunkSize;
    let generatedTop = Math.min(this.minY+this.height-1,chunk?.baseProfile?.surfaceY?.[column] ?? terrainSurfaceHeight(this.config,x,z));
    if(chunk?.baseBlocks) {
      generatedTop=this.minY-1;
      for(let y=this.minY+this.height-1;y>=this.minY;y--)if(isTerrainMeshBlock(chunk.getBaseBlock(coord.localX,y,coord.localZ))){generatedTop=y;break;}
    }
    if (!chunk || !hasDeltas(chunk)) return generatedTop;
    ensureRenderSections(chunk);
    const columnRevision=chunk.renderColumnRevisions.get(column)??0;
    const cacheKey = `${coord.chunkId}:${coord.localX}:${coord.localZ}`;
    const cached = this.collisionColumnTopCache.get(cacheKey);
    if(cached?.chunk===chunk && cached.columnEpoch===chunk.renderColumnEpoch && cached.columnRevision===columnRevision) return cached.top;

    let affected = false;
    let candidateY = generatedTop;
    ensureRenderSections(chunk);
    for (const delta of chunk.renderDeltaColumns.get(coord.localX+coord.localZ*this.chunkSize)?.values() ?? []) {
      affected = true;
      if (isTerrainMeshBlock(delta.blockId)) candidateY = Math.max(candidateY, delta.localY);
    }
    if (!affected) {
      this.cacheCollisionColumnTop(cacheKey, chunk, generatedTop, columnRevision);
      return generatedTop;
    }

    const maxY = this.minY + this.height - 1;
    for (let y = Math.min(maxY, candidateY); y >= this.minY; y -= 1) {
      const blockId = chunk.baseBlocksReady
        ? chunk.getFinalBlock(coord.localX, y, coord.localZ)
        : this.getTerrainCollisionBlockAtWorld(x, y, z);
      if (!isTerrainMeshBlock(blockId)) continue;
      this.cacheCollisionColumnTop(cacheKey, chunk, y, columnRevision);
      return y;
    }
    const top = this.minY - 1;
    this.cacheCollisionColumnTop(cacheKey, chunk, top, columnRevision);
    return top;
  }

  getWaterLevelAtWorld(worldX, worldZ, surface = undefined) {
    const x = Math.trunc(worldX);
    const z = Math.trunc(worldZ);
    const terrainTop = Number.isFinite(Number(surface))
      ? Math.trunc(Number(surface))
      : this.getOpaqueColumnTopAtWorld(x, z);
    return waterLevelAt(this.config, x, z, terrainTop);
  }

  getCollisionBlockAtWorld(worldX, worldY, worldZ) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    if (this.supplementalCollisionProvider?.hasCollisionAtWorld?.(coord.worldX, coord.worldY, coord.worldZ)) {
      return BLOCK_ID.stone;
    }
    return this.getTerrainCollisionBlockAtWorld(coord.worldX, coord.worldY, coord.worldZ);
  }

  getTerrainCollisionBlockAtWorld(worldX, worldY, worldZ) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    const chunk = this.chunks.get(coord.chunkId);
    if (chunk) {
      if (chunk.hasDeltaAt(coord.localX, coord.localY, coord.localZ)) return collisionBlockId(chunk.getFinalBlock(coord.localX, coord.localY, coord.localZ));
      if (chunk.baseBlocksReady) {
        const base = collisionBlockId(chunk.getBaseBlock(coord.localX, coord.localY, coord.localZ));
        if (base !== BLOCK_ID.air) return base;
        const loadedTreeBlock = this.getLoadedTreeTrunkBlockAtWorld(coord.worldX, coord.worldY, coord.worldZ);
        if (loadedTreeBlock !== null) return loadedTreeBlock;
        return collisionBlockId(getGeneratedTreeTrunkBlockAtConfig(this.config, coord.worldX, coord.worldY, coord.worldZ));
      }
    }
    return collisionBlockId(getBlockAtConfig(this.config, coord.worldX, coord.worldY, coord.worldZ));
  }

  getCollisionTopAtWorld(worldX, worldZ, maxBlockY = Infinity) {
    const x = Math.floor(Number(worldX));
    const z = Math.floor(Number(worldZ));
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) return -Infinity;
    const cap = Number.isFinite(maxBlockY) ? Math.floor(maxBlockY) : Infinity;
    const supplementalTop = Number(this.supplementalCollisionProvider?.collisionTopAtWorld?.(x, z, cap));
    let top = Number.isFinite(supplementalTop) ? supplementalTop : -Infinity;
    const worldTop = this.minY + this.height - 1;
    const opaqueTop = this.getOpaqueColumnTopAtWorld(x, z);

    if (opaqueTop <= cap) {
      top = Math.max(top, opaqueTop + 1);
    } else {
      // A player below the opaque column top is inside edited terrain. Keep the
      // exact scan for this recovery path, but never pay for it on normal frames.
      for (let y = Math.min(worldTop, cap); y >= this.minY; y -= 1) {
        if (!isBlockingBlock(this.getTerrainCollisionBlockAtWorld(x, y, z))) continue;
        top = Math.max(top, y + 1);
        break;
      }
    }

    top = Math.max(top, this.getTreeCollisionTopAtWorld(x, z, cap));
    return top;
  }

  getTreeCollisionTopAtWorld(worldX, worldZ, maxBlockY = Infinity) {
    const x = Math.floor(Number(worldX));
    const z = Math.floor(Number(worldZ));
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) return -Infinity;
    const cap = Number.isFinite(maxBlockY) ? Math.floor(maxBlockY) : Infinity;
    const coord = worldToChunk(x, 0, z, this.chunkSize);
    const chunk = this.chunks.get(coord.chunkId);
    const loadedTree = chunk?.baseBlocksReady
      ? (chunk.treeInstances ?? []).find((tree) => tree.x === x && tree.z === z)
      : null;
    if (chunk?.baseBlocksReady && !loadedTree) return -Infinity;
    const surface = terrainSurfaceHeight(this.config, x, z);
    const baseY = loadedTree?.baseY ?? surface + 1;
    const maxY = loadedTree
      ? loadedTree.baseY + loadedTree.trunkHeight - 1
      : surface + MAX_GENERATED_TREE_TRUNK_HEIGHT;

    for (let y = Math.min(cap, maxY); y >= baseY; y -= 1) {
      if (isBlockingBlock(this.getTerrainCollisionBlockAtWorld(x, y, z))) return y + 1;
    }
    return -Infinity;
  }

  cacheCollisionColumnTop(key, chunk, top, columnRevision = null) {
    if (this.collisionColumnTopCache.size >= COLLISION_COLUMN_CACHE_LIMIT && !this.collisionColumnTopCache.has(key)) {
      this.collisionColumnTopCache.delete(this.collisionColumnTopCache.keys().next().value);
    }
    this.collisionColumnTopCache.set(key, {
      chunk,
      version: chunk.version,
      chainRevision: chunk.chainRevision,
      columnRevision,
      columnEpoch: chunk.renderColumnEpoch,
      top,
    });
  }

  isCameraOccluderAtWorld(worldX, worldY, worldZ) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    if (this.supplementalCollisionProvider?.hasCollisionAtWorld?.(coord.worldX, coord.worldY, coord.worldZ)) return true;
    const chunk = this.chunks.get(coord.chunkId);
    if (chunk?.baseBlocksReady) {
      // Hosts may replace the public voxel query. Keep that provider authoritative.
      if (this.getBlockAtWorld !== ChunkManager.prototype.getBlockAtWorld) {
        return isCameraOccluderBlock(this.getBlockAtWorld(coord.worldX, coord.worldY, coord.worldZ));
      }
      if (chunk.hasDeltaAt(coord.localX, coord.localY, coord.localZ)) {
        return isCameraOccluderBlock(chunk.getFinalBlock(coord.localX, coord.localY, coord.localZ));
      }
      const base = chunk.getBaseBlock(coord.localX, coord.localY, coord.localZ);
      if (base !== BLOCK_ID.air) return isCameraOccluderBlock(base);
      // Tree crowns only contain leaves, which cannot occlude the camera. Prove
      // the absence of a trunk without constructing/hash-testing those crowns.
      // Missing neighbors and possible trunks retain the full legacy query,
      // including its overlap order and generated fallback semantics.
      if (this.loadedTreesCannotOccludeCameraAtWorld(coord.worldX, coord.worldY, coord.worldZ)) return false;
      return isCameraOccluderBlock(this.getBlockAtWorld(coord.worldX, coord.worldY, coord.worldZ));
    }
    if (chunk?.hasDeltaAt(coord.localX, coord.localY, coord.localZ)) {
      return isCameraOccluderBlock(chunk.getFinalBlock(coord.localX, coord.localY, coord.localZ));
    }

    // Camera collision only needs an opaque terrain boundary while a worker is
    // still building this chunk. The cached height oracle avoids invoking the
    // full block/resource generator for every short sweep sample.
    return coord.worldY <= terrainSurfaceHeight(this.config, coord.worldX, coord.worldZ);
  }

  loadedTreesCannotOccludeCameraAtWorld(worldX, worldY, worldZ) {
    const min = worldToChunk(worldX - 2, worldY, worldZ - 2, this.chunkSize);
    const max = worldToChunk(worldX + 2, worldY, worldZ + 2, this.chunkSize);
    for (let z = min.chunkZ; z <= max.chunkZ; z++) for (let x = min.chunkX; x <= max.chunkX; x++) {
      const chunk = this.chunks.get(chunkId(x, z));
      if (!chunk?.baseBlocksReady) return false;
      for (const tree of chunk.treeInstances ?? []) {
        if (tree.x !== worldX || tree.z !== worldZ) continue;
        if (treeInstanceTrunkBlockAt(this.config, tree, worldX, worldY, worldZ) !== BLOCK_ID.air) return false;
      }
    }
    return true;
  }

  getLoadedTreeBlockAtWorld(worldX, worldY, worldZ) {
    const min = worldToChunk(worldX - 2, worldY, worldZ - 2, this.chunkSize);
    const max = worldToChunk(worldX + 2, worldY, worldZ + 2, this.chunkSize);
    let missingRootChunk = false;
    for (let chunkZ = min.chunkZ; chunkZ <= max.chunkZ; chunkZ += 1) {
      for (let chunkX = min.chunkX; chunkX <= max.chunkX; chunkX += 1) {
        const chunk = this.chunks.get(chunkId(chunkX, chunkZ));
        if (!chunk?.baseBlocksReady) {
          missingRootChunk = true;
          continue;
        }
        for (const tree of chunk.treeInstances ?? []) {
          if (Math.abs(Math.trunc(worldX) - tree.x) > 2 || Math.abs(Math.trunc(worldZ) - tree.z) > 2) continue;
          const block = treeInstanceBlockAt(this.config, tree, worldX, worldY, worldZ);
          if (block !== BLOCK_ID.air) return block;
        }
      }
    }
    return missingRootChunk ? null : BLOCK_ID.air;
  }

  getLoadedTreeTrunkBlockAtWorld(worldX, worldY, worldZ) {
    const root = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    const chunk = this.chunks.get(root.chunkId);
    if (!chunk?.baseBlocksReady) return null;
    for (const tree of chunk.treeInstances ?? []) {
      if (tree.x !== Math.trunc(worldX) || tree.z !== Math.trunc(worldZ)) continue;
      const block = treeInstanceTrunkBlockAt(this.config, tree, worldX, worldY, worldZ);
      if (block !== BLOCK_ID.air) return block;
    }
    return BLOCK_ID.air;
  }

  applyChainDelta(chunkKeyOrDeltas, maybeDeltas) {
    const startedAt=performance.now();
    const deltas = Array.isArray(chunkKeyOrDeltas) ? chunkKeyOrDeltas : maybeDeltas;
    const groups = groupDeltasByChunk(deltas, this);
    assertManagerResidentCapacity(groups, this, "chainDeltas");
    let changedChunks = 0;
    for (const group of groups.values()) {
      const chunk = this.ensureChunk(group.chunkX, group.chunkZ);
      const result = chunk.applyChainDelta(group.deltas);
      if (result.changed) changedChunks += 1;
      this.markBoundaryNeighborsDirty(chunk, result.boundaryMask, group.deltas);
    }
    this.stageStats.record("delta-merge",performance.now()-startedAt);
    return { changedChunks };
  }

  replaceChainDeltasForChunk(idOrChunk, deltas = [], options = {}) {
    const id = typeof idOrChunk === "string" ? idOrChunk : chunkId(idOrChunk?.chunkX ?? 0, idOrChunk?.chunkZ ?? 0);
    const chunk = this.chunks.get(id);
    if (!chunk) return { applied: false, reason: "chunk-unloaded", changed: false };
    const previous = Array.from(chunk.getFinalDeltaMap().values());
    const result = chunk.replaceChainDeltas(deltas, options);
    if (result.applied) this.markBoundaryNeighborsDirty(chunk, result.boundaryMask, [...previous,...deltas]);
    return result;
  }

  commitPreparedChainSnapshotForChunk(idOrChunk, preparation) {
    const id=typeof idOrChunk==="string"?idOrChunk:chunkId(idOrChunk?.chunkX??0,idOrChunk?.chunkZ??0);
    const chunk=this.chunks.get(id);
    if(!chunk||chunk!==preparation?.chunk)return {applied:false,reason:"chunk-unloaded",changed:false};
    const startedAt=performance.now();
    const result=chunk.commitPreparedChainSnapshot(preparation);
    this.stageStats.record("snapshot-commit",performance.now()-startedAt);
    if(result.applied&&!preparation.renderPlan?.handlesNeighborhood)this.markBoundaryNeighborsDirty(chunk,result.boundaryMask,preparation.changes);
    return result;
  }

  applyRemoteDelta(deltas, options={}) {
    const groups=groupDeltasByChunk(deltas,this);
    for(const group of groups.values()) {
      const chunk=this.chunks.get(chunkId(group.chunkX,group.chunkZ));
      if(!chunk)continue;
      const result=chunk.applyRemoteDelta(group.deltas,options);
      this.markBoundaryNeighborsDirty(chunk,result.boundaryMask,group.deltas);
    }
  }

  expireRemoteDeltas(now=Date.now()) {
    for(const chunk of this.remoteOverlayChunks) {
      if(this.chunks.get(chunk.id)!==chunk||!chunk.remoteDeltas.size){this.remoteOverlayChunks.delete(chunk);continue;}
      if(now<chunk.remoteDeltaExpiryAt)continue;
      const changes=[...chunk.remoteDeltas.values()].filter(delta=>delta.expiresAt<=now);
      const result=chunk.expireRemoteDeltas(now);
      if(result.changed&&!chunk.onRemoteDeltasExpired)this.markBoundaryNeighborsDirty(chunk,result.boundaryMask,changes);
    }
  }

  acknowledgeChainSnapshotForChunk(idOrChunk, options = {}) {
    const id = typeof idOrChunk === "string" ? idOrChunk : chunkId(idOrChunk?.chunkX ?? 0, idOrChunk?.chunkZ ?? 0);
    return this.chunks.get(id)?.acknowledgeChainSnapshot?.(options) ?? false;
  }

  resetChainSnapshotAuthority() {
    for (const chunk of this.chunks.values()) chunk.resetChainSnapshotAuthority?.();
  }

  clearChainDeltas(chunkIds = null) {
    let cleared = 0;
    const ids = chunkIds ? new Set(chunkIds) : null;
    for (const chunk of this.chunks.values()) {
      if (ids && !ids.has(chunk.id)) continue;
      const previous = Array.from(chunk.chainDeltas.values());
      const result = chunk.clearChainDeltas();
      if (!result) continue;
      cleared += 1;
      this.markBoundaryNeighborsDirty(chunk, result.boundaryMask, previous);
    }
    return cleared;
  }

  applyPendingDelta(chunkKeyOrDeltas, maybeDeltas, maybeTxId) {
    const startedAt=performance.now();
    const deltas = Array.isArray(chunkKeyOrDeltas) ? chunkKeyOrDeltas : maybeDeltas;
    const txId = Array.isArray(chunkKeyOrDeltas) ? maybeDeltas : maybeTxId;
    const groups = groupDeltasByChunk(deltas, this);
    assertManagerResidentCapacity(groups, this, "pendingDeltas");
    for (const group of groups.values()) {
      const chunk = this.ensureChunk(group.chunkX, group.chunkZ);
      const result = chunk.applyPendingDelta(group.deltas, txId);
      this.markBoundaryNeighborsDirty(chunk, result.boundaryMask, group.deltas);
    }
    this.stageStats.record("delta-merge",performance.now()-startedAt);
  }

  confirmPendingDelta(txId, confirmation = {}) {
    for (const chunk of this.chunks.values()) chunk.confirmPendingDelta(txId, confirmation);
  }

  rollbackPendingDelta(txId) {
    for (const chunk of this.chunks.values()) {
      const changes = [...chunk.pendingDeltas.values()].filter(delta => delta.txId === txId);
      const result = chunk.rollbackPendingDelta(txId);
      if (result.rolledBack) this.markBoundaryNeighborsDirty(chunk, result.boundaryMask, changes);
    }
  }

  markBoundaryNeighborsDirty(chunk, boundaryMask = 0, deltas = null) {
    const mask = Math.trunc(Number(boundaryMask) || 0);
    if (!chunk) return 0;
    const lit=deltas?.length?this.invalidateLightingDependencies(chunk,deltas):new Set();
    if(!mask)return 0;
    let dirtied = 0;
    const mark = (chunkX, chunkZ) => {
      const neighbor = this.chunks.get(chunkId(chunkX, chunkZ));
      if (!neighbor) return;
      if(deltas?.length)invalidateRenderSections(neighbor,deltas.map(d=>({worldX:d.worldX,worldY:d.worldY,worldZ:d.worldZ,localY:d.localY??d.worldY})),"geometry-halo");
      if(!lit.has(neighbor))neighbor.markDirty();
      else neighbor.renderInvalidationPending=false;
      dirtied += 1;
    };
    if (mask & CHUNK_BOUNDARY_MASK.NEGATIVE_X) mark(chunk.chunkX - 1, chunk.chunkZ);
    if (mask & CHUNK_BOUNDARY_MASK.POSITIVE_X) mark(chunk.chunkX + 1, chunk.chunkZ);
    if (mask & CHUNK_BOUNDARY_MASK.NEGATIVE_Z) mark(chunk.chunkX, chunk.chunkZ - 1);
    if (mask & CHUNK_BOUNDARY_MASK.POSITIVE_Z) mark(chunk.chunkX, chunk.chunkZ + 1);
    if ((mask & CHUNK_BOUNDARY_MASK.NEGATIVE_X) && (mask & CHUNK_BOUNDARY_MASK.NEGATIVE_Z)) mark(chunk.chunkX - 1, chunk.chunkZ - 1);
    if ((mask & CHUNK_BOUNDARY_MASK.NEGATIVE_X) && (mask & CHUNK_BOUNDARY_MASK.POSITIVE_Z)) mark(chunk.chunkX - 1, chunk.chunkZ + 1);
    if ((mask & CHUNK_BOUNDARY_MASK.POSITIVE_X) && (mask & CHUNK_BOUNDARY_MASK.NEGATIVE_Z)) mark(chunk.chunkX + 1, chunk.chunkZ - 1);
    if ((mask & CHUNK_BOUNDARY_MASK.POSITIVE_X) && (mask & CHUNK_BOUNDARY_MASK.POSITIVE_Z)) mark(chunk.chunkX + 1, chunk.chunkZ + 1);
    return dirtied;
  }

  ensureChunkForDelta(delta) {
    const normalized = normalizeDelta(delta, this.chunkSize);
    assertDeltaInBuildRange(normalized, this.config.minY, this.config.maxBuildY);
    return this.ensureChunk(normalized.chunkX, normalized.chunkZ);
  }

  surfaceYAt(worldX, worldZ) {
    const x = Math.floor(Number(worldX) || 0);
    const z = Math.floor(Number(worldZ) || 0);
    for (let y = this.minY + this.height - 1; y >= this.minY; y -= 1) {
      const block = this.getBlockAtWorld(x, y, z);
      if (isBlockingBlock(block)) return y + 1;
    }
    return this.minY + 1;
  }

  stats() {
    let triangles = 0;
    let vertices = 0;
    let uploaded = 0;
    let ready = 0;
    let visualTriangles = 0;
    let visualVertices = 0;
    let visualUploaded = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.baseBlocksReady) ready += 1;
      if (chunk.mesh) {
        triangles += chunk.mesh.triangleCount;
        vertices += chunk.mesh.vertexCount;
        uploaded += chunk.gpuUploaded ? 1 : 0;
      }
      if (chunk.visualMesh) {
        visualTriangles += chunk.visualMesh.triangleCount;
        visualVertices += chunk.visualMesh.vertexCount;
        visualUploaded += chunk.visualGpuUploaded ? 1 : 0;
      }
    }
    return {
      chunks: this.chunks.size,
      reusableMeshBytes: this.reusableMeshBytes,
      reusableMeshChunks: this.reusableMeshes.size,
      reusedMeshChunks: this.reusedMeshChunks,
      ready,
      uploaded,
      triangles,
      vertices,
      visualUploaded,
      visualTriangles,
      visualVertices,
      lastRebuildMs: this.lastRebuildMs,
      lastWorkerBuildMs: this.lastWorkerBuildMs,
      buildQueue: this.buildQueue.length,
      inFlightBuilds: this.inFlightBuilds.size,
      computingJobs: [...this.inFlightBuilds.values()].filter(task => !task.computeReleased).length,
      readyResults: [...this.inFlightBuilds.values()].filter(task => task.computeReleased).length,
      workers: this.workers.length,
      lastBuildError: this.lastBuildError,
      failedBuilds: this.workerBuildFailures.size,
      staleBuildResults: this.staleBuildResults,
      sectionBuildVisits: this.sectionBuildVisits,
      nearFieldRepairs: this.nearFieldRepairs,
      progressiveSectionsCommitted: this.progressiveSectionsCommitted,
      progressivePacketsQueued: [...this.inFlightBuilds.values()].reduce((sum, task) => sum + (task.pendingProgress?.size ?? 0), 0),
      progressiveBytesQueued: [...this.inFlightBuilds.values()].reduce((sum, task) => sum + (task.progressBytesQueued ?? 0), 0),
      workerTaskTimeouts: this.workerTaskTimeouts,
      cancelledWorkerTasks: this.cancelledWorkerTasks,
      fallbackSlices: this.fallbackSlices,
      fallbackCancelled: this.fallbackCancelled,
      fallbackActive: Boolean(this.fallbackBuild),
      remoteOverlayChunks: this.remoteOverlayChunks.size,
      cpuStages: this.stageStats.snapshot(),
    };
  }

  diagnostics({maxEntries=64}={}) {
    const entries=[],arrays=new Set();let cpuMeshBytes=0,oldestDirtyMs=0;
    for(const chunk of this.chunks.values()) {
    for(const summary of [chunk.mesh,chunk.visualMesh])for(const array of summary?.materializedArrays??[])if(!arrays.has(array.buffer)){arrays.add(array.buffer);cpuMeshBytes+=array.buffer.byteLength;}
    for(const unit of chunk.renderSections?.values()??[chunk]) {
      for(const mesh of [unit.mesh,unit.visualMesh])if(mesh&&!mesh.sectionSummary)for(const array of [mesh.vertices,mesh.indices])if(array&&!arrays.has(array.buffer)){arrays.add(array.buffer);cpuMeshBytes+=array.buffer.byteLength;}
      const age=unit.oldestDirtyAt==null?0:performance.now()-unit.oldestDirtyAt;oldestDirtyMs=Math.max(oldestDirtyMs,age);
      if(entries.length<Math.min(256,Math.max(0,maxEntries)))entries.push({id:unit.id,generation:unit.generation,worldVersion:chunk.version,authorityInputRevision:chunk.authorityInputRevision,dataRevision:unit.dataRevision,haloRevision:unit.haloRevision,lightRevision:unit.lightRevision,meshVersion:unit.meshVersion,visualMeshVersion:unit.visualMeshVersion,gpuUploaded:unit.gpuUploaded,visualGpuUploaded:unit.visualGpuUploaded,dirty:unit.dirty,visualDirty:unit.visualDirty,dirtyReason:unit.dirtyReason,ageMs:age,visualError:unit.visualError});
    }
    }
    return {...this.stats(),cpuMeshBytes,oldestDirtyMs,columnTopCacheEntries:this.collisionColumnTopCache.size,entries};
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFallbackBuild();
    if (this.dispatchTimer !== null) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
    for (const worker of this.workers) this.terminateWorker(worker);
    this.workers = [];
    this.idleWorkers = [];
    this.buildQueue.length = 0;
    this.buildQueueNeedsSort = false;
    this.inFlightBuilds.clear();
    this.settledWorkerTaskIds = new WeakMap();
    this.completedBuilds.length = 0;
    this.workerBuildFailures.clear();
    this.remoteOverlayChunks.clear();
    this.consecutiveWorkerFailures = 0;
    this.dispatchScheduled = false;
    for(const chunk of this.chunks.values())for(const section of chunk.renderSections?.values()??[]){section.buildState="ready";section.buildTaskId=null;}
    this.useWorkers = false;
    this.workerCount = 0;
    this.activeBuildLimit = 0;
    this.chunks.clear();
    this.visibilityOrder = null;
    this.reusableMeshes.clear();this.reusableMeshBytes=0;
    this.pickedSurfaceColumnsByChunk.clear();
    this.visibleChunkMemory.clear();
    this.collisionColumnTopCache.clear();
    this.supplementalCollisionProvider = null;
    this.renderLogger = null;
  }

  logRenderEvent(type, data = {}) {
    this.renderLogger?.record?.(type, data);
  }

  initWorkers(targetCount = this.workerCount) {
    if (this.disposed || !this.useWorkers) return false;
    try {
      const requested = boundedManagerInteger(targetCount, 0, CHUNK_MANAGER_LIMITS.maxWorkers, "worker pool target");
      const target = Math.min(this.workerCount, requested);
      for (let i = this.workers.length; i < target; i += 1) {
        const worker = new Worker(this.workerUrl, { type: "module" });
        try {
          worker.onmessage = (event) => this.handleWorkerMessage(worker, event.data);
          worker.onerror = (event) => this.handleWorkerError(worker, event);
          worker.onmessageerror = (event) => this.handleWorkerError(worker, event, { allowRestart: false });
          worker.postMessage({
            type: "setSurfaceDecorationRules",
            rules: this.surfaceDecorationRules.rules,
            revision: this.surfaceDecorationRulesRevision,
          });
          this.workers.push(worker);
          this.idleWorkers.push(worker);
        } catch (error) {
          this.terminateWorker(worker);
          throw error;
        }
      }
      return this.workers.length >= target;
    } catch (error) {
      this.disableWorkerMode(error);
      return false;
    }
  }

  terminateWorker(worker) {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch {
      // A failed Worker may already be terminated by the browser.
    }
  }

  recoverWorkerTasks(worker, error) {
    let recovered = 0;
    for (const [taskId, task] of Array.from(this.inFlightBuilds.entries())) {
      if (task.worker !== worker || task.computeReleased) continue;
      const chunk = this.chunks.get(task.id);
      for (const job of task.sectionJobs ?? [{sectionIndex:task.sectionIndex}]) {
        const section=chunk?.renderSections?.get(job.sectionIndex);
        if(section&&section.buildTaskId===taskId){section.buildTaskId=null;section.buildState="ready";}
      }
      const obsolete = task.cancelled
        || !chunk
        || (task.phase === "chunk" && chunk.buildTaskId !== taskId);
      if (!obsolete && task.phase === "visual" && chunk.mesh) {
        this.logRenderEvent("visual-build-error", {
          chunkX: task.chunkX,
          chunkZ: task.chunkZ,
          error: error?.message || String(error),
        });
      } else if (!obsolete) {
        chunk.markBuildError(error);
        this.recordWorkerBuildFailure(chunk, error);
      }
      this.rememberSettledWorkerTask(worker, taskId);
      this.inFlightBuilds.delete(taskId);
      recovered += 1;
    }
    return recovered;
  }

  rememberSettledWorkerTask(worker, taskId) {
    if (!worker || !Number.isSafeInteger(taskId)) return;
    let taskIds = this.settledWorkerTaskIds.get(worker);
    if (!taskIds) {
      taskIds = new Set();
      this.settledWorkerTaskIds.set(worker, taskIds);
    }
    taskIds.add(taskId);
    while (taskIds.size > 64) taskIds.delete(taskIds.values().next().value);
  }

  settleWorkerTask(taskId, task) {
    if (!task || this.inFlightBuilds.get(taskId) !== task) return false;
    this.inFlightBuilds.delete(taskId);
    this.rememberSettledWorkerTask(task.worker, taskId);
    return true;
  }

  validateWorkerResponse(worker, message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { error: new Error("Chunk worker returned an invalid message.") };
    }
    const taskId = message.taskId;
    if (!Number.isSafeInteger(taskId) || taskId < 1) {
      return { error: new Error("Chunk worker response has an invalid task ID.") };
    }
    const task = this.inFlightBuilds.get(taskId);
    if (!task) {
      if (this.settledWorkerTaskIds.get(worker)?.has(taskId)) return { late: true };
      return { error: new Error(`Chunk worker response references unknown task ${taskId}.`) };
    }
    if (task.worker !== worker) {
      return { error: new Error(`Chunk worker response does not own task ${taskId}.`) };
    }
    if (message.chunkX !== task.chunkX || message.chunkZ !== task.chunkZ) {
      return { error: new Error(`Chunk worker response coordinates do not match task ${taskId}.`) };
    }
    const phase = workerResponsePhase(message.type);
    if (!phase || phase !== task.phase) {
      return { error: new Error(`Chunk worker response type ${String(message.type)} is invalid during the ${task.phase} phase of task ${taskId}.`) };
    }
    if (message.type === "chunkBuilt" || message.type === "chunkProgress" || message.type === "visualBuilt") {
      if (message.taskVersion !== task.version || message.materialVersion !== task.materialVersion) {
        return { error: new Error(`Chunk worker response versions do not match task ${taskId}.`) };
      }
      if ((message.type === "chunkBuilt" || message.type === "chunkProgress") && message.mode !== task.mode) {
        return { error: new Error(`Chunk worker response mode does not match task ${taskId}.`) };
      }
    }
    return { task };
  }

  disableWorkerMode(error = "chunk workers are unavailable") {
    if (this.disposed) return;
    this.lastBuildError = error?.message || String(error);
    if (this.dispatchTimer !== null) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
    this.dispatchScheduled = false;
    for (const task of this.inFlightBuilds.values()) {
      const chunk = this.chunks.get(task.id);
      chunk?.markBuildError(this.lastBuildError);
      if (chunk) this.recordWorkerBuildFailure(chunk, this.lastBuildError);
    }
    for (const worker of this.workers) this.terminateWorker(worker);
    for (const chunk of this.chunks.values()) {
      if (chunk.buildState === "queued" || chunk.buildState === "building" || chunk.buildState === "error") {
        chunk.markBuildStale();
      }
    }
    this.workers = [];
    this.idleWorkers = [];
    this.buildQueue.length = 0;
    this.inFlightBuilds.clear();
    for(const chunk of this.chunks.values())for(const section of chunk.renderSections?.values()??[]){section.buildState="ready";section.buildTaskId=null;}
    this.useWorkers = false;
    this.workerCount = 0;
    this.activeBuildLimit = 0;
  }

  markWorkerIdle(worker) {
    if (!this.workers.includes(worker) || this.idleWorkers.includes(worker)) return;
    this.idleWorkers.push(worker);
  }

  enqueueBuild(chunk) {
    if (!this.useWorkers || !chunk || chunk.baseBlocksReady || chunk.buildState === "queued" || chunk.buildState === "building") return false;
    if (this.buildQueue.length >= this.maxQueuedBuilds) return false;
    chunk.markQueued();
    const queuedAt = performance.now();
    this.buildQueue.push({ id: chunk.id, chunkX: chunk.chunkX, chunkZ: chunk.chunkZ, queuedAt, mode: "base", version: chunk.version });
    this.buildQueueNeedsSort = true;
    this.logRenderEvent("chunk-build-queued", {
      chunkId: chunk.id,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      queueLength: this.buildQueue.length,
    });
    return true;
  }

  enqueueRemesh(chunk) {
    // If authority/material inputs supersede the first base build, none of its
    // sections has ever been published. Rebuild that initial snapshot as one
    // batch instead of paying one Worker round trip for every empty height layer.
    if(chunk?.renderSections && chunk.mesh)return this.enqueueSectionBuilds(chunk);
    if (!this.useWorkers || !chunk?.baseBlocksReady || !chunk.dirty || chunk.buildState === "queued" || chunk.buildState === "building") return false;
    if (this.buildQueue.length >= this.maxQueuedBuilds) return false;
    chunk.markQueued();
    const queuedAt = performance.now();
    this.buildQueue.push({
      id: chunk.id,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      queuedAt,
      mode: "remesh",
      version: chunk.version,
    });
    this.buildQueueNeedsSort = true;
    this.logRenderEvent("chunk-remesh-queued", {
      chunkId: chunk.id,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      version: chunk.version,
      deltaCount: chunk.chainDeltas.size + chunk.pendingDeltas.size,
      queueLength: this.buildQueue.length,
    });
    return true;
  }

  takeNextBuildTask(now = performance.now()) {
    const serial = this.buildDispatchSerial = (this.buildDispatchSerial ?? 0) + 1;
    let index = 0;
    // Reserve one of eight selections for genuinely waiting columns. An old
    // dirty timestamp on a repeatedly serviced edit must not monopolize this
    // lane, and a capped distance/age score alone cannot guarantee progress.
    if (serial % 8 === 0) {
      let oldest = now - 2000;
      for (let candidate = 0; candidate < this.buildQueue.length; candidate++) {
        const task = this.buildQueue[candidate], chunk = this.chunks.get(task.id);
        if (!chunk) continue;
        const waitingSince = Math.max(task.queuedAt ?? now, chunk.lastBuildDispatchAt ?? -Infinity);
        if (waitingSince < oldest) { oldest = waitingSince; index = candidate; }
      }
    }
    return this.buildQueue.splice(index, 1)[0];
  }

  dispatchBuilds() {
    if (!this.useWorkers || !this.idleWorkers.length || !this.buildQueue.length) return;
    const activeLimit = Math.max(0, Math.min(this.workerCount, Math.trunc(this.activeBuildLimit || 0)));
    const computingCount = () => [...this.inFlightBuilds.values()].filter(task => !task.computeReleased).length;
    const ready = [...this.inFlightBuilds.values()].filter(task => task.computeReleased);
    if (ready.length >= 24 || ready.reduce((sum, task) => sum + (task.progressBytesQueued || 0), 0) >= 64 * 1024 * 1024) return;
    if (computingCount() >= activeLimit) return;
    if (this.buildQueueNeedsSort || performance.now() - this.lastBuildQueueSortAt >= 100) {
      const now = performance.now();
      for(const task of this.buildQueue)task.dispatchPriority=taskPriority(task,this,now);
      this.buildQueue.sort((a, b) => a.dispatchPriority - b.dispatchPriority);
      this.buildQueueNeedsSort = false;
      this.lastBuildQueueSortAt = now;
    }
    while (this.idleWorkers.length && this.buildQueue.length && computingCount() < activeLimit) {
      const worker = this.idleWorkers.pop();
      const task = this.takeNextBuildTask();
      const chunk = this.chunks.get(task.id);
      if(task.mode==="section") {
        if(!chunk||chunk!==task.chunk||!this.dispatchSectionBuild(worker,task,chunk))this.idleWorkers.push(worker);
        continue;
      }
      const staleBase = task.mode !== "remesh" && chunk?.baseBlocksReady;
      const staleRemesh = task.mode === "remesh" && (!chunk?.baseBlocksReady || !chunk.dirty);
      if (!chunk || staleBase || staleRemesh) {
        if (chunk && staleRemesh && chunk.buildState === "queued") chunk.markBuildStale();
        this.idleWorkers.push(worker);
        continue;
      }
      // A base build may wait in the queue while initial world deltas arrive.
      // Snapshot the latest revision at dispatch so the first mesh can include
      // those deltas instead of immediately scheduling an identical remesh.
      task.version = chunk.version;
      let finalDeltas;
      let neighborDeltas;
      let treeDeltas;
      try {
        finalDeltas = packedFinalDeltasForWorker(chunk);
        neighborDeltas = this.neighborDeltasForWorker(chunk.chunkX, chunk.chunkZ);
        treeDeltas = this.treeNeighborDeltasForWorker(chunk.chunkX, chunk.chunkZ);
      } catch (error) {
        this.lastBuildError = error?.message || String(error);
        chunk.markBuildError(error);
        this.recordWorkerBuildFailure(chunk, error);
        this.markWorkerIdle(worker);
        continue;
      }
      const taskId = this.taskSerial++;
      const startedAt = performance.now();
      chunk.lastBuildDispatchAt = startedAt;
      const waitMs = Number.isFinite(task.queuedAt) ? startedAt - task.queuedAt : 0;
      const progressiveJobs = [...ensureRenderSections(chunk, { initializeColumnTops: chunk.baseBlocksReady }).values()]
        .map(section => ({ sectionIndex: section.sectionIndex, sectionRevision: sectionRevision(section, this.materialVersion) }));
      chunk.markBuilding(taskId);
      this.inFlightBuilds.set(taskId, {
        worker,
        chunk,
        id: chunk.id,
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        queuedAt: task.queuedAt,
        startedAt,
        waitMs,
        mode: task.mode || "base",
        version: task.version,
        includesFinalDeltas: true,
        reusableBase: !finalDeltas.length && !neighborDeltas.length && !treeDeltas.length && this.reusableMeshNeighborhoodIsClean(chunk),
        materialVersion: this.materialVersion,
        phase: "chunk",
        cancelled: false,
        progressiveJobs,
        pendingProgress: new Map(),
        receivedProgress: new Set(),
        nextProgressToApply: 0,
        baseProfileAtStart: chunk.baseProfile,
        baseBlocksAtStart: chunk.baseBlocks,
      });
      this.logRenderEvent("chunk-build-start", {
        chunkId: chunk.id,
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        waitMs,
        queueLength: this.buildQueue.length,
      });
      const message = {
        type: "buildChunk",
        taskId,
        worldSeed: new Uint8Array(managerWorldSeed(this)),
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        generationVersion: this.generationVersion,
        resourceRuleVersion: this.resourceRuleVersion,
        materialVersion: this.materialVersion,
        options: this.workerOptions(),
        mode: task.mode || "base",
        taskVersion: task.version,
        progressiveSections: true,
        sectionJobs: progressiveJobs,
        preferredSectionY: this.buildCamera ? (this.buildCamera.targetWorldY ?? this.buildCamera.worldY)
          + (this.buildCamera.targetLocalOffsetY ?? this.buildCamera.localOffsetY ?? 0) : undefined,
        baseProfile: task.mode === "remesh" ? chunk.baseProfile : null,
        treeInstances: task.mode === "remesh" && chunk.baseProfile ? chunk.treeInstances : null,
        finalDeltas,
        pickedSurfaceColumns: chunk.pickedSurfaceColumns,
        neighborDeltas,
        treeDeltas,
        lightingDeltas: this.visualDeltasForWorker(chunk.chunkX,chunk.chunkZ,this.shadows?SUNLIGHT_HORIZONTAL_REACH:8),
        columnTopHalo: this.captureWorkerColumnTopHalo(chunk),
      };
      const transfer = [];
      if (finalDeltas.byteLength) transfer.push(finalDeltas.buffer);
      if (neighborDeltas.byteLength) transfer.push(neighborDeltas.buffer);
      if (treeDeltas.byteLength) transfer.push(treeDeltas.buffer);
      if (message.columnTopHalo) transfer.push(message.columnTopHalo.tops.buffer);
      if (message.columnTopHalo?.columns) transfer.push(message.columnTopHalo.columns.buffer);
      if (message.lightingDeltas.byteLength) transfer.push(message.lightingDeltas.buffer);
      try {
        worker.postMessage(message, transfer);
      } catch (error) {
        this.handleWorkerError(worker, error, { allowRestart: false });
        return;
      }
    }
  }

  scheduleBuildDispatch() {
    if (this.disposed || this.dispatchScheduled || !this.useWorkers || !this.continuousBuildDispatch) return;
    this.dispatchScheduled = true;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.dispatchScheduled = false;
      if (this.disposed) return;
      this.dispatchBuilds();
    }, 0);
  }

  handleWorkerMessage(worker, message) {
    if (this.disposed || !this.workers.includes(worker)) return;
    const validation = this.validateWorkerResponse(worker, message);
    if (validation.late) {
      this.logRenderEvent("chunk-worker-late-response", {
        taskId: message.taskId,
        type: message.type,
      });
      return;
    }
    if (validation.error) {
      this.handleWorkerError(worker, validation.error);
      return;
    }
    const task = validation.task;
    task.lastActivityAt = performance.now();
    if (task.progressiveJobs && (message.type === "chunkProgress" || message.progressComplete === true)) {
      try { this.queueWorkerProgress(task, message); }
      catch (error) { this.handleWorkerError(worker, error); }
      return;
    }
    const chunk = this.chunks.get(task.id);
    if (task.phase === "chunk" && (!chunk || (task.sectionJobs
      ? chunk!==task.chunk || !task.sectionJobs.some(job=>chunk.renderSections?.get(job.sectionIndex)?.buildTaskId===message.taskId)
      : task.sectionIndex!==undefined ? chunk!==task.chunk||chunk.renderSections?.get(task.sectionIndex)?.buildTaskId!==message.taskId : chunk.buildTaskId!==message.taskId))) task.cancelled = true;

    if (message.type === "chunkBuildError" || message.type === "visualBuildError") {
      const error = new Error(message.error || (message.type === "visualBuildError" ? "Visual build failed." : "Chunk build failed."));
      if (message.type === "visualBuildError") {
        this.logRenderEvent("visual-build-error", {
          chunkX: task.chunkX,
          chunkZ: task.chunkZ,
          error: error.message,
        });
      }
      this.handleWorkerError(worker, error);
      return;
    }

    this.consecutiveWorkerFailures = 0;
    if (message.type === "chunkBuilt") {
      try {
        if (!task.cancelled) this.applyWorkerBuildResult(message, task);
        if (message.visualError) {
          this.logRenderEvent("visual-build-error", {
            chunkX: task.chunkX,
            chunkZ: task.chunkZ,
            error: message.visualError,
          });
        }
      } catch (error) {
        this.handleWorkerError(worker, error);
        return;
      }
      if (message.visualPending === true) {
        task.phase = "visual";
      } else if (this.settleWorkerTask(message.taskId, task)) {
        this.markWorkerIdle(worker);
      }
      this.scheduleBuildDispatch();
      return;
    }

    try {
      if (!task.cancelled) this.applyWorkerVisualResult(message, task);
    } catch (error) {
      this.handleWorkerError(worker, error);
      return;
    }
    if (this.settleWorkerTask(message.taskId, task)) this.markWorkerIdle(worker);
    this.scheduleBuildDispatch();
  }

  queueWorkerProgress(task, message) {
    const count = task.progressiveJobs.length;
    if (message.progressComplete === true) {
      if (message.progressMessageCount !== count) throw new Error("Invalid progressive Worker terminal count.");
      task.progressTerminal = message;
      this.releaseComputedWorkerTask(task);
      return;
    }
    const sequence = message.progressSequence;
    const results = message.sectionResults;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= count
      || !Array.isArray(results) || results.length < 1 || results.length > 8 || sequence + results.length > count) {
      throw new Error("Invalid progressive Worker section packet.");
    }
    if (results.every((_, index) => task.receivedProgress.has(sequence + index))) return;
    task.receivedProgressSections ??= new Set();
    const packetSections = new Set();
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const job = task.progressiveJobs.find(candidate => candidate.sectionIndex === result?.sectionIndex);
      if (!job || result.sectionRevision !== job.sectionRevision || task.receivedProgress.has(sequence + index)
        || task.receivedProgressSections.has(result.sectionIndex) || packetSections.has(result.sectionIndex)
        || sequence !== 0 && message.baseProfile
        || results.length > 1 && (result.mesh?.indexCount || result.visualMesh?.indexCount || result.visualError)) {
        throw new Error("Progressive Worker section does not match its captured job.");
      }
      packetSections.add(result.sectionIndex);
    }
    const receivedAt = performance.now();
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const sectionMessage = results.length === 1 ? message : { ...message, progressSequence: sequence + index,
        baseProfile: index === 0 ? message.baseProfile : null, treeInstances: index === 0 ? message.treeInstances : null,
        sectionResults: [result] };
      sectionMessage.receivedAt = receivedAt;
      task.receivedProgress.add(sequence + index);
      task.receivedProgressSections.add(result.sectionIndex);
      task.pendingProgress.set(sequence + index, sectionMessage);
      task.progressBytesQueued = (task.progressBytesQueued ?? 0) + progressivePacketBytes(sectionMessage);
    }
    task.firstProgressReceivedAt ??= receivedAt;
    this.releaseComputedWorkerTask(task);
  }

  releaseComputedWorkerTask(task) {
    if (task.computeReleased || !task.progressTerminal || task.receivedProgress.size !== task.progressiveJobs.length) return false;
    task.computeReleased = true;
    task.computedAt = performance.now();
    this.markWorkerIdle(task.worker);
    this.scheduleBuildDispatch();
    return true;
  }

  ensureChainPresentation(id) {
    const chunk = this.chunks.get(id);
    if (!chunk?.baseBlocksReady) return false;
    if (!chunk.renderSections) { if (!chunk.mesh) { chunk.dirty = true; return true; } return false; }
    let missing = false;
    for (const section of chunk.renderSections.values()) {
      if (!section.mesh && !section.dirty) { section.dirty = true; section.visualDirty = true; section.oldestDirtyAt ??= performance.now(); missing = true; }
      if (!section.visualMesh && !section.visualDirty) { section.visualDirty = true; section.oldestDirtyAt ??= performance.now(); missing = true; }
    }
    if (missing) chunk.dirty = true;
    return missing;
  }

  drainWorkerProgress(budgetMs = 1, { maxPackets = 64 } = {}) {
    const startedAt = performance.now();
    if (budgetMs <= 0 || !this.inFlightBuilds?.size) return 0;
    const tasks = [...this.inFlightBuilds.entries()].filter(([, task]) => task.progressiveJobs);
    if (!tasks.length) return 0;
    let committed = 0, packets = 0, advanced = true;
    const first = (this.progressDrainCursor ?? 0) % tasks.length;
    this.progressDrainCursor = first + 1;
    while (advanced && packets < maxPackets) {
      advanced = false;
      for (let offset = 0; offset < tasks.length; offset++) {
        const [taskId, task] = tasks[(first + offset) % tasks.length];
        if (!this.inFlightBuilds.has(taskId)) continue;
        const chunk = this.chunks.get(task.id);
        if (chunk !== task.chunk) task.cancelled = true;
        if (task.cancelled) { task.pendingProgress.clear(); task.progressBytesQueued = 0; }
        const ownsChunk = chunk === task.chunk && (chunk.buildTaskId === taskId || !task.baseAdopted);
        const message = task.pendingProgress.get(task.nextProgressToApply);
        // Host reserves service; an expired low-level deadline remains strict.
        if (message && packets < maxPackets && performance.now() - startedAt < budgetMs) {
          task.pendingProgress.delete(task.nextProgressToApply++);
          task.progressBytesQueued = Math.max(0, (task.progressBytesQueued ?? 0) - progressivePacketBytes(message));
          packets++; advanced = true;
          if (!task.baseAdopted) {
            if (chunk.baseProfile !== task.baseProfileAtStart || chunk.baseBlocks !== task.baseBlocksAtStart) task.cancelled = true;
            if (!task.cancelled && message.baseProfile) {
              chunk.setBaseProfile(message.baseProfile, message.treeInstances,
                this.baseBlockResolverForChunk(chunk.chunkX, chunk.chunkZ, message.baseProfile), { retainRenderSections: true });
              // Tree owners were unknown before the first generated profile.
              // An intervening edit can touch a crown in another section. Keep
              // all other captured sections usable and retry these owners.
              if (chunk.version !== task.version) for (const tree of chunk.treeInstances) {
                const section = chunk.renderSections.get(Math.floor((tree.baseY - chunk.minY) / 16));
                if (section) { section.dataRevision++; section.haloRevision++; section.dirty = true; section.visualDirty = true; }
              }
            }
            task.baseAdopted = true;
            if (chunk === task.chunk && chunk.buildTaskId == null) chunk.markBuilding(taskId);
          }
          if (!task.cancelled && message.materialVersion === this.materialVersion) {
            const result = message.sectionResults[0];
            const section = chunk.renderSections.get(result.sectionIndex);
            const changesGeometry = section?.mesh?.indexCount || section?.visualMesh?.indexCount
              || result.mesh?.indexCount || result.visualMesh?.indexCount || result.visualError;
            const updateSummary = task.mode !== "base" || Boolean(changesGeometry);
            if (section && commitRenderSection(chunk, section, result, result.sectionRevision, { updateSummary })) {
              committed++; this.progressiveSectionsCommitted++;
              this.completedBuilds.push(chunk);
              this.logRenderEvent("section-worker-progress", { chunkId: chunk.id, section: section.sectionIndex,
                taskId, cpuReadyAt: section.meshReadyAt, receivedAt: message.receivedAt,
                applyWaitMs: performance.now() - message.receivedAt, elapsedMs: performance.now() - task.startedAt,
                first: task.firstSectionCommittedAt == null });
              task.firstSectionCommittedAt ??= performance.now();
            } else this.staleBuildResults++;
          }
          if (ownsChunk) chunk.markBuilding(taskId);
        }
        if (task.progressTerminal && (task.cancelled || task.nextProgressToApply === task.progressiveJobs.length)) {
          if (chunk === task.chunk && chunk.buildTaskId === taskId) {
            chunk.buildTaskId = null;
            chunk.buildState = chunk.baseBlocksReady ? "ready" : "empty";
            if (!task.cancelled) {
              updateChunkSectionSummary(chunk);
              if (task.reusableBase && !chunk.dirty) chunk.reusableBaseVersion = chunk.version;
              this.workerBuildFailures.delete(chunk.id);
              this.consecutiveWorkerFailures = 0;
            }
          }
          this.lastWorkerBuildMs = Number(task.progressTerminal.elapsedMs) || 0;
          if (this.settleWorkerTask(taskId, task) && !task.computeReleased) this.markWorkerIdle(task.worker);
          this.scheduleBuildDispatch();
        }
      }
      if (performance.now() - startedAt >= budgetMs) break;
    }
    this.stageStats.record("worker-progress-commit", performance.now() - startedAt);
    return committed;
  }

  handleWorkerError(worker, event, { allowRestart = true } = {}) {
    if (this.disposed) return;
    const knownWorker = this.workers.includes(worker)
      || this.idleWorkers.includes(worker)
      || Array.from(this.inFlightBuilds.values()).some((task) => task.worker === worker);
    if (!knownWorker) return;
    const error = event instanceof Error ? event : new Error(event?.message || "chunk worker failed");
    this.lastBuildError = error.message;
    const previousPoolSize = this.workers.length;
    this.recoverWorkerTasks(worker, error);
    this.idleWorkers = this.idleWorkers.filter((candidate) => candidate !== worker);
    this.workers = this.workers.filter((candidate) => candidate !== worker);
    this.terminateWorker(worker);
    this.consecutiveWorkerFailures += 1;
    if (!allowRestart || this.consecutiveWorkerFailures >= MAX_CONSECUTIVE_WORKER_FAILURES) {
      this.disableWorkerMode(error);
      return;
    }
    const replacementTarget = Math.min(
      this.workerCount,
      Math.max(1, this.activeBuildLimit, previousPoolSize),
    );
    if (this.workers.length < replacementTarget) this.initWorkers(replacementTarget);
    if (!this.useWorkers || !this.workers.length) {
      this.disableWorkerMode(error);
      return;
    }
    this.scheduleBuildDispatch();
  }

  applyWorkerBuildResult(message, timingTask = null) {
    const chunk = this.chunks.get(chunkId(message.chunkX, message.chunkZ));
    if (timingTask?.sectionJobs) {
      if (chunk !== timingTask.chunk) return;
      const results = message.sectionResults ? new Map(message.sectionResults.map(result=>[result.sectionIndex,result]))
        : new Map([[message.sectionIndex ?? timingTask.sectionIndex,message]]);
      let changed = false;
      for (const job of timingTask.sectionJobs) {
        const section = chunk.renderSections?.get(job.sectionIndex), result = results.get(job.sectionIndex);
        if (!section || section.buildTaskId !== message.taskId) continue;
        if (result && result.sectionRevision === job.sectionRevision && commitRenderSection(chunk,section,result,job.sectionRevision,{updateSummary:false})) changed = true;
        else { section.buildState="ready";section.buildTaskId=null;this.staleBuildResults++; }
      }
      if (changed) {
        updateChunkSectionSummary(chunk);
        this.completedBuilds.push(chunk);
      }
      return;
    }
    if(timingTask?.sectionIndex!==undefined) {
      const section=chunk?.renderSections?.get(timingTask.sectionIndex);
      if(!section||chunk!==timingTask.chunk||section.buildTaskId!==message.taskId)return;
      if(message.sectionRevision!==timingTask.sectionRevision||!commitRenderSection(chunk,section,message,timingTask.sectionRevision)) {
        section.buildState="ready";section.buildTaskId=null;this.staleBuildResults++;
      } else this.completedBuilds.push(chunk);
      return;
    }
    if (!chunk || chunk.buildTaskId !== message.taskId) return;
    if(message.sectionResults) {
      if(message.baseProfile)chunk.setBaseProfile(message.baseProfile,message.treeInstances,this.baseBlockResolverForChunk(message.chunkX,message.chunkZ,message.baseProfile));
      const sections=ensureRenderSections(chunk);
      if(!timingTask || (chunk===timingTask.chunk&&chunk.version===timingTask.version&&message.materialVersion===this.materialVersion)) {
        for(const result of message.sectionResults){const section=sections.get(result.sectionIndex);if(section)commitRenderSection(chunk,section,result,sectionRevision(section,this.materialVersion),{updateSummary:false});}
        updateChunkSectionSummary(chunk);
        if (timingTask?.reusableBase) chunk.reusableBaseVersion=chunk.version;
        this.completedBuilds.push(chunk);
      } else {chunk.markBuildStale();this.staleBuildResults++;}
      return;
    }
    this.workerBuildFailures.delete(chunk.id);
    if (timingTask && (chunk.version !== timingTask.version || message.taskVersion !== timingTask.version || message.materialVersion !== this.materialVersion)) {
      if (!chunk.baseBlocksReady && message.baseProfile) {
        chunk.setBaseProfile(message.baseProfile, message.treeInstances, this.baseBlockResolverForChunk(message.chunkX, message.chunkZ, message.baseProfile));
      }
      chunk.markBuildStale();
      return;
    }
    if (timingTask?.mode === "remesh") {
      if (chunk.version !== timingTask.version || message.taskVersion !== timingTask.version) {
        chunk.markBuildStale();
        return;
      }
      this.lastWorkerBuildMs = Number(message.elapsedMs) || 0;
      this.commitLegacyWorkerMeshes(chunk,message,timingTask.version);
      this.logWorkerBuildDone("chunk-remesh-done", chunk, message, timingTask);
      this.completedBuilds.push(chunk);
      return;
    }
    if (message.baseProfile) chunk.setBaseProfile(message.baseProfile, message.treeInstances, this.baseBlockResolverForChunk(message.chunkX, message.chunkZ, message.baseProfile));
    else chunk.setBaseBlocks(message.baseBlocks, message.treeInstances);
    this.lastWorkerBuildMs = Number(message.elapsedMs) || 0;
    if (hasDeltas(chunk) && timingTask?.includesFinalDeltas !== true) {
      chunk.markDirty();
      return;
    }
    this.commitLegacyWorkerMeshes(chunk,message,timingTask?.version ?? message.taskVersion);
    this.logWorkerBuildDone("chunk-build-done", chunk, message, timingTask);
    this.completedBuilds.push(chunk);
  }

  applyWorkerVisualResult(message, timingTask = null) {
    const chunk = this.chunks.get(chunkId(message.chunkX, message.chunkZ));
    if (!chunk || !chunk.mesh) return;
    if (message.materialVersion !== this.materialVersion) return;
    if (timingTask?.mode === "remesh") {
      if (chunk.version !== timingTask.version || message.taskVersion !== timingTask.version) return;
    } else if (timingTask && chunk.version !== timingTask.version) {
      return;
    } else if (hasDeltas(chunk) && timingTask?.includesFinalDeltas !== true) {
      return;
    }
    chunk.setVisualMesh(message.visualMesh, timingTask?.version ?? message.taskVersion);
    const timings = message.timings || {};
    this.logRenderEvent("visual-build-done", {
      chunkId: chunk.id,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      elapsedMs: Number(timings.visualMeshMs) || Number(message.elapsedMs) || 0,
      totalMs: Number(message.elapsedMs) || 0,
      waitMs: timingTask?.waitMs ?? 0,
      baseMs: Number(timings.baseMs) || 0,
      treeMs: Number(timings.treeMs) || 0,
      opaqueMeshMs: Number(timings.opaqueMeshMs) || 0,
      visualMeshMs: Number(timings.visualMeshMs) || 0,
      triangles: message.visualMesh?.triangleCount || 0,
      bytes: (message.visualMesh?.vertices?.byteLength || 0) + (message.visualMesh?.indices?.byteLength || 0),
    });
  }

  logWorkerBuildDone(type, chunk, message, timingTask = null) {
    const timings = message.timings || {};
    this.logRenderEvent(type, {
      chunkId: chunk.id,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      version: timingTask?.version ?? chunk.version,
      elapsedMs: Number(message.elapsedMs) || 0,
      waitMs: timingTask?.waitMs ?? 0,
      totalMs: (timingTask?.waitMs ?? 0) + (Number(message.elapsedMs) || 0),
      baseMs: Number(timings.baseMs) || 0,
      treeMs: Number(timings.treeMs) || 0,
      opaqueMeshMs: Number(timings.opaqueMeshMs) || 0,
      visualMeshMs: Number(timings.visualMeshMs) || 0,
      triangles: (message.mesh?.triangleCount || 0) + (message.visualMesh?.triangleCount || 0),
      bytes: (message.mesh?.vertices?.byteLength || 0) + (message.mesh?.indices?.byteLength || 0) + (message.visualMesh?.vertices?.byteLength || 0) + (message.visualMesh?.indices?.byteLength || 0) + profileByteLength(message.baseProfile),
    });
  }

  drainCompletedBuilds() {
    if (!this.completedBuilds.length) return [];
    const out = [...new Set(this.completedBuilds.filter((chunk) => this.chunks.get(chunk.id) === chunk))];
    this.completedBuilds.length = 0;
    return out;
  }

  prepareWorkerBuildRetry(chunk, now = performance.now()) {
    const failure = this.workerBuildFailures.get(chunk?.id);
    if (failure && now < failure.retryAt) return false;
    chunk?.markBuildStale?.();
    return true;
  }

  recordWorkerBuildFailure(chunk, error) {
    if (!chunk) return;
    const previous = this.workerBuildFailures.get(chunk.id);
    const count = Math.max(1, (previous?.count || 0) + 1);
    const retryDelayMs = Math.min(WORKER_BUILD_RETRY_MAX_MS, WORKER_BUILD_RETRY_BASE_MS * (2 ** Math.min(5, count - 1)));
    this.workerBuildFailures.set(chunk.id, {
      count,
      retryAt: performance.now() + retryDelayMs,
      error: error?.message || String(error || "chunk worker build failed"),
    });
  }

  ensureChunkBaseSync(chunk) {
    if (!chunk || chunk.baseBlocksReady) return chunk;
    const baseProfile = generateBaseChunkProfileFromConfig(this.config, chunk.chunkX, chunk.chunkZ, { cacheTreeCandidates: true });
    const treeInstances = generateTreeInstancesForChunkFromConfig(this.config, chunk.chunkX, chunk.chunkZ, baseProfile);
    chunk.setBaseProfile(baseProfile, treeInstances, this.baseBlockResolverForChunk(chunk.chunkX, chunk.chunkZ, baseProfile));
    chunk.dirty = true;
    return chunk;
  }

  baseBlockResolverForChunk(chunkX, chunkZ, profile = null) {
    const coordinateX = Math.trunc(chunkX);
    const coordinateZ = Math.trunc(chunkZ);
    return (localX, localY, localZ) => {
      const x = Math.trunc(localX);
      const z = Math.trunc(localZ);
      const worldX = chunkLocalToWorldI32(coordinateX, x, this.chunkSize);
      const worldZ = chunkLocalToWorldI32(coordinateZ, z, this.chunkSize);
      if (profile?.surfaceY && profile?.waterY) {
        const column = x + z * this.chunkSize;
        const storedWater = profile.waterY[column];
        return getBaseBlockAtColumnConfig(
          this.config,
          worldX,
          localY,
          worldZ,
          profile.surfaceY[column],
          storedWater === profile.noWater ? null : storedWater,
          profile.surfaceBlock?.[column],
        );
      }
      return getBaseBlockAtConfig(this.config, worldX, localY, worldZ);
    };
  }

  workerOptions() {
    return {
      chunkSize: this.chunkSize,
      height: this.height,
      minY: this.minY,
      maxBuildY: this.maxBuildY,
      seaLevel: this.seaLevel,
      maxTerrainHeight: this.maxTerrainHeight,
      renderSections: true,
      shadows: this.shadows,
      generationVersion: this.generationVersion,
      resourceRuleVersion: this.resourceRuleVersion,
    };
  }

  neighborDeltasForWorker(chunkX, chunkZ, sectionIndex = null) {
    const values=[];
    for(const delta of this.neighborDeltaValues(chunkX,chunkZ,sectionIndex))appendWorkerDelta(values,delta);
    return packDeltaValues(values);
  }

  neighborDeltaValues(chunkX, chunkZ, sectionIndex = null) {
    const deltas = [];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const chunk = this.chunks.get(chunkId(chunkX + dx, chunkZ + dz));
        if (!chunk) continue;
        for (const delta of sectionIndex===null?finalDeltaValues(chunk):sectionDeltaValues(chunk,sectionIndex)) {
          if (!deltaTouchesTargetBoundary(delta, dx, dz, this.chunkSize)) continue;
          if(deltas.length>=DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries)throw workerDeltaLimitError();
          deltas.push(delta);
        }
      }
    }
    return deltas;
  }

  treeNeighborDeltasForWorker(chunkX, chunkZ, sectionIndex = null) {
    return this.visualDeltasForWorker(chunkX,chunkZ,6,sectionIndex);
  }

  visualDeltasForWorker(chunkX,chunkZ,margin,sectionIndex = null) {
    const values=[],radius=Math.ceil(margin/this.chunkSize);
    for(let dz=-radius;dz<=radius;dz++)for(let dx=-radius;dx<=radius;dx++) {
      if(dx===0&&dz===0)continue;
      const chunk=this.chunks.get(chunkId(chunkX+dx,chunkZ+dz));if(!chunk)continue;
      for(const delta of sectionIndex===null?finalDeltaValues(chunk):sectionDeltaValues(chunk,sectionIndex)) {
        const x=delta.worldX-chunkX*this.chunkSize,z=delta.worldZ-chunkZ*this.chunkSize;
        if(x>=-margin&&z>=-margin&&x<this.chunkSize+margin&&z<this.chunkSize+margin)appendWorkerDelta(values,delta);
      }
    }
    return packDeltaValues(values);
  }

}

function chunkDistance(chunk, center) {
  return Math.max(Math.abs(chunk.chunkX - center.chunkX), Math.abs(chunk.chunkZ - center.chunkZ));
}

function chunkPriority(chunk, center, manager) {
  return offsetPriority(chunk.chunkX - center.chunkX, chunk.chunkZ - center.chunkZ, manager.loadDirX, manager.loadDirZ) + chunkDistance(chunk, center) * 0.01;
}

function chunkVisibleInCameraCone(chunk, cameraState, manager) {
  const chunkSize = manager.chunkSize || DEFAULT_CHUNK_SIZE;
  const cx = chunk.chunkX * chunkSize + chunkSize * 0.5;
  const cz = chunk.chunkZ * chunkSize + chunkSize * 0.5;
  const cameraX = Math.trunc(cameraState.worldX || 0) + (cameraState.localOffsetX || 0);
  const cameraZ = Math.trunc(cameraState.worldZ || 0) + (cameraState.localOffsetZ || 0);
  const dx = cx - cameraX;
  const dz = cz - cameraZ;
  const distance = Math.hypot(dx, dz);
  if (distance <= chunkSize * 2.2) return true;

  const forward = cameraForwardXZ(cameraState);
  if (!forward) return true;
  const invDistance = 1 / Math.max(0.0001, distance);
  const dot = (dx * invDistance) * forward[0] + (dz * invDistance) * forward[1];
  const verticalFov = ((Number(cameraState.fov) || 58) * Math.PI) / 180;
  const aspect = Math.max(0.8, Math.min(2.4, Number(cameraState.aspect) || 1.6));
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * aspect);
  const chunkPadding = Math.atan((chunkSize * 1.35) / Math.max(chunkSize, distance));
  const safetyPadding = 0.34;
  return dot >= Math.cos(horizontalFov * 0.5 + chunkPadding + safetyPadding);
}

function visibilityCenterChunk(cameraState, chunkSize) {
  return cameraRenderCenterChunk(cameraState, chunkSize);
}

function cameraForwardXZ(cameraState) {
  let dx = 0;
  let dz = 0;
  if (Number.isFinite(cameraState.targetWorldX) && Number.isFinite(cameraState.targetWorldZ)) {
    const cameraX = Math.trunc(cameraState.worldX || 0) + (cameraState.localOffsetX || 0);
    const cameraZ = Math.trunc(cameraState.worldZ || 0) + (cameraState.localOffsetZ || 0);
    const targetX = Math.trunc(cameraState.targetWorldX || 0) + (cameraState.targetLocalOffsetX || 0);
    const targetZ = Math.trunc(cameraState.targetWorldZ || 0) + (cameraState.targetLocalOffsetZ || 0);
    dx = targetX - cameraX;
    dz = targetZ - cameraZ;
  } else {
    const yaw = Number(cameraState.yaw) || 0;
    const pitch = Number(cameraState.pitch) || 0;
    const cp = Math.cos(pitch);
    dx = Math.sin(yaw) * cp;
    dz = Math.cos(yaw) * cp;
  }
  const length = Math.hypot(dx, dz);
  if (length <= 0.0001) return null;
  return [dx / length, dz / length];
}

function buildLoadOffsets(viewDistance, dirX, dirZ) {
  const offsets = [];
  for (let dz = -viewDistance; dz <= viewDistance; dz += 1) {
    for (let dx = -viewDistance; dx <= viewDistance; dx += 1) {
      offsets.push({ dx, dz, priority: offsetPriority(dx, dz, dirX, dirZ) });
    }
  }
  offsets.sort((a, b) => a.priority - b.priority);
  return offsets;
}

function taskPriority(task, manager, now) {
  const age = Math.max(0, now - (task.queuedAt ?? now));
  const near = Math.max(Math.abs(task.chunkX-manager.centerChunkX),Math.abs(task.chunkZ-manager.centerChunkZ)) <= 1;
  // Nearby edits must reach a Worker before an old background streaming ring;
  // they no longer receive an unbudgeted main-thread compensation build.
  const remeshPriority = near && (task.mode === "remesh" || task.mode === "section") ? -50000 : 0;
  const chunk=manager.chunks.get(task.id);
  const center=manager.buildCameraCenter;
  const inView=manager.buildCamera && chunk && center
    && Math.max(Math.abs(task.chunkX-center.chunkX),Math.abs(task.chunkZ-center.chunkZ))<=manager.viewDistance
    && (near || manager.chunkInBuildFrustum(chunk));
  const visiblePriority=manager.buildCamera && (near||inView) ? -20000 : 0;
  const predictive = manager.maxPredictivePreloadChunks > 0
    && (manager.prefetchChunkX !== manager.centerChunkX || manager.prefetchChunkZ !== manager.centerChunkZ)
    && Math.max(Math.abs(task.chunkX-manager.prefetchChunkX),Math.abs(task.chunkZ-manager.prefetchChunkZ)) <= manager.viewDistance;
  return remeshPriority + visiblePriority + (predictive ? -8000 : 0) + offsetPriority(task.chunkX - manager.centerChunkX, task.chunkZ - manager.centerChunkZ, manager.loadDirX, manager.loadDirZ) - Math.min(40000, age * 4);
}

function offsetPriority(dx, dz, dirX, dirZ) {
  const forward = dx * dirX + dz * dirZ;
  const lateral = Math.abs(-dx * dirZ + dz * dirX);
  const distance = Math.max(Math.abs(dx), Math.abs(dz));
  const behindPenalty = forward < -0.35 ? 180 + Math.min(120, Math.abs(forward) * 12) : 0;
  return distance * 1000 + behindPenalty + lateral * 8 - forward * 6;
}

function directionBucketKey(directionX, directionZ) {
  const length = Math.hypot(directionX || 0, directionZ || 0);
  if (length < 0.0001) return "idle";
  const angle = Math.atan2(directionZ / length, directionX / length);
  return String((Math.round(angle / (Math.PI / 4)) + 8) % 8);
}

function hasDeltas(chunk) {
  return Boolean(chunk?.chainDeltas?.size || chunk?.pendingDeltas?.size || chunk?.remoteDeltas?.size);
}

function groupDeltasByChunk(deltas, manager) {
  const source = deltas ?? [];
  if (Array.isArray(source) && source.length > DELTA_RESOURCE_LIMITS.maxBatchEntries) {
    throw deltaBatchEntryLimitError();
  }
  const groups = new Map();
  let entryCount = 0;
  for (const rawDelta of source) {
    entryCount += 1;
    if (entryCount > DELTA_RESOURCE_LIMITS.maxBatchEntries) throw deltaBatchEntryLimitError();
    const delta = normalizeDelta(rawDelta, manager.chunkSize);
    assertDeltaInBuildRange(delta, manager.config.minY, manager.config.maxBuildY);
    const id = chunkId(delta.chunkX, delta.chunkZ);
    let group = groups.get(id);
    if (!group) {
      if (groups.size >= DELTA_RESOURCE_LIMITS.maxBatchChunks) {
        throw new RangeError(
          `Delta batch touches more than the ${DELTA_RESOURCE_LIMITS.maxBatchChunks}-chunk safety limit.`,
        );
      }
      group = { chunkX: delta.chunkX, chunkZ: delta.chunkZ, deltas: [] };
      groups.set(id, group);
    }
    group.deltas.push(delta);
  }
  return groups;
}

function assertManagerResidentCapacity(groups, manager, targetMapName) {
  const otherMapName = targetMapName === "chainDeltas" ? "pendingDeltas" : "chainDeltas";
  for (const [id, group] of groups) {
    const chunk = manager.chunks.get(id);
    const target = chunk?.[targetMapName];
    const otherSize = chunk?.[otherMapName]?.size ?? 0;
    let targetSize = target?.size ?? 0;
    const addedKeys = new Set();
    for (const delta of group.deltas) {
      const key = deltaKey(delta.localX, delta.localY, delta.localZ, manager.chunkSize);
      if (target?.has(key) || addedKeys.has(key)) continue;
      addedKeys.add(key);
      targetSize += 1;
      if (targetSize + otherSize > DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk) {
        throw residentDeltaLimitError(id);
      }
    }
    if (targetSize + otherSize > DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk) {
      throw residentDeltaLimitError(id);
    }
  }
}

function assertDeltaInBuildRange(delta, minY, maxY) {
  if (delta.worldY < minY || delta.worldY > maxY) {
    throw new RangeError(
      `Delta world Y must be an integer from the configured build minimum ${minY} to maximum ${maxY}.`,
    );
  }
  return delta;
}

function deltaBatchEntryLimitError() {
  return new RangeError(
    `Delta batch exceeds the ${DELTA_RESOURCE_LIMITS.maxBatchEntries}-entry safety limit.`,
  );
}

function residentDeltaLimitError(id) {
  return new RangeError(
    `Chunk ${id} exceeds the ${DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk}-entry resident delta safety limit.`,
  );
}

function finalDeltaValues(chunk) {
  if (typeof chunk?.getFinalDeltaMap === "function") return chunk.getFinalDeltaMap().values();
  if (!chunk?.pendingDeltas?.size) return chunk?.chainDeltas?.values?.() ?? [];
  const merged = new Map(chunk?.chainDeltas ?? []);
  for (const [key, delta] of chunk.pendingDeltas) merged.set(key, delta);
  return merged.values();
}

function packedFinalDeltasForWorker(chunk) {
  if (typeof chunk?.getFinalDeltaMap === "function") {
    const deltas = chunk.getFinalDeltaMap();
    return packDeltaValues(deltas.values(), deltas.size);
  }
  return packDeltaValues(finalDeltaValues(chunk));
}

function packDeltaValues(values, knownCount = Array.isArray(values) ? values.length : null) {
  if (knownCount !== null) {
    if (!Number.isSafeInteger(knownCount) || knownCount < 0) {
      throw new RangeError("Worker delta payload length must be a non-negative safe integer.");
    }
    if (knownCount > DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries) throw workerDeltaLimitError();
    return packKnownDeltaValues(values ?? [], knownCount);
  }

  const source = [];
  for (const delta of values ?? []) appendWorkerDelta(source, delta);
  return packKnownDeltaValues(source, source.length);
}

function packKnownDeltaValues(values, count) {
  if (!count) return new Int32Array(0);
  const packed = new Int32Array(count * 4);
  let offset = 0;
  let packedCount = 0;
  for (const delta of values) {
    if (packedCount >= count) {
      throw new RangeError("Worker delta collection grew while it was being packed.");
    }
    packed[offset++] = packedDeltaInteger(delta?.worldX, DELTA_PROTOCOL_LIMITS.minWorldXZ, DELTA_PROTOCOL_LIMITS.maxWorldXZ, "world X");
    packed[offset++] = packedDeltaInteger(delta?.worldY, DELTA_PROTOCOL_LIMITS.minWorldY, DELTA_PROTOCOL_LIMITS.maxWorldY, "world Y");
    packed[offset++] = packedDeltaInteger(delta?.worldZ, DELTA_PROTOCOL_LIMITS.minWorldXZ, DELTA_PROTOCOL_LIMITS.maxWorldXZ, "world Z");
    packed[offset++] = packedDeltaInteger(delta?.blockId, DELTA_PROTOCOL_LIMITS.minBlockId, DELTA_PROTOCOL_LIMITS.maxBlockId, "block ID");
    packedCount += 1;
  }
  if (packedCount !== count) throw new RangeError("Worker delta collection shrank while it was being packed.");
  return packed;
}

function appendWorkerDelta(target, delta) {
  if (target.length >= DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries) throw workerDeltaLimitError();
  target.push(delta);
}

function workerDeltaLimitError() {
  return new RangeError(
    `Worker delta payload exceeds the ${DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries}-entry safety limit.`,
  );
}

function packedDeltaInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Worker delta ${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function deltaTouchesTargetBoundary(delta, neighborDx, neighborDz, chunkSize) {
  if (neighborDx < 0 && delta.localX !== chunkSize - 1) return false;
  if (neighborDx > 0 && delta.localX !== 0) return false;
  if (neighborDz < 0 && delta.localZ !== chunkSize - 1) return false;
  if (neighborDz > 0 && delta.localZ !== 0) return false;
  return true;
}

function deltaTouchesTargetVisualMargin(delta, neighborDx, neighborDz, chunkSize, margin) {
  const width = Math.max(1, Math.min(Math.trunc(margin) || 1, chunkSize));
  if (neighborDx < 0 && delta.localX < chunkSize - width) return false;
  if (neighborDx > 0 && delta.localX >= width) return false;
  if (neighborDz < 0 && delta.localZ < chunkSize - width) return false;
  if (neighborDz > 0 && delta.localZ >= width) return false;
  return true;
}

function profileByteLength(profile) {
  if (!profile) return 0;
  return (profile.surfaceY?.byteLength || 0)
    + (profile.waterY?.byteLength || 0)
    + (profile.surfaceBlock?.byteLength || 0);
}

function collisionBlockId(blockId) {
  if (blockId === BLOCK_ID.leaves || blockId === BLOCK_ID.pineLeaves) return BLOCK_ID.air;
  return blockId;
}

function isTerrainMeshBlock(blockId) {
  return blockId !== BLOCK_ID.cactus && isOpaqueSolidBlock(blockId);
}

function decorationRulesSignature(rules) {
  return rules.map((rule) => [
    rule.ruleId,
    rule.decorationId,
    rule.surfaceBlockId,
    rule.dropBlockId,
    rule.rollStartBps,
    rule.rollEndBps,
    rule.minY,
    rule.maxY,
    rule.salt,
    rule.variant,
    rule.flags,
  ].join(":" )).join("|");
}

function defaultWorkerCount() {
  if (typeof Worker === "undefined") return 0;
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 4;
  const coarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  if (coarse) return Math.max(1, Math.min(3, cores - 1));
  return Math.max(1, Math.min(6, cores - 2));
}

function normalizeWorkerUrl(value) {
  if (value === null || value === undefined) return new URL("./chunk-build-worker.js", import.meta.url);
  if (value instanceof URL) return new URL(value.href);
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Chunk worker URL must be a non-empty string or URL.");
  }
  return value;
}

function workerResponsePhase(type) {
  if (type === "chunkBuilt" || type === "chunkProgress" || type === "chunkBuildError") return "chunk";
  if (type === "visualBuilt" || type === "visualBuildError") return "visual";
  return null;
}

function boundedManagerInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function managerWorldSeed(manager) {
  const seed = managerWorldSeeds.get(manager);
  if (!seed) throw new Error("ChunkManager world seed is unavailable.");
  return seed;
}

function progressivePacketBytes(message) {
  let bytes=0;
  for(const result of message.sectionResults ?? []) for(const mesh of [result.mesh,result.visualMesh]) {
    bytes += (mesh?.vertices?.byteLength ?? 0) + (mesh?.indices?.byteLength ?? 0);
  }
  if(message.baseProfile) for(const key of ['surfaceY','waterY','surfaceBlock']) bytes += message.baseProfile[key]?.byteLength ?? 0;
  for(const tree of message.treeInstances ?? []) bytes += tree.leafMasks?.byteLength ?? 0;
  return bytes;
}
