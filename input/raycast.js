import { worldToChunk } from "../core/coordinates.js";
import { blockDef, BLOCK_ID, isBlockingBlock, isLowVegetationBlock } from "../world/block-registry.js";
import { getResourceAt } from "../world/resource-oracle.js";
import { cameraForward } from "../renderer/camera.js";

export function raycastBlock(cameraState, direction = null, maxDistance = 6, worldState) {
  if (!worldState?.getBlockAtWorld) throw new Error("raycastBlock requires a worldState with getBlockAtWorld().");
  const dir = normalize(direction ?? cameraForward(cameraState));
  const origin = cameraWorldFloat(cameraState);
  let x = Math.floor(origin[0]);
  let y = Math.floor(origin[1]);
  let z = Math.floor(origin[2]);
  const stepX = dir[0] > 0 ? 1 : -1;
  const stepY = dir[1] > 0 ? 1 : -1;
  const stepZ = dir[2] > 0 ? 1 : -1;
  const tDeltaX = dir[0] === 0 ? Infinity : Math.abs(1 / dir[0]);
  const tDeltaY = dir[1] === 0 ? Infinity : Math.abs(1 / dir[1]);
  const tDeltaZ = dir[2] === 0 ? Infinity : Math.abs(1 / dir[2]);
  let tMaxX = intBound(origin[0], dir[0]);
  let tMaxY = intBound(origin[1], dir[1]);
  let tMaxZ = intBound(origin[2], dir[2]);
  let travelled = 0;
  let face = [0, 0, 0];

  while (travelled <= maxDistance) {
    const blockId = worldState.getBlockAtWorld(x, y, z);
    if (blockId !== BLOCK_ID.air && (!isLowVegetationBlock(blockId) || isBlockingBlock(blockId))) {
      const coord = worldToChunk(x, y, z, worldState.chunkSize);
      const block = blockDef(blockId);
      const resource = getResourceAt(worldState.worldSeed, x, y, z, worldState.resourceRuleVersion, { blockId });
      return {
        hit: true,
        worldX: x,
        worldY: y,
        worldZ: z,
        chunkX: coord.chunkX,
        chunkZ: coord.chunkZ,
        chunkId: coord.chunkId,
        localX: coord.localX,
        localY: coord.localY,
        localZ: coord.localZ,
        blockId,
        resourceId: resource.resourceId,
        materialId: block.materialId,
        faceX: face[0],
        faceY: face[1],
        faceZ: face[2],
        distance: travelled,
      };
    }
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        x += stepX;
        travelled = tMaxX;
        tMaxX += tDeltaX;
        face = [-stepX, 0, 0];
      } else {
        z += stepZ;
        travelled = tMaxZ;
        tMaxZ += tDeltaZ;
        face = [0, 0, -stepZ];
      }
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      travelled = tMaxY;
      tMaxY += tDeltaY;
      face = [0, -stepY, 0];
    } else {
      z += stepZ;
      travelled = tMaxZ;
      tMaxZ += tDeltaZ;
      face = [0, 0, -stepZ];
    }
  }
  return { hit: false };
}

export function raycastBlockFromScreen(cameraState, clientX, clientY, canvas, maxDistance = 6, worldState) {
  const direction = screenRayDirection(cameraState, clientX, clientY, canvas);
  return raycastBlock(cameraState, direction, maxDistance, worldState);
}

export function screenRayDirection(cameraState, clientX, clientY, canvas) {
  const rect = canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
  const width = Math.max(1, rect.width || canvas?.clientWidth || 1);
  const height = Math.max(1, rect.height || canvas?.clientHeight || 1);
  const ndcX = ((Number(clientX) - rect.left) / width) * 2 - 1;
  const ndcY = 1 - ((Number(clientY) - rect.top) / height) * 2;
  const forward = normalize(cameraForward(cameraState));
  const worldUp = [0, 1, 0];
  let right = cross(forward, worldUp);
  if (lengthSq(right) < 0.000001) right = [1, 0, 0];
  right = normalize(right);
  const up = normalize(cross(right, forward));
  const fov = ((Number(cameraState?.fov) || 58) * Math.PI) / 180;
  const aspect = Number(cameraState?.aspect) || (width / height) || 1;
  const halfHeight = Math.tan(fov * 0.5);
  const halfWidth = halfHeight * aspect;
  return normalize([
    forward[0] + right[0] * ndcX * halfWidth + up[0] * ndcY * halfHeight,
    forward[1] + right[1] * ndcX * halfWidth + up[1] * ndcY * halfHeight,
    forward[2] + right[2] * ndcX * halfWidth + up[2] * ndcY * halfHeight,
  ]);
}

export function cameraWorldFloat(cameraState) {
  return [
    Math.trunc(cameraState.worldX || 0) + (cameraState.localOffsetX || 0),
    Math.trunc(cameraState.worldY || 0) + (cameraState.localOffsetY || 0),
    Math.trunc(cameraState.worldZ || 0) + (cameraState.localOffsetZ || 0),
  ];
}

function intBound(s, ds) {
  if (ds === 0) return Infinity;
  const value = ds > 0 ? Math.ceil(s) - s : s - Math.floor(s);
  return value === 0 ? Math.abs(1 / ds) : value / Math.abs(ds);
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function lengthSq(v) {
  return v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
}
