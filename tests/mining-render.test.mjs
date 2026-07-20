import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

import { ChunkManager } from "../chunk/chunk-manager.js";
import { ChunkState } from "../chunk/chunk-state.js";
import { CHUNK_VERTEX_STRIDE_BYTES, POSITION_PACK_SCALE, createSurfaceDecorationPreviewMesh, meshChunkOpaqueFast, meshChunkVisual } from "../chunk/chunk-mesher.js";
import { WebGL2VoxelRenderer } from "../renderer/webgl2-renderer.js";
import { BLOCK_ID, isOpaqueSolidBlock } from "../world/block-registry.js";
import { compileSurfaceDecorationRules, resolveSurfaceDecoration, SURFACE_DECORATION_ID } from "../world/surface-decoration-rules.js";
import { createWorldGeneratorConfig, treeInstanceBlockAt, treeInstanceLeafProfile } from "../world/world-generator.js";

const sourceManager = createBoundaryManager();
const target = findLevelBoundarySurface(sourceManager);
const sourceChunk = sourceManager.chunks.get("0,0");
const neighborChunk = sourceManager.chunks.get("1,0");
const sourceMeshBeforeMining = sourceChunk.mesh;
const sourceMeshVersionBeforeMining = sourceChunk.meshVersion;
const neighborMeshVersionBeforeMining = neighborChunk.meshVersion;
const delta = {
  worldX: 15,
  worldY: target.worldY,
  worldZ: target.worldZ,
  blockId: BLOCK_ID.air,
};

sourceManager.applyPendingDelta([delta], "mining-render-test");
assert.equal(sourceChunk.mesh, sourceMeshBeforeMining, "dirtying a chunk must retain its last complete CPU mesh");
assert.equal(sourceChunk.meshVersion, sourceMeshVersionBeforeMining, "world edits must not advance the committed mesh revision before remeshing");
assert.equal(neighborChunk.meshVersion, neighborMeshVersionBeforeMining, "boundary invalidation must retain the neighboring committed mesh revision");
assert.equal(sourceChunk.version, sourceMeshVersionBeforeMining + 1, "the source world revision should still advance immediately");
assert.equal(neighborChunk.version, neighborMeshVersionBeforeMining + 1, "the boundary neighbor world revision should still advance immediately");

sourceManager.rebuildDirtyChunks(100_000);
assert.equal(sourceChunk.meshVersion, sourceChunk.version, "the source mesh revision should advance after a successful rebuild");
assert.equal(neighborChunk.meshVersion, neighborChunk.version, "the neighbor mesh revision should advance after a successful rebuild");
assert.equal(sourceManager.getBlockAtWorld(delta.worldX, delta.worldY, delta.worldZ), BLOCK_ID.air, "only the mined coordinate should become air");
assert.ok(isOpaqueSolidBlock(sourceManager.getBlockAtWorld(delta.worldX, delta.worldY - 1, delta.worldZ)), "the block below a mined surface must remain solid");
assert.ok(isOpaqueSolidBlock(sourceManager.getBlockAtWorld(delta.worldX + 1, delta.worldY, delta.worldZ)), "the neighboring terrain block must remain solid");
assert.ok(hasFaceCovering(sourceChunk.mesh, {
  normal: [0, 127, 0],
  x: [15, 16],
  y: [delta.worldY, delta.worldY],
  z: [delta.worldZ, delta.worldZ + 1],
}), "mining a surface block must expose the top face of the block below");
assert.ok(hasFaceCovering(neighborChunk.mesh, {
  normal: [-127, 0, 0],
  x: [0, 0],
  y: [delta.worldY, delta.worldY + 1],
  z: [delta.worldZ, delta.worldZ + 1],
}), "a boundary mine must expose the adjacent chunk side face");

