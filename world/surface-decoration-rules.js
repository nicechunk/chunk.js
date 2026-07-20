import { hashCoord3, normalizeSeedBytes } from "../core/hash.js";
import { BLOCK_ID } from "./block-registry.js";

export const SURFACE_DECORATION_ROLL_DENOMINATOR = 10_000;
export const SURFACE_DECORATION_RULE_MAX_COUNT = 128;

export const SURFACE_DECORATION_FLAGS = Object.freeze({
  SHADOW: 1 << 0,
  MINEABLE: 1 << 1,
  SNOW_CAPPED: 1 << 2,
});

export const SURFACE_DECORATION_ID = Object.freeze({
  flowerClump: 1,
  flowerSprig: 2,
  grassSprout: 3,
  grassTuft: 4,
  mushroom: 5,
  mossPatch: 6,
  swampGrass: 7,
  microCactus: 8,
  dryShrub: 9,
  dryGrass: 10,
  lichenPatch: 11,
  cotton: 12,
  flowerWhite: 13,
  flowerYellow: 14,
  flowerRed: 15,
  flowerBlue: 16,
  flowerPink: 17,
  pebbleGray: 100,
  pebblePale: 101,
  pebbleSnow: 102,
  pebbleSand: 103,
  pebbleDark: 104,
  pebbleWarm: 105,
  pebbleMossy: 106,
  pebbleSalt: 107,
});

const SURFACE_DECORATION_NAMES = Object.freeze({
  [SURFACE_DECORATION_ID.flowerClump]: "Flower Clump",
  [SURFACE_DECORATION_ID.flowerSprig]: "Flower Sprig",
  [SURFACE_DECORATION_ID.grassSprout]: "Grass Sprout",
  [SURFACE_DECORATION_ID.grassTuft]: "Grass Tuft",
  [SURFACE_DECORATION_ID.mushroom]: "Mushroom",
  [SURFACE_DECORATION_ID.mossPatch]: "Moss Patch",
  [SURFACE_DECORATION_ID.swampGrass]: "Swamp Grass",
  [SURFACE_DECORATION_ID.microCactus]: "Cactus",
  [SURFACE_DECORATION_ID.dryShrub]: "Dry Shrub",
  [SURFACE_DECORATION_ID.dryGrass]: "Dry Grass",
  [SURFACE_DECORATION_ID.lichenPatch]: "Lichen Patch",
  [SURFACE_DECORATION_ID.cotton]: "Cotton Plant",
  [SURFACE_DECORATION_ID.flowerWhite]: "White Flower",
  [SURFACE_DECORATION_ID.flowerYellow]: "Yellow Flower",
  [SURFACE_DECORATION_ID.flowerRed]: "Red Flower",
  [SURFACE_DECORATION_ID.flowerBlue]: "Blue Flower",
  [SURFACE_DECORATION_ID.flowerPink]: "Pink Flower",
  [SURFACE_DECORATION_ID.pebbleGray]: "Gray Pebbles",
  [SURFACE_DECORATION_ID.pebblePale]: "Pale Pebbles",
  [SURFACE_DECORATION_ID.pebbleSnow]: "Snowy Pebbles",
  [SURFACE_DECORATION_ID.pebbleSand]: "Sand Pebbles",
  [SURFACE_DECORATION_ID.pebbleDark]: "Dark Pebbles",
  [SURFACE_DECORATION_ID.pebbleWarm]: "Warm Pebbles",
  [SURFACE_DECORATION_ID.pebbleMossy]: "Mossy Pebbles",
  [SURFACE_DECORATION_ID.pebbleSalt]: "Salt Pebbles",
});

const COMMON_FLAGS = SURFACE_DECORATION_FLAGS.SHADOW | SURFACE_DECORATION_FLAGS.MINEABLE;

