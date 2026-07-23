import assert from "node:assert/strict";
import test from "node:test";

import { ChunkState } from "../chunk/chunk-state.js";

const OWN_CHAIN_DELTA = Object.freeze({ worldX: 1, worldY: 1, worldZ: 1, blockId: 2 });
const OWN_PENDING_DELTA = Object.freeze({ worldX: 2, worldY: 1, worldZ: 1, blockId: 3 });

test("applyChainDelta rejects a mixed valid-invalid batch without changing authoritative state or cache", () => {
  const chunk = cachedChunkState();
  const before = captureAuthorityState(chunk);

  assert.throws(
    () => chunk.applyChainDelta([
      { worldX: 3, worldY: 1, worldZ: 1, blockId: 4 },
      { worldX: 4, worldY: 1, worldZ: 1, blockId: "5" },
    ]),
    /block ID must be an integer/,
  );

  assertAuthorityStateUnchanged(chunk, before);
});

test("applyPendingDelta rejects a mixed valid-invalid batch without changing authoritative state or cache", () => {
  const chunk = cachedChunkState();
  const before = captureAuthorityState(chunk);

  assert.throws(
    () => chunk.applyPendingDelta([
      { worldX: 3, worldY: 1, worldZ: 1, blockId: 4 },
      { worldX: 4.5, worldY: 1, worldZ: 1, blockId: 5 },
    ], "mixed-invalid"),
    /world X must be an integer/,
  );

  assertAuthorityStateUnchanged(chunk, before);
});

test("foreign-only incremental batches are ignored without changing authoritative state", () => {
  const chunk = cachedChunkState();
  const foreignDelta = { worldX: 16, worldY: 1, worldZ: 1, blockId: 4 };

  for (const { apply, includesChainRevision } of [
    { apply: () => chunk.applyChainDelta([foreignDelta]), includesChainRevision: true },
    { apply: () => chunk.applyPendingDelta([foreignDelta], "foreign-only"), includesChainRevision: false },
  ]) {
    const before = captureAuthorityState(chunk);
    assert.deepEqual(apply(), {
      applied: false,
      accepted: 0,
      changed: false,
      boundaryMask: 0,
      ...(includesChainRevision ? { chainRevision: before.chainRevision } : {}),
    });
    assertAuthorityStateUnchanged(chunk, before);
  }
});

test("delta application remains transactional when base resolution fails after an earlier valid entry", () => {
  let rejectX = null;
  const chunk = createChunk({
    baseBlocks: null,
    baseBlockResolver(localX) {
      if (localX === rejectX) throw new Error("base resolver failed");
      return 0;
    },
    baseBlocksReady: true,
  });

  rejectX = 4;
  for (const apply of [
    () => chunk.applyChainDelta([
      { worldX: 3, worldY: 1, worldZ: 1, blockId: 0 },
      { worldX: 4, worldY: 1, worldZ: 1, blockId: 5 },
    ]),
    () => chunk.applyPendingDelta([
      { worldX: 3, worldY: 1, worldZ: 1, blockId: 0 },
      { worldX: 4, worldY: 1, worldZ: 1, blockId: 5 },
    ], "resolver-failure"),
  ]) {
    const before = captureAuthorityState(chunk);
    assert.throws(apply, /base resolver failed/);
    assertAuthorityStateUnchanged(chunk, before);
  }
});

test("replaceChainDeltas validates the complete batch and rejects foreign-chunk entries atomically", () => {
  const chunk = cachedChunkState();
  chunk.applyChainDelta([{ worldX: 6, worldY: 1, worldZ: 1, blockId: 7 }]);
  chunk.getFinalDeltaMap();
  chunk.dirty = false;
  assert.equal(chunk.unobservedChainDeltaKeys.size, 1);

  for (const snapshot of [
    [
      { worldX: 3, worldY: 1, worldZ: 1, blockId: 4 },
      { worldX: 4, worldY: 1, worldZ: 1, blockId: Number.NaN },
    ],
    [
      { worldX: 3, worldY: 1, worldZ: 1, blockId: 4 },
      { worldX: 16, worldY: 1, worldZ: 1, blockId: 5 },
    ],
  ]) {
    const before = captureAuthorityState(chunk);
    assert.throws(
      () => chunk.replaceChainDeltas(snapshot, {
        expectedChainRevision: chunk.chainRevision,
        snapshotToken: 7,
        snapshotSlot: 11,
      }),
      /(?:block ID must be an integer|belongs to chunk 1,0; expected 0,0)/,
    );
    assertAuthorityStateUnchanged(chunk, before);
  }
});

test("replaceChainDeltas treats the default null expected revision as no revision precondition", () => {
  const chunk = createChunk();
  chunk.applyChainDelta([OWN_CHAIN_DELTA], { protectUntilSnapshot: false });
  assert.equal(chunk.chainRevision, 1);

  const result = chunk.replaceChainDeltas([
    { worldX: 5, worldY: 1, worldZ: 1, blockId: 6 },
  ], {
    snapshotToken: 12,
    snapshotSlot: 20,
  });

  assert.equal(result.applied, true);
  assert.equal(result.chainRevision, 2);
  assert.equal(chunk.chainDeltas.size, 1);
  assert.equal(chunk.getFinalBlock(5, 1, 1), 6);
  assert.equal(chunk.getFinalBlock(1, 1, 1), 0);
});

