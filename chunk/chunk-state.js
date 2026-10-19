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

import { confirmationProtection, mayReplaceProtectedDelta, optionalSnapshotSlot, REMOTE_DELTA_TTL_MS } from "./chunk-authority.js";

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
    this.pickedSurfaceColumns = [];
    this.version = 0;
    // Authority preparation depends on actual voxel/overlay/base inputs, not
    // render-only neighbour halo and lighting invalidations of `version`.
    this.authorityInputRevision = 0;
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
    this.confirmedDeltaProtection = new Map();
    this.remoteDeltas = new Map();
    this.remoteDeltaExpiryAt = Infinity;
    this.authorityEpoch = 1;
    this.authorityNow = () => Date.now();
    this.pendingDeltas = new Map();
    this.finalDeltaMapCache = null;
    this.chainRevision = 0;
    this.chainSnapshotToken = 0;
    this.chainSnapshotSlot = null;
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
    this.expireRemoteDeltas();
    if (!this.pendingDeltas.size && !this.chainDeltas.size && !this.remoteDeltas.size) return this.getBaseBlock(localX, localY, localZ);
    const key = deltaKey(localX, localY, localZ, this.chunkSize);
    const pending = this.pendingDeltas.get(key);
    if (pending) return pending.blockId;
    const remote = this.remoteDeltas.get(key);
    if (remote) return remote.blockId;
    const chain = this.chainDeltas.get(key);
    if (chain) return chain.blockId;
    return this.getBaseBlock(localX, localY, localZ);
  }

  revealStateAt(localX, localY, localZ) {
    const key = deltaKey(localX, localY, localZ, this.chunkSize);
    if (this.pendingDeltas.has(key)) return REVEAL_STATE.DIRTY;
    if (this.remoteDeltas.has(key)) return REVEAL_STATE.MODIFIED;
    if (this.chainDeltas.has(key)) return REVEAL_STATE.CONFIRMED;
    return this.blockRevealStates.get(key) ?? this.revealState;
  }

  hasDeltaAt(localX, localY, localZ) {
    this.expireRemoteDeltas();
    if (!this.pendingDeltas.size && !this.chainDeltas.size && !this.remoteDeltas.size) return false;
    const key = deltaKey(localX, localY, localZ, this.chunkSize);
    return this.pendingDeltas.has(key) || this.remoteDeltas.has(key) || this.chainDeltas.has(key);
  }

  getFinalDeltaMap() {
    this.expireRemoteDeltas();
    if (!this.pendingDeltas.size && !this.remoteDeltas.size) return this.chainDeltas;
    if (this.finalDeltaMapCache) return this.finalDeltaMapCache;
    const merged = new Map(this.chainDeltas);
    for (const [key, delta] of this.remoteDeltas) merged.set(key, delta);
    for (const [key, delta] of this.pendingDeltas) merged.set(key, delta);
    this.finalDeltaMapCache = merged;
    return merged;
  }

  applyRemoteDelta(deltas = [], { ttlMs = REMOTE_DELTA_TTL_MS, now = this.authorityNow() } = {}) {
    const normalized = normalizeDeltaBatch(deltas, this);
    const next = new Map(this.remoteDeltas);
    let boundaryMask = 0;
    const expiresAt = now + Math.max(1, Math.min(REMOTE_DELTA_TTL_MS, Number(ttlMs) || REMOTE_DELTA_TTL_MS));
    for (const delta of normalized) {
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) continue;
      const key = deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize);
      // Unverified hints never replace a newer local confirmed/pending change.
      if (this.pendingDeltas.has(key) || this.confirmedDeltaProtection.has(key)) continue;
      if (next.size >= 2048 && !next.has(key)) continue;
      next.set(key, { ...delta, source: "remote", expiresAt });
      boundaryMask |= boundaryMaskForDelta(delta, this.chunkSize);
    }
    if (next.size === 0) return { applied: false, changed: false, boundaryMask: 0 };
    this.remoteDeltas = next;
    this.authorityInputRevision++;
    this.onRemoteDeltasChanged?.();
    this.remoteDeltaExpiryAt = Math.min(this.remoteDeltaExpiryAt, expiresAt);
    this.finalDeltaMapCache = null;
    this.invalidateRenderSections?.(normalized);
    this.markDirty(REVEAL_STATE.MODIFIED, normalized);
    return { applied: true, changed: true, boundaryMask };
  }

  expireRemoteDeltas(now = this.authorityNow()) {
    if (now < this.remoteDeltaExpiryAt) return { changed: false, boundaryMask: 0 };
    const expired = [];
    let nextExpiry = Infinity;
    for (const [key, delta] of this.remoteDeltas) {
      if (delta.expiresAt <= now) { this.remoteDeltas.delete(key); expired.push(delta); }
      else nextExpiry = Math.min(nextExpiry, delta.expiresAt);
    }
    this.remoteDeltaExpiryAt = nextExpiry;
    this.onRemoteDeltasChanged?.();
    if (!expired.length) return { changed: false, boundaryMask: 0 };
    this.authorityInputRevision++;
    this.finalDeltaMapCache = null;
    this.invalidateRenderSections?.(expired);
    this.markDirty(REVEAL_STATE.MODIFIED, expired);
    const boundaryMask = expired.reduce((mask, delta) => mask | boundaryMaskForDelta(delta, this.chunkSize), 0);
    this.onRemoteDeltasExpired?.(expired, boundaryMask);
    return { changed: true, boundaryMask, deltas: expired };
  }

  applyChainDelta(deltas = [], { protectUntilSnapshot = true, confirmation = null } = {}) {
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
    this.authorityInputRevision++;
    this.unobservedChainDeltaKeys = nextUnobservedChainDeltaKeys;
    for (const delta of normalizedDeltas) {
      if (delta.chunkX !== this.chunkX || delta.chunkZ !== this.chunkZ) continue;
      const key = deltaKey(delta.localX, delta.localY, delta.localZ, this.chunkSize);
      if (protectUntilSnapshot) this.confirmedDeltaProtection.set(key, confirmationProtection(confirmation || {}, this.authorityNow()));
      else this.confirmedDeltaProtection.delete(key);
      this.remoteDeltas.delete(key);
    }
    this.onRemoteDeltasChanged?.();
    this.invalidateRenderSections?.(normalizedDeltas);
    this.finalDeltaMapCache = null;
    this.chainRevision += 1;
    this.chainSnapshotToken = 0;
    if (meshChanged || deltaChanged) this.markDirty(REVEAL_STATE.MODIFIED, normalizedDeltas);
    else this.revealState = REVEAL_STATE.MODIFIED;
    return { applied: accepted > 0, accepted, changed: meshChanged || deltaChanged, boundaryMask, chainRevision: this.chainRevision };
  }

  replaceChainDeltas(deltas = [], options = {}) {
    const preparation = this.prepareChainSnapshot(deltas, options);
    while (!preparation.done) preparation.step({ maxEntries: 512, budgetMs: Infinity });
    return this.commitPreparedChainSnapshot(preparation);
  }

  prepareChainSnapshot(deltas = [], options = {}) {
    const expected = options.expectedChainRevision == null ? null : nonNegativeSafeInteger(options.expectedChainRevision, "Expected chain revision");
    const token = nonNegativeSafeInteger(options.snapshotToken === undefined ? 0 : options.snapshotToken, "Snapshot token");
    const slot = optionalSnapshotSlot(options.snapshotSlot);
    const source = options.source || "rpc";
    const snapshotCommitment = options.snapshotCommitment || "confirmed";
    const now = this.authorityNow();
    const metadata = { snapshotSlot: slot, snapshotCommitment, source, readStartedAt: options.readStartedAt ?? now, now };
    const revision = this.chainRevision;
    const worldVersion = this.version;
    const inputRevision = this.authorityInputRevision;
    const baseIdentity = { baseBlocks: this.baseBlocks, baseProfile: this.baseProfile, baseBlockResolver: this.baseBlockResolver, baseBlocksReady: this.baseBlocksReady, treeInstances: this.treeInstances, materialVersion: this.materialVersion, generationVersion: this.generationVersion, resourceRuleVersion: this.resourceRuleVersion, minY: this.minY, height: this.height, maxBuildY: this.maxBuildY, surfaceDecorationRules: this.surfaceDecorationRules };
    const epoch = this.authorityEpoch;
    const chunk = this;
    const next = new Map();
    const protections = new Map();
    const protectedKeys = new Set();
    const changes = [];
    let renderPlan = null;
    let boundaryMask = 0;
    let retained = 0;
    let done = false;
    let result = null;
    const sourceDeltas = deltas ?? [];
    const packed = sourceDeltas instanceof Int32Array;
    if (packed && sourceDeltas.length % 4) throw new RangeError("Packed chunk deltas must contain four integers per entry.");
    if ((packed ? sourceDeltas.length / 4 : sourceDeltas.length) > DELTA_RESOURCE_LIMITS.maxBatchEntries) throw deltaBatchEntryLimitError();
    function *prepare() {
      if (expected !== null && expected !== revision) { result = { applied: false, reason: "stale-chain-revision", changed: false }; return; }
      if (chunk.chainSnapshotSlot !== null && (slot === null || slot < chunk.chainSnapshotSlot)) {
        result = { applied: false, reason: "stale-chain-slot", changed: false }; return;
      }
      for (let index = 0; index < sourceDeltas.length; index += packed ? 4 : 1) {
        const raw = packed ? { worldX: sourceDeltas[index], worldY: sourceDeltas[index + 1], worldZ: sourceDeltas[index + 2], blockId: sourceDeltas[index + 3] } : sourceDeltas[index];
        const delta = normalizeDelta(raw, chunk.chunkSize);
        if (delta.worldY < chunk.minY || delta.worldY > chunk.maxBuildY) throw new RangeError(`Delta world Y must be an integer from the configured build minimum ${chunk.minY} to maximum ${chunk.maxBuildY}.`);
        if (delta.chunkX !== chunk.chunkX || delta.chunkZ !== chunk.chunkZ) throw new RangeError(`Chain snapshot delta belongs to chunk ${delta.chunkX},${delta.chunkZ}; expected ${chunk.id}.`);
        next.set(deltaKey(delta.localX, delta.localY, delta.localZ, chunk.chunkSize), { ...delta, source: "chain" });
        yield;
      }
      for (const [key, protection] of chunk.confirmedDeltaProtection) {
        const before = chunk.chainDeltas.get(key);
        const after = next.get(key);
        if (before && before.blockId !== (after?.blockId ?? chunk.getBaseBlock(before.localX, before.localY, before.localZ))
            && !mayReplaceProtectedDelta(protection, metadata)) {
          next.set(key, before); protections.set(key, protection); protectedKeys.add(key); retained += 1;
        }
        yield;
      }
      assertResidentDeltaCapacity(next, chunk.pendingDeltas, chunk.id);
      for (const [key, before] of chunk.chainDeltas) {
        const after = next.get(key);
        if (before.blockId !== after?.blockId) { const delta = after ?? before; changes.push(delta); boundaryMask |= boundaryMaskForDelta(delta, chunk.chunkSize); }
        yield;
      }
      for (const [key, after] of next) {
        if (!chunk.chainDeltas.has(key)) { changes.push(after); boundaryMask |= boundaryMaskForDelta(after, chunk.chunkSize); }
        yield;
      }
      // A complete RPC snapshot supersedes hints, including hints for records
      // absent in the new account pair. Persistent cache is only a preview.
      if (source === "rpc") for (const delta of chunk.remoteDeltas.values()) { changes.push(delta); boundaryMask |= boundaryMaskForDelta(delta, chunk.chunkSize); yield; }
      if (chunk.prepareRenderSnapshotInvalidation) renderPlan = yield* chunk.prepareRenderSnapshotInvalidation(next, changes, { dropRemote: source === "rpc" });
      result = { applied: true, changed: changes.length > 0, boundaryMask, deltaCount: next.size, retainedUnobserved: retained, chainRevision: revision + 1, snapshotToken: token, chainSnapshotSlot: slot };
    }
    const iterator = prepare();
    return {
      chunk, revision, worldVersion, inputRevision, baseIdentity, epoch, expected, options, next, protections, protectedKeys, changes,
      get renderPlan() { return renderPlan; },
      get done() { return done; },
      get result() { return result; },
      step({ maxEntries = 64, budgetMs = 1 } = {}) {
        if (!done && (chunk.chainRevision !== revision || chunk.authorityEpoch !== epoch)) { done = true; result = { applied: false, reason: "stale-chain-revision", changed: false }; }
        if (!done && (chunk.authorityInputRevision !== inputRevision || Object.entries(baseIdentity).some(([key, value]) => chunk[key] !== value))) { done = true; result = { applied: false, reason: "stale-world-revision", changed: false }; }
        const started = performance.now();
        let processed = 0;
        while (!done && processed < Math.max(1, maxEntries)) {
          const part = iterator.next(); done = part.done; processed += 1;
          if (performance.now() - started >= budgetMs) break;
        }
        return { done, processed, elapsedMs: performance.now() - started };
      },
    };
  }

  commitPreparedChainSnapshot(preparation) {
    if (preparation.chunk !== this || preparation.epoch !== this.authorityEpoch || preparation.revision !== this.chainRevision) return { applied: false, reason: "stale-chain-revision", changed: false };
    if (preparation.inputRevision !== this.authorityInputRevision || Object.entries(preparation.baseIdentity).some(([key, value]) => this[key] !== value)) return { applied: false, reason: "stale-world-revision", changed: false };
    if (preparation.renderPlan?.isCurrent && !preparation.renderPlan.isCurrent()) return { applied: false, reason: "stale-world-revision", changed: false };
    if (!preparation.done) return { applied: false, reason: "snapshot-not-prepared", changed: false };
    const result = preparation.result;
    if (!result?.applied) return result;
    assertResidentDeltaCapacity(preparation.next, this.pendingDeltas, this.id);
    this.chainDeltas = preparation.next;
    this.authorityInputRevision++;
    this.confirmedDeltaProtection = preparation.protections;
    this.unobservedChainDeltaKeys = preparation.protectedKeys;
    if ((preparation.options.source || "rpc") === "rpc") { this.remoteDeltas = new Map(); this.remoteDeltaExpiryAt = Infinity; this.onRemoteDeltasChanged?.(); }
    this.finalDeltaMapCache = null;
    this.chainRevision += 1;
    this.chainSnapshotToken = result.snapshotToken;
    this.chainSnapshotSlot = result.chainSnapshotSlot;
    if (result.changed) {
      if (preparation.renderPlan) preparation.renderPlan.commit();
      else this.invalidateRenderSections?.(preparation.changes);
      this.markDirty(REVEAL_STATE.MODIFIED, preparation.changes);
    } else { preparation.renderPlan?.commit(); this.revealState = this.chainDeltas.size ? REVEAL_STATE.CONFIRMED : (this.pendingDeltas.size ? REVEAL_STATE.DIRTY : REVEAL_STATE.REVEALED); }
    // Keep the old public result shape for callers that need final geometry;
    // do not persist these effective values as a verified RPC account snapshot.
    return Object.defineProperty({ ...result }, "effectiveDeltas", { enumerable: true, get: () => Array.from(this.chainDeltas.values()) });
  }

  acknowledgeChainSnapshot({ snapshotToken = 0, snapshotSlot = null } = {}) {
    const token = nonNegativeSafeInteger(snapshotToken, "Snapshot token");
    const slot = optionalSnapshotSlot(snapshotSlot);
    if (!token || token !== this.chainSnapshotToken || this.confirmedDeltaProtection.size || this.remoteDeltas.size || (this.chainSnapshotSlot !== null && (slot === null || slot < this.chainSnapshotSlot))) return false;
    if(this.chainSnapshotSlot!==slot)this.authorityInputRevision++;
    this.chainSnapshotSlot = slot;
    return true;
  }

  resetChainSnapshotAuthority() {
    this.authorityEpoch += 1;
    this.chainSnapshotToken = 0;
    this.chainSnapshotSlot = null;
    // Do not erase unobserved local confirmations when changing RPC endpoint.
  }

  clearChainDeltas() {
    if (!this.chainDeltas.size) {
      if (!this.chainSnapshotToken && !this.chainSnapshotSlot && !this.unobservedChainDeltaKeys.size) return false;
      this.unobservedChainDeltaKeys.clear();
      this.confirmedDeltaProtection.clear();
      this.chainSnapshotToken = 0;
      this.chainSnapshotSlot = null;
      this.authorityInputRevision++;
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
    this.authorityInputRevision++;
    this.unobservedChainDeltaKeys.clear();
    this.confirmedDeltaProtection.clear();
    this.finalDeltaMapCache = null;
    this.chainRevision += 1;
    this.chainSnapshotToken = 0;
    this.chainSnapshotSlot = null;
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
    this.authorityInputRevision++;
    this.finalDeltaMapCache = null;
    if (meshChanged || deltaChanged) { this.invalidateRenderSections?.(normalizedDeltas); this.markDirty(REVEAL_STATE.DIRTY, normalizedDeltas); }
    else this.revealState = REVEAL_STATE.DIRTY;
    return { applied: accepted > 0, accepted, changed: meshChanged || deltaChanged, boundaryMask };
  }

  confirmPendingDelta(txId, confirmation = {}) {
    let changed = false;
    for (const [key, delta] of Array.from(this.pendingDeltas.entries())) {
      if (delta.txId !== txId) continue;
      this.pendingDeltas.delete(key);
      this.chainDeltas.set(key, { ...delta, source: "chain" });
      this.unobservedChainDeltaKeys.add(key);
      this.confirmedDeltaProtection.set(key, confirmationProtection(confirmation, this.authorityNow()));
      this.remoteDeltas.delete(key);
      changed = true;
    }
    if (changed) this.revealState = REVEAL_STATE.CONFIRMED;
    if (changed) {
      this.onRemoteDeltasChanged?.();
      this.authorityInputRevision++;
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
    if (changed) { this.finalDeltaMapCache = null; this.authorityInputRevision++; }
    return { rolledBack: changed, changed: meshChanged || deltaChanged, boundaryMask };
  }

  markDirty(state = REVEAL_STATE.DIRTY) {
    if (this.renderSections && !this.renderInvalidationPending) this.invalidateRenderSections?.(null, "dependency");
    this.renderInvalidationPending = false;
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
    this.authorityInputRevision++;
    this.baseBlocks = baseBlocks ?? new Uint16Array(this.chunkSize * this.height * this.chunkSize);
    this.baseProfile = null;
    this.baseBlockResolver = null;
    this.treeInstances = treeInstances ?? [];
    this.baseBlocksReady = true;
    this.buildState = "ready";
    this.buildTaskId = null;
    this.buildError = null;
    this.invalidateRenderSections?.(null,"base-blocks");
  }

  setBaseProfile(baseProfile, treeInstances = this.treeInstances, baseBlockResolver = null) {
    this.authorityInputRevision++;
    this.baseBlocks = null;
    this.baseProfile = baseProfile ?? null;
    this.baseBlockResolver = typeof baseBlockResolver === "function" ? baseBlockResolver : null;
    this.treeInstances = treeInstances ?? [];
    this.baseBlocksReady = Boolean(this.baseProfile || this.baseBlockResolver);
    this.buildState = this.baseBlocksReady ? "ready" : "empty";
    this.buildTaskId = null;
    this.buildError = null;
    this.invalidateRenderSections?.(null,"base-profile");
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
  if (source instanceof Int32Array) return normalizePackedDeltaBatch(source, chunk);
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

function normalizePackedDeltaBatch(source, chunk) {
  if (source.length % 4 !== 0) {
    throw new RangeError("Packed chunk deltas must contain four integers per entry.");
  }
  const entryCount = source.length / 4;
  if (entryCount > DELTA_RESOURCE_LIMITS.maxBatchEntries) throw deltaBatchEntryLimitError();
  const normalized = new Array(entryCount);
  for (let offset = 0, index = 0; offset < source.length; offset += 4, index += 1) {
    const entry = normalizeDelta({
      worldX: source[offset],
      worldY: source[offset + 1],
      worldZ: source[offset + 2],
      blockId: source[offset + 3],
    }, chunk.chunkSize);
    if (entry.worldY < chunk.minY || entry.worldY > chunk.maxBuildY) {
      throw new RangeError(
        `Delta world Y must be an integer from the configured build minimum ${chunk.minY} to maximum ${chunk.maxBuildY}.`,
      );
    }
    normalized[index] = entry;
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
    ?? chunk.remoteDeltas.get(key)?.blockId
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
  if(Number.isSafeInteger(chunk.authorityInputRevision))chunk.authorityInputRevision++;
}
