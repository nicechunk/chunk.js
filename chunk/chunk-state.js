import { REVEAL_STATE, DEFAULT_CHUNK_HEIGHT, DEFAULT_CHUNK_SIZE, DEFAULT_MIN_WORLD_Y } from "../core/constants.js";
import { chunkId, containsLocal, localIndex } from "../core/coordinates.js";
import { normalizeSeedBytes } from "../core/hash.js";
import { BLOCK_ID } from "../world/block-registry.js";
import {
  assertSupportedGenerationVersion,
  assertSupportedResourceRuleVersion,
  DEFAULT_GENERATION_VERSION,
  DEFAULT_RESOURCE_RULE_VERSION,
  normalizeWorldGeneratorDimensions,
} from "../world/world-generator.js";
import { DELTA_RESOURCE_LIMITS, deltaKey, normalizeDelta } from "./chunk-delta.js";

const chunkStateWorldSeeds = new WeakMap();

export const CHUNK_BOUNDARY_MASK = Object.freeze({
  NEGATIVE_X: 1,
  POSITIVE_X: 2,
  NEGATIVE_Z: 4,
  POSITIVE_Z: 8,
});

export class ChunkState {
  constructor({
    chunkX,
    chunkZ,
    chunkSize = DEFAULT_CHUNK_SIZE,
    height = DEFAULT_CHUNK_HEIGHT,
    minY = DEFAULT_MIN_WORLD_Y,
    maxBuildY = undefined,
    generationVersion = DEFAULT_GENERATION_VERSION,
    resourceRuleVersion = DEFAULT_RESOURCE_RULE_VERSION,
    materialVersion = 1,
    worldSeed = null,
    surfaceDecorationRules = null,
    baseBlocks = null,
    baseProfile = null,
    baseBlockResolver = null,
    treeInstances = [],
    baseBlocksReady = baseBlocks !== null || baseProfile !== null,
  } = {}) {
    const dimensions = normalizeWorldGeneratorDimensions({
      chunkSize,
      height,
      minY,
      maxBuildY: maxBuildY ?? baseProfile?.maxBuildY,
    });
    this.id = chunkId(chunkX, chunkZ);
    this.chunkX = Math.trunc(chunkX);
    this.chunkZ = Math.trunc(chunkZ);
    this.chunkSize = dimensions.chunkSize;
    this.height = dimensions.height;
    this.minY = dimensions.minY;
    this.maxBuildY = dimensions.maxBuildY;
    this.generationVersion = assertSupportedGenerationVersion(generationVersion);
    this.resourceRuleVersion = assertSupportedResourceRuleVersion(resourceRuleVersion);
    this.materialVersion = materialVersion;
    setChunkStateWorldSeed(this, worldSeed);
    Object.defineProperty(this, "worldSeed", {
      enumerable: true,
      get: () => {
        const seed = chunkStateWorldSeeds.get(this);
        return seed ? new Uint8Array(seed) : null;
      },
      set: (value) => setChunkStateWorldSeed(this, value),
    });
    this.surfaceDecorationRules = surfaceDecorationRules;
    this.version = 0;
    // World edits can advance while the previous mesh is still on the GPU.
    // These revisions only advance when a replacement mesh has finished.
    this.meshVersion = -1;
    this.visualMeshVersion = -1;
    this.baseBlocks = baseBlocks;
    this.baseProfile = baseProfile;
    this.baseBlockResolver = typeof baseBlockResolver === "function" ? baseBlockResolver : null;
    this.baseBlocksReady = Boolean(baseBlocksReady);
    this.treeInstances = treeInstances;
    this.chainDeltas = new Map();
    this.unobservedChainDeltaKeys = new Set();
    this.pendingDeltas = new Map();
    this.finalDeltaMapCache = null;
    this.chainRevision = 0;
    this.chainSnapshotToken = 0;
    this.chainSnapshotSlot = 0;
    this.finalBlocks = null;
    this.mesh = null;
    this.visualMesh = null;
    this.dirty = true;
    this.gpuUploaded = false;
    this.visualGpuUploaded = false;
    this.buildState = this.baseBlocksReady ? "ready" : "empty";
    this.buildTaskId = null;
    this.buildError = null;
    this.revealState = REVEAL_STATE.UNKNOWN;
    this.blockRevealStates = new Map();
  }

