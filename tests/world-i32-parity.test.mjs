import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { ChunkManager } from "../chunk/chunk-manager.js";
import { normalizeDelta } from "../chunk/chunk-delta.js";
import { CHUNK_VERTEX_STRIDE_BYTES, meshChunkOpaqueFast, meshChunkVisual, POSITION_PACK_SCALE } from "../chunk/chunk-mesher.js";
import {
  I16_MAX,
  I16_MIN,
  I32_MAX,
  I32_MIN,
  hashCoord3,
  saturatingAddI16,
  saturatingAddI32,
  saturatingMulI32,
  saturatingSubI16,
  saturatingSubI32,
  valueNoise2,
} from "../core/hash.js";
import { BLOCK_ID } from "../world/block-registry.js";
import {
  chunkLocalToWorldI32,
  createWorldGeneratorConfig,
  DEFAULT_GENERATION_VERSION,
  generateBaseChunkProfileFromConfig,
  generateTreeInstancesForChunkFromConfig,
  getBaseBlockAt,
  getBlockAt,
  surfaceBlockAt,
  terrainSurfaceHeight,
  treeAt,
  waterLevelAt,
} from "../world/world-generator.js";

// Produced by compiling the current authoritative Rust state.rs read-only.
// Parent worktree HEAD: 012c91571057fa8b244114a9fd6aba708f15fe9b
// state.rs SHA-256: 3883cebaaf7be7ef4d13fba06e5b85761bf654c2423bd1b51e41842440255577
// Dirty state.rs diff SHA-256: d439ed7be9e850d87cb2c401f9ffa583e1c1d0e5cd22cf9986d7c15a6dfe79c0
// Probe compiler: rustc 1.97.1 (8bab26f4f 2026-07-14).
const RUST_BOUNDARY_COLUMNS = Object.freeze([
  [I32_MIN, I32_MIN, 109],
  [I32_MIN, I32_MIN + 1, 109],
  [I32_MIN, -1, 109],
  [I32_MIN, 0, 109],
  [I32_MIN, I32_MAX, 124],
  [I32_MIN + 1, I32_MIN, 109],
  [I32_MIN + 1, I32_MAX - 1, 124],
  [-1, I32_MIN, 119],
  [0, I32_MIN, 119],
  [0, I32_MAX, 104],
  [1, I32_MAX, 104],
  [I32_MAX - 1, I32_MIN + 1, 97],
  [I32_MAX - 1, I32_MAX - 1, 98],
  [I32_MAX, I32_MIN, 97],
  [I32_MAX, -1, 107],
  [I32_MAX, 0, 107],
  [I32_MAX, I32_MAX - 1, 98],
  [I32_MAX, I32_MAX, 98],
  [12, -34, 83],
  [256, 896, 114],
]);

const RUST_FULL_COLUMN_SIGNATURE = "bc0dba49848ef10e06034ce39d8521809aa90d32edba128918834d7166f1ac77";

test("signed saturation helpers match Rust i32 and i16 endpoint arithmetic", () => {
  assert.equal(saturatingAddI32(I32_MAX, 1), I32_MAX);
  assert.equal(saturatingAddI32(I32_MIN, -1), I32_MIN);
  assert.equal(saturatingSubI32(I32_MIN, 1), I32_MIN);
  assert.equal(saturatingSubI32(I32_MAX, -1), I32_MAX);
  assert.equal(saturatingMulI32(I32_MAX, 2), I32_MAX);
  assert.equal(saturatingMulI32(I32_MIN, 2), I32_MIN);
  assert.equal(saturatingMulI32(-715_827_883, 3), I32_MIN);
  assert.equal(saturatingAddI16(I16_MAX, 1), I16_MAX);
  assert.equal(saturatingAddI16(I16_MIN, -1), I16_MIN);
  assert.equal(saturatingSubI16(I16_MIN, 1), I16_MIN);
  assert.equal(saturatingSubI16(I16_MAX, -1), I16_MAX);
});

