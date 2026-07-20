import { BLOCK_FLAGS } from "../core/constants.js";

export const BLOCK_ID = Object.freeze({
  air: 0,
  grass: 1,
  dirt: 2,
  stone: 3,
  deepStone: 4,
  sand: 5,
  gravel: 6,
  clay: 7,
  mud: 8,
  dryDirt: 9,
  saltFlat: 10,
  snow: 11,
  ice: 12,
  frozenSoil: 13,
  basalt: 14,
  ash: 15,
  bedrock: 16,
  water: 17,
  swampWater: 18,
  toxicWater: 19,
  lava: 20,
  quicksand: 21,
  trunk: 22,
  leaves: 23,
  pineTrunk: 24,
  pineLeaves: 25,
  deadWood: 26,
  giantRoot: 27,
  grassPlant: 28,
  dryGrass: 29,
  bush: 30,
  deadBush: 31,
  cactus: 32,
  reed: 33,
  swampGrass: 34,
  snowBush: 35,
  thorn: 36,
  moss: 37,
  lichen: 38,
  vine: 39,
  glowMycelium: 40,
  mushroom: 41,
  seaweed: 42,
  aquaticPlant: 43,
  coral: 44,
  deadCoral: 45,
  shellBed: 46,
  coal: 47,
  cotton: 48,
  flowerWhite: 49,
  flowerYellow: 50,
  flowerRed: 51,
  flowerBlue: 52,
  flowerPink: 53,
});

export const RESOURCE_ID = Object.freeze({
  none: 0,
  grassFiber: 1,
  soil: 2,
  stone: 3,
  sand: 4,
  clay: 5,
  snow: 6,
  basalt: 7,
  water: 8,
  wood: 9,
  leaves: 10,
  coal: 11,
  salt: 12,
  ice: 13,
  lava: 14,
  organic: 15,
  cactus: 16,
  reed: 17,
  moss: 18,
  mushroom: 19,
  aquaticPlant: 20,
  coral: 21,
  shell: 22,
  cotton: 23,
  flowerWhite: 24,
  flowerYellow: 25,
  flowerRed: 26,
  flowerBlue: 27,
  flowerPink: 28,
});

export const MATERIAL_ID = Object.freeze({
  air: 0,
  grassTop: 1,
  dirt: 2,
  stone: 3,
  deepStone: 4,
  sand: 5,
  gravel: 6,
  clay: 7,
  mud: 8,
  dryDirt: 9,
  saltFlat: 10,
  snow: 11,
  ice: 12,
  frozenSoil: 13,
  basalt: 14,
  ash: 15,
  bedrock: 16,
  water: 17,
  swampWater: 18,
  toxicWater: 19,
  lava: 20,
  quicksand: 21,
  trunk: 22,
  leaves: 23,
  pineTrunk: 24,
  pineLeaves: 25,
  deadWood: 26,
  giantRoot: 27,
  grassPlant: 28,
  dryGrass: 29,
  bush: 30,
  deadBush: 31,
  cactus: 32,
  reed: 33,
  swampGrass: 34,
  snowBush: 35,
  thorn: 36,
  moss: 37,
  lichen: 38,
  vine: 39,
  glowMycelium: 40,
  mushroom: 41,
  seaweed: 42,
  aquaticPlant: 43,
  coral: 44,
  deadCoral: 45,
  shellBed: 46,
  coal: 47,
  flowerWhite: 48,
  flowerYellow: 49,
  flowerRed: 50,
  flowerBlue: 51,
  flowerPink: 52,
  grassSide: 53,
  shadow: 54,
  woodenPlank: 55,
  woodenStick: 56,
  squaredTimber: 57,
  clearGlassPanel: 58,
  iceBlueGlassPanel: 59,
  amberGlassPanel: 60,
  basaltReinforcedGlass: 61,
  firedClayBrick: 62,
  adobeBrick: 63,
  stoneBrick: 64,
  deepStoneBrick: 65,
  basaltBrick: 66,
  sandstoneBlock: 67,
  cobblestone: 68,
  polishedStoneSlab: 69,
  limePlaster: 70,
  clayPlaster: 71,
  rammedEarth: 72,
  shellTerrazzo: 73,
  whiteCeramicTile: 74,
  blueCeramicTile: 75,
  volcanicAshConcrete: 76,
  saltCrystalBlock: 77,
  roofTileTerracotta: 96,
  roofTileIceBlue: 97,
  roofTileShellWhite: 98,
  roofTileCharcoal: 99,
  roofTileAshGray: 100,
  roofTileMycelium: 101,
});