  getBaseBlock(localX, localY, localZ) {
    if (!containsLocal(localX, localY, localZ, this)) return BLOCK_ID.air;
    const y = Math.trunc(localY);
    const profileMaxBuildY = Number.isInteger(this.baseProfile?.maxBuildY)
      ? this.baseProfile.maxBuildY
      : this.maxBuildY;
    if (y > Math.min(this.maxBuildY, profileMaxBuildY)) return BLOCK_ID.air;
    if (this.baseBlocks) return this.baseBlocks[localIndex(localX, localY, localZ, this)] ?? BLOCK_ID.air;
    if (this.baseProfile) {
      const x = Math.trunc(localX);
      const z = Math.trunc(localZ);
      const column = x + z * this.chunkSize;
      const surfaceY = this.baseProfile.surfaceY?.[column];
      const waterY = this.baseProfile.waterY?.[column];
      const hasSurfaceWater = Number.isFinite(waterY)
        && waterY !== this.baseProfile.noWater
        && waterY >= this.minY
        && waterY < this.minY + this.height
        && waterY > surfaceY;
      if (y > surfaceY) {
        if (hasSurfaceWater && y <= waterY) return BLOCK_ID.water;
        return BLOCK_ID.air;
      }
      if (y === surfaceY) {
        return this.baseProfile.surfaceBlock?.[column] ?? this.baseBlockResolver?.(x, y, z) ?? BLOCK_ID.air;
      }
    }
    if (this.baseBlockResolver) return this.baseBlockResolver(localX, localY, localZ) ?? BLOCK_ID.air;
    return BLOCK_ID.air;
  }

  getFinalBlock(localX, localY, localZ) {
    if (!containsLocal(localX, localY, localZ, this)) return BLOCK_ID.air;
    if (!this.pendingDeltas.size && !this.chainDeltas.size) return this.getBaseBlock(localX, localY, localZ);
    const key = deltaKey(localX, localY, localZ, this.chunkSize);
    const pending = this.pendingDeltas.get(key);
    if (pending) return pending.blockId;
    const chain = this.chainDeltas.get(key);
    if (chain) return chain.blockId;
    return this.getBaseBlock(localX, localY, localZ);
  }

  revealStateAt(localX, localY, localZ) {
    const key = deltaKey(localX, localY, localZ, this.chunkSize);
    if (this.pendingDeltas.has(key)) return REVEAL_STATE.DIRTY;
    if (this.chainDeltas.has(key)) return REVEAL_STATE.CONFIRMED;
    return this.blockRevealStates.get(key) ?? this.revealState;
  }

  hasDeltaAt(localX, localY, localZ) {
    if (!this.pendingDeltas.size && !this.chainDeltas.size) return false;
    const key = deltaKey(localX, localY, localZ, this.chunkSize);
    return this.pendingDeltas.has(key) || this.chainDeltas.has(key);
  }

  getFinalDeltaMap() {
    if (!this.pendingDeltas.size) return this.chainDeltas;
    if (!this.chainDeltas.size) return this.pendingDeltas;
    if (this.finalDeltaMapCache) return this.finalDeltaMapCache;
    const merged = new Map(this.chainDeltas);
    for (const [key, delta] of this.pendingDeltas) merged.set(key, delta);
    this.finalDeltaMapCache = merged;
    return merged;
  }

