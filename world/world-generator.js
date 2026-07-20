import {
  DEFAULT_CHUNK_HEIGHT,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_TERRAIN_HEIGHT,
  DEFAULT_MIN_WORLD_Y,
  DEFAULT_SEA_LEVEL,
} from "../core/constants.js";
import { normalizeSeedBytes, hashCoord3, valueNoise2, smoothRangeFixed, lerpIntFixed, scaleByFixed } from "../core/hash.js";
import { chunkToWorld } from "../core/coordinates.js";
import { BLOCK_ID, isFluidBlock } from "./block-registry.js";

export const MAINNET_WORLD_SEED = "nicechunk-mainnet-001";
export const DEFAULT_GENERATION_VERSION = 5;
export const DEFAULT_RESOURCE_RULE_VERSION = 1;

const generatorCacheLimit = 180000;

export function createWorldGeneratorConfig(options = {}) {
  const minY = finiteInt(options.minY, DEFAULT_MIN_WORLD_Y);
  const height = finiteInt(options.height, DEFAULT_CHUNK_HEIGHT);
  const maxBuildY = finiteInt(options.maxBuildY, minY + height - 1);
  const worldSeedText = options.worldSeedHex ?? options.worldSeed ?? MAINNET_WORLD_SEED;
  return {
    worldSeed: normalizeSeedBytes(worldSeedText),
    worldSeedHex: String(worldSeedText),
    chunkSize: finiteInt(options.chunkSize, DEFAULT_CHUNK_SIZE),
    height,
    minY,
    maxBuildY,
    seaLevel: finiteInt(options.seaLevel, DEFAULT_SEA_LEVEL),
    maxTerrainHeight: finiteInt(options.maxTerrainHeight, DEFAULT_MAX_TERRAIN_HEIGHT),
    generationVersion: finiteInt(options.generationVersion, DEFAULT_GENERATION_VERSION),
    resourceRuleVersion: finiteInt(options.resourceRuleVersion, DEFAULT_RESOURCE_RULE_VERSION),
    cache: createGenerationCache(),
  };
}

export function generateBaseChunk(worldSeed, chunkX, chunkZ, generationVersion = DEFAULT_GENERATION_VERSION, options = {}) {
  const config = createWorldGeneratorConfig({ ...options, worldSeed, generationVersion });
  const blocks = new Uint16Array(config.chunkSize * config.height * config.chunkSize);
  const minWorldX = Math.trunc(chunkX) * config.chunkSize;
  const minWorldZ = Math.trunc(chunkZ) * config.chunkSize;
  const maxWorldX = minWorldX + config.chunkSize - 1;
  const maxWorldZ = minWorldZ + config.chunkSize - 1;

  for (let localZ = 0; localZ < config.chunkSize; localZ += 1) {
    for (let localX = 0; localX < config.chunkSize; localX += 1) {
      const { worldX, worldZ } = chunkToWorld(chunkX, chunkZ, localX, 0, localZ, config.chunkSize);
      const surface = terrainSurfaceHeight(config, worldX, worldZ);
      const water = waterLevelAt(config, worldX, worldZ, surface);
      const topFillY = Math.min(config.minY + config.height - 1, Math.max(surface, water ?? surface));
      for (let y = config.minY; y <= topFillY; y += 1) {
        const blockId = generatedTerrainOrFluidAt(config, worldX, y, worldZ, surface, water);
        if (blockId !== BLOCK_ID.air) blocks[indexOf(localX, y, localZ, config)] = blockId;
      }

    }
  }

  return blocks;
}

export function generateBaseChunkProfile(worldSeed, chunkX, chunkZ, generationVersion = DEFAULT_GENERATION_VERSION, options = {}) {
  const config = createWorldGeneratorConfig({ ...options, worldSeed, generationVersion });
  return generateBaseChunkProfileFromConfig(config, chunkX, chunkZ);
}