sourceManager.confirmPendingDelta("mining-render-test");
const confirmedHashes = boundaryMeshHashes(sourceManager);
const reloadedManager = createBoundaryManager();
const replacement = reloadedManager.replaceChainDeltasForChunk("0,0", [delta], {
  expectedChainRevision: 0,
  snapshotToken: 1,
  snapshotSlot: 1,
});
assert.equal(replacement.applied, true, "a persisted mining snapshot should apply to the loaded source chunk");
reloadedManager.rebuildDirtyChunks(100_000);
assert.deepEqual(boundaryMeshHashes(reloadedManager), confirmedHashes, "PDA reload and local confirmation must produce identical boundary meshes");
assert.equal(reloadedManager.getBlockAtWorld(delta.worldX, delta.worldY, delta.worldZ), BLOCK_ID.air, "the persisted mined coordinate should remain air after reload");
assert.ok(isOpaqueSolidBlock(reloadedManager.getBlockAtWorld(delta.worldX, delta.worldY - 1, delta.worldZ)), "PDA reload must not remove the block below the mined coordinate");

await assertWorkerBuildExposesBoundaryFace(sourceManager, delta);
assertProfileSurfaceVisualsRequireSupport();
assertBackpackDecorationMeshesMatchWorld();
assertTreeLeafDeltaCarvesOnlyTheMinedCanopyArea();
assertRegionBufferRevisionHandoff();
assertBuildingUploadsDoNotInvalidateTerrainRegions();

console.log("mining render tests passed");

function createBoundaryManager() {
  const manager = new ChunkManager({ viewDistance: 1, useWorkers: false });
  manager.ensureChunk(0, 0);
  manager.ensureChunk(1, 0);
  manager.rebuildDirtyChunks(100_000);
  return manager;
}

function findLevelBoundarySurface(manager) {
  for (let worldZ = 0; worldZ < manager.chunkSize; worldZ += 1) {
    const sourceY = manager.surfaceYAt(15, worldZ) - 1;
    const neighborY = manager.surfaceYAt(16, worldZ) - 1;
    if (sourceY !== neighborY) continue;
    if (!isOpaqueSolidBlock(manager.getBlockAtWorld(15, sourceY, worldZ))) continue;
    if (!isOpaqueSolidBlock(manager.getBlockAtWorld(16, neighborY, worldZ))) continue;
    return { worldY: sourceY, worldZ };
  }
  throw new Error("Unable to find a level generated surface on the test chunk boundary.");
}

function hasFaceCovering(mesh, expected) {
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  for (let vertex = 0; vertex + 3 < mesh.vertexCount; vertex += 4) {
    const points = [];
    let matchingNormal = true;
    for (let corner = 0; corner < 4; corner += 1) {
      const offset = (vertex + corner) * CHUNK_VERTEX_STRIDE_BYTES;
      matchingNormal &&= view.getInt8(offset + 8) === expected.normal[0]
        && view.getInt8(offset + 9) === expected.normal[1]
        && view.getInt8(offset + 10) === expected.normal[2];
      points.push([
        view.getInt16(offset, true) / POSITION_PACK_SCALE,
        view.getInt16(offset + 2, true) / POSITION_PACK_SCALE,
        view.getInt16(offset + 4, true) / POSITION_PACK_SCALE,
      ]);
    }
    if (!matchingNormal) continue;
    if (axisCovers(points, 0, expected.x) && axisCovers(points, 1, expected.y) && axisCovers(points, 2, expected.z)) return true;
  }
  return false;
}

function axisCovers(points, axis, range) {
  const values = points.map((point) => point[axis]);
  const epsilon = 1 / POSITION_PACK_SCALE;
  return Math.min(...values) <= range[0] + epsilon && Math.max(...values) >= range[1] - epsilon;
}

function boundaryMeshHashes(manager) {
  const source = manager.chunks.get("0,0");
  const neighbor = manager.chunks.get("1,0");
  return [meshHash(source.mesh), meshHash(source.visualMesh), meshHash(neighbor.mesh), meshHash(neighbor.visualMesh)];
}

