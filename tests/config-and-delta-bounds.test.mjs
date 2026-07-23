import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";
import {
  DELTA_PROTOCOL_LIMITS,
  DELTA_RESOURCE_LIMITS,
  normalizeDelta,
} from "../chunk/chunk-delta.js";
import { ChunkState } from "../chunk/chunk-state.js";
import { createWorldGeneratorConfig } from "../world/world-generator.js";

test("world configuration rejects non-finite and unsafe allocation dimensions", () => {
  for (const options of [
    { chunkSize: Infinity },
    { chunkSize: 1_000_000 },
    { height: Infinity },
    { height: 1_000_000 },
    { chunkSize: 64, height: 4096 },
    { minY: 32_767, height: 2 },
  ]) {
    assert.throws(() => createWorldGeneratorConfig(options), RangeError);
  }

  const config = createWorldGeneratorConfig({ chunkSize: "16", height: "64", minY: "-16" });
  assert.equal(config.chunkSize, 16);
  assert.equal(config.height, 64);
  assert.equal(config.minY, -16);
  assert.equal(config.maxBuildY, 47);
});

test("ChunkManager keeps normalized world dimensions and bounded streaming controls", () => {
  assert.throws(
    () => new ChunkManager({ useWorkers: false, viewDistance: Infinity }),
    /view distance/,
  );
  assert.throws(
    () => new ChunkManager({ useWorkers: false, preloadMargin: -1 }),
    /preload margin/,
  );

  const manager = new ChunkManager({
    useWorkers: false,
    chunkSize: "16",
    height: "64",
    minY: "-16",
    viewDistance: 20,
    preloadMargin: 2,
    maxQueuedBuilds: 2025,
  });
  assert.equal(manager.chunkSize, manager.config.chunkSize);
  assert.equal(manager.height, manager.config.height);
  assert.equal(manager.minY, manager.config.minY);
  assert.equal(manager.preloadDistance, 22);
  assert.throws(() => manager.setViewDistance(Infinity), /view distance/);
  assert.throws(() => { manager.maxQueuedBuilds = Infinity; }, /maximum queued builds/);
  manager.dispose();
});

test("delta normalization preserves the transfer protocol and rejects truncation", () => {
  const accepted = normalizeDelta({
    worldX: DELTA_PROTOCOL_LIMITS.maxWorldXZ,
    worldY: DELTA_PROTOCOL_LIMITS.maxWorldY,
    worldZ: DELTA_PROTOCOL_LIMITS.minWorldXZ,
    blockId: DELTA_PROTOCOL_LIMITS.maxBlockId,
  }, 16);
  assert.equal(accepted.worldX, DELTA_PROTOCOL_LIMITS.maxWorldXZ);
  assert.equal(accepted.worldY, DELTA_PROTOCOL_LIMITS.maxWorldY);
  assert.equal(accepted.worldZ, DELTA_PROTOCOL_LIMITS.minWorldXZ);
  assert.equal(accepted.blockId, DELTA_PROTOCOL_LIMITS.maxBlockId);

  for (const delta of [
    { worldX: 2 ** 32, worldY: 0, worldZ: 0, blockId: 1 },
    { worldX: 0.5, worldY: 0, worldZ: 0, blockId: 1 },
    { worldX: "0", worldY: 0, worldZ: 0, blockId: 1 },
    { worldX: 0, worldY: 32_768, worldZ: 0, blockId: 1 },
    { worldX: 0, worldY: 0, worldZ: -2_147_483_649, blockId: 1 },
    { worldX: 0, worldY: 0, worldZ: 0, blockId: 65_536 },
    { worldX: 0, worldY: 0, worldZ: 0 },
  ]) {
    assert.throws(() => normalizeDelta(delta, 16), RangeError);
  }

  const state = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    height: 1,
    minY: 0,
    baseBlocks: new Uint16Array(16 * 16),
  });
  assert.throws(
    () => state.applyPendingDelta([{ worldX: 2 ** 32, worldY: 0, worldZ: 0, blockId: 1 }], "invalid"),
    /world X/,
  );
});

test("ChunkManager validates a complete delta batch before loading chunks", () => {
  const manager = new ChunkManager({ useWorkers: false });
  const valid = { worldX: 0, worldY: 0, worldZ: 0, blockId: 1 };

  assert.throws(
    () => manager.applyChainDelta([valid, { ...valid, worldX: "1" }]),
    /world X/,
  );
  assert.equal(manager.chunks.size, 0);

  assert.throws(
    () => manager.applyPendingDelta([valid, null], "invalid"),
    /Chunk delta must be an object/,
  );
  assert.equal(manager.chunks.size, 0);
  manager.dispose();
});

test("delta batches reject configured resource ceilings before loading or reading entries", () => {
  const manager = new ChunkManager({ useWorkers: false });
  let oversizedEntryRead = false;
  const oversized = new Array(DELTA_RESOURCE_LIMITS.maxBatchEntries + 1);
  Object.defineProperty(oversized, 0, {
    get() {
      oversizedEntryRead = true;
      throw new Error("oversized delta entry should not be read");
    },
  });

  assert.throws(
    () => manager.applyChainDelta(oversized),
    new RegExp(`${DELTA_RESOURCE_LIMITS.maxBatchEntries}-entry safety limit`),
  );
  assert.equal(oversizedEntryRead, false);
  assert.equal(manager.chunks.size, 0);

  const tooManyChunks = Array.from(
    { length: DELTA_RESOURCE_LIMITS.maxBatchChunks + 1 },
    (_, index) => ({ worldX: index * manager.chunkSize, worldY: 0, worldZ: 0, blockId: 0 }),
  );
  assert.throws(
    () => manager.applyPendingDelta(tooManyChunks, "too-many-chunks"),
    new RegExp(`${DELTA_RESOURCE_LIMITS.maxBatchChunks}-chunk safety limit`),
  );
  assert.equal(manager.chunks.size, 0);

  const state = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    height: 8,
    minY: 0,
    baseBlocks: new Uint16Array(16 * 8 * 16),
  });
  assert.throws(
    () => state.applyChainDelta(oversized),
    new RegExp(`${DELTA_RESOURCE_LIMITS.maxBatchEntries}-entry safety limit`),
  );
  assert.equal(oversizedEntryRead, false);
  manager.dispose();
});