export function generateBaseChunkProfileFromConfig(config, chunkX, chunkZ, { cacheTreeCandidates = false } = {}) {
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
      const { worldX, worldZ } = chunkToWorld(chunkX, chunkZ, localX, 0, localZ, size);
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
    chunkX: Math.trunc(chunkX),
    chunkZ: Math.trunc(chunkZ),
    chunkSize: size,
    minY: config.minY,
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

export function generateTreeInstancesForChunk(worldSeed, chunkX, chunkZ, generationVersion = DEFAULT_GENERATION_VERSION, options = {}) {
  const config = createWorldGeneratorConfig({ ...options, worldSeed, generationVersion });
  return generateTreeInstancesForChunkFromConfig(config, chunkX, chunkZ);
}

export function generateTreeInstancesForChunkFromConfig(config, chunkX, chunkZ, baseProfile = null) {
  const minWorldX = Math.trunc(chunkX) * config.chunkSize;
  const minWorldZ = Math.trunc(chunkZ) * config.chunkSize;
  const maxWorldX = minWorldX + config.chunkSize - 1;
  const maxWorldZ = minWorldZ + config.chunkSize - 1;
  const out = [];
  const treeCandidates = baseProfile?.treeCandidates;
  const hasTreeCandidates = Array.isArray(treeCandidates) && treeCandidates.length >= config.chunkSize * config.chunkSize;
  for (let z = minWorldZ; z <= maxWorldZ; z += 1) {
    for (let x = minWorldX; x <= maxWorldX; x += 1) {
      const localX = x - minWorldX;
      const localZ = z - minWorldZ;
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
        variantSeed: hashCoord3(config.worldSeed, x, tree.baseY, z, 751) >>> 0,
      };
      const leafProfile = treeInstanceLeafProfile(config, instance);
      instance.leafMinY = leafProfile.minY;
      instance.leafMasks = leafProfile.masks;
      out.push(instance);
    }
  }
  return out;
}

export function getBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion = DEFAULT_GENERATION_VERSION, options = {}) {
  const config = createWorldGeneratorConfig({ ...options, worldSeed, generationVersion: ruleVersion });
  const x = Math.trunc(worldX);
  const y = Math.trunc(worldY);
  const z = Math.trunc(worldZ);
  return blockAtConfig(config, x, y, z);
}

export function getBaseBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion = DEFAULT_GENERATION_VERSION, options = {}) {
  const config = createWorldGeneratorConfig({ ...options, worldSeed, generationVersion: ruleVersion });
  return getBaseBlockAtConfig(config, worldX, worldY, worldZ);
}

export function getBaseBlockAtConfig(config, worldX, worldY, worldZ) {
  const x = Math.trunc(worldX);
  const y = Math.trunc(worldY);
  const z = Math.trunc(worldZ);
  const surface = terrainSurfaceHeight(config, x, z);
  return generatedTerrainOrFluidAt(config, x, y, z, surface, waterLevelAt(config, x, z, surface));
}

export function getBaseBlockAtColumnConfig(config, worldX, worldY, worldZ, surfaceY, waterY = undefined, surfaceBlockId = undefined) {
  const x = Math.trunc(worldX);
  const y = Math.trunc(worldY);
  const z = Math.trunc(worldZ);
  const surface = Number.isFinite(surfaceY) ? Math.trunc(surfaceY) : terrainSurfaceHeight(config, x, z);
  const water = waterY === undefined
    ? waterLevelAt(config, x, z, surface)
    : Number.isFinite(waterY) ? Math.trunc(waterY) : null;
  return generatedTerrainOrFluidAt(config, x, y, z, surface, water, surfaceBlockId);
}

export function getGeneratedTreeBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion = DEFAULT_GENERATION_VERSION, options = {}) {
  const config = createWorldGeneratorConfig({ ...options, worldSeed, generationVersion: ruleVersion });
  return treeBlockAt(config, Math.trunc(worldX), Math.trunc(worldY), Math.trunc(worldZ));
}