// Rules use disjoint basis-point bands per surface and salt. A coordinate can
// therefore resolve one decoration with one hash and no per-model branching.
export const DEFAULT_SURFACE_DECORATION_RULES = Object.freeze([
  rule(1, "flowerClump", "grass", "grassPlant", 0, 70, 201),
  rule(2, "flowerSprig", "grass", "grassPlant", 70, 170, 201),
  rule(3, "grassSprout", "grass", "grassPlant", 170, 210, 201),
  rule(4, "grassTuft", "grass", "grassPlant", 210, 370, 201),
  rule(5, "pebbleGray", "grass", "gravel", 370, 425, 201),

  rule(10, "pebbleWarm", "dirt", "gravel", 0, 90, 202),
  rule(11, "lichenPatch", "stone", "lichen", 0, 165, 203),
  rule(12, "pebblePale", "stone", "stone", 165, 360, 203),
  rule(13, "pebbleDark", "deepStone", "stone", 0, 220, 204),

  rule(20, "microCactus", "sand", "cactus", 0, 24, 205),
  rule(21, "pebbleSand", "sand", "stone", 24, 46, 205),
  rule(22, "lichenPatch", "gravel", "lichen", 0, 120, 206),
  rule(23, "pebbleGray", "gravel", "gravel", 120, 420, 206),

  rule(30, "mushroom", "clay", "mushroom", 0, 35, 207),
  rule(31, "mossPatch", "clay", "lichen", 35, 130, 207),
  rule(32, "pebbleWarm", "clay", "stone", 130, 250, 207),
  rule(33, "mushroom", "mud", "mushroom", 0, 50, 208),
  rule(34, "mossPatch", "mud", "lichen", 50, 220, 208),
  rule(35, "swampGrass", "mud", "swampGrass", 220, 400, 208),
  rule(36, "pebbleDark", "mud", "stone", 400, 450, 208),

  rule(40, "dryShrub", "dryDirt", "deadBush", 0, 90, 209),
  rule(41, "dryGrass", "dryDirt", "dryGrass", 90, 250, 209),
  rule(42, "pebbleWarm", "dryDirt", "stone", 250, 340, 209),
  rule(43, "pebbleSalt", "saltFlat", "stone", 0, 100, 210),

  rule(50, "lichenPatch", "snow", "lichen", 0, 200, 211),
  rule(51, "pebbleSnow", "snow", "stone", 200, 360, 211, 0, COMMON_FLAGS | SURFACE_DECORATION_FLAGS.SNOW_CAPPED),
  rule(52, "lichenPatch", "frozenSoil", "lichen", 0, 170, 213),
  rule(53, "pebbleSnow", "frozenSoil", "stone", 170, 350, 213, 1, COMMON_FLAGS | SURFACE_DECORATION_FLAGS.SNOW_CAPPED),

  rule(60, "lichenPatch", "basalt", "lichen", 0, 120, 214),
  rule(61, "pebbleDark", "basalt", "basalt", 120, 350, 214),
  rule(62, "dryShrub", "ash", "deadBush", 0, 80, 215),
  rule(63, "dryGrass", "ash", "dryGrass", 80, 210, 215),
  rule(64, "pebbleDark", "ash", "basalt", 210, 340, 215),

  rule(70, "pebbleSand", "quicksand", "stone", 0, 15, 221),
  rule(71, "mossPatch", "moss", "lichen", 0, 180, 237),
  rule(72, "pebbleMossy", "moss", "stone", 180, 260, 237),
  rule(73, "pebblePale", "shellBed", "stone", 0, 45, 246),

  // Keep every deployed fixture rule in its original array position. These
  // additions consume only the previously unused grass roll band for salt 201.
  rule(74, "cotton", "grass", "cotton", 425, 455, 201),
  rule(75, "flowerWhite", "grass", "flowerWhite", 455, 475, 201),
  rule(76, "flowerYellow", "grass", "flowerYellow", 475, 495, 201),
  rule(77, "flowerRed", "grass", "flowerRed", 495, 515, 201),
  rule(78, "flowerBlue", "grass", "flowerBlue", 515, 535, 201),
  rule(79, "flowerPink", "grass", "flowerPink", 535, 555, 201),
]);

export const EMPTY_COMPILED_SURFACE_DECORATION_RULES = Object.freeze({
  rules: Object.freeze([]),
  bySurface: new Map(),
});
export const DEFAULT_COMPILED_SURFACE_DECORATION_RULES = compileSurfaceDecorationRules(DEFAULT_SURFACE_DECORATION_RULES);

export function compileSurfaceDecorationRules(rules = []) {
  if (Array.isArray(rules) && rules.length === 0) return EMPTY_COMPILED_SURFACE_DECORATION_RULES;
  const normalized = normalizeSurfaceDecorationRules(rules);
  const bySurface = new Map();
  for (const entry of normalized) {
    const list = bySurface.get(entry.surfaceBlockId);
    if (list) list.push(entry);
    else bySurface.set(entry.surfaceBlockId, [entry]);
  }
  return Object.freeze({ rules: Object.freeze(normalized), bySurface });
}

