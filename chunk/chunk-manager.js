import { DEFAULT_CHUNK_HEIGHT, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_TERRAIN_HEIGHT, DEFAULT_MESH_BUDGET_MS, DEFAULT_MIN_WORLD_Y, DEFAULT_SEA_LEVEL, DEFAULT_VIEW_DISTANCE } from "../core/constants.js";
import { chunkId, worldToChunk } from "../core/coordinates.js";
import { isBlockingBlock, isOpaqueSolidBlock, BLOCK_ID } from "../world/block-registry.js";
import { compileSurfaceDecorationRules } from "../world/surface-decoration-rules.js";
import {
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
import { meshChunkOpaqueFast, meshChunkVisual } from "./chunk-mesher.js";

const DEFAULT_MAX_BUILD_QUEUE = 768;
const DEFAULT_VISIBILITY_LINGER_FRAMES = 12;
const VISIBILITY_CLEANUP_INTERVAL_FRAMES = 45;
const INITIAL_BUILD_CONCURRENCY = 1;
const WORKER_BUILD_RETRY_BASE_MS = 180;
const WORKER_BUILD_RETRY_MAX_MS = 5000;
const COLLISION_COLUMN_CACHE_LIMIT = 4096;
const MAX_GENERATED_TREE_TRUNK_HEIGHT = 7;

export class ChunkManager {
  constructor({
    worldSeed = MAINNET_WORLD_SEED,
    chunkSize = DEFAULT_CHUNK_SIZE,
    height = DEFAULT_CHUNK_HEIGHT,
    minY = DEFAULT_MIN_WORLD_Y,
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
    deferInitialBuilds = false,
    deferContinuousBuildDispatch = false,
    maxQueuedBuilds = DEFAULT_MAX_BUILD_QUEUE,
    visibilityLingerFrames = DEFAULT_VISIBILITY_LINGER_FRAMES,
  } = {}) {
    this.config = createWorldGeneratorConfig({ worldSeed, chunkSize, height, minY, seaLevel, maxTerrainHeight, generationVersion, resourceRuleVersion });
    this.worldSeed = worldSeed;
    this.chunkSize = chunkSize;
    this.height = height;
    this.minY = minY;
    this.viewDistance = viewDistance;
    this.preloadMargin = Math.max(0, Math.trunc(preloadMargin || 0));
    this.preloadDistance = this.viewDistance + this.preloadMargin;
    this.seaLevel = seaLevel;
    this.maxTerrainHeight = maxTerrainHeight;
    this.generationVersion = generationVersion;
    this.resourceRuleVersion = resourceRuleVersion;
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
    this.useWorkers = Boolean(useWorkers && typeof Worker !== "undefined");
    this.workerCount = this.useWorkers ? Math.max(1, Math.trunc(workerCount || 1)) : 0;
    this.deferInitialBuilds = Boolean(deferInitialBuilds && this.useWorkers);
    this.continuousBuildDispatch = !Boolean(deferContinuousBuildDispatch && this.useWorkers);
    this.activeBuildLimit = this.deferInitialBuilds ? 0 : Math.min(this.workerCount, INITIAL_BUILD_CONCURRENCY);
    this.maxQueuedBuilds = Math.max(1, Math.trunc(maxQueuedBuilds || DEFAULT_MAX_BUILD_QUEUE));
    this.workers = [];
    this.idleWorkers = [];
    this.buildQueue = [];
    this.buildQueueNeedsSort = false;
    this.inFlightBuilds = new Map();
    this.completedBuilds = [];
    this.workerBuildFailures = new Map();
    this.dispatchScheduled = false;
    this.taskSerial = 1;
    this.renderLogger = null;
    this.supplementalCollisionProvider = null;
    this.collisionColumnTopCache = new Map();
    this.visibilityFrame = 0;
    this.lastVisibilityCleanupFrame = 0;
    this.visibilityLingerFrames = Math.max(0, Math.trunc(Number(visibilityLingerFrames) || 0));
    this.visibleChunkMemory = new Map();
    if (this.useWorkers && !this.deferInitialBuilds) this.initWorkers(Math.min(this.workerCount, INITIAL_BUILD_CONCURRENCY));
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
    for (const worker of this.workers) {
      worker.postMessage({ type: "setSurfaceDecorationRules", rules: compiled.rules, revision: this.surfaceDecorationRulesRevision });
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
      this.ensureChunk(centerX + offset.dx, centerZ + offset.dz);
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
    const next = Math.max(0, Math.min(this.workerCount, Math.trunc(Number(limit) || 0)));
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
    this.viewDistance = Math.max(1, Math.trunc(Number(viewDistance) || DEFAULT_VIEW_DISTANCE));
    this.preloadMargin = Math.max(0, Math.trunc(Number(preloadMargin) || 0));
    this.preloadDistance = this.viewDistance + this.preloadMargin;
    this.lastEnsuredRangeKey = "";
    this.ensureChunkRange(this.centerChunkX, this.centerChunkZ, { force: true });
  }

  ensureChunk(chunkX, chunkZ) {
    const id = chunkId(chunkX, chunkZ);
    let chunk = this.chunks.get(id);
    if (chunk) return chunk;
    chunk = new ChunkState({
      chunkX,
      chunkZ,
      chunkSize: this.chunkSize,
      height: this.height,
      minY: this.minY,
      generationVersion: this.generationVersion,
      resourceRuleVersion: this.resourceRuleVersion,
      materialVersion: this.materialVersion,
      worldSeed: this.config.worldSeed,
      surfaceDecorationRules: this.surfaceDecorationRules,
      baseBlocks: null,
      baseBlocksReady: false,
    });
    this.chunks.set(id, chunk);
    if (this.useWorkers) {
      this.enqueueBuild(chunk);
    } else {
      this.ensureChunkBaseSync(chunk);
    }
    return chunk;
  }

  unloadFarChunks(centerX, centerZ) {
    const limit = this.preloadDistance + 2;
    for (const [id, chunk] of Array.from(this.chunks.entries())) {
      if (Math.max(Math.abs(chunk.chunkX - centerX), Math.abs(chunk.chunkZ - centerZ)) > limit) this.chunks.delete(id);
    }
    this.buildQueue = this.buildQueue.filter((task) => this.chunks.has(task.id));
    this.completedBuilds = this.completedBuilds.filter((chunk) => this.chunks.has(chunk.id));
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
      if (chunkVisibleInCameraCone(chunk, cameraState, this)) {
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

  rebuildDirtyChunks(budgetMs = DEFAULT_MESH_BUDGET_MS) {
    const start = performance.now();
    const rebuilt = this.drainCompletedBuilds();
    const dirty = Array.from(this.chunks.values())
      .filter((chunk) => chunk.dirty && chunk.buildState !== "queued" && chunk.buildState !== "building")
      .sort((a, b) => Math.max(Math.abs(a.chunkX - this.centerChunkX), Math.abs(a.chunkZ - this.centerChunkZ)) - Math.max(Math.abs(b.chunkX - this.centerChunkX), Math.abs(b.chunkZ - this.centerChunkZ)));
    for (const chunk of dirty) {
      if (this.useWorkers) {
        if (chunk.buildState === "error" && !this.prepareWorkerBuildRetry(chunk, start)) continue;
        if (chunk.baseBlocksReady) this.enqueueRemesh(chunk);
        else this.enqueueBuild(chunk);
        if (performance.now() - start >= budgetMs) break;
        continue;
      }
      if (!chunk.baseBlocksReady) this.ensureChunkBaseSync(chunk);
      const access = {
        getBlockAtWorld: (x, y, z) => this.getBlockAtWorld(x, y, z),
        getDeltaAtWorld: (x, y, z) => this.getDeltaAtWorld(x, y, z),
        getColumnTopAtWorld: (x, z) => this.getOpaqueColumnTopAtWorld(x, z),
        getWaterLevelAtWorld: (x, z, surface = terrainSurfaceHeight(this.config, x, z)) => waterLevelAt(this.config, x, z, surface),
        treeDeltaCandidateCount: this.treeDeltaCandidateCountForChunk(chunk.chunkX, chunk.chunkZ),
      };
      const meshStartedAt = performance.now();
      const mesh = meshChunkOpaqueFast(chunk, access);
      const opaqueMeshMs = performance.now() - meshStartedAt;
      const visualStartedAt = performance.now();
      const visualMesh = meshChunkVisual(chunk, access);
      const visualMeshMs = performance.now() - visualStartedAt;
      chunk.setMeshes(mesh, visualMesh);
      this.logRenderEvent("chunk-build-sync", {
        chunkId: chunk.id,
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        elapsedMs: opaqueMeshMs + visualMeshMs,
        opaqueMeshMs,
        visualMeshMs,
        triangles: (mesh?.triangleCount || 0) + (visualMesh?.triangleCount || 0),
        bytes: (mesh?.vertices?.byteLength || 0) + (mesh?.indices?.byteLength || 0) + (visualMesh?.vertices?.byteLength || 0) + (visualMesh?.indices?.byteLength || 0),
      });
      rebuilt.push(chunk);
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
        return getGeneratedTreeBlockAt(this.worldSeed, coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions());
      }
    }
    return getBlockAt(this.worldSeed, coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions());
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
    const generatedTop = terrainSurfaceHeight(this.config, x, z);
    const coord = worldToChunk(x, 0, z, this.chunkSize);
    const chunk = this.chunks.get(coord.chunkId);
    if (!chunk || !hasDeltas(chunk)) return generatedTop;

    const cacheKey = `${coord.chunkId}:${coord.localX}:${coord.localZ}`;
    const cached = this.collisionColumnTopCache.get(cacheKey);
    if (
      cached?.chunk === chunk
      && cached.version === chunk.version
      && cached.chainRevision === chunk.chainRevision
    ) {
      return cached.top;
    }

    let affected = false;
    let candidateY = generatedTop;
    for (const delta of finalDeltaValues(chunk)) {
      if (delta.localX !== coord.localX || delta.localZ !== coord.localZ) continue;
      affected = true;
      if (isTerrainMeshBlock(delta.blockId)) candidateY = Math.max(candidateY, delta.localY);
    }
    if (!affected) {
      this.cacheCollisionColumnTop(cacheKey, chunk, generatedTop);
      return generatedTop;
    }

    const maxY = this.minY + this.height - 1;
    for (let y = Math.min(maxY, candidateY); y >= this.minY; y -= 1) {
      const blockId = chunk.baseBlocksReady
        ? chunk.getFinalBlock(coord.localX, y, coord.localZ)
        : this.getTerrainCollisionBlockAtWorld(x, y, z);
      if (!isTerrainMeshBlock(blockId)) continue;
      this.cacheCollisionColumnTop(cacheKey, chunk, y);
      return y;
    }
    const top = this.minY - 1;
    this.cacheCollisionColumnTop(cacheKey, chunk, top);
    return top;
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
        return collisionBlockId(getGeneratedTreeTrunkBlockAt(this.worldSeed, coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions()));
      }
    }
    return collisionBlockId(getBlockAt(this.worldSeed, coord.worldX, coord.worldY, coord.worldZ, this.generationVersion, this.workerOptions()));
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

  cacheCollisionColumnTop(key, chunk, top) {
    if (this.collisionColumnTopCache.size >= COLLISION_COLUMN_CACHE_LIMIT && !this.collisionColumnTopCache.has(key)) {
      this.collisionColumnTopCache.delete(this.collisionColumnTopCache.keys().next().value);
    }
    this.collisionColumnTopCache.set(key, {
      chunk,
      version: chunk.version,
      chainRevision: chunk.chainRevision,
      top,
    });
  }

  isCameraOccluderAtWorld(worldX, worldY, worldZ) {
    const coord = worldToChunk(worldX, worldY, worldZ, this.chunkSize);
    if (this.supplementalCollisionProvider?.hasCollisionAtWorld?.(coord.worldX, coord.worldY, coord.worldZ)) return true;
    const chunk = this.chunks.get(coord.chunkId);
    if (chunk?.baseBlocksReady) {
      return isBlockingBlock(this.getBlockAtWorld(coord.worldX, coord.worldY, coord.worldZ));
    }
    if (chunk?.hasDeltaAt(coord.localX, coord.localY, coord.localZ)) {
      return isBlockingBlock(collisionBlockId(chunk.getFinalBlock(coord.localX, coord.localY, coord.localZ)));
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
    const deltas = Array.isArray(chunkKeyOrDeltas) ? chunkKeyOrDeltas : maybeDeltas;
    let changedChunks = 0;
    for (const group of groupDeltasByChunk(deltas, this.chunkSize).values()) {
      const chunk = this.ensureChunk(group.chunkX, group.chunkZ);
      const result = chunk.applyChainDelta(group.deltas);
      if (result.changed) changedChunks += 1;
      this.markBoundaryNeighborsDirty(chunk, result.boundaryMask);
    }
    return { changedChunks };
  }

  replaceChainDeltasForChunk(idOrChunk, deltas = [], options = {}) {
    const id = typeof idOrChunk === "string" ? idOrChunk : chunkId(idOrChunk?.chunkX ?? 0, idOrChunk?.chunkZ ?? 0);
    const chunk = this.chunks.get(id);
    if (!chunk) return { applied: false, reason: "chunk-unloaded", changed: false };
    const result = chunk.replaceChainDeltas(deltas, options);
    if (result.applied) this.markBoundaryNeighborsDirty(chunk, result.boundaryMask);
    return result;
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
      const result = chunk.clearChainDeltas();
      if (!result) continue;
      cleared += 1;
      this.markBoundaryNeighborsDirty(chunk, result.boundaryMask);
    }
    return cleared;
  }

  applyPendingDelta(chunkKeyOrDeltas, maybeDeltas, maybeTxId) {
    const deltas = Array.isArray(chunkKeyOrDeltas) ? chunkKeyOrDeltas : maybeDeltas;
    const txId = Array.isArray(chunkKeyOrDeltas) ? maybeDeltas : maybeTxId;
    for (const group of groupDeltasByChunk(deltas, this.chunkSize).values()) {
      const chunk = this.ensureChunk(group.chunkX, group.chunkZ);
      const result = chunk.applyPendingDelta(group.deltas, txId);
      this.markBoundaryNeighborsDirty(chunk, result.boundaryMask);
    }
  }

  confirmPendingDelta(txId) {
    for (const chunk of this.chunks.values()) chunk.confirmPendingDelta(txId);
  }

  rollbackPendingDelta(txId) {
    for (const chunk of this.chunks.values()) {
      const result = chunk.rollbackPendingDelta(txId);
      if (result.rolledBack) this.markBoundaryNeighborsDirty(chunk, result.boundaryMask);
    }
  }

  markBoundaryNeighborsDirty(chunk, boundaryMask = 0) {
    const mask = Math.trunc(Number(boundaryMask) || 0);
    if (!chunk || !mask) return 0;
    let dirtied = 0;
    const mark = (chunkX, chunkZ) => {
      const neighbor = this.chunks.get(chunkId(chunkX, chunkZ));
      if (!neighbor) return;
      neighbor.markDirty();
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
    const coord = worldToChunk(delta.worldX, delta.worldY, delta.worldZ, this.chunkSize);
    return this.ensureChunk(coord.chunkX, coord.chunkZ);
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
    };
  }

  dispose() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idleWorkers = [];
    this.buildQueue.length = 0;
    this.buildQueueNeedsSort = false;
    this.inFlightBuilds.clear();
    this.completedBuilds.length = 0;
    this.workerBuildFailures.clear();
    this.dispatchScheduled = false;
  }

  logRenderEvent(type, data = {}) {
    this.renderLogger?.record?.(type, data);
  }

  initWorkers(targetCount = this.workerCount) {
    try {
      const target = Math.max(0, Math.min(this.workerCount, Math.trunc(Number(targetCount) || 0)));
      for (let i = this.workers.length; i < target; i += 1) {
        const worker = new Worker(new URL("./chunk-build-worker.js", import.meta.url), { type: "module" });
        worker.onmessage = (event) => this.handleWorkerMessage(worker, event.data);
        worker.onerror = (event) => this.handleWorkerError(worker, event);
        this.workers.push(worker);
        this.idleWorkers.push(worker);
        worker.postMessage({
          type: "setSurfaceDecorationRules",
          rules: this.surfaceDecorationRules.rules,
          revision: this.surfaceDecorationRulesRevision,
        });
      }
    } catch (error) {
      this.lastBuildError = error?.message || String(error);
      this.useWorkers = false;
      this.workerCount = 0;
      this.dispose();
    }
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
    if (this.buildQueueNeedsSort) {
      this.buildQueue.sort((a, b) => taskPriority(a, this) - taskPriority(b, this));
      this.buildQueueNeedsSort = false;
    }
    while (this.idleWorkers.length && this.buildQueue.length && this.inFlightBuilds.size < activeLimit) {
      const worker = this.idleWorkers.pop();
      const task = this.buildQueue.shift();
      const chunk = this.chunks.get(task.id);
      const staleBase = task.mode !== "remesh" && chunk?.baseBlocksReady;
      const staleRemesh = task.mode === "remesh" && (!chunk?.baseBlocksReady || !chunk.dirty || chunk.version !== task.version);
      if (!chunk || staleBase || staleRemesh) {
        if (chunk && staleRemesh && chunk.buildState === "queued") chunk.markBuildStale();
        this.idleWorkers.push(worker);
        continue;
      }
      const taskId = this.taskSerial++;
      const startedAt = performance.now();
      const waitMs = Number.isFinite(task.queuedAt) ? startedAt - task.queuedAt : 0;
      chunk.markBuilding(taskId);
      this.inFlightBuilds.set(taskId, {
        worker,
        id: chunk.id,
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        queuedAt: task.queuedAt,
        startedAt,
        waitMs,
        mode: task.mode || "base",
        version: task.version,
      });
      this.logRenderEvent("chunk-build-start", {
        chunkId: chunk.id,
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        waitMs,
        queueLength: this.buildQueue.length,
      });
      const finalDeltas = task.mode === "remesh" ? packedFinalDeltasForWorker(chunk) : EMPTY_PACKED_DELTAS;
      const neighborDeltas = this.neighborDeltasForWorker(chunk.chunkX, chunk.chunkZ);
      const treeDeltas = this.treeNeighborDeltasForWorker(chunk.chunkX, chunk.chunkZ);
      const message = {
        type: "buildChunk",
        taskId,
        worldSeed: this.worldSeed,
        chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ,
        generationVersion: this.generationVersion,
        resourceRuleVersion: this.resourceRuleVersion,
        materialVersion: this.materialVersion,
        options: this.workerOptions(),
        mode: task.mode || "base",
        taskVersion: task.version,
        finalDeltas,
        neighborDeltas,
        treeDeltas,
      };
      const transfer = [];
      if (finalDeltas.byteLength) transfer.push(finalDeltas.buffer);
      if (neighborDeltas.byteLength) transfer.push(neighborDeltas.buffer);
      if (treeDeltas.byteLength) transfer.push(treeDeltas.buffer);
      worker.postMessage(message, transfer);
    }
  }

  scheduleBuildDispatch() {
    if (this.dispatchScheduled || !this.useWorkers || !this.continuousBuildDispatch) return;
    this.dispatchScheduled = true;
    setTimeout(() => {
      this.dispatchScheduled = false;
      this.dispatchBuilds();
    }, 0);
  }

  handleWorkerMessage(worker, message) {
    if (!message) return;
    if (message.type === "chunkBuilt") {
      const task = this.inFlightBuilds.get(message.taskId);
      this.applyWorkerBuildResult(message, task);
      if (message.visualError) {
        this.logRenderEvent("visual-build-error", {
          chunkX: message.chunkX,
          chunkZ: message.chunkZ,
          error: message.visualError,
        });
      }
      if (!message.visualPending) {
        if (task) this.inFlightBuilds.delete(message.taskId);
        this.idleWorkers.push(worker);
      }
      this.scheduleBuildDispatch();
      return;
    } else if (message.type === "visualBuilt") {
      const task = this.inFlightBuilds.get(message.taskId);
      if (task) this.inFlightBuilds.delete(message.taskId);
      this.applyWorkerVisualResult(message, task);
      this.idleWorkers.push(worker);
      this.scheduleBuildDispatch();
      return;
    } else if (message.type === "visualBuildError") {
      const task = this.inFlightBuilds.get(message.taskId);
      if (task) this.inFlightBuilds.delete(message.taskId);
      this.lastBuildError = message.error || "visual build failed";
      this.logRenderEvent("visual-build-error", {
        chunkX: message.chunkX,
        chunkZ: message.chunkZ,
        error: this.lastBuildError,
      });
      this.idleWorkers.push(worker);
      this.scheduleBuildDispatch();
      return;
    } else if (message.type === "chunkBuildError") {
      const task = this.inFlightBuilds.get(message.taskId);
      if (task) this.inFlightBuilds.delete(message.taskId);
      this.lastBuildError = message.error || "chunk build failed";
      const chunk = this.chunks.get(chunkId(message.chunkX, message.chunkZ));
      chunk?.markBuildError(this.lastBuildError);
      if (chunk) this.recordWorkerBuildFailure(chunk, this.lastBuildError);
      this.idleWorkers.push(worker);
    }
    this.scheduleBuildDispatch();
  }

  handleWorkerError(worker, event) {
    this.lastBuildError = event?.message || "chunk worker failed";
    for (const [taskId, task] of Array.from(this.inFlightBuilds.entries())) {
      if (task.worker !== worker) continue;
      const chunk = this.chunks.get(task.id);
      chunk?.markBuildError(this.lastBuildError);
      if (chunk) this.recordWorkerBuildFailure(chunk, this.lastBuildError);
      this.inFlightBuilds.delete(taskId);
    }
    this.idleWorkers = this.idleWorkers.filter((candidate) => candidate !== worker);
    this.workers = this.workers.filter((candidate) => candidate !== worker);
    worker.terminate();
    if (!this.workers.length) this.useWorkers = false;
  }

  applyWorkerBuildResult(message, timingTask = null) {
    const chunk = this.chunks.get(chunkId(message.chunkX, message.chunkZ));
    if (!chunk || chunk.buildTaskId !== message.taskId) return;
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
      chunk.setMeshes(message.mesh, message.visualMesh ?? null, timingTask.version);
      this.logWorkerBuildDone("chunk-remesh-done", chunk, message, timingTask);
      this.completedBuilds.push(chunk);
      return;
    }
    if (message.baseProfile) chunk.setBaseProfile(message.baseProfile, message.treeInstances, this.baseBlockResolverForChunk(message.chunkX, message.chunkZ, message.baseProfile));
    else chunk.setBaseBlocks(message.baseBlocks, message.treeInstances);
    this.lastWorkerBuildMs = Number(message.elapsedMs) || 0;
    if (hasDeltas(chunk)) {
      chunk.markDirty();
      return;
    }
    chunk.setMeshes(message.mesh, message.visualMesh ?? null, timingTask?.version ?? message.taskVersion);
    this.logWorkerBuildDone("chunk-build-done", chunk, message, timingTask);
    this.completedBuilds.push(chunk);
  }

  applyWorkerVisualResult(message, timingTask = null) {
    const chunk = this.chunks.get(chunkId(message.chunkX, message.chunkZ));
    if (!chunk || !chunk.mesh) return;
    if (message.materialVersion !== this.materialVersion) return;
    if (timingTask?.mode === "remesh") {
      if (chunk.version !== timingTask.version || message.taskVersion !== timingTask.version) return;
    } else if (hasDeltas(chunk)) {
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
    const originX = Math.trunc(chunkX) * this.chunkSize;
    const originZ = Math.trunc(chunkZ) * this.chunkSize;
    return (localX, localY, localZ) => {
      const x = Math.trunc(localX);
      const z = Math.trunc(localZ);
      if (profile?.surfaceY && profile?.waterY) {
        const column = x + z * this.chunkSize;
        const storedWater = profile.waterY[column];
        return getBaseBlockAtColumnConfig(
          this.config,
          originX + x,
          localY,
          originZ + z,
          profile.surfaceY[column],
          storedWater === profile.noWater ? null : storedWater,
          profile.surfaceBlock?.[column],
        );
      }
      return getBaseBlockAtConfig(this.config, originX + x, localY, originZ + z);
    };
  }

  workerOptions() {
    return {
      chunkSize: this.chunkSize,
      height: this.height,
      minY: this.minY,
      seaLevel: this.seaLevel,
      maxTerrainHeight: this.maxTerrainHeight,
      generationVersion: this.generationVersion,
      resourceRuleVersion: this.resourceRuleVersion,
    };
  }

  neighborDeltasForWorker(chunkX, chunkZ) {
    const deltas = [];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const chunk = this.chunks.get(chunkId(chunkX + dx, chunkZ + dz));
        if (!chunk) continue;
        for (const delta of finalDeltaValues(chunk)) {
          if (!deltaTouchesTargetBoundary(delta, dx, dz, this.chunkSize)) continue;
          deltas.push(delta);
        }
      }
    }
    return packDeltaValues(deltas);
  }

  treeNeighborDeltasForWorker(chunkX, chunkZ) {
    const deltas = [];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const chunk = this.chunks.get(chunkId(chunkX + dx, chunkZ + dz));
        if (!chunk) continue;
        for (const delta of finalDeltaValues(chunk)) {
          if (deltaTouchesTargetVisualMargin(delta, dx, dz, this.chunkSize, 2)) deltas.push(delta);
        }
      }
    }
    return packDeltaValues(deltas);
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
  const remeshPriority = task.mode === "remesh" ? -20000 : 0;
  return remeshPriority + offsetPriority(task.chunkX - manager.centerChunkX, task.chunkZ - manager.centerChunkZ, manager.loadDirX, manager.loadDirZ);
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
  return Boolean(chunk?.chainDeltas?.size || chunk?.pendingDeltas?.size);
}