export function treeInstanceBlockAt(config, tree, worldX, worldY, worldZ) {
  if (!tree) return BLOCK_ID.air;
  return treeVolumeBlock(config, tree, Math.trunc(worldX), Math.trunc(worldY), Math.trunc(worldZ));
}

export function treeInstanceLeafProfile(configOrSeed, tree) {
  if (!tree) return { minY: 0, masks: [] };
  const worldSeed = configOrSeed?.worldSeed instanceof Uint8Array
    ? configOrSeed.worldSeed
    : normalizeSeedBytes(configOrSeed?.worldSeed ?? configOrSeed);
  const top = Math.trunc(Number(tree.baseY) + Number(tree.trunkHeight));
  const minY = tree.pine ? top - 4 : top - 2;
  const maxY = top + 1;
  const leafBlockId = tree.pine ? BLOCK_ID.pineLeaves : BLOCK_ID.leaves;
  const masks = new Array(maxY - minY + 1).fill(0);
  const config = { worldSeed };
  for (let y = minY; y <= maxY; y += 1) {
    let mask = 0;
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        if (treeVolumeBlock(config, tree, tree.x + dx, y, tree.z + dz) !== leafBlockId) continue;
        mask |= 1 << ((dz + 2) * 5 + dx + 2);
      }
    }
    masks[y - minY] = mask >>> 0;
  }
  return { minY, masks };
}

export function getGeneratedTreeTrunkBlockAt(worldSeed, worldX, worldY, worldZ, ruleVersion = DEFAULT_GENERATION_VERSION, options = {}) {
  const config = createWorldGeneratorConfig({ ...options, worldSeed, generationVersion: ruleVersion });
  const x = Math.trunc(worldX);
  const y = Math.trunc(worldY);
  const z = Math.trunc(worldZ);
  const surface = terrainSurfaceHeight(config, x, z);
  if (!canGrowTree(config, x, z, surface)) return BLOCK_ID.air;
  return treeInstanceTrunkBlockAt(config, treeAt(config, x, z, surface), x, y, z);
}

export function treeInstanceTrunkBlockAt(config, tree, worldX, worldY, worldZ) {
  if (!tree) return BLOCK_ID.air;
  const x = Math.trunc(worldX);
  const y = Math.trunc(worldY);
  const z = Math.trunc(worldZ);
  const top = tree.baseY + tree.trunkHeight;
  if (x === tree.x && z === tree.z && y >= tree.baseY && y < top) return tree.pine ? BLOCK_ID.pineTrunk : BLOCK_ID.trunk;
  return BLOCK_ID.air;
}