  applyChainDelta(deltas = [], { protectUntilSnapshot = true } = {}) {
    const normalizedDeltas = normalizeDeltaBatch(deltas, this);
    assertProjectedResidentDeltaCapacity(this, normalizedDeltas, "chainDeltas");
    const nextChainDeltas = new Map(this.chainDeltas);
    const nextUnobservedChainDeltaKeys = new Set(this.unobservedChainDeltaKeys);
    let meshChanged = false;
    let deltaChanged = false;
    let boundaryMask = 0;
    let accepted = 0;
    for (const normalized of normalizedDeltas) {
      const delta = { ...normalized, source: "chain" };
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) continue;
      const key = deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize);
      const previous = nextChainDeltas.get(key);
      const before = meshChanged
        ? null
        : finalBlockFromMaps(this, delta, nextChainDeltas, this.pendingDeltas);
      nextChainDeltas.set(key, delta);
      if (protectUntilSnapshot) nextUnobservedChainDeltaKeys.add(key);
      else nextUnobservedChainDeltaKeys.delete(key);
      if (!meshChanged) {
        meshChanged = before !== finalBlockFromMaps(this, delta, nextChainDeltas, this.pendingDeltas);
      }
      if (previous?.blockId !== delta.blockId) {
        deltaChanged = true;
        boundaryMask |= boundaryMaskForDelta(delta, this.chunkSize);
      }
      accepted += 1;
    }
    assertResidentDeltaCapacity(nextChainDeltas, this.pendingDeltas, this.id);
    if (!accepted) {
      return {
        applied: false,
        accepted: 0,
        changed: false,
        boundaryMask: 0,
        chainRevision: this.chainRevision,
      };
    }
    this.chainDeltas = nextChainDeltas;
    this.unobservedChainDeltaKeys = nextUnobservedChainDeltaKeys;
    this.finalDeltaMapCache = null;
    this.chainRevision += 1;
    this.chainSnapshotToken = 0;
    if (meshChanged || deltaChanged) this.markDirty(REVEAL_STATE.MODIFIED);
    else this.revealState = REVEAL_STATE.MODIFIED;
    return { applied: accepted > 0, accepted, changed: meshChanged || deltaChanged, boundaryMask, chainRevision: this.chainRevision };
  }

  replaceChainDeltas(deltas = [], { expectedChainRevision = null, snapshotToken = 0, snapshotSlot = 0 } = {}) {
    const expected = expectedChainRevision === null
      ? null
      : nonNegativeSafeInteger(expectedChainRevision, "Expected chain revision");
    const nextSnapshotToken = nonNegativeSafeInteger(snapshotToken, "Snapshot token");
    const incomingSlot = nonNegativeSafeInteger(snapshotSlot, "Snapshot slot");
    const normalizedDeltas = normalizeDeltaBatch(deltas ?? [], this);
    for (const delta of normalizedDeltas) {
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) {
        throw new RangeError(
          `Chain snapshot delta belongs to chunk ${delta.chunkX},${delta.chunkZ}; expected ${this.id}.`,
        );
      }
    }

    if (expected !== null && expected !== this.chainRevision) {
      return { applied: false, reason: "stale-chain-revision", changed: false, chainRevision: this.chainRevision };
    }
    if (this.chainSnapshotSlot > 0 && incomingSlot < this.chainSnapshotSlot) {
      return {
        applied: false,
        reason: "stale-chain-slot",
        changed: false,
        chainRevision: this.chainRevision,
        chainSnapshotSlot: this.chainSnapshotSlot,
      };
    }

    const next = new Map();
    for (const normalized of normalizedDeltas) {
      const delta = { ...normalized, source: "chain" };
      next.set(deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize), delta);
    }

    // A confirmed transaction can be newer than a lagging RPC node. Keep its
    // delta until a full account snapshot has observed the same value once.
    const nextUnobservedChainDeltaKeys = new Set(this.unobservedChainDeltaKeys);
    for (const key of nextUnobservedChainDeltaKeys) {
      const protectedDelta = this.chainDeltas.get(key);
      if (!protectedDelta) {
        nextUnobservedChainDeltaKeys.delete(key);
        continue;
      }
      const observed = next.get(key);
      if (observed?.blockId === protectedDelta.blockId) {
        nextUnobservedChainDeltaKeys.delete(key);
      } else {
        next.set(key, protectedDelta);
      }
    }
    assertResidentDeltaCapacity(next, this.pendingDeltas, this.id);

    let meshChanged = false;
    let deltaChanged = false;
    let boundaryMask = 0;
    for (const [key, beforeDelta] of this.chainDeltas) {
      if (this.pendingDeltas.has(key)) continue;
      const afterDelta = next.get(key);
      if (beforeDelta?.blockId === afterDelta?.blockId) continue;
      const sample = afterDelta ?? beforeDelta;
      if (!sample) continue;
      deltaChanged = true;
      boundaryMask |= boundaryMaskForDelta(sample, this.chunkSize);
      if (!meshChanged) {
        const base = this.getBaseBlock(sample.localX, sample.localY, sample.localZ);
        const before = beforeDelta?.blockId ?? base;
        const after = afterDelta?.blockId ?? base;
        if (before !== after) meshChanged = true;
      }
    }
    for (const [key, afterDelta] of next) {
      if (this.chainDeltas.has(key) || this.pendingDeltas.has(key)) continue;
      deltaChanged = true;
      boundaryMask |= boundaryMaskForDelta(afterDelta, this.chunkSize);
      if (!meshChanged && this.getBaseBlock(afterDelta.localX, afterDelta.localY, afterDelta.localZ) !== afterDelta.blockId) meshChanged = true;
    }

    this.chainDeltas = next;
    this.unobservedChainDeltaKeys = nextUnobservedChainDeltaKeys;
    this.finalDeltaMapCache = null;
    this.chainRevision += 1;
    this.chainSnapshotToken = nextSnapshotToken;
    this.chainSnapshotSlot = Math.max(this.chainSnapshotSlot, incomingSlot);
    if (meshChanged || deltaChanged) this.markDirty(REVEAL_STATE.MODIFIED);
    else this.revealState = next.size ? REVEAL_STATE.CONFIRMED : (this.pendingDeltas.size ? REVEAL_STATE.DIRTY : REVEAL_STATE.REVEALED);
    return {
      applied: true,
      changed: meshChanged || deltaChanged,
      boundaryMask,
      deltaCount: next.size,
      retainedUnobserved: this.unobservedChainDeltaKeys.size,
      effectiveDeltas: Array.from(next.values()),
      chainRevision: this.chainRevision,
      snapshotToken: this.chainSnapshotToken,
      chainSnapshotSlot: this.chainSnapshotSlot,
    };
  }

  acknowledgeChainSnapshot({ snapshotToken = 0, snapshotSlot = 0 } = {}) {
    const token = nonNegativeSafeInteger(snapshotToken, "Snapshot token");
    const slot = nonNegativeSafeInteger(snapshotSlot, "Snapshot slot");
    if (!token || token !== this.chainSnapshotToken || slot < this.chainSnapshotSlot) return false;
    this.chainSnapshotSlot = Math.max(this.chainSnapshotSlot, slot);
    return true;
  }

  resetChainSnapshotAuthority() {
    this.chainSnapshotToken = 0;
    this.chainSnapshotSlot = 0;
    this.unobservedChainDeltaKeys.clear();
  }

  clearChainDeltas() {
    if (!this.chainDeltas.size) {
      if (!this.chainSnapshotToken && !this.chainSnapshotSlot && !this.unobservedChainDeltaKeys.size) return false;
      this.unobservedChainDeltaKeys.clear();
      this.chainSnapshotToken = 0;
      this.chainSnapshotSlot = 0;
      return { cleared: true, changed: false, boundaryMask: 0 };
    }
    let meshChanged = false;
    let deltaChanged = false;
    let boundaryMask = 0;
    for (const delta of this.chainDeltas.values()) {
      if (this.pendingDeltas.has(deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize))) continue;
      deltaChanged = true;
      boundaryMask |= boundaryMaskForDelta(delta, this.chunkSize);
      meshChanged ||= this.getFinalBlock(delta.localX, delta.localY, delta.localZ) !== this.getBaseBlock(delta.localX, delta.localY, delta.localZ);
    }
    this.chainDeltas.clear();
    this.unobservedChainDeltaKeys.clear();
    this.finalDeltaMapCache = null;
    this.chainRevision += 1;
    this.chainSnapshotToken = 0;
    this.chainSnapshotSlot = 0;
    if (meshChanged || deltaChanged) this.markDirty(this.pendingDeltas.size ? REVEAL_STATE.DIRTY : REVEAL_STATE.REVEALED);
    else this.revealState = this.pendingDeltas.size ? REVEAL_STATE.DIRTY : REVEAL_STATE.REVEALED;
    return { cleared: true, changed: meshChanged || deltaChanged, boundaryMask };
  }

  applyPendingDelta(deltas = [], txId) {
    const normalizedDeltas = normalizeDeltaBatch(deltas, this);
    assertProjectedResidentDeltaCapacity(this, normalizedDeltas, "pendingDeltas");
    const nextPendingDeltas = new Map(this.pendingDeltas);
    let meshChanged = false;
    let deltaChanged = false;
    let boundaryMask = 0;
    let accepted = 0;
    for (const normalized of normalizedDeltas) {
      const delta = { ...normalized, source: "pending", txId };
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) continue;
      const key = deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize);
      const previous = nextPendingDeltas.get(key) ?? this.chainDeltas.get(key);
      const before = meshChanged
        ? null
        : finalBlockFromMaps(this, delta, this.chainDeltas, nextPendingDeltas);
      nextPendingDeltas.set(key, delta);
      if (!meshChanged) {
        meshChanged = before !== finalBlockFromMaps(this, delta, this.chainDeltas, nextPendingDeltas);
      }
      if (previous?.blockId !== delta.blockId) {
        deltaChanged = true;
        boundaryMask |= boundaryMaskForDelta(delta, this.chunkSize);
      }
      accepted += 1;
    }
    assertResidentDeltaCapacity(this.chainDeltas, nextPendingDeltas, this.id);
    if (!accepted) return { applied: false, accepted: 0, changed: false, boundaryMask: 0 };
    this.pendingDeltas = nextPendingDeltas;
    this.finalDeltaMapCache = null;
    if (meshChanged || deltaChanged) this.markDirty(REVEAL_STATE.DIRTY);
    else this.revealState = REVEAL_STATE.DIRTY;
    return { applied: accepted > 0, accepted, changed: meshChanged || deltaChanged, boundaryMask };
  }

  confirmPendingDelta(txId) {
    let changed = false;
    for (const [key, delta] of Array.from(this.pendingDeltas.entries())) {
      if (delta.txId !== txId) continue;
      this.pendingDeltas.delete(key);
      this.chainDeltas.set(key, { ...delta, source: "chain" });
      this.unobservedChainDeltaKeys.add(key);
      changed = true;
    }
    if (changed) this.revealState = REVEAL_STATE.CONFIRMED;
    if (changed) {
      this.finalDeltaMapCache = null;
      this.chainRevision += 1;
      this.chainSnapshotToken = 0;
    }
    return changed;
  }

  rollbackPendingDelta(txId) {
    let changed = false;
    let meshChanged = false;
    let deltaChanged = false;
    let boundaryMask = 0;
    for (const [key, delta] of Array.from(this.pendingDeltas.entries())) {
      if (delta.txId !== txId) continue;
      const before = this.getFinalBlock(delta.localX, delta.localY, delta.localZ);
      this.pendingDeltas.delete(key);
      const after = this.getFinalBlock(delta.localX, delta.localY, delta.localZ);
      meshChanged ||= before !== after;
      if (delta.blockId !== this.chainDeltas.get(key)?.blockId) {
        deltaChanged = true;
        boundaryMask |= boundaryMaskForDelta(delta, this.chunkSize);
      }
      changed = true;
    }
    if (meshChanged || deltaChanged) this.markDirty(REVEAL_STATE.CONFLICT);
    else if (changed) this.revealState = REVEAL_STATE.CONFLICT;
    if (changed) this.finalDeltaMapCache = null;
    return { rolledBack: changed, changed: meshChanged || deltaChanged, boundaryMask };
  }

  markDirty(state = REVEAL_STATE.DIRTY) {
    this.dirty = true;
    this.version += 1;
    this.revealState = state;
  }

  markQueued(taskId = null) {
    this.buildState = "queued";
    this.buildTaskId = taskId;
    this.buildError = null;
  }

  markBuilding(taskId) {
    this.buildState = "building";
    this.buildTaskId = taskId;
    this.buildError = null;
  }

  markBuildError(error) {
    this.buildState = "error";
    this.buildError = error?.message || String(error);
    this.buildTaskId = null;
  }

  markBuildStale() {
    this.buildState = this.baseBlocksReady ? "ready" : "empty";
    this.buildTaskId = null;
    this.buildError = null;
    this.dirty = true;
  }

  setBaseBlocks(baseBlocks, treeInstances = this.treeInstances) {
    this.baseBlocks = baseBlocks ?? new Uint16Array(this.chunkSize * this.height * this.chunkSize);
    this.baseProfile = null;
    this.baseBlockResolver = null;
    this.treeInstances = treeInstances ?? [];
    this.baseBlocksReady = true;
    this.buildState = "ready";
    this.buildTaskId = null;
    this.buildError = null;
  }

  setBaseProfile(baseProfile, treeInstances = this.treeInstances, baseBlockResolver = null) {
    this.baseBlocks = null;
    this.baseProfile = baseProfile ?? null;
    this.baseBlockResolver = typeof baseBlockResolver === "function" ? baseBlockResolver : null;
    this.treeInstances = treeInstances ?? [];
    this.baseBlocksReady = Boolean(this.baseProfile || this.baseBlockResolver);
    this.buildState = this.baseBlocksReady ? "ready" : "empty";
    this.buildTaskId = null;
    this.buildError = null;
  }

  setMesh(mesh, meshVersion = this.version) {
    const committedVersion = normalizedMeshVersion(meshVersion, this.version);
    this.mesh = mesh;
    this.meshVersion = committedVersion;
    this.dirty = false;
    this.gpuUploaded = false;
    this.visualMesh = null;
    this.visualMeshVersion = committedVersion;
    this.visualGpuUploaded = false;
    this.baseBlocksReady = true;
    this.buildState = "ready";
    this.buildTaskId = null;
  }

  setMeshes(mesh, visualMesh = null, meshVersion = this.version) {
    const committedVersion = normalizedMeshVersion(meshVersion, this.version);
    this.mesh = mesh;
    this.meshVersion = committedVersion;
    this.visualMesh = visualMesh;
    this.visualMeshVersion = committedVersion;
    this.dirty = false;
    this.gpuUploaded = false;
    this.visualGpuUploaded = false;
    this.baseBlocksReady = true;
    this.buildState = "ready";
    this.buildTaskId = null;
  }

  setVisualMesh(visualMesh, meshVersion = this.version) {
    this.visualMesh = visualMesh;
    this.visualMeshVersion = normalizedMeshVersion(meshVersion, this.version);
    this.visualGpuUploaded = false;
  }
}

