const EPSILON = 1e-7;
const MAX_TRACE_VISIT_BYTES = 64 * 1024;
let retainedTraceVisits = null;

/**
 * Conservative camera volume sweep. A box enclosing the eye and its near plane
 * is swept against voxel AABBs (Minkowski expansion + exact slab intersection).
 * The DDA is only a broad phase; corners between sample rays cannot be missed.
 * minimumDistance is intentionally not a blind zone: even the focus must be safe.
 */
export function resolveCameraCollisionSegment(
  focusX, focusY, focusZ, desiredX, desiredY, desiredZ,
  isBlockedAt, options = {}, out = {},
) {
  const radius = Math.max(0, finiteOr(options.radius, 0.24));
  const skin = Math.max(0, finiteOr(options.skin, 0.1));
  const dx = desiredX - focusX;
  const dy = desiredY - focusY;
  const dz = desiredZ - focusZ;
  const requestedDistance = Math.hypot(dx, dy, dz);
  out.startBlocked = false;
  out.usedFallback = false;
  out.safe = false;
  if (![focusX, focusY, focusZ, desiredX, desiredY, desiredZ].every(Number.isFinite)) {
    return writeResult(out, focusX, focusY, focusZ, 0, true);
  }
  if (typeof isBlockedAt !== "function") {
    out.safe = true;
    return writeResult(out, desiredX, desiredY, desiredZ, requestedDistance, false);
  }
  if (!isCameraVolumeClear(focusX, focusY, focusZ, isBlockedAt, radius)) {
    out.startBlocked = true;
    const fallback = options.fallbackPosition;
    if (fallback && fallback.length >= 3 && fallback.slice(0, 3).every(Number.isFinite)
      && isCameraVolumeClear(fallback[0], fallback[1], fallback[2], isBlockedAt, radius)) {
      out.safe = true;
      out.usedFallback = true;
      return writeResult(out, fallback[0], fallback[1], fallback[2], 0, true);
    }
    // A point already in solid has no legal sweep. Let the caller choose a safe
    // player eye / last-safe position; never label the blocked origin safe.
    return writeResult(out, focusX, focusY, focusZ, 0, true);
  }
  out.safe = true;
  if (requestedDistance <= EPSILON) {
    return writeResult(out, focusX, focusY, focusZ, 0, false);
  }
  const inv = 1 / requestedDistance;
  const ux = dx * inv;
  const uy = dy * inv;
  const uz = dz * inv;
  const hit = traceCameraBox(focusX, focusY, focusZ, ux, uy, uz, requestedDistance, radius, isBlockedAt);
  if (!Number.isFinite(hit)) {
    return writeResult(out, desiredX, desiredY, desiredZ, requestedDistance, false);
  }
  const distance = Math.max(0, Math.min(requestedDistance, hit - skin - EPSILON));
  return writeResult(out, focusX + ux * distance, focusY + uy * distance, focusZ + uz * distance, distance, true);
}

/** Box enclosure is deliberately conservative, including near-plane corners. */
export function isCameraVolumeClear(x, y, z, isBlockedAt, radius = 0.24) {
  if (![x, y, z, radius].every(Number.isFinite)) return false;
  if (typeof isBlockedAt !== "function") return true;
  const r = Math.max(0, radius);
  if (r <= EPSILON) return !isBlockedAt(Math.floor(x), Math.floor(y), Math.floor(z));
  for (let bz = Math.floor(z - r + EPSILON); bz <= Math.floor(z + r - EPSILON); bz += 1) {
    for (let by = Math.floor(y - r + EPSILON); by <= Math.floor(y + r - EPSILON); by += 1) {
      for (let bx = Math.floor(x - r + EPSILON); bx <= Math.floor(x + r - EPSILON); bx += 1) {
        if (isBlockedAt(bx, by, bz)) return false;
      }
    }
  }
  // With radius zero, exact integer coordinates still belong to one voxel.
  return true;
}

