import {
  DEFAULT_CHUNK_HEIGHT,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_TERRAIN_HEIGHT,
  DEFAULT_MIN_WORLD_Y,
  DEFAULT_SEA_LEVEL,
} from "../core/constants.js";
import {
  hashCoord3,
  I16_MAX,
  I16_MIN,
  I32_MAX,
  I32_MIN,
  lerpIntFixed,
  normalizeSeedBytes,
  saturatingAddI16,
  saturatingAddI32,
  saturatingMulI32,
  saturatingSubI16,
  saturatingSubI32,
  scaleByFixed,
  SEED_BYTE_LENGTH,
  smoothRangeFixed,
  valueNoise2,
} from "../core/hash.js";
import { BLOCK_ID, isFluidBlock } from "./block-registry.js";

export const MAINNET_WORLD_SEED = "nicechunk-mainnet-001";
export const DEFAULT_GENERATION_VERSION = 5;
export const DEFAULT_RESOURCE_RULE_VERSION = 1;
export const SUPPORTED_GENERATION_VERSIONS = Object.freeze([DEFAULT_GENERATION_VERSION]);
export const SUPPORTED_RESOURCE_RULE_VERSIONS = Object.freeze([DEFAULT_RESOURCE_RULE_VERSION]);
export const WORLD_GENERATOR_LIMITS = Object.freeze({
  minChunkSize: 1,
  maxChunkSize: 64,
  maxHeight: 4096,
  maxChunkVoxels: 4_194_304,
  minHorizontalCoordinate: I32_MIN,
  maxHorizontalCoordinate: I32_MAX,
  minVerticalCoordinate: I16_MIN,
  maxVerticalCoordinate: I16_MAX,
});

const generatorCacheLimit = 180000;
const configWorldSeeds = new WeakMap();
const configGenerationCaches = new WeakMap();

export function createWorldGeneratorConfig(options = {}) {
  const dimensions = normalizeWorldGeneratorDimensions(options);
  const hasWorldSeed = options.worldSeed != null;
  const hasWorldSeedHex = options.worldSeedHex != null;
  if (hasWorldSeed && hasWorldSeedHex) {
    throw new TypeError("Provide either worldSeed or worldSeedHex, not both.");
  }
  if (hasWorldSeedHex && (typeof options.worldSeedHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(options.worldSeedHex))) {
    throw new TypeError("worldSeedHex must be exactly 64 hexadecimal characters.");
  }
  const worldSeedInput = options.worldSeedHex ?? options.worldSeed ?? MAINNET_WORLD_SEED;
  const worldSeed = normalizeSeedBytes(worldSeedInput);
  const generationVersion = assertSupportedGenerationVersion(
    options.generationVersion ?? DEFAULT_GENERATION_VERSION,
  );
  const resourceRuleVersion = assertSupportedResourceRuleVersion(
    options.resourceRuleVersion ?? DEFAULT_RESOURCE_RULE_VERSION,
  );
  const config = {
    worldSeedHex: bytesToHex(worldSeed),
    ...dimensions,
    generationVersion,
    resourceRuleVersion,
  };
  configWorldSeeds.set(config, worldSeed);
  configGenerationCaches.set(config, createGenerationCache());
  Object.defineProperty(config, "worldSeed", {
    enumerable: true,
    get: () => new Uint8Array(worldSeed),
  });
  return Object.freeze(config);
}

export function normalizeWorldGeneratorDimensions(options = {}) {
  const chunkSize = boundedInteger(
    options.chunkSize,
    DEFAULT_CHUNK_SIZE,
    WORLD_GENERATOR_LIMITS.minChunkSize,
    WORLD_GENERATOR_LIMITS.maxChunkSize,
    "chunk size",
  );
  const minY = boundedInteger(
    options.minY,
    DEFAULT_MIN_WORLD_Y,
    WORLD_GENERATOR_LIMITS.minVerticalCoordinate,
    WORLD_GENERATOR_LIMITS.maxVerticalCoordinate,
    "minimum world Y",
  );
  const height = boundedInteger(
    options.height,
    DEFAULT_CHUNK_HEIGHT,
    1,
    WORLD_GENERATOR_LIMITS.maxHeight,
    "chunk height",
  );
  const worldTop = minY + height - 1;
  if (worldTop > WORLD_GENERATOR_LIMITS.maxVerticalCoordinate) {
    throw new RangeError("Chunk vertical bounds must fit signed 16-bit world Y coordinates.");
  }
  if (chunkSize * chunkSize * height > WORLD_GENERATOR_LIMITS.maxChunkVoxels) {
    throw new RangeError(`Chunk volume exceeds the ${WORLD_GENERATOR_LIMITS.maxChunkVoxels}-voxel safety limit.`);
  }
  const maxBuildY = boundedInteger(options.maxBuildY, worldTop, minY, worldTop, "maximum build Y");
  return {
    chunkSize,
    height,
    minY,
    maxBuildY,
    seaLevel: boundedInteger(
      options.seaLevel,
      DEFAULT_SEA_LEVEL,
      WORLD_GENERATOR_LIMITS.minVerticalCoordinate,
      WORLD_GENERATOR_LIMITS.maxVerticalCoordinate,
      "sea level",
    ),
    maxTerrainHeight: boundedInteger(
      options.maxTerrainHeight,
      DEFAULT_MAX_TERRAIN_HEIGHT,
      WORLD_GENERATOR_LIMITS.minVerticalCoordinate,
      WORLD_GENERATOR_LIMITS.maxVerticalCoordinate,
      "maximum terrain height",
    ),
  };
}

export function assertSupportedGenerationVersion(value = DEFAULT_GENERATION_VERSION) {
  return assertSupportedVersion(
    value,
    SUPPORTED_GENERATION_VERSIONS,
    "world generation",
  );
}

export function assertSupportedResourceRuleVersion(value = DEFAULT_RESOURCE_RULE_VERSION) {
  return assertSupportedVersion(
    value,
    SUPPORTED_RESOURCE_RULE_VERSIONS,
    "resource rule",
  );
}

export function assertWorldCoordinates(worldX, worldY, worldZ) {
  return {
    worldX: protocolInteger(
      worldX,
      WORLD_GENERATOR_LIMITS.minHorizontalCoordinate,
      WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate,
      "world X",
    ),
    worldY: protocolInteger(
      worldY,
      WORLD_GENERATOR_LIMITS.minVerticalCoordinate,
      WORLD_GENERATOR_LIMITS.maxVerticalCoordinate,
      "world Y",
    ),
    worldZ: protocolInteger(
      worldZ,
      WORLD_GENERATOR_LIMITS.minHorizontalCoordinate,
      WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate,
      "world Z",
    ),
  };
}

