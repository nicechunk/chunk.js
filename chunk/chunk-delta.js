import { BLOCK_ID } from "../world/block-registry.js";

export function normalizeDelta(delta, chunkSize) {
  const size = Math.max(1, Math.trunc(Number(chunkSize) || 16));
  const worldX = Math.trunc(delta.worldX);
  const worldY = Math.trunc(delta.worldY);
  const worldZ = Math.trunc(delta.worldZ);
  const chunkX = Math.floor(worldX / size);
  const chunkZ = Math.floor(worldZ / size);
  return {
    worldX,
    worldY,
    worldZ,
    chunkX,
    chunkZ,
    localX: worldX - chunkX * size,
    localY: worldY,
    localZ: worldZ - chunkZ * size,
    blockId: Number.isInteger(delta.blockId) ? delta.blockId : BLOCK_ID.air,
    txId: delta.txId ?? null,
    source: delta.source ?? "unknown",
  };
}

export function deltaKey(localX, localY, localZ, chunkSize = 16) {
  const size = Math.max(1, Math.trunc(Number(chunkSize) || 16));
  return Math.trunc(localY) * size * size + Math.trunc(localZ) * size + Math.trunc(localX);
}
