import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";
import { ChunkState } from "../chunk/chunk-state.js";
import { BLOCK_ID } from "../world/block-registry.js";
import {
  createWorldGeneratorConfig,
  DEFAULT_GENERATION_VERSION,
  generateBaseChunk,
  generateBaseChunkProfile,
  getBaseBlockAt,
  getBaseBlockAtColumnConfig,
  getBlockAt,
  terrainSurfaceHeight,
  waterLevelAt,
} from "../world/world-generator.js";

const seed = "vertical-contract-test";

const verticalCases = [
  {
    name: "a sea plane above a lower build ceiling",
    options: {
      chunkSize: 1,
      minY: 0,
      height: 32,
      maxBuildY: 10,
      seaLevel: 20,
      maxTerrainHeight: 9,
    },
    surfaceY: 8,
    waterY: 10,
  },
  {
    name: "a one-layer world",
    options: {
      chunkSize: 1,
      minY: 0,
      height: 1,
      maxTerrainHeight: 0,
    },
    surfaceY: 0,
    waterY: null,
  },
  {
    name: "a two-layer flooded world",
    options: {
      chunkSize: 1,
      minY: -12,
      height: 2,
      seaLevel: 20,
      maxTerrainHeight: 100,
    },
    surfaceY: -12,
    waterY: -11,
  },
  {
    name: "a terrain cap below the world span",
    options: {
      chunkSize: 1,
      minY: 4,
      height: 3,
      seaLevel: 20,
      maxTerrainHeight: -100,
    },
    surfaceY: 4,
    waterY: 6,
  },
];

test("custom vertical configurations keep every base reconstruction path identical", () => {
  for (const fixture of verticalCases) {
    const config = createWorldGeneratorConfig({ worldSeed: seed, ...fixture.options });
    const worldTop = config.minY + config.height - 1;
    const surface = terrainSurfaceHeight(config, 0, 0);
    const water = waterLevelAt(config, 0, 0, surface);
    assert.equal(surface, fixture.surfaceY, `${fixture.name}: surface`);
    assert.equal(water, fixture.waterY, `${fixture.name}: water`);
    assert.ok(surface >= config.minY && surface <= config.maxBuildY, `${fixture.name}: surface must fit the build domain`);
    assert.ok(water === null || (water > surface && water <= config.maxBuildY), `${fixture.name}: water must fit above the surface`);

    const blocks = generateBaseChunk(seed, 0, 0, DEFAULT_GENERATION_VERSION, fixture.options);
    const profile = generateBaseChunkProfile(seed, 0, 0, DEFAULT_GENERATION_VERSION, fixture.options);
    assert.equal(profile.surfaceY[0], surface, `${fixture.name}: profile surface`);
    assert.equal(profile.waterY[0], water ?? profile.noWater, `${fixture.name}: profile water`);

    const resolveProfileBlock = (_localX, worldY, _localZ) => getBaseBlockAtColumnConfig(
      config,
      0,
      worldY,
      0,
      profile.surfaceY[0],
      profile.waterY[0] === profile.noWater ? null : profile.waterY[0],
      profile.surfaceBlock[0],
    );
    const profileState = new ChunkState({
      chunkX: 0,
      chunkZ: 0,
      chunkSize: config.chunkSize,
      minY: config.minY,
      height: config.height,
      maxBuildY: config.maxBuildY,
      baseProfile: profile,
      baseBlockResolver: resolveProfileBlock,
    });
    const materializedState = new ChunkState({
      chunkX: 0,
      chunkZ: 0,
      chunkSize: config.chunkSize,
      minY: config.minY,
      height: config.height,
      maxBuildY: config.maxBuildY,
      baseBlocks: blocks,
    });

    for (let worldY = config.minY; worldY <= worldTop; worldY += 1) {
      const label = `${fixture.name} at Y=${worldY}`;
      const expected = getBaseBlockAt(seed, 0, worldY, 0, DEFAULT_GENERATION_VERSION, fixture.options);
      assert.equal(getBlockAt(seed, 0, worldY, 0, DEFAULT_GENERATION_VERSION, fixture.options), expected, `${label}: point lookup`);
      assert.equal(blocks[worldY - config.minY], expected, `${label}: materialized chunk`);
      assert.equal(resolveProfileBlock(0, worldY, 0), expected, `${label}: profile resolver`);
      assert.equal(profileState.getBaseBlock(0, worldY, 0), expected, `${label}: profile state`);
      assert.equal(materializedState.getBaseBlock(0, worldY, 0), expected, `${label}: materialized state`);
      if (worldY > config.maxBuildY) assert.equal(expected, BLOCK_ID.air, `${label}: above maxBuildY`);
    }

    for (const worldY of [config.minY - 1, config.maxBuildY + 1]) {
      const label = `${fixture.name} outside the build domain at Y=${worldY}`;
      assert.equal(getBlockAt(seed, 0, worldY, 0, DEFAULT_GENERATION_VERSION, fixture.options), BLOCK_ID.air, `${label}: point lookup`);
      assert.equal(getBaseBlockAt(seed, 0, worldY, 0, DEFAULT_GENERATION_VERSION, fixture.options), BLOCK_ID.air, `${label}: base lookup`);
      assert.equal(profileState.getBaseBlock(0, worldY, 0), BLOCK_ID.air, `${label}: profile state`);
      assert.equal(materializedState.getBaseBlock(0, worldY, 0), BLOCK_ID.air, `${label}: materialized state`);
    }

    assert.equal(profile.surfaceBlock[0], blocks[surface - config.minY], `${fixture.name}: profile surface material`);
  }
});