export function assertReconstructionSeed(value) {
  if (value == null) throw new TypeError("World reconstruction requires an explicit seed.");
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const byteLength = value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
    if (byteLength !== SEED_BYTE_LENGTH) {
      throw new RangeError(`World reconstruction seeds must contain exactly ${SEED_BYTE_LENGTH} bytes.`);
    }
  } else if (Array.isArray(value) && value.length !== SEED_BYTE_LENGTH) {
    throw new RangeError(`World reconstruction seeds must contain exactly ${SEED_BYTE_LENGTH} bytes.`);
  }
  return normalizeSeedBytes(value);
}

export function assertExplicitGenerationVersion(value) {
  if (!Number.isInteger(value)) {
    throw new RangeError(
      `Unsupported world generation version ${String(value)}. An explicit integer is required; supported versions: ${SUPPORTED_GENERATION_VERSIONS.join(", ")}.`,
    );
  }
  return assertSupportedGenerationVersion(value);
}

export function assertExplicitResourceRuleVersion(value) {
  if (!Number.isInteger(value)) {
    throw new RangeError(
      `Unsupported resource rule version ${String(value)}. An explicit integer is required; supported versions: ${SUPPORTED_RESOURCE_RULE_VERSIONS.join(", ")}.`,
    );
  }
  return assertSupportedResourceRuleVersion(value);
}

export function generateBaseChunk(worldSeed, chunkX, chunkZ, generationVersion, options = {}) {
  const config = createWorldGeneratorConfig({
    ...options,
    worldSeed: assertReconstructionSeed(worldSeed),
    generationVersion: assertExplicitGenerationVersion(generationVersion),
  });
  const coordinates = assertChunkCoordinates(config, chunkX, chunkZ);
  const blocks = new Uint16Array(config.chunkSize * config.height * config.chunkSize);

  for (let localZ = 0; localZ < config.chunkSize; localZ += 1) {
    for (let localX = 0; localX < config.chunkSize; localX += 1) {
      const worldX = chunkLocalToWorldI32(coordinates.chunkX, localX, config.chunkSize);
      const worldZ = chunkLocalToWorldI32(coordinates.chunkZ, localZ, config.chunkSize);
      const surface = terrainSurfaceHeight(config, worldX, worldZ);
      const water = waterLevelAt(config, worldX, worldZ, surface);
      const topFillY = Math.min(config.maxBuildY, Math.max(surface, water ?? surface));
      for (let y = config.minY; y <= topFillY; y += 1) {
        const blockId = generatedTerrainOrFluidAt(config, worldX, y, worldZ, surface, water);
        if (blockId !== BLOCK_ID.air) blocks[indexOf(localX, y, localZ, config)] = blockId;
      }

    }
  }

  return blocks;
}

export function generateBaseChunkProfile(worldSeed, chunkX, chunkZ, generationVersion, options = {}) {
  const config = createWorldGeneratorConfig({
    ...options,
    worldSeed: assertReconstructionSeed(worldSeed),
    generationVersion: assertExplicitGenerationVersion(generationVersion),
  });
  return generateBaseChunkProfileFromConfig(config, chunkX, chunkZ);
}

export function generateBaseChunkProfileFromConfig(config, chunkX, chunkZ, { cacheTreeCandidates = false } = {}) {
  const coordinates = assertChunkCoordinates(config, chunkX, chunkZ);
  const size = config.chunkSize;
  const cells = size * size;
  const surfaceY = new Int16Array(cells);
  const waterY = new Int16Array(cells);
  const surfaceBlock = new Uint16Array(cells);
  const treeCandidates = cacheTreeCandidates ? new Array(cells) : null;
  const noWater = Math.max(-32768, Math.min(32767, config.minY - 1));
  waterY.fill(noWater);

  for (let localZ = 0; localZ < size; localZ += 1) {
    for (let localX = 0; localX < size; localX += 1) {
      const worldX = chunkLocalToWorldI32(coordinates.chunkX, localX, size);
      const worldZ = chunkLocalToWorldI32(coordinates.chunkZ, localZ, size);
      const column = localX + localZ * size;
      const surface = terrainSurfaceHeight(config, worldX, worldZ);
      const water = waterLevelAt(config, worldX, worldZ, surface);
      surfaceY[column] = surface;
      waterY[column] = water ?? noWater;
      surfaceBlock[column] = surfaceBlockAt(config, worldX, worldZ, surface);
      const tree = treeCandidates
        ? (canGrowTree(config, worldX, worldZ, surface) ? treeAt(config, worldX, worldZ, surface, surfaceBlock[column]) : null)
        : undefined;
      if (treeCandidates) treeCandidates[column] = tree;
    }
  }

  const profile = {
    chunkX: coordinates.chunkX,
    chunkZ: coordinates.chunkZ,
    chunkSize: size,
    minY: config.minY,
    maxBuildY: config.maxBuildY,
    height: config.height,
    generationVersion: config.generationVersion,
    surfaceY,
    waterY,
    surfaceBlock,
    noWater,
  };
  if (treeCandidates) Object.defineProperty(profile, "treeCandidates", { value: treeCandidates, configurable: true });
  return profile;
}

export function generateTreeInstancesForChunk(worldSeed, chunkX, chunkZ, generationVersion, options = {}) {
  const config = createWorldGeneratorConfig({
    ...options,
    worldSeed: assertReconstructionSeed(worldSeed),
    generationVersion: assertExplicitGenerationVersion(generationVersion),
  });
  return generateTreeInstancesForChunkFromConfig(config, chunkX, chunkZ);
}

