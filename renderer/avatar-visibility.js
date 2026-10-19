import { aabbIntersectsCameraFrustum, prepareCameraFrustum } from './frustum.js';

const envelopes = new WeakMap();

// Rotation about p satisfies |p + R(v-p)| <= |v| + 2|p|.
// Include every equipment/group and NCM4 parent in the envelope before pose
// generation. Visibility may over-include; it must never clip animated reach.
export function avatarAnimationRadius(mesh, vertices = mesh?.vertices) {
  if (!mesh || !(vertices instanceof Float32Array)) return null;
  let cached = envelopes.get(mesh);
  if (!cached || cached.vertices !== vertices || cached.parts !== mesh.parts) {
    const stride = (mesh.vertexStrideBytes || 40) / 4;
    let base = 0;
    for (let i = 0; i < vertices.length; i += stride) base = Math.max(base, Math.hypot(vertices[i], vertices[i + 1], vertices[i + 2]));
    const partRadii = [];
    for (const part of mesh.parts ?? []) {
      if ([part.cx, part.cy, part.cz, part.sx, part.sy, part.sz].every(Number.isFinite)) {
        const radius = Math.hypot(Math.abs(part.cx) + Math.abs(part.sx) / 2,
          Math.abs(part.cy) + Math.abs(part.sy) / 2, Math.abs(part.cz) + Math.abs(part.sz) / 2);
        partRadii.push(radius); base = Math.max(base, radius);
      } else partRadii.push(base);
    }
    cached = { vertices, parts: mesh.parts, base, partRadii };
    envelopes.set(mesh, cached);
  }
  let radius = cached.base;
  if (mesh.format === 'NCM4') {
    const bones = mesh.skeleton?.bones;
    if (!Array.isArray(bones)) return null;
    for (let i = 0; i < (mesh.parts?.length ?? 0); i++) {
      let reach = cached.partRadii[i] ?? cached.base, bone = mesh.parts[i].boneIndex;
      for (let depth = 0; bone >= 0 && depth < bones.length; depth++) {
        const node = bones[bone]; if (!node) break;
        if (!node.pivot?.every(Number.isFinite)) return null;
        reach += 2 * Math.hypot(...node.pivot); bone = node.parent;
      }
      radius = Math.max(radius, reach);
    }
  } else if (mesh.parts?.length) {
    let pivot = 0, offset = 0;
    for (const p of Object.values(mesh.pivots ?? {})) { if (!p?.every(Number.isFinite)) return null; pivot = Math.max(pivot, Math.hypot(...p)); }
    for (const p of Object.values(mesh.boneOffsets ?? {})) { if (!p?.every(Number.isFinite)) return null; offset = Math.max(offset, Math.hypot(...p)); }
    // The current cloth displacement is <= (1 + .42) * .042 * 2.
    radius += 2 * pivot + offset + .12;
  }
  return Number.isFinite(radius) ? radius + .01 : null;
}

export function selectVisibleAvatars(avatars, camera, entryForAvatar, output = []) {
  output.length = 0;
  const frustum = camera ? prepareCameraFrustum(camera) : null;
  for (const avatar of avatars) {
    if (Math.max(0, Math.min(1, Number(avatar.opacity ?? 1) || 0)) <= .001) continue;
    const entry = entryForAvatar(avatar); if (!entry?.handle) continue;
    const radius = avatarAnimationRadius(entry.mesh, entry.handle.drawVertices ?? entry.mesh?.vertices);
    if (radius == null || !camera) { output.push(avatar); continue; }
    const x = (avatar.worldX || 0) + (avatar.localOffsetX || 0),
      y = (avatar.worldY || 0) + (avatar.localOffsetY || 0),
      z = (avatar.worldZ || 0) + (avatar.localOffsetZ || 0);
    if (aabbIntersectsCameraFrustum({ minX: x - radius, maxX: x + radius,
      minY: y - radius, maxY: y + radius, minZ: z - radius, maxZ: z + radius }, camera, frustum)) output.push(avatar);
  }
  return output;
}
