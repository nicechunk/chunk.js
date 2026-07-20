import { blockDef } from "./block-registry.js";
import { DEFAULT_GENERATION_VERSION, getBlockAt } from "./world-generator.js";

export function getResourceAt(worldSeed, worldX, worldY, worldZ, resourceRuleVersion = 1, options = {}) {
  const generationVersion = Math.trunc(options.generationVersion ?? DEFAULT_GENERATION_VERSION);
  const blockId = options.blockId ?? getBlockAt(worldSeed, worldX, worldY, worldZ, generationVersion, options);
  const def = blockDef(blockId);
  return {
    resourceId: def.resourceId,
    blockId,
    generationVersion,
    resourceRuleVersion,
  };
}
