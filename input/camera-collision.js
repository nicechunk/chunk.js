const CAMERA_SWEEP_RING = new Float32Array([
  0, 0,
  1, 0,
  -1, 0,
  0, 1,
  0, -1,
  0.70710678, 0.70710678,
  -0.70710678, 0.70710678,
  0.70710678, -0.70710678,
  -0.70710678, -0.70710678,
]);

/**
 * Sweeps a small camera cross-section from its focus to the requested eye
 * position. The caller owns `out`, so the per-frame path stays allocation-free.
 */
export function resolveCameraCollisionSegment(
  focusX,
  focusY,
  focusZ,
  desiredX,
  desiredY,
  desiredZ,
  isBlockedAt,
  options = {},
  out = {},
) {
  const deltaX = desiredX - focusX;
  const deltaY = desiredY - focusY;
  const deltaZ = desiredZ - focusZ;
  const requestedDistance = Math.hypot(deltaX, deltaY, deltaZ);
  if (!Number.isFinite(requestedDistance) || requestedDistance <= 0.000001 || typeof isBlockedAt !== "function") {
    return writeResult(out, desiredX, desiredY, desiredZ, Math.max(0, requestedDistance || 0), false);
  }

  const inverseDistance = 1 / requestedDistance;
  const directionX = deltaX * inverseDistance;
  const directionY = deltaY * inverseDistance;
  const directionZ = deltaZ * inverseDistance;
  const horizontalLength = Math.hypot(directionX, directionZ);
  const rightX = horizontalLength > 0.000001 ? directionZ / horizontalLength : 1;
  const rightY = 0;
  const rightZ = horizontalLength > 0.000001 ? -directionX / horizontalLength : 0;
  const upX = horizontalLength > 0.000001 ? -(directionY * directionX) / horizontalLength : 0;
  const upY = horizontalLength > 0.000001 ? horizontalLength : 0;
  const upZ = horizontalLength > 0.000001 ? -(directionY * directionZ) / horizontalLength : 1;
  const radius = Math.max(0, finiteOr(options.radius, 0.24));
  const skin = Math.max(0, finiteOr(options.skin, 0.1));
  const minimumDistance = clamp(finiteOr(options.minimumDistance, 0.12), 0, requestedDistance);
  const probeLength = requestedDistance - minimumDistance;
  let firstHitDistance = Infinity;
  const ringLength = radius > 0.000001 ? CAMERA_SWEEP_RING.length : 2;

  for (let index = 0; index < ringLength; index += 2) {
    const ringRight = CAMERA_SWEEP_RING[index] * radius;
    const ringUp = CAMERA_SWEEP_RING[index + 1] * radius;
    const offsetX = rightX * ringRight + upX * ringUp;
    const offsetY = rightY * ringRight + upY * ringUp;
    const offsetZ = rightZ * ringRight + upZ * ringUp;
    const hitDistance = traceBlockedVoxelDistance(
      focusX + directionX * minimumDistance + offsetX,
      focusY + directionY * minimumDistance + offsetY,
      focusZ + directionZ * minimumDistance + offsetZ,
      directionX,
      directionY,
      directionZ,
      probeLength,
      isBlockedAt,
    );
    if (hitDistance < firstHitDistance) firstHitDistance = hitDistance;
  }

  if (!Number.isFinite(firstHitDistance)) {
    return writeResult(out, desiredX, desiredY, desiredZ, requestedDistance, false);
  }

  const safeDistance = clamp(minimumDistance + firstHitDistance - skin, 0, requestedDistance);
  return writeResult(
    out,
    focusX + directionX * safeDistance,
    focusY + directionY * safeDistance,
    focusZ + directionZ * safeDistance,
    safeDistance,
    true,
  );
}

function traceBlockedVoxelDistance(originX, originY, originZ, directionX, directionY, directionZ, maxDistance, isBlockedAt) {
  let voxelX = Math.floor(originX);
  let voxelY = Math.floor(originY);
  let voxelZ = Math.floor(originZ);
  const stepX = directionX > 0 ? 1 : directionX < 0 ? -1 : 0;
  const stepY = directionY > 0 ? 1 : directionY < 0 ? -1 : 0;
  const stepZ = directionZ > 0 ? 1 : directionZ < 0 ? -1 : 0;
  const deltaX = stepX ? Math.abs(1 / directionX) : Infinity;
  const deltaY = stepY ? Math.abs(1 / directionY) : Infinity;
  const deltaZ = stepZ ? Math.abs(1 / directionZ) : Infinity;
  let nextX = firstBoundaryDistance(originX, voxelX, directionX, stepX);
  let nextY = firstBoundaryDistance(originY, voxelY, directionY, stepY);
  let nextZ = firstBoundaryDistance(originZ, voxelZ, directionZ, stepZ);
  let travelled = 0;
  const maxIterations = Math.ceil(maxDistance * (Math.abs(directionX) + Math.abs(directionY) + Math.abs(directionZ))) + 12;

  for (let iteration = 0; iteration < maxIterations && travelled <= maxDistance + 0.000001; iteration += 1) {
    if (isBlockedAt(voxelX, voxelY, voxelZ)) return travelled;
    if (nextX <= nextY && nextX <= nextZ) {
      voxelX += stepX;
      travelled = nextX;
      nextX += deltaX;
    } else if (nextY <= nextZ) {
      voxelY += stepY;
      travelled = nextY;
      nextY += deltaY;
    } else {
      voxelZ += stepZ;
      travelled = nextZ;
      nextZ += deltaZ;
    }
  }
  return Infinity;
}

function firstBoundaryDistance(origin, voxel, direction, step) {
  if (!step) return Infinity;
  if (step > 0) return (voxel + 1 - origin) / direction;
  return (origin - voxel) / -direction;
}

function writeResult(out, x, y, z, distance, collided) {
  out.x = x;
  out.y = y;
  out.z = z;
  out.distance = distance;
  out.collided = collided;
  return out;
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