test("ChunkState does not expose stale materialized or profile data above maxBuildY", () => {
  const maxBuildY = 2;
  const blocks = new Uint16Array(4);
  blocks[3] = BLOCK_ID.stone;
  const materialized = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 1,
    minY: 0,
    height: 4,
    maxBuildY,
    baseBlocks: blocks,
  });
  assert.equal(materialized.getBaseBlock(0, maxBuildY + 1, 0), BLOCK_ID.air);

  const staleProfile = {
    surfaceY: Int16Array.of(1),
    waterY: Int16Array.of(3),
    surfaceBlock: Uint16Array.of(BLOCK_ID.sand),
    noWater: -1,
    minY: 0,
    height: 4,
  };
  const profiled = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 1,
    minY: 0,
    height: 4,
    maxBuildY,
    baseProfile: staleProfile,
    baseBlockResolver: () => BLOCK_ID.water,
  });
  assert.equal(profiled.getBaseBlock(0, maxBuildY + 1, 0), BLOCK_ID.air);
});

test("generated profiles carry maxBuildY into profile-only ChunkState construction", () => {
  const options = {
    chunkSize: 1,
    minY: 0,
    height: 32,
    maxBuildY: 10,
    seaLevel: 20,
    maxTerrainHeight: 9,
  };
  const profile = generateBaseChunkProfile(seed, 0, 0, DEFAULT_GENERATION_VERSION, options);
  assert.equal(profile.maxBuildY, options.maxBuildY);
  const state = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: profile.chunkSize,
    minY: profile.minY,
    height: profile.height,
    baseProfile: profile,
    baseBlockResolver: () => BLOCK_ID.water,
  });
  assert.equal(state.maxBuildY, options.maxBuildY);
  assert.equal(state.getBaseBlock(0, options.maxBuildY + 1, 0), BLOCK_ID.air);
});

test("ChunkManager preserves a custom maxBuildY in synchronous and Worker configuration paths", () => {
  const options = {
    worldSeed: seed,
    chunkSize: 1,
    minY: 0,
    height: 32,
    maxBuildY: 10,
    seaLevel: 20,
    maxTerrainHeight: 9,
    useWorkers: false,
  };
  const manager = new ChunkManager(options);
  try {
    assert.equal(manager.maxBuildY, options.maxBuildY);
    assert.equal(manager.config.maxBuildY, options.maxBuildY);
    assert.equal(manager.workerOptions().maxBuildY, options.maxBuildY);

    const chunk = manager.ensureChunk(0, 0);
    assert.equal(chunk.maxBuildY, options.maxBuildY);
    for (const worldY of [options.maxBuildY - 1, options.maxBuildY, options.maxBuildY + 1]) {
      assert.equal(
        manager.getBlockAtWorld(0, worldY, 0),
        getBlockAt(seed, 0, worldY, 0, DEFAULT_GENERATION_VERSION, options),
        `manager lookup at Y=${worldY}`,
      );
    }
    assert.equal(manager.getBlockAtWorld(0, options.maxBuildY + 1, 0), BLOCK_ID.air);
  } finally {
    manager.dispose();
  }
});
