import { DEFAULT_CHUNK_HEIGHT, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_TERRAIN_HEIGHT, DEFAULT_MESH_BUDGET_MS, DEFAULT_MIN_WORLD_Y, DEFAULT_SEA_LEVEL, DEFAULT_VIEW_DISTANCE } from "../core/constants.js";
import { chunkId, worldToChunk } from "../core/coordinates.js";
import { isBlockingBlock, isOpaqueSolidBlock, BLOCK_ID } from "../world/block-registry.js";
import { compileSurfaceDecorationRules } from "../world/surface-decoration-rules.js";
import {
  chunkLocalToWorldI32,
  createWorldGeneratorConfig,
  DEFAULT_GENERATION_VERSION,
  DEFAULT_RESOURCE_RULE_VERSION,
  generateBaseChunkProfileFromConfig,
  generateTreeInstancesForChunkFromConfig,
  getBaseBlockAtColumnConfig,
  getBaseBlockAtConfig,
  getBlockAt,
  getGeneratedTreeBlockAt,
  getGeneratedTreeTrunkBlockAt,
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
import { ensureRenderSections, buildRenderSection, commitRenderSection, sectionRevision, sectionDeltaValues, invalidateRenderSections, prepareRenderSnapshotInvalidation } from "./render-sections.js";
import { chunkIntersectsCameraFrustum } from "../renderer/frustum.js";
import { RenderStageStats } from "../debug/stats.js";

const DEFAULT_MAX_BUILD_QUEUE = 768;
const DEFAULT_VISIBILITY_LINGER_FRAMES = 12;
const VISIBILITY_CLEANUP_INTERVAL_FRAMES = 45;
const INITIAL_BUILD_CONCURRENCY = 1;
const WORKER_BUILD_RETRY_BASE_MS = 180;
const WORKER_BUILD_RETRY_MAX_MS = 5000;
const MAX_CONSECUTIVE_WORKER_FAILURES = 3;
const COLLISION_COLUMN_CACHE_LIMIT = 4096;
const MAX_GENERATED_TREE_TRUNK_HEIGHT = 7;
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
    useWorkers = typeof Worker !== "undefined",
    workerCount = defaultWorkerCount(),
    workerUrl = null,
    deferInitialBuilds = false,
    deferContinuousBuildDispatch = false,
    maxQueuedBuilds = DEFAULT_MAX_BUILD_QUEUE,
    visibilityLingerFrames = DEFAULT_VISIBILITY_LINGER_FRAMES,
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
    this.seaLevel = this.config.seaLevel;
    this.maxTerrainHeight = this.config.maxTerrainHeight;
    this.generationVersion = this.config.generationVersion;
    this.resourceRuleVersion = this.config.resourceRuleVersion;
    this.materialVersion = materialVersion;
    this.surfaceDecorationRules = compileSurfaceDecorationRules(surfaceDecorationRules);
    this.surfaceDecorationRulesRevision = 0;
    this.surfaceDecorationRulesSignature = decorationRulesSignature(this.surfaceDecorationRules.rules);
    this.chunks = new Map();
    this.centerChunkX = 0;
    this.centerChunkZ = 0;
    this.loadDirX = 0;
    this.loadDirZ = 1;
    this.loadDirectionKey = directionBucketKey(this.loadDirX, this.loadDirZ);
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
    this.inFlightBuilds = new Map();
    this.settledWorkerTaskIds = new WeakMap();
    this.completedBuilds = [];
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
    this.surfaceDecorationRules = compiled;
    this.surfaceDecorationRulesSignature = signature;
    this.surfaceDecorationRulesRevision = compiled.rules.length
      ? Math.max(1, Math.trunc(Number(revision) || 1))
      : Math.max(0, Math.trunc(Number(revision) || 0));
    this.materialVersion += 1;
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
      chunk.materialVersion = this.materialVersion;
      chunk.markDirty();
    }
    this.dispatchBuilds();
    return true;
  }

  updatePlayerPosition(worldX, worldY, worldZ, options = {}) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    if (Number.isFinite(options.directionX) || Number.isFinite(options.directionZ)) this.setLoadDirection(options.directionX, options.directionZ);
    if (coord.chunkX !== this.centerChunkX || coord.chunkZ !== this.centerChunkZ) this.buildQueueNeedsSort = true;
    const nextRangeKey = `${coord.chunkX}:${coord.chunkZ}:${this.preloadDistance}`;
    this.centerChunkX = coord.chunkX;
    this.centerChunkZ = coord.chunkZ;
    if (nextRangeKey !== this.lastEnsuredRangeKey) {
      this.ensureChunkRange(coord.chunkX, coord.chunkZ, { force: true });
      this.unloadFarChunks(coord.chunkX, coord.chunkZ);
    }
    this.dispatchBuilds();
  }

  ensureChunkRange(centerX = this.centerChunkX, centerZ = this.centerChunkZ, { force = false } = {}) {
    const rangeKey = `${centerX}:${centerZ}:${this.preloadDistance}`;
    if (!force && rangeKey === this.lastEnsuredRangeKey) {
      this.dispatchBuilds();
      return;
    }
    this.lastEnsuredRangeKey = rangeKey;
    for (const offset of buildLoadOffsets(this.preloadDistance, this.loadDirX, this.loadDirZ)) {
      // Reserve identities immediately, but do not reconstruct every new base
      // column in this call when Workers are unavailable. The normal dirty
      // scheduler generates near bases progressively under its task budget.
      this.ensureChunk(centerX + offset.dx, centerZ + offset.dz, { deferBase: true });
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
      baseBlocks: null,
      baseBlocksReady: false,
    });
    chunk.prepareRenderSnapshotNeighborhood=(changes)=>this.prepareSnapshotNeighborhood(chunk,changes);
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
      if (Math.max(Math.abs(chunk.chunkX - centerX), Math.abs(chunk.chunkZ - centerZ)) > limit) {
        const edits=[...chunk.getFinalDeltaMap().values()];
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
    for (const id of this.workerBuildFailures.keys()) {
      if (!this.chunks.has(id)) this.workerBuildFailures.delete(id);
    }
  }

  getVisibleChunks(cameraState = {}) {
    const chunks = [];
    const frame = ++this.visibilityFrame;
    const cameraChunk = visibilityCenterChunk(cameraState, this.chunkSize);
    for (const chunk of this.chunks.values()) {
      const distance = Math.max(Math.abs(chunk.chunkX - cameraChunk.chunkX), Math.abs(chunk.chunkZ - cameraChunk.chunkZ));
      if (!chunk.mesh) continue;
      if (distance > this.viewDistance) {
        this.visibleChunkMemory.delete(chunk.id);
        continue;
      }
      if (chunkIntersectsCameraFrustum(chunk, cameraState)) {
        this.visibleChunkMemory.set(chunk.id, frame);
        chunks.push(chunk);
        continue;
      }
      const lastVisibleFrame = this.visibleChunkMemory.get(chunk.id) || 0;
      if (lastVisibleFrame && frame - lastVisibleFrame <= this.visibilityLingerFrames) chunks.push(chunk);
    }
    this.cleanupVisibleChunkMemory(frame);
    chunks.sort((a, b) => chunkPriority(a, cameraChunk, this) - chunkPriority(b, cameraChunk, this));
    return chunks;
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
      getBlockAtWorld:(x,y,z)=>this.getBlockAtWorld(x,y,z),
      getDeltaAtWorld:(x,y,z)=>this.getDeltaAtWorld(x,y,z),
      getColumnTopAtWorld:(x,z)=>this.getOpaqueColumnTopAtWorld(x,z),
      getWaterLevelAtWorld:(x,z,surface)=>this.getWaterLevelAtWorld(x,z,surface),
      getNeighborDeltas:(index)=>this.neighborDeltaValues(chunk.chunkX,chunk.chunkZ,index),
      treeDeltaCandidateCount:this.treeDeltaCandidateCountForChunk(chunk.chunkX,chunk.chunkZ),
    };
  }

  invalidateLightingDependencies(source,deltas) {
    // Seven sun samples reach 14.3 horizontal cells. This footprint is separate
    // from the one-cell geometry halo and the tree/vegetation dependency.
    const reach=15;
    const changed=new Set();
    for(const target of this.chunks.values()) {
      if(target===source)continue;
      const minX=target.chunkX*this.chunkSize,minZ=target.chunkZ*this.chunkSize;
      const relevant=deltas.filter(d=>d.worldX>=minX-reach&&d.worldX<minX+this.chunkSize+reach&&d.worldZ>=minZ-reach&&d.worldZ<minZ+this.chunkSize+reach);
      if(!relevant.length)continue;
      if(!target.renderSections) {target.markDirty();changed.add(target);continue;}
      for(const section of target.renderSections.values()) {
        if(!section.mesh?.vertexCount&&!section.visualMesh?.vertexCount)continue;
        if(section.originY>Math.max(...relevant.map(d=>d.worldY))+4)continue;
        section.lightRevision++;section.dirty=true;section.visualDirty=true;
        section.dirtyReason="sun-halo";section.oldestDirtyAt??=performance.now();
      }
      target.renderInvalidationPending=true;target.markDirty();changed.add(target);
    }
    return changed;
  }

  captureColumnTopHalo(chunk) {
    const margin=15,width=this.chunkSize+2*margin;
    const originX=chunk.chunkX*this.chunkSize-margin,originZ=chunk.chunkZ*this.chunkSize-margin;
    const tops=new Int32Array(width*width);
    for(let z=0;z<width;z++)for(let x=0;x<width;x++)tops[x+z*width]=this.getOpaqueColumnTopAtWorld(originX+x,originZ+z);
    return {originX,originZ,width,tops};
  }

  captureWorkerColumnTopHalo(chunk) {
    // The Worker reconstructs unchanged columns from the same captured seed and
    // generator configuration. Only edited column tops need a main-thread read.
    // Dense/custom base blocks retain the complete snapshot path.
    const margin=15,width=this.chunkSize+2*margin;
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
    const plans=new Map(),reach=15,radius=Math.ceil(reach/this.chunkSize);
    for(const delta of changes) {
      for(let dz=-radius;dz<=radius;dz++)for(let dx=-radius;dx<=radius;dx++) {
        if(dx===0&&dz===0)continue;
        const cx=source.chunkX+dx,cz=source.chunkZ+dz,x=delta.worldX-cx*this.chunkSize,z=delta.worldZ-cz*this.chunkSize;
        if(x< -reach||z< -reach||x>=this.chunkSize+reach||z>=this.chunkSize+reach)continue;
        const id=chunkId(cx,cz);let plan=plans.get(id);
        if(!plan)plans.set(id,plan={data:new Set(),light:new Set(),maxY:-Infinity,trees:false});
        const y=delta.localY??delta.worldY;
        if(x>=-1&&z>=-1&&x<=this.chunkSize&&z<=this.chunkSize)for(const sy of [y-1,y,y+1])plan.data.add(Math.floor((sy-this.minY)/16));
        for(const sy of [y-4,y,y+4])plan.light.add(Math.floor((sy-this.minY)/16));
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
          if(!geometry&&!plan.light.has(index)&&section.originY>plan.maxY)continue;
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
    const sections=ensureRenderSections(chunk);
    let queued=false;
    for(const section of sections.values()) {
      if(!section.dirty&&(!section.visualDirty||performance.now()<section.visualRetryAt))continue;
      if(section.buildState!=="ready"||this.buildQueue.length>=this.maxQueuedBuilds)continue;
      section.buildState="queued";
      this.buildQueue.push({id:chunk.id,chunk,sectionIndex:section.sectionIndex,chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,mode:"section",queuedAt:section.oldestDirtyAt??performance.now(),version:chunk.version});
      queued=true;
    }
    this.buildQueueNeedsSort ||= queued;
    return queued;
  }

  dispatchSectionBuild(worker,queued,chunk) {
    const section=chunk.renderSections.get(queued.sectionIndex);
    if(!section||(!section.dirty&&!section.visualDirty)){if(section)section.buildState="ready";return false;}
    const taskId=this.taskSerial++,revision=sectionRevision(section,this.materialVersion),startedAt=performance.now();
    const task={...queued,worker,chunk,version:chunk.version,sectionRevision:revision,materialVersion:this.materialVersion,phase:"chunk",cancelled:false,startedAt};
    section.buildState="building";section.buildTaskId=taskId;
    this.inFlightBuilds.set(taskId,task);
    const finalDeltas=packDeltaValues(sectionDeltaValues(chunk,section.sectionIndex));
    const neighborDeltas=this.neighborDeltasForWorker(chunk.chunkX,chunk.chunkZ,section.sectionIndex);
    const treeDeltas=this.treeNeighborDeltasForWorker(chunk.chunkX,chunk.chunkZ,section.sectionIndex);
    const lightingDeltas=this.visualDeltasForWorker(chunk.chunkX,chunk.chunkZ,8,section.sectionIndex);
    const columnTopHalo=this.captureWorkerColumnTopHalo(chunk);
    try {
      worker.postMessage({type:"buildChunk",taskId,worldSeed:new Uint8Array(managerWorldSeed(this)),chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,
        generationVersion:this.generationVersion,resourceRuleVersion:this.resourceRuleVersion,materialVersion:this.materialVersion,
        options:this.workerOptions(),mode:"section",taskVersion:task.version,sectionIndex:section.sectionIndex,sectionRevision:revision,
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

  rebuildDirtyChunks(budgetMs = DEFAULT_MESH_BUDGET_MS) {
    const start = performance.now();
    const rebuilt = this.drainCompletedBuilds();
    const dirty = Array.from(this.chunks.values())
      .filter((chunk) => chunk.dirty && chunk.buildState !== "queued" && chunk.buildState !== "building")
      .sort((a, b) => Math.max(Math.abs(a.chunkX - this.centerChunkX), Math.abs(a.chunkZ - this.centerChunkZ)) - Math.max(Math.abs(b.chunkX - this.centerChunkX), Math.abs(b.chunkZ - this.centerChunkZ)));
    for (const chunk of dirty) {
      if (this.useWorkers) {
        if (chunk.buildState === "error" && !this.prepareWorkerBuildRetry(chunk, start)) continue;
        if (chunk.baseBlocksReady && chunk.renderSections) {
          const near=Math.max(Math.abs(chunk.chunkX-this.centerChunkX),Math.abs(chunk.chunkZ-this.centerChunkZ))<=1;
          if(near) {
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
      if (!chunk.baseBlocksReady) this.ensureChunkBaseSync(chunk);
      const access = this.meshAccessForChunk(chunk);
      const sections=ensureRenderSections(chunk);
      let changed=false;
      for (const section of sections.values()) {
        if (!section.dirty && (!section.visualDirty || performance.now()<section.visualRetryAt)) continue;
        const revision=sectionRevision(section,this.materialVersion);
        const result=buildRenderSection(chunk,section,access,{visualOnly:!section.dirty});
        if(commitRenderSection(chunk,section,result,revision))changed=true;
        this.sectionBuildVisits+=result.voxelVisits;
        this.stageStats.record("mesh-build",result.elapsedMs);
        this.logRenderEvent("section-build-sync",{chunkId:chunk.id,section:section.sectionIndex,generation:section.generation,revision,elapsedMs:result.elapsedMs,voxelVisits:result.voxelVisits,uniqueVoxelQueries:result.voxelQueries,voxelCacheBytes:result.voxelCacheBytes,lightCells:result.lighting?.cells??0,visualError:result.visualError});
        if(performance.now()-start>=budgetMs)break;
      }
      if(changed)rebuilt.push(chunk);
      if (performance.now() - start >= budgetMs) break;
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
        return getGeneratedTreeBlockAt(managerWorldSeed(this), coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions());
      }
    }
    return getBlockAt(managerWorldSeed(this), coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions());
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
        return collisionBlockId(getGeneratedTreeTrunkBlockAt(managerWorldSeed(this), coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions()));
      }
    }
    return collisionBlockId(getBlockAt(managerWorldSeed(this), coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions()));
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
      workers: this.workers.length,
      lastBuildError: this.lastBuildError,
      failedBuilds: this.workerBuildFailures.size,
      staleBuildResults: this.staleBuildResults,
      sectionBuildVisits: this.sectionBuildVisits,
      nearFieldRepairs: this.nearFieldRepairs,
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
      if (task.worker !== worker) continue;
      const chunk = this.chunks.get(task.id);
      const section=chunk?.renderSections?.get(task.sectionIndex);
      if(section&&section.buildTaskId===taskId){section.buildTaskId=null;section.buildState="ready";}
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
    if (message.type === "chunkBuilt" || message.type === "visualBuilt") {
      if (message.taskVersion !== task.version || message.materialVersion !== task.materialVersion) {
        return { error: new Error(`Chunk worker response versions do not match task ${taskId}.`) };
      }
      if (message.type === "chunkBuilt" && message.mode !== task.mode) {
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
    if(chunk?.renderSections)return this.enqueueSectionBuilds(chunk);
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

  dispatchBuilds() {
    if (!this.useWorkers || !this.idleWorkers.length || !this.buildQueue.length) return;
    const activeLimit = Math.max(0, Math.min(this.workerCount, Math.trunc(this.activeBuildLimit || 0)));
    if (this.inFlightBuilds.size >= activeLimit) return;
    if (this.buildQueueNeedsSort || this.buildQueue.length) {
      this.buildQueue.sort((a, b) => taskPriority(a, this) - taskPriority(b, this));
      this.buildQueueNeedsSort = false;
    }
    while (this.idleWorkers.length && this.buildQueue.length && this.inFlightBuilds.size < activeLimit) {
      const worker = this.idleWorkers.pop();
      const task = this.buildQueue.shift();
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
      const waitMs = Number.isFinite(task.queuedAt) ? startedAt - task.queuedAt : 0;
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
        materialVersion: this.materialVersion,
        phase: "chunk",
        cancelled: false,
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
        finalDeltas,
        pickedSurfaceColumns: chunk.pickedSurfaceColumns,
        neighborDeltas,
        treeDeltas,
        lightingDeltas: this.visualDeltasForWorker(chunk.chunkX,chunk.chunkZ,8),
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
    const chunk = this.chunks.get(task.id);
    if (task.phase === "chunk" && (!chunk || (task.sectionIndex!==undefined ? chunk!==task.chunk||chunk.renderSections?.get(task.sectionIndex)?.buildTaskId!==message.taskId : chunk.buildTaskId!==message.taskId))) task.cancelled = true;

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
        for(const result of message.sectionResults){const section=sections.get(result.sectionIndex);if(section)commitRenderSection(chunk,section,result,sectionRevision(section,this.materialVersion));}
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
    const out = this.completedBuilds.filter((chunk) => this.chunks.has(chunk.id));
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
  if (Number.isFinite(cameraState?.targetWorldX) && Number.isFinite(cameraState?.targetWorldZ)) {
    const targetX = Math.trunc(cameraState.targetWorldX || 0) + (cameraState.targetLocalOffsetX || 0);
    const targetY = Math.trunc(cameraState.targetWorldY || 0) + (cameraState.targetLocalOffsetY || 0);
    const targetZ = Math.trunc(cameraState.targetWorldZ || 0) + (cameraState.targetLocalOffsetZ || 0);
    return worldToChunk(targetX, targetY, targetZ, chunkSize);
  }
  return worldToChunk(cameraState?.worldX ?? 0, cameraState?.worldY ?? 0, cameraState?.worldZ ?? 0, chunkSize);
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

function taskPriority(task, manager) {
  const age = Math.max(0, performance.now() - (task.queuedAt ?? performance.now()));
  const near = Math.max(Math.abs(task.chunkX-manager.centerChunkX),Math.abs(task.chunkZ-manager.centerChunkZ)) <= 1;
  const remeshPriority = near && (task.mode === "remesh" || task.mode === "section") ? -2000 : 0;
  return remeshPriority + offsetPriority(task.chunkX - manager.centerChunkX, task.chunkZ - manager.centerChunkZ, manager.loadDirX, manager.loadDirZ) - Math.min(40000, age * 4);
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
  if (type === "chunkBuilt" || type === "chunkBuildError") return "chunk";
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
