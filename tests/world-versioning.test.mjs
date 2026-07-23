import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";
import { ChunkState } from "../chunk/chunk-state.js";
import { MAX_DEVELOPMENT_SEED_TEXT_LENGTH, normalizeSeedBytes } from "../core/hash.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { getResourceAt } from "../world/resource-oracle.js";
import {
  assertWorldCoordinates,
  createWorldGeneratorConfig,
  DEFAULT_GENERATION_VERSION,
  DEFAULT_RESOURCE_RULE_VERSION,
  generateBaseChunkProfileFromConfig,
  getBlockAt,
  SUPPORTED_GENERATION_VERSIONS,
  SUPPORTED_RESOURCE_RULE_VERSIONS,
  terrainSurfaceHeight,
  WORLD_GENERATOR_LIMITS,
} from "../world/world-generator.js";

test("world and resource versions fail closed outside their implemented algorithms", () => {
  assert.deepEqual(SUPPORTED_GENERATION_VERSIONS, [DEFAULT_GENERATION_VERSION]);
  assert.deepEqual(SUPPORTED_RESOURCE_RULE_VERSIONS, [DEFAULT_RESOURCE_RULE_VERSION]);

  for (const version of [-1, 0, 1, 4, 6, 999, 5.5, "unknown"]) {
    assert.throws(
      () => createWorldGeneratorConfig({ generationVersion: version }),
      /Unsupported world generation version/,
    );
    assert.throws(
      () => getBlockAt("version-test", 0, 0, 0, version),
      /Unsupported world generation version/,
    );
  }

  for (const version of [-1, 0, 2, 999, 1.5, "unknown"]) {
    assert.throws(
      () => createWorldGeneratorConfig({ resourceRuleVersion: version }),
      /Unsupported resource rule version/,
    );
    assert.throws(
      () => getResourceAt("version-test", 0, 0, 0, version),
      /Unsupported resource rule version/,
    );
  }

  assert.throws(
    () => getBlockAt("version-test", 0, 0, 0),
    /Unsupported world generation version undefined/,
  );
  assert.throws(
    () => getResourceAt("version-test", 0, 0, 0, DEFAULT_RESOURCE_RULE_VERSION, {
      blockId: BLOCK_ID.stone,
    }),
    /Unsupported world generation version undefined/,
  );
  assert.throws(
    () => getResourceAt("version-test", 0, 0, 0, undefined, {
      blockId: BLOCK_ID.stone,
      generationVersion: DEFAULT_GENERATION_VERSION,
    }),
    /Unsupported resource rule version undefined/,
  );
});

test("version metadata is normalized consistently across public state objects", () => {
  const config = createWorldGeneratorConfig({ generationVersion: "5", resourceRuleVersion: "1" });
  assert.equal(config.generationVersion, DEFAULT_GENERATION_VERSION);
  assert.equal(config.resourceRuleVersion, DEFAULT_RESOURCE_RULE_VERSION);

  const manager = new ChunkManager({
    generationVersion: "5",
    resourceRuleVersion: "1",
    useWorkers: false,
    deferInitialBuilds: true,
  });
  assert.equal(manager.generationVersion, DEFAULT_GENERATION_VERSION);
  assert.equal(manager.resourceRuleVersion, DEFAULT_RESOURCE_RULE_VERSION);
  manager.dispose();

  const state = new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    generationVersion: "5",
    resourceRuleVersion: "1",
  });
  assert.equal(state.generationVersion, DEFAULT_GENERATION_VERSION);
  assert.equal(state.resourceRuleVersion, DEFAULT_RESOURCE_RULE_VERSION);
});

test("authoritative world and resource lookups reject coordinate coercion and aliasing", () => {
  assert.deepEqual(
    assertWorldCoordinates(
      WORLD_GENERATOR_LIMITS.minHorizontalCoordinate,
      WORLD_GENERATOR_LIMITS.maxVerticalCoordinate,
      WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate,
    ),
    {
      worldX: WORLD_GENERATOR_LIMITS.minHorizontalCoordinate,
      worldY: WORLD_GENERATOR_LIMITS.maxVerticalCoordinate,
      worldZ: WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate,
    },
  );

  for (const [worldX, worldY, worldZ] of [
    [0.5, 0, 0],
    ["1", 0, 0],
    [NaN, 0, 0],
    [Infinity, 0, 0],
    [WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate + 1, 0, 0],
    [0, WORLD_GENERATOR_LIMITS.minVerticalCoordinate - 1, 0],
    [0, 0, WORLD_GENERATOR_LIMITS.minHorizontalCoordinate - 1],
  ]) {
    assert.throws(
      () => getBlockAt("coordinate-test", worldX, worldY, worldZ, DEFAULT_GENERATION_VERSION),
      /must be an integer from/,
    );
    assert.throws(
      () => getResourceAt("coordinate-test", worldX, worldY, worldZ, DEFAULT_RESOURCE_RULE_VERSION, {
        blockId: BLOCK_ID.stone,
        generationVersion: DEFAULT_GENERATION_VERSION,
      }),
      /must be an integer from/,
    );
  }
});