test("manager and state reject deltas outside their configured vertical build span atomically", () => {
  const manager = new ChunkManager({ useWorkers: false, height: 8, minY: 10, maxBuildY: 14 });
  const valid = { worldX: 0, worldY: 10, worldZ: 0, blockId: 0 };

  for (const invalidY of [9, 15]) {
    assert.throws(
      () => manager.applyChainDelta([valid, { ...valid, worldY: invalidY }]),
      /configured build minimum 10 to maximum 14/,
    );
    assert.equal(manager.chunks.size, 0);
  }
  assert.throws(
    () => manager.ensureChunkForDelta({ ...valid, worldY: 15 }),
    /configured build minimum 10 to maximum 14/,
  );
  assert.equal(manager.chunks.size, 0);

  const state = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    height: 8,
    minY: 10,
    maxBuildY: 14,
    baseBlocks: new Uint16Array(16 * 8 * 16),
  });
  assert.throws(
    () => state.applyPendingDelta([valid, { ...valid, worldY: 15 }], "above-build-ceiling"),
    /configured build minimum 10 to maximum 14/,
  );
  assert.equal(state.pendingDeltas.size, 0);
  manager.dispose();
});

test("resident chain and pending deltas share one per-chunk memory ceiling", () => {
  const manager = new ChunkManager({ useWorkers: false, height: 8, minY: 0 });
  const first = manager.ensureChunk(0, 0);
  const saturated = manager.ensureChunk(1, 0);
  const retained = Object.freeze({
    worldX: 16,
    worldY: 0,
    worldZ: 0,
    localX: 0,
    localY: 0,
    localZ: 0,
    blockId: 0,
    source: "chain",
  });
  for (let key = 0; key < DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk; key += 1) {
    saturated.chainDeltas.set(key, retained);
  }

  const batch = [
    { worldX: 0, worldY: 0, worldZ: 0, blockId: 0 },
    { worldX: 16, worldY: 0, worldZ: 0, blockId: 0 },
  ];
  assert.throws(
    () => manager.applyPendingDelta(batch, "resident-overflow"),
    new RegExp(`${DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk}-entry resident delta safety limit`),
  );
  assert.equal(first.pendingDeltas.size, 0, "a later chunk overflow must reject the manager batch before earlier chunks mutate");
  assert.equal(saturated.pendingDeltas.size, 0);

  const chainReference = saturated.chainDeltas;
  const pendingReference = saturated.pendingDeltas;
  assert.throws(
    () => saturated.applyPendingDelta([batch[1]], "direct-overflow"),
    new RegExp(`${DELTA_RESOURCE_LIMITS.maxResidentEntriesPerChunk}-entry resident delta safety limit`),
  );
  assert.strictEqual(saturated.chainDeltas, chainReference);
  assert.strictEqual(saturated.pendingDeltas, pendingReference);
  assert.equal(saturated.pendingDeltas.size, 0);

  manager.dispose();
});

test("Worker delta collection stops at its bound instead of exhausting an unbounded iterable", () => {
  const manager = new ChunkManager({ useWorkers: false, height: 1, minY: 0 });
  let yielded = 0;
  const boundaryDelta = {
    worldX: 16,
    worldY: 0,
    worldZ: 0,
    localX: 0,
    localY: 0,
    localZ: 0,
    blockId: 0,
  };
  const values = {
    [Symbol.iterator]() {
      return {
        next() {
          yielded += 1;
          return { done: false, value: boundaryDelta };
        },
      };
    },
  };
  manager.chunks.set("1,0", {
    getFinalDeltaMap() {
      return { values: () => values };
    },
  });

  assert.throws(
    () => manager.neighborDeltasForWorker(0, 0),
    new RegExp(`${DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries}-entry safety limit`),
  );
  assert.equal(yielded, DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries + 1);
  manager.dispose();
});

test("Worker packing rejects a known oversized final-delta collection before iterating it", () => {
  const manager = new ChunkManager({ useWorkers: false, height: 1, minY: 0 });
  const chunk = manager.ensureChunk(0, 0);
  let iterated = false;
  let posted = false;
  chunk.getFinalDeltaMap = () => ({
    size: DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries + 1,
    values() {
      return {
        [Symbol.iterator]() {
          return {
            next() {
              iterated = true;
              throw new Error("oversized final deltas should not be iterated");
            },
          };
        },
      };
    },
  });

  const worker = {
    postMessage() {
      posted = true;
    },
    terminate() {},
  };
  manager.useWorkers = true;
  manager.workerCount = 1;
  manager.activeBuildLimit = 1;
  manager.workers = [worker];
  manager.idleWorkers = [worker];
  chunk.markDirty();
  assert.equal(manager.enqueueRemesh(chunk), true);

  manager.dispatchBuilds();

  assert.equal(iterated, false);
  assert.equal(posted, false);
  assert.match(
    manager.lastBuildError,
    new RegExp(`${DELTA_RESOURCE_LIMITS.maxWorkerPayloadEntries}-entry safety limit`),
  );
  manager.dispose();
});
