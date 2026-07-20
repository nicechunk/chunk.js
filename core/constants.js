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