function meshHash(mesh) {
  const hash = createHash("sha256");
  hash.update(mesh.vertices);
  hash.update(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return hash.digest("hex");
}

function assertProfileSurfaceVisualsRequireSupport() {
  const noPdaDecorationChunk = createSingleColumnProfileChunk({});
  assert.equal(
    meshChunkVisual(noPdaDecorationChunk).indexCount,
    0,
    "non-tree surface decorations must remain disabled until PDA rules are injected",
  );

  const nonMatchingDecorationRules = compileSurfaceDecorationRules([{
    ruleId: 9,
    decorationId: SURFACE_DECORATION_ID.pebblePale,
    surfaceBlockId: BLOCK_ID.stone,
    dropBlockId: BLOCK_ID.stone,
    rollStartBps: 0,
    rollEndBps: 1,
    minY: 0,
    maxY: 16,
    salt: 9,
    variant: 0,
    flags: 0,
  }]);
  const iceChunk = createSingleColumnProfileChunk({
    surfaceBlockId: BLOCK_ID.ice,
    surfaceDecorationRules: nonMatchingDecorationRules,
  });
  assert.ok(meshChunkVisual(iceChunk).indexCount > 0, "a collidable transparent profile surface must have visual geometry");
  iceChunk.applyChainDelta([{ worldX: 0, worldY: 4, worldZ: 0, blockId: BLOCK_ID.air }], { protectUntilSnapshot: false });
  assert.equal(meshChunkVisual(iceChunk).indexCount, 0, "mining a transparent profile surface must remove its visual geometry");

  const decorationChunk = createSingleColumnProfileChunk({
    surfaceDecorationRules: compileSurfaceDecorationRules([{
      ruleId: 1,
      decorationId: SURFACE_DECORATION_ID.pebbleGray,
      surfaceBlockId: BLOCK_ID.grass,
      dropBlockId: BLOCK_ID.stone,
      rollStartBps: 0,
      rollEndBps: 10_000,
      minY: 0,
      maxY: 16,
      salt: 1,
      variant: 0,
      flags: 0,
    }]),
  });
  assert.ok(meshChunkVisual(decorationChunk).indexCount > 0, "the fixture should render a deterministic surface decoration before mining");
  decorationChunk.applyChainDelta([{ worldX: 0, worldY: 4, worldZ: 0, blockId: BLOCK_ID.air }], { protectUntilSnapshot: false });
  assert.equal(meshChunkVisual(decorationChunk).indexCount, 0, "surface decorations must disappear when their supporting terrain block is mined");

}

function createSingleColumnProfileChunk({ surfaceBlockId = BLOCK_ID.grass, surfaceDecorationRules }) {
  const noWater = -32_768;
  return new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 1,
    height: 8,
    minY: 0,
    worldSeed: "mining-render-profile-test",
    surfaceDecorationRules,
    baseProfile: {
      surfaceY: Int16Array.of(4),
      waterY: Int16Array.of(noWater),
      surfaceBlock: Uint16Array.of(surfaceBlockId),
      noWater,
      minY: 0,
      height: 8,
    },
    baseBlockResolver: (_x, y) => y < 4 ? BLOCK_ID.dirt : BLOCK_ID.air,
  });
}

