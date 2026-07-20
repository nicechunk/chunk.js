import { cameraFloatPosition, cameraForward } from "./camera.js";

export function visibleByDistance(chunk, cameraState, chunkSize, viewDistance) {
  const centerX = chunk.chunkX * chunkSize + chunkSize / 2;
  const centerZ = chunk.chunkZ * chunkSize + chunkSize / 2;
  const dx = centerX - (cameraState.worldX || 0);
  const dz = centerZ - (cameraState.worldZ || 0);
  const maxDistance = (viewDistance + 1) * chunkSize;
  return dx * dx + dz * dz <= maxDistance * maxDistance;
}

export function filterChunksByCameraFrustum(chunks, cameraState) {
  const list = Array.isArray(chunks) ? chunks : Array.from(chunks ?? []);
  if (!cameraState || !list.length) return list;
  const frustum = prepareCameraFrustum(cameraState);
  const visible = [];
  for (const chunk of list) {
    if (chunk?.frustumCullEligible !== true || chunkIntersectsPreparedFrustum(chunk, frustum)) visible.push(chunk);
  }
  return visible;
}

export function chunkIntersectsCameraFrustum(chunk, cameraState) {
  if (!cameraState) return true;
  return chunkIntersectsPreparedFrustum(chunk, prepareCameraFrustum(cameraState));
}

function chunkIntersectsPreparedFrustum(chunk, frustum) {
  const bounds = chunkWorldBounds(chunk);
  if (!bounds) return true;

  const deltaX = bounds.centerX - frustum.eyeX;
  const deltaY = bounds.centerY - frustum.eyeY;
  const deltaZ = bounds.centerZ - frustum.eyeZ;
  const depth = deltaX * frustum.forwardX + deltaY * frustum.forwardY + deltaZ * frustum.forwardZ;
  if (depth + bounds.radius < frustum.near || depth - bounds.radius > frustum.far) return false;
  if (!frustum.sideCull) return true;

  const horizontal = deltaX * frustum.rightX + deltaZ * frustum.rightZ;
  const vertical = deltaX * frustum.upX + deltaY * frustum.upY + deltaZ * frustum.upZ;
  if (Math.abs(horizontal) * frustum.horizontalCos
    > depth * frustum.horizontalSin + bounds.radius) return false;
  if (Math.abs(vertical) * frustum.verticalCos
    > depth * frustum.verticalSin + bounds.radius) return false;
  return true;
}

function prepareCameraFrustum(cameraState) {
  const eye = cameraFloatPosition(cameraState);
  const forward = cameraForward(cameraState);
  const near = Math.max(0, finiteNumber(cameraState.near, 0.08));
  const far = Math.max(near, finiteNumber(cameraState.far, 420));
  const halfVertical = clamp(finiteNumber(cameraState.fov, 58) * Math.PI / 360, 0.01, Math.PI * 0.49);
  const tanVertical = Math.tan(halfVertical);
  const tanHorizontal = tanVertical * Math.max(0.01, finiteNumber(cameraState.aspect, 1));
  const horizontalInverse = 1 / Math.hypot(1, tanHorizontal);
  const verticalInverse = 1 / Math.hypot(1, tanVertical);
  const horizontalLength = Math.hypot(forward[0], forward[2]);
  const sideCull = horizontalLength >= 1e-6;
  const rightX = sideCull ? forward[2] / horizontalLength : 0;
  const rightZ = sideCull ? -forward[0] / horizontalLength : 0;
  return {
    eyeX: finiteNumber(cameraState.worldX, 0) + eye[0],
    eyeY: finiteNumber(cameraState.worldY, 0) + eye[1],
    eyeZ: finiteNumber(cameraState.worldZ, 0) + eye[2],
    forwardX: forward[0],
    forwardY: forward[1],
    forwardZ: forward[2],
    rightX,
    rightZ,
    upX: forward[1] * rightZ,
    upY: forward[2] * rightX - forward[0] * rightZ,
    upZ: -forward[1] * rightX,
    near,
    far,
    sideCull,
    horizontalCos: horizontalInverse,
    horizontalSin: tanHorizontal * horizontalInverse,
    verticalCos: verticalInverse,
    verticalSin: tanVertical * verticalInverse,
  };
}

function chunkWorldBounds(chunk) {
  const prepared = chunk?.frustumBounds;
  if (prepared && [prepared.centerX, prepared.centerY, prepared.centerZ, prepared.radius].every(Number.isFinite)
    && prepared.radius > 0) return prepared;
  const chunkX = Number(chunk?.chunkX);
  const chunkZ = Number(chunk?.chunkZ);
  const chunkSize = Number(chunk?.chunkSize);
  const minY = Number(chunk?.minY);
  const height = Number(chunk?.height);
  if (![chunkX, chunkZ, chunkSize, minY, height].every(Number.isFinite)
    || chunkSize <= 0 || height <= 0) return null;
  const padding = 0.25;
  const width = chunkSize + padding * 2;
  const paddedHeight = height + padding * 2;
  return {
    centerX: chunkX * chunkSize + chunkSize * 0.5,
    centerY: minY + height * 0.5,
    centerZ: chunkZ * chunkSize + chunkSize * 0.5,
    radius: Math.hypot(width, paddedHeight, width) * 0.5,
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
