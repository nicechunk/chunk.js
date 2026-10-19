// World-space direction towards the sun. Terrain, the sky disc, water highlights
// and baked visibility must all use the same light source.
export const WORLD_SUN_VECTOR = Object.freeze([-0.72, 0.34, 0.62]);
// Match the existing terrain shadow footprint; all work stays in section builds.
export const SUNLIGHT_HORIZONTAL_REACH = 15;
export const SUNLIGHT_VERTICAL_REACH = Math.ceil(
  SUNLIGHT_HORIZONTAL_REACH * WORLD_SUN_VECTOR[1] / Math.hypot(WORLD_SUN_VECTOR[0], WORLD_SUN_VECTOR[2]),
) + 1;