function groupDeltasByChunk(deltas, chunkSize) {
  const groups = new Map();
  for (const delta of deltas ?? []) {
    if (!delta) continue;
    const coord = worldToChunk(delta.worldX, delta.worldY, delta.worldZ, chunkSize);
    let group = groups.get(coord.chunkId);
    if (!group) {
      group = { chunkX: coord.chunkX, chunkZ: coord.chunkZ, deltas: [] };
      groups.set(coord.chunkId, group);
    }
    group.deltas.push(delta);
  }
  return groups;
}

const EMPTY_PACKED_DELTAS = new Int32Array(0);

function finalDeltaValues(chunk) {
  if (typeof chunk?.getFinalDeltaMap === "function") return chunk.getFinalDeltaMap().values();
  if (!chunk?.pendingDeltas?.size) return chunk?.chainDeltas?.values?.() ?? [];
  const merged = new Map(chunk?.chainDeltas ?? []);
  for (const [key, delta] of chunk.pendingDeltas) merged.set(key, delta);
  return merged.values();
}

function packedFinalDeltasForWorker(chunk) {
  return packDeltaValues(finalDeltaValues(chunk));
}

function packDeltaValues(values) {
  const source = Array.isArray(values) ? values : Array.from(values ?? []);
  if (!source.length) return new Int32Array(0);
  const packed = new Int32Array(source.length * 4);
  let offset = 0;
  for (const delta of source) {
    packed[offset++] = Math.trunc(delta.worldX);
    packed[offset++] = Math.trunc(delta.worldY);
    packed[offset++] = Math.trunc(delta.worldZ);
    packed[offset++] = Math.trunc(delta.blockId);
  }
  return packed;
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
