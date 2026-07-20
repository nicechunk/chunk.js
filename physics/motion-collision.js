export function createAabbFromCenter(cx, cy, cz, halfX, halfY, halfZ, target = {}) {
  const hx = Math.max(0, Number(halfX) || 0);
  const hy = Math.max(0, Number(halfY) || 0);
  const hz = Math.max(0, Number(halfZ) || 0);
  target.minX = Number(cx) - hx;
  target.maxX = Number(cx) + hx;
  target.minY = Number(cy) - hy;
  target.maxY = Number(cy) + hy;
  target.minZ = Number(cz) - hz;
  target.maxZ = Number(cz) + hz;
  return target;
}

export function createBlockAabb(worldX, worldY, worldZ, padding = 0, target = {}) {
  const pad = Math.max(0, Number(padding) || 0);
  const x = Math.trunc(Number(worldX) || 0);
  const y = Math.trunc(Number(worldY) || 0);
  const z = Math.trunc(Number(worldZ) || 0);
  target.minX = x - pad;
  target.maxX = x + 1 + pad;
  target.minY = y - pad;
  target.maxY = y + 1 + pad;
  target.minZ = z - pad;
  target.maxZ = z + 1 + pad;
  return target;
}

export function aabbIntersectsAabb(a, b) {
  return Boolean(a && b
    && a.minX <= b.maxX && a.maxX >= b.minX
    && a.minY <= b.maxY && a.maxY >= b.minY
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ);
}

export function sphereIntersectsAabb(sphere, aabb) {
  if (!sphere || !aabb) return false;
  const x = Number(sphere.x ?? sphere.centerX) || 0;
  const y = Number(sphere.y ?? sphere.centerY) || 0;
  const z = Number(sphere.z ?? sphere.centerZ) || 0;
  const radius = Math.max(0, Number(sphere.radius) || 0);
  const dx = x < aabb.minX ? aabb.minX - x : (x > aabb.maxX ? x - aabb.maxX : 0);
  const dy = y < aabb.minY ? aabb.minY - y : (y > aabb.maxY ? y - aabb.maxY : 0);
  const dz = z < aabb.minZ ? aabb.minZ - z : (z > aabb.maxZ ? z - aabb.maxZ : 0);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

export function aabbCenter(a, target = {}) {
  target.x = (Number(a?.minX) + Number(a?.maxX)) * 0.5;
  target.y = (Number(a?.minY) + Number(a?.maxY)) * 0.5;
  target.z = (Number(a?.minZ) + Number(a?.maxZ)) * 0.5;
  return target;
}

export function aabbHalfSize(a, target = {}) {
  target.x = Math.max(0, (Number(a?.maxX) - Number(a?.minX)) * 0.5);
  target.y = Math.max(0, (Number(a?.maxY) - Number(a?.minY)) * 0.5);
  target.z = Math.max(0, (Number(a?.maxZ) - Number(a?.minZ)) * 0.5);
  return target;
}

export function clampPointToAabb(x, y, z, aabb, target = {}) {
  target.x = clamp(Number(x) || 0, aabb.minX, aabb.maxX);
  target.y = clamp(Number(y) || 0, aabb.minY, aabb.maxY);
  target.z = clamp(Number(z) || 0, aabb.minZ, aabb.maxZ);
  return target;
}

export function sweptAabbIntersection(previousBox, currentBox, targetBox, result = {}) {
  if (!previousBox || !currentBox || !targetBox) return miss(result);
  const currentCenter = aabbCenter(currentBox, scratchCurrentCenter);
  if (aabbIntersectsAabb(currentBox, targetBox)) {
    clampPointToAabb(currentCenter.x, currentCenter.y, currentCenter.z, targetBox, result);
    result.hit = true;
    result.time = 1;
    return result;
  }

  const previousCenter = aabbCenter(previousBox, scratchPreviousCenter);
  const half = aabbHalfSize(currentBox, scratchHalfSize);
  const dx = currentCenter.x - previousCenter.x;
  const dy = currentCenter.y - previousCenter.y;
  const dz = currentCenter.z - previousCenter.z;
  if (dx * dx + dy * dy + dz * dz <= 0.0000001) return miss(result);

  const expanded = scratchExpandedTarget;
  expanded.minX = targetBox.minX - half.x;
  expanded.maxX = targetBox.maxX + half.x;
  expanded.minY = targetBox.minY - half.y;
  expanded.maxY = targetBox.maxY + half.y;
  expanded.minZ = targetBox.minZ - half.z;
  expanded.maxZ = targetBox.maxZ + half.z;

  const toi = rayAabbTimeOfImpact(previousCenter.x, previousCenter.y, previousCenter.z, dx, dy, dz, expanded);
  if (toi === null) return miss(result);
  const hitX = previousCenter.x + dx * toi;
  const hitY = previousCenter.y + dy * toi;
  const hitZ = previousCenter.z + dz * toi;
  clampPointToAabb(hitX, hitY, hitZ, targetBox, result);
  result.hit = true;
  result.time = toi;
  return result;
}

function rayAabbTimeOfImpact(x, y, z, dx, dy, dz, box) {
  let enter = 0;
  let exit = 1;
  const tx = axisInterval(x, dx, box.minX, box.maxX);
  if (!tx) return null;
  enter = Math.max(enter, tx.enter);
  exit = Math.min(exit, tx.exit);
  if (enter > exit) return null;

  const ty = axisInterval(y, dy, box.minY, box.maxY);
  if (!ty) return null;
  enter = Math.max(enter, ty.enter);
  exit = Math.min(exit, ty.exit);
  if (enter > exit) return null;

  const tz = axisInterval(z, dz, box.minZ, box.maxZ);
  if (!tz) return null;
  enter = Math.max(enter, tz.enter);
  exit = Math.min(exit, tz.exit);
  if (enter > exit) return null;

  return enter >= 0 && enter <= 1 ? enter : null;
}

function axisInterval(position, delta, min, max) {
  if (Math.abs(delta) < 0.000001) {
    return position >= min && position <= max ? { enter: 0, exit: 1 } : null;
  }
  const inv = 1 / delta;
  let enter = (min - position) * inv;
  let exit = (max - position) * inv;
  if (enter > exit) [enter, exit] = [exit, enter];
  return { enter, exit };
}

function miss(result) {
  result.hit = false;
  result.time = 1;
  result.x = 0;
  result.y = 0;
  result.z = 0;
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const scratchCurrentCenter = {};
const scratchPreviousCenter = {};
const scratchHalfSize = {};
const scratchExpandedTarget = {};