export function normalizeSurfaceDecorationRules(rules = []) {
  if (!Array.isArray(rules) || rules.length > SURFACE_DECORATION_RULE_MAX_COUNT) {
    throw new Error(`Invalid surface decoration rule count: ${rules?.length ?? 0}`);
  }
  if (!rules.length) return [];
  const ids = new Set();
  return rules.map((entry, index) => {
    const normalized = Object.freeze({
      ruleId: integer(entry.ruleId, index + 1, 1, 0xffff),
      decorationId: integer(entry.decorationId, 0, 1, 0xffff),
      surfaceBlockId: integer(entry.surfaceBlockId, 0, 1, 0xffff),
      dropBlockId: integer(entry.dropBlockId, 0, 1, 0xffff),
      rollStartBps: integer(entry.rollStartBps, 0, 0, SURFACE_DECORATION_ROLL_DENOMINATOR - 1),
      rollEndBps: integer(entry.rollEndBps, 0, 1, SURFACE_DECORATION_ROLL_DENOMINATOR),
      minY: integer(entry.minY, -32, -0x8000, 0x7fff),
      maxY: integer(entry.maxY, 320, -0x8000, 0x7fff),
      salt: integer(entry.salt, 0, 0, 0xffff),
      variant: integer(entry.variant, 0, 0, 0xff),
      flags: integer(entry.flags, COMMON_FLAGS, 0, 0xff),
    });
    if (ids.has(normalized.ruleId) || normalized.rollStartBps >= normalized.rollEndBps || normalized.minY > normalized.maxY) {
      throw new Error(`Invalid surface decoration rule at index ${index}`);
    }
    ids.add(normalized.ruleId);
    return normalized;
  });
}

export function resolveSurfaceDecoration({
  worldSeed,
  worldX,
  surfaceY,
  worldZ,
  surfaceBlockId,
  rules = EMPTY_COMPILED_SURFACE_DECORATION_RULES,
} = {}) {
  const compiled = rules?.bySurface instanceof Map ? rules : compileSurfaceDecorationRules(rules);
  const candidates = compiled.bySurface.get(Math.trunc(surfaceBlockId));
  if (!candidates?.length) return null;
  const x = Math.trunc(worldX);
  const y = Math.trunc(surfaceY);
  const z = Math.trunc(worldZ);
  const seed = worldSeed instanceof Uint8Array ? worldSeed : normalizeSeedBytes(worldSeed);
  let activeSalt = -1;
  let roll = -1;
  for (const entry of candidates) {
    if (y < entry.minY || y > entry.maxY) continue;
    if (entry.salt !== activeSalt) {
      activeSalt = entry.salt;
      roll = hashCoord3(seed, x, y + 1, z, 1200 + entry.salt) % SURFACE_DECORATION_ROLL_DENOMINATOR;
    }
    if (roll < entry.rollStartBps || roll >= entry.rollEndBps) continue;
    return {
      ...entry,
      roll,
      variantHash: surfaceDecorationVariantHash({
        worldSeed: seed,
        worldX: x,
        surfaceY: y,
        worldZ: z,
        ruleId: entry.ruleId,
      }),
    };
  }
  return null;
}

export function surfaceDecorationName(decorationId) {
  const id = Math.trunc(Number(decorationId) || 0);
  return SURFACE_DECORATION_NAMES[id] ?? (id > 0 ? `Decoration ${id}` : "Decoration");
}

export function surfaceDecorationVariantHash({ worldSeed, worldX, surfaceY, worldZ, ruleId } = {}) {
  const seed = worldSeed instanceof Uint8Array ? worldSeed : normalizeSeedBytes(worldSeed);
  return hashCoord3(
    seed,
    Math.trunc(Number(worldX) || 0),
    Math.trunc(Number(surfaceY) || 0) + 1,
    Math.trunc(Number(worldZ) || 0),
    2200 + Math.max(0, Math.trunc(Number(ruleId) || 0)),
  );
}

function rule(ruleId, decorationName, surfaceName, dropName, rollStartBps, rollEndBps, salt, variant = 0, flags = COMMON_FLAGS) {
  return Object.freeze({
    ruleId,
    decorationId: SURFACE_DECORATION_ID[decorationName],
    surfaceBlockId: BLOCK_ID[surfaceName],
    dropBlockId: BLOCK_ID[dropName],
    rollStartBps,
    rollEndBps,
    minY: -32,
    maxY: 320,
    salt,
    variant,
    flags,
  });
}

function integer(value, fallback, min, max) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.max(min, Math.min(max, number));
}