test("hash and noise endpoints match Rust, including saturated cell plus one", () => {
  const seed = createWorldGeneratorConfig().worldSeed;
  for (const [x, z, scale, salt, expected] of [
    [I32_MIN, I32_MIN, 1, 900, 123],
    [I32_MAX, I32_MAX, 1, 900, 91],
    [I32_MIN, I32_MAX, 1, 901, 129],
    [I32_MAX, I32_MIN, 1, 901, 213],
    [I32_MIN, I32_MIN, 2, 902, 57],
    [I32_MAX, I32_MAX, 2, 902, 169],
  ]) {
    assert.equal(valueNoise2(seed, x, z, scale, salt), expected);
  }
  assert.equal(hashCoord3(seed, I32_MIN, I32_MIN, I32_MIN, 903), 329_468_732);
  assert.equal(hashCoord3(seed, I32_MAX, I32_MAX, I32_MAX, 903), 3_855_696_188);
});

test("generation v5 matches the Rust full-column golden at signed-i32 boundaries", () => {
  const config = createWorldGeneratorConfig();
  const vectors = RUST_BOUNDARY_COLUMNS.map(([x, z, expectedSurface]) => {
    const surface = terrainSurfaceHeight(config, x, z);
    assert.equal(surface, expectedSurface, `surface at ${x},${z}`);
    const blocks = [];
    for (let y = config.minY; y <= config.maxBuildY; y += 1) {
      const blockId = getBlockAt(config.worldSeed, x, y, z, DEFAULT_GENERATION_VERSION);
      if (blockId !== BLOCK_ID.air) blocks.push([y, blockId]);
    }
    return { x, z, surface, blocks };
  });
  assert.equal(sha256(vectors), RUST_FULL_COLUMN_SIGNATURE);
});

test("Rust boundary vectors exercise saturated coal, tree origin, and leaf hashes", () => {
  const config = createWorldGeneratorConfig();
  const vectors = [
    [I32_MIN + 2, 33, I32_MIN, 109, BLOCK_ID.coal],
    [I32_MAX, 66, I32_MAX, 98, BLOCK_ID.coal],
    [I32_MIN + 9, 129, I32_MAX, 124, BLOCK_ID.leaves],
    [I32_MIN + 81, 112, I32_MIN, 106, BLOCK_ID.leaves],
    [I32_MAX - 49, 106, I32_MAX, 100, BLOCK_ID.leaves],
    [I32_MAX - 92, 128, I32_MIN + 50, 125, BLOCK_ID.pineLeaves],
  ];
  for (const [x, y, z, expectedSurface, expectedBlock] of vectors) {
    assert.equal(terrainSurfaceHeight(config, x, z), expectedSurface, `surface at ${x},${z}`);
    assert.equal(
      getBlockAt(config.worldSeed, x, y, z, DEFAULT_GENERATION_VERSION),
      expectedBlock,
      `block at ${x},${y},${z}`,
    );
  }
});

