import assert from "node:assert/strict";
import test from "node:test";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { actualFaces, expectedFaces } from "./helpers/face-oracle.mjs";

test("an underground edit does not leave eight unchanged neighbour columns permanently dirty", () => {
  const manager = new ChunkManager({ useWorkers: false, shadows: false });
  try {
    for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
      const chunk = manager.ensureChunk(x, z);
      chunk.treeInstances = [];
    }
    manager.rebuildDirtyChunks(1_000_000);
    const centre = manager.chunks.get("0,0");
    const neighbours = [...manager.chunks.values()].filter(chunk => chunk !== centre);
    const before = neighbours.map(chunk => ({ chunk, version: chunk.version,
      sections: [...chunk.renderSections.values()].map(section => [section.dataRevision, section.haloRevision,
        section.lightRevision, section.meshCommitToken, section.visualCommitToken]) }));
    manager.applyPendingDelta([{ worldX: 8, worldY: 65, worldZ: 8, blockId: BLOCK_ID.air }], "sealed-edit");
    for (const entry of before) {
      assert.equal(entry.chunk.version, entry.version);
      assert.equal(entry.chunk.dirty, false);
      assert.deepEqual([...entry.chunk.renderSections.values()].map(section => [section.dataRevision,
        section.haloRevision, section.lightRevision, section.meshCommitToken, section.visualCommitToken]), entry.sections);
    }
    manager.rebuildDirtyChunks(1_000_000);
    assert.deepEqual(actualFaces(centre.mesh), expectedFaces(centre, (...position) => manager.getBlockAtWorld(...position)));
    assert.ok(neighbours.every(chunk => !chunk.dirty));
  } finally { manager.dispose(); }
});