function assertBackpackDecorationMeshesMatchWorld() {
  const surfaceByDecoration = new Map([
    [SURFACE_DECORATION_ID.flowerClump, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.flowerSprig, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.grassSprout, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.grassTuft, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.mushroom, BLOCK_ID.mud],
    [SURFACE_DECORATION_ID.mossPatch, BLOCK_ID.mud],
    [SURFACE_DECORATION_ID.swampGrass, BLOCK_ID.mud],
    [SURFACE_DECORATION_ID.microCactus, BLOCK_ID.sand],
    [SURFACE_DECORATION_ID.dryShrub, BLOCK_ID.dryDirt],
    [SURFACE_DECORATION_ID.dryGrass, BLOCK_ID.dryDirt],
    [SURFACE_DECORATION_ID.lichenPatch, BLOCK_ID.stone],
    [SURFACE_DECORATION_ID.cotton, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.flowerWhite, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.flowerYellow, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.flowerRed, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.flowerBlue, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.flowerPink, BLOCK_ID.grass],
    [SURFACE_DECORATION_ID.pebbleGray, BLOCK_ID.gravel],
    [SURFACE_DECORATION_ID.pebblePale, BLOCK_ID.stone],
    [SURFACE_DECORATION_ID.pebbleSnow, BLOCK_ID.snow],
    [SURFACE_DECORATION_ID.pebbleSand, BLOCK_ID.sand],
    [SURFACE_DECORATION_ID.pebbleDark, BLOCK_ID.basalt],
    [SURFACE_DECORATION_ID.pebbleWarm, BLOCK_ID.clay],
    [SURFACE_DECORATION_ID.pebbleMossy, BLOCK_ID.stone],
    [SURFACE_DECORATION_ID.pebbleSalt, BLOCK_ID.saltFlat],
  ]);
  const decorationIds = Object.values(SURFACE_DECORATION_ID);
  assert.equal(surfaceByDecoration.size, decorationIds.length, "every PDA decoration model must have a world/backpack parity fixture");
  for (let index = 0; index < decorationIds.length; index += 1) {
    const decorationId = decorationIds[index];
    const surfaceBlockId = surfaceByDecoration.get(decorationId);
    const worldSeed = `decoration-preview-parity-${decorationId}`;
    const rule = {
      ruleId: index + 1,
      decorationId,
      surfaceBlockId,
      dropBlockId: BLOCK_ID.grassPlant,
      rollStartBps: 0,
      rollEndBps: 10_000,
      minY: 0,
      maxY: 16,
      salt: index + 101,
      variant: decorationId === SURFACE_DECORATION_ID.pebbleSnow ? 1 : 0,
      flags: 0,
    };
    const compiledRules = compileSurfaceDecorationRules([rule]);
    const chunk = createSingleColumnProfileChunk({ surfaceBlockId, surfaceDecorationRules: compiledRules });
    chunk.worldSeed = worldSeed;
    const worldMesh = meshChunkVisual(chunk);
    const resolved = resolveSurfaceDecoration({
      worldSeed,
      worldX: 0,
      surfaceY: 4,
      worldZ: 0,
      surfaceBlockId,
      rules: compiledRules,
    });
    assert.ok(resolved, `fixture should resolve decoration ${decorationId}`);
    const preview = createSurfaceDecorationPreviewMesh({
      decorationId,
      variantHash: resolved.variantHash,
      surfaceBlockId,
      variant: rule.variant,
      flags: rule.flags,
    });
    assert.equal(worldMesh.vertexCount, preview.vertices.length, `backpack vertex count must match world decoration ${decorationId}`);
    assert.equal(worldMesh.indexCount, preview.indices.length, `backpack index count must match world decoration ${decorationId}`);
    assert.deepEqual(Array.from(worldMesh.indices), preview.indices, `backpack topology must match world decoration ${decorationId}`);
    assertPackedDecorationVerticesMatch(worldMesh.vertices, preview.vertices, 5, decorationId);
  }
}

function assertPackedDecorationVerticesMatch(packed, previewVertices, worldY, decorationId) {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  for (let index = 0; index < previewVertices.length; index += 1) {
    const offset = index * CHUNK_VERTEX_STRIDE_BYTES;
    const preview = previewVertices[index];
    const expectedPosition = [preview.p[0], preview.p[1] + worldY, preview.p[2]]
      .map((value) => Math.round(value * POSITION_PACK_SCALE));
    const actualPosition = [
      view.getInt16(offset, true),
      view.getInt16(offset + 2, true),
      view.getInt16(offset + 4, true),
    ];
    assert.deepEqual(actualPosition, expectedPosition, `backpack position must match world decoration ${decorationId}, vertex ${index}`);
    assert.deepEqual([
      view.getInt8(offset + 8),
      view.getInt8(offset + 9),
      view.getInt8(offset + 10),
    ], preview.n.map((value) => value || 0), `backpack normal must match world decoration ${decorationId}, vertex ${index}`);
    assert.equal(view.getUint8(offset + 11), preview.ao, `backpack AO must match world decoration ${decorationId}, vertex ${index}`);
    assert.equal(view.getUint16(offset + 16, true), preview.layer, `backpack material must match world decoration ${decorationId}, vertex ${index}`);
    assert.equal(view.getUint16(offset + 18, true), preview.flags, `backpack flags must match world decoration ${decorationId}, vertex ${index}`);
  }
}