export function terrainProfile(configOrSeed, worldX, worldZ, options = {}) {
  const config = configOrSeed?.worldSeed instanceof Uint8Array ? configOrSeed : createWorldGeneratorConfig({ ...options, worldSeed: configOrSeed });
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
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
  const cached = config.cache?.surface?.get(cacheKey);
  if (cached !== undefined) return cached;

  const maxSurface = Math.max(config.minY + 8, Math.min(config.maxTerrainHeight, config.maxBuildY - 1));
  const desiredMinSurface = Math.max(config.minY + 8, config.seaLevel - 28);
  const minSurface = Math.min(desiredMinSurface, maxSurface);
  const terrain = terrainFactors(config, x, z);
  const { wx, wz, shelf, inland, waterMask, valleyMask, floodplainMask, lake, valleySoftness, openRiver } = terrain;

  const ocean =
    config.seaLevel - 16 +
    Math.trunc((valueNoise2(config.worldSeed, wx, wz, 96, 24) - 128) * 5 / 128) +
    Math.trunc((valueNoise2(config.worldSeed, wx, wz, 36, 25) - 128) * 2 / 128);
  const coast = config.seaLevel - 3 + Math.trunc(shelf * 8 / 1024);
  const plains = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 120, 26) - 128) * 4 / 128);
  const hills = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 56, 27) - 128) * 7 / 128);
  const rolling = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 28, 28) - 128) * 2 / 128);
  const roughness = smoothRangeFixed(Math.abs(valueNoise2(config.worldSeed, wx, wz, 180, 40) - 128), 54, 122);
  const mountainRange = scaleByFixed(smoothRangeFixed(valueNoise2(config.worldSeed, wx, wz, 360, 30), 136, 226), inland);
  const highland = scaleByFixed(34, scaleByFixed(smoothRangeFixed(valueNoise2(config.worldSeed, wx, wz, 620, 46), 116, 206), inland));
  const ridgeLine = 128 - Math.abs(valueNoise2(config.worldSeed, wx, wz, 92, 29) - 128);
  const ridgeLift = smoothRangeFixed(ridgeLine, 44, 126);
  const peakMask = scaleByFixed(smoothRangeFixed(valueNoise2(config.worldSeed, wx, wz, 176, 47), 176, 242), mountainRange);
  const crag = scaleByFixed(smoothRangeFixed(Math.abs(valueNoise2(config.worldSeed, wx, wz, 52, 48) - 128), 48, 126), mountainRange);
  const mountain = highland + scaleByFixed(24 + scaleByFixed(72, ridgeLift) + scaleByFixed(24, crag), mountainRange) + scaleByFixed(34, peakMask);

  const land = config.seaLevel + 7 + Math.trunc(inland * 8 / 1024) + scaleByFixed(plains + scaleByFixed(hills + rolling, roughness), inland) + mountain;
  let shapedLand = Math.max(coast, land);
  if (floodplainMask > 0) {
    const flatNoise = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 54, 38) - 128) / 128);
    const floodplainLift = 2 + Math.trunc((1024 - openRiver) * 2 / 1024);
    const floodplainFloor = config.seaLevel + floodplainLift + flatNoise;
    const floodplainBlend = Math.min(1024, Math.trunc(floodplainMask * (720 + Math.trunc(openRiver * 420 / 1024)) / 1024));
    shapedLand = lerpIntFixed(shapedLand, Math.min(shapedLand, floodplainFloor), floodplainBlend);
  }
  if (valleyMask > 0) {
    const bedNoise = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 32, 39) - 128) * 2 / 128);
    const slopeNoise = valueNoise2(config.worldSeed, wx, wz, 150, 42);
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
  cacheSetBounded(config.cache?.surface, cacheKey, height);
  return height;
}

export function waterLevelAt(config, worldX, worldZ, surface = terrainSurfaceHeight(config, worldX, worldZ)) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  const cacheKey = `${x},${z},${surface}`;
  const cached = config.cache?.water?.get(cacheKey);
  if (cached !== undefined) return cached;
  let waterLevel = null;
  if (surface < config.seaLevel) {
    waterLevel = config.seaLevel;
  }
  cacheSetBounded(config.cache?.water, cacheKey, waterLevel);
  return waterLevel;
}

