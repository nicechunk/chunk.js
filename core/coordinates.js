import { DEFAULT_CHUNK_SIZE } from "./constants.js";

export function chunkId(chunkX, chunkZ) {
  return `${Math.trunc(chunkX)},${Math.trunc(chunkZ)}`;
}

export function worldToChunk(worldX, worldY = 0, worldZ = 0, chunkSize = DEFAULT_CHUNK_SIZE) {
  const x = Math.trunc(worldX);
  const y = Math.trunc(worldY);
  const z = Math.trunc(worldZ);
  const chunkX = divFloor(x, chunkSize);
  const chunkZ = divFloor(z, chunkSize);
  return {
    worldX: x,
    worldY: y,
    worldZ: z,
    chunkX,
    chunkZ,
    localX: positiveModulo(x, chunkSize),
    localY: y,
    localZ: positiveModulo(z, chunkSize),
    chunkId: chunkId(chunkX, chunkZ),
  };
}

export function chunkToWorld(chunkX, chunkZ, localX, localY = 0, localZ = 0, chunkSize = DEFAULT_CHUNK_SIZE) {
  return {
    worldX: Math.trunc(chunkX) * chunkSize + Math.trunc(localX),
    worldY: Math.trunc(localY),
    worldZ: Math.trunc(chunkZ) * chunkSize + Math.trunc(localZ),
  };
}

export function worldToRenderPosition(worldX, worldY, worldZ, cameraOrigin = { worldX: 0, worldY: 0, worldZ: 0 }) {
  return [
    Math.trunc(worldX) - Math.trunc(cameraOrigin.worldX || 0),
    Math.trunc(worldY) - Math.trunc(cameraOrigin.worldY || 0),
    Math.trunc(worldZ) - Math.trunc(cameraOrigin.worldZ || 0),
  ];
}

export function localIndex(localX, localY, localZ, { chunkSize = DEFAULT_CHUNK_SIZE, minY = 0, height } = {}) {
  const y = Math.trunc(localY) - Math.trunc(minY);
  return Math.trunc(localX) + chunkSize * (y + Math.trunc(height) * Math.trunc(localZ));
}

export function containsLocal(localX, localY, localZ, { chunkSize = DEFAULT_CHUNK_SIZE, minY = 0, height } = {}) {
  const x = Math.trunc(localX);
  const y = Math.trunc(localY);
  const z = Math.trunc(localZ);
  return x >= 0 && z >= 0 && x < chunkSize && z < chunkSize && y >= minY && y < minY + height;
}

export function divFloor(value, divisor) {
  return Math.floor(Math.trunc(value) / Math.trunc(divisor));
}

export function positiveModulo(value, divisor) {
  const d = Math.trunc(divisor);
  return ((Math.trunc(value) % d) + d) % d;
}