const SOLID_MINEABLE = BLOCK_FLAGS.SOLID | BLOCK_FLAGS.MINEABLE;
const CUTOUT_MINEABLE = BLOCK_FLAGS.TRANSPARENT | BLOCK_FLAGS.CUTOUT | BLOCK_FLAGS.MINEABLE;
const LIQUID = BLOCK_FLAGS.TRANSPARENT | BLOCK_FLAGS.LIQUID;
const LIQUID_MINEABLE = LIQUID | BLOCK_FLAGS.MINEABLE;

export const blockDefs = Object.freeze({
  [BLOCK_ID.air]: def(BLOCK_ID.air, "air", RESOURCE_ID.none, MATERIAL_ID.air, 0, BLOCK_FLAGS.TRANSPARENT),
  [BLOCK_ID.grass]: def(BLOCK_ID.grass, "grass", RESOURCE_ID.grassFiber, MATERIAL_ID.grassTop, 2, SOLID_MINEABLE),
  [BLOCK_ID.dirt]: def(BLOCK_ID.dirt, "dirt", RESOURCE_ID.soil, MATERIAL_ID.dirt, 2, SOLID_MINEABLE),
  [BLOCK_ID.stone]: def(BLOCK_ID.stone, "stone", RESOURCE_ID.stone, MATERIAL_ID.stone, 5, SOLID_MINEABLE),
  [BLOCK_ID.deepStone]: def(BLOCK_ID.deepStone, "deepStone", RESOURCE_ID.stone, MATERIAL_ID.deepStone, 8, SOLID_MINEABLE),
  [BLOCK_ID.sand]: def(BLOCK_ID.sand, "sand", RESOURCE_ID.sand, MATERIAL_ID.sand, 2, SOLID_MINEABLE),
  [BLOCK_ID.gravel]: def(BLOCK_ID.gravel, "gravel", RESOURCE_ID.stone, MATERIAL_ID.gravel, 3, SOLID_MINEABLE),
  [BLOCK_ID.clay]: def(BLOCK_ID.clay, "clay", RESOURCE_ID.clay, MATERIAL_ID.clay, 3, SOLID_MINEABLE),
  [BLOCK_ID.mud]: def(BLOCK_ID.mud, "mud", RESOURCE_ID.soil, MATERIAL_ID.mud, 2, SOLID_MINEABLE),
  [BLOCK_ID.dryDirt]: def(BLOCK_ID.dryDirt, "dryDirt", RESOURCE_ID.soil, MATERIAL_ID.dryDirt, 2, SOLID_MINEABLE),
  [BLOCK_ID.saltFlat]: def(BLOCK_ID.saltFlat, "saltFlat", RESOURCE_ID.salt, MATERIAL_ID.saltFlat, 2, SOLID_MINEABLE),
  [BLOCK_ID.snow]: def(BLOCK_ID.snow, "snow", RESOURCE_ID.snow, MATERIAL_ID.snow, 1, SOLID_MINEABLE),
  [BLOCK_ID.ice]: def(BLOCK_ID.ice, "ice", RESOURCE_ID.ice, MATERIAL_ID.ice, 4, SOLID_MINEABLE | BLOCK_FLAGS.TRANSPARENT),
  [BLOCK_ID.frozenSoil]: def(BLOCK_ID.frozenSoil, "frozenSoil", RESOURCE_ID.soil, MATERIAL_ID.frozenSoil, 3, SOLID_MINEABLE),
  [BLOCK_ID.basalt]: def(BLOCK_ID.basalt, "basalt", RESOURCE_ID.basalt, MATERIAL_ID.basalt, 7, SOLID_MINEABLE),
  [BLOCK_ID.ash]: def(BLOCK_ID.ash, "ash", RESOURCE_ID.soil, MATERIAL_ID.ash, 2, SOLID_MINEABLE),
  [BLOCK_ID.bedrock]: def(BLOCK_ID.bedrock, "bedrock", RESOURCE_ID.none, MATERIAL_ID.bedrock, 65535, BLOCK_FLAGS.SOLID),
  [BLOCK_ID.water]: def(BLOCK_ID.water, "water", RESOURCE_ID.water, MATERIAL_ID.water, 0, LIQUID),
  [BLOCK_ID.swampWater]: def(BLOCK_ID.swampWater, "swampWater", RESOURCE_ID.water, MATERIAL_ID.swampWater, 0, LIQUID),
  [BLOCK_ID.toxicWater]: def(BLOCK_ID.toxicWater, "toxicWater", RESOURCE_ID.water, MATERIAL_ID.toxicWater, 0, LIQUID_MINEABLE | BLOCK_FLAGS.EMISSIVE),
  [BLOCK_ID.lava]: def(BLOCK_ID.lava, "lava", RESOURCE_ID.lava, MATERIAL_ID.lava, 0, LIQUID_MINEABLE | BLOCK_FLAGS.EMISSIVE),
  [BLOCK_ID.quicksand]: def(BLOCK_ID.quicksand, "quicksand", RESOURCE_ID.sand, MATERIAL_ID.quicksand, 2, SOLID_MINEABLE),
  [BLOCK_ID.trunk]: def(BLOCK_ID.trunk, "trunk", RESOURCE_ID.wood, MATERIAL_ID.trunk, 3, SOLID_MINEABLE),
  [BLOCK_ID.leaves]: def(BLOCK_ID.leaves, "leaves", RESOURCE_ID.leaves, MATERIAL_ID.leaves, 1, SOLID_MINEABLE),
  [BLOCK_ID.pineTrunk]: def(BLOCK_ID.pineTrunk, "pineTrunk", RESOURCE_ID.wood, MATERIAL_ID.pineTrunk, 3, SOLID_MINEABLE),
  [BLOCK_ID.pineLeaves]: def(BLOCK_ID.pineLeaves, "pineLeaves", RESOURCE_ID.leaves, MATERIAL_ID.pineLeaves, 1, SOLID_MINEABLE),
  [BLOCK_ID.deadWood]: def(BLOCK_ID.deadWood, "deadWood", RESOURCE_ID.wood, MATERIAL_ID.deadWood, 3, SOLID_MINEABLE),
  [BLOCK_ID.giantRoot]: def(BLOCK_ID.giantRoot, "giantRoot", RESOURCE_ID.wood, MATERIAL_ID.giantRoot, 4, SOLID_MINEABLE),
  [BLOCK_ID.grassPlant]: def(BLOCK_ID.grassPlant, "grassPlant", RESOURCE_ID.grassFiber, MATERIAL_ID.grassPlant, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.dryGrass]: def(BLOCK_ID.dryGrass, "dryGrass", RESOURCE_ID.grassFiber, MATERIAL_ID.dryGrass, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.bush]: def(BLOCK_ID.bush, "bush", RESOURCE_ID.leaves, MATERIAL_ID.bush, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.deadBush]: def(BLOCK_ID.deadBush, "deadBush", RESOURCE_ID.organic, MATERIAL_ID.deadBush, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.cactus]: def(BLOCK_ID.cactus, "cactus", RESOURCE_ID.cactus, MATERIAL_ID.cactus, 2, SOLID_MINEABLE),
  [BLOCK_ID.reed]: def(BLOCK_ID.reed, "reed", RESOURCE_ID.reed, MATERIAL_ID.reed, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.swampGrass]: def(BLOCK_ID.swampGrass, "swampGrass", RESOURCE_ID.grassFiber, MATERIAL_ID.swampGrass, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.snowBush]: def(BLOCK_ID.snowBush, "snowBush", RESOURCE_ID.leaves, MATERIAL_ID.snowBush, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.thorn]: def(BLOCK_ID.thorn, "thorn", RESOURCE_ID.organic, MATERIAL_ID.thorn, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.moss]: def(BLOCK_ID.moss, "moss", RESOURCE_ID.none, MATERIAL_ID.moss, 0, BLOCK_FLAGS.TRANSPARENT | BLOCK_FLAGS.CUTOUT),
  [BLOCK_ID.lichen]: def(BLOCK_ID.lichen, "lichen", RESOURCE_ID.moss, MATERIAL_ID.lichen, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.vine]: def(BLOCK_ID.vine, "vine", RESOURCE_ID.organic, MATERIAL_ID.vine, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.glowMycelium]: def(BLOCK_ID.glowMycelium, "glowMycelium", RESOURCE_ID.mushroom, MATERIAL_ID.glowMycelium, 1, CUTOUT_MINEABLE | BLOCK_FLAGS.EMISSIVE),
  [BLOCK_ID.mushroom]: def(BLOCK_ID.mushroom, "mushroom", RESOURCE_ID.mushroom, MATERIAL_ID.mushroom, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.seaweed]: def(BLOCK_ID.seaweed, "seaweed", RESOURCE_ID.aquaticPlant, MATERIAL_ID.seaweed, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.aquaticPlant]: def(BLOCK_ID.aquaticPlant, "aquaticPlant", RESOURCE_ID.aquaticPlant, MATERIAL_ID.aquaticPlant, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.coral]: def(BLOCK_ID.coral, "coral", RESOURCE_ID.coral, MATERIAL_ID.coral, 2, SOLID_MINEABLE),
  [BLOCK_ID.deadCoral]: def(BLOCK_ID.deadCoral, "deadCoral", RESOURCE_ID.coral, MATERIAL_ID.deadCoral, 2, SOLID_MINEABLE),
  [BLOCK_ID.shellBed]: def(BLOCK_ID.shellBed, "shellBed", RESOURCE_ID.shell, MATERIAL_ID.shellBed, 2, SOLID_MINEABLE),
  [BLOCK_ID.coal]: def(BLOCK_ID.coal, "coal", RESOURCE_ID.coal, MATERIAL_ID.coal, 5, SOLID_MINEABLE),
  [BLOCK_ID.cotton]: def(BLOCK_ID.cotton, "cotton", RESOURCE_ID.cotton, MATERIAL_ID.flowerWhite, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.flowerWhite]: def(BLOCK_ID.flowerWhite, "flowerWhite", RESOURCE_ID.flowerWhite, MATERIAL_ID.flowerWhite, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.flowerYellow]: def(BLOCK_ID.flowerYellow, "flowerYellow", RESOURCE_ID.flowerYellow, MATERIAL_ID.flowerYellow, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.flowerRed]: def(BLOCK_ID.flowerRed, "flowerRed", RESOURCE_ID.flowerRed, MATERIAL_ID.flowerRed, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.flowerBlue]: def(BLOCK_ID.flowerBlue, "flowerBlue", RESOURCE_ID.flowerBlue, MATERIAL_ID.flowerBlue, 1, CUTOUT_MINEABLE),
  [BLOCK_ID.flowerPink]: def(BLOCK_ID.flowerPink, "flowerPink", RESOURCE_ID.flowerPink, MATERIAL_ID.flowerPink, 1, CUTOUT_MINEABLE),
});