function normalizedMeshVersion(value, fallback) {
  const revision = Number(value);
  return Number.isFinite(revision) ? Math.trunc(revision) : Math.trunc(Number(fallback) || 0);
}

function normalizeDeltaBatch(deltas, chunk) {
  const source = deltas ?? [];
  if (Array.isArray(source) && source.length > DELTA_RESOURCE_LIMITS.maxBatchEntries) {
    throw deltaBatchEntryLimitError();
  }
  const normalized = [];
  for (const delta of source) {
    if (normalized.length >= DELTA_RESOURCE_LIMITS.maxBatchEntries) throw deltaBatchEntryLimitError();
    const entry = normalizeDelta(delta, chunk.chunkSize);
    if (entry.worldY < chunk.minY || entry.worldY > chunk.maxBuildY) {
      throw new RangeError(
        `Delta world Y must be an integer from the configured build minimum ${chunk.minY} to maximum ${chunk.maxBuildY}.`,
      );
    }
    normalized.push(entry);
  }
  return normalized;
}

function assertResidentDeltaCapacity(chainDeltas, pendingDeltas, id) {
  if (chainDeltas.size + pendingDeltas.size <= DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk) return;
  throw new RangeError(
    `Chunk ${id} exceeds the ${DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk}-entry resident delta safety limit.`,
  );
}