export function surfaceBlockAt(config, worldX, worldZ, surface = terrainSurfaceHeight(config, worldX, worldZ)) {
  const x = Math.trunc(worldX);
  const z = Math.trunc(worldZ);
  const water = waterLevelAt(config, x, z, surface);
  const underwater = water !== null && surface < water;
  const moisture = moistureAt(config, x, z);
  const desert = desertScoreAt(config, x, z);
  const gravelPatch = valueNoise2(config.worldSeed, x, z, 44, 103);
  const clayPatch = valueNoise2(config.worldSeed, x, z, 52, 104);

  if (underwater || surface <= config.seaLevel + 1) {
    if (moisture > 190 && clayPatch > 148) return BLOCK_ID.clay;
    if (gravelPatch > 218) return BLOCK_ID.gravel;
    if (valueNoise2(config.worldSeed, x, z, 96, 105) > 236) return BLOCK_ID.shellBed;
    return BLOCK_ID.sand;
  }
  if (volcanicAt(config, x, z) > 246) return valueNoise2(config.worldSeed, x, z, 64, 106) > 180 ? BLOCK_ID.basalt : BLOCK_ID.ash;
  if (coldAt(config, x, z, surface)) return surface > config.seaLevel + 34 || valueNoise2(config.worldSeed, x, z, 72, 107) > 164 ? BLOCK_ID.snow : BLOCK_ID.frozenSoil;
  if (desert > 178) {
    if (desert > 226 && valueNoise2(config.worldSeed, x, z, 88, 108) > 188) return BLOCK_ID.saltFlat;
    return desert > 204 ? BLOCK_ID.sand : BLOCK_ID.dryDirt;
  }
  if (moisture > 188) {
    return moisture > 208 ? BLOCK_ID.mud : BLOCK_ID.grass;
  }
  if (surface >= config.seaLevel + 36) return BLOCK_ID.stone;
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
  const originX = cellX * cellSize;
  const originZ = cellZ * cellSize;
  const inner = Math.max(1, cellSize - 2);
  const treeX = originX + 1 + (hashCoord3(config.worldSeed, cellX, 0, cellZ, 401) % inner);
  const treeZ = originZ + 1 + (hashCoord3(config.worldSeed, cellX, 0, cellZ, 402) % inner);
  const roll = hashCoord3(config.worldSeed, cellX, 0, cellZ, 403) & 255;
  const exists = x === treeX && z === treeZ && roll > density;
  const snowy = surface >= snowLineAt(config, x, z);
  const pine = growth.pine;
  const trunkHeight = (pine ? 5 : 4) + (hashCoord3(config.worldSeed, x, surface, z, 405) % 3);
  return { exists, x, z, baseY: surface + 1, trunkHeight, pine, snowy: pine && snowy };
}

function blockAtConfig(config, x, y, z) {
  if (y <= config.minY) return BLOCK_ID.bedrock;
  if (y > config.maxBuildY) return BLOCK_ID.air;
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
  if (y < config.minY || y >= config.minY + config.height) return BLOCK_ID.air;
  if (y > surface) return water !== null && y <= water ? BLOCK_ID.water : BLOCK_ID.air;
  if (y <= config.minY) return BLOCK_ID.bedrock;
  const depth = surface - y;
  if (depth <= 0) return Number.isFinite(surfaceBlockId) ? Math.trunc(surfaceBlockId) : surfaceBlockAt(config, x, z, surface);
  if (depth <= 3) return subsurfaceBlockAt(config, x, z, surface, surfaceBlockId);
  const oreBlock = oreVeinBlockAt(config, x, y, z, surface);
  if (oreBlock !== BLOCK_ID.air) return oreBlock;
  if (y <= config.minY + 40 || depth >= 52) return BLOCK_ID.deepStone;
  if (volcanicAt(config, x, z) > 238 && hashCoord3(config.worldSeed, x, y, z, 601) > 210) return BLOCK_ID.basalt;
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
      return hashCoord3(config.worldSeed, x, surface - 1, z, 121) > 112 ? BLOCK_ID.clay : BLOCK_ID.mud;
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
  if (surface <= config.seaLevel + 1) return false;
  const water = waterLevelAt(config, x, z, surface);
  if (water !== null && surface < water) return false;
  if (desertScoreAt(config, x, z) > 178 || volcanicAt(config, x, z) > 236) return false;
  return true;
}

function treeBlockAt(config, x, y, z) {
  for (let cz = z - 2; cz <= z + 2; cz += 1) {
    for (let cx = x - 2; cx <= x + 2; cx += 1) {
      const surface = terrainSurfaceHeight(config, cx, cz);
      if (!canGrowTree(config, cx, cz, surface)) continue;
      const tree = treeAt(config, cx, cz, surface);
      if (!tree.exists) continue;
      const block = treeVolumeBlock(config, tree, x, y, z);
      if (block !== BLOCK_ID.air) return block;
    }
  }
  return BLOCK_ID.air;
}

