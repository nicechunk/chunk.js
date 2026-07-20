import { REVEAL_STATE, DEFAULT_CHUNK_HEIGHT, DEFAULT_CHUNK_SIZE, DEFAULT_MIN_WORLD_Y } from "../core/constants.js";
import { chunkId, containsLocal, localIndex } from "../core/coordinates.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { DEFAULT_GENERATION_VERSION, DEFAULT_RESOURCE_RULE_VERSION } from "../world/world-generator.js";
import { deltaKey, normalizeDelta } from "./chunk-delta.js";

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
    this.id = chunkId(chunkX, chunkZ);
    this.chunkX = Math.trunc(chunkX);
    this.chunkZ = Math.trunc(chunkZ);
    this.chunkSize = Math.trunc(chunkSize);
    this.height = Math.trunc(height);
    this.minY = Math.trunc(minY);
    this.generationVersion = generationVersion;
    this.resourceRuleVersion = resourceRuleVersion;
    this.materialVersion = materialVersion;
    this.worldSeed = worldSeed;
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
    if (this.baseBlocks) return this.baseBlocks[localIndex(localX, localY, localZ, this)] ?? BLOCK_ID.air;
    if (this.baseProfile) {
      const x = Math.trunc(localX);
      const y = Math.trunc(localY);
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
    let meshChanged = false;
    let deltaChanged = false;
    let boundaryMask = 0;
    let accepted = 0;
    for (const raw of deltas) {
      const delta = normalizeDelta(raw, this.chunkSize);
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) continue;
      const key = deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize);
      const previous = this.chainDeltas.get(key);
      const before = meshChanged ? null : this.getFinalBlock(delta.localX, delta.localY, delta.localZ);
      delta.source = "chain";
      this.chainDeltas.set(key, delta);
      if (protectUntilSnapshot) this.unobservedChainDeltaKeys.add(key);
      else this.unobservedChainDeltaKeys.delete(key);
      if (!meshChanged) meshChanged = before !== this.getFinalBlock(delta.localX, delta.localY, delta.localZ);
      if (previous?.blockId !== delta.blockId) {
        deltaChanged = true;
        boundaryMask |= boundaryMaskForDelta(delta, this.chunkSize);
      }
      accepted += 1;
    }
    if (accepted) {
      this.finalDeltaMapCache = null;
      this.chainRevision += 1;
      this.chainSnapshotToken = 0;
    }
    if (meshChanged || deltaChanged) this.markDirty(REVEAL_STATE.MODIFIED);
    else this.revealState = REVEAL_STATE.MODIFIED;
    return { applied: accepted > 0, accepted, changed: meshChanged || deltaChanged, boundaryMask, chainRevision: this.chainRevision };
  }

  replaceChainDeltas(deltas = [], { expectedChainRevision = null, snapshotToken = 0, snapshotSlot = 0 } = {}) {
    const expected = Number(expectedChainRevision);
    if (Number.isFinite(expected) && Math.trunc(expected) !== this.chainRevision) {
      return { applied: false, reason: "stale-chain-revision", changed: false, chainRevision: this.chainRevision };
    }
    const incomingSlot = Math.max(0, Math.trunc(Number(snapshotSlot) || 0));
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
    for (const raw of deltas ?? []) {
      const delta = normalizeDelta(raw, this.chunkSize);
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) continue;
      delta.source = "chain";
      next.set(deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize), delta);
    }

    // A confirmed transaction can be newer than a lagging RPC node. Keep its
    // delta until a full account snapshot has observed the same value once.
    for (const key of this.unobservedChainDeltaKeys) {
      const protectedDelta = this.chainDeltas.get(key);
      if (!protectedDelta) {
        this.unobservedChainDeltaKeys.delete(key);
        continue;
      }
      const observed = next.get(key);
      if (observed?.blockId === protectedDelta.blockId) {
        this.unobservedChainDeltaKeys.delete(key);
      } else {
        next.set(key, protectedDelta);
      }
    }

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
    this.finalDeltaMapCache = null;
    this.chainRevision += 1;
    this.chainSnapshotToken = Math.max(0, Math.trunc(Number(snapshotToken) || 0));
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
    const token = Math.max(0, Math.trunc(Number(snapshotToken) || 0));
    const slot = Math.max(0, Math.trunc(Number(snapshotSlot) || 0));
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
    let meshChanged = false;
    let deltaChanged = false;
    let boundaryMask = 0;
    let accepted = 0;
    for (const raw of deltas) {
      const delta = normalizeDelta(raw, this.chunkSize);
      delta.txId = txId;
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) continue;
      const key = deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize);
      const previous = this.pendingDeltas.get(key) ?? this.chainDeltas.get(key);
      const before = this.getFinalBlock(delta.localX, delta.localY, delta.localZ);
      this.pendingDeltas.set(key, { ...delta, source: "pending", txId });
      meshChanged ||= before !== this.getFinalBlock(delta.localX, delta.localY, delta.localZ);
      if (previous?.blockId !== delta.blockId) {
        deltaChanged = true;
        boundaryMask |= boundaryMaskForDelta(delta, this.chunkSize);
      }
      accepted += 1;
    }
    if (meshChanged || deltaChanged) this.markDirty(REVEAL_STATE.DIRTY);
    else this.revealState = REVEAL_STATE.DIRTY;
    if (accepted) this.finalDeltaMapCache = null;
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