function assertProjectedResidentDeltaCapacity(chunk, normalizedDeltas, targetMapName) {
  const target = chunk[targetMapName];
  const other = targetMapName === "chainDeltas" ? chunk.pendingDeltas : chunk.chainDeltas;
  let projectedTargetSize = target.size;
  if (projectedTargetSize + other.size > DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk) {
    assertResidentDeltaCapacity(
      targetMapName === "chainDeltas" ? target : other,
      targetMapName === "pendingDeltas" ? target : other,
      chunk.id,
    );
  }
  const addedKeys = new Set();
  for (const delta of normalizedDeltas) {
    if (delta.chunkX !== chunk.chunkX || delta.chunkZ !== chunk.chunkZ) continue;
    const key = deltaKey(delta.localX, delta.localY, delta.localZ, chunk.chunkSize);
    if (target.has(key) || addedKeys.has(key)) continue;
    addedKeys.add(key);
    projectedTargetSize += 1;
    if (projectedTargetSize + other.size > DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk) {
      throw new RangeError(
        `Chunk ${chunk.id} exceeds the ${DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk}-entry resident delta safety limit.`,
      );
    }
  }
}

function deltaBatchEntryLimitError() {
  return new RangeError(
    `Delta batch exceeds the ${DELTA_RESOURCE_LIMITS.maxBatchEntries}-entry safety limit.`,
  );
}

