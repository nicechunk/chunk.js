import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";
import {
  BLOCK_ID,
  RESOURCE_ID,
  blockDefs,
  isBlockingBlock,
  isCameraOccluderBlock,
} from "../world/block-registry.js";
import { terrainSurfaceHeight } from "../world/world-generator.js";

test("supplemental collision providers affect body, ground, and camera queries", () => {
  const manager = new ChunkManager({ height: 64, minY: -16, useWorkers: false });
  const provider = {
    hasCollisionAtWorld(worldX, worldY, worldZ) {
      return Math.floor(worldX) === -17 && Math.floor(worldY) === 1000 && Math.floor(worldZ) === 16;
    },
    collisionTopAtWorld(worldX, worldZ, maxBlockY) {
      return Math.floor(worldX) === -17 && Math.floor(worldZ) === 16 && maxBlockY >= 1000
        ? 1001
        : -Infinity;
    },
  };

  assert.equal(manager.setSupplementalCollisionProvider(provider), provider);
  assert.equal(isBlockingBlock(manager.getCollisionBlockAtWorld(-17, 1000, 16)), true);
  assert.equal(manager.isCameraOccluderAtWorld(-17, 1000, 16), true);
  assert.equal(manager.getCollisionTopAtWorld(-17, 16, 1000), 1001);
  assert.ok(manager.getCollisionTopAtWorld(-17, 16, 999) < 1001);

  assert.equal(manager.setSupplementalCollisionProvider(null), null);
  assert.equal(manager.getCollisionBlockAtWorld(-17, 1000, 16), BLOCK_ID.air);
  assert.equal(manager.isCameraOccluderAtWorld(-17, 1000, 16), false);
});

test("camera collision ignores every leaf-family block and retains solid occluders", () => {
  const leafBlockIds = Object.values(blockDefs)
    .filter((definition) => definition.resourceId === RESOURCE_ID.leaves)
    .map((definition) => definition.blockId);
  assert.ok(leafBlockIds.includes(BLOCK_ID.leaves));
  assert.ok(leafBlockIds.includes(BLOCK_ID.pineLeaves));

  const manager = new ChunkManager({ height: 64, minY: -16, useWorkers: false });
  const chunk = manager.ensureChunk(0, 0);

  function assertCameraBehavior(blockId, expected, label) {
    assert.equal(isCameraOccluderBlock(blockId), expected, `${label} registry classification`);

    chunk.baseBlocksReady = true;
    manager.getBlockAtWorld = () => blockId;
    assert.equal(manager.isCameraOccluderAtWorld(1, 1, 1), expected, `${label} in a loaded chunk`);

    chunk.baseBlocksReady = false;
    chunk.hasDeltaAt = () => true;
    chunk.getFinalBlock = () => blockId;
    assert.equal(manager.isCameraOccluderAtWorld(1, 1, 1), expected, `${label} in a delta before base loading`);
  }

  for (const blockId of leafBlockIds) {
    assertCameraBehavior(blockId, false, `leaf block ${blockId}`);
  }

  for (const blockId of [BLOCK_ID.trunk, BLOCK_ID.pineTrunk, BLOCK_ID.stone]) {
    assertCameraBehavior(blockId, true, `solid block ${blockId}`);
  }
});

test("collision column tops avoid a world-height scan on ordinary terrain", () => {
  const manager = new ChunkManager({ height: 352, minY: -32, useWorkers: false });
  const worldX = 800;
  const worldZ = 800;
  const maxBlockY = manager.minY + manager.height - 1;
  const original = manager.getTerrainCollisionBlockAtWorld.bind(manager);
  let expected = -Infinity;
  for (let y = maxBlockY; y >= manager.minY; y -= 1) {
    if (!isBlockingBlock(original(worldX, y, worldZ))) continue;
    expected = y + 1;
    break;
  }

  let samples = 0;
  manager.getTerrainCollisionBlockAtWorld = (...args) => {
    samples += 1;
    return original(...args);
  };

  assert.equal(manager.getCollisionTopAtWorld(worldX, worldZ, maxBlockY), expected);
  assert.ok(samples <= 7, `expected at most 7 tree samples, received ${samples}`);
});

test("edited collision column tops are cached until the Chunk revision changes", () => {
  const manager = new ChunkManager({ height: 352, minY: -32, useWorkers: false });
  const worldX = 24;
  const worldZ = 24;
  const surfaceY = terrainSurfaceHeight(manager.config, worldX, worldZ);
  const chunk = manager.ensureChunk(Math.floor(worldX / manager.chunkSize), Math.floor(worldZ / manager.chunkSize));
  manager.applyChainDelta([{
    worldX,
    worldY: surfaceY,
    worldZ,
    blockId: BLOCK_ID.air,
  }]);

  let deltaReads = 0;
  const original = chunk.getFinalDeltaMap.bind(chunk);
  chunk.getFinalDeltaMap = () => {
    deltaReads += 1;
    return original();
  };

  assert.equal(manager.getOpaqueColumnTopAtWorld(worldX, worldZ), surfaceY - 1);
  assert.equal(manager.getOpaqueColumnTopAtWorld(worldX, worldZ), surfaceY - 1);
  assert.equal(deltaReads, 1);
});