export function generateTreeInstancesForChunkFromConfig(config, chunkX, chunkZ, baseProfile = null) {
  const coordinates = assertChunkCoordinates(config, chunkX, chunkZ);
  const out = [];
  const visitedWorldColumns = new Set();
  const treeCandidates = baseProfile?.treeCandidates;
  const hasTreeCandidates = Array.isArray(treeCandidates) && treeCandidates.length >= config.chunkSize * config.chunkSize;
  for (let localZ = 0; localZ < config.chunkSize; localZ += 1) {
    const z = chunkLocalToWorldI32(coordinates.chunkZ, localZ, config.chunkSize);
    for (let localX = 0; localX < config.chunkSize; localX += 1) {
      const x = chunkLocalToWorldI32(coordinates.chunkX, localX, config.chunkSize);
      const worldColumn = `${x},${z}`;
      if (visitedWorldColumns.has(worldColumn)) continue;
      visitedWorldColumns.add(worldColumn);
      const column = localX + localZ * config.chunkSize;
      const surface = baseProfile?.surfaceY?.[column] ?? terrainSurfaceHeight(config, x, z);
      let tree = hasTreeCandidates ? treeCandidates[column] : null;
      if (!hasTreeCandidates) {
        if (!canGrowTree(config, x, z, surface)) continue;
        const surfaceBlock = baseProfile?.surfaceBlock?.[column];
        tree = treeAt(config, x, z, surface, surfaceBlock);
      }
      if (!tree?.exists) continue;
      const instance = {
        id: `${x},${tree.baseY},${z}`,
        x,
        z,
        baseY: tree.baseY,
        trunkHeight: tree.trunkHeight,
        pine: tree.pine,
        snowy: tree.snowy,
        variantSeed: hashCoord3(worldSeedBytes(config), x, tree.baseY, z, 751) >>> 0,
      };
      const leafProfile = treeInstanceLeafProfile(config, instance);
      instance.leafMinY = leafProfile.minY;
      instance.leafMasks = leafProfile.masks;
      out.push(instance);
    }
  }
  return out;
}

export function getBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion, options = {}) {
  const config = createWorldGeneratorConfig({
    ...options,
    worldSeed: assertReconstructionSeed(worldSeed),
    generationVersion: assertExplicitGenerationVersion(ruleVersion),
  });
  const coordinates = assertWorldCoordinates(worldX, worldY, worldZ);
  return blockAtConfig(config, coordinates.worldX, coordinates.worldY, coordinates.worldZ);
}

export function getBaseBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion, options = {}) {
  const config = createWorldGeneratorConfig({
    ...options,
    worldSeed: assertReconstructionSeed(worldSeed),
    generationVersion: assertExplicitGenerationVersion(ruleVersion),
  });
  const coordinates = assertWorldCoordinates(worldX, worldY, worldZ);
  return getBaseBlockAtConfig(config, coordinates.worldX, coordinates.worldY, coordinates.worldZ);
}

export function getBaseBlockAtConfig(config, worldX, worldY, worldZ) {
  const { worldX: x, worldY: y, worldZ: z } = assertWorldCoordinates(worldX, worldY, worldZ);
  const surface = terrainSurfaceHeight(config, x, z);
  return generatedTerrainOrFluidAt(config, x, y, z, surface, waterLevelAt(config, x, z, surface));
}

export function getBaseBlockAtColumnConfig(config, worldX, worldY, worldZ, surfaceY, waterY = undefined, surfaceBlockId = undefined) {
  const { worldX: x, worldY: y, worldZ: z } = assertWorldCoordinates(worldX, worldY, worldZ);
  const surface = Number.isFinite(surfaceY)
    ? clampInt(Math.trunc(surfaceY), config.minY, terrainSurfaceCeiling(config))
    : terrainSurfaceHeight(config, x, z);
  const requestedWater = waterY === undefined
    ? waterLevelAt(config, x, z, surface)
    : Number.isFinite(waterY) ? Math.trunc(waterY) : null;
  const clippedWater = requestedWater === null
    ? null
    : Math.min(requestedWater, config.maxBuildY);
  const water = clippedWater !== null && clippedWater > surface ? clippedWater : null;
  return generatedTerrainOrFluidAt(config, x, y, z, surface, water, surfaceBlockId);
}

export function getGeneratedTreeBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion, options = {}) {
  const config = createWorldGeneratorConfig({
    ...options,
    worldSeed: assertReconstructionSeed(worldSeed),
    generationVersion: assertExplicitGenerationVersion(ruleVersion),
  });
  const coordinates = assertWorldCoordinates(worldX, worldY, worldZ);
  if (!containsVerticalBuildCoordinate(config, coordinates.worldY)) return BLOCK_ID.air;
  return treeBlockAt(config, coordinates.worldX, coordinates.worldY, coordinates.worldZ);
}

export function treeInstanceBlockAt(config, tree, worldX, worldY, worldZ) {
  if (!tree) return BLOCK_ID.air;
  const coordinates = assertWorldCoordinates(worldX, worldY, worldZ);
  if (!containsVerticalBuildCoordinate(config, coordinates.worldY)) return BLOCK_ID.air;
  return treeVolumeBlock(config, tree, coordinates.worldX, coordinates.worldY, coordinates.worldZ);
}

export function treeInstanceLeafProfile(configOrSeed, tree) {
  if (!tree) return { minY: 0, masks: [] };
  const worldSeed = configOrSeed?.worldSeed instanceof Uint8Array
    ? configOrSeed.worldSeed
    : normalizeSeedBytes(configOrSeed?.worldSeed ?? configOrSeed);
  const top = saturatingAddI16(tree.baseY, tree.trunkHeight);
  const minY = saturatingSubI16(top, tree.pine ? 4 : 2);
  const maxY = saturatingAddI16(top, 1);
  const leafBlockId = tree.pine ? BLOCK_ID.pineLeaves : BLOCK_ID.leaves;
  const masks = new Array(maxY - minY + 1).fill(0);
  const config = { worldSeed };
  for (let y = minY; y <= maxY; y += 1) {
    let mask = 0;
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const worldX = saturatingAddI32(tree.x, dx);
        const worldZ = saturatingAddI32(tree.z, dz);
        if (treeVolumeBlock(config, tree, worldX, y, worldZ) !== leafBlockId) continue;
        mask |= 1 << ((dz + 2) * 5 + dx + 2);
      }
    }
    masks[y - minY] = mask >>> 0;
  }
  return { minY, masks };
}

export function getGeneratedTreeTrunkBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion, options = {}) {
  const config = createWorldGeneratorConfig({
    ...options,
    worldSeed: assertReconstructionSeed(worldSeed),
    generationVersion: assertExplicitGenerationVersion(ruleVersion),
  });
  const { worldX: x, worldY: y, worldZ: z } = assertWorldCoordinates(worldX, worldY, worldZ);
  if (!containsVerticalBuildCoordinate(config, y)) return BLOCK_ID.air;
  const surface = terrainSurfaceHeight(config, x, z);
  if (!canGrowTree(config, x, z, surface)) return BLOCK_ID.air;
  return treeInstanceTrunkBlockAt(config, treeAt(config, x, z, surface), x, y, z);
}

