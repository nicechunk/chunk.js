function part(id, x, y, z, sx, sy, sz, shade) {
  return Object.freeze({ id, x, y, z, sx, sy, sz, shade });
}

export const CACTUS_MODEL_HEIGHT_SCALE = 2;

function tallPart(id, x, y, z, sx, sy, sz, shade) {
  return part(id, x, y * CACTUS_MODEL_HEIGHT_SCALE, z, sx, sy * CACTUS_MODEL_HEIGHT_SCALE, sz, shade);
}

// Five cuboids keep the silhouette distinctive while remaining cheap enough to
// merge directly into the existing per-chunk opaque mesh.
export const CACTUS_MODEL_PARTS = Object.freeze([
  tallPart("trunk", 0.000, 0.500, 0.000, 0.300, 0.920, 0.280, 228),
  tallPart("low_arm", -0.245, 0.480, 0.000, 0.300, 0.180, 0.240, 216),
  tallPart("low_tip", -0.330, 0.610, 0.000, 0.200, 0.340, 0.220, 224),
  tallPart("high_arm", 0.245, 0.640, 0.000, 0.300, 0.180, 0.240, 232),
  tallPart("high_tip", 0.330, 0.775, 0.000, 0.200, 0.310, 0.220, 240),
]);

export const CACTUS_MODEL_MAX_Y = Math.max(...CACTUS_MODEL_PARTS.map((entry) => entry.y + entry.sy * 0.5));
export const CACTUS_MODEL_QUAD_COUNT = CACTUS_MODEL_PARTS.length * 5;
export const CACTUS_MODEL_TRIANGLE_COUNT = CACTUS_MODEL_QUAD_COUNT * 2;

const CACTUS_MODEL_ROTATIONS = Object.freeze(Array.from({ length: 4 }, (_, quarterTurns) => Object.freeze(
  CACTUS_MODEL_PARTS.map((entry) => rotatePart(entry, quarterTurns)),
)));

export function cactusModelPartsForQuarterTurn(quarterTurns = 0) {
  return CACTUS_MODEL_ROTATIONS[Math.trunc(Number(quarterTurns) || 0) & 3];
}

function rotatePart(entry, quarterTurns) {
  const turn = quarterTurns & 3;
  if (turn === 0) return entry;
  if (turn === 1) return part(entry.id, entry.z, entry.y, -entry.x, entry.sz, entry.sy, entry.sx, entry.shade);
  if (turn === 2) return part(entry.id, -entry.x, entry.y, -entry.z, entry.sx, entry.sy, entry.sz, entry.shade);
  return part(entry.id, -entry.z, entry.y, entry.x, entry.sz, entry.sy, entry.sx, entry.shade);
}
