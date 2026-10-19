import { cameraOrigin, cameraViewProjection } from "./camera.js";

const meshBoundsCache = new WeakMap();

/** Rendering, build priority and initial coverage share the camera target radius. */
export function cameraRenderCenterChunk(cameraState, chunkSize = 16) {
  const size = Math.max(1, Math.trunc(chunkSize || 16));
  const target = Number.isFinite(cameraState?.targetWorldX) && Number.isFinite(cameraState?.targetWorldZ);
  const x = target ? Math.trunc(cameraState.targetWorldX || 0) + (cameraState.targetLocalOffsetX || 0)
    : Math.trunc(cameraState?.worldX || 0) + (cameraState?.localOffsetX || 0);
  const z = target ? Math.trunc(cameraState.targetWorldZ || 0) + (cameraState.targetLocalOffsetZ || 0)
    : Math.trunc(cameraState?.worldZ || 0) + (cameraState?.localOffsetZ || 0);
  return { chunkX: Math.floor(x / size), chunkZ: Math.floor(z / size) };
}

export function visibleByDistance(chunk, cameraState, chunkSize, viewDistance) {
  const eyeX = (cameraState.worldX || 0) + (cameraState.localOffsetX || 0);
  const eyeZ = (cameraState.worldZ || 0) + (cameraState.localOffsetZ || 0);
  const minX = chunk.chunkX * chunkSize, minZ = chunk.chunkZ * chunkSize;
  const dx = Math.max(minX - eyeX, 0, eyeX - minX - chunkSize);
  const dz = Math.max(minZ - eyeZ, 0, eyeZ - minZ - chunkSize);
  const maxDistance = (viewDistance + 1) * chunkSize;
  return dx * dx + dz * dz <= maxDistance * maxDistance;
}

export function filterChunksByCameraFrustum(chunks, cameraState) {
  const list = Array.isArray(chunks) ? chunks : Array.from(chunks ?? []);
  if (!cameraState || !list.length) return list;
  const frustum = prepareCameraFrustum(cameraState);
  return list.filter((chunk) => {
    // Keep legacy callers with no committed geometry or declared bounds safe.
    if (chunk?.frustumCullEligible !== true && !chunk?.mesh && !chunk?.renderBounds) return true;
    return boundsIntersectPreparedFrustum(chunkWorldBounds(chunk), frustum);
  });
}

export function chunkIntersectsCameraFrustum(chunk, cameraState, prepared = null) {
  return !cameraState || boundsIntersectPreparedFrustum(chunkWorldBounds(chunk), prepared ?? prepareCameraFrustum(cameraState));
}

export function aabbIntersectsCameraFrustum(bounds, cameraState) {
  return !cameraState || boundsIntersectPreparedFrustum(bounds, prepareCameraFrustum(cameraState));
}

export function prepareCameraFrustum(cameraState) {
  const matrix = cameraViewProjection(cameraState);
  const origin = cameraOrigin(cameraState);
  const planes = [];
  // Actual clip-space planes; pitch, roll/target, aspect, near and far use the
  // same projection as rendering. All arithmetic is camera-origin relative.
  for (const row of [0, 1, 2]) {
    for (const sign of [1, -1]) {
      const a = matrix[3] + sign * matrix[row];
      const b = matrix[7] + sign * matrix[4 + row];
      const c = matrix[11] + sign * matrix[8 + row];
      const d = matrix[15] + sign * matrix[12 + row];
      const length = Math.hypot(a, b, c);
      if (length > 1e-12) planes.push([a / length, b / length, c / length, d / length]);
    }
  }
  return { planes, origin };
}

function boundsIntersectPreparedFrustum(bounds, { planes, origin }) {
  if (!validBounds(bounds)) return true;
  const minX = bounds.minX - origin.worldX, maxX = bounds.maxX - origin.worldX;
  const minY = bounds.minY - origin.worldY, maxY = bounds.maxY - origin.worldY;
  const minZ = bounds.minZ - origin.worldZ, maxZ = bounds.maxZ - origin.worldZ;
  for (const [a, b, c, d] of planes) {
    const x = a >= 0 ? maxX : minX, y = b >= 0 ? maxY : minY, z = c >= 0 ? maxZ : minZ;
    // Conservative tolerance for float32 projection and surfaces exactly on a plane.
    if (a * x + b * y + c * z + d < -0.001) return false;
  }
  return true;
}