function finalBlockFromMaps(chunk, delta, chainDeltas, pendingDeltas) {
  if (!containsLocal(delta.localX, delta.localY, delta.localZ, chunk)) return BLOCK_ID.air;
  const key = deltaKey(delta.localX, delta.localY, delta.localZ, chunk.chunkSize);
  return pendingDeltas.get(key)?.blockId
    ?? chainDeltas.get(key)?.blockId
    ?? chunk.getBaseBlock(delta.localX, delta.localY, delta.localZ);
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value === 0 ? 0 : value;
}

function boundaryMaskForDelta(delta, chunkSize) {
  let mask = 0;
  // Tree canopies extend two blocks beyond their root chunk. Dirtifying this
  // narrow visual margin lets a leaf delta rebuild the one proxy mesh that owns
  // the tree without widening normal terrain sampling or adding draw calls.
  const visualMargin = Math.max(1, Math.min(2, chunkSize));
  if (delta.localX < visualMargin) mask |= CHUNK_BOUNDARY_MASK.NEGATIVE_X;
  if (delta.localX >= chunkSize - visualMargin) mask |= CHUNK_BOUNDARY_MASK.POSITIVE_X;
  if (delta.localZ < visualMargin) mask |= CHUNK_BOUNDARY_MASK.NEGATIVE_Z;
  if (delta.localZ >= chunkSize - visualMargin) mask |= CHUNK_BOUNDARY_MASK.POSITIVE_Z;
  return mask;
}

function setChunkStateWorldSeed(chunk, value) {
  chunkStateWorldSeeds.set(chunk, value == null ? null : normalizeSeedBytes(value));
}