function assertTreeLeafDeltaCarvesOnlyTheMinedCanopyArea() {
  const chunkSize = 16;
  const height = 12;
  const config = createWorldGeneratorConfig({ worldSeed: "tree-leaf-render-test", chunkSize, height, minY: 0 });
  const tree = { x: 8, z: 8, baseY: 1, trunkHeight: 4, pine: false };
  const leafProfile = treeInstanceLeafProfile(config, tree);
  tree.leafMinY = leafProfile.minY;
  tree.leafMasks = leafProfile.masks;
  assertLeafProfileMatchesCanonicalTree(config, tree, leafProfile);
  const target = firstExposedLeaf(tree, leafProfile);
  const treeChunk = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize,
    height,
    minY: 0,
    worldSeed: config.worldSeed,
    baseBlocks: new Uint16Array(chunkSize * height * chunkSize),
    treeInstances: [tree],
  });
  const intact = meshChunkOpaqueFast(treeChunk);
  treeChunk.setMeshes(intact, null);
  assert.equal(treeChunk.dirty, false, "the intact fixture should start with a committed mesh");
  assert.equal(treeInstanceBlockAt(config, tree, target.worldX, target.worldY, target.worldZ), BLOCK_ID.leaves, "the selected visual leaf must be a canonical mineable leaf block");
  assert.ok(hasFaceCovering(intact, target.face), "the canonical target leaf must have a visible face before mining");
  assert.ok(hasFaceCovering(intact, {
    normal: [127, 0, 0],
    x: [8.74, 8.74],
    y: [1, 5],
    z: [8.26, 8.74],
  }), "tree trunks should use one continuous, uniform-width box from base to top");

  const applied = treeChunk.applyChainDelta([{ ...target, blockId: BLOCK_ID.air }], { protectUntilSnapshot: false });
  assert.equal(applied.changed, true, "an air delta over a generated leaf must count as a render change");
  assert.equal(treeChunk.dirty, true, "mining a generated leaf must enqueue its tree mesh for rebuilding");
  const carved = meshChunkOpaqueFast(treeChunk, { treeDeltaCandidateCount: 1 });
  assert.ok(carved.indexCount > 0, "mining one leaf must keep the trunk and remaining canopy visible");
  assert.notEqual(meshHash(carved), meshHash(intact), "a mined leaf delta must change the merged tree proxy mesh");
  assert.equal(hasFaceCovering(carved, target.face), false, "the mined canonical leaf face must be removed from the visual tree mesh");
  assert.ok(hasFaceCovering(carved, {
    normal: [127, 0, 0],
    x: [8.74, 8.74],
    y: [1, 5],
    z: [8.26, 8.74],
  }), "leaf carving must not remove or taper the tree trunk");
}

function assertLeafProfileMatchesCanonicalTree(config, tree, profile) {
  const leafBlockId = tree.pine ? BLOCK_ID.pineLeaves : BLOCK_ID.leaves;
  for (let layer = 0; layer < profile.masks.length; layer += 1) {
    const y = profile.minY + layer;
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const bit = (dz + 2) * 5 + dx + 2;
        const masked = Boolean((profile.masks[layer] >>> 0) & (1 << bit));
        const canonical = treeInstanceBlockAt(config, tree, tree.x + dx, y, tree.z + dz) === leafBlockId;
        assert.equal(masked, canonical, `leaf mask mismatch at ${dx},${y},${dz}`);
      }
    }
  }
}

function firstExposedLeaf(tree, profile) {
  const faces = [
    { normal: [127, 0, 0], delta: [1, 0, 0] },
    { normal: [-127, 0, 0], delta: [-1, 0, 0] },
    { normal: [0, 127, 0], delta: [0, 1, 0] },
    { normal: [0, -127, 0], delta: [0, -1, 0] },
    { normal: [0, 0, 127], delta: [0, 0, 1] },
    { normal: [0, 0, -127], delta: [0, 0, -1] },
  ];
  for (let layer = 0; layer < profile.masks.length; layer += 1) {
    const y = profile.minY + layer;
    for (let bit = 0; bit < 25; bit += 1) {
      if (!((profile.masks[layer] >>> 0) & (1 << bit))) continue;
      const dx = bit % 5 - 2;
      const dz = Math.floor(bit / 5) - 2;
      for (const face of faces) {
        if (leafProfileContains(profile, dx + face.delta[0], y + face.delta[1], dz + face.delta[2])) continue;
        const x = tree.x + dx;
        const z = tree.z + dz;
        return {
          worldX: x,
          worldY: y,
          worldZ: z,
          face: leafFaceExpectation(face.normal, x, y, z),
        };
      }
    }
  }
  throw new Error("Tree fixture has no exposed canonical leaf");
}