export function blockDef(blockId) {
  return blockDefs[blockId] ?? blockDefs[BLOCK_ID.air];
}

export function blockMaterialIdForFace(blockId, faceIndex) {
  const definition = blockDef(blockId);
  if (definition.blockId === BLOCK_ID.grass && faceIndex !== 2) return MATERIAL_ID.grassSide;
  return definition.materialId;
}

export function blockFlags(blockId) {
  return blockDef(blockId).flags;
}

export function isOpaqueSolidBlock(blockId) {
  const flags = blockFlags(blockId);
  return Boolean(flags & BLOCK_FLAGS.SOLID) && !Boolean(flags & BLOCK_FLAGS.TRANSPARENT) && blockId !== BLOCK_ID.air;
}

export function isBlockingBlock(blockId) {
  const flags = blockFlags(blockId);
  return Boolean(flags & BLOCK_FLAGS.SOLID) && !Boolean(flags & BLOCK_FLAGS.LIQUID) && !Boolean(flags & BLOCK_FLAGS.CUTOUT) && blockId !== BLOCK_ID.air;
}

export function isVisualBlock(blockId) {
  const flags = blockFlags(blockId);
  return blockId !== BLOCK_ID.air && (Boolean(flags & BLOCK_FLAGS.TRANSPARENT) || Boolean(flags & BLOCK_FLAGS.LIQUID) || Boolean(flags & BLOCK_FLAGS.CUTOUT));
}