function treeVolumeBlock(config, tree, x, y, z) {
  const top = tree.baseY + tree.trunkHeight;
  if (x === tree.x && z === tree.z && y >= tree.baseY && y < top) return tree.pine ? BLOCK_ID.pineTrunk : BLOCK_ID.trunk;
  if (tree.pine) {
    if (leafLayerContains(config, tree.x, top - 4, tree.z, x, y, z, 2, 158, 501)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, top - 3, tree.z, x, y, z, 2, 188, 502)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, top - 2, tree.z, x, y, z, 1, 218, 503)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, top - 1, tree.z, x, y, z, 1, 184, 504)) return BLOCK_ID.pineLeaves;
    if (leafLayerContains(config, tree.x, top, tree.z, x, y, z, 1, 138, 505)) return BLOCK_ID.pineLeaves;
    if (x === tree.x && y === top + 1 && z === tree.z) return BLOCK_ID.pineLeaves;
    return BLOCK_ID.air;
  }
  if (leafLayerContains(config, tree.x, top - 2, tree.z, x, y, z, 2, 174, 511)) return BLOCK_ID.leaves;
  if (leafLayerContains(config, tree.x, top - 1, tree.z, x, y, z, 2, 214, 512)) return BLOCK_ID.leaves;
  if (leafLayerContains(config, tree.x, top, tree.z, x, y, z, 2, 148, 513)) return BLOCK_ID.leaves;
  if (leafLayerContains(config, tree.x, top + 1, tree.z, x, y, z, 1, 194, 514)) return BLOCK_ID.leaves;
  return BLOCK_ID.air;
}

function leafLayerContains(config, cx, cy, cz, x, y, z, radius, density, salt) {
  if (y !== cy) return false;
  const dx = x - cx;
  const dz = z - cz;
  if (Math.abs(dx) > radius || Math.abs(dz) > radius) return false;
  const distance = Math.abs(dx) + Math.abs(dz);
  if (distance > radius + 1) return false;
  const corner = Math.abs(dx) === radius && Math.abs(dz) === radius;
  const roll = hashCoord3(config.worldSeed, cx + dx * 23, cy, cz + dz * 29, salt) & 255;
  if (corner && roll < 178) return false;
  return roll <= density;
}

function terrainFactors(config, x, z) {
  const cacheKey = `${x},${z}`;
  const cached = config.cache?.terrain?.get(cacheKey);
  if (cached) return cached;
  const warpX = Math.trunc((valueNoise2(config.worldSeed, x, z, 160, 31) - 128) * 22 / 128);
  const warpZ = Math.trunc((valueNoise2(config.worldSeed, x, z, 160, 32) - 128) * 22 / 128);
  const wx = x + warpX;
  const wz = z + warpZ;
  const continent =
    Math.trunc((valueNoise2(config.worldSeed, wx, wz, 520, 21) - 128) * 86 / 128) +
    Math.trunc((valueNoise2(config.worldSeed, wx, wz, 220, 22) - 128) * 42 / 128) +
    Math.trunc((valueNoise2(config.worldSeed, wx, wz, 96, 23) - 128) * 14 / 128) +
    46;
  const shelf = smoothRangeFixed(continent, -50, 34);
  const inland = smoothRangeFixed(continent, -8, 78);
  const riverWarpX = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 128, 33) - 128) * 36 / 128);
  const riverWarpZ = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 128, 34) - 128) * 36 / 128);
  const riverLine = 128 - Math.abs(valueNoise2(config.worldSeed, wx + riverWarpX, wz + riverWarpZ, 104, 35) - 128);
  const lakeNoise = valueNoise2(config.worldSeed, wx, wz, 220, 37);
  const widthNoise = Math.trunc((valueNoise2(config.worldSeed, wx, wz, 420, 43) * 2 + valueNoise2(config.worldSeed, wx, wz, 96, 44)) / 3);
  const canyonNoise = valueNoise2(config.worldSeed, wx, wz, 340, 47);
  const broadPlain = smoothRangeFixed(valueNoise2(config.worldSeed, wx, wz, 760, 49), 144, 224);
  const riverWidth = Math.min(255, widthNoise + Math.trunc(broadPlain * 64 / 1024));
  const lakeWidth = valueNoise2(config.worldSeed, wx, wz, 520, 45);
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
  cacheSetBounded(config.cache?.terrain, cacheKey, terrain);
  return terrain;
}