test("interior generation v5 signatures remain unchanged by endpoint saturation", () => {
  const config = createWorldGeneratorConfig();
  const coordinates = [-2048, -1024, -513, -257, -129, -64, -1, 0, 1, 63, 128, 255, 512, 1023, 2048]
    .flatMap((x) => [-1536, -769, -384, -127, -1, 0, 1, 96, 255, 640, 1536].map((z) => [x, z]));
  const terrain = coordinates.map(([x, z]) => [x, z, terrainSurfaceHeight(config, x, z)]);
  const trees = [];
  for (let z = 888; z < 904; z += 1) {
    for (let x = 248; x < 264; x += 1) {
      const surface = terrainSurfaceHeight(config, x, z);
      trees.push([x, z, surface, treeAt(config, x, z, surface)]);
    }
  }
  const blocks = coordinates.flatMap(([x, z]) => {
    const surface = terrainSurfaceHeight(config, x, z);
    return [-18, -8, -1, 0, 1, 4, 9].map((deltaY) => [
      x,
      surface + deltaY,
      z,
      getBlockAt(config.worldSeed, x, surface + deltaY, z, DEFAULT_GENERATION_VERSION),
    ]);
  });
  const treeInstances = [[-100, -100], [-99, -100], [-98, -100], [-97, -100]].map(([chunkX, chunkZ]) => [
    chunkX,
    chunkZ,
    generateTreeInstancesForChunkFromConfig(config, chunkX, chunkZ),
  ]);
  assert.equal(sha256(terrain), "bc345f148e87bde22f0ac493f56aad4578860172beaeec17dd15c2bc5e808fef");
  assert.equal(sha256(trees), "8bb584a3480c5630fb4bc6f933cf6b8b4a989c099aa032cbe9e4566bc0c1ac26");
  assert.equal(sha256(blocks), "bad8496c79341c183bac1f7a189f42616b7907399e1195ec0d86ca5f512fabb5");
  assert.equal(sha256(treeInstances), "02e219aad3ea8ebfa16be4fae71f2a620b52c7a5634fa9e6d174869c24d44849");
});

test("custom chunk sizes clamp the exact chunk/local sum once at i32 endpoints", () => {
  for (const chunkSize of [3, 5, 16]) {
    const config = createWorldGeneratorConfig({ chunkSize });
    const minimumChunk = Math.floor(I32_MIN / chunkSize);
    const maximumChunk = Math.floor(I32_MAX / chunkSize);
    const minimumCoordinates = Array.from(
      { length: chunkSize },
      (_, local) => chunkLocalToWorldI32(minimumChunk, local, chunkSize),
    );
    const maximumCoordinates = Array.from(
      { length: chunkSize },
      (_, local) => chunkLocalToWorldI32(maximumChunk, local, chunkSize),
    );

    assert.equal(minimumCoordinates[normalizeEndpoint(I32_MIN, chunkSize).localX], I32_MIN);
    assert.equal(maximumCoordinates[normalizeEndpoint(I32_MAX, chunkSize).localX], I32_MAX);
    assertEndpointProfileAxis(config, I32_MIN, -9_847, "x");
    assertEndpointProfileAxis(config, I32_MAX, -9_700, "x");
    assertEndpointProfileAxis(config, I32_MIN, -10_000, "z");
    assertEndpointProfileAxis(config, I32_MAX, -10_000, "z");
    assert.throws(() => generateBaseChunkProfileFromConfig(config, minimumChunk - 1, 0));
    assert.throws(() => generateBaseChunkProfileFromConfig(config, maximumChunk + 1, 0));

    if (chunkSize === 16) {
      assert.deepEqual(minimumCoordinates, Array.from({ length: 16 }, (_, local) => I32_MIN + local));
      assert.deepEqual(maximumCoordinates, Array.from({ length: 16 }, (_, local) => I32_MAX - 15 + local));
    }
  }
});

test("normalizeDelta chunk/local coordinates reconstruct both i32 endpoints exactly", () => {
  for (const chunkSize of [3, 5, 16]) {
    for (const endpoint of [I32_MIN, I32_MAX]) {
      const normalized = normalizeDelta({
        worldX: endpoint,
        worldY: 0,
        worldZ: endpoint,
        blockId: BLOCK_ID.air,
      }, chunkSize);
      assert.equal(normalized.chunkX * chunkSize + normalized.localX, endpoint);
      assert.equal(normalized.chunkZ * chunkSize + normalized.localZ, endpoint);
      assert.equal(chunkLocalToWorldI32(normalized.chunkX, normalized.localX, chunkSize), endpoint);
      assert.equal(chunkLocalToWorldI32(normalized.chunkZ, normalized.localZ, chunkSize), endpoint);
    }
  }
});

