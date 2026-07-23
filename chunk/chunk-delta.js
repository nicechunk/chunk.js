import { WORLD_GENERATOR_LIMITS } from "../world/world-generator.js";

export const DELTA_PROTOCOL_LIMITS = Object.freeze({
  minWorldXZ: -2_147_483_648,
  maxWorldXZ: 2_147_483_647,
  minWorldY: -32_768,
  maxWorldY: 32_767,
  minBlockId: 0,
  maxBlockId: 65_535,
});

// These are runtime resource ceilings, not coordinate/proof semantics. Keep
// them separate from DELTA_PROTOCOL_LIMITS so raising a memory budget cannot be
// mistaken for a protocol-version change.
export const DELTA_RESOURCE_LIMITS = Object.freeze({
  maxBatchEntries: 262_144,
  maxBatchChunks: 2_048,
  maxResidentEntriesPerChunk: 262_144,
  maxWorkerPayloadEntries: 262_144,
});

export function normalizeDelta(delta, chunkSize) {
  if (!delta || typeof delta !== "object") throw new TypeError("Chunk delta must be an object.");
  const size = boundedInteger(
    chunkSize,
    WORLD_GENERATOR_LIMITS.minChunkSize,
    WORLD_GENERATOR_LIMITS.maxChunkSize,
    "chunk size",
  );
  const worldX = boundedInteger(delta.worldX, DELTA_PROTOCOL_LIMITS.minWorldXZ, DELTA_PROTOCOL_LIMITS.maxWorldXZ, "world X");
  const worldY = boundedInteger(delta.worldY, DELTA_PROTOCOL_LIMITS.minWorldY, DELTA_PROTOCOL_LIMITS.maxWorldY, "world Y");
  const worldZ = boundedInteger(delta.worldZ, DELTA_PROTOCOL_LIMITS.minWorldXZ, DELTA_PROTOCOL_LIMITS.maxWorldXZ, "world Z");
  const blockId = boundedInteger(delta.blockId, DELTA_PROTOCOL_LIMITS.minBlockId, DELTA_PROTOCOL_LIMITS.maxBlockId, "block ID");
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
    blockId,
    txId: delta.txId ?? null,
    source: delta.source ?? "unknown",
  };
}

export function deltaKey(localX, localY, localZ, chunkSize = 16) {
  const size = Math.max(1, Math.trunc(Number(chunkSize) || 16));
  return Math.trunc(localY) * size * size + Math.trunc(localZ) * size + Math.trunc(localX);
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