export function treeInstanceTrunkBlockAt(config, tree, worldX, worldY, worldZ) {
  if (!tree) return BLOCK_ID.air;
  const { worldX: x, worldY: y, worldZ: z } = assertWorldCoordinates(worldX, worldY, worldZ);
  if (!containsVerticalBuildCoordinate(config, y)) return BLOCK_ID.air;
  const top = saturatingAddI16(tree.baseY, tree.trunkHeight);
  if (x === tree.x && z === tree.z && y >= tree.baseY && y < top) return tree.pine ? BLOCK_ID.pineTrunk : BLOCK_ID.trunk;
  return BLOCK_ID.air;
}

export function terrainProfile(configOrSeed, worldX, worldZ, options = {}) {
  const config = configOrSeed?.worldSeed instanceof Uint8Array ? configOrSeed : createWorldGeneratorConfig({ ...options, worldSeed: configOrSeed });
  const x = protocolHorizontalCoordinate(worldX, "world X");
  const z = protocolHorizontalCoordinate(worldZ, "world Z");
  const height = terrainSurfaceHeight(config, x, z);
  const waterLevel = waterLevelAt(config, x, z, height);
  const moisture = moistureAt(config, x, z);
  const desert = desertScoreAt(config, x, z);
  const volcanic = volcanicAt(config, x, z);
  const terrain = surfaceBlockAt(config, x, z, height);
  return {
    height,
    waterLevel,
    terrain,
    moisture,
    desert,
    volcanic,
    cold: coldAt(config, x, z, height),
    wet: moisture > 188,
    fluid: waterLevel !== null && waterLevel > height ? BLOCK_ID.water : null,
  };
}

export function terrainSurfaceHeight(config, worldX, worldZ) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  const cacheKey = `${x},${z}`;
  const surfaceCache = generationCache(config).surface;
  const cached = surfaceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const maxSurface = terrainSurfaceCeiling(config);
  const desiredMinSurface = Math.max(
    saturatingAddI16(config.minY, 8),
    saturatingSubI16(config.seaLevel, 28),
  );
  const minSurface = Math.min(desiredMinSurface, maxSurface);
  const terrain = terrainFactors(config, x, z);
  const { wx, wz, shelf, inland, waterMask, valleyMask, floodplainMask, lake, valleySoftness, openRiver } = terrain;

  const ocean =
    config.seaLevel - 16 +
    Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 96, 24) - 128) * 5 / 128) +
    Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 36, 25) - 128) * 2 / 128);
  const coast = config.seaLevel - 3 + Math.trunc(shelf * 8 / 1024);
  const plains = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 120, 26) - 128) * 4 / 128);
  const hills = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 56, 27) - 128) * 7 / 128);
  const rolling = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 28, 28) - 128) * 2 / 128);
  const roughness = smoothRangeFixed(Math.abs(valueNoise2(worldSeedBytes(config), wx, wz, 180, 40) - 128), 54, 122);
  const mountainRange = scaleByFixed(smoothRangeFixed(valueNoise2(worldSeedBytes(config), wx, wz, 360, 30), 136, 226), inland);
  const highland = scaleByFixed(34, scaleByFixed(smoothRangeFixed(valueNoise2(worldSeedBytes(config), wx, wz, 620, 46), 116, 206), inland));
  const ridgeLine = 128 - Math.abs(valueNoise2(worldSeedBytes(config), wx, wz, 92, 29) - 128);
  const ridgeLift = smoothRangeFixed(ridgeLine, 44, 126);
  const peakMask = scaleByFixed(smoothRangeFixed(valueNoise2(worldSeedBytes(config), wx, wz, 176, 47), 176, 242), mountainRange);
  const crag = scaleByFixed(smoothRangeFixed(Math.abs(valueNoise2(worldSeedBytes(config), wx, wz, 52, 48) - 128), 48, 126), mountainRange);
  const mountain = highland + scaleByFixed(24 + scaleByFixed(72, ridgeLift) + scaleByFixed(24, crag), mountainRange) + scaleByFixed(34, peakMask);

  const land = config.seaLevel + 7 + Math.trunc(inland * 8 / 1024) + scaleByFixed(plains + scaleByFixed(hills + rolling, roughness), inland) + mountain;
  let shapedLand = Math.max(coast, land);
  if (floodplainMask > 0) {
    const flatNoise = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 54, 38) - 128) / 128);
    const floodplainLift = 2 + Math.trunc((1024 - openRiver) * 2 / 1024);
    const floodplainFloor = config.seaLevel + floodplainLift + flatNoise;
    const floodplainBlend = Math.min(1024, Math.trunc(floodplainMask * (720 + Math.trunc(openRiver * 420 / 1024)) / 1024));
    shapedLand = lerpIntFixed(shapedLand, Math.min(shapedLand, floodplainFloor), floodplainBlend);
  }
  if (valleyMask > 0) {
    const bedNoise = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 32, 39) - 128) * 2 / 128);
    const slopeNoise = valueNoise2(worldSeedBytes(config), wx, wz, 150, 42);
    const canyon = scaleByFixed(smoothRangeFixed(slopeNoise, 190, 252), 1024 - scaleByFixed(openRiver, 640));
    const gentle = 1024 - scaleByFixed(openRiver, 1024 - canyon);
    const slopeStrength = 220 + scaleByFixed(360, canyon) + scaleByFixed(90, gentle);
    const valleyBlend = Math.min(1024, Math.trunc(valleyMask * slopeStrength / 1024));
    const bankLift = 2 + Math.trunc((255 - valleySoftness) * 4 / 255);
    const valleyCut = Math.trunc(valleyMask * (1 + Math.trunc(slopeNoise / 86)) / 1024);
    const bankFloor = config.seaLevel + bankLift - valleyCut + bedNoise;
    shapedLand = lerpIntFixed(shapedLand, Math.min(shapedLand, bankFloor), valleyBlend);

    const coreStart = 84 + Math.trunc((255 - slopeNoise) * 172 / 255);
    const coreBlend = smoothRangeFixed(waterMask, coreStart, 1024);
    if (coreBlend > 0) {
      const waterBed = config.seaLevel - 1 - Math.trunc(waterMask * 4 / 1024) - Math.trunc(lake * 3 / 1024) + bedNoise;
      shapedLand = lerpIntFixed(shapedLand, waterBed, coreBlend);
    }
  }

  const height = clampInt(lerpIntFixed(ocean, shapedLand, shelf), minSurface, maxSurface);
  cacheSetBounded(surfaceCache, cacheKey, height);
  return height;
}