test("endpoint tree enumeration uses real local columns and emits each aliased world tree once", () => {
  const fixtures = [
    [3, "x", I32_MIN, 5],
    [3, "x", I32_MAX, 8],
    [3, "z", I32_MIN, -18],
    [3, "z", I32_MAX, 5],
    [5, "x", I32_MIN, 3],
    [5, "x", I32_MAX, 5],
    [5, "z", I32_MIN, -11],
    [5, "z", I32_MAX, 3],
    [16, "x", I32_MIN, 0],
    [16, "x", I32_MAX, 0],
    [16, "z", I32_MIN, 0],
    [16, "z", I32_MAX, 0],
  ];
  for (const [chunkSize, axis, endpoint, otherChunk] of fixtures) {
    const config = createWorldGeneratorConfig({ chunkSize });
    const endpointChunk = Math.floor(endpoint / chunkSize);
    const chunkX = axis === "x" ? endpointChunk : otherChunk;
    const chunkZ = axis === "z" ? endpointChunk : otherChunk;
    const profile = generateBaseChunkProfileFromConfig(config, chunkX, chunkZ, { cacheTreeCandidates: true });
    const direct = generateTreeInstancesForChunkFromConfig(config, chunkX, chunkZ);
    const profiled = generateTreeInstancesForChunkFromConfig(config, chunkX, chunkZ, profile);
    const label = `size ${chunkSize} ${axis}=${endpoint}`;

    assert.ok(direct.length > 0, `${label} fixture must exercise at least one real tree`);
    assert.deepEqual(profiled, direct, `${label} cached local columns must match direct reconstruction`);
    assert.equal(
      new Set(profiled.map((tree) => `${tree.x},${tree.z}`)).size,
      profiled.length,
      `${label} must not duplicate an aliased world tree`,
    );
  }
});

test("endpoint ChunkState profile resolvers use the same saturated local mapping", () => {
  for (const chunkSize of [3, 5, 16]) {
    for (const endpoint of [I32_MIN, I32_MAX]) {
      const manager = new ChunkManager({ chunkSize, useWorkers: false });
      try {
        const chunkX = Math.floor(endpoint / chunkSize);
        const chunk = manager.ensureChunk(chunkX, 0);
        for (let localX = 0; localX < chunkSize; localX += 1) {
          const worldX = chunkLocalToWorldI32(chunkX, localX, chunkSize);
          const column = localX;
          const worldY = Math.max(manager.minY, chunk.baseProfile.surfaceY[column] - 4);
          assert.equal(
            chunk.getBaseBlock(localX, worldY, 0),
            getBaseBlockAt(manager.worldSeed, worldX, worldY, 0, manager.generationVersion, manager.workerOptions()),
            `size ${chunkSize}, endpoint ${endpoint}, local ${localX}`,
          );
        }
      } finally {
        manager.dispose();
      }
    }
  }
});

test("synchronous endpoint meshing never forwards wider-than-i32 world coordinates", () => {
  for (const endpoint of [I32_MIN, I32_MAX]) {
    const manager = new ChunkManager({ chunkSize: 3, useWorkers: false });
    try {
      const chunk = manager.ensureChunk(Math.floor(endpoint / manager.chunkSize), 0);
      const assertHorizontal = (value, label) => {
        assert.ok(Number.isInteger(value) && value >= I32_MIN && value <= I32_MAX, `${label}=${value}`);
      };
      const access = {
        getBlockAtWorld: (x, y, z) => {
          assertHorizontal(x, "block X");
          assertHorizontal(z, "block Z");
          return manager.getBlockAtWorld(x, y, z);
        },
        getDeltaAtWorld: (x, y, z) => {
          assertHorizontal(x, "delta X");
          assertHorizontal(z, "delta Z");
          return manager.getDeltaAtWorld(x, y, z);
        },
        getColumnTopAtWorld: (x, z) => {
          assertHorizontal(x, "column X");
          assertHorizontal(z, "column Z");
          return manager.getOpaqueColumnTopAtWorld(x, z);
        },
        getWaterLevelAtWorld: (x, z, surface) => {
          assertHorizontal(x, "water X");
          assertHorizontal(z, "water Z");
          return waterLevelAt(manager.config, x, z, surface);
        },
        treeDeltaCandidateCount: 0,
      };
      const opaque = meshChunkOpaqueFast(chunk, access);
      const visual = meshChunkVisual(chunk, access);
      assert.ok(opaque?.vertices instanceof Uint8Array);
      assert.ok(visual?.vertices instanceof Uint8Array);
    } finally {
      manager.dispose();
    }
  }
});