export function isLowVegetationBlock(blockId) {
  switch (blockId) {
    case BLOCK_ID.grassPlant:
    case BLOCK_ID.dryGrass:
    case BLOCK_ID.bush:
    case BLOCK_ID.deadBush:
    case BLOCK_ID.cactus:
    case BLOCK_ID.reed:
    case BLOCK_ID.swampGrass:
    case BLOCK_ID.snowBush:
    case BLOCK_ID.thorn:
    case BLOCK_ID.moss:
    case BLOCK_ID.lichen:
    case BLOCK_ID.vine:
    case BLOCK_ID.glowMycelium:
    case BLOCK_ID.mushroom:
    case BLOCK_ID.seaweed:
    case BLOCK_ID.aquaticPlant:
    case BLOCK_ID.cotton:
    case BLOCK_ID.flowerWhite:
    case BLOCK_ID.flowerYellow:
    case BLOCK_ID.flowerRed:
    case BLOCK_ID.flowerBlue:
    case BLOCK_ID.flowerPink:
      return true;
    default:
      return false;
  }
}

export function isFluidBlock(blockId) {
  return Boolean(blockFlags(blockId) & BLOCK_FLAGS.LIQUID);
}

export function isMineableBlock(blockId) {
  return Boolean(blockFlags(blockId) & BLOCK_FLAGS.MINEABLE);
}

function def(blockId, name, resourceId, materialId, hardness, flags) {
  return Object.freeze({ blockId, name, resourceId, materialId, hardness, flags });
}