/** World-space bounds of committed channels; never infer geometry from column tops. */
export function chunkWorldBounds(chunk) {
  if (validBounds(chunk?.renderBounds)) return chunk.renderBounds;
  const chunkSize = Number(chunk?.chunkSize);
  const ox = Number(chunk?.chunkX) * chunkSize;
  const oz = Number(chunk?.chunkZ) * chunkSize;
  if (![chunkSize, ox, oz].every(Number.isFinite) || chunkSize <= 0) return null;
  let bounds = null;
  const summaries = [chunk?.mesh, chunk?.visualMesh];
  const summarized = summaries.some(mesh => mesh?.sectionSummary)
    && summaries.every(mesh => !mesh || !mesh.sectionSummary || mesh.bounds || mesh.vertexCount === 0);
  const channels = summarized ? summaries.filter(mesh => !mesh?.sectionSummary || mesh.bounds)
    : summaries.filter(mesh => !mesh?.sectionSummary);
  if (!summarized) for (const section of (chunk?.renderSections ?? chunk?.sections)?.values?.() ?? []) channels.push(section.mesh, section.visualMesh);
  for (const mesh of channels) {
    const local = committedMeshBounds(mesh);
    if (!local) continue;
    const originY = mesh.sectionSummary ? 0 : Number(mesh.originY) || 0;
    bounds = unionBounds(bounds, {
      minX: ox + local.minX, maxX: ox + local.maxX,
      minY: originY + local.minY, maxY: originY + local.maxY,
      minZ: oz + local.minZ, maxZ: oz + local.maxZ,
    });
  }
  if (bounds) return bounds;
  // Building manifests currently carry sphere bounds. Retain that conservative
  // extent for compatibility, including models that extend beyond a nominal cell.
  const sphere = chunk?.frustumBounds;
  if (sphere && [sphere.centerX, sphere.centerY, sphere.centerZ, sphere.radius].every(Number.isFinite) && sphere.radius > 0) {
    return {
      minX: sphere.centerX - sphere.radius, maxX: sphere.centerX + sphere.radius,
      minY: sphere.centerY - sphere.radius, maxY: sphere.centerY + sphere.radius,
      minZ: sphere.centerZ - sphere.radius, maxZ: sphere.centerZ + sphere.radius,
    };
  }
  const minY = Number(chunk?.minY), height = Number(chunk?.height);
  if (![minY, height].every(Number.isFinite) || height <= 0) return null;
  return { minX: ox - 0.25, maxX: ox + chunkSize + 0.25, minY: minY - 0.25,
    maxY: minY + height + 0.25, minZ: oz - 0.25, maxZ: oz + chunkSize + 0.25 };
}

function committedMeshBounds(mesh) {
  if (!mesh || typeof mesh !== "object") return null;
  if (validBounds(mesh.bounds)) return mesh.bounds;
  const vertices = mesh.vertices;
  const revision = mesh.commitToken ?? mesh.revision ?? mesh.meshVersion;
  const cached = meshBoundsCache.get(mesh);
  if (cached && cached.vertices === vertices && cached.revision === revision) return cached.bounds;
  if (!ArrayBuffer.isView(vertices) || !vertices.byteLength) return null;
  const float = mesh.positionType === "float32" || vertices instanceof Float32Array;
  const stride = Number(mesh.vertexStrideBytes) || (float ? 40 : 20);
  const scale = Number(mesh.positionScale) || 64;
  if (stride < (float ? 12 : 6) || vertices.byteLength % stride) return null;
  const data = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let offset = 0; offset < vertices.byteLength; offset += stride) {
    const vertexScale = float ? 1 : Math.max(1, data.getInt16(offset + 6, true) || scale);
    const x = float ? data.getFloat32(offset, true) : data.getInt16(offset, true) / vertexScale;
    const y = float ? data.getFloat32(offset + 4, true) : data.getInt16(offset + 2, true) / vertexScale;
    const z = float ? data.getFloat32(offset + 8, true) : data.getInt16(offset + 4, true) / vertexScale;
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  if (!validBounds(bounds)) return null;
  meshBoundsCache.set(mesh, { vertices, revision, bounds });
  return bounds;
}
function validBounds(bounds) {
  return bounds && [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ].every(Number.isFinite)
    && bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY && bounds.minZ <= bounds.maxZ;
}
function unionBounds(a, b) {
  if (!a) return { ...b };
  return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) };
}