test("endpoint tree meshes collapse saturated leaf aliases onto the affine in-domain cell", () => {
  for (const [chunkSize, endpoint, otherChunk] of [
    [3, I32_MIN, 5],
    [3, I32_MAX, 8],
    [5, I32_MIN, 3],
    [5, I32_MAX, 5],
  ]) {
    const config = createWorldGeneratorConfig({ chunkSize });
    const chunkX = Math.floor(endpoint / chunkSize);
    const trees = generateTreeInstancesForChunkFromConfig(config, chunkX, otherChunk);
    const boundaryTree = trees.find((tree) => Math.abs(saturatingSubI32(tree.x, endpoint)) <= 2);
    assert.ok(boundaryTree, `size ${chunkSize}, endpoint ${endpoint} must exercise a boundary canopy`);
    const chunkState = emptyTreeMeshState(config, chunkX, otherChunk, boundaryTree);
    const mesh = meshChunkOpaqueFast(chunkState);
    const xs = packedVertexAxis(mesh.vertices, 0);
    const endpointLocal = endpoint - chunkX * chunkSize;
    if (endpoint === I32_MIN) {
      assert.ok(Math.min(...xs) >= endpointLocal, `size ${chunkSize} must not emit the saturated minimum into the affine fringe`);
    } else {
      assert.ok(Math.max(...xs) <= endpointLocal + 1, `size ${chunkSize} must not emit the saturated maximum into the affine fringe`);
    }
  }
});

test("Worker endpoint profile messages match main-thread reconstruction", async () => {
  const config = createWorldGeneratorConfig({ chunkSize: 3 });
  for (const [worldX, worldZ] of [[I32_MIN, -9_847], [I32_MAX, -9_700]]) {
    const anchor = normalizeDelta({
      worldX,
      worldY: 0,
      worldZ,
      blockId: BLOCK_ID.air,
    }, config.chunkSize);
    const expected = generateBaseChunkProfileFromConfig(config, anchor.chunkX, anchor.chunkZ);
    const result = await buildChunkInNodeWorker(config, anchor.chunkX, anchor.chunkZ);

    assert.equal(result.type, "chunkBuilt", result.error || `Worker endpoint build at X=${worldX} should succeed`);
    assert.equal(result.visualError, null, `Worker endpoint visual meshing at X=${worldX} must not exceed i32`);
    assert.ok(result.mesh?.vertices instanceof Uint8Array);
    assert.ok(result.visualMesh?.vertices instanceof Uint8Array);
    assert.equal(result.baseProfile.chunkX, expected.chunkX);
    assert.equal(result.baseProfile.chunkZ, expected.chunkZ);
    assert.equal(result.baseProfile.chunkSize, expected.chunkSize);
    assert.equal(result.baseProfile.minY, expected.minY);
    assert.equal(result.baseProfile.maxBuildY, expected.maxBuildY);
    assert.equal(result.baseProfile.height, expected.height);
    assert.equal(result.baseProfile.generationVersion, expected.generationVersion);
    assert.equal(result.baseProfile.noWater, expected.noWater);
    assert.deepEqual(result.baseProfile.surfaceY, expected.surfaceY);
    assert.deepEqual(result.baseProfile.waterY, expected.waterY);
    assert.deepEqual(result.baseProfile.surfaceBlock, expected.surfaceBlock);
  }
});

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeEndpoint(endpoint, chunkSize) {
  return normalizeDelta({
    worldX: endpoint,
    worldY: 0,
    worldZ: 0,
    blockId: BLOCK_ID.air,
  }, chunkSize);
}