test("replaceChainDeltas rejects malformed revision, token, and slot metadata without side effects", () => {
  const chunk = createChunk();
  chunk.replaceChainDeltas([OWN_CHAIN_DELTA], {
    expectedChainRevision: 0,
    snapshotToken: 17,
    snapshotSlot: 23,
  });
  chunk.applyPendingDelta([OWN_PENDING_DELTA], "cache-seed");
  assert.ok(chunk.getFinalDeltaMap());
  chunk.dirty = false;

  const invalidValues = ["1", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  const cases = [
    ...invalidValues.map((value) => ({ field: "expectedChainRevision", value, message: /Expected chain revision/ })),
    ...[null, ...invalidValues].map((value) => ({ field: "snapshotToken", value, message: /Snapshot token/ })),
    ...[null, ...invalidValues].map((value) => ({ field: "snapshotSlot", value, message: /Snapshot slot/ })),
  ];

  for (const { field, value, message } of cases) {
    const options = {
      expectedChainRevision: chunk.chainRevision,
      snapshotToken: chunk.chainSnapshotToken,
      snapshotSlot: chunk.chainSnapshotSlot,
      [field]: value,
    };
    const before = captureAuthorityState(chunk);
    assert.throws(
      () => chunk.replaceChainDeltas([OWN_CHAIN_DELTA], options),
      (error) => error instanceof RangeError && message.test(error.message),
    );
    assertAuthorityStateUnchanged(chunk, before);
  }
});

test("acknowledgeChainSnapshot applies the same strict metadata contract atomically", () => {
  const chunk = createChunk();
  chunk.replaceChainDeltas([OWN_CHAIN_DELTA], {
    expectedChainRevision: 0,
    snapshotToken: 17,
    snapshotSlot: 23,
  });
  chunk.dirty = false;

  const invalidValues = [null, "17", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  for (const field of ["snapshotToken", "snapshotSlot"]) {
    for (const value of invalidValues) {
      const options = {
        snapshotToken: chunk.chainSnapshotToken,
        snapshotSlot: chunk.chainSnapshotSlot,
        [field]: value,
      };
      const before = captureAuthorityState(chunk);
      assert.throws(
        () => chunk.acknowledgeChainSnapshot(options),
        (error) => error instanceof RangeError && /Snapshot (?:token|slot)/.test(error.message),
      );
      assertAuthorityStateUnchanged(chunk, before);
    }
  }

  const beforeMismatch = captureAuthorityState(chunk);
  assert.equal(chunk.acknowledgeChainSnapshot({ snapshotToken: 0, snapshotSlot: 24 }), false);
  assertAuthorityStateUnchanged(chunk, beforeMismatch);
});

function createChunk(overrides = {}) {
  return new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 16,
    height: 8,
    minY: 0,
    baseBlocks: new Uint16Array(16 * 8 * 16),
    ...overrides,
  });
}

function cachedChunkState() {
  const chunk = createChunk();
  chunk.applyChainDelta([OWN_CHAIN_DELTA], { protectUntilSnapshot: false });
  chunk.applyPendingDelta([OWN_PENDING_DELTA], "cache-seed");
  const cache = chunk.getFinalDeltaMap();
  assert.notStrictEqual(cache, chunk.chainDeltas);
  assert.notStrictEqual(cache, chunk.pendingDeltas);
  chunk.dirty = false;
  return chunk;
}

function captureAuthorityState(chunk) {
  return {
    chainDeltasReference: chunk.chainDeltas,
    chainDeltas: cloneEntries(chunk.chainDeltas),
    pendingDeltasReference: chunk.pendingDeltas,
    pendingDeltas: cloneEntries(chunk.pendingDeltas),
    unobservedReference: chunk.unobservedChainDeltaKeys,
    unobserved: [...chunk.unobservedChainDeltaKeys],
    cacheReference: chunk.finalDeltaMapCache,
    cache: chunk.finalDeltaMapCache ? cloneEntries(chunk.finalDeltaMapCache) : null,
    chainRevision: chunk.chainRevision,
    chainSnapshotToken: chunk.chainSnapshotToken,
    chainSnapshotSlot: chunk.chainSnapshotSlot,
    version: chunk.version,
    dirty: chunk.dirty,
    revealState: chunk.revealState,
  };
}

function assertAuthorityStateUnchanged(chunk, before) {
  assert.strictEqual(chunk.chainDeltas, before.chainDeltasReference);
  assert.deepEqual(cloneEntries(chunk.chainDeltas), before.chainDeltas);
  assert.strictEqual(chunk.pendingDeltas, before.pendingDeltasReference);
  assert.deepEqual(cloneEntries(chunk.pendingDeltas), before.pendingDeltas);
  assert.strictEqual(chunk.unobservedChainDeltaKeys, before.unobservedReference);
  assert.deepEqual([...chunk.unobservedChainDeltaKeys], before.unobserved);
  assert.strictEqual(chunk.finalDeltaMapCache, before.cacheReference);
  assert.deepEqual(chunk.finalDeltaMapCache ? cloneEntries(chunk.finalDeltaMapCache) : null, before.cache);
  assert.equal(chunk.chainRevision, before.chainRevision);
  assert.equal(chunk.chainSnapshotToken, before.chainSnapshotToken);
  assert.equal(chunk.chainSnapshotSlot, before.chainSnapshotSlot);
  assert.equal(chunk.version, before.version);
  assert.equal(chunk.dirty, before.dirty);
  assert.equal(chunk.revealState, before.revealState);
}

function cloneEntries(map) {
  return [...map].map(([key, value]) => [key, { ...value }]);
}