export function waterLevelAt(config, worldX, worldZ, surface = terrainSurfaceHeight(config, worldX, worldZ)) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  const cacheKey = `${x},${z},${surface}`;
  const waterCache = generationCache(config).water;
  const cached = waterCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let waterLevel = null;
  if (surface < config.seaLevel) {
    const effectiveWaterLevel = Math.min(config.seaLevel, config.maxBuildY);
    if (effectiveWaterLevel > surface) waterLevel = effectiveWaterLevel;
  }
  cacheSetBounded(waterCache, cacheKey, waterLevel);
  return waterLevel;
}

export function surfaceBlockAt(config, worldX, worldZ, surface = terrainSurfaceHeight(config, worldX, worldZ)) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  if (surface <= config.minY) return BLOCK_ID.bedrock;
  const water = waterLevelAt(config, x, z, surface);
  const underwater = water !== null && surface < water;
  const moisture = moistureAt(config, x, z);
  const desert = desertScoreAt(config, x, z);
  const gravelPatch = valueNoise2(worldSeedBytes(config), x, z, 44, 103);
  const clayPatch = valueNoise2(worldSeedBytes(config), x, z, 52, 104);

  if (underwater || surface <= saturatingAddI16(config.seaLevel, 1)) {
    if (moisture > 190 && clayPatch > 148) return BLOCK_ID.clay;
    if (gravelPatch > 218) return BLOCK_ID.gravel;
    if (valueNoise2(worldSeedBytes(config), x, z, 96, 105) > 236) return BLOCK_ID.shellBed;
    return BLOCK_ID.sand;
  }
  if (volcanicAt(config, x, z) > 246) return valueNoise2(worldSeedBytes(config), x, z, 64, 106) > 180 ? BLOCK_ID.basalt : BLOCK_ID.ash;
  if (coldAt(config, x, z, surface)) return surface > saturatingAddI16(config.seaLevel, 34) || valueNoise2(worldSeedBytes(config), x, z, 72, 107) > 164 ? BLOCK_ID.snow : BLOCK_ID.frozenSoil;
  if (desert > 178) {
    if (desert > 226 && valueNoise2(worldSeedBytes(config), x, z, 88, 108) > 188) return BLOCK_ID.saltFlat;
    return desert > 204 ? BLOCK_ID.sand : BLOCK_ID.dryDirt;
  }
  if (moisture > 188) {
    return moisture > 208 ? BLOCK_ID.mud : BLOCK_ID.grass;
  }
  if (surface >= saturatingAddI16(config.seaLevel, 36)) return BLOCK_ID.stone;
  return BLOCK_ID.grass;
}

export function treeAt(config, worldX, worldZ, surface = terrainSurfaceHeight(config, worldX, worldZ), surfaceBlockId = undefined) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  const growth = treeGrowthProfile(config, x, z, surface, surfaceBlockId);
  const density = growth.density;
  const cellSize = growth.cellSize;
  const cellX = divFloor(x, cellSize);
  const cellZ = divFloor(z, cellSize);
  const originX = saturatingMulI32(cellX, cellSize);
  const originZ = saturatingMulI32(cellZ, cellSize);
  const inner = Math.max(1, cellSize - 2);
  const treeX = saturatingAddI32(
    saturatingAddI32(originX, 1),
    hashCoord3(worldSeedBytes(config), cellX, 0, cellZ, 401) % inner,
  );
  const treeZ = saturatingAddI32(
    saturatingAddI32(originZ, 1),
    hashCoord3(worldSeedBytes(config), cellX, 0, cellZ, 402) % inner,
  );
  const roll = hashCoord3(worldSeedBytes(config), cellX, 0, cellZ, 403) & 255;
  const snowy = surface >= snowLineAt(config, x, z);
  const pine = growth.pine;
  const tree = treeFromProfile(config, x, z, surface, pine);
  const crownTop = saturatingAddI16(
    saturatingAddI16(tree.baseY, tree.trunkHeight),
    1,
  );
  const exists = x === treeX
    && z === treeZ
    && roll > density
    && crownTop <= config.maxBuildY;
  return { ...tree, exists, snowy: pine && snowy };
}

function blockAtConfig(config, x, y, z) {
  if (!containsVerticalBuildCoordinate(config, y)) return BLOCK_ID.air;
  if (y === config.minY) return BLOCK_ID.bedrock;
  const surface = terrainSurfaceHeight(config, x, z);
  if (y > surface) {
    const water = waterLevelAt(config, x, z, surface);
    if (water !== null && y <= water) return BLOCK_ID.water;
    const treeBlock = treeBlockAt(config, x, y, z);
    if (treeBlock !== BLOCK_ID.air) return treeBlock;
    return BLOCK_ID.air;
  }
  return generatedTerrainOrFluidAt(config, x, y, z, surface, waterLevelAt(config, x, z, surface));
}

function generatedTerrainOrFluidAt(config, x, y, z, surface, water, surfaceBlockId = undefined) {
  if (!containsVerticalBuildCoordinate(config, y)) return BLOCK_ID.air;
  if (y > surface) return water !== null && y <= water ? BLOCK_ID.water : BLOCK_ID.air;
  if (y <= config.minY) return BLOCK_ID.bedrock;
  const depth = saturatingSubI16(surface, y);
  if (depth <= 0) return Number.isFinite(surfaceBlockId) ? Math.trunc(surfaceBlockId) : surfaceBlockAt(config, x, z, surface);
  if (depth <= 3) return subsurfaceBlockAt(config, x, z, surface, surfaceBlockId);
  const oreBlock = oreVeinBlockAt(config, x, y, z, surface);
  if (oreBlock !== BLOCK_ID.air) return oreBlock;
  if (y <= saturatingAddI16(config.minY, 40) || depth >= 52) return BLOCK_ID.deepStone;
  if (volcanicAt(config, x, z) > 238 && hashCoord3(worldSeedBytes(config), x, y, z, 601) > 210) return BLOCK_ID.basalt;
  return BLOCK_ID.stone;
}

function subsurfaceBlockAt(config, x, z, surface, surfaceBlockId = undefined) {
  const top = Number.isFinite(surfaceBlockId) ? Math.trunc(surfaceBlockId) : surfaceBlockAt(config, x, z, surface);
  switch (top) {
    case BLOCK_ID.sand:
    case BLOCK_ID.saltFlat:
    case BLOCK_ID.quicksand:
      return BLOCK_ID.sand;
    case BLOCK_ID.mud:
    case BLOCK_ID.clay:
    case BLOCK_ID.moss:
      return hashCoord3(worldSeedBytes(config), x, surface - 1, z, 121) > 112 ? BLOCK_ID.clay : BLOCK_ID.mud;
    case BLOCK_ID.snow:
    case BLOCK_ID.frozenSoil:
      return BLOCK_ID.frozenSoil;
    case BLOCK_ID.basalt:
    case BLOCK_ID.ash:
      return BLOCK_ID.basalt;
    case BLOCK_ID.stone:
      return BLOCK_ID.stone;
    default:
      return BLOCK_ID.dirt;
  }
}

