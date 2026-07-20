const DEFAULT_COLLISION_EPSILON = 0.0001;

export function createCollisionBox({
  halfWidth,
  halfDepth,
  height,
  offsetX = 0,
  offsetY = 0,
  offsetZ = 0,
  name = "box",
} = {}) {
  return Object.freeze({
    name,
    halfWidth: Math.max(0, Number(halfWidth) || 0),
    halfDepth: Math.max(0, Number(halfDepth) || 0),
    height: Math.max(0, Number(height) || 0),
    offsetX: Number(offsetX) || 0,
    offsetY: Number(offsetY) || 0,
    offsetZ: Number(offsetZ) || 0,
  });
}

export function prepareCollisionBoxes(boxes, originX, originY, originZ, yaw = 0) {
  const source = Array.isArray(boxes) ? boxes : [];
  return source
    .filter((box) => box && box.halfWidth > 0 && box.halfDepth > 0 && box.height > 0)
    .map((box) => prepareCollisionBox(box, originX, originY, originZ, yaw));
}

export function prepareCollisionBox(box, originX, originY, originZ, yaw = 0) {
  const c = Math.cos(yaw || 0);
  const s = Math.sin(yaw || 0);
  const centerX = originX + c * box.offsetX + s * box.offsetZ;
  const centerZ = originZ - s * box.offsetX + c * box.offsetZ;
  const extentX = Math.abs(c) * box.halfWidth + Math.abs(s) * box.halfDepth;
  const extentZ = Math.abs(s) * box.halfWidth + Math.abs(c) * box.halfDepth;
  return {
    box,
    centerX,
    centerZ,
    minX: centerX - extentX,
    maxX: centerX + extentX,
    minY: originY + box.offsetY,
    maxY: originY + box.offsetY + box.height,
    minZ: centerZ - extentZ,
    maxZ: centerZ + extentZ,
    rightX: c,
    rightZ: -s,
    forwardX: s,
    forwardZ: c,
    extentX,
    extentZ,
  };
}

export function preparedCollisionBoxIntersectsBlock(prepared, blockX, blockY, blockZ, epsilon = DEFAULT_COLLISION_EPSILON) {
  if (prepared.maxY <= blockY + epsilon || prepared.minY >= blockY + 1 - epsilon) return false;
  return preparedCollisionFootprintIntersectsBlock(prepared, blockX, blockZ, epsilon);
}

export function preparedCollisionFootprintIntersectsBlock(prepared, blockX, blockZ, epsilon = DEFAULT_COLLISION_EPSILON) {
  const dx = blockX + 0.5 - prepared.centerX;
  const dz = blockZ + 0.5 - prepared.centerZ;
  if (Math.abs(dx) >= prepared.extentX + 0.5 - epsilon) return false;
  if (Math.abs(dz) >= prepared.extentZ + 0.5 - epsilon) return false;

  const rightBlockHalf = 0.5 * (Math.abs(prepared.rightX) + Math.abs(prepared.rightZ));
  const forwardBlockHalf = 0.5 * (Math.abs(prepared.forwardX) + Math.abs(prepared.forwardZ));
  const rightDistance = dx * prepared.rightX + dz * prepared.rightZ;
  const forwardDistance = dx * prepared.forwardX + dz * prepared.forwardZ;
  return (
    Math.abs(rightDistance) < prepared.box.halfWidth + rightBlockHalf - epsilon &&
    Math.abs(forwardDistance) < prepared.box.halfDepth + forwardBlockHalf - epsilon
  );
}

export function maxCollisionHorizontalExtent(boxes, yaw = 0) {
  let maxExtent = 0;
  for (const prepared of prepareCollisionBoxes(boxes, 0, 0, 0, yaw)) {
    maxExtent = Math.max(maxExtent, Math.abs(prepared.minX), Math.abs(prepared.maxX), Math.abs(prepared.minZ), Math.abs(prepared.maxZ));
  }
  return maxExtent;
}