function traceCameraBox(x, y, z, ux, uy, uz, maxDistance, radius, blocked) {
  let bx = Math.floor(x);
  let by = Math.floor(y);
  let bz = Math.floor(z);
  const sx = Math.sign(ux), sy = Math.sign(uy), sz = Math.sign(uz);
  const ddx = sx ? Math.abs(1 / ux) : Infinity;
  const ddy = sy ? Math.abs(1 / uy) : Infinity;
  const ddz = sz ? Math.abs(1 / uz) : Infinity;
  let nx = firstBoundaryDistance(x, bx, ux, sx);
  let ny = firstBoundaryDistance(y, by, uy, sy);
  let nz = firstBoundaryDistance(z, bz, uz, sz);
  let travelled = 0;
  let firstHit = Infinity;
  const pad = Math.ceil(radius);
  const visits = borrowTraceVisits(x, y, z, ux, uy, uz, maxDistance, pad);
  const maxIterations = Math.ceil(maxDistance * (Math.abs(ux) + Math.abs(uy) + Math.abs(uz))) + 8;
  try {
    for (let i = 0; i < maxIterations && travelled <= maxDistance + EPSILON; i += 1) {
      for (let oz = -pad; oz <= pad; oz += 1) {
        for (let oy = -pad; oy <= pad; oy += 1) {
          for (let ox = -pad; ox <= pad; ox += 1) {
            const vx = bx + ox, vy = by + oy, vz = bz + oz;
            if (visits) {
              const ix = vx - visits.x, iy = vy - visits.y, iz = vz - visits.z;
              if (ix >= 0 && ix < visits.width && iy >= 0 && iy < visits.height && iz >= 0 && iz < visits.depth) {
                const key = (iz * visits.height + iy) * visits.width + ix;
                if (visits.bytes[key]) continue;
                visits.bytes[key] = 1;
              }
            }
            const distance = rayExpandedVoxel(x, y, z, ux, uy, uz, vx, vy, vz, radius, Math.min(firstHit, maxDistance));
            // Test geometry before asking the potentially expensive world provider.
            if (distance < firstHit && distance <= maxDistance && blocked(vx, vy, vz)) firstHit = distance;
          }
        }
      }
      if (nx <= ny && nx <= nz) { bx += sx; travelled = nx; nx += ddx; }
      else if (ny <= nz) { by += sy; travelled = ny; ny += ddy; }
      else { bz += sz; travelled = nz; nz += ddz; }
      // One voxel halo can hit up to radius before the current center cell.
      if (travelled > firstHit + radius * Math.sqrt(3) + 1) break;
    }
    return firstHit;
  } finally {
    // A nested world provider can start another sweep. Only a released array
    // can be borrowed; retained scratch never exceeds this one bounded array.
    if (visits && (!retainedTraceVisits || visits.bytes.length > retainedTraceVisits.length)) retainedTraceVisits = visits.bytes;
  }
}

function borrowTraceVisits(x, y, z, ux, uy, uz, distance, pad) {
  const ex = x + ux * distance, ey = y + uy * distance, ez = z + uz * distance;
  const minX = Math.floor(Math.min(x, ex)) - pad - 1;
  const minY = Math.floor(Math.min(y, ey)) - pad - 1;
  const minZ = Math.floor(Math.min(z, ez)) - pad - 1;
  const width = Math.floor(Math.max(x, ex)) + pad + 2 - minX;
  const height = Math.floor(Math.max(y, ey)) + pad + 2 - minY;
  const depth = Math.floor(Math.max(z, ez)) + pad + 2 - minZ;
  const size = width * height * depth;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_TRACE_VISIT_BYTES) return null;
  const bytes = retainedTraceVisits?.length >= size ? retainedTraceVisits : new Uint8Array(size);
  retainedTraceVisits = null;
  bytes.fill(0, 0, size);
  return { bytes, x: minX, y: minY, z: minZ, width, height, depth };
}

function rayExpandedVoxel(x, y, z, ux, uy, uz, bx, by, bz, radius, maxDistance) {
  let enter = 0, exit = maxDistance;
  if (Math.abs(ux) < EPSILON) {
    if (x <= bx - radius + EPSILON || x >= bx + 1 + radius - EPSILON) return Infinity;
  } else {
    const a = (bx - radius + EPSILON - x) / ux;
    const b = (bx + 1 + radius - EPSILON - x) / ux;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return Infinity;
  }
  if (Math.abs(uy) < EPSILON) {
    if (y <= by - radius + EPSILON || y >= by + 1 + radius - EPSILON) return Infinity;
  } else {
    const a = (by - radius + EPSILON - y) / uy;
    const b = (by + 1 + radius - EPSILON - y) / uy;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return Infinity;
  }
  if (Math.abs(uz) < EPSILON) {
    if (z <= bz - radius + EPSILON || z >= bz + 1 + radius - EPSILON) return Infinity;
  } else {
    const a = (bz - radius + EPSILON - z) / uz;
    const b = (bz + 1 + radius - EPSILON - z) / uz;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return Infinity;
  }
  return exit < 0 ? Infinity : Math.max(0, enter);
}

function firstBoundaryDistance(origin, voxel, direction, step) {
  return !step ? Infinity : step > 0 ? (voxel + 1 - origin) / direction : (origin - voxel) / -direction;
}
function writeResult(out, x, y, z, distance, collided) {
  out.x = x; out.y = y; out.z = z; out.distance = distance; out.collided = collided;
  return out;
}
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
