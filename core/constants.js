export const DEFAULT_CHUNK_SIZE = 16;
export const DEFAULT_CHUNK_HEIGHT = 353;
export const DEFAULT_MIN_WORLD_Y = -32;
export const DEFAULT_VIEW_DISTANCE = 5;
export const DEFAULT_MESH_BUDGET_MS = 5;
export const MAX_MOBILE_DPR = 1.25;
export const MAX_DESKTOP_DPR = 1.75;
export const DEFAULT_SEA_LEVEL = 96;
export const DEFAULT_LAND_BASE_HEIGHT = 100;
export const DEFAULT_MAX_TERRAIN_HEIGHT = 240;
export const WATER_SURFACE_OFFSET = 1;

// Canonical physical scale shared by the game world, forged NCF1 assets, and
// every character-relative preview. NCF1 dimensions are metres; the live game
// renders one world unit per voxel block.
export const WORLD_BLOCK_SIZE_METERS = 0.4;
export const PLAYER_AVATAR_HEIGHT_METERS = 1.75;
export const PEASANT_GUY_SOURCE_HEIGHT_UNITS = 2.52;
export const WORLD_UNITS_PER_METER = 1 / WORLD_BLOCK_SIZE_METERS;
export const PLAYER_AVATAR_HEIGHT_WORLD_UNITS = PLAYER_AVATAR_HEIGHT_METERS * WORLD_UNITS_PER_METER;
export const PEASANT_GUY_GAME_SCALE = PLAYER_AVATAR_HEIGHT_WORLD_UNITS / PEASANT_GUY_SOURCE_HEIGHT_UNITS;
export const PEASANT_GUY_METER_SCALE = PLAYER_AVATAR_HEIGHT_METERS / PEASANT_GUY_SOURCE_HEIGHT_UNITS;

export const REVEAL_STATE = Object.freeze({
  UNKNOWN: 0,
  COMMITTED: 1,
  REVEALED: 2,
  MODIFIED: 3,
  DIRTY: 4,
  CONFIRMED: 5,
  CONFLICT: 6,
});

export const BLOCK_FLAGS = Object.freeze({
  SOLID: 1 << 0,
  TRANSPARENT: 1 << 1,
  EMISSIVE: 1 << 2,
  MINEABLE: 1 << 3,
  LIQUID: 1 << 4,
  CUTOUT: 1 << 5,
});
