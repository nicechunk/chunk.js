import { blockDef, blockDefs } from "./block-registry.js";
import {
  assertExplicitGenerationVersion,
  assertExplicitResourceRuleVersion,
  assertReconstructionSeed,
  assertWorldCoordinates,
  getBlockAt,
} from "./world-generator.js";

export function getResourceAt(
  worldSeed,
  worldX,
  worldY,
  worldZ,
  resourceRuleVersion,
  options = {},
) {
  const normalizedSeed = assertReconstructionSeed(worldSeed);
  const coordinates = assertWorldCoordinates(worldX, worldY, worldZ);
  const normalizedResourceRuleVersion = assertExplicitResourceRuleVersion(resourceRuleVersion);
  const generationVersion = assertExplicitGenerationVersion(options.generationVersion);
  const blockId = options.blockId ?? getBlockAt(
    normalizedSeed,
    coordinates.worldX,
    coordinates.worldY,
    coordinates.worldZ,
    generationVersion,
    options,
  );
  if (!Number.isInteger(blockId) || !Object.hasOwn(blockDefs, blockId)) {
    throw new RangeError(`Unsupported block ID ${String(blockId)} for resource rule version ${normalizedResourceRuleVersion}.`);
  }
  const def = blockDef(blockId);
  return {
    resourceId: def.resourceId,
    blockId,
    generationVersion,
    resourceRuleVersion: normalizedResourceRuleVersion,
  };
}
