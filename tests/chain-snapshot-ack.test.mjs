import assert from "node:assert/strict";
import test from "node:test";

import { ChunkState } from "../chunk/chunk-state.js";

test("acknowledging identical chain snapshots advances slot without dirtying the chunk", () => {
  const chunk = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 16,
    height: 128,
    minY: 0,
    baseBlocks: new Uint16Array(16 * 128 * 16),
  });
  const applied = chunk.replaceChainDeltas([
    { worldX: 2, worldY: 70, worldZ: 3, blockId: 0 },
  ], {
    expectedChainRevision: 0,
    snapshotToken: 7,
    snapshotSlot: 100,
  });
  assert.equal(applied.applied, true);

  chunk.dirty = false;
  const version = chunk.version;
  const revision = chunk.chainRevision;
  assert.equal(chunk.acknowledgeChainSnapshot({ snapshotToken: 7, snapshotSlot: 101 }), true);
  assert.equal(chunk.chainSnapshotSlot, 101);
  assert.equal(chunk.chainRevision, revision);
  assert.equal(chunk.version, version);
  assert.equal(chunk.dirty, false);

  assert.equal(chunk.acknowledgeChainSnapshot({ snapshotToken: 6, snapshotSlot: 102 }), false);
  assert.equal(chunk.acknowledgeChainSnapshot({ snapshotToken: 7, snapshotSlot: 99 }), false);
  assert.equal(chunk.chainSnapshotSlot, 101);
});