function leafProfileContains(profile, dx, y, dz) {
  if (dx < -2 || dx > 2 || dz < -2 || dz > 2) return false;
  const layer = y - profile.minY;
  if (layer < 0 || layer >= profile.masks.length) return false;
  return Boolean((profile.masks[layer] >>> 0) & (1 << ((dz + 2) * 5 + dx + 2)));
}

function leafFaceExpectation(normal, x, y, z) {
  if (normal[0] > 0) return { normal, x: [x + 1, x + 1], y: [y, y + 1], z: [z, z + 1] };
  if (normal[0] < 0) return { normal, x: [x, x], y: [y, y + 1], z: [z, z + 1] };
  if (normal[1] > 0) return { normal, x: [x, x + 1], y: [y + 1, y + 1], z: [z, z + 1] };
  if (normal[1] < 0) return { normal, x: [x, x + 1], y: [y, y], z: [z, z + 1] };
  if (normal[2] > 0) return { normal, x: [x, x + 1], y: [y, y + 1], z: [z + 1, z + 1] };
  return { normal, x: [x, x + 1], y: [y, y + 1], z: [z, z] };
}

async function assertWorkerBuildExposesBoundaryFace(manager, minedDelta) {
  const workerUrl = new URL("../chunk/chunk-build-worker.js", import.meta.url);
  const bootstrap = `
    import { parentPort } from "node:worker_threads";
    globalThis.self = globalThis;
    self.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
    await import(${JSON.stringify(workerUrl.href)});
    parentPort.on("message", (data) => self.onmessage({ data }));
    parentPort.postMessage({ type: "ready" });
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { type: "module" });
  try {
    await waitForWorkerMessage(worker, (message) => message?.type === "ready");
    const resultPromise = waitForWorkerMessage(worker, (message) => message?.type === "chunkBuilt" || message?.type === "chunkBuildError");
    worker.postMessage({
      type: "buildChunk",
      taskId: 1,
      worldSeed: manager.worldSeed,
      chunkX: 1,
      chunkZ: 0,
      generationVersion: manager.generationVersion,
      resourceRuleVersion: manager.resourceRuleVersion,
      materialVersion: manager.materialVersion,
      options: manager.workerOptions(),
      mode: "remesh",
      taskVersion: 1,
      finalDeltas: new Int32Array(0),
      neighborDeltas: new Int32Array([minedDelta.worldX, minedDelta.worldY, minedDelta.worldZ, minedDelta.blockId]),
    });
    const result = await resultPromise;
    assert.equal(result.type, "chunkBuilt", result.error || "the worker boundary remesh should succeed");
    assert.ok(hasFaceCovering(result.mesh, {
      normal: [-127, 0, 0],
      x: [0, 0],
      y: [minedDelta.worldY, minedDelta.worldY + 1],
      z: [minedDelta.worldZ, minedDelta.worldZ + 1],
    }), "the worker remesh must account for mined boundary deltas when exposing neighbor faces");
  } finally {
    await worker.terminate();
  }
}

function waitForWorkerMessage(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the chunk build worker.")), 10_000);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      finish(null, message);
    };
    const onError = (error) => finish(error);
    const finish = (error, message) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      if (error) reject(error);
      else resolve(message);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function assertRegionBufferRevisionHandoff() {
  const canvas = { addEventListener() {}, removeEventListener() {} };
  const renderer = new WebGL2VoxelRenderer(canvas, { useRegionBatching: true, regionChunkSize: 4 });
  const events = [];
  let handleSerial = 0;
  renderer.initialized = true;
  renderer.bufferManager = {
    createChunkBuffers(mesh) {
      const handle = {
        id: ++handleSerial,
        vao: {},
        indexCount: mesh.indexCount,
        indexType: 0,
        triangleCount: mesh.triangleCount,
        byteLength: mesh.vertices.byteLength + mesh.indices.byteLength,
      };
      events.push(`create:${handle.id}`);
      return handle;
    },
    disposeChunkBuffers(handle) {
      events.push(`dispose:${handle.id}`);
    },
  };

  const chunk = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    height: 1,
    minY: 0,
    baseBlocks: new Uint16Array(16 * 16),
  });
  chunk.setMeshes(testQuadMesh(1), null);
  assert.equal(renderer.prepareChunksForRender([chunk], { maxUploads: 1 }).uploaded, 1, "the first committed mesh should upload once");
  const firstRegion = renderer.regionBuffers.get("0,0");

  chunk.markDirty();
  assert.equal(renderer.prepareChunksForRender([chunk], { maxUploads: 1 }).uploaded, 0, "a dirty world revision must not re-upload the unchanged committed mesh");
  assert.equal(renderer.regionBuffers.get("0,0"), firstRegion, "the previous complete region should remain active during remeshing");

  chunk.setMeshes(testQuadMesh(2), null);
  const deferred = renderer.prepareChunksForRender([chunk], { maxUploads: 0 });
  assert.equal(deferred.uploaded, 0, "a zero upload budget should defer the replacement region");
  assert.equal(renderer.regionBuffers.get("0,0"), firstRegion, "a deferred replacement must retain the previous GPU region");
  assert.equal(renderOpaqueDrawCount(renderer, chunk), 1, "the stale complete region should still draw while its replacement waits for upload");

  assert.equal(renderer.prepareChunksForRender([chunk], { maxUploads: 1 }).uploaded, 1, "the committed replacement should upload when budget is available");
  const secondRegion = renderer.regionBuffers.get("0,0");
  assert.notEqual(secondRegion, firstRegion, "the replacement should atomically become the active region");
  assert.deepEqual(events, ["create:1", "create:2", "dispose:1"], "new GPU buffers must be created before old buffers are disposed");

  chunk.markDirty();
  chunk.setMeshes(testQuadMesh(3), null);
  const streamingReplacement = renderer.prepareChunksForRender([chunk], {
    maxUploads: 1,
    deferRegionUploads: true,
  });
  const thirdRegion = renderer.regionBuffers.get("0,0");
  assert.equal(streamingReplacement.uploaded, 1, "a stale visible region must refresh even while ordinary region uploads are deferred");
  assert.notEqual(thirdRegion, secondRegion, "streaming must not leave a stale region hiding confirmed world edits");
  assert.equal(renderer.chunkBuffers.has(chunk.id), false, "a region replacement should not leave an occluded per-chunk staging buffer");
  assert.deepEqual(events, ["create:1", "create:2", "dispose:1", "create:3", "dispose:2"]);
}

function assertBuildingUploadsDoNotInvalidateTerrainRegions() {
  const canvas = { addEventListener() {}, removeEventListener() {} };
  const renderer = new WebGL2VoxelRenderer(canvas, { useRegionBatching: true, regionChunkSize: 4 });
  const disposed = [];
  let handleSerial = 0;
  renderer.initialized = true;
  renderer.bufferManager = {
    createChunkBuffers(mesh) {
      return {
        id: ++handleSerial,
        vao: {},
        indexCount: mesh.indexCount,
        indexType: 0,
        triangleCount: mesh.triangleCount,
        byteLength: mesh.vertices.byteLength + mesh.indices.byteLength,
      };
    },
    disposeChunkBuffers(handle) {
      disposed.push(handle.id);
    },
  };

  const terrain = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    height: 1,
    minY: 0,
    baseBlocks: new Uint16Array(16 * 16),
  });
  terrain.setMeshes(testQuadMesh(1), null);
  const building = {
    id: "building:test:0,0",
    building: true,
    regionBatchEligible: false,
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 16,
    mesh: testQuadMesh(2),
    meshVersion: 1,
    version: 1,
    gpuUploaded: false,
    visualMesh: null,
    visualMeshVersion: -1,
    visualGpuUploaded: false,
  };

  const initial = renderer.prepareChunksForRender([terrain, building], { maxUploads: 1 });
  assert.equal(initial.uploaded, 1, "the shared frame budget must upload only the terrain region first");
  assert.equal(initial.pendingUploads, 1, "the independent building upload should remain pending");
  const terrainRegion = renderer.regionBuffers.get("0,0");
  assert.ok(terrainRegion?.handle, "terrain should remain region batched");
  assert.deepEqual([...terrainRegion.chunkIds], [terrain.id], "building chunks must never enter terrain region buffers");
  assert.deepEqual(renderer.getRegionGroups([terrain, building], "mesh")[0].chunks.map((chunk) => chunk.id), [terrain.id]);

  const buildingUpload = renderer.prepareChunksForRender([terrain, building], { maxUploads: 1 });
  assert.equal(buildingUpload.uploaded, 1);
  assert.equal(renderer.regionBuffers.get("0,0"), terrainRegion, "adding a building must not replace the terrain GPU handle");
  const firstBuildingHandle = renderer.chunkBuffers.get(building.id)?.handle;
  assert.ok(firstBuildingHandle, "the building should use its own chunk buffer");

  building.mesh = testQuadMesh(3);
  building.meshVersion = 2;
  building.version = 2;
  building.gpuUploaded = false;
  const replacement = renderer.prepareChunksForRender([terrain, building], { maxUploads: 1 });
  assert.equal(replacement.uploaded, 1, "a building replacement must still respect the frame upload budget");
  assert.equal(renderer.regionBuffers.get("0,0"), terrainRegion, "updating a building must leave terrain buffers untouched");
  assert.notEqual(renderer.chunkBuffers.get(building.id)?.handle, firstBuildingHandle);
  assert.deepEqual(disposed, [firstBuildingHandle.id], "only the superseded building buffer should be disposed");
}

function testQuadMesh(marker) {
  const vertices = new Uint8Array(4 * CHUNK_VERTEX_STRIDE_BYTES);
  const view = new DataView(vertices.buffer);
  for (let vertex = 0; vertex < 4; vertex += 1) {
    const offset = vertex * CHUNK_VERTEX_STRIDE_BYTES;
    view.setInt16(offset + 6, POSITION_PACK_SCALE, true);
    view.setUint8(offset + 11, marker);
  }
  return {
    vertices,
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    vertexCount: 4,
    indexCount: 6,
    triangleCount: 2,
    quadCount: 1,
    blockCount: 1,
    vertexStrideBytes: CHUNK_VERTEX_STRIDE_BYTES,
  };
}

function renderOpaqueDrawCount(renderer, chunk) {
  let drawCalls = 0;
  renderer.gl = {
    COLOR_BUFFER_BIT: 1,
    DEPTH_BUFFER_BIT: 2,
    DEPTH_TEST: 3,
    CULL_FACE: 4,
    BLEND: 5,
    TRIANGLES: 6,
    clearColor() {},
    clear() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniform1f() {},
    uniform2f() {},
    uniform3f() {},
    uniform4f() {},
    enable() {},
    disable() {},
    depthMask() {},
    bindVertexArray() {},
    drawElements() { drawCalls += 1; },
  };
  renderer.program = {};
  renderer.uniforms = {
    uViewProjection: {},
    uTileScale: {},
    uTime: {},
    uWorldOrigin: {},
    uChunkOrigin: {},
  };
  renderer.textureArray = { bind() {} };
  renderer.resize = () => false;
  const noDraw = () => ({ drawCalls: 0, triangles: 0, bufferMemory: 0 });
  renderer.renderSkyGradient = noDraw;
  renderer.renderSunDisc = noDraw;
  renderer.renderClouds = noDraw;
  renderer.renderProjectedShadows = noDraw;
  renderer.renderAvatars = noDraw;
  renderer.renderVisualChunks = noDraw;
  renderer.renderVoxelParticles = noDraw;
  renderer.renderVoxelOverlays = noDraw;
  renderer.render({
    worldX: 0,
    worldY: 8,
    worldZ: 0,
    localOffsetX: 0.5,
    localOffsetY: 0.5,
    localOffsetZ: 0.5,
    targetWorldX: 0,
    targetWorldY: 0,
    targetWorldZ: 0,
    yaw: 0,
    pitch: -0.4,
    fov: 58,
    near: 0.1,
    far: 128,
    aspect: 1,
  }, [chunk], [], []);
  return drawCalls;
}
