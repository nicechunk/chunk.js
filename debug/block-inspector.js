import { worldToChunk } from "../core/coordinates.js";
import { blockDef } from "../world/block-registry.js";

export function inspectBlock(worldState, worldX, worldY, worldZ) {
  const coord = worldToChunk(worldX, worldY, worldZ, worldState.chunkSize);
  const chunk = worldState.chunks?.get?.(coord.chunkId);
  const blockId = worldState.getBlockAtWorld(coord.worldX, coord.worldY, coord.worldZ);
  const def = blockDef(blockId);
  const key = `${coord.localX},${coord.localY},${coord.localZ}`;
  return {
    worldX: coord.worldX,
    worldY: coord.worldY,
    worldZ: coord.worldZ,
    chunkX: coord.chunkX,
    chunkZ: coord.chunkZ,
    localX: coord.localX,
    localY: coord.localY,
    localZ: coord.localZ,
    blockId,
    blockName: def.name,
    resourceId: def.resourceId,
    materialId: def.materialId,
    generationVersion: chunk?.generationVersion ?? worldState.generationVersion,
    resourceRuleVersion: chunk?.resourceRuleVersion ?? worldState.resourceRuleVersion,
    revealState: chunk?.revealStateAt?.(coord.localX, coord.localY, coord.localZ) ?? null,
    fromBaseWorld: Boolean(chunk && !chunk.chainDeltas.has(key) && !chunk.pendingDeltas.has(key)),
    fromChainDelta: Boolean(chunk?.chainDeltas.has(key)),
    pending: Boolean(chunk?.pendingDeltas.has(key)),
    pda: null,
    txHash: chunk?.pendingDeltas.get(key)?.txId ?? null,
  };
}
