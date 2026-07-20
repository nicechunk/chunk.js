// Browser entry used by /play. Keep this list explicit: native ESM evaluates
// every re-export, so the general chunk.js barrel would also fetch forge code.
export {
  BLOCK_FLAGS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MESH_BUDGET_MS,
} from "./core/constants.js";
export { chunkId, worldToChunk } from "./core/coordinates.js";
export {
  BLOCK_ID,
  RESOURCE_ID,
  blockDef,
  isBlockingBlock,
  isFluidBlock,
  isMineableBlock,
} from "./world/block-registry.js";
export {
  createWorldGeneratorConfig,
  surfaceBlockAt,
  terrainSurfaceHeight,
  waterLevelAt,
} from "./world/world-generator.js";
export {
  compileSurfaceDecorationRules,
  resolveSurfaceDecoration,
  surfaceDecorationName,
  surfaceDecorationVariantHash,
} from "./world/surface-decoration-rules.js";
export { ChunkManager } from "./chunk/chunk-manager.js";
export {
  decodeNcm3,
  encodeNcm3,
  payloadByteLength,
} from "./ncm/blueprint-codec.js";
export {
  NCM4_ACTION_IDS,
  NCM4_ACTIONS,
  NCM4_BONE_IDS,
  NCM4_BONES,
  NCM4_MAX_PAYLOAD_BYTES,
  NCM4_ROTATION_STEP_RADIANS,
  NCM4_TICKS_PER_SECOND,
  decodeNcm4,
  encodeNcm4,
  ncm4PayloadByteLength,
} from "./ncm/character-codec.js";
export {
  BUILDING_QUARTER_TURNS,
  buildingFootprint,
  createBuildingPlacement,
  parseNcm3Building,
} from "./construction/building-parser.js";
export {
  buildingChunkCollisionTopAt,
  buildingChunkHasCollisionAt,
  createBuildingChunkMeshes,
} from "./construction/building-mesher.js";
export { createBuildingMeshWorkerClient } from "./construction/building-mesh-client.js";
export {
  RESOURCE_DROP_MODEL_BLOCK_IDS,
  createResourceDropPreviewMesh,
  hasResourceDropPreviewModel,
} from "./chunk/chunk-mesher.js";
export { createCameraState, cameraForward } from "./renderer/camera.js";
export { filterChunksByCameraFrustum } from "./renderer/frustum.js";
export {
  WebGL2VoxelRenderer,
  detectWebGl2Support,
} from "./renderer/webgl2-renderer.js";
export {
  blockColor,
  createVoxelItemIconCanvas,
  renderVoxelItemIconYaw,
  resourceName,
  voxelItemLabel,
} from "./renderer/item-preview.js";
export {
  SMELTING_MATERIAL_MODEL_IDS,
  createSmeltingMaterialPreviewMesh,
  hasSmeltingMaterialPreviewModel,
  smeltingMaterialModelDefinition,
} from "./renderer/smelting-material-models.js";
export { loadPeasantGuyAvatarMesh } from "./renderer/avatar-mesh.js";
export { createForgedWorldItemMesh } from "./renderer/forged-world-mesh.js";
export { createAvatarPreviewRenderer } from "./renderer/avatar-preview.js";
export { createSmeltingCoreRenderer } from "./renderer/smelting-core.js";
export { ThirdPersonPlayerControls } from "./input/controls.js";
export {
  createCollisionBox,
  maxCollisionHorizontalExtent,
  prepareCollisionBoxes,
  preparedCollisionBoxIntersectsBlock,
  preparedCollisionFootprintIntersectsBlock,
} from "./input/collision.js";
export { resolveCameraCollisionSegment } from "./input/camera-collision.js";
export { raycastBlock, raycastBlockFromScreen } from "./input/raycast.js";
export { createAvatarToolCollisionResolver } from "./physics/voxel-item-collision.js";
export { inspectBlock } from "./debug/block-inspector.js";
export { RenderLog } from "./debug/render-log.js";
export { FrameStatsCounter } from "./debug/stats.js";