function canGrowTree(config, x, z, surface) {
  if (surface >= config.maxBuildY) return false;
  if (surface <= saturatingAddI16(config.seaLevel, 1)) return false;
  const water = waterLevelAt(config, x, z, surface);
  if (water !== null && surface < water) return false;
  if (desertScoreAt(config, x, z) > 178 || volcanicAt(config, x, z) > 236) return false;
  return true;
}

function treeBlockAt(config, x, y, z) {
  if (!containsVerticalBuildCoordinate(config, y)) return BLOCK_ID.air;
  let best = null;
  for (let cellSize = 6; cellSize <= 14; cellSize += 1) {
    const minCellX = treeCandidateMinCell(x, 2, cellSize);
    const maxCellX = treeCandidateMaxCell(x, 2, cellSize);
    const minCellZ = treeCandidateMinCell(z, 2, cellSize);
    const maxCellZ = treeCandidateMaxCell(z, 2, cellSize);
    const inner = cellSize - 2;
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const treeX = saturatingAddI32(
          saturatingAddI32(saturatingMulI32(cellX, cellSize), 1),
          hashCoord3(worldSeedBytes(config), cellX, 0, cellZ, 401) % inner,
        );
        const treeZ = saturatingAddI32(
          saturatingAddI32(saturatingMulI32(cellZ, cellSize), 1),
          hashCoord3(worldSeedBytes(config), cellX, 0, cellZ, 402) % inner,
        );
        if (Math.abs(saturatingSubI32(treeX, x)) > 2
          || Math.abs(saturatingSubI32(treeZ, z)) > 2) {
          continue;
        }
        const roll = hashCoord3(worldSeedBytes(config), cellX, 0, cellZ, 403) & 255;
        if (roll <= 128) continue;
        const surface = terrainSurfaceHeight(config, treeX, treeZ);
        if (!treeVerticalBoundsCanContain(surface, y)
          || !canGrowTree(config, treeX, treeZ, surface)) {
          continue;
        }
        const growth = treeGrowthProfile(config, treeX, treeZ, surface);
        if (growth.cellSize !== cellSize || roll <= growth.density) continue;
        const tree = treeFromProfile(config, treeX, treeZ, surface, growth.pine);
        const block = treeVolumeBlock(config, tree, x, y, z);
        if (block === BLOCK_ID.air) continue;
        if (!best || tree.z < best.z || (tree.z === best.z && tree.x < best.x)) {
          best = { x: tree.x, z: tree.z, block };
        }
      }
    }
  }
  return best?.block ?? BLOCK_ID.air;
}

function treeVerticalBoundsCanContain(surface, y) {
  return y >= saturatingAddI16(surface, 1)
    && y <= saturatingAddI16(surface, 9);
}

function treeCandidateMinCell(worldCoordinate, radius, cellSize) {
  return divFloor(
    saturatingSubI32(
      saturatingSubI32(worldCoordinate, radius),
      saturatingSubI32(cellSize, 2),
    ),
    cellSize,
  );
}

function treeCandidateMaxCell(worldCoordinate, radius, cellSize) {
  return divFloor(
    saturatingSubI32(saturatingAddI32(worldCoordinate, radius), 1),
    cellSize,
  );
}

function treeFromProfile(config, x, z, surface, pine) {
  const trunkHeight = (pine ? 5 : 4)
    + (hashCoord3(worldSeedBytes(config), x, surface, z, 405) % 3);
  return {
    exists: true,
    x,
    z,
    baseY: saturatingAddI16(surface, 1),
    trunkHeight,
    pine,
  };
}

function treeVolumeBlock(config, tree, x, y, z) {
  const top = saturatingAddI16(tree.baseY, tree.trunkHeight);
  if (x === tree.x && z === tree.z && y >= tree.baseY && y < top) return tree.pine ? BLOCK_ID.pineTrunk : BLOCK_ID.trunk;
  if (tree.pine) {
    if (leafLayerContains(config, tree.x, saturatingSubI16(top, 4), tree.z, x, y, z, 2, 158, 501)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, saturatingSubI16(top, 3), tree.z, x, y, z, 2, 188, 502)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, saturatingSubI16(top, 2), tree.z, x, y, z, 1, 218, 503)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, saturatingSubI16(top, 1), tree.z, x, y, z, 1, 184, 504)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, top, tree.z, x, y, z, 1, 138, 505)) return BLOCK_ID.pineLeaves;
    if (x === tree.x && y === saturatingAddI16(top, 1) && z === tree.z) return BLOCK_ID.pineLeaves;
    return BLOCK_ID.air;
  }
  if (leafLayerContains(config, tree.x, saturatingSubI16(top, 2), tree.z, x, y, z, 2, 174, 511)) return BLOCK_ID.leaves;
  if (leafLayerContains(config, tree.x, saturatingSubI16(top, 1), tree.z, x, y, z, 2, 214, 512)) return BLOCK_ID.leaves;
  if (leafLayerContains(config, tree.x, top, tree.z, x, y, z, 2, 148, 513)) return BLOCK_ID.leaves;
  if (leafLayerContains(config, tree.x, saturatingAddI16(top, 1), tree.z, x, y, z, 1, 194, 514)) return BLOCK_ID.leaves;
  return BLOCK_ID.air;
}

function leafLayerContains(config, cx, cy, cz, x, y, z, radius, density, salt) {
  if (y !== cy) return false;
  const dx = saturatingSubI32(x, cx);
  const dz = saturatingSubI32(z, cz);
  if (Math.abs(dx) > radius || Math.abs(dz) > radius) return false;
  const distance = saturatingAddI32(Math.abs(dx), Math.abs(dz));
  if (distance > radius + 1) return false;
  const corner = Math.abs(dx) === radius && Math.abs(dz) === radius;
  const hashX = saturatingAddI32(cx, saturatingMulI32(dx, 23));
  const hashZ = saturatingAddI32(cz, saturatingMulI32(dz, 29));
  const roll = hashCoord3(worldSeedBytes(config), hashX, cy, hashZ, salt) & 255;
  if (corner && roll < 178) return false;
  return roll <= density;
}