function inlandWaterLevel(config, wx, wz) {
  return config.seaLevel + 6 + Math.trunc((valueNoise2(config.worldSeed, wx, wz, 180, 41) - 128) / 128);
}

function moistureAt(config, x, z) {
  return Math.trunc((valueNoise2(config.worldSeed, x, z, 176, 211) * 3 + valueNoise2(config.worldSeed, x, z, 72, 212)) / 4);
}

function desertScoreAt(config, x, z) {
  return Math.trunc((valueNoise2(config.worldSeed, x, z, 224, 213) * 3 + (255 - moistureAt(config, x, z))) / 4);
}

function volcanicAt(config, x, z) {
  return valueNoise2(config.worldSeed, x, z, 192, 205);
}

function coldAt(config, x, z, surface) {
  const snowLine = snowLineAt(config, x, z);
  return surface >= snowLine || (surface >= snowLine - 7 && valueNoise2(config.worldSeed, x, z, 160, 201) < 28);
}

function snowLineAt(config, x, z) {
  return config.seaLevel + 58 + Math.trunc((valueNoise2(config.worldSeed, x, z, 220, 202) - 128) * 8 / 128);
}

function treeGrowthProfile(config, x, z, surface, surfaceBlockId = undefined) {
  const top = Number.isFinite(surfaceBlockId) ? Math.trunc(surfaceBlockId) : surfaceBlockAt(config, x, z, surface);
  if (top === BLOCK_ID.sand || top === BLOCK_ID.saltFlat || top === BLOCK_ID.ash || top === BLOCK_ID.basalt) {
    return { cellSize: 14, density: 255, pine: false };
  }
  const moisture = moistureAt(config, x, z);
  const altitude = surface - config.seaLevel;
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
  if (surface >= snowLine - 10) {
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

  const patch = valueNoise2(config.worldSeed, x, z, 260, 406);
  if (patch > 204) {
    cellSize -= 1;
    density -= 24;
  } else if (patch < 58) {
    cellSize += 1;
    density += 14;
  }
  cellSize = Math.max(6, Math.min(14, cellSize));
  density = Math.max(128, Math.min(250, density));
  const pine = surface >= snowLine - 18
    || altitude >= 46
    || (altitude >= 26 && moisture < 168)
    || (hashCoord3(config.worldSeed, x, surface, z, 404) & 255) > 218;
  return { cellSize, density, pine };
}

function oreVeinBlockAt(config, x, y, z, surface) {
  const depth = surface - y;
  if (depth < 10 || y <= config.minY + 4) return BLOCK_ID.air;
  if (depth > 92 && y < config.minY + 12) return BLOCK_ID.air;

  const layerY = divFloor(y - config.minY, 6);
  const cellX = divFloor(x, 10);
  const cellZ = divFloor(z, 10);
  const band = hashCoord3(config.worldSeed, cellX, layerY, cellZ, 301) & 255;
  if (band < 214) return BLOCK_ID.air;

  const depthBand = depth >= 18 && depth <= 76 ? 1 : 0;
  if (!depthBand) return BLOCK_ID.air;

  const lens = hashCoord3(config.worldSeed, x + layerY * 17, y, z - layerY * 13, 302) & 255;
  const vein = hashCoord3(config.worldSeed, divFloor(x + y * 2, 4), layerY, divFloor(z - y * 3, 4), 303) & 255;
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

function cacheSetBounded(cache, key, value) {
  if (!cache) return;
  if (cache.size > generatorCacheLimit) cache.clear();
  cache.set(key, value);
}

function finiteInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
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
