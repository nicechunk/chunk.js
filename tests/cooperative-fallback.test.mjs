import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkManager } from '../chunk/chunk-manager.js';
import { buildRenderSection } from '../chunk/render-sections.js';
import { BLOCK_ID } from '../world/block-registry.js';

const options = { useWorkers: false, chunkSize: 4, minY: 0, height: 16, maxBuildY: 15, shadows: false };
const stableMesh = mesh => mesh && { vertices: mesh.vertices, indices: mesh.indices, bounds: mesh.bounds, originY: mesh.originY, indexCount: mesh.indexCount };

test('zero-budget fallback advances private bounded steps through cold base and section publication', () => {
  const manager = new ChunkManager(options);
  try {
    const chunk = manager.ensureChunk(0, 0, { deferBase: true });
    manager.ensureChunkBaseSync = () => { throw new Error('whole-column synchronous fallback is forbidden'); };
    manager.rebuildDirtyChunks(0);
    assert.equal(chunk.baseBlocksReady, false);
    assert.equal(chunk.mesh, null);
    assert.equal(manager.fallbackSlices, 1);
    let frames = 1;
    while (chunk.dirty && frames++ < 5000) manager.rebuildDirtyChunks(0);
    assert.ok(frames > 3);
    assert.equal(chunk.dirty, false);
    assert.equal(manager.fallbackBuild, null);
    for (const section of chunk.renderSections.values()) {
      const reference = buildRenderSection(chunk, section, manager.meshAccessForChunk(chunk));
      assert.deepEqual(stableMesh(section.mesh), stableMesh(reference.mesh));
      assert.deepEqual(stableMesh(section.visualMesh), stableMesh(reference.visualMesh));
    }
  } finally { manager.dispose(); }
});

test('an edit between fallback slices cancels the snapshot and preserves the old complete mesh until a valid replacement', () => {
  const manager = new ChunkManager(options);
  try {
    const chunk = manager.ensureChunk(0, 0);
    for (let index=0; index<10 && chunk.dirty; index++) manager.rebuildDirtyChunks(1000);
    assert.equal(chunk.dirty, false);
    const section = chunk.renderSections.get(0), oldMesh = section.mesh;
    manager.applyPendingDelta([{worldX: 1, worldY: 5, worldZ: 1, blockId: BLOCK_ID.air}], 'first');
    manager.rebuildDirtyChunks(0);
    const first = manager.fallbackBuild;
    assert.ok(first);
    manager.applyPendingDelta([{worldX: 2, worldY: 5, worldZ: 1, blockId: BLOCK_ID.air}], 'second');
    assert.equal(section.mesh, oldMesh);
    manager.rebuildDirtyChunks(0);
    assert.notEqual(manager.fallbackBuild, first);
    assert.ok(manager.fallbackCancelled >= 1);
    for (let index=0; index<10 && chunk.dirty; index++) manager.rebuildDirtyChunks(1000);
    assert.equal(chunk.dirty, false);
    assert.equal(chunk.getFinalBlock(1,5,1), BLOCK_ID.air);
    assert.equal(chunk.getFinalBlock(2,5,1), BLOCK_ID.air);
    const expected = buildRenderSection(chunk, section, manager.meshAccessForChunk(chunk));
    assert.deepEqual(stableMesh(section.mesh), stableMesh(expected.mesh));
    assert.equal(section.buildState, 'ready');
  } finally { manager.dispose(); }
});

test('unload and disposal release private fallback scratch and never publish into a new instance', () => {
  const manager = new ChunkManager(options);
  const old = manager.ensureChunk(0,0);
  manager.rebuildDirtyChunks(0);
  const oldJob = manager.fallbackBuild;
  assert.ok(oldJob);
  manager.chunks.delete(old.id);
  const current = manager.ensureChunk(0,0);
  manager.rebuildDirtyChunks(0);
  assert.notEqual(manager.fallbackBuild, oldJob);
  assert.equal(old.mesh, null);
  assert.equal(current.mesh, null);
  manager.dispose();
  assert.equal(manager.fallbackBuild, null);
  assert.equal(current.mesh, null);
});