function terrainFactors(config, x, z) {
  const cacheKey = `${x},${z}`;
  const terrainCache = generationCache(config).terrain;
  const cached = terrainCache.get(cacheKey);
  if (cached) return cached;
  const warpX = Math.trunc((valueNoise2(worldSeedBytes(config), x, z, 160, 31) - 128) * 22 / 128);
  const warpZ = Math.trunc((valueNoise2(worldSeedBytes(config), x, z, 160, 32) - 128) * 22 / 128);
  const wx = saturatingAddI32(x, warpX);
  const wz = saturatingAddI32(z, warpZ);
  const continent =
    Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 520, 21) - 128) * 86 / 128) +
    Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 220, 22) - 128) * 42 / 128) +
    Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 96, 23) - 128) * 14 / 128) +
    46;
  const shelf = smoothRangeFixed(continent, -50, 34);
  const inland = smoothRangeFixed(continent, -8, 78);
  const riverWarpX = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 128, 33) - 128) * 36 / 128);
  const riverWarpZ = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 128, 34) - 128) * 36 / 128);
  const riverLine = 128 - Math.abs(valueNoise2(
    worldSeedBytes(config),
    saturatingAddI32(wx, riverWarpX),
    saturatingAddI32(wz, riverWarpZ),
    104,
    35,
  ) - 128);
  const lakeNoise = valueNoise2(worldSeedBytes(config), wx, wz, 220, 37);
  const widthNoise = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 420, 43) * 2 + valueNoise2(worldSeedBytes(config), wx, wz, 96, 44)) / 3);
  const canyonNoise = valueNoise2(worldSeedBytes(config), wx, wz, 340, 47);
  const broadPlain = smoothRangeFixed(valueNoise2(worldSeedBytes(config), wx, wz, 760, 49), 144, 224);
  const riverWidth = Math.min(255, widthNoise + Math.trunc(broadPlain * 64 / 1024));
  const lakeWidth = valueNoise2(worldSeedBytes(config), wx, wz, 520, 45);
  const openRiver = scaleByFixed(smoothRangeFixed(riverWidth, 72, 198), 1024 - smoothRangeFixed(canyonNoise, 190, 252));
  const riverValleyStart = 104 - Math.trunc(riverWidth * 88 / 255);
  const riverTerraceStart = Math.max(0, riverValleyStart - 64 - Math.trunc(riverWidth * 42 / 255));
  const riverFloodplainStart = Math.max(0, riverTerraceStart - 44 - Math.trunc(riverWidth * 32 / 255));
  const riverCoreStart = 122 - Math.trunc(riverWidth * 44 / 255);
  const riverTerrace = scaleByFixed(smoothRangeFixed(riverLine, riverTerraceStart, 128), 220 + Math.trunc(riverWidth * 430 / 255));
  const riverFloodplain = scaleByFixed(smoothRangeFixed(riverLine, riverFloodplainStart, 128), openRiver);
  const river = scaleByFixed(smoothRangeFixed(riverLine, riverCoreStart, 128), inland);
  const riverValley = scaleByFixed(Math.max(smoothRangeFixed(riverLine, riverValleyStart, 128), riverTerrace), inland);
  const lakeCoreStart = 226 - Math.trunc(lakeWidth * 28 / 255);
  const lake = scaleByFixed(smoothRangeFixed(lakeNoise, lakeCoreStart, 242), inland);
  const lakeValleyStart = 194 - Math.trunc(lakeWidth * 74 / 255);
  const lakeTerrace = scaleByFixed(smoothRangeFixed(lakeNoise, Math.max(0, lakeValleyStart - 42), 242), 180 + Math.trunc(lakeWidth * 260 / 255));
  const lakeValley = scaleByFixed(Math.max(smoothRangeFixed(lakeNoise, lakeValleyStart, 242), lakeTerrace), inland);
  const floodplainMask = scaleByFixed(Math.max(riverFloodplain, lakeTerrace), inland);
  const terrain = { wx, wz, continent, shelf, inland, river, lake, riverValley, lakeValley, waterMask: Math.max(river, lake), valleyMask: Math.max(riverValley, lakeValley), floodplainMask, valleySoftness: Math.max(riverWidth, lakeWidth), openRiver };
  cacheSetBounded(terrainCache, cacheKey, terrain);
  return terrain;
}

function inlandWaterLevel(config, wx, wz) {
  const offset = Math.trunc((valueNoise2(worldSeedBytes(config), wx, wz, 180, 41) - 128) / 128);
  return saturatingAddI16(saturatingAddI16(config.seaLevel, 6), offset);
}

function moistureAt(config, x, z) {
  return Math.trunc((valueNoise2(worldSeedBytes(config), x, z, 176, 211) * 3 + valueNoise2(worldSeedBytes(config), x, z, 72, 212)) / 4);
}

function desertScoreAt(config, x, z) {
  return Math.trunc((valueNoise2(worldSeedBytes(config), x, z, 224, 213) * 3 + (255 - moistureAt(config, x, z))) / 4);
}

function volcanicAt(config, x, z) {
  return valueNoise2(worldSeedBytes(config), x, z, 192, 205);
}

function coldAt(config, x, z, surface) {
  const snowLine = snowLineAt(config, x, z);
  return surface >= snowLine || (surface >= saturatingSubI16(snowLine, 7) && valueNoise2(worldSeedBytes(config), x, z, 160, 201) < 28);
}

function snowLineAt(config, x, z) {
  const offset = Math.trunc((valueNoise2(worldSeedBytes(config), x, z, 220, 202) - 128) * 8 / 128);
  return clampInt(config.seaLevel + 58 + offset, I16_MIN, I16_MAX);
}