function assertEndpointProfileAxis(config, endpoint, anchor, axis) {
  const delta = normalizeDelta({
    worldX: axis === "x" ? endpoint : anchor,
    worldY: 0,
    worldZ: axis === "z" ? endpoint : anchor,
    blockId: BLOCK_ID.air,
  }, config.chunkSize);
  const profile = generateBaseChunkProfileFromConfig(config, delta.chunkX, delta.chunkZ);
  for (let local = 0; local < config.chunkSize; local += 1) {
    const worldX = axis === "x"
      ? chunkLocalToWorldI32(delta.chunkX, local, config.chunkSize)
      : anchor;
    const worldZ = axis === "z"
      ? chunkLocalToWorldI32(delta.chunkZ, local, config.chunkSize)
      : anchor;
    const localX = axis === "x" ? local : delta.localX;
    const localZ = axis === "z" ? local : delta.localZ;
    const column = localX + localZ * config.chunkSize;
    const surface = terrainSurfaceHeight(config, worldX, worldZ);
    const water = waterLevelAt(config, worldX, worldZ, surface);
    assert.equal(profile.surfaceY[column], surface, `${axis} surface at size ${config.chunkSize}, local ${local}`);
    assert.equal(profile.waterY[column], water ?? profile.noWater, `${axis} water at size ${config.chunkSize}, local ${local}`);
    assert.equal(
      profile.surfaceBlock[column],
      surfaceBlockAt(config, worldX, worldZ, surface),
      `${axis} surface block at size ${config.chunkSize}, local ${local}`,
    );
  }
}

function emptyTreeMeshState(config, chunkX, chunkZ, tree) {
  return {
    chunkX,
    chunkZ,
    chunkSize: config.chunkSize,
    minY: config.minY,
    height: 1,
    baseProfile: null,
    treeInstances: [tree],
    chainDeltas: new Map(),
    pendingDeltas: new Map(),
    getFinalBlock: () => BLOCK_ID.air,
    getFinalDeltaMap: () => new Map(),
    hasDeltaAt: () => false,
  };
}

function packedVertexAxis(vertices, byteOffset) {
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const values = [];
  for (let offset = byteOffset; offset < vertices.byteLength; offset += CHUNK_VERTEX_STRIDE_BYTES) {
    values.push(view.getInt16(offset, true) / POSITION_PACK_SCALE);
  }
  return values;
}

async function buildChunkInNodeWorker(config, chunkX, chunkZ) {
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
    const resultPromise = waitForWorkerMessage(
      worker,
      (message) => message?.type === "chunkBuilt" || message?.type === "chunkBuildError",
    );
    worker.postMessage({
      type: "buildChunk",
      taskId: 1,
      worldSeed: config.worldSeed,
      chunkX,
      chunkZ,
      generationVersion: config.generationVersion,
      resourceRuleVersion: config.resourceRuleVersion,
      materialVersion: 1,
      options: {
        chunkSize: config.chunkSize,
        height: config.height,
        minY: config.minY,
        maxBuildY: config.maxBuildY,
        seaLevel: config.seaLevel,
        maxTerrainHeight: config.maxTerrainHeight,
      },
      mode: "base",
      taskVersion: 1,
      finalDeltas: new Int32Array(0),
      neighborDeltas: new Int32Array(0),
      treeDeltas: new Int32Array(0),
    });
    return await resultPromise;
  } finally {
    await worker.terminate();
  }
}

function waitForWorkerMessage(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the chunk build Worker.")), 10_000);
    const onMessage = (message) => {
      if (predicate(message)) finish(null, message);
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