test("chunk reconstruction and explicit resource blocks fail closed outside the release domain", () => {
  const config = createWorldGeneratorConfig({ chunkSize: 16 });
  const maximumChunk = Math.floor(
    (WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate - (config.chunkSize - 1)) / config.chunkSize,
  );
  for (const chunkX of [maximumChunk + 1, 0.5, "0", Infinity]) {
    assert.throws(
      () => generateBaseChunkProfileFromConfig(config, chunkX, 0),
      /chunk X must be an integer from/,
    );
  }

  const resource = getResourceAt("block-test", 0, 0, 0, DEFAULT_RESOURCE_RULE_VERSION, {
    blockId: BLOCK_ID.stone,
    generationVersion: DEFAULT_GENERATION_VERSION,
  });
  assert.equal(resource.blockId, BLOCK_ID.stone);
  for (const blockId of [-1, "3", 54, 65_535, NaN, Infinity]) {
    assert.throws(
      () => getResourceAt("block-test", 0, 0, 0, DEFAULT_RESOURCE_RULE_VERSION, {
        blockId,
        generationVersion: DEFAULT_GENERATION_VERSION,
      }),
      /Unsupported block ID/,
    );
  }
});

test("seed normalization is bounded, canonical, and detached from caller mutation", () => {
  const input = Uint8Array.from({ length: 32 }, (_, index) => index);
  const expected = new Uint8Array(input);
  const config = createWorldGeneratorConfig({ worldSeed: input });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.hasOwn(config, "cache"), false);
  assert.deepEqual(config.worldSeed, expected);
  assert.equal(config.worldSeedHex, Buffer.from(expected).toString("hex"));

  const cachedSurface = terrainSurfaceHeight(config, 12, -34);
  const exposedConfigSeed = config.worldSeed;
  exposedConfigSeed.fill(255);
  assert.notEqual(exposedConfigSeed, config.worldSeed);
  assert.deepEqual(config.worldSeed, expected);
  assert.equal(config.worldSeedHex, Buffer.from(expected).toString("hex"));
  assert.equal(terrainSurfaceHeight(config, 12, -34), cachedSurface);
  assert.equal(
    terrainSurfaceHeight(config, 13, -34),
    terrainSurfaceHeight(createWorldGeneratorConfig({ worldSeed: expected }), 13, -34),
    "mutating an exposed seed copy must not affect an uncached salt or coordinate",
  );

  input[0] = 255;
  assert.deepEqual(config.worldSeed, expected);
  assert.deepEqual(
    createWorldGeneratorConfig({ worldSeedHex: config.worldSeedHex }).worldSeed,
    expected,
  );

  for (const [field, value] of [
    ["chunkSize", 3],
    ["worldSeedHex", "ff".repeat(32)],
    ["generationVersion", 999],
    ["resourceRuleVersion", 999],
    ["cache", { surface: new Map([["12,-34", -32_768]]) }],
  ]) {
    assert.throws(() => {
      config[field] = value;
    }, TypeError);
  }
  assert.equal(terrainSurfaceHeight(config, 12, -34), cachedSurface);

  const clonedConfig = structuredClone(config);
  assert.equal(Object.hasOwn(clonedConfig, "cache"), false);
  assert.equal(
    terrainSurfaceHeight(clonedConfig, 12, -34),
    cachedSurface,
    "a structured-clone config must lazily receive private generation state",
  );
  const foreignConfig = { ...clonedConfig };
  assert.equal(
    terrainSurfaceHeight(foreignConfig, 13, -34),
    terrainSurfaceHeight(config, 13, -34),
    "an equivalent foreign config must reconstruct without a public cache property",
  );

  const managerInput = new Uint8Array(expected);
  const manager = new ChunkManager({
    worldSeed: managerInput,
    useWorkers: false,
    viewDistance: 1,
    deferInitialBuilds: true,
  });
  managerInput[1] = 255;
  assert.deepEqual(manager.worldSeed, expected);
  assert.notEqual(manager.worldSeed, manager.worldSeed);
  assert.notEqual(manager.worldSeed, manager.config.worldSeed);
  assert.deepEqual(manager.worldSeed, manager.config.worldSeed);
  const expectedManagerBlock = manager.getBlockAtWorld(0, 0, 0);
  const exposedManagerSeed = manager.worldSeed;
  const exposedManagerConfigSeed = manager.config.worldSeed;
  exposedManagerSeed.fill(255);
  exposedManagerConfigSeed.fill(254);
  assert.deepEqual(manager.worldSeed, expected);
  assert.deepEqual(manager.config.worldSeed, expected);
  assert.equal(manager.getBlockAtWorld(0, 0, 0), expectedManagerBlock);
  const managerChunk = manager.ensureChunk(0, 0);
  const exposedChunkSeed = managerChunk.worldSeed;
  exposedChunkSeed.fill(253);
  assert.deepEqual(managerChunk.worldSeed, expected);
  manager.dispose();

  const firstDefault = normalizeSeedBytes();
  firstDefault[0] = 0;
  assert.equal(normalizeSeedBytes()[0], 7, "default seed callers must not share mutable bytes");

  for (const invalid of [
    "",
    "x".repeat(MAX_DEVELOPMENT_SEED_TEXT_LENGTH + 1),
    123,
    {},
    new Uint8Array(33),
    [0, 256],
  ]) {
    assert.throws(() => createWorldGeneratorConfig({ worldSeed: invalid }));
  }
  assert.throws(
    () => createWorldGeneratorConfig({ worldSeed: expected, worldSeedHex: "00".repeat(32) }),
    /either worldSeed or worldSeedHex/,
  );
  assert.throws(
    () => createWorldGeneratorConfig({ worldSeedHex: "not-hex" }),
    /64 hexadecimal characters/,
  );
  assert.throws(
    () => getBlockAt(new Uint8Array(31), 0, 0, 0, DEFAULT_GENERATION_VERSION),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => getBlockAt(undefined, 0, 0, 0, DEFAULT_GENERATION_VERSION),
    /explicit seed/,
  );
});