function treeGrowthProfile(config, x, z, surface, surfaceBlockId = undefined) {
  const top = Number.isFinite(surfaceBlockId) ? Math.trunc(surfaceBlockId) : surfaceBlockAt(config, x, z, surface);
  if (top === BLOCK_ID.sand || top === BLOCK_ID.saltFlat || top === BLOCK_ID.ash || top === BLOCK_ID.basalt) {
    return { cellSize: 14, density: 255, pine: false };
  }
  const moisture = moistureAt(config, x, z);
  const altitude = saturatingSubI16(surface, config.seaLevel);
  const snowLine = snowLineAt(config, x, z);
  const terrain = terrainFactors(config, x, z);
  let cellSize = 9;
  let density = 218;
  if (moisture > 214 && altitude <= 44) {
    cellSize = 6;
    density = 136;
  } else if (moisture > 188 && altitude <= 54) {
    cellSize = 6;
    density = 154;
  } else if (moisture < 116) {
    cellSize = 11;
    density = 226;
  } else if (moisture < 150) {
    cellSize = 9;
    density = 210;
  } else {
    cellSize = 7;
    density = 184;
  }

  if (altitude <= 6) {
    cellSize += 2;
    density += 22;
  } else if (altitude <= 18 && terrain.floodplainMask > 360) {
    cellSize += 1;
    density += 10;
  }
  if (terrain.floodplainMask > 620 && terrain.openRiver > 520) density += 10;
  if (altitude >= 36) {
    cellSize += 1;
    density += 12;
  }
  if (altitude >= 54) {
    cellSize += 1;
    density += 14;
  }
  if (surface >= saturatingSubI16(snowLine, 10)) {
    cellSize += 1;
    density += 12;
  }
  if (surface >= snowLine) {
    cellSize += 1;
    density += 12;
  }
  if (top === BLOCK_ID.stone || top === BLOCK_ID.gravel) {
    cellSize += 1;
    density += 14;
  } else if (top === BLOCK_ID.frozenSoil || top === BLOCK_ID.snow) {
    cellSize += 1;
    density += 8;
  } else if (top === BLOCK_ID.mud || top === BLOCK_ID.clay) {
    density -= 8;
  }

  const patch = valueNoise2(worldSeedBytes(config), x, z, 260, 406);
  if (patch > 204) {
    cellSize -= 1;
    density -= 24;
  } else if (patch < 58) {
    cellSize += 1;
    density += 14;
  }
  cellSize = Math.max(6, Math.min(14, cellSize));
  density = Math.max(128, Math.min(250, density));
  const pine = surface >= saturatingSubI16(snowLine, 18)
    || altitude >= 46
    || (altitude >= 26 && moisture < 168)
    || (hashCoord3(worldSeedBytes(config), x, surface, z, 404) & 255) > 218;
  return { cellSize, density, pine };
}

function oreVeinBlockAt(config, x, y, z, surface) {
  const depth = saturatingSubI16(surface, y);
  if (depth < 10 || y <= saturatingAddI16(config.minY, 4)) return BLOCK_ID.air;
  if (depth > 92 && y < saturatingAddI16(config.minY, 12)) return BLOCK_ID.air;

  const layerY = divFloor(y - config.minY, 6);
  const cellX = divFloor(x, 10);
  const cellZ = divFloor(z, 10);
  const band = hashCoord3(worldSeedBytes(config), cellX, layerY, cellZ, 301) & 255;
  if (band < 214) return BLOCK_ID.air;

  const depthBand = depth >= 18 && depth <= 76 ? 1 : 0;
  if (!depthBand) return BLOCK_ID.air;

  const lens = hashCoord3(
    worldSeedBytes(config),
    saturatingAddI32(x, saturatingMulI32(layerY, 17)),
    y,
    saturatingSubI32(z, saturatingMulI32(layerY, 13)),
    302,
  ) & 255;
  const vein = hashCoord3(
    worldSeedBytes(config),
    divFloor(saturatingAddI32(x, saturatingMulI32(y, 2)), 4),
    layerY,
    divFloor(saturatingSubI32(z, saturatingMulI32(y, 3)), 4),
    303,
  ) & 255;
  if (lens + Math.trunc(vein / 2) < 228) return BLOCK_ID.air;
  return BLOCK_ID.coal;
}

function indexOf(localX, worldY, localZ, config) {
  const y = worldY - config.minY;
  return Math.trunc(localX) + config.chunkSize * (y + config.height * Math.trunc(localZ));
}

function createGenerationCache() {
  return {
    surface: new Map(),
    terrain: new Map(),
    water: new Map(),
  };
}

function generationCache(config) {
  let cache = configGenerationCaches.get(config);
  if (!cache) {
    cache = createGenerationCache();
    configGenerationCaches.set(config, cache);
  }
  return cache;
}

function cacheSetBounded(cache, key, value) {
  if (!cache) return;
  if (cache.size > generatorCacheLimit) cache.clear();
  cache.set(key, value);
}

function terrainSurfaceCeiling(config) {
  // Generation v5 normally leaves one block of headroom. A one-layer world
  // cannot do that, so its bedrock layer is also its valid terrain surface.
  const buildSurfaceCeiling = config.maxBuildY > config.minY
    ? saturatingSubI16(config.maxBuildY, 1)
    : config.maxBuildY;
  return Math.max(
    config.minY,
    Math.min(config.maxTerrainHeight, buildSurfaceCeiling),
  );
}

function containsVerticalBuildCoordinate(config, worldY) {
  return worldY >= config.minY && worldY <= config.maxBuildY;
}

function worldSeedBytes(config) {
  const cached = configWorldSeeds.get(config);
  if (cached) return cached;
  const normalized = normalizeSeedBytes(config?.worldSeed);
  configWorldSeeds.set(config, normalized);
  return normalized;
}

function bytesToHex(bytes) {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function assertChunkCoordinates(config, chunkX, chunkZ) {
  const size = config.chunkSize;
  const minimum = Math.floor(WORLD_GENERATOR_LIMITS.minHorizontalCoordinate / size);
  const maximum = Math.floor(WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate / size);
  return {
    chunkX: protocolInteger(chunkX, minimum, maximum, "chunk X"),
    chunkZ: protocolInteger(chunkZ, minimum, maximum, "chunk Z"),
  };
}

export function chunkLocalToWorldI32(chunkCoordinate, localCoordinate, chunkSize) {
  // Supported chunk coordinates and sizes keep this affine result inside the
  // exact-integer range of Number. Clamp only the completed coordinate so a
  // world endpoint decomposed by normalizeDelta() reconstructs to itself for
  // non-canonical development chunk sizes.
  return clampInt(
    chunkCoordinate * chunkSize + localCoordinate,
    I32_MIN,
    I32_MAX,
  );
}

function protocolHorizontalCoordinate(value, label) {
  return protocolInteger(
    value,
    WORLD_GENERATOR_LIMITS.minHorizontalCoordinate,
    WORLD_GENERATOR_LIMITS.maxHorizontalCoordinate,
    label,
  );
}

function protocolInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function assertSupportedVersion(value, supportedVersions, label) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || !supportedVersions.includes(version)) {
    throw new RangeError(
      `Unsupported ${label} version ${String(value)}. Supported versions: ${supportedVersions.join(", ")}.`,
    );
  }
  return version;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function divFloor(value, divisor) {
  return Math.floor(Math.trunc(value) / Math.trunc(divisor));
}

export function isGeneratedFluidBlock(blockId) {
  return isFluidBlock(blockId);
}
