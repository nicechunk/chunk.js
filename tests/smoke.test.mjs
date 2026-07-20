import assert from "node:assert/strict";
import {
  BLOCK_ID,
  CACTUS_MODEL_HEIGHT_SCALE,
  CACTUS_MODEL_MAX_Y,
  CACTUS_MODEL_PARTS,
  CACTUS_MODEL_TRIANGLE_COUNT,
  blockDef,
  blockMaterialIdForFace,
  ChunkManager,
  CHUNK_VERTEX_STRIDE_BYTES,
  WebGL2VoxelRenderer,
  WebGl2VoxelRenderer,
  buildCloudDebugAsset,
  buildDebugVisualModelAssets,
  bakeForgeComponentsToAppearance,
  buildForgeCuboidMesh,
  buildForgeDesignMesh,
  aabbIntersectsAabb,
  createAvatarToolCollisionResolver,
  createBlockAabb,
  createWorldGeneratorConfig,
  createSurfaceDecorationPreviewMesh,
  DEFAULT_COMPILED_SURFACE_DECORATION_RULES,
  DEFAULT_FORGE_BENCH_CUBOIDS,
  createCollisionBox,
  createEquipmentModelParts,
  createAvatarMeshFromNcm,
  createCameraState,
  createForgeComponent,
  createForgeDesign,
  createForgeMaterialProof,
  createForgeWorkbenchComponent,
  createForgeWorkbenchDesign,
  createForgeWorkbenchMaterial,
  decodeNcf1,
  decodeNcf1EquipmentHeader,
  detectWebGl2Support,
  encodeNcf1,
  encodeCompactNcf1,
  encodeCompactNcf1Bytes,
  encodeNcf1Bytes,
  EQUIPMENT_MODEL_ID,
  forgeBytesToCode,
  forgeChainDesignHash,
  forgeCodeToBytes,
  forgeCompactAttributeScore,
  forgeComponentOccupiedBoundsQ2,
  forgeComponentSolidFraction,
  forgeDesignStatsVector,
  forgeMaterialRequirements,
  forgeMaterialScoreFromCompactAttributes,
  forgeRawDesignHash,
  forgeWorkbenchEquipment,
  forgeWorkbenchComponentOffsetQ,
  forgeWorkbenchPhysicalAdvisory,
  forgeWorkbenchStats,
  forgeWorkbenchToolOptionsFromHit,
  forgeVoxelIndex,
  ForgeWorkbenchRenderer,
  FORGE_ATTRIBUTE_KEYS,
  FORGE_COMPONENT_GRID,
  FORGE_MACHINING_STATE_KIND,
  FORGE_WORKBENCH_INHERITANCE_MODE,
  FORGE_WORKBENCH_MAX_COMPONENTS,
  gripForgeComponent,
  hammerForgeComponent,
  FORGE_MESH_VERTEX_STRIDE_BYTES,
  FORGE_TOOL_VISUAL_IDS,
  createForgeToolVisualMesh,
  createForgeTransformGizmoMesh,
  createForgeConstructionReticleMesh,
  forgeToolActionDuration,
  forgeAxisDragPlaneNormal,
  intersectRayPlane,
  pickForgeAxisGizmoRay,
  sampleForgeToolVisualPose,
  getBlockAt,
  getBakedBlockFaceTile,
  getResourceAt,
  inspectBlock,
  isBlockingBlock,
  isLowVegetationBlock,
  isMineableBlock,
  isOpaqueSolidBlock,
  isVisualBlock,
  MATERIAL_ID,
  materialDef,
  NCF1_MAX_RAW_BYTES,
  normalizeForgeComponent,
  normalizeForgeWorkbench,
  paintForgeComponent,
  parseForgeMaterialProfile,
  pickForgeMeshRay,
  prepareCollisionBoxes,
  POSITION_PACK_SCALE,
  preparedCollisionBoxIntersectsBlock,
  compareForgeMaterialCapacity,
  raycastBlock,
  resolveSurfaceDecoration,
  resolveForgeToolFootprint,
  resolveAvatarNcmCode,
  RESOURCE_ID,
  surfaceBlockAt,
  SURFACE_DECORATION_ID,
  surfaceDecorationName,
  sumForgeMaterialCapacities,
  selectCompactNcf1Encoding,
  sawForgeComponent,
  drillForgeComponent,
  taperForgeComponent,
  rotateForgeComponent,
  restoreForgeMachiningState,
  serializeForgeMachiningState,
  translateForgeComponent,
  terrainSurfaceHeight,
  TextureArrayManager,
  updateAvatarMeshVertices,
  validateNcf1,
  verifyForgeMaterialProof,
  waterLevelAt,
} from "../index.js";

const chunks = new ChunkManager({ viewDistance: 1, height: 64, minY: -16 });
chunks.updatePlayerPosition(0, 24, 0);
const rebuilt = chunks.rebuildDirtyChunks(100);
assert.ok(rebuilt.length > 0, "dirty chunk rebuild should produce meshes");
const chunk = rebuilt[0];
assert.ok(chunk.mesh.vertexCount > 0, "chunk mesh should contain vertices");
assert.equal(chunk.mesh.vertices.byteLength, chunk.mesh.vertexCount * chunk.mesh.vertexStrideBytes, "packed vertex stride should stay stable");
assert.ok(chunk.mesh.triangleCount > 0, "chunk mesh should contain triangles");

const visibilityChunks = new ChunkManager({ viewDistance: 3, height: 64, minY: -16, useWorkers: false, visibilityLingerFrames: 2 });
const edgeVisibleChunk = visibilityChunks.ensureChunk(0, 3);
edgeVisibleChunk.mesh = { vertexCount: 1, triangleCount: 1 };
const distanceEdgeChunk = visibilityChunks.ensureChunk(0, 4);
distanceEdgeChunk.mesh = { vertexCount: 1, triangleCount: 1 };
const visibleCamera = createCameraState({ worldX: 0, worldY: 24, worldZ: 0, yaw: 0, pitch: 0, fov: 50, aspect: 1 });
assert.ok(visibilityChunks.getVisibleChunks(visibleCamera).some((candidate) => candidate.id === edgeVisibleChunk.id), "edge chunk should be visible while inside the camera cone");
visibilityChunks.getVisibleChunks(createCameraState({ worldX: 0, worldY: 24, worldZ: 16, yaw: 0, pitch: 0, fov: 50, aspect: 1 }));
assert.equal(visibilityChunks.getVisibleChunks(visibleCamera).some((candidate) => candidate.id === distanceEdgeChunk.id), false, "chunks outside the render radius must not linger because they flicker at the radius boundary");
const awayCamera = createCameraState({ worldX: 0, worldY: 24, worldZ: 0, yaw: Math.PI, pitch: 0, fov: 50, aspect: 1 });
assert.ok(visibilityChunks.getVisibleChunks(awayCamera).some((candidate) => candidate.id === edgeVisibleChunk.id), "edge chunk should linger briefly after leaving the cone to avoid far-distance flicker");
assert.ok(visibilityChunks.getVisibleChunks(awayCamera).some((candidate) => candidate.id === edgeVisibleChunk.id), "visibility linger should cover short frame-to-frame camera jitter");
assert.equal(visibilityChunks.getVisibleChunks(awayCamera).some((candidate) => candidate.id === edgeVisibleChunk.id), false, "visibility linger should expire so culling still saves draw cost");
const targetCenteredVisibility = new ChunkManager({ viewDistance: 1, height: 64, minY: -16, useWorkers: false, visibilityLingerFrames: 2 });
const playerRadiusChunk = targetCenteredVisibility.ensureChunk(0, 1);
playerRadiusChunk.mesh = { vertexCount: 1, triangleCount: 1 };
const cameraOnlyRadiusChunk = targetCenteredVisibility.ensureChunk(0, -2);
cameraOnlyRadiusChunk.mesh = { vertexCount: 1, triangleCount: 1 };
const thirdPersonCamera = createCameraState({
  worldX: 0,
  worldY: 32,
  worldZ: -16,
  targetWorldX: 0,
  targetWorldY: 24,
  targetWorldZ: 0,
  yaw: 0,
  pitch: 0,
  fov: 58,
  aspect: 1.6,
});
const targetCenteredVisible = targetCenteredVisibility.getVisibleChunks(thirdPersonCamera);
assert.ok(targetCenteredVisible.some((candidate) => candidate.id === playerRadiusChunk.id), "render radius should include chunks near the player/camera target");
assert.equal(targetCenteredVisible.some((candidate) => candidate.id === cameraOnlyRadiusChunk.id), false, "third-person camera offset must not render chunks outside the player-centered radius");

const y = chunks.surfaceYAt(0, 0) - 1;
const before = chunks.getBlockAtWorld(0, y, 0);
assert.notEqual(before, BLOCK_ID.air, "surface block should be solid before pending delta");
chunks.applyPendingDelta([{ worldX: 0, worldY: y, worldZ: 0, blockId: BLOCK_ID.air }], "tx-test");
assert.equal(chunks.getBlockAtWorld(0, y, 0), BLOCK_ID.air, "pending delta should affect final render block");
chunks.rollbackPendingDelta("tx-test");
assert.equal(chunks.getBlockAtWorld(0, y, 0), before, "rollback should restore base or chain state");
chunks.applyPendingDelta([{ worldX: 0, worldY: y, worldZ: 0, blockId: BLOCK_ID.air }], "tx-test-2");
chunks.confirmPendingDelta("tx-test-2");
assert.equal(chunks.getBlockAtWorld(0, y, 0), BLOCK_ID.air, "confirmed pending delta should become chain delta");

const snapshotChunks = new ChunkManager({ viewDistance: 1, height: 96, minY: -16, useWorkers: false });
snapshotChunks.updatePlayerPosition(0, 48, 0);
const snapshotChunk = snapshotChunks.chunks.get("0,0");
const snapshotY0 = snapshotChunks.surfaceYAt(0, 0) - 1;
const snapshotY1 = snapshotChunks.surfaceYAt(1, 0) - 1;
const snapshotBase0 = snapshotChunks.getBlockAtWorld(0, snapshotY0, 0);
const snapshotBase1 = snapshotChunks.getBlockAtWorld(1, snapshotY1, 0);
const snapshotVersion = snapshotChunk.version;
snapshotChunks.applyChainDelta([
  { worldX: 0, worldY: snapshotY0, worldZ: 0, blockId: BLOCK_ID.air },
  { worldX: 1, worldY: snapshotY1, worldZ: 0, blockId: BLOCK_ID.air },
]);
assert.equal(snapshotChunk.version, snapshotVersion + 1, "batched chain deltas in one chunk should trigger one mesh version change");
const firstSnapshotRevision = snapshotChunk.chainRevision;
const observedIncremental = snapshotChunks.replaceChainDeltasForChunk("0,0", [
  { worldX: 0, worldY: snapshotY0, worldZ: 0, blockId: BLOCK_ID.air },
  { worldX: 1, worldY: snapshotY1, worldZ: 0, blockId: BLOCK_ID.air },
], { expectedChainRevision: firstSnapshotRevision, snapshotToken: 40 });
assert.equal(observedIncremental.applied, true, "a full PDA snapshot should observe and release protected incremental deltas");
assert.equal(observedIncremental.retainedUnobserved, 0, "observed incremental deltas should no longer need RPC-lag protection");
const replacement = snapshotChunks.replaceChainDeltasForChunk("0,0", [
  { worldX: 0, worldY: snapshotY0, worldZ: 0, blockId: BLOCK_ID.air },
], { expectedChainRevision: snapshotChunk.chainRevision, snapshotToken: 41 });
assert.equal(replacement.applied, true, "matching chain revision should accept a complete PDA snapshot");
assert.equal(snapshotChunks.getBlockAtWorld(0, snapshotY0, 0), BLOCK_ID.air, "snapshot should retain listed chain deltas");
assert.equal(snapshotChunks.getBlockAtWorld(1, snapshotY1, 0), snapshotBase1, "snapshot replacement should remove records no longer present on chain");
assert.equal(snapshotChunk.chainSnapshotToken, 41, "accepted snapshots should record their cache token");
snapshotChunks.applyPendingDelta([{ worldX: 0, worldY: snapshotY0, worldZ: 0, blockId: snapshotBase0 }], "snapshot-pending");
const pendingSnapshot = snapshotChunks.replaceChainDeltasForChunk("0,0", [], {
  expectedChainRevision: snapshotChunk.chainRevision,
  snapshotToken: 42,
});
assert.equal(pendingSnapshot.applied, true, "chain snapshots should apply while a local transaction is pending");
assert.equal(snapshotChunks.getBlockAtWorld(0, snapshotY0, 0), snapshotBase0, "pending deltas must override the latest chain snapshot");
snapshotChunks.rollbackPendingDelta("snapshot-pending");
assert.equal(snapshotChunks.getBlockAtWorld(0, snapshotY0, 0), snapshotBase0, "rolling back pending state should reveal the atomically replaced chain snapshot");
const staleRevision = snapshotChunk.chainRevision;
snapshotChunks.applyChainDelta([{ worldX: 1, worldY: snapshotY1, worldZ: 0, blockId: BLOCK_ID.air }]);
const staleSnapshot = snapshotChunks.replaceChainDeltasForChunk("0,0", [], {
  expectedChainRevision: staleRevision,
  snapshotToken: 43,
});
assert.equal(staleSnapshot.applied, false, "an RPC snapshot captured before a newer chain mutation must be rejected");
assert.equal(snapshotChunks.getBlockAtWorld(1, snapshotY1, 0), BLOCK_ID.air, "rejected stale snapshots must not overwrite newer chain state");

const lagProtectedRevision = snapshotChunk.chainRevision;
const laggingSnapshot = snapshotChunks.replaceChainDeltasForChunk("0,0", [], {
  expectedChainRevision: lagProtectedRevision,
  snapshotToken: 44,
});
assert.equal(laggingSnapshot.applied, true, "a lagging RPC snapshot can still update unrelated chain state");
assert.equal(laggingSnapshot.retainedUnobserved, 1, "an incremental chain confirmation must stay protected until RPC observes it");
assert.equal(snapshotChunks.getBlockAtWorld(1, snapshotY1, 0), BLOCK_ID.air, "a lagging RPC response must not resurrect a locally confirmed block");
const caughtUpSnapshot = snapshotChunks.replaceChainDeltasForChunk("0,0", [
  { worldX: 1, worldY: snapshotY1, worldZ: 0, blockId: BLOCK_ID.air },
], { expectedChainRevision: snapshotChunk.chainRevision, snapshotToken: 45 });
assert.equal(caughtUpSnapshot.retainedUnobserved, 0, "RPC observation should release incremental confirmation protection");
const removedAfterObservation = snapshotChunks.replaceChainDeltasForChunk("0,0", [], {
  expectedChainRevision: snapshotChunk.chainRevision,
  snapshotToken: 46,
});
assert.equal(removedAfterObservation.applied, true, "a later complete snapshot may remove an already observed record");
assert.equal(snapshotChunks.getBlockAtWorld(1, snapshotY1, 0), snapshotBase1, "complete snapshots remain authoritative after catching up");
const slottedSnapshot = snapshotChunks.replaceChainDeltasForChunk("0,0", [
  { worldX: 1, worldY: snapshotY1, worldZ: 0, blockId: BLOCK_ID.air },
], {
  expectedChainRevision: snapshotChunk.chainRevision,
  snapshotToken: 47,
  snapshotSlot: 500,
});
assert.equal(slottedSnapshot.applied, true, "a context-slotted snapshot should apply normally");
const olderSlotSnapshot = snapshotChunks.replaceChainDeltasForChunk("0,0", [], {
  expectedChainRevision: snapshotChunk.chainRevision,
  snapshotToken: 48,
  snapshotSlot: 499,
});
assert.equal(olderSlotSnapshot.applied, false, "an older RPC context slot must not roll chain state backward");
assert.equal(olderSlotSnapshot.reason, "stale-chain-slot", "slot rollback should report its exact rejection reason");
assert.equal(snapshotChunks.getBlockAtWorld(1, snapshotY1, 0), BLOCK_ID.air, "a rejected older slot must preserve the newer rendered delta");
const newerSlotSnapshot = snapshotChunks.replaceChainDeltasForChunk("0,0", [], {
  expectedChainRevision: snapshotChunk.chainRevision,
  snapshotToken: 49,
  snapshotSlot: 501,
});
assert.equal(newerSlotSnapshot.applied, true, "a newer RPC context slot may replace the complete snapshot");
assert.equal(snapshotChunk.chainSnapshotSlot, 501, "chunks should retain the latest verified RPC slot watermark");

const boundaryChunks = new ChunkManager({ viewDistance: 1, height: 96, minY: -16, useWorkers: false });
const boundarySource = boundaryChunks.ensureChunk(0, 0);
const boundaryNeighbor = boundaryChunks.ensureChunk(1, 0);
const boundaryY = boundaryChunks.surfaceYAt(15, 0) - 1;
const boundaryNeighborVersion = boundaryNeighbor.version;
boundaryChunks.applyChainDelta([{ worldX: 15, worldY: boundaryY, worldZ: 0, blockId: BLOCK_ID.air }]);
assert.equal(boundarySource.chainDeltas.size, 1, "boundary chain delta should apply to its owning chunk");
assert.equal(boundaryNeighbor.version, boundaryNeighborVersion + 1, "a boundary delta must invalidate the adjacent chunk face exactly once");
boundaryChunks.applyChainDelta([{ worldX: 14, worldY: boundaryY, worldZ: 0, blockId: BLOCK_ID.air }]);
const packedBoundaryDeltas = boundaryChunks.neighborDeltasForWorker(1, 0);
assert.ok(packedBoundaryDeltas instanceof Int32Array, "worker delta payloads should use compact transferable integer storage");
assert.equal(packedBoundaryDeltas.length, 4, "neighbor worker payloads should include only the one touching boundary delta, not interior or owning chunk duplicates");
assert.deepEqual(Array.from(packedBoundaryDeltas), [15, boundaryY, 0, BLOCK_ID.air], "packed neighbor deltas should preserve exact integer proof coordinates");
const packedTreeBoundaryDeltas = boundaryChunks.treeNeighborDeltasForWorker(1, 0);
assert.deepEqual(
  Array.from(packedTreeBoundaryDeltas),
  [15, boundaryY, 0, BLOCK_ID.air, 14, boundaryY, 0, BLOCK_ID.air],
  "tree proxy payloads should include the two-block canopy margin without widening ordinary face-neighbor payloads",
);

const camera = createCameraState({ worldX: 1, worldY: y + 8, worldZ: 1, localOffsetX: 0.5, localOffsetY: 0.5, localOffsetZ: 0.5 });
const hit = raycastBlock(camera, [0, -1, 0], 20, chunks);
assert.equal(hit.hit, true, "integer raycast should hit terrain");
const info = inspectBlock(chunks, hit.worldX, hit.worldY, hit.worldZ);
assert.equal(info.worldX, hit.worldX, "inspector should report hit world coordinate");
assert.equal(typeof detectWebGl2Support, "function", "WebGL2 support detector should be exported");
assert.equal(typeof WebGL2VoxelRenderer, "function", "WebGL2 renderer should be exported");
assert.equal(WebGl2VoxelRenderer, WebGL2VoxelRenderer, "legacy WebGl2 name should alias WebGL2 renderer");
const avatarMesh = createAvatarMeshFromNcm();
assert.ok(avatarMesh.vertexCount > 0, "default peasant guy avatar should decode into vertices");
assert.ok(avatarMesh.triangleCount > 0, "default peasant guy avatar should decode into triangles");
assert.ok(resolveAvatarNcmCode("NCM:peasant_guy:v1").startsWith("NCM2:"), "symbolic player appearance code should resolve to a renderable NCM2 avatar");
const symbolicAvatarMesh = createAvatarMeshFromNcm("NCM:peasant_guy:v1");
assert.equal(symbolicAvatarMesh.indexCount, avatarMesh.indexCount, "symbolic peasant guy code should resolve to the built-in avatar mesh");
const animatedAvatarVertices = updateAvatarMeshVertices(avatarMesh, { moving: true, timeMs: 1234 });
assert.equal(animatedAvatarVertices.length, avatarMesh.vertices.length, "animated avatar vertex buffer length should stay stable");
assert.ok(Array.from(animatedAvatarVertices).every(Number.isFinite), "animated avatar vertices should remain finite");
const equippedAvatarMesh = createAvatarMeshFromNcm(undefined, { attachIronPickaxe: true });
assert.ok(equippedAvatarMesh.equipment.some((entry) => entry.id === "basic_iron_pickaxe"), "avatar mesh should expose the iron pickaxe equipment slot");
assert.ok(equippedAvatarMesh.equipment.some((entry) => entry.id === "forged_pickaxe"), "avatar mesh should expose the forged pickaxe equipment slot");
assert.ok(equippedAvatarMesh.equipment.some((entry) => entry.id === "held_block"), "avatar mesh should expose the held block equipment slot");
const sharedPickaxeParts = createEquipmentModelParts(EQUIPMENT_MODEL_ID.basicPickaxe);
const avatarPickaxeParts = equippedAvatarMesh.parts.filter((part) => part.equipmentId === EQUIPMENT_MODEL_ID.basicPickaxe);
assert.deepEqual(avatarPickaxeParts.map((part) => part.name), sharedPickaxeParts.map((part) => part.name), "hotbar and avatar pickaxes must use the same model part list");
const sharedPickaxeScale = avatarPickaxeParts[0].sx / sharedPickaxeParts[0].size[0];
for (let index = 0; index < sharedPickaxeParts.length; index += 1) {
  assert.deepEqual(avatarPickaxeParts[index].color, sharedPickaxeParts[index].color, "hotbar and avatar pickaxes must use the same model palette");
  assert.ok(Math.abs(avatarPickaxeParts[index].sx - sharedPickaxeParts[index].size[0] * sharedPickaxeScale) < 1e-7);
  assert.ok(Math.abs(avatarPickaxeParts[index].sy - sharedPickaxeParts[index].size[1] * sharedPickaxeScale) < 1e-7);
  assert.ok(Math.abs(avatarPickaxeParts[index].sz - sharedPickaxeParts[index].size[2] * sharedPickaxeScale) < 1e-7);
}
const rightArmParts = equippedAvatarMesh.parts.filter((part) => part.bone === "right_arm");
const leftArmParts = equippedAvatarMesh.parts.filter((part) => part.bone === "left_arm");
const rightArmInnerX = Math.min(...rightArmParts.map((part) => part.cx - part.sx * 0.5));
const leftArmInnerX = Math.max(...leftArmParts.map((part) => part.cx + part.sx * 0.5));
assert.ok(Math.abs(equippedAvatarMesh.pivots.right_arm[0] - rightArmInnerX) < 1e-7, "right arm should rotate from its torso-facing shoulder end");
assert.ok(Math.abs(equippedAvatarMesh.pivots.left_arm[0] - leftArmInnerX) < 1e-7, "left arm should rotate from its torso-facing shoulder end");
const rightShoulder = equippedAvatarMesh.pivots.right_arm.map((value, index) => value + equippedAvatarMesh.boneOffsets.right_arm[index]);
assert.ok(rightShoulder.every((value, index) => Math.abs(value - equippedAvatarMesh.pivots.right_hand_item[index]) < 1e-7), "held tools should inherit the right shoulder rotation pivot");
assert.ok(equippedAvatarMesh.handAnchors.right_hand_item[1] < rightShoulder[1], "right-hand equipment mount should remain below the shoulder");
const miningScale = (1.75 / 0.4) / 2.52;
const miningAvatarMesh = createAvatarMeshFromNcm(undefined, { scale: miningScale, attachIronPickaxe: true });
const miningPlayer = {
  worldX: 0,
  worldY: 0,
  worldZ: 0,
  localOffsetX: 0,
  localOffsetY: 0,
  localOffsetZ: 0,
  avatarYaw: 0,
};
const miningAvatar = { ...miningPlayer, yaw: 0 };
let miningEquipment = { rightHand: "pickaxe", miningTool: true, equipmentId: "basic_iron_pickaxe" };
const toolCollision = createAvatarToolCollisionResolver({
  getAvatarMesh: () => miningAvatarMesh,
  getAvatar: () => miningAvatar,
  getPlayer: () => miningPlayer,
  getPlayerWorldFloat: () => [0, 0, 0],
  getSelectedEquipment: () => miningEquipment,
  playerBodyHeight: 4.375,
});
const toolReachSphere = toolCollision.toolReachSphere();
assert.ok(toolReachSphere.radius > 2 && toolReachSphere.radius < 3, "tool reach sphere should derive its radius from the shoulder-to-tool geometry");
miningEquipment = { rightHand: "pickaxe", miningTool: true, equipmentId: "forged_pickaxe", forged: true };
const forgedToolReachSphere = toolCollision.toolReachSphere();
assert.equal(forgedToolReachSphere.equipmentId, "forged_pickaxe", "tool reach should follow the currently equipped physical model");
assert.ok(forgedToolReachSphere.radius > toolReachSphere.radius, "larger forged tool geometry should produce a different reach radius");
miningEquipment = { rightHand: "pickaxe", miningTool: true, equipmentId: "basic_iron_pickaxe" };
for (const [worldX, worldY, worldZ] of [[0, 1, -2], [2, 1, 0], [0, 1, 2], [-2, 1, 0]]) {
  const solution = toolCollision.toolTargetingSolution({ worldX, worldY, worldZ });
  assert.equal(solution.reachable, true, `tool targeting should auto-rotate toward reachable block ${worldX},${worldY},${worldZ}`);
  const targetBox = createBlockAabb(worldX, worldY, worldZ, 0.06, {});
  const impactFrame = toolCollision.toolCollisionFrame({
    progress: solution.impactProgress,
    yaw: solution.yaw,
    pitchOffset: solution.pitchOffset,
  });
  assert.ok(impactFrame.boxes.some((box) => aabbIntersectsAabb(box, targetBox)), "targeting solution should place the physical tool inside the selected block at impact");
}
const elevatedToolSolution = toolCollision.toolTargetingSolution({ worldX: 0, worldY: 5, worldZ: -1 });
assert.equal(elevatedToolSolution.reachable, true, "tool targeting should adjust arm pitch for elevated blocks inside the shoulder reach sphere");
assert.notEqual(elevatedToolSolution.pitchOffset, 0, "elevated targeting should carry a physical arm pitch adjustment");
const distantToolSolution = toolCollision.toolTargetingSolution({ worldX: 0, worldY: 1, worldZ: -6 });
assert.equal(distantToolSolution.reachable, false, "blocks outside the shoulder-and-tool sphere must not be mineable");
assert.equal(distantToolSolution.withinReachSphere, false, "distant blocks should fail the cheap reach-sphere broad phase");
const customToolPivot = miningAvatarMesh.pivots.right_hand_item;
const customToolMesh = {
  ...miningAvatarMesh,
  parts: miningAvatarMesh.parts.concat({
    name: "longToolCollisionVolume",
    cx: customToolPivot[0],
    cy: customToolPivot[1],
    cz: customToolPivot[2] - 4,
    sx: 0.2,
    sy: 0.2,
    sz: 2,
    color: [1, 1, 1, 1],
    bone: "right_hand_item",
    equipment: true,
    equipmentId: "long_drill",
    toolCollisionPart: true,
  }),
};
const customToolCollision = createAvatarToolCollisionResolver({
  getAvatarMesh: () => customToolMesh,
  getAvatar: () => miningAvatar,
  getPlayer: () => miningPlayer,
  getPlayerWorldFloat: () => [0, 0, 0],
  getSelectedEquipment: () => ({ rightHand: "drill", miningTool: true, equipmentId: "long_drill" }),
  playerBodyHeight: 4.375,
});
assert.ok(customToolCollision.toolReachSphere().radius > 5, "future mining tools should derive reach from their own collision volume without hardcoded pickaxe IDs");
assert.equal(customToolCollision.toolCollisionFrame({ progress: 0.7 }).boxes.length, 1, "future tool collision should use its declared physical parts only");
const pickaxeAvatarVertices = updateAvatarMeshVertices(equippedAvatarMesh, { timeMs: 1000, equipment: { rightHand: "pickaxe" } });
assert.equal(pickaxeAvatarVertices.length, equippedAvatarMesh.vertices.length, "pickaxe avatar vertex buffer length should stay stable");
assert.ok(Array.from(pickaxeAvatarVertices).every(Number.isFinite), "pickaxe avatar vertices should remain finite");
const forgedAvatarVerticesA = new Float32Array(updateAvatarMeshVertices(equippedAvatarMesh, { timeMs: 1000, equipment: { rightHand: "pickaxe", forged: true, designHash: 0x1234abcd } }));
assert.equal(forgedAvatarVerticesA.length, equippedAvatarMesh.vertices.length, "forged pickaxe avatar vertex buffer length should stay stable");
assert.ok(Array.from(forgedAvatarVerticesA).every(Number.isFinite), "forged pickaxe avatar vertices should remain finite");
const forgedAvatarVerticesB = new Float32Array(updateAvatarMeshVertices(equippedAvatarMesh, { timeMs: 1000, equipment: { rightHand: "pickaxe", forged: true, designHash: 0x9876fedc } }));
assert.ok(floatArraysDiffer(forgedAvatarVerticesA, forgedAvatarVerticesB), "forged pickaxe designHash should affect the native avatar vertex colors");
const blockAvatarVertices = updateAvatarMeshVertices(equippedAvatarMesh, { timeMs: 1000, equipment: { rightHand: "block", color: [0.2, 0.6, 0.3, 1] } });
assert.equal(blockAvatarVertices.length, equippedAvatarMesh.vertices.length, "held block avatar vertex buffer length should stay stable");
assert.ok(Array.from(blockAvatarVertices).every(Number.isFinite), "held block avatar vertices should remain finite");
const emptyAvatarVertices = updateAvatarMeshVertices(equippedAvatarMesh, { timeMs: 1000, equipment: { rightHand: "empty" } });
assert.equal(emptyAvatarVertices.length, equippedAvatarMesh.vertices.length, "empty-hand avatar vertex buffer length should stay stable");
assert.ok(Array.from(emptyAvatarVertices).every(Number.isFinite), "empty-hand avatar vertices should remain finite");
const visualAssets = buildDebugVisualModelAssets();
assert.ok(visualAssets.length >= 4, "debug visual model assets should include ground detail and tree previews");
const visualAssetById = new Map(visualAssets.map((asset) => [asset.id, asset]));
for (const asset of visualAssets) {
  assert.ok(asset.vertexCount > 0, `${asset.id} should contain vertices`);
  assert.ok(asset.triangleCount > 0, `${asset.id} should contain triangles`);
}
assert.ok((visualAssetById.get("grass_tuft")?.triangleCount ?? 0) >= 24, "grass tuft preview should use micro voxel volume, not the old flat plant mesh");
assert.ok((visualAssetById.get("micro_sprout_patch")?.triangleCount ?? 0) >= 16, "micro sprout preview should add lightweight voxel ground detail");
assert.ok((visualAssetById.get("micro_flower_sprig")?.triangleCount ?? 0) >= 48, "micro flower sprig should add small voxel flower ground detail");
assert.ok((visualAssetById.get("white_flower_clump")?.triangleCount ?? 0) >= 48, "flower preview should include voxel stem, petals, and center");
const grassTuftAsset = visualAssetById.get("grass_tuft");
const grassTuftY = grassTuftAsset.vertices.map((vertex) => vertex.p[1]);
assert.ok(Math.max(...grassTuftY) - Math.min(...grassTuftY) > 0.54, "grass tuft height should use the requested doubled scale");
assert.ok(grassTuftAsset.triangleCount <= 50, "taller grass should use five merged blades rather than adding geometry");
const whiteFlowerAsset = visualAssetById.get("white_flower_clump");
const yellowCenterLayer = materialDef(MATERIAL_ID.flowerYellow).textureLayer;
assert.equal(whiteFlowerAsset.triangleCount, 48, "planar four-petal flower should stay within the 24-quad budget");
assert.equal(whiteFlowerAsset.vertices.filter((vertex) => vertex.layer === yellowCenterLayer).length, 4, "flower center should be one front-facing yellow quad");
assert.equal(CACTUS_MODEL_PARTS.length, 5, "canonical cactus rendering should stay within the five-cuboid performance budget");
assert.equal(CACTUS_MODEL_HEIGHT_SCALE, 2, "canonical cactus should use the requested doubled vertical scale");
assert.ok(CACTUS_MODEL_MAX_Y > 1.9 && CACTUS_MODEL_MAX_Y < 2, "doubled cactus geometry should rise almost two blocks from its base");
assert.equal(visualAssetById.get("micro_cactus")?.triangleCount, CACTUS_MODEL_TRIANGLE_COUNT, "cactus preview should use the exact canonical five-cuboid silhouette");
const snowTextureLayer = materialDef(MATERIAL_ID.snow).textureLayer;
assert.equal(visualAssetById.get("pine_tree_proxy")?.vertices.some((vertex) => vertex.layer === snowTextureLayer), false, "ordinary pine preview should not use the snow texture layer");
assert.equal(visualAssetById.get("snowy_cedar_tree_proxy")?.vertices.some((vertex) => vertex.layer === snowTextureLayer), true, "snowline cedar preview should replace exposed canopy tops with the snow texture layer");
const decorativePlantAssetIds = [
  "grass_tuft",
  "dry_grass_tuft",
  "voxel_bush",
  "voxel_snow_bush",
  "voxel_dead_bush",
  "voxel_thorn",
  "voxel_reed_cluster",
  "swamp_grass_tuft",
  "micro_moss_patch",
  "voxel_lichen",
  "voxel_vine",
  "micro_mushroom",
  "voxel_glow_mycelium",
  "voxel_seaweed",
  "voxel_aquatic_plant",
];
for (const id of decorativePlantAssetIds) {
  assert.ok(visualAssetById.has(id), `${id} should be exposed on the material/debug page`);
  assert.ok((visualAssetById.get(id)?.triangleCount ?? 0) >= 6, `${id} should use recognizable merged geometry, not one flat plant plane`);
  assert.ok((visualAssetById.get(id)?.triangleCount ?? Infinity) <= 200, `${id} should stay inside the decorative plant triangle budget`);
  const asset = visualAssetById.get(id);
  assert.ok(
    quantizedUsableTriangleCount(asset, POSITION_PACK_SCALE) >= asset.triangleCount * 0.70,
    `${id} should retain at least 70% of its triangles after packed-position quantization`,
  );
}

const tileManager = new TextureArrayManager(null, { tileSize: 32, seed: "nicechunk-mainnet-001" });
const previewGrassTop = getBakedBlockFaceTile(BLOCK_ID.grass, 2, { textureSeed: "nicechunk-mainnet-001", textureTileSize: 32 });
const previewGrassSide = getBakedBlockFaceTile(BLOCK_ID.grass, 0, { textureSeed: "nicechunk-mainnet-001", textureTileSize: 32 });
const worldGrassTop = tileManager.generateMaterialTile(materialDef(MATERIAL_ID.grassTop));
const worldGrassSide = tileManager.generateMaterialTile(materialDef(MATERIAL_ID.grassSide));
assert.equal(blockMaterialIdForFace(BLOCK_ID.grass, 2), MATERIAL_ID.grassTop, "grass top preview must use the world grass-top material");
assert.equal(blockMaterialIdForFace(BLOCK_ID.grass, 0), MATERIAL_ID.grassSide, "grass side preview must use the world grass-and-soil side material");
assert.deepEqual(previewGrassTop.pixels, worldGrassTop, "item previews must reuse the exact baked world top-face pixels");
assert.deepEqual(previewGrassSide.pixels, worldGrassSide, "item previews must reuse the exact baked world side-face pixels");
assert.strictEqual(previewGrassTop.pixels, worldGrassTop, "world and item preview tiles should share the deterministic material cache");
assert.notDeepEqual(previewGrassTop.pixels, previewGrassSide.pixels, "grass top and side textures must stay visually distinct");
const grassPlantTile = tileManager.generateMaterialTile(materialDef(MATERIAL_ID.grassPlant));
const deadBushTile = tileManager.generateMaterialTile(materialDef(MATERIAL_ID.deadBush));
const reedTile = tileManager.generateMaterialTile(materialDef(MATERIAL_ID.reed));
const bushTile = tileManager.generateMaterialTile(materialDef(MATERIAL_ID.bush));
const seaweedTile = tileManager.generateMaterialTile(materialDef(MATERIAL_ID.seaweed));
assert.equal(minAlpha(grassPlantTile), 255, "micro voxel grass material should be fully opaque, not old flat plant alpha");
assert.equal(minAlpha(deadBushTile), 255, "dead bush material should now be opaque because it is rendered as voxel geometry");
assert.equal(minAlpha(reedTile), 255, "reed material should now be opaque because it is rendered as voxel geometry");
assert.equal(minAlpha(bushTile), 255, "bush material should now be opaque because it is rendered as voxel geometry");
assert.equal(minAlpha(seaweedTile), 255, "seaweed material should now be opaque because it is rendered as voxel geometry");

const generatorConfig = createWorldGeneratorConfig({ worldSeed: "nicechunk-mainnet-001" });
assert.equal(generatorConfig.minY, -32, "default world minY should stay aligned with current ChunkBroken PDA minY");
assert.equal(generatorConfig.maxBuildY, 320, "default world maxBuildY should use the early high-mountain contract-safe limit");
assert.equal(generatorConfig.maxTerrainHeight, 240, "default terrain should allow high mountains below the contract build ceiling");
assert.ok(generatorConfig.maxBuildY - generatorConfig.minY <= 511, "default world height must stay inside current 3-byte chunk PDA Y offset capacity");
const solanaProofOptions = {
  generationVersion: generatorConfig.generationVersion,
  minY: generatorConfig.minY,
  height: generatorConfig.height,
  seaLevel: generatorConfig.seaLevel,
  maxTerrainHeight: generatorConfig.maxTerrainHeight,
};
const proofSurfaceY = terrainSurfaceHeight(generatorConfig, 0, 0);
for (const [x, y, z] of [
  [0, proofSurfaceY, 0],
  [-96, generatorConfig.seaLevel, -96],
  [64, Math.max(generatorConfig.minY + 8, proofSurfaceY - 24), 48],
]) {
  const blockId = getBlockAt("nicechunk-mainnet-001", x, y, z, generatorConfig.generationVersion, solanaProofOptions);
  const proof = getResourceAt("nicechunk-mainnet-001", x, y, z, generatorConfig.resourceRuleVersion, solanaProofOptions);
  assert.equal(proof.blockId, blockId, "Solana proof path should reproduce blockId from seed + integer coordinate + generation version");
  assert.equal(proof.resourceId, blockDef(blockId).resourceId, "Solana proof path should derive resourceId from authoritative block definition");
  assert.equal(proof.generationVersion, generatorConfig.generationVersion, "resource proof should report the generation version used for block reconstruction");
  assert.equal(proof.resourceRuleVersion, generatorConfig.resourceRuleVersion, "resource proof should report the resource rule version separately");
}
const highMountainY = terrainSurfaceHeight(generatorConfig, 2808, 516);
assert.ok(highMountainY >= 220, "mainnet seed should expose visible high mountains after contract-safe height expansion");
assert.ok(highMountainY <= generatorConfig.maxTerrainHeight, "high mountains must stay below the configured terrain cap");
let foundBelowSeaWater = false;
for (let x = -192; x <= 192; x += 8) {
  for (let z = -192; z <= 192; z += 8) {
    const surface = terrainSurfaceHeight(generatorConfig, x, z);
    const water = waterLevelAt(generatorConfig, x, z, surface);
    if (surface >= generatorConfig.seaLevel) {
      assert.equal(water, null, "natural water must not generate above the global sea level");
      assert.notEqual(getBlockAt("nicechunk-mainnet-001", x, surface + 1, z), BLOCK_ID.water, "above-sea columns must not contain suspended water above terrain");
    } else if (water === generatorConfig.seaLevel) {
      foundBelowSeaWater = true;
      assert.equal(getBlockAt("nicechunk-mainnet-001", x, generatorConfig.seaLevel, z), BLOCK_ID.water, "below-sea terrain should fill to the global water plane");
    }
  }
}
assert.equal(foundBelowSeaWater, true, "water generation regression scan should include at least one below-sea water column");
{
  const settlementRiverCenter = { x: 160, z: -188 };
  let waterColumns = 0;
  let flatBankColumns = 0;
  let minRiverAreaY = Infinity;
  let maxRiverAreaY = -Infinity;
  for (let z = settlementRiverCenter.z - 12; z <= settlementRiverCenter.z + 12; z += 1) {
    for (let x = settlementRiverCenter.x - 24; x <= settlementRiverCenter.x + 24; x += 1) {
      const surface = terrainSurfaceHeight(generatorConfig, x, z);
      const water = waterLevelAt(generatorConfig, x, z, surface);
      if (water === generatorConfig.seaLevel && surface < generatorConfig.seaLevel) waterColumns += 1;
      if (surface >= generatorConfig.seaLevel && surface <= generatorConfig.seaLevel + 8) flatBankColumns += 1;
      minRiverAreaY = Math.min(minRiverAreaY, surface);
      maxRiverAreaY = Math.max(maxRiverAreaY, surface);
    }
  }
  assert.ok(waterColumns >= 600, "mainnet seed should include broad open rivers, not only narrow canyon cuts");
  assert.ok(flatBankColumns >= 320, "broad rivers should have enough flat nearby banks for settlement placement");
  assert.ok(maxRiverAreaY - minRiverAreaY <= 12, "settlement river banks should transition with a gentle local height range");
}
let foundCoalVein = false;
for (let x = -160; x <= 160; x += 16) {
  for (let z = -160; z <= 160; z += 16) {
    const surface = terrainSurfaceHeight(generatorConfig, x, z);
    for (let y = generatorConfig.minY + 5; y < surface; y += 9) {
      const block = getBlockAt("nicechunk-mainnet-001", x, y, z);
      assert.notEqual(block, BLOCK_ID.air, "default underground generation must stay solid; only deltas may create cavities");
      if (block === BLOCK_ID.coal) foundCoalVein = true;
    }
  }
}
assert.equal(foundCoalVein, true, "underground resources should generate as deterministic ore vein layers");
for (let x = -96; x <= 96; x += 8) {
  for (let z = -96; z <= 96; z += 8) {
    const surface = terrainSurfaceHeight(generatorConfig, x, z);
    if (surfaceBlockAt(generatorConfig, x, z, surface) !== BLOCK_ID.sand) continue;
    const plant = getBlockAt("nicechunk-mainnet-001", x, surface + 1, z);
    assert.ok(plant === BLOCK_ID.air || plant === BLOCK_ID.water, "non-tree surface objects must not be core-generated blocks");
  }
}
const mossSurfaceChunks = new ChunkManager({ viewDistance: 1, height: 160, minY: 0, worldSeed: "nicechunk-mainnet-001" });
mossSurfaceChunks.updatePlayerPosition(287, 104, -295);
for (let i = 0; i < 12; i += 1) mossSurfaceChunks.rebuildDirtyChunks(1000);
const mossSurfaceChunk = mossSurfaceChunks.chunks.get("17,-19");
const wetlandSurfaceY = terrainSurfaceHeight(generatorConfig, 287, -295);
const wetlandSurfaceBlock = surfaceBlockAt(generatorConfig, 287, -295, wetlandSurfaceY);
assert.equal(blockDef(BLOCK_ID.moss).resourceId, RESOURCE_ID.none, "moss should stay visual-only and must not become a chain resource");
assert.equal(mossSurfaceChunks.getBlockAtWorld(287, wetlandSurfaceY, -295), wetlandSurfaceBlock, "mossy wetland columns should keep a real terrain block as chain truth");
assert.notEqual(surfaceBlockAt(generatorConfig, 287, -295, terrainSurfaceHeight(generatorConfig, 287, -295)), BLOCK_ID.moss, "moss must not replace the canonical surface block");
assert.equal(mossSurfaceChunks.surfaceYAt(287.313, -294.118), wetlandSurfaceY + 1, "surfaceYAt should sample the player's actual floor cell, not a rounded neighbor column");
assert.equal(meshHasTopFace(mossSurfaceChunk.mesh, 15, wetlandSurfaceY + 1, 9), true, "fast profile mesher should render the real wetland terrain top face");
const cactusWorldX = 826;
const cactusWorldZ = -1997;
const cactusSurfaceY = terrainSurfaceHeight(generatorConfig, cactusWorldX, cactusWorldZ);
const cactusBlockY = cactusSurfaceY + 1;
const cactusDecoration = resolveSurfaceDecoration({
  worldSeed: generatorConfig.worldSeed,
  worldX: cactusWorldX,
  surfaceY: cactusSurfaceY,
  worldZ: cactusWorldZ,
  surfaceBlockId: surfaceBlockAt(generatorConfig, cactusWorldX, cactusWorldZ, cactusSurfaceY),
  rules: DEFAULT_COMPILED_SURFACE_DECORATION_RULES,
});
assert.equal(BLOCK_ID.cactus, 32, "cactus drop block ID must remain stable for PDA inventory data");
assert.equal(RESOURCE_ID.cactus, 16, "canonical cactus resource ID must remain stable for chain inventory data");
assert.equal(blockDef(BLOCK_ID.cactus).resourceId, RESOURCE_ID.cactus, "cactus block truth must still resolve to its canonical resource");
assert.equal(getBlockAt("nicechunk-mainnet-001", cactusWorldX, cactusBlockY, cactusWorldZ), BLOCK_ID.air, "PDA decorations must not create independent generated voxels");
assert.equal(cactusDecoration?.decorationId, SURFACE_DECORATION_ID.microCactus, "the PDA rule should identify the visible cactus model");
assert.equal(cactusDecoration?.dropBlockId, BLOCK_ID.cactus, "the PDA rule should define the cactus backpack reward");
const flowerPreview = createSurfaceDecorationPreviewMesh({
  decorationId: SURFACE_DECORATION_ID.flowerClump,
  variantHash: 0xf13b9a61,
  surfaceBlockId: BLOCK_ID.grass,
});
assert.ok(flowerPreview.vertices.length > 0 && flowerPreview.indices.length > 0, "backpack decoration previews must reuse real world decoration geometry");
assert.equal(surfaceDecorationName(SURFACE_DECORATION_ID.flowerClump), "Flower Clump", "PDA decoration identity must produce a distinct backpack label");
assert.equal(isBlockingBlock(BLOCK_ID.cactus), true, "voxel cactus rendering must preserve solid full-cell collision");
assert.equal(isMineableBlock(BLOCK_ID.cactus), true, "voxel cactus rendering must preserve mining eligibility");
assert.equal(isOpaqueSolidBlock(BLOCK_ID.cactus), true, "cactus must retain opaque depth writes and early-Z rendering");
assert.equal(isVisualBlock(BLOCK_ID.cactus), false, "opaque cactus geometry must not be duplicated in the blended visual pass");
assert.equal(isLowVegetationBlock(BLOCK_ID.cactus), true, "cactus must use dedicated low-density visual geometry");
const cactusRayWorld = {
  chunkSize: 16,
  worldSeed: "nicechunk-mainnet-001",
  resourceRuleVersion: 1,
  getBlockAtWorld: (x, y, z) => x === 1 && y === 0 && z === 0 ? BLOCK_ID.cactus : BLOCK_ID.air,
};
const cactusRay = raycastBlock({ worldX: 0, worldY: 0, worldZ: 0, localOffsetX: 0.25, localOffsetY: 0.5, localOffsetZ: 0.5 }, [1, 0, 0], 3, cactusRayWorld);
assert.equal(cactusRay.hit, true, "solid cactus must remain raycastable after entering the vegetation visual path");
assert.equal(cactusRay.blockId, BLOCK_ID.cactus, "cactus raycast must return canonical block truth for mining");
const cloudAsset = buildCloudDebugAsset({ seed: "nicechunk-mainnet-001", radius: 180, baseHeight: 0 });
assert.ok(cloudAsset.vertexCount > 0, "debug cloud asset should contain vertices");
assert.ok(cloudAsset.triangleCount > 0, "debug cloud asset should contain triangles");
const wideCloudAsset = buildCloudDebugAsset({ seed: "nicechunk-mainnet-001", radius: 520, baseHeight: 0 });
assert.ok(wideCloudAsset.triangleCount <= 1500, "wide cloud debug asset should stay sparse enough for a single visual draw");
const cloudAlpha = floatAttributeRange(wideCloudAsset.vertices, 10, 9);
assert.ok(cloudAlpha.min < 0.5 && cloudAlpha.max > 0.78, "cloud layer should fade at the sky edge while keeping solid cloud centers");

const bodyBox = createCollisionBox({ halfWidth: 0.5, halfDepth: 0.3, height: 2 });
const [preparedBody] = prepareCollisionBoxes([bodyBox], 0.5, 1, 0.5, 0);
assert.equal(preparedCollisionBoxIntersectsBlock(preparedBody, 0, 1, 0), true, "entity volume should collide with occupied block");
assert.equal(preparedCollisionBoxIntersectsBlock(preparedBody, 1, 1, 0), false, "touching a block face should not count as penetration");
assert.equal(preparedCollisionBoxIntersectsBlock(preparedBody, 0, 3, 0), false, "touching a block ceiling should not count as penetration");

const compactForgeFixture = "NCF1.4ACQAFale2J0el73B1BKFIEBT7AAAwSYgAA";
assert.equal(NCF1_MAX_RAW_BYTES, 640, "canonical NCF1 payloads must fit the tag-8 transaction budget");
const compactForgeDesign = decodeNcf1(compactForgeFixture, { requireCanonical: true });
assert.equal(compactForgeDesign.version, 14, "forge core should decode the deployed NCF1 v14 format");
assert.equal(compactForgeDesign.components.length, 1, "forge fixture should retain its component count");
assert.equal(encodeNcf1(compactForgeDesign), compactForgeFixture, "canonical NCF1 decode/encode should be byte deterministic");
assert.equal(
  validateNcf1(`${compactForgeFixture.slice(0, -1)}B`).code,
  "invalid-base64url",
  "forge text decoding must reject non-zero unused base64url tail bits",
);
assert.equal(forgeChainDesignHash(compactForgeFixture), 1985161465, "forge chain hash must match FNV-1a over decoded NCF1 bytes");
assert.equal(forgeRawDesignHash(compactForgeFixture), 1985161465, "raw forge hash must remain available for the local cache");
assert.throws(
  () => forgeChainDesignHash(createForgeDesign()),
  (error) => error?.code === "invalid-material-requirements",
  "validated chain hashing must reject the zero mass or volume headers rejected by Rust",
);

const deterministicForgeDesign = createForgeDesign({
  equipmentStats: {
    massGrams: 1_000,
    volumeCm3: 350,
    attributes: { hardness: 70, durability: 80, toughness: 64 },
  },
});
const deterministicForgeBytesA = encodeNcf1Bytes(deterministicForgeDesign);
const deterministicForgeBytesB = encodeNcf1Bytes(decodeNcf1(deterministicForgeBytesA));
assert.deepEqual(deterministicForgeBytesB, deterministicForgeBytesA, "integer forge state must round-trip to identical bytes");
assert.equal(validateNcf1(forgeBytesToCode(deterministicForgeBytesA)).ok, true, "strict forge validator should accept canonical bytes");
assert.equal(validateNcf1(forgeBytesToCode(deterministicForgeBytesA.slice(0, -1))).ok, false, "strict forge validator must reject truncated codes");
assert.equal(
  validateNcf1(forgeBytesToCode(Uint8Array.from([...deterministicForgeBytesA, 0]))).code,
  "trailing-data",
  "strict forge validator must reject trailing bytes",
);
assert.deepEqual(forgeCodeToBytes(encodeNcf1(deterministicForgeDesign)), deterministicForgeBytesA, "base64url code conversion should be lossless");
const unchangedCompactSelection = selectCompactNcf1Encoding(deterministicForgeDesign);
assert.equal(unchangedCompactSelection.mode, "components", "the compact selector should retain editable components when appearance bytes are not shorter");
assert.deepEqual(unchangedCompactSelection.bytes, deterministicForgeBytesA, "a no-saving compact selection must preserve the original canonical component bytes");
assert.equal(unchangedCompactSelection.savedBytes, 0, "a no-saving compact selection should report zero saved bytes");

const forgeFacePaintColors = [0xf10, 0xf70, 0x1f0, 0x0af, 0x70f, 0xf0a];
const bakedSixFaceComponent = createForgeComponent({
  resourceId: "copper",
  color444: 0xabc,
  dimsQ: [84, 60, 84],
  offsetQ: [54, 0, -54],
  grip: { offsetQ: [10, 20, -30], axis: 2, sign: -1, rotation: 3 },
  paintQuads: [
    { axis: 0, side: 0, plane: 0, u0: 0, u1: 10, v0: 0, v1: 14, color444: forgeFacePaintColors[0] },
    { axis: 0, side: 1, plane: 14, u0: 0, u1: 10, v0: 0, v1: 14, color444: forgeFacePaintColors[1] },
    { axis: 1, side: 0, plane: 0, u0: 0, u1: 14, v0: 0, v1: 14, color444: forgeFacePaintColors[2] },
    { axis: 1, side: 1, plane: 10, u0: 0, u1: 14, v0: 0, v1: 14, color444: forgeFacePaintColors[3] },
    { axis: 2, side: 0, plane: 0, u0: 0, u1: 14, v0: 0, v1: 10, color444: forgeFacePaintColors[4] },
    { axis: 2, side: 1, plane: 14, u0: 0, u1: 14, v0: 0, v1: 10, color444: forgeFacePaintColors[5] },
  ],
});
const sixFaceComponentDesign = createForgeDesign({
  components: [bakedSixFaceComponent],
  equipment: { mass5g: 12, volumeCm3: 34, attributes6: new Uint8Array(12).fill(17) },
});
const bakedSixFaceDesign = bakeForgeComponentsToAppearance(sixFaceComponentDesign);
assert.equal(bakedSixFaceDesign.version, 14, "appearance baking must remain inside the deployed NCF1 v14 format");
assert.deepEqual(bakedSixFaceDesign.equipment, sixFaceComponentDesign.equipment, "appearance baking must preserve the complete authoritative equipment header");
assert.deepEqual(
  bakedSixFaceDesign.appearance.grip,
  { offsetQ: [10, 20, -30], axis: 2, sign: -1, rotation: 3 },
  "appearance baking should shift the first effective grip with its centered component geometry",
);
for (let axis = 0; axis < 3; axis += 1) {
  for (const side of [0, 1]) {
    const quad = bakedSixFaceDesign.appearance.quads.find((candidate) => candidate.axis === axis && candidate.side === side);
    assert.ok(quad, `appearance baking should retain axis ${axis} side ${side}`);
    assert.equal(quad.resourceId, "copper", `appearance axis ${axis} side ${side} should retain its material resource`);
    assert.equal(
      quad.color444,
      forgeFacePaintColors[axis * 2 + side],
      `appearance axis ${axis} side ${side} should retain its painted rgb444 color`,
    );
  }
}
const bakedSixFaceBytes = encodeNcf1Bytes(bakedSixFaceDesign);
const bakedSixFaceMesh = buildForgeDesignMesh(bakedSixFaceDesign);
const decodedBakedSixFaceMesh = buildForgeDesignMesh(decodeNcf1(bakedSixFaceBytes, { requireCanonical: true }));
assert.deepEqual(
  encodeNcf1Bytes(decodeNcf1(bakedSixFaceBytes, { requireCanonical: true })),
  bakedSixFaceBytes,
  "baked appearance payloads should decode and re-encode canonically",
);
assert.deepEqual(decodedBakedSixFaceMesh.vertices, bakedSixFaceMesh.vertices, "decoded appearance bytes should reproduce identical packed mesh vertices");
assert.deepEqual(decodedBakedSixFaceMesh.indices, bakedSixFaceMesh.indices, "decoded appearance bytes should reproduce identical mesh indices");
assert.deepEqual(
  forgeMeshBoundsRelativeToGripP(
    buildForgeDesignMesh(sixFaceComponentDesign),
    bakedSixFaceComponent.grip.offsetQ.map((value, axis) => value + bakedSixFaceComponent.offsetQ[axis]),
  ),
  forgeMeshBoundsRelativeToGripP(bakedSixFaceMesh, bakedSixFaceDesign.appearance.grip.offsetQ),
  "centering a full component and its grip should preserve their exact packed-space relationship",
);
const oddExtentGripComponent = createForgeComponent({
  dimsQ: [85, 61, 83],
  offsetQ: [-37, 22, 49],
  grip: { offsetQ: [13, -17, 19], axis: 1, sign: 1, rotation: 2 },
});
const oddExtentGripBake = bakeForgeComponentsToAppearance(createForgeDesign({
  components: [oddExtentGripComponent],
  equipment: deterministicForgeDesign.equipment,
}));
const oddSourceBounds = forgeMeshBoundsRelativeToGripP(
  buildForgeDesignMesh(createForgeDesign({ components: [oddExtentGripComponent] })),
  oddExtentGripComponent.grip.offsetQ.map((value, axis) => value + oddExtentGripComponent.offsetQ[axis]),
);
const oddBakedBounds = forgeMeshBoundsRelativeToGripP(
  buildForgeDesignMesh(oddExtentGripBake),
  oddExtentGripBake.appearance.grip.offsetQ,
);
for (const edge of ["min", "max"]) {
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(
      Math.abs(oddSourceBounds[edge][axis] - oddBakedBounds[edge][axis]) <= 1,
      `odd appearance extent should stay within one packed position unit at ${edge} axis ${axis}`,
    );
  }
}
assert.deepEqual(
  decodeNcf1EquipmentHeader(bakedSixFaceBytes).attributes6,
  decodeNcf1EquipmentHeader(encodeNcf1Bytes(sixFaceComponentDesign)).attributes6,
  "surface baking must leave the authoritative equipment header unchanged",
);
const splitPaintBake = bakeForgeComponentsToAppearance(createForgeDesign({
  components: [createForgeComponent({
    dimsQ: [4, 4, 4],
    paintQuads: [
      { axis: 0, side: 1, plane: 14, u0: 0, u1: 5, v0: 0, v1: 14, color444: 0xf00 },
      { axis: 0, side: 1, plane: 14, u0: 5, u1: 10, v0: 0, v1: 14, color444: 0x00f },
    ],
  })],
  equipment: deterministicForgeDesign.equipment,
}));
assert.deepEqual(
  [...new Set(splitPaintBake.appearance.quads
    .filter((quad) => quad.axis === 0 && quad.side === 1)
    .map((quad) => quad.color444))].sort((left, right) => left - right),
  [0x00f, 0xf00],
  "surface-owner ranking should preserve adjacent paint regions even when many source cells quantize together",
);

const subCellProtrusionDesign = createForgeDesign({
  components: [
    createForgeComponent({ resourceId: "iron", dimsQ: [64, 64, 64] }),
    createForgeComponent({
      resourceId: "copper",
      dimsQ: [15, 15, 15],
      offsetQ: [25, 0, 0],
      paintQuads: [{ axis: 0, side: 1, plane: 14, u0: 0, u1: 10, v0: 0, v1: 14, color444: 0xf04 }],
    }),
  ],
  equipment: deterministicForgeDesign.equipment,
});
const bakedSubCellProtrusion = bakeForgeComponentsToAppearance(subCellProtrusionDesign);
const visibleCopperProtrusion = bakedSubCellProtrusion.appearance.quads.find((quad) => (
  quad.axis === 0 && quad.side === 1 && quad.plane === 24 && quad.resourceId === "copper"
));
assert.ok(visibleCopperProtrusion, "a one-packed-unit material protrusion should retain its own outer surface owner");
assert.equal(visibleCopperProtrusion.color444, 0xf04, "a sub-cell protrusion should retain paint from its physically outermost source face");

const compactLineComponents = Array.from({ length: 8 }, (_, index) => createForgeComponent({
  resourceId: index < 4 ? "iron" : "copper",
  dimsQ: [32, 32, 32],
  offsetQ: [(index * 2 - 7) * 16, 0, 0],
}));
const compactLineDesign = createForgeDesign({
  components: compactLineComponents,
  equipment: deterministicForgeDesign.equipment,
});
const compactLineSelection = selectCompactNcf1Encoding(compactLineDesign);
assert.equal(compactLineSelection.mode, "appearance", "adjacent components should bake to a shorter union surface");
assert.equal(compactLineSelection.surfaceBaked, true, "the selector should identify when editable components became an immutable surface");
assert.ok(compactLineSelection.byteLength < compactLineSelection.sourceByteLength, "appearance mode must be selected only for a real byte saving");
assert.ok(compactLineSelection.byteLength <= NCF1_MAX_RAW_BYTES, "selected compact payloads must fit the chain byte ceiling");
assert.deepEqual(encodeCompactNcf1Bytes(compactLineDesign), compactLineSelection.bytes, "compact byte encoding should reuse the deterministic selector");
assert.equal(encodeCompactNcf1(compactLineDesign), compactLineSelection.code, "compact text encoding should reuse the deterministic selector");
const repeatedCompactLineBake = bakeForgeComponentsToAppearance(compactLineDesign);
assert.deepEqual(
  encodeNcf1Bytes(repeatedCompactLineBake),
  encodeNcf1Bytes(compactLineSelection.design),
  "component surface baking should be byte deterministic",
);
assert.deepEqual(
  [...new Set(compactLineSelection.design.appearance.quads.map((quad) => quad.resourceId))].sort(),
  ["copper", "iron"],
  "a merged appearance should retain visible material boundaries",
);
assert.ok(
  buildForgeDesignMesh(compactLineSelection.design).triangleCount < buildForgeDesignMesh(compactLineDesign).triangleCount,
  "a selected union surface should also reduce deterministic in-game render triangles",
);
const componentLineRequirements = forgeMaterialRequirements(encodeNcf1Bytes(compactLineDesign));
const compactLineRequirements = forgeMaterialRequirements(compactLineSelection.bytes);
assert.deepEqual(compactLineRequirements.vector, componentLineRequirements.vector, "surface compaction must preserve the two header-derived material requirements");
assert.notEqual(compactLineRequirements.designHash, componentLineRequirements.designHash, "surface compaction must produce a distinct raw-byte design identity");
const componentLineProof = createForgeMaterialProof(encodeNcf1Bytes(compactLineDesign));
const compactLineProof = createForgeMaterialProof(compactLineSelection.bytes);
assert.equal(verifyForgeMaterialProof(compactLineSelection.bytes, componentLineProof).ok, false, "a pre-compaction proof must not verify against compact bytes");
assert.equal(
  verifyForgeMaterialProof(compactLineSelection.bytes, compactLineProof, compactLineRequirements.vector).ok,
  true,
  "a proof derived from the selected compact bytes should verify with exact material capacity",
);

const checkerSolid = new Uint8Array(FORGE_COMPONENT_GRID.x * FORGE_COMPONENT_GRID.y * FORGE_COMPONENT_GRID.z);
for (let z = 0; z < FORGE_COMPONENT_GRID.z; z += 1) {
  for (let y = 0; y < FORGE_COMPONENT_GRID.y; y += 1) {
    for (let x = 0; x < FORGE_COMPONENT_GRID.x; x += 1) {
      checkerSolid[forgeVoxelIndex(x, y, z)] = (x + y + z) & 1;
    }
  }
}
const oversizedEditableDesign = createForgeDesign({
  components: [createForgeComponent(), createForgeComponent({ solid: checkerSolid })],
  equipment: deterministicForgeDesign.equipment,
});
assert.throws(
  () => encodeNcf1Bytes(oversizedEditableDesign),
  (error) => error?.code === "code-too-large",
  "complex editable component history should still respect the direct 640-byte encoder ceiling",
);
const rescuedCompactSelection = selectCompactNcf1Encoding(oversizedEditableDesign);
assert.equal(rescuedCompactSelection.mode, "appearance", "the compact selector should rescue an oversized editable design when its union surface is small");
assert.ok(rescuedCompactSelection.sourceByteLength > NCF1_MAX_RAW_BYTES, "the rescue fixture should prove the source component payload exceeds the chain ceiling");
assert.ok(rescuedCompactSelection.byteLength <= NCF1_MAX_RAW_BYTES, "the rescued appearance payload must fit the chain ceiling");
assert.equal(decodeNcf1(rescuedCompactSelection.bytes, { requireCanonical: true }).version, 14, "rescued compact payloads should remain canonical NCF1 v14");
const irreducibleCheckerDesign = createForgeDesign({
  components: [createForgeComponent({ solid: checkerSolid })],
  equipment: deterministicForgeDesign.equipment,
});
assert.throws(
  () => selectCompactNcf1Encoding(irreducibleCheckerDesign),
  (error) => error?.code === "code-too-large",
  "the compact selector must still reject geometry when neither v14 representation fits 640 bytes",
);
let boundarySeed = (11 * 2654435761) >>> 0;
const boundarySolid = new Uint8Array(FORGE_COMPONENT_GRID.x * FORGE_COMPONENT_GRID.y * FORGE_COMPONENT_GRID.z);
for (let index = 0; index < boundarySolid.length; index += 1) {
  boundarySeed = (Math.imul(boundarySeed, 1664525) + 1013904223) >>> 0;
  if (boundarySeed / 2 ** 32 < 0.126) boundarySolid[index] = 1;
}
const exactBoundaryDesign = createForgeDesign({
  components: [createForgeComponent({ solid: boundarySolid, dimsQ: [128, 96, 128], color444: 0x123 })],
  equipment: deterministicForgeDesign.equipment,
});
const exactBoundaryBytes = encodeNcf1Bytes(exactBoundaryDesign);
assert.equal(exactBoundaryBytes.length, NCF1_MAX_RAW_BYTES, "a canonical component fixture should be accepted at exactly 640 bytes");
assert.deepEqual(
  selectCompactNcf1Encoding(exactBoundaryDesign).bytes,
  exactBoundaryBytes,
  "the compact selector should retain an exact-640-byte component payload when appearance is larger",
);
assert.equal(decodeNcf1(exactBoundaryBytes, { requireCanonical: true }).version, 14, "the exact 640-byte boundary should decode canonically as NCF1 v14");
assert.equal(
  validateNcf1(Uint8Array.from([...exactBoundaryBytes, 0])).code,
  "code-too-large",
  "adding one byte to the exact boundary must fail as 641 bytes before geometry parsing",
);

const alreadyCompactSelection = selectCompactNcf1Encoding(bakedSixFaceDesign);
assert.equal(alreadyCompactSelection.mode, "appearance", "an existing appearance payload should remain in appearance mode");
assert.equal(alreadyCompactSelection.sourceMode, "appearance", "an existing appearance payload should report its actual source mode");
assert.equal(alreadyCompactSelection.surfaceBaked, false, "an existing appearance payload should not be reported as newly baked");
assert.equal(alreadyCompactSelection.savedBytes, 0, "an existing appearance payload should not claim synthetic savings");

const materialRequirements = forgeMaterialRequirements(compactForgeFixture);
assert.deepEqual(
  materialRequirements.vector,
  [5_000, 341],
  "chain material requirements must contain only volume and effective durability",
);
assert.equal(materialRequirements.requiredVolumeMm3, 5_000, "volume requirements should convert cm3 to mm3 exactly");
assert.equal(materialRequirements.requiredEffectiveDurability, 341, "effective durability should match the Rust integer formula");
assert.equal(materialRequirements.materialScore, 59, "material score should use decoded compact6 attributes");
assert.equal(materialRequirements.hashAlgorithm, "fnv1a32-ncf1-raw", "material proof metadata should declare the raw-byte hash");
const mediumForgeFixture = "NCF1.4A1QCCale2J0el73B1BKFIVKSnAAFAGYgAA";
assert.deepEqual(forgeMaterialRequirements(mediumForgeFixture).vector, [130_000, 656], "a second NCF1 fixture should match Rust requirement arithmetic");
assert.equal(forgeChainDesignHash(mediumForgeFixture), 232607990, "a second fixture should match Rust raw-byte FNV-1a");
assert.equal(forgeCompactAttributeScore(0), 0, "compact6 zero should decode to score zero");
assert.equal(forgeCompactAttributeScore(31), 49, "compact6 midpoint rounding should match Rust below half");
assert.equal(forgeCompactAttributeScore(32), 51, "compact6 midpoint rounding should match Rust above half");
assert.equal(forgeCompactAttributeScore(63), 100, "compact6 maximum should decode to score 100");
const minimumRequirementDesign = createForgeDesign({
  equipment: { mass5g: 1, volumeCm3: 1, attributes6: new Uint8Array(12) },
});
assert.deepEqual(forgeMaterialRequirements(minimumRequirementDesign).vector, [1_000, 19], "minimum non-zero header requirements should match Rust");
const maximumScoreAttributes = new Uint8Array(12).fill(63);
maximumScoreAttributes[4] = 0;
const maximumRequirementDesign = createForgeDesign({
  equipment: { mass5g: 0xffff, volumeCm3: 0xffff, attributes6: maximumScoreAttributes },
});
assert.deepEqual(forgeMaterialRequirements(maximumRequirementDesign).vector, [65_535_000, 54_246], "maximum header requirements should remain exact safe integers");
const compactHeader = decodeNcf1EquipmentHeader(compactForgeFixture);
assert.deepEqual(
  forgeDesignStatsVector(compactForgeFixture),
  [9, 5, 26, 37, 30, 54, 9, 52, 30, 37, 59, 55, 1, 53],
  "the 12 attributes should remain available as display-only design statistics",
);
assert.equal(forgeMaterialScoreFromCompactAttributes(compactHeader.attributes6), 59, "standalone material scoring should match requirement derivation");

const materialCapacity = sumForgeMaterialCapacities([
  { volumeMm3: 3_000, durabilityCurrent: 300, durabilityMax: 400, qualityBps: 5_000 },
  { volumeMm3: 2_000, durabilityCurrent: 191, durabilityMax: 191, qualityBps: 10_000 },
]);
assert.deepEqual(materialCapacity.vector, [5_000, 341], "slot capacity should sum volume and floored quality-adjusted durability");
const exactCapacity = compareForgeMaterialCapacity(materialRequirements, materialCapacity);
assert.equal(exactCapacity.ok, true, "two-field material capacity should accept exact coverage");
const missingVolume = compareForgeMaterialCapacity(materialRequirements, [4_999, 341]);
assert.equal(missingVolume.ok, false, "material capacity must reject volume one unit below the requirement");
assert.equal(missingVolume.fields[0].deficit, 1, "volume comparison should expose the exact integer deficit");
const missingDurability = compareForgeMaterialCapacity(materialRequirements, [5_000, 340]);
assert.equal(missingDurability.ok, false, "material capacity must reject effective durability one unit below the requirement");
assert.equal(missingDurability.fields[1].deficit, 1, "durability comparison should expose the exact integer deficit");
assert.throws(
  () => compareForgeMaterialCapacity([0, 0], [0, 0]),
  (error) => error?.code === "invalid-material-requirements",
  "manual requirements must preserve the chain's non-zero invariant",
);
assert.throws(
  () => compareForgeMaterialCapacity(materialRequirements, forgeDesignStatsVector(compactForgeFixture)),
  (error) => error?.code === "invalid-material-capacity",
  "display attributes must never be accepted as the authoritative chain capacity",
);

const compactForgeBytes = forgeCodeToBytes(compactForgeFixture);
const headerOnlyForgeBytes = compactForgeBytes.slice(0, 14);
assert.throws(
  () => forgeMaterialRequirements(compactForgeBytes.slice(0, 13)),
  (error) => error?.code === "truncated-code",
  "the chain-compatible parser must reject a truncated 108-bit equipment header",
);
assert.equal(validateNcf1(headerOnlyForgeBytes).ok, false, "the full codec must reject a geometry-truncated design");
assert.deepEqual(
  forgeMaterialRequirements(headerOnlyForgeBytes).vector,
  materialRequirements.vector,
  "chain requirements should depend only on the complete 108-bit equipment header",
);
assert.notEqual(
  forgeChainDesignHash(headerOnlyForgeBytes),
  materialRequirements.designHash,
  "geometry bytes should remain bound into the design identity even though they do not change requirements",
);
const oversizedForgeBytes = new Uint8Array(NCF1_MAX_RAW_BYTES + 1);
oversizedForgeBytes.set(compactForgeBytes);
assert.equal(validateNcf1(oversizedForgeBytes).code, "code-too-large", "the full codec must enforce the 640-byte canonical ceiling");
assert.throws(
  () => forgeMaterialRequirements(oversizedForgeBytes),
  (error) => error?.code === "code-too-large",
  "chain requirement derivation must enforce the same tag-8 byte ceiling",
);
const materialProof = createForgeMaterialProof(compactForgeFixture);
assert.equal(verifyForgeMaterialProof(compactForgeFixture, materialProof, materialCapacity).ok, true, "material proof should bind requirements to the complete raw design hash");
assert.equal(
  verifyForgeMaterialProof(compactForgeFixture, { ...materialProof, designHash: materialProof.designHash ^ 1 }).ok,
  false,
  "material proof must reject a mismatched design hash",
);
const geometryTamperedBytes = compactForgeBytes.slice();
geometryTamperedBytes[geometryTamperedBytes.length - 1] ^= 1;
assert.deepEqual(forgeMaterialRequirements(geometryTamperedBytes).vector, materialRequirements.vector, "geometry changes must not alter header requirements");
assert.equal(
  verifyForgeMaterialProof(geometryTamperedBytes, materialProof).ok,
  false,
  "raw-byte proof hashing must detect a geometry-only payload change",
);

const smeltedSteelProfile = parseForgeMaterialProfile({
  materialId: "carbon_steel",
  material: {
    class: "alloy",
    attributes: { hardness: 86, durability: 88, density: 76 },
  },
  materialProperties: {
    attributes: { hardness: 91, durability: 84, toughness: 87, density: 79 },
  },
});
assert.equal(FORGE_WORKBENCH_MAX_COMPONENTS, 24, "workbench material components must match the Rust verifier's input ceiling");
assert.equal(smeltedSteelProfile.archetypeId, "iron", "smelted alloy IDs should resolve to a forge-compatible iron archetype");
assert.equal(smeltedSteelProfile.attributes.hardness, 91, "per-item smelting attributes should override the recipe/base profile");
assert.equal(smeltedSteelProfile.attributes.durability, 84, "all supplied smelting material attributes should reach equipment derivation");
assert.equal(smeltedSteelProfile.attributes.workability, 62, "missing smelting attributes should use deterministic archetype fallbacks");
assert.equal(smeltedSteelProfile.densityScore, 79, "smelting density scores should drive deterministic integer mass");
const heatDerivedCeramicProfile = parseForgeMaterialProfile({
  materialId: "alumina_plate",
  material: {
    class: "ceramic",
    requiredHeatTier: 4,
    attributes: { density: 42, heatResistance: 92 },
  },
});
assert.equal(heatDerivedCeramicProfile.heat, 48, "material heat should derive from required heat tier plus rounded heat resistance");
const heatDerivedFuelProfile = parseForgeMaterialProfile({
  materialId: "charcoal",
  material: {
    class: "carbon",
    forgeUse: "fuel",
    requiredHeatTier: 1,
    heatTier: 4,
    attributes: { density: 25, heatResistance: 62 },
  },
});
assert.equal(heatDerivedFuelProfile.heat, 72, "fuel heat should derive from its fuel heat tier before archetype fallback");
assert.equal(
  parseForgeMaterialProfile({
    heat: 7,
    materialId: "alumina_plate",
    material: { requiredHeatTier: 4, attributes: { heatResistance: 92 } },
  }).heat,
  7,
  "an explicit per-material heat value should override deterministic tier derivation",
);
const nestedParticularSmeltProfile = parseForgeMaterialProfile({
  materialId: "iron_bloom",
  material: { attributes: { hardness: 10, density: 70 } },
  slot: { materialProperties: { attributes: { hardness: 99, density: 81 } } },
});
assert.equal(nestedParticularSmeltProfile.attributes.hardness, 99, "slot-specific smelting attributes must override recipe/base material attributes");
assert.equal(nestedParticularSmeltProfile.densityScore, 81, "slot-specific smelting density must override the recipe/base density");
const revalidatedFakeProfile = parseForgeMaterialProfile({
  kind: "forge-material-profile-v1",
  archetypeId: "iron",
  resourceId: "iron",
  color444: 0x9ca,
  dimsQ: [76, 46, 65],
  heat: 18,
  attributes: { hardness: 999, density: -5 },
});
assert.equal(revalidatedFakeProfile.attributes.hardness, 100, "serialized profile brands must not bypass attribute normalization");
assert.equal(revalidatedFakeProfile.densityScore, 1, "serialized profile brands must not bypass positive density normalization");
assert.equal(Object.isFrozen(revalidatedFakeProfile), true, "revalidated forge profiles should be immutable records");
assert.throws(
  () => createForgeWorkbenchComponent({ materialId: "iron_bloom" }),
  (error) => error?.code === "invalid-material-volume",
  "workbench components must not invent material volume when no backpack or preview input volume was supplied",
);
assert.throws(
  () => createForgeWorkbenchMaterial({
    kind: "forge-workbench-material-v1",
    volumeMm3: -1,
    profile: smeltedSteelProfile,
  }),
  (error) => error?.code === "integer-out-of-range",
  "serialized material brands must not bypass positive u32 volume validation",
);
assert.throws(
  () => createForgeWorkbenchMaterial({ materialId: "iron_bloom", volumeMm3: 1_000, slotIndex: 99 }),
  (error) => error?.code === "integer-out-of-range",
  "workbench slot indexes must stay inside the chain client's 0-98 range",
);
const workbenchOffsets = Array.from({ length: FORGE_WORKBENCH_MAX_COMPONENTS }, (_, index) => forgeWorkbenchComponentOffsetQ(index));
assert.equal(new Set(workbenchOffsets.map((offset) => offset.join(":"))).size, FORGE_WORKBENCH_MAX_COMPONENTS, "all 24 initial material positions should be distinct");
assert.deepEqual(workbenchOffsets[0], [0, 0, 0], "the first workbench component should stay centered");
assert.notDeepEqual(workbenchOffsets[1], workbenchOffsets[0], "the second workbench component must not overlap the first at the same center");

const steelWorkbenchEntry = createForgeWorkbenchComponent({
  key: "slot-3",
  slotIndex: 3,
  materialId: "carbon_steel",
  volumeMm3: 123_456,
  materialProperties: {
    attributes: {
      hardness: 91,
      durability: 84,
      toughness: 87,
      ductility: 44,
      brittleness: 30,
      density: 79,
      heatResistance: 74,
      corrosionResistance: 42,
      conductivity: 36,
      thermalConductivity: 42,
      magnetism: 78,
      workability: 52,
    },
  },
});
const fullSteelStats = forgeWorkbenchStats([steelWorkbenchEntry.component], [steelWorkbenchEntry.material]);
assert.equal(fullSteelStats.inheritanceMode, FORGE_WORKBENCH_INHERITANCE_MODE, "workbench stats should identify the deterministic material inheritance rule");
assert.equal(fullSteelStats.inputVolumeMm3, 123_456, "workbench inputs should preserve the exact backpack slot volume");
assert.equal(fullSteelStats.usedVolumeMm3, 123_456, "a full solid mask should use the selected slot's complete volume");
assert.equal(fullSteelStats.requiredVolumeMm3, 123_000, "equipment headers should floor millimetres cubed to an encodable cubic-centimetre requirement");
assert.equal(fullSteelStats.volumeHeadroomMm3, 456, "header quantization must leave input headroom instead of exceeding the slot");
assert.equal(fullSteelStats.requirementsWithinInputs, true, "derived equipment volume must never exceed selected input volume");
assert.equal(fullSteelStats.equipment.mass5g, 195, "equipment mass should use exact integer slot volume and density-score arithmetic");
assert.equal(fullSteelStats.equipment.attributes6[0], 57, "smelting attributes should be compacted into the NCF1 equipment header");
assert.equal(fullSteelStats.massWeight, 123_456 * 79, "workbench mass weight should remain exact before 5-gram header quantization");
assert.equal(fullSteelStats.componentBreakdown.length, 1, "workbench stats should expose one contribution per forge component");
assert.equal(fullSteelStats.componentBreakdown[0].materialId, "carbon_steel", "component contributions should preserve the source material ID");
assert.equal(fullSteelStats.componentBreakdown[0].usedVolumeMm3, 123_456, "component contributions should expose exact used material volume");
assert.equal(fullSteelStats.componentBreakdown[0].densityScore, 79, "component contributions should expose their raw density score");
assert.equal(fullSteelStats.componentBreakdown[0].massWeight, 123_456 * 79, "component contributions should expose their exact inheritance weight");
assert.equal(fullSteelStats.componentBreakdown[0].weightBps, 10_000, "a single component should own the complete inherited mass share");
assert.deepEqual(
  Object.keys(fullSteelStats.componentBreakdown[0].attributes),
  [...FORGE_ATTRIBUTE_KEYS],
  "component contributions should expose all 12 raw material attributes in canonical order",
);
assert.equal(fullSteelStats.materialBreakdown.length, 1, "a single source material should produce one aggregate material row");
assert.equal(fullSteelStats.materialBreakdown[0].weightBps, 10_000, "a single aggregate material should own the complete inherited mass share");
assert.deepEqual(
  forgeWorkbenchEquipment([steelWorkbenchEntry.component], [steelWorkbenchEntry.material]),
  fullSteelStats.equipment,
  "standalone equipment derivation should match workbench statistics",
);
assert.equal(fullSteelStats.physicsAdvisory.advisoryOnly, true, "workbench physics should identify itself as non-validating advisory data");
assert.deepEqual(fullSteelStats.physicsAdvisory.centerOfMassQ, [0, 0, 0], "a centered full component should have a centered mass distribution");
assert.ok(fullSteelStats.physicsAdvisory.inertiaQ2.every(Number.isInteger), "principal-axis inertia hints should stay in deterministic integer Q-squared units");
assert.deepEqual(
  forgeWorkbenchPhysicalAdvisory([steelWorkbenchEntry.component], [steelWorkbenchEntry.material]),
  fullSteelStats.physicsAdvisory,
  "standalone physical advisory analysis should match workbench stats",
);

const steelSolidBefore = new Uint8Array(steelWorkbenchEntry.component.solid);
const hammeredSteel = hammerForgeComponent(steelWorkbenchEntry.component);
assert.deepEqual(steelWorkbenchEntry.component.solid, steelSolidBefore, "pure hammer transforms must not mutate their input component");
assert.strictEqual(hammeredSteel.solid, steelWorkbenchEntry.component.solid, "shape-only hammer transforms should structurally share the unchanged solid mask");
assert.equal(
  forgeWorkbenchStats([hammeredSteel], [steelWorkbenchEntry.material]).requiredVolumeMm3,
  fullSteelStats.requiredVolumeMm3,
  "hammer deformation should conserve input material volume",
);

const sawedSteelA = sawForgeComponent(steelWorkbenchEntry.component);
const sawedSteelB = sawForgeComponent(steelWorkbenchEntry.component);
assert.deepEqual(sawedSteelA, sawedSteelB, "saw transforms should be byte deterministic for the same integer state");
assert.deepEqual(steelWorkbenchEntry.component.solid, steelSolidBefore, "pure saw transforms must not mutate their input mask");
assert.ok(forgeComponentSolidFraction(sawedSteelA).solidCells < forgeComponentSolidFraction(steelWorkbenchEntry.component).solidCells, "saw cuts should remove solid cells");
const sawedSteelStats = forgeWorkbenchStats([sawedSteelA], [steelWorkbenchEntry.material]);
assert.ok(sawedSteelStats.requiredVolumeMm3 < fullSteelStats.requiredVolumeMm3, "saw cuts should reduce equipment material requirements by solid fraction");
assert.ok(sawedSteelStats.requiredVolumeMm3 <= sawedSteelStats.inputVolumeMm3, "cut equipment must stay covered by its real backpack input");

const drilledSteel = drillForgeComponent(steelWorkbenchEntry.component);
const taperedSteel = taperForgeComponent(steelWorkbenchEntry.component);
assert.ok(forgeWorkbenchStats([drilledSteel], [steelWorkbenchEntry.material]).usedVolumeMm3 < fullSteelStats.usedVolumeMm3, "drilling should remove material from the deterministic solid mask");
assert.ok(forgeWorkbenchStats([taperedSteel], [steelWorkbenchEntry.material]).usedVolumeMm3 < fullSteelStats.usedVolumeMm3, "tapering should remove material from the deterministic solid mask");
const grippedSteel = gripForgeComponent(steelWorkbenchEntry.component, { axis: "z", sign: -1, rotation: 2 });
assert.deepEqual(grippedSteel.grip, { offsetQ: [0, 0, 0], axis: 2, sign: -1, rotation: 2 }, "grip placement should use canonical integer orientation fields");
assert.strictEqual(grippedSteel.solid, steelWorkbenchEntry.component.solid, "grip placement should not allocate or alter a solid mask");
const offsetGripSteel = gripForgeComponent(steelWorkbenchEntry.component, { offsetQ: [-40, 0, 0], axis: "y", sign: 1 });
const offsetGripStats = forgeWorkbenchStats([offsetGripSteel], [steelWorkbenchEntry.material]);
assert.deepEqual(offsetGripStats.physicsAdvisory.gripTorque.pointQ, [-40, 0, 0], "grip torque should use the component-local grip point in workbench coordinates");
assert.equal(offsetGripStats.physicsAdvisory.gripTorque.radialLeverArmQ, 40, "grip torque should expose the integer COM lever arm perpendicular to the grip axis");
assert.equal(
  offsetGripStats.physicsAdvisory.gripTorque.radialTorqueMgQ,
  offsetGripStats.massMilligrams * 40,
  "grip torque should be a deterministic mass-times-lever advisory index",
);
assert.equal(offsetGripStats.chainReady, fullSteelStats.chainReady, "grip torque must never become an additional chain validation gate");
assert.equal(offsetGripStats.requiredVolumeMm3, fullSteelStats.requiredVolumeMm3, "grip torque must not alter encoded material requirements");
const paintedSteel = paintForgeComponent(steelWorkbenchEntry.component, { color444: 0xf84 });
assert.equal(paintedSteel.color444, 0xf84, "paint transforms should accept canonical rgb444 colors");
assert.strictEqual(paintedSteel.solid, steelWorkbenchEntry.component.solid, "paint transforms should conserve material and share the solid mask");
const rotatedSteel = rotateForgeComponent(steelWorkbenchEntry.component, "y");
assert.deepEqual(
  rotatedSteel.dimsQ,
  [steelWorkbenchEntry.component.dimsQ[2], steelWorkbenchEntry.component.dimsQ[1], steelWorkbenchEntry.component.dimsQ[0]],
  "rotation should deterministically swap the selected envelope axes",
);
assert.equal(
  forgeWorkbenchStats([rotatedSteel], [steelWorkbenchEntry.material]).requiredVolumeMm3,
  fullSteelStats.requiredVolumeMm3,
  "rotation should conserve material requirements",
);
const rotatedDrilledSteelY = rotateForgeComponent(drilledSteel, "y");
assert.ok(
  Array.from({ length: 14 }, (_, x) => rotatedDrilledSteelY.solid[forgeVoxelIndex(x, 5, 6)]).every((value) => value === 0),
  "Y rotation should rotate a drilled Z-axis bore into the X axis",
);
let fourTurnSteel = drilledSteel;
for (let turn = 0; turn < 4; turn += 1) fourTurnSteel = rotateForgeComponent(fourTurnSteel, "y");
assert.deepEqual(fourTurnSteel.solid, drilledSteel.solid, "four lossless Y quarter-turns should restore the exact solid mask");
assert.deepEqual(fourTurnSteel.dimsQ, drilledSteel.dimsQ, "four Y quarter-turns should restore the exact component dimensions");

const paintedGripComponent = createForgeComponent({
  resourceId: "iron",
  dimsQ: [76, 46, 65],
  grip: { offsetQ: [3, 4, 5], axis: 1, sign: 1, rotation: 2 },
  paintQuads: [{ axis: 1, side: 1, plane: 10, u0: 2, u1: 4, v0: 3, v1: 5, color444: 0xf84 }],
});
const paintedGripRotationY = rotateForgeComponent(paintedGripComponent, "y");
assert.deepEqual(paintedGripRotationY.grip, { offsetQ: [5, 4, -3], axis: 1, sign: 1, rotation: 2 }, "Y rotation should rotate the grip offset and preserve its aligned normal");
assert.deepEqual(
  paintedGripRotationY.paintQuads,
  [{ axis: 1, side: 1, plane: 10, u0: 3, u1: 5, v0: 10, v1: 12, color444: 0xf84 }],
  "Y rotation should losslessly rotate painted surface cells",
);
const rotationGripExpectations = {
  x: { offsetQ: [3, -5, 4], axis: 2, sign: 1, rotation: 2 },
  y: { offsetQ: [5, 4, -3], axis: 1, sign: 1, rotation: 2 },
  z: { offsetQ: [-4, 3, 5], axis: 0, sign: -1, rotation: 2 },
};
for (const axis of ["x", "y", "z"]) {
  const rotated = rotateForgeComponent(paintedGripComponent, axis);
  assert.equal(forgeComponentSolidFraction(rotated).solidCells, forgeComponentSolidFraction(paintedGripComponent).solidCells, `${axis.toUpperCase()} rotation should conserve solid-cell material volume`);
  assert.deepEqual(rotated.grip, rotationGripExpectations[axis], `${axis.toUpperCase()} rotation should transform grip position and normal deterministically`);
  assert.ok(rotated.paintQuads.some((quad) => quad.color444 === 0xf84), `${axis.toUpperCase()} rotation should retain painted surface data`);
  assert.doesNotThrow(
    () => createForgeDesign({ components: [rotated], equipment: fullSteelStats.equipment }),
    `${axis.toUpperCase()} rotation should remain canonical NCF1 component state`,
  );
  assert.equal(
    forgeWorkbenchStats([rotated], [steelWorkbenchEntry.material]).requiredVolumeMm3,
    fullSteelStats.requiredVolumeMm3,
    `${axis.toUpperCase()} rotation should conserve equipment material requirements`,
  );
}
const translatedSteel = translateForgeComponent(steelWorkbenchEntry.component, [100, -20, 44]);
assert.deepEqual(normalizeForgeWorkbench([translatedSteel])[0].offsetQ, [0, 0, 0], "workbench normalization should recenter integer component bounds");

const copperWorkbenchEntry = createForgeWorkbenchComponent({
  materialId: "copper_bloom",
  volumeMm3: 76_543,
  material: { attributes: { hardness: 42, durability: 58, toughness: 48, density: 82 } },
}, { positionIndex: 1 });
const mixedWorkbenchStats = forgeWorkbenchStats(
  [sawedSteelA, drillForgeComponent(copperWorkbenchEntry.component)],
  [steelWorkbenchEntry.material, copperWorkbenchEntry.material],
);
assert.equal(mixedWorkbenchStats.inputVolumeMm3, 199_999, "multi-material workbenches should sum exact selected slot volumes");
assert.ok(mixedWorkbenchStats.requiredVolumeMm3 <= mixedWorkbenchStats.inputVolumeMm3, "aggregate NCF1 volume must remain covered after mixed-material cuts");
assert.equal(mixedWorkbenchStats.componentBreakdown.length, 2, "mixed workbenches should retain component-level material contributions");
assert.deepEqual(
  mixedWorkbenchStats.materialBreakdown.map((entry) => entry.materialId),
  ["carbon_steel", "copper_bloom"],
  "material aggregates should retain deterministic first-seen material order",
);
assert.equal(
  mixedWorkbenchStats.componentBreakdown.reduce((sum, entry) => sum + entry.massWeight, 0),
  mixedWorkbenchStats.massWeight,
  "component inheritance weights should sum to the workbench total",
);
assert.equal(
  mixedWorkbenchStats.materialBreakdown.reduce((sum, entry) => sum + entry.usedVolumeMm3, 0),
  mixedWorkbenchStats.usedVolumeMm3,
  "aggregate material rows should sum to the exact used workbench volume",
);
for (const key of FORGE_ATTRIBUTE_KEYS) {
  const inheritedTotal = mixedWorkbenchStats.componentBreakdown.reduce(
    (sum, entry) => sum + entry.attributes[key] * entry.massWeight,
    0,
  );
  assert.equal(
    mixedWorkbenchStats.attributes[key],
    Math.floor((inheritedTotal + Math.floor(mixedWorkbenchStats.massWeight / 2)) / mixedWorkbenchStats.massWeight),
    `${key} should use the documented deterministic mass-weighted inheritance rule`,
  );
}
const secondCopperWorkbenchEntry = createForgeWorkbenchComponent({
  key: "slot-8",
  slotIndex: 8,
  materialId: "copper_bloom",
  volumeMm3: 25_000,
  material: { attributes: { hardness: 50, durability: 62, toughness: 53, density: 80 } },
}, { positionIndex: 2 });
const groupedCopperStats = forgeWorkbenchStats(
  [copperWorkbenchEntry.component, secondCopperWorkbenchEntry.component],
  [copperWorkbenchEntry.material, secondCopperWorkbenchEntry.material],
);
assert.equal(groupedCopperStats.materialBreakdown.length, 1, "components with the same material ID should aggregate into one material row");
assert.equal(groupedCopperStats.materialBreakdown[0].componentCount, 2, "aggregate material rows should report their contributing component count");
assert.deepEqual(groupedCopperStats.materialBreakdown[0].slotIndices, [8], "material aggregates should preserve available live slot indexes without inventing missing ones");
assert.equal(groupedCopperStats.materialBreakdown[0].weightBps, 10_000, "one aggregated material should retain the complete mass share");
const hotDenseEntry = createForgeWorkbenchComponent({
  materialId: "thermal_mix",
  volumeMm3: 100_000,
  heat: 100,
  attributes: { density: 80 },
}, { positionIndex: 0 });
const coldLightEntry = createForgeWorkbenchComponent({
  materialId: "thermal_mix",
  volumeMm3: 100_000,
  heat: 0,
  attributes: { density: 20 },
}, { positionIndex: 1 });
const thermalMixStats = forgeWorkbenchStats(
  [hotDenseEntry.component, coldLightEntry.component],
  [hotDenseEntry.material, coldLightEntry.material],
);
assert.equal(thermalMixStats.heat, 80, "workbench heat should inherit by exact material mass rather than raw volume");
assert.equal(thermalMixStats.materialBreakdown[0].heat, 80, "same-material aggregate heat should use the workbench mass-weighting rule");
const mixedWorkbenchDesign = createForgeWorkbenchDesign(
  [sawedSteelA, drillForgeComponent(copperWorkbenchEntry.component)],
  [steelWorkbenchEntry.material, copperWorkbenchEntry.material],
);
assert.deepEqual(
  encodeNcf1Bytes(decodeNcf1(encodeNcf1Bytes(mixedWorkbenchDesign))),
  encodeNcf1Bytes(mixedWorkbenchDesign),
  "workbench-derived equipment and transformed components should remain canonical NCF1 state",
);

const forgeDesignMeshA = buildForgeDesignMesh(deterministicForgeDesign);
const forgeDesignMeshB = buildForgeDesignMesh(decodeNcf1(deterministicForgeBytesA));
assert.equal(forgeDesignMeshA.vertexStrideBytes, FORGE_MESH_VERTEX_STRIDE_BYTES, "forge workpiece mesh should use the compact packed vertex format");
assert.equal(forgeDesignMeshA.triangleCount, 12, "one full forge component should greedy-mesh to one cuboid");
assert.deepEqual(forgeDesignMeshB.vertices, forgeDesignMeshA.vertices, "forge render mesh should be deterministic from canonical integer state");
const mergedCuboids = buildForgeCuboidMesh([
  { id: "a", centerQ: [0, 0, 0], sizeQ: [64, 64, 64], color444: 0xf84 },
  { id: "b", centerQ: [96, 0, 0], sizeQ: [64, 64, 64], color444: 0x48f },
]);
assert.equal(mergedCuboids.triangleCount, 24, "dynamic cuboids should merge into one uploadable mesh");
assert.equal(mergedCuboids.pickBounds.length, 2, "merged cuboids should retain lightweight CPU picking bounds");

const pickCubeOffset = [2.25, -1.5, 3.75];
const pickCubeMesh = buildForgeCuboidMesh([
  { id: "pick-cube", centerQ: [0, 0, 0], sizeQ: [64, 64, 64], color444: 0x999 },
]);
for (let axis = 0; axis < 3; axis += 1) {
  for (const side of [0, 1]) {
    const normal = [0, 0, 0];
    normal[axis] = side ? 1 : -1;
    const localPoint = [0.125, -0.1875, 0.0625];
    localPoint[axis] = normal[axis] * 0.5;
    const origin = localPoint.map((value, candidate) => value + pickCubeOffset[candidate]);
    origin[axis] = pickCubeOffset[axis] + normal[axis] * 2;
    const direction = normal.map((value) => -value);
    const faceHit = pickForgeMeshRay(pickCubeMesh, { origin, direction }, { offset: pickCubeOffset });
    assert.ok(faceHit, `ray should hit cuboid axis ${axis} side ${side}`);
    assert.equal(faceHit.face.axis, axis, `cuboid axis ${axis} side ${side} should report its surface axis`);
    assert.equal(faceHit.face.side, side, `cuboid axis ${axis} side ${side} should report its surface side`);
    assert.deepEqual(faceHit.face.normal, normal, `cuboid axis ${axis} side ${side} should report its outward normal`);
    assertVectorNear(faceHit.localPoint, localPoint, `cuboid axis ${axis} side ${side} should retain mesh-local hit coordinates`);
    assertVectorNear(
      faceHit.point,
      localPoint.map((value, candidate) => value + pickCubeOffset[candidate]),
      `cuboid axis ${axis} side ${side} should apply the render offset to world hit coordinates`,
    );
  }
}

const faceHammerComponent = createForgeComponent({
  resourceId: "iron",
  dimsQ: [100, 100, 100],
  offsetQ: [10, -20, 30],
});
const faceHammerMesh = buildForgeDesignMesh(createForgeDesign({ components: [faceHammerComponent] }));
for (let axis = 0; axis < 3; axis += 1) {
  for (const side of [0, 1]) {
    const ray = forgeComponentFaceRay(faceHammerComponent, axis, side);
    const hit = pickForgeMeshRay(faceHammerMesh, ray);
    assert.ok(hit, `hammer ray should hit component axis ${axis} side ${side}`);
    const toolOptions = forgeWorkbenchToolOptionsFromHit(faceHammerComponent, "hammer", hit);
    assert.equal(toolOptions.axis, axis, `hammer options should follow hit axis ${axis}`);
    assert.equal(Object.hasOwn(toolOptions, "spreadQ"), false, "surface hits should retain the hammer's volume-conserving displacement mode");
    const footprint = resolveForgeToolFootprint(faceHammerComponent, "hammer", toolOptions);
    assert.ok(footprint.cells.length > 0 && footprint.cells.length <= 9, `hammer axis ${axis} side ${side} should resolve a clipped local 3x3 footprint`);
    assert.ok(
      footprint.cells.every((cell) => cell[axis] === (side ? FORGE_COMPONENT_GRID[["x", "y", "z"][axis]] - 1 : 0)),
      `hammer axis ${axis} side ${side} footprint should stay on the selected exposed surface`,
    );
    const hammered = hammerForgeComponent(faceHammerComponent, toolOptions);
    assert.ok(hammered.dimsQ[axis] < faceHammerComponent.dimsQ[axis], `hammering axis ${axis} side ${side} should compress the struck axis`);
    assert.strictEqual(hammered.solid, faceHammerComponent.solid, `hammering axis ${axis} side ${side} should displace material without deleting voxels`);
    assert.equal(
      forgeWorkbenchStats([hammered], [{ materialId: "iron", volumeMm3: 100_000 }]).usedVolumeMm3,
      forgeWorkbenchStats([faceHammerComponent], [{ materialId: "iron", volumeMm3: 100_000 }]).usedVolumeMm3,
      `hammering axis ${axis} side ${side} should conserve exact used material volume`,
    );
    let tangentExpanded = false;
    for (let candidate = 0; candidate < 3; candidate += 1) {
      if (candidate === axis) continue;
      assert.ok(hammered.dimsQ[candidate] >= faceHammerComponent.dimsQ[candidate], `hammering axis ${axis} side ${side} should not lose displaced material on tangent axis ${candidate}`);
      tangentExpanded ||= hammered.dimsQ[candidate] > faceHammerComponent.dimsQ[candidate];
    }
    assert.equal(tangentExpanded, true, `hammering axis ${axis} side ${side} should spread compressed material across a tangent axis`);
    const beforeBounds = forgeComponentAxisBoundsQ2(faceHammerComponent, axis);
    const afterBounds = forgeComponentAxisBoundsQ2(hammered, axis);
    const oppositeBoundary = side ? 0 : 1;
    assert.equal(
      afterBounds[oppositeBoundary],
      beforeBounds[oppositeBoundary],
      `hammering axis ${axis} side ${side} should keep the opposite Q2 boundary fixed`,
    );
    assert.ok(
      side ? afterBounds[1] < beforeBounds[1] : afterBounds[0] > beforeBounds[0],
      `hammering axis ${axis} side ${side} should move only the struck boundary inward`,
    );
  }
}
const lowTangentHammer = hammerForgeComponent(faceHammerComponent, {
  axis: 2,
  side: "high",
  plane: FORGE_COMPONENT_GRID.z,
  center: [1, 5, FORGE_COMPONENT_GRID.z - 1],
});
const highTangentHammer = hammerForgeComponent(faceHammerComponent, {
  axis: 2,
  side: "high",
  plane: FORGE_COMPONENT_GRID.z,
  center: [FORGE_COMPONENT_GRID.x - 2, 5, FORGE_COMPONENT_GRID.z - 1],
});
assert.ok(lowTangentHammer.offsetQ[0] < faceHammerComponent.offsetQ[0], "a low-X hammer footprint should displace spread material toward low X");
assert.ok(highTangentHammer.offsetQ[0] > faceHammerComponent.offsetQ[0], "a high-X hammer footprint should displace spread material toward high X");
assert.deepEqual(lowTangentHammer.solid, highTangentHammer.solid, "opposite local hammer strikes should conserve the identical solid mask");

const targetedDrillComponent = createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
  offsetQ: [16, -8, 24],
});
const targetedDrillCell = [3, 7, FORGE_COMPONENT_GRID.z - 1];
const targetedDrillRay = forgeComponentCellFaceRay(targetedDrillComponent, 2, 1, targetedDrillCell);
const targetedDrillMesh = buildForgeDesignMesh(createForgeDesign({ components: [targetedDrillComponent] }));
const targetedDrillHit = pickForgeMeshRay(targetedDrillMesh, targetedDrillRay);
assert.ok(targetedDrillHit, "drill targeting ray should hit the selected surface cell");
const targetedDrillOptions = forgeWorkbenchToolOptionsFromHit(targetedDrillComponent, "handDrill", targetedDrillHit);
assert.equal(targetedDrillOptions.axis, 2, "drill direction should follow the selected surface normal");
assert.equal(targetedDrillOptions.center[0], targetedDrillCell[0], "drill X center should derive from the mesh-local hit point");
assert.equal(targetedDrillOptions.center[1], targetedDrillCell[1], "drill Y center should derive from the mesh-local hit point");
const targetedDrilledComponent = drillForgeComponent(targetedDrillComponent, targetedDrillOptions);
for (let z = 0; z < FORGE_COMPONENT_GRID.z; z += 1) {
  assert.equal(targetedDrilledComponent.solid[forgeVoxelIndex(targetedDrillCell[0], targetedDrillCell[1], z)], 0, "drill hit options should cut the selected bore through its complete axis");
}
assert.equal(
  targetedDrilledComponent.solid[forgeVoxelIndex(targetedDrillCell[0] + 1, targetedDrillCell[1], 0)],
  1,
  "surface-directed drilling should leave an adjacent voxel column intact",
);
const targetedDrilledMesh = buildForgeDesignMesh(createForgeDesign({ components: [targetedDrilledComponent] }));
assert.equal(
  pickForgeMeshRay(targetedDrilledMesh, targetedDrillRay),
  null,
  "a ray through a drilled bore must not return the removed AABB entrance surface as a false hit",
);

const targetedSawOptions = forgeWorkbenchToolOptionsFromHit(targetedDrillComponent, "saw", targetedDrillHit, {
  angle: 90,
  mode: "kerf",
  depth: "shallow",
});
assert.equal(targetedSawOptions.axis, 2, "saw direction should follow the selected surface normal");
assert.equal(targetedSawOptions.side, "high", "saw depth should start at the selected positive face");
assert.equal(targetedSawOptions.center[0], targetedDrillCell[0], "saw X center should derive from the mesh-local hit point");
assert.equal(targetedSawOptions.center[1], targetedDrillCell[1], "saw Y center should derive from the mesh-local hit point");
const targetedSawedComponent = sawForgeComponent(targetedDrillComponent, targetedSawOptions);
for (let z = FORGE_COMPONENT_GRID.z - 4; z < FORGE_COMPONENT_GRID.z; z += 1) {
  assert.equal(
    targetedSawedComponent.solid[forgeVoxelIndex(targetedDrillCell[0], targetedDrillCell[1], z)],
    0,
    "surface-directed shallow sawing should cut inward from the selected high face",
  );
}
assert.equal(
  targetedSawedComponent.solid[forgeVoxelIndex(targetedDrillCell[0], targetedDrillCell[1], FORGE_COMPONENT_GRID.z - 5)],
  1,
  "surface-directed shallow sawing should stop after one quarter of the selected axis",
);

const protectedMachiningBase = createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
  offsetQ: [12, -6, 18],
});
const protectedDrill = drillForgeComponent(protectedMachiningBase, {
  axis: 2,
  side: "high",
  center: [7, 5, FORGE_COMPONENT_GRID.z - 1],
  size: 3,
  profile: "round",
  depth: "through",
});
assert.equal(protectedDrill.machining?.kind, FORGE_MACHINING_STATE_KIND, "drilling should retain a workbench-only physical machining checkpoint");
assert.equal(protectedDrill.machining.stamps.length, 1, "drilling should add one immutable machining stamp");
const protectedDrillStamp = protectedDrill.machining.stamps[0];
const protectedDrillBoundsQ2 = forgeMachinedBoundsQ2(protectedDrill);
const protectedDrillCells = forgeComponentSolidFraction(protectedDrill).solidCells;
const protectedGridSizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
for (let hammerAxis = 0; hammerAxis < 3; hammerAxis += 1) {
  for (const hammerSide of [0, 1]) {
    const center = protectedGridSizes.map((size) => Math.floor(size / 2));
    center[hammerAxis] = hammerSide ? protectedGridSizes[hammerAxis] - 1 : 0;
    const options = { axis: hammerAxis, side: hammerSide ? "high" : "low", center };
    const hammeredOnce = hammerForgeComponent(protectedDrill, options);
    const hammeredTwice = hammerForgeComponent(protectedDrill, options);
    assert.deepEqual(hammeredOnce, hammeredTwice, `machined hammer axis ${hammerAxis} side ${hammerSide} should remain deterministic`);
    assert.equal(
      forgeComponentSolidFraction(hammeredOnce).solidCells,
      protectedDrillCells,
      `machined hammer axis ${hammerAxis} side ${hammerSide} should conserve the exact used cell count`,
    );
    assert.deepEqual(
      hammeredOnce.machining.stamps[0].sizeQ,
      protectedDrillStamp.sizeQ,
      `machined hammer axis ${hammerAxis} side ${hammerSide} should retain the physical drill diameter`,
    );
    assertForgeMachiningCenterFollowsDeformation(
      protectedDrill,
      protectedDrillStamp,
      hammeredOnce,
      hammeredOnce.machining.stamps[0],
      `machined hammer axis ${hammerAxis} side ${hammerSide} should move the drill center with its material`,
    );
    const hammeredBoundsQ2 = forgeMachinedBoundsQ2(hammeredOnce);
    for (const tangentAxis of [0, 1]) {
      const beforeExtent = protectedDrillBoundsQ2.max[tangentAxis] - protectedDrillBoundsQ2.min[tangentAxis];
      const afterExtent = hammeredBoundsQ2.max[tangentAxis] - hammeredBoundsQ2.min[tangentAxis];
      const tolerance = Math.max(
        forgeComponentCellPitchQ2(protectedDrill, tangentAxis),
        forgeComponentCellPitchQ2(hammeredOnce, tangentAxis),
      );
      assert.ok(
        Math.abs(afterExtent - beforeExtent) <= tolerance,
        `machined hammer axis ${hammerAxis} side ${hammerSide} should keep drill extent within one fixed-grid cell on tangent axis ${tangentAxis}`,
      );
    }
  }
}

const edgeMachiningBase = createForgeComponent({
  resourceId: "iron",
  dimsQ: [76, 46, 65],
});
const edgeMachiningFixtures = [
  ["drill", drillForgeComponent(edgeMachiningBase, {
    axis: 2,
    side: "high",
    center: [0, 0, FORGE_COMPONENT_GRID.z - 1],
    size: 3,
    profile: "round",
    depth: "through",
  })],
  ["saw", sawForgeComponent(edgeMachiningBase, {
    axis: 2,
    side: "high",
    center: [0, 0, FORGE_COMPONENT_GRID.z - 1],
    angle: 0,
    mode: "kerf",
    depth: "through",
  })],
];
for (const [toolId, machined] of edgeMachiningFixtures) {
  const machinedCells = forgeComponentSolidFraction(machined).solidCells;
  const machiningStamp = machined.machining.stamps[0];
  for (let hammerAxis = 0; hammerAxis < 3; hammerAxis += 1) {
    for (const hammerSide of [0, 1]) {
      const center = protectedGridSizes.map((size) => Math.floor(size / 2));
      center[hammerAxis] = hammerSide ? protectedGridSizes[hammerAxis] - 1 : 0;
      const hammered = hammerForgeComponent(machined, {
        axis: hammerAxis,
        side: hammerSide ? "high" : "low",
        center,
      });
      assert.notStrictEqual(
        hammered,
        machined,
        `edge ${toolId} should allow its first hammer deformation on axis ${hammerAxis} side ${hammerSide}`,
      );
      assert.notDeepEqual(
        hammered.dimsQ,
        machined.dimsQ,
        `edge ${toolId} hammer axis ${hammerAxis} side ${hammerSide} should change dimensions`,
      );
      assert.equal(
        forgeComponentSolidFraction(hammered).solidCells,
        machinedCells,
        `edge ${toolId} hammer axis ${hammerAxis} side ${hammerSide} should conserve its exact material cells`,
      );
      const hammeredStamp = hammered.machining.stamps[0];
      assert.deepEqual(
        hammeredStamp.sizeQ,
        machiningStamp.sizeQ,
        `edge ${toolId} hammer axis ${hammerAxis} side ${hammerSide} should retain its physical tool size`,
      );
      assert.equal(
        hammeredStamp.depthQ,
        machiningStamp.depthQ,
        `edge ${toolId} hammer axis ${hammerAxis} side ${hammerSide} should retain its physical tool depth`,
      );
      if (machiningStamp.normalQ) {
        assert.deepEqual(
          hammeredStamp.normalQ,
          machiningStamp.normalQ,
          `edge ${toolId} hammer axis ${hammerAxis} side ${hammerSide} should retain its saw normal`,
        );
      }
      assertForgeMachiningCenterFollowsDeformation(
        machined,
        machiningStamp,
        hammered,
        hammeredStamp,
        `edge ${toolId} hammer axis ${hammerAxis} side ${hammerSide} should move its center with the material`,
      );
      const hammeredMesh = buildForgeDesignMesh(createForgeDesign({ components: [hammered] }));
      for (const raySide of [0, 1]) {
        assert.equal(
          pickForgeMeshRay(hammeredMesh, forgeMachiningStampRay(hammered, hammeredStamp, raySide)),
          null,
          `edge ${toolId} hammer axis ${hammerAxis} side ${hammerSide} should keep its through anchor open from ray side ${raySide}`,
        );
      }
    }
  }
}

const hammerBeforeMachining = hammerForgeComponent(protectedMachiningBase, {
  axis: 0,
  side: "high",
  center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
});
const drillAfterHammer = drillForgeComponent(hammerBeforeMachining, {
  axis: 2,
  side: "high",
  center: [7, 5, FORGE_COMPONENT_GRID.z - 1],
  size: 3,
  profile: "round",
  depth: "through",
});
assert.deepEqual(
  drillAfterHammer.machining.stamps[0].sizeQ,
  protectedDrillStamp.sizeQ,
  "drilling after a hammer deformation should use the pre-deformation physical tool diameter",
);
let repeatedlyHammeredDrill = protectedDrill;
for (let strike = 0; strike < 10; strike += 1) {
  repeatedlyHammeredDrill = hammerForgeComponent(repeatedlyHammeredDrill, {
    axis: strike % 2,
    side: strike % 3 ? "high" : "low",
    center: strike % 2 ? [7, 9, 7] : [13, 5, 7],
  });
  assert.equal(
    forgeComponentSolidFraction(repeatedlyHammeredDrill).solidCells,
    protectedDrillCells,
    `repeated machining-protected hammer strike ${strike + 1} should conserve exact used material`,
  );
  assert.deepEqual(
    repeatedlyHammeredDrill.machining.stamps[0].sizeQ,
    protectedDrillStamp.sizeQ,
    `repeated machining-protected hammer strike ${strike + 1} should retain the drill diameter`,
  );
  const repeatedlyHammeredMesh = buildForgeDesignMesh(createForgeDesign({
    components: [repeatedlyHammeredDrill],
  }));
  for (const side of [0, 1]) {
    assert.equal(
      pickForgeMeshRay(
        repeatedlyHammeredMesh,
        forgeMachiningStampRay(repeatedlyHammeredDrill, repeatedlyHammeredDrill.machining.stamps[0], side),
      ),
      null,
      `repeated machining-protected hammer strike ${strike + 1} should keep the drill center ray open from side ${side}`,
    );
  }
}

let gridBoundedDrill = protectedDrill;
for (let strike = 0; strike < 10; strike += 1) {
  gridBoundedDrill = hammerForgeComponent(gridBoundedDrill, {
    axis: 0,
    side: "high",
    center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
  });
}
assert.deepEqual(
  gridBoundedDrill.dimsQ,
  [84, 94, 128],
  "hammering should stop before a fixed drill footprint leaves the canonical grid envelope",
);
assert.strictEqual(
  hammerForgeComponent(gridBoundedDrill, {
    axis: 0,
    side: "high",
    center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
  }),
  gridBoundedDrill,
  "an unsupported extra deformation should be a deterministic no-op",
);
const gridBoundedDrillBoundsQ2 = forgeMachinedBoundsQ2(gridBoundedDrill);
for (const axis of [0, 1]) {
  const originalExtent = protectedDrillBoundsQ2.max[axis] - protectedDrillBoundsQ2.min[axis];
  const boundedExtent = gridBoundedDrillBoundsQ2.max[axis] - gridBoundedDrillBoundsQ2.min[axis];
  assert.ok(
    Math.abs(boundedExtent - originalExtent) <= forgeComponentCellPitchQ2(gridBoundedDrill, axis),
    `grid-bounded hammering should keep drill extent within one current cell on tangent axis ${axis}`,
  );
}
assert.equal(
  forgeComponentSolidFraction(gridBoundedDrill).solidCells,
  protectedDrillCells,
  "grid-bounded hammering should retain the exact material-cell budget",
);

let depthBoundedDrill = protectedDrill;
for (let strike = 0; strike < 10; strike += 1) {
  depthBoundedDrill = hammerForgeComponent(depthBoundedDrill, {
    axis: 2,
    side: "high",
    center: [7, 5, FORGE_COMPONENT_GRID.z - 1],
  });
}
assert.deepEqual(
  depthBoundedDrill.dimsQ,
  [136, 96, 78],
  "through-depth compression should stop before its tangent grid stretches the drill beyond one cell",
);
const depthBoundedDrillBoundsQ2 = forgeMachinedBoundsQ2(depthBoundedDrill);
for (const axis of [0, 1]) {
  const originalExtent = protectedDrillBoundsQ2.max[axis] - protectedDrillBoundsQ2.min[axis];
  const boundedExtent = depthBoundedDrillBoundsQ2.max[axis] - depthBoundedDrillBoundsQ2.min[axis];
  assert.ok(
    Math.abs(boundedExtent - originalExtent) <= forgeComponentCellPitchQ2(depthBoundedDrill, axis),
    `through-depth compression should keep drill extent within one current cell on tangent axis ${axis}`,
  );
}

const protectedSaw = sawForgeComponent(protectedMachiningBase, {
  axis: 2,
  side: "high",
  center: [7, 5, FORGE_COMPONENT_GRID.z - 1],
  angle: 90,
  mode: "kerf",
  depth: "through",
});
const protectedSawBoundsQ2 = forgeMachinedBoundsQ2(protectedSaw);
const protectedSawHammer = hammerForgeComponent(protectedSaw, {
  axis: 0,
  side: "high",
  center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
});
const protectedSawHammerBoundsQ2 = forgeMachinedBoundsQ2(protectedSawHammer);
assert.equal(
  forgeComponentSolidFraction(protectedSawHammer).solidCells,
  forgeComponentSolidFraction(protectedSaw).solidCells,
  "hammering a sawed component should conserve exact used material",
);
assert.ok(
  Math.abs(
    (protectedSawHammerBoundsQ2.max[0] - protectedSawHammerBoundsQ2.min[0])
    - (protectedSawBoundsQ2.max[0] - protectedSawBoundsQ2.min[0])
  ) <= forgeComponentCellPitchQ2(protectedSawHammer, 0),
  "hammering should keep a physical saw kerf within one fixed-grid cell of its original width",
);
let gridBoundedSaw = protectedSaw;
for (let strike = 0; strike < 10; strike += 1) {
  gridBoundedSaw = hammerForgeComponent(gridBoundedSaw, {
    axis: 0,
    side: "high",
    center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
  });
}
assert.deepEqual(
  gridBoundedSaw.dimsQ,
  [56, 114, 158],
  "repeated hammering should keep deterministic dimensions while the fixed saw kerf follows its material",
);
const gridBoundedSawBoundsQ2 = forgeMachinedBoundsQ2(gridBoundedSaw);
assert.ok(
  Math.abs(
    (gridBoundedSawBoundsQ2.max[0] - gridBoundedSawBoundsQ2.min[0])
    - (protectedSawBoundsQ2.max[0] - protectedSawBoundsQ2.min[0])
  ) <= forgeComponentCellPitchQ2(gridBoundedSaw, 0),
  "grid-bounded hammering should keep saw kerf width within one current cell",
);
assert.equal(
  forgeComponentSolidFraction(gridBoundedSaw).solidCells,
  forgeComponentSolidFraction(protectedSaw).solidCells,
  "grid-bounded saw deformation should retain the exact material-cell budget",
);

for (const trimSide of ["a", "b"]) {
  const protectedTrim = sawForgeComponent(createForgeComponent({
    resourceId: "iron",
    dimsQ: [112, 80, 112],
  }), {
    axis: 0,
    side: "low",
    center: [0, 5, 7],
    angle: 90,
    mode: "trim",
    trimSide,
    depth: "half",
  });
  const protectedTrimCells = forgeComponentSolidFraction(protectedTrim).solidCells;
  const trimHammerOptions = {
    axis: 1,
    side: "low",
    center: [7, 0, 7],
  };
  const hammeredTrim = hammerForgeComponent(protectedTrim, trimHammerOptions);
  assert.notStrictEqual(
    hammeredTrim,
    protectedTrim,
    `saw trim side ${trimSide} should allow its first grid-safe hammer deformation`,
  );
  assert.deepEqual(
    hammeredTrim.dimsQ,
    [120, 70, 120],
    `saw trim side ${trimSide} should keep deterministic dimensions after its first hammer deformation`,
  );
  assert.equal(
    forgeComponentSolidFraction(hammeredTrim).solidCells,
    protectedTrimCells,
    `saw trim side ${trimSide} hammering should conserve the exact material-cell budget`,
  );
  assert.strictEqual(
    hammerForgeComponent(hammeredTrim, trimHammerOptions),
    hammeredTrim,
    `saw trim side ${trimSide} should stop before repeated hammering crosses its retained cut side`,
  );
}

let retreatProtectedTrim = sawForgeComponent(createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
}), {
  axis: 1,
  side: "low",
  center: [7, 0, 7],
  angle: 0,
  mode: "trim",
  trimSide: "b",
  depth: "shallow",
});
const retreatProtectedTrimCells = forgeComponentSolidFraction(retreatProtectedTrim).solidCells;
const retreatTrimHammerOptions = {
  axis: 1,
  side: "low",
  center: [7, 0, 7],
};
retreatProtectedTrim = hammerForgeComponent(retreatProtectedTrim, retreatTrimHammerOptions);
retreatProtectedTrim = hammerForgeComponent(retreatProtectedTrim, retreatTrimHammerOptions);
assert.deepEqual(
  retreatProtectedTrim.dimsQ,
  [120, 70, 120],
  "repeated trim hammering should stop before any local cut-plane region retreats into the selected side",
);
assert.equal(
  forgeComponentSolidFraction(retreatProtectedTrim).solidCells,
  retreatProtectedTrimCells,
  "retreat-bounded trim hammering should retain the exact material-cell budget",
);
assert.strictEqual(
  hammerForgeComponent(retreatProtectedTrim, retreatTrimHammerOptions),
  retreatProtectedTrim,
  "trim hammering should stop when no further deformation can retain its physical cut plane",
);

let locallyRetreatingTrim = sawForgeComponent(createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
}), {
  axis: 0,
  side: "low",
  center: [0, 9, 13],
  angle: 30,
  mode: "trim",
  trimSide: "a",
  depth: "half",
});
const locallyRetreatingTrimCells = forgeComponentSolidFraction(locallyRetreatingTrim).solidCells;
const localRetreatHammerOptions = {
  axis: 2,
  side: "low",
  center: [7, 5, 0],
};
for (let strike = 0; strike < 4; strike += 1) {
  locallyRetreatingTrim = hammerForgeComponent(locallyRetreatingTrim, localRetreatHammerOptions);
}
assert.deepEqual(
  locallyRetreatingTrim.dimsQ,
  [128, 96, 82],
  "trim hammering should retain every locally valid deformation before a partial cut-plane retreat",
);
assert.equal(
  forgeComponentSolidFraction(locallyRetreatingTrim).solidCells,
  locallyRetreatingTrimCells,
  "locally bounded trim hammering should retain the exact material-cell budget",
);
assert.strictEqual(
  hammerForgeComponent(locallyRetreatingTrim, localRetreatHammerOptions),
  locallyRetreatingTrim,
  "trim validation should inspect the complete final solid instead of only the nearest owned cut cells",
);

let overlappingProtectedTrim = createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
});
overlappingProtectedTrim = sawForgeComponent(overlappingProtectedTrim, {
  axis: 2,
  side: "low",
  center: [1, 5, 0],
  angle: 90,
  mode: "trim",
  trimSide: "b",
  depth: "shallow",
});
overlappingProtectedTrim = sawForgeComponent(overlappingProtectedTrim, {
  axis: 2,
  side: "low",
  center: [3, 5, 0],
  angle: 90,
  mode: "trim",
  trimSide: "a",
  depth: "shallow",
});
const overlappingTrimCells = forgeComponentSolidFraction(overlappingProtectedTrim).solidCells;
const hammeredOverlappingTrim = hammerForgeComponent(overlappingProtectedTrim, {
  axis: 0,
  side: "low",
  center: [0, 5, 7],
});
assert.deepEqual(
  hammeredOverlappingTrim.dimsQ,
  [98, 86, 120],
  "overlapping trims should use their final solid union instead of a single-stamp owner subset",
);
assert.equal(
  forgeComponentSolidFraction(hammeredOverlappingTrim).solidCells,
  overlappingTrimCells,
  "overlapping trim hammering should retain the exact material-cell budget",
);

const anchoredSawBase = createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
  offsetQ: [12, -6, 18],
});
const anchoredSaw = sawForgeComponent(anchoredSawBase, {
  axis: 2,
  side: "low",
  center: [7, 5, 0],
  angle: 45,
  mode: "kerf",
  depth: "through",
});
const anchoredSawCells = forgeComponentSolidFraction(anchoredSaw).solidCells;
const anchoredSawHammer = hammerForgeComponent(anchoredSaw, {
  axis: 0,
  side: "low",
  center: [0, 7, 7],
});
assert.equal(anchoredSawCells, 1_820, "the through-saw anchor fixture should retain its canonical cut budget");
assert.equal(
  forgeComponentSolidFraction(anchoredSawHammer).solidCells,
  anchoredSawCells,
  "hammering a through-saw anchor should conserve its exact solid-cell count",
);
assertForgeMachiningCenterFollowsDeformation(
  anchoredSaw,
  anchoredSaw.machining.stamps[0],
  anchoredSawHammer,
  anchoredSawHammer.machining.stamps[0],
  "hammering should move the through-saw anchor with its material",
);
assert.deepEqual(
  anchoredSawHammer.machining.stamps[0].sizeQ,
  anchoredSaw.machining.stamps[0].sizeQ,
  "hammering should retain the through-saw's physical kerf",
);
const anchoredSawMesh = buildForgeDesignMesh(createForgeDesign({ components: [anchoredSawHammer] }));
for (const side of [0, 1]) {
  assert.equal(
    pickForgeMeshRay(
      anchoredSawMesh,
      forgeMachiningStampRay(anchoredSawHammer, anchoredSawHammer.machining.stamps[0], side),
    ),
    null,
    `the through-saw anchor should remain open from Z side ${side}`,
  );
}

let boundaryAnchoredSaw = sawForgeComponent(createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
  offsetQ: [12, -6, 18],
}), {
  axis: 0,
  side: "low",
  center: [0, 5, 7],
  angle: 45,
  mode: "kerf",
  depth: "through",
});
const boundaryAnchoredSawBeforeHammer = boundaryAnchoredSaw;
const boundaryAnchoredSawStampBeforeHammer = boundaryAnchoredSaw.machining.stamps[0];
const boundaryAnchoredSawCells = forgeComponentSolidFraction(boundaryAnchoredSaw).solidCells;
for (const [axis, side, center] of [
  [1, "low", [7, 0, 7]],
  [2, "high", [7, 5, 13]],
  [0, "low", [0, 5, 7]],
  [1, "high", [7, 9, 7]],
  [2, "low", [7, 5, 0]],
  [0, "high", [13, 5, 7]],
  [1, "low", [7, 0, 7]],
  [2, "high", [7, 5, 13]],
  [0, "low", [0, 5, 7]],
]) {
  boundaryAnchoredSaw = hammerForgeComponent(boundaryAnchoredSaw, {
    axis,
    side,
    center,
    compressionBps: 9_600,
  });
}
assert.deepEqual(boundaryAnchoredSaw.dimsQ, [112, 80, 112], "balanced boundary-anchor hammering should restore the original dimensions");
assert.deepEqual(boundaryAnchoredSaw.offsetQ, [15, -4, 15], "balanced boundary-anchor hammering should retain deterministic offset displacement");
assertForgeMachiningCenterFollowsDeformation(
  boundaryAnchoredSawBeforeHammer,
  boundaryAnchoredSawStampBeforeHammer,
  boundaryAnchoredSaw,
  boundaryAnchoredSaw.machining.stamps[0],
  "balanced boundary-anchor hammering should return the saw center with its material dimensions",
);
assert.deepEqual(
  boundaryAnchoredSaw.machining.stamps[0].sizeQ,
  boundaryAnchoredSawStampBeforeHammer.sizeQ,
  "balanced boundary-anchor hammering should retain the physical saw kerf",
);
assert.equal(
  forgeComponentSolidFraction(boundaryAnchoredSaw).solidCells,
  boundaryAnchoredSawCells,
  "boundary-anchor hammering should retain the exact material-cell budget",
);
const boundaryAnchoredSawMesh = buildForgeDesignMesh(createForgeDesign({ components: [boundaryAnchoredSaw] }));
for (const side of [0, 1]) {
  assert.equal(
    pickForgeMeshRay(
      boundaryAnchoredSawMesh,
      forgeMachiningStampRay(boundaryAnchoredSaw, boundaryAnchoredSaw.machining.stamps[0], side),
    ),
    null,
    `a saw center on a voxel boundary should remain open from X side ${side}`,
  );
}

let anchoredMultiThrough = drillForgeComponent(createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
}), {
  axis: 2,
  side: "high",
  center: [7, 5, FORGE_COMPONENT_GRID.z - 1],
  size: 3,
  profile: "round",
  depth: "through",
});
anchoredMultiThrough = sawForgeComponent(anchoredMultiThrough, {
  axis: 0,
  side: "high",
  center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
  angle: 45,
  mode: "kerf",
  depth: "through",
});
const anchoredMultiThroughCells = forgeComponentSolidFraction(anchoredMultiThrough).solidCells;
for (const hammerAxis of [1, 2, 0, 1]) {
  const center = protectedGridSizes.map((size) => Math.floor(size / 2));
  center[hammerAxis] = protectedGridSizes[hammerAxis] - 1;
  anchoredMultiThrough = hammerForgeComponent(anchoredMultiThrough, {
    axis: hammerAxis,
    side: "high",
    center,
  });
}
assert.equal(
  forgeComponentSolidFraction(anchoredMultiThrough).solidCells,
  anchoredMultiThroughCells,
  "multi-stamp through anchors should retain the exact target solid-cell count after repeated hammering",
);
const anchoredMultiThroughMesh = buildForgeDesignMesh(createForgeDesign({ components: [anchoredMultiThrough] }));
for (const stamp of anchoredMultiThrough.machining.stamps) {
  assert.equal(stamp.depthQ, 0, "the multi-stamp anchor fixture should contain only through cuts");
  for (const side of [0, 1]) {
    assert.equal(
      pickForgeMeshRay(
        anchoredMultiThroughMesh,
        forgeMachiningStampRay(anchoredMultiThrough, stamp, side),
      ),
      null,
      `repeated hammering should keep ${stamp.toolId} through anchor open from side ${side}`,
    );
  }
}

const orderedStampA = {
  axis: 2,
  side: "high",
  center: [12, 3, FORGE_COMPONENT_GRID.z - 1],
  size: 3,
  profile: "slot",
  direction: "b",
  depth: "half",
};
const orderedStampB = {
  axis: 0,
  side: "high",
  center: [FORGE_COMPONENT_GRID.x - 1, 1, 6],
  size: 3,
  profile: "slot",
  direction: "b",
  depth: "shallow",
};
const orderedStampHammer = {
  axis: 2,
  side: "low",
  center: [7, 5, 0],
};
const machineOrderedStamps = (first, second) => {
  let component = createForgeComponent({ resourceId: "iron", dimsQ: [112, 80, 112] });
  component = drillForgeComponent(component, first);
  component = drillForgeComponent(component, second);
  component = hammerForgeComponent(component, orderedStampHammer);
  return hammerForgeComponent(component, orderedStampHammer);
};
const orderedStampsAB = machineOrderedStamps(orderedStampA, orderedStampB);
const orderedStampsBA = machineOrderedStamps(orderedStampB, orderedStampA);
assert.equal(
  forgeComponentSolidFraction(orderedStampsAB).solidCells,
  forgeComponentSolidFraction(orderedStampsBA).solidCells,
  "canonical machining tie-breaks should retain the same exact cell budget for either stamp order",
);
assert.deepEqual(
  orderedStampsAB.solid,
  orderedStampsBA.solid,
  "canonical machining tie-breaks should make equivalent drill unions independent of stamp input order",
);

const protectedMachiningRecord = serializeForgeMachiningState(protectedSawHammer);
const protectedMachiningCanonical = createForgeDesign({
  equipment: { mass5g: 1, volumeCm3: 1, attributes6: new Uint8Array(FORGE_ATTRIBUTE_KEYS.length) },
  components: [protectedSawHammer],
});
const protectedMachiningBytes = encodeNcf1Bytes(protectedMachiningCanonical);
assert.ok(protectedMachiningBytes.length <= NCF1_MAX_RAW_BYTES, "machining resolution should remain inside the canonical NCF1 byte ceiling");
const protectedMachiningDecoded = decodeNcf1(protectedMachiningBytes);
assert.equal(Object.hasOwn(protectedMachiningDecoded.components[0], "machining"), false, "workbench machining history must not enter canonical NCF1");
const protectedMachiningRestored = restoreForgeMachiningState(
  protectedMachiningDecoded.components[0],
  protectedMachiningRecord,
);
assert.deepEqual(protectedMachiningRestored.solid, protectedSawHammer.solid, "draft machining restoration should reproduce the exact canonical solid mask");

const historylessCutComponent = createForgeComponent({
  resourceId: protectedDrill.resourceId,
  dimsQ: protectedDrill.dimsQ,
  offsetQ: protectedDrill.offsetQ,
  solid: protectedDrill.solid,
});
const historylessHammerOptions = {
  axis: 0,
  side: "high",
  center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
};
assert.strictEqual(
  hammerForgeComponent(historylessCutComponent, historylessHammerOptions),
  historylessCutComponent,
  "a canonical cut mask without physical machining history must not be stretched by hammering",
);
assert.strictEqual(
  normalizeForgeComponent(historylessCutComponent),
  historylessCutComponent,
  "a canonical cut mask without physical machining history must not be stretched by normalization",
);
const historylessCheckpoint = restoreForgeMachiningState(historylessCutComponent, null);
assert.strictEqual(
  hammerForgeComponent(historylessCheckpoint, historylessHammerOptions),
  historylessCheckpoint,
  "a migrated partial checkpoint must remain deformation-safe without inferred machining history",
);
const historylessAdditionalDrill = drillForgeComponent(historylessCheckpoint, {
  axis: 1,
  side: "low",
  center: [3, 0, 4],
  size: 1,
  profile: "round",
  depth: "through",
});
assert.strictEqual(
  hammerForgeComponent(historylessAdditionalDrill, historylessHammerOptions),
  historylessAdditionalDrill,
  "new stamps must not make an untracked partial base safe to deform",
);

let multiStampMachining = drillForgeComponent(protectedMachiningBase, {
  axis: 2,
  side: "high",
  center: [4, 4, FORGE_COMPONENT_GRID.z - 1],
  size: 3,
  profile: "round",
  depth: "through",
});
multiStampMachining = sawForgeComponent(multiStampMachining, {
  axis: 0,
  side: "low",
  center: [0, 7, 9],
  angle: 45,
  mode: "kerf",
  depth: "half",
});
multiStampMachining = drillForgeComponent(multiStampMachining, {
  axis: 1,
  side: "high",
  center: [10, FORGE_COMPONENT_GRID.y - 1, 5],
  size: 3,
  profile: "slot",
  direction: "b",
  depth: "shallow",
});
multiStampMachining = rotateForgeComponent(multiStampMachining, "y");
multiStampMachining = hammerForgeComponent(multiStampMachining, {
  axis: 0,
  side: "high",
  center: [FORGE_COMPONENT_GRID.x - 1, 5, 7],
});
const multiStampRecord = JSON.parse(JSON.stringify(serializeForgeMachiningState(multiStampMachining)));
assert.equal(multiStampRecord.stamps.length, 3, "machining drafts should retain every ordered drill and saw stamp");
const multiStampCanonical = createForgeDesign({
  equipment: { mass5g: 1, volumeCm3: 1, attributes6: new Uint8Array(FORGE_ATTRIBUTE_KEYS.length) },
  components: [multiStampMachining],
});
const multiStampBytes = encodeNcf1Bytes(multiStampCanonical);
const multiStampDecoded = decodeNcf1(multiStampBytes);
const multiStampRestored = restoreForgeMachiningState(
  multiStampDecoded.components[0],
  multiStampRecord,
);
assert.deepEqual(multiStampRestored.solid, multiStampMachining.solid, "multi-stamp JSON restoration should reproduce the exact canonical solid mask");
assert.deepEqual(serializeForgeMachiningState(multiStampRestored), multiStampRecord, "multi-stamp JSON restoration should preserve the canonical draft record");
assert.equal(Object.hasOwn(multiStampDecoded.components[0], "machining"), false, "multi-stamp machining history must not enter decoded NCF1 components");
const machiningFreeComponent = { ...multiStampMachining };
delete machiningFreeComponent.machining;
assert.deepEqual(
  multiStampBytes,
  encodeNcf1Bytes(createForgeDesign({
    equipment: multiStampCanonical.equipment,
    components: [machiningFreeComponent],
  })),
  "adding workbench-only machining history must not change canonical NCF1 bytes after the solid is resolved",
);

const cloneMachiningRecord = () => JSON.parse(JSON.stringify(multiStampRecord));
const machiningBase64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const corruptMachiningRecords = [
  ["missing stamps", (record) => { delete record.stamps; }, "invalid-machining-state"],
  ["non-array stamps", (record) => { record.stamps = "invalid"; }, "invalid-machining-state"],
  ["unexpected state field", (record) => { record.extra = true; }, "invalid-machining-state"],
  ["string reference dimension", (record) => { record.referenceDimsQ[0] = String(record.referenceDimsQ[0]); }, "invalid-machining-state"],
  ["missing base solid", (record) => { record.baseSolidBits = null; }, "invalid-machining-state"],
  ["base solid without stamps", (record) => { record.stamps = []; }, "invalid-machining-state"],
  ["non-canonical base solid", (record) => {
    const last = record.baseSolidBits.at(-1);
    const index = machiningBase64UrlAlphabet.indexOf(last);
    assert.equal(index % 4, 0, "machining bitsets should end in a canonical base64url sextet");
    record.baseSolidBits = `${record.baseSolidBits.slice(0, -1)}${machiningBase64UrlAlphabet[index + 1]}`;
  }, "invalid-machining-state"],
  ["too many stamps", (record) => {
    record.stamps = Array.from({ length: 129 }, () => JSON.parse(JSON.stringify(record.stamps[0])));
  }, "too-many-machining-stamps"],
  ["missing stamp depth", (record) => { delete record.stamps[0].depthQ; }, "invalid-machining-stamp"],
  ["unexpected stamp field", (record) => { record.stamps[0].extra = true; }, "invalid-machining-stamp"],
  ["string stamp axis", (record) => { record.stamps[0].axis = String(record.stamps[0].axis); }, "invalid-machining-stamp"],
  ["invalid drill profile", (record) => { record.stamps[0].profile = "invalid"; }, "invalid-machining-stamp"],
  ["invalid drill direction", (record) => { record.stamps[0].direction = "invalid"; }, "invalid-machining-stamp"],
  ["invalid saw angle", (record) => { record.stamps[1].angle = 13; }, "invalid-machining-stamp"],
  ["invalid saw mode", (record) => { record.stamps[1].mode = "invalid"; }, "invalid-machining-stamp"],
  ["invalid saw trim side", (record) => { record.stamps[1].trimSide = "invalid"; }, "invalid-machining-stamp"],
];
for (const [label, corrupt, expectedCode] of corruptMachiningRecords) {
  const record = cloneMachiningRecord();
  corrupt(record);
  assert.throws(
    () => restoreForgeMachiningState(multiStampDecoded.components[0], record),
    (error) => error?.code === expectedCode,
    `machining draft restoration should reject ${label}`,
  );
}

const forgeGridSizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
for (let axis = 0; axis < 3; axis += 1) {
  for (const side of [0, 1]) {
    const tunnelSolid = new Uint8Array(faceHammerComponent.solid);
    const tunnelCell = forgeGridSizes.map((size) => Math.floor(size / 2));
    tunnelCell[axis] = side ? forgeGridSizes[axis] - 1 : 0;
    for (let depth = 0; depth < 2; depth += 1) {
      const cell = [...tunnelCell];
      cell[axis] = side ? forgeGridSizes[axis] - 1 - depth : depth;
      tunnelSolid[forgeVoxelIndex(cell[0], cell[1], cell[2])] = 0;
    }
    const tunnelComponent = createForgeComponent({
      resourceId: "iron",
      dimsQ: [112, 80, 112],
      solid: tunnelSolid,
    });
    const tunnelMesh = buildForgeDesignMesh(createForgeDesign({ components: [tunnelComponent] }));
    const tunnelHit = pickForgeMeshRay(tunnelMesh, forgeComponentCellFaceRay(tunnelComponent, axis, side, tunnelCell));
    assert.ok(tunnelHit, `axis ${axis} side ${side} tunnel ray should reach the first internal material face`);
    assert.equal(tunnelHit.face.axis, axis, `axis ${axis} side ${side} internal hit should preserve its normal axis`);
    assert.equal(tunnelHit.face.side, side, `axis ${axis} side ${side} internal hit should preserve its normal side`);
    const expectedPlane = side ? forgeGridSizes[axis] - 2 : 2;
    const expectedFirstLayer = side ? expectedPlane - 1 : expectedPlane;

    for (const [toolId, transform, extraOptions] of [
      ["handDrill", drillForgeComponent, { size: 1, profile: "round", depth: "shallow" }],
      ["saw", sawForgeComponent, { angle: 90, mode: "kerf", depth: "shallow" }],
    ]) {
      const hitOptions = forgeWorkbenchToolOptionsFromHit(tunnelComponent, toolId, tunnelHit, extraOptions);
      assert.equal(hitOptions.plane, expectedPlane, `${toolId} axis ${axis} side ${side} should retain the actual internal hit plane`);
      const footprint = resolveForgeToolFootprint(tunnelComponent, toolId, hitOptions);
      assert.equal(footprint.layers[0], expectedFirstLayer, `${toolId} axis ${axis} side ${side} should start at the internal surface cell`);
      assert.equal(
        footprint.layers[1],
        expectedFirstLayer + (side ? -1 : 1),
        `${toolId} axis ${axis} side ${side} should spend its next depth layer moving inward`,
      );
      const transformed = transform(tunnelComponent, hitOptions);
      assert.deepEqual(
        forgeRemovedCellIndices(tunnelComponent, transformed),
        footprint.cells.map((cell) => forgeVoxelIndex(cell[0], cell[1], cell[2])).sort((left, right) => left - right),
        `${toolId} axis ${axis} side ${side} transform should remove exactly its shared internal-plane footprint`,
      );
    }

    const axeOptions = forgeWorkbenchToolOptionsFromHit(tunnelComponent, "axe", tunnelHit, {
      size: 3,
      maxInset: 3,
    });
    const axeFootprint = resolveForgeToolFootprint(tunnelComponent, "axe", axeOptions);
    const axeCut = taperForgeComponent(tunnelComponent, axeOptions);
    assert.ok(axeFootprint.cells.length > 0, `axe axis ${axis} side ${side} should resolve a non-empty local wedge`);
    assert.ok(axeFootprint.cells.length < FORGE_COMPONENT_GRID.x * FORGE_COMPONENT_GRID.y, `axe axis ${axis} side ${side} should stay local instead of tapering the whole workpiece`);
    assert.deepEqual(
      forgeRemovedCellIndices(tunnelComponent, axeCut),
      axeFootprint.cells.map((cell) => forgeVoxelIndex(cell[0], cell[1], cell[2])).sort((left, right) => left - right),
      `axe axis ${axis} side ${side} should remove exactly its shared wedge footprint`,
    );
    assert.ok(forgeComponentSolidFraction(axeCut).solidCells > 0, `axe axis ${axis} side ${side} should preserve at least one solid cell`);
  }
}

const lowAxeCenter = taperForgeComponent(faceHammerComponent, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [2, 2, FORGE_COMPONENT_GRID.z - 1],
});
const highAxeCenter = taperForgeComponent(faceHammerComponent, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [11, 7, FORGE_COMPONENT_GRID.z - 1],
});
assert.notDeepEqual(
  forgeRemovedCellIndices(faceHammerComponent, lowAxeCenter),
  forgeRemovedCellIndices(faceHammerComponent, highAxeCenter),
  "distant axe hits should cut different local wedges",
);
const minimalCutSolid = new Uint8Array(faceHammerComponent.solid.length);
minimalCutSolid[forgeVoxelIndex(7, 5, 12)] = 1;
minimalCutSolid[forgeVoxelIndex(7, 5, 13)] = 1;
const minimalCutComponent = createForgeComponent({ resourceId: "iron", dimsQ: [100, 100, 100], solid: minimalCutSolid });
const minimalDrillOptions = {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [7, 5, 13], size: 1, depth: "through",
};
const minimalDrillFootprint = resolveForgeToolFootprint(minimalCutComponent, "handDrill", minimalDrillOptions);
const minimalDrillCut = drillForgeComponent(minimalCutComponent, minimalDrillOptions);
assert.equal(minimalDrillFootprint.cells.length, 1, "an all-covering tool footprint should reserve one deterministic material cell");
assert.deepEqual(
  forgeRemovedCellIndices(minimalCutComponent, minimalDrillCut),
  minimalDrillFootprint.cells.map((cell) => forgeVoxelIndex(cell[0], cell[1], cell[2])),
  "the shared footprint should remain exact when the one-cell preservation rule applies",
);
assert.equal(forgeComponentSolidFraction(minimalDrillCut).solidCells, 1, "an all-covering tool cut should retain exactly one material cell");

const forgeShapeToolFixture = createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
});
const forgeShapeToolCenter = [7, 5, FORGE_COMPONENT_GRID.z - 1];
const expectedZDepthLayers = {
  shallow: Math.ceil(FORGE_COMPONENT_GRID.z / 4),
  half: Math.ceil(FORGE_COMPONENT_GRID.z / 2),
  through: FORGE_COMPONENT_GRID.z,
};
for (const [depth, depthLayers] of Object.entries(expectedZDepthLayers)) {
  for (const side of ["low", "high"]) {
    const sawed = sawForgeComponent(forgeShapeToolFixture, {
      axis: 2,
      side,
      center: forgeShapeToolCenter,
      angle: 90,
      mode: "kerf",
      depth,
    });
    for (let z = 0; z < FORGE_COMPONENT_GRID.z; z += 1) {
      const shouldCut = side === "low" ? z < depthLayers : z >= FORGE_COMPONENT_GRID.z - depthLayers;
      assert.equal(
        sawed.solid[forgeVoxelIndex(forgeShapeToolCenter[0], forgeShapeToolCenter[1], z)],
        shouldCut ? 0 : 1,
        `saw ${depth} depth should cut exactly ${depthLayers} layers inward from the ${side} face`,
      );
      assert.equal(
        sawed.solid[forgeVoxelIndex(forgeShapeToolCenter[0] + 1, forgeShapeToolCenter[1], z)],
        1,
        `saw ${depth} kerf should leave the adjacent column intact`,
      );
    }
  }
}
const sawAngle45 = sawForgeComponent(forgeShapeToolFixture, {
  axis: 2,
  side: "high",
  center: forgeShapeToolCenter,
  angle: 45,
  mode: "kerf",
  depth: "half",
});
const sawAngle44 = sawForgeComponent(forgeShapeToolFixture, {
  axis: 2,
  side: "high",
  center: forgeShapeToolCenter,
  angle: 44,
  mode: "kerf",
  depth: "half",
});
assert.deepEqual(sawAngle44.solid, sawAngle45.solid, "saw angles should quantize to the shared fixed-angle table");
assert.deepEqual(
  sawForgeComponent(forgeShapeToolFixture, {
    axis: 2,
    side: "high",
    center: forgeShapeToolCenter,
    angle: 45,
    mode: "kerf",
    depth: "half",
  }).solid,
  sawAngle45.solid,
  "fixed-angle saw cuts should be byte deterministic",
);
const sawKerf = sawForgeComponent(forgeShapeToolFixture, {
  axis: 2,
  side: "high",
  center: [6, 5, FORGE_COMPONENT_GRID.z - 1],
  angle: 90,
  mode: "kerf",
  depth: "shallow",
});
const sawTrimA = sawForgeComponent(forgeShapeToolFixture, {
  axis: 2,
  side: "high",
  center: [6, 5, FORGE_COMPONENT_GRID.z - 1],
  angle: 90,
  mode: "trim",
  trimSide: "a",
  depth: "shallow",
});
const sawTrimB = sawForgeComponent(forgeShapeToolFixture, {
  axis: 2,
  side: "high",
  center: [6, 5, FORGE_COMPONENT_GRID.z - 1],
  angle: 90,
  mode: "trim",
  trimSide: "b",
  depth: "shallow",
});
assert.ok(
  forgeRemovedCellCount(forgeShapeToolFixture, sawTrimA) > forgeRemovedCellCount(forgeShapeToolFixture, sawKerf),
  "saw trim mode should remove one selected side of the cut instead of only its kerf",
);
assert.equal(sawTrimA.solid[forgeVoxelIndex(0, 5, FORGE_COMPONENT_GRID.z - 1)], 0, "saw trim side A should remove its selected half-plane");
assert.equal(sawTrimA.solid[forgeVoxelIndex(13, 5, FORGE_COMPONENT_GRID.z - 1)], 1, "saw trim side A should retain the opposite half-plane");
assert.equal(sawTrimB.solid[forgeVoxelIndex(0, 5, FORGE_COMPONENT_GRID.z - 1)], 1, "saw trim side B should retain side A");
assert.equal(sawTrimB.solid[forgeVoxelIndex(13, 5, FORGE_COMPONENT_GRID.z - 1)], 0, "saw trim side B should remove the opposite half-plane");
const sawTrimAAdvisory = forgeWorkbenchPhysicalAdvisory([sawTrimA], [{ materialId: "iron", volumeMm3: 100_000 }]);
const sawTrimBAdvisory = forgeWorkbenchPhysicalAdvisory([sawTrimB], [{ materialId: "iron", volumeMm3: 100_000 }]);
assert.ok(sawTrimAAdvisory.centerOfMassQ[0] > 0, "removing the low-X half should move the advisory COM toward high X");
assert.ok(sawTrimBAdvisory.centerOfMassQ[0] < 0, "removing the high-X half should move the advisory COM toward low X");
assert.notDeepEqual(sawTrimAAdvisory.inertiaQ2, sawTrimBAdvisory.inertiaQ2, "different integer mass distributions should expose independently testable inertia hints");
assert.deepEqual(
  forgeWorkbenchPhysicalAdvisory([sawTrimA], [{ materialId: "iron", volumeMm3: 100_000 }]),
  sawTrimAAdvisory,
  "COM and inertia advisory calculations should be deterministic for the same canonical workpiece",
);

const drillFootprintCounts = {
  round: { 1: 1, 3: 5, 5: 13 },
  square: { 1: 1, 3: 9, 5: 25 },
  slot: { 1: 1, 3: 5, 5: 21 },
};
for (const [profile, counts] of Object.entries(drillFootprintCounts)) {
  for (const [sizeText, footprintCells] of Object.entries(counts)) {
    const size = Number(sizeText);
    const drilled = drillForgeComponent(forgeShapeToolFixture, {
      axis: 2,
      side: "high",
      center: forgeShapeToolCenter,
      size,
      profile,
      direction: "a",
      depth: "shallow",
    });
    assert.equal(
      forgeRemovedCellCount(forgeShapeToolFixture, drilled),
      footprintCells * expectedZDepthLayers.shallow,
      `${profile} drill size ${size} should use its deterministic ${footprintCells}-cell footprint`,
    );
  }
}
for (const [depth, depthLayers] of Object.entries(expectedZDepthLayers)) {
  for (const side of ["low", "high"]) {
    const drilled = drillForgeComponent(forgeShapeToolFixture, {
      axis: 2,
      side,
      center: forgeShapeToolCenter,
      size: 1,
      profile: "round",
      depth,
    });
    for (let z = 0; z < FORGE_COMPONENT_GRID.z; z += 1) {
      const shouldCut = side === "low" ? z < depthLayers : z >= FORGE_COMPONENT_GRID.z - depthLayers;
      assert.equal(
        drilled.solid[forgeVoxelIndex(forgeShapeToolCenter[0], forgeShapeToolCenter[1], z)],
        shouldCut ? 0 : 1,
        `drill ${depth} depth should cut exactly ${depthLayers} layers inward from the ${side} face`,
      );
    }
  }
}
const slotDrillA = drillForgeComponent(forgeShapeToolFixture, {
  axis: 2,
  side: "high",
  center: forgeShapeToolCenter,
  size: 3,
  profile: "slot",
  direction: "a",
  depth: "shallow",
});
const slotDrillB = drillForgeComponent(forgeShapeToolFixture, {
  axis: 2,
  side: "high",
  center: forgeShapeToolCenter,
  size: 3,
  profile: "slot",
  direction: "b",
  depth: "shallow",
});
assert.equal(slotDrillA.solid[forgeVoxelIndex(9, 5, FORGE_COMPONENT_GRID.z - 1)], 0, "slot direction A should extend along the first tangent axis");
assert.equal(slotDrillA.solid[forgeVoxelIndex(7, 7, FORGE_COMPONENT_GRID.z - 1)], 1, "slot direction A should stay narrow on the second tangent axis");
assert.equal(slotDrillB.solid[forgeVoxelIndex(9, 5, FORGE_COMPONENT_GRID.z - 1)], 1, "slot direction B should stay narrow on the first tangent axis");
assert.equal(slotDrillB.solid[forgeVoxelIndex(7, 7, FORGE_COMPONENT_GRID.z - 1)], 0, "slot direction B should extend along the second tangent axis");

const forgePaintFixture = createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
});
for (const [size, paintedCells] of [[1, 1], [3, 9], [5, 25]]) {
  const painted = paintForgeComponent(forgePaintFixture, {
    axis: 2,
    side: "high",
    plane: FORGE_COMPONENT_GRID.z,
    center: forgeShapeToolCenter,
    size,
    mode: "paint",
    color444: 0xf84,
  });
  assert.equal(forgePaintCellsForTest(painted).size, paintedCells, `paint brush size ${size} should affect only its local exposed footprint`);
}
const selectivelyExposedSolid = new Uint8Array(forgePaintFixture.solid);
selectivelyExposedSolid[forgeVoxelIndex(7, 5, 7)] = 0;
selectivelyExposedSolid[forgeVoxelIndex(8, 5, 7)] = 0;
const selectivelyExposedComponent = createForgeComponent({
  resourceId: "iron",
  dimsQ: [112, 80, 112],
  solid: selectivelyExposedSolid,
});
const selectivelyPainted = paintForgeComponent(selectivelyExposedComponent, {
  axis: 2,
  side: "high",
  plane: 7,
  center: [7, 5, 6],
  size: 3,
  mode: "paint",
  color444: 0xf84,
});
assert.deepEqual(
  [...forgePaintCellsForTest(selectivelyPainted).keys()].sort(),
  [
    forgePaintCellKeyForTest(2, 1, 7, 7, 5),
    forgePaintCellKeyForTest(2, 1, 7, 8, 5),
  ].sort(),
  "paint should affect only solid cells whose selected faces are actually exposed",
);
const largePaintPatch = paintForgeComponent(forgePaintFixture, {
  axis: 2,
  side: "high",
  plane: FORGE_COMPONENT_GRID.z,
  center: forgeShapeToolCenter,
  size: 5,
  mode: "paint",
  color444: 0xf84,
});
const erasedPaintPatch = paintForgeComponent(largePaintPatch, {
  axis: 2,
  side: "high",
  plane: FORGE_COMPONENT_GRID.z,
  center: forgeShapeToolCenter,
  size: 3,
  mode: "erase",
});
const erasedPaintCells = forgePaintCellsForTest(erasedPaintPatch);
assert.equal(erasedPaintCells.size, 16, "paint erase size 3 should remove only the central nine cells from a size-5 patch");
assert.equal(erasedPaintCells.has(forgePaintCellKeyForTest(2, 1, FORGE_COMPONENT_GRID.z, 7, 5)), false, "paint erase should clear the selected cell");
assert.equal(erasedPaintCells.has(forgePaintCellKeyForTest(2, 1, FORGE_COMPONENT_GRID.z, 5, 3)), true, "paint erase should retain cells outside its footprint");

let sawPaintFixture = paintForgeComponent(forgePaintFixture, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [7, 5, 13], size: 1, color444: 0xf84,
});
sawPaintFixture = paintForgeComponent(sawPaintFixture, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [10, 5, 13], size: 1, color444: 0x4bd,
});
const sawPrunedPaint = sawForgeComponent(sawPaintFixture, {
  axis: 2, side: "high", center: [7, 5, 13], angle: 90, mode: "kerf", depth: "through",
});
const sawPrunedPaintCells = forgePaintCellsForTest(sawPrunedPaint);
assert.equal(sawPrunedPaintCells.has(forgePaintCellKeyForTest(2, 1, 14, 7, 5)), false, "sawing should prune paint attached to a removed cell");
assert.equal(sawPrunedPaintCells.get(forgePaintCellKeyForTest(2, 1, 14, 10, 5)), 0x4bd, "sawing should preserve paint on an unaffected exposed face");

let drillPaintFixture = paintForgeComponent(forgePaintFixture, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [7, 5, 13], size: 1, color444: 0xf84,
});
drillPaintFixture = paintForgeComponent(drillPaintFixture, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [10, 5, 13], size: 1, color444: 0x4bd,
});
const drillPrunedPaint = drillForgeComponent(drillPaintFixture, {
  axis: 2, side: "high", center: [7, 5, 13], size: 1, profile: "round", depth: "through",
});
const drillPrunedPaintCells = forgePaintCellsForTest(drillPrunedPaint);
assert.equal(drillPrunedPaintCells.has(forgePaintCellKeyForTest(2, 1, 14, 7, 5)), false, "drilling should prune paint attached to a removed cell");
assert.equal(drillPrunedPaintCells.get(forgePaintCellKeyForTest(2, 1, 14, 10, 5)), 0x4bd, "drilling should preserve paint on an unaffected exposed face");

let taperPaintFixture = paintForgeComponent(forgePaintFixture, {
  axis: 1, side: "high", plane: FORGE_COMPONENT_GRID.y, center: [0, 9, 7], size: 1, color444: 0xf84,
});
taperPaintFixture = paintForgeComponent(taperPaintFixture, {
  axis: 1, side: "low", plane: 0, center: [7, 0, 7], size: 1, color444: 0x4bd,
});
const taperPrunedPaint = taperForgeComponent(taperPaintFixture, { axis: 1, side: "high" });
const taperPrunedPaintCells = forgePaintCellsForTest(taperPrunedPaint);
assert.equal(taperPrunedPaintCells.has(forgePaintCellKeyForTest(1, 1, 10, 0, 7)), false, "tapering should prune paint attached to a removed cell");
assert.equal(taperPrunedPaintCells.get(forgePaintCellKeyForTest(1, 0, 0, 7, 7)), 0x4bd, "tapering should preserve paint on an unaffected exposed face");

let localAxePaintFixture = paintForgeComponent(forgePaintFixture, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [7, 5, 13], size: 1, color444: 0xf84,
});
localAxePaintFixture = paintForgeComponent(localAxePaintFixture, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [12, 5, 13], size: 1, color444: 0x4bd,
});
const localAxePaintCut = taperForgeComponent(localAxePaintFixture, {
  axis: 2, side: "high", plane: FORGE_COMPONENT_GRID.z, center: [7, 5, 13], size: 3, maxInset: 3,
});
const localAxePaintCells = forgePaintCellsForTest(localAxePaintCut);
assert.equal(localAxePaintCells.has(forgePaintCellKeyForTest(2, 1, 14, 7, 5)), false, "a local axe cut should prune paint attached to its removed wedge");
assert.equal(localAxePaintCells.get(forgePaintCellKeyForTest(2, 1, 14, 12, 5)), 0x4bd, "a local axe cut should preserve paint outside its wedge footprint");

const normalizableComponent = paintForgeComponent(createForgeComponent({
  resourceId: "iron",
  dimsQ: [40, 100, 160],
  offsetQ: [12, -34, 56],
}), {
  axis: 2,
  side: "high",
  plane: FORGE_COMPONENT_GRID.z,
  center: forgeShapeToolCenter,
  size: 3,
  color444: 0xf84,
});
const normalizedComponent = normalizeForgeComponent(normalizableComponent);
assert.deepEqual(normalizedComponent.dimsQ, [60, 100, 140], "component normalization should move only dimensions toward their shared average");
assert.deepEqual(normalizedComponent.offsetQ, normalizableComponent.offsetQ, "component normalization should preserve its workbench offset");
assert.strictEqual(normalizedComponent.solid, normalizableComponent.solid, "component normalization should structurally share the unchanged solid mask");
assert.strictEqual(normalizedComponent.paintQuads, normalizableComponent.paintQuads, "component normalization should structurally share unchanged paint data");
assert.deepEqual(normalizableComponent.dimsQ, [40, 100, 160], "component normalization must not mutate its input dimensions");

const lowCutFloorComponent = sawForgeComponent(createForgeComponent({
  resourceId: "iron",
  dimsQ: [64, 64, 64],
  offsetQ: [0, 0, 0],
}), { axis: 1, side: "low", layers: 2 });
const lowCutOccupiedBounds = forgeComponentOccupiedBoundsQ2(lowCutFloorComponent);
assert.ok(lowCutOccupiedBounds.minQ2[1] > -64, "occupied bounds should follow material removed from the bottom voxel layers");
const lowCutMesh = buildForgeDesignMesh(createForgeDesign({ components: [lowCutFloorComponent] }));
assert.equal(
  lowCutMesh.pickBounds[0].min[1] * 128,
  lowCutOccupiedBounds.minQ2[1],
  "renderer pick and collision bounds should match the exact occupied voxel surface",
);

assert.equal(typeof ForgeWorkbenchRenderer, "function", "native on-demand forge workbench renderer should be exported");
assert.deepEqual(
  DEFAULT_FORGE_BENCH_CUBOIDS.filter((part) => ["deck", "rim-back", "rim-front", "rim-left", "rim-right", "coal-core", "anvil-foot", "anvil-top"].includes(part.id)).map((part) => part.id),
  ["deck"],
  "the forge work surface should be one uninterrupted deck without fire, anvil, or raised rims",
);
assert.deepEqual(FORGE_TOOL_VISUAL_IDS, ["hammer", "saw", "handDrill", "grip", "axe", "paintBrush"], "forge renderer should expose every batched tool visual");
for (const toolId of FORGE_TOOL_VISUAL_IDS) {
  const toolMesh = createForgeToolVisualMesh(toolId);
  assert.ok(toolMesh?.indexCount > 0, `${toolId} should have a native packed 3D mesh`);
  assert.equal(toolMesh.vertexStrideBytes, FORGE_MESH_VERTEX_STRIDE_BYTES, `${toolId} should reuse the native forge vertex layout`);
  assert.equal(toolMesh.indices.length, toolMesh.indexCount, `${toolId} should be represented by one batched indexed mesh`);
}
const transformGizmoMesh = createForgeTransformGizmoMesh();
const constructionReticleMesh = createForgeConstructionReticleMesh();
assert.ok(transformGizmoMesh.indexCount > 0, "the glove transform gizmo should use one packed static mesh");
assert.ok(constructionReticleMesh.indexCount > 0, "the construction reticle should use one packed static mesh");
assert.equal(transformGizmoMesh.vertexStrideBytes, FORGE_MESH_VERTEX_STRIDE_BYTES, "the transform gizmo should reuse the forge vertex layout");
assert.equal(constructionReticleMesh.vertexStrideBytes, FORGE_MESH_VERTEX_STRIDE_BYTES, "the construction reticle should reuse the forge vertex layout");
const xAxisGizmoHit = pickForgeAxisGizmoRay(
  { origin: [0.8, 0.04, 5], direction: [0, 0, -1] },
  { center: [0, 0, 0], scale: 1 },
);
assert.equal(xAxisGizmoHit?.axis, 0, "analytic gizmo picking should identify the X handle without triangle scans");
const yDragPlane = forgeAxisDragPlaneNormal([0, 1, 0], [0, 0, 5]);
assertVectorNear(yDragPlane, [0, 0, 1], "Y-axis dragging should use a camera-facing plane that contains Y");
assertVectorNear(
  intersectRayPlane({ origin: [0, 2, 5], direction: [0, 0, -1] }, [0, 0, 0], yDragPlane),
  [0, 2, 0],
  "axis drag rays should retain their constrained-axis coordinate",
);
const visualHit = { index: 0, point: [0.2, 1.9, -0.3], face: { axis: 1, side: 1, normal: [0, 1, 0] } };
const hammerContactPose = sampleForgeToolVisualPose("hammer", {
  hit: visualHit,
  cameraEye: [4, 5, 6],
  elapsedSeconds: forgeToolActionDuration("hammer") * 0.62,
});
assert.ok(hammerContactPose?.basis.every(Number.isFinite), "hammer action should produce a finite face-relative pose");
const sawStartPose = sampleForgeToolVisualPose("saw", { hit: visualHit, settings: { angle: 45 }, elapsedSeconds: 0 });
const sawTravelPose = sampleForgeToolVisualPose("saw", { hit: visualHit, settings: { angle: 45 }, elapsedSeconds: 0.07 });
assert.ok(floatArraysDiffer(sawStartPose.translation, sawTravelPose.translation), "saw action should travel along its configured cut angle");
const drillPose = sampleForgeToolVisualPose("handDrill", { hit: visualHit, elapsedSeconds: 0.1 });
assert.equal(drillPose.spinComponentIndex, 1, "hand drill should spin only its batched bit component");
assert.ok(drillPose.spinRadians > 0, "hand drill action should use elapsed-time-based bit rotation");
const gripPose = sampleForgeToolVisualPose("grip", { hit: visualHit, settings: { rotation: 1, valid: false }, preview: true });
assert.equal(gripPose.unlit, 1, "grip hand should retain its legacy unlit overlay style");
assert.ok(gripPose.tintMix > 0.9, "an invalid grip preview should use the red failure tint");
for (const toolId of ["hammer", "saw", "handDrill", "grip"]) {
  for (let axis = 0; axis < 3; axis += 1) {
    for (const side of [0, 1]) {
      const normal = [0, 0, 0];
      normal[axis] = side ? 1 : -1;
      const pose = sampleForgeToolVisualPose(toolId, {
        hit: { index: 0, point: [0, 1.9, 0], face: { axis, side, normal } },
        cameraEye: [4, 5, 6],
        elapsedSeconds: 0.1,
        settings: { angle: 45, rotation: 1 },
      });
      assert.ok(pose?.translation.every(Number.isFinite), `${toolId} should produce a finite translation for face ${axis}:${side}`);
      assert.ok(Math.abs(Math.abs(basisDeterminant(pose.basis)) - 1) < 1e-6, `${toolId} should produce an orthonormal basis for face ${axis}:${side}`);
    }
  }
}
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const componentOffsetFrames = [];
try {
  globalThis.requestAnimationFrame = (callback) => {
    const id = componentOffsetFrames.length + 1;
    componentOffsetFrames.push({ id, callback });
    return id;
  };
  globalThis.cancelAnimationFrame = () => {};
  const onDemandOffsetRenderer = new ForgeWorkbenchRenderer(createForgeRendererTestCanvas(), { controls: false });
  let onDemandOffsetRenders = 0;
  onDemandOffsetRenderer.render = () => {
    onDemandOffsetRenders += 1;
    return onDemandOffsetRenderer.lastStats;
  };
  onDemandOffsetRenderer.setComponentVisualOffsets([[0, 2, 0]]);
  onDemandOffsetRenderer.setComponentVisualOffsets([[0, 2, 0]]);
  assert.equal(componentOffsetFrames.length, 1, "one component-offset update should queue only one on-demand frame");
  componentOffsetFrames.shift().callback(1);
  assert.equal(onDemandOffsetRenderer.framePending, false, "a component-offset frame should not keep an animation RAF alive by itself");
  onDemandOffsetRenderer.setComponentVisualOffsets(null);
  assert.equal(componentOffsetFrames.length, 1, "clearing component offsets should queue one final settled frame");
  componentOffsetFrames.shift().callback(2);
  assert.equal(onDemandOffsetRenders, 2, "component offsets should render only their update and clear frames");
  assert.equal(onDemandOffsetRenderer.raf, 0, "the renderer should return to idle after component offsets are cleared");
  onDemandOffsetRenderer.dispose();
} finally {
  if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
  else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
}
const rendererCanvas = createForgeRendererTestCanvas();
const inferredFloorRenderer = new ForgeWorkbenchRenderer(rendererCanvas, { controls: false, workpieceFloorY: null });
assert.ok(inferredFloorRenderer.workpieceFloorY > 1, "a null floor override should retain the deck-derived work surface");
assert.equal(
  inferredFloorRenderer.workpieceBaseOffset()[1],
  inferredFloorRenderer.workpieceFloorY,
  "the default workpiece coordinate origin should follow the flat work surface",
);
const floorRenderer = new ForgeWorkbenchRenderer(rendererCanvas, { controls: false });
floorRenderer.invalidate = () => true;
const floorBaseOffset = floorRenderer.workpieceBaseOffset();
floorRenderer.setWorkpieceCuboids([
  { id: "floor-probe", center: [0, 0, 0], size: [1, 0.72, 1], color444: 0xaaa },
], { offset: [floorBaseOffset[0], floorBaseOffset[1] + 0.5, floorBaseOffset[2]] });
const floorDelta = floorRenderer.constrainWorkpieceDragDelta(0, [0, -1, 0]);
const floorBound = floorRenderer.dynamicMesh.pickBounds[0];
assert.ok(
  floorBound.min[1] + floorRenderer.dynamicOffset[1] + floorDelta[1] >= floorRenderer.workpieceFloorY - 1e-9,
  "downward material dragging should stop at the flat forge surface",
);
assert.equal(floorDelta[0], 0, "surface collision should not alter X movement");
assert.equal(floorDelta[2], 0, "surface collision should not alter Z movement");
let dragConstraintInput = null;
floorRenderer.setWorkpieceDragConstraint((index, deltaWorld, renderer) => {
  dragConstraintInput = { index, deltaWorld, renderer };
  return [0.5, -100, 0.25];
});
const callbackConstrainedDelta = floorRenderer.constrainWorkpieceDragDelta(0, [1, -1, 1]);
assert.equal(dragConstraintInput.index, 0, "custom material drag constraints should receive the component index");
assert.equal(dragConstraintInput.renderer, floorRenderer, "custom material drag constraints should receive their renderer");
assert.equal(
  dragConstraintInput.deltaWorld[1],
  floorDelta[1],
  "custom material drag constraints should run after the flat-surface constraint",
);
assertVectorNear(
  callbackConstrainedDelta,
  [0.5, floorDelta[1], 0.25],
  "custom material drag constraints should control all axes without bypassing the forge surface",
);
floorRenderer.setWorkpieceDragConstraint(() => [Infinity, 0, 0]);
assertVectorNear(
  floorRenderer.constrainWorkpieceDragDelta(0, [0, -1, 0]),
  floorDelta,
  "a non-finite custom drag result should retain the finite floor-constrained delta",
);
floorRenderer.setWorkpieceDragConstraint(null);
floorRenderer.setWorkpieceCuboids([], { offset: floorBaseOffset });
assert.equal(
  floorRenderer.workpieceFloorLocalY(floorBaseOffset),
  0,
  "an empty workbench should retain the configured workpiece coordinate frame",
);
const belowFloorDesign = createForgeDesign({
  components: [translateForgeComponent(lowCutFloorComponent, [0, -128, 0])],
});
floorRenderer.setDesign(belowFloorDesign, { offset: floorBaseOffset });
assert.ok(
  floorRenderer.dynamicMesh.pickBounds[0].min[1] + floorRenderer.dynamicOffset[1] >= floorRenderer.workpieceFloorY - 1e-9,
  "setDesign should keep loaded workpieces above the forge surface even before page-level validation",
);
const interactionEvents = [];
const forgeRenderer = new ForgeWorkbenchRenderer(rendererCanvas, {
  controls: false,
  workpieceOffset: [0, 0, 0],
  benchCuboids: [{ id: "occluder", center: [0, 0, 1], size: [1, 1, 1], color444: 0x444 }],
  workpieceCuboids: [{ id: "workpiece", center: [0, 0, 0], size: [1, 1, 1], color444: 0xaaa }],
  onPick: (hit) => interactionEvents.push(["pick", hit?.index ?? null]),
  onWorkpieceDrag: (interaction) => interactionEvents.push([interaction.phase, interaction.hit?.index ?? null]),
});
let forgeRendererInvalidations = 0;
forgeRenderer.invalidate = () => {
  forgeRendererInvalidations += 1;
  return true;
};
const visualOffsetMesh = forgeRenderer.dynamicMesh;
forgeRenderer.setComponentVisualOffsets([[0, 1.25, 0]]);
forgeRenderer.setComponentVisualOffsets([[0, 1.25, 0]]);
assert.equal(forgeRendererInvalidations, 1, "an unchanged component visual offset should not schedule a duplicate frame");
assert.equal(forgeRenderer.dynamicMesh, visualOffsetMesh, "component visual offsets should not rebuild the shared workpiece mesh");
assert.deepEqual(
  forgeRenderer.snapshot().componentVisualOffsets,
  [[0, 1.25, 0]],
  "renderer snapshots should expose component visual offsets",
);
forgeRenderer.screenRay = () => ({ origin: [0, 1.25, 5], direction: [0, 0, -1] });
assert.equal(forgeRenderer.pickWorkpiece(0, 0)?.index, 0, "workpiece picking should follow a component's visual offset");
forgeRenderer.transformTargetIndex = 0;
forgeRenderer.dragPreview = { index: 0, deltaWorld: [0.5, 0.25, -0.5] };
assertVectorNear(
  forgeRenderer.axisGizmoState().center,
  [0.5, 1.5, -0.5],
  "the transform gizmo should combine component animation and drag-preview offsets",
);
assertVectorNear(
  forgeRenderer.workpieceWorldPoint([0, 0, 0], 0),
  [0.5, 1.5, -0.5],
  "component world points should combine animation and drag-preview offsets",
);
forgeRenderer.transformTargetIndex = -1;
forgeRenderer.dragPreview = null;
forgeRenderer.setComponentVisualOffsets(null);
assert.equal(forgeRenderer.snapshot().componentVisualOffsets, null, "clearing component visual offsets should restore the settled view");
assert.doesNotThrow(
  () => forgeRenderer.setComponentVisualOffsets([null]),
  "a landed component may use a null entry while other drop offsets finish",
);
forgeRenderer.setComponentVisualOffsets(null);
forgeRendererInvalidations = 0;
const highlightedHit = { index: 0, face: { axis: 2, side: 1, normal: [0, 0, 1] } };
forgeRenderer.setSelectedFace(highlightedHit);
forgeRenderer.setSelectedFace(highlightedHit);
assert.equal(forgeRendererInvalidations, 1, "selecting the same forge face twice should schedule only one on-demand frame");
assert.deepEqual(forgeRenderer.snapshot().selected.face, highlightedHit.face, "renderer snapshots should expose the selected construction face");
forgeRenderer.screenRay = () => ({ origin: [0, 0, 5], direction: [0, 0, -1] });
assert.equal(forgeRenderer.pickWorkpiece(0, 0), null, "a nearer forge bench surface should occlude workpiece picking");
forgeRenderer.setBenchCuboids([{ id: "behind", center: [0, 0, -2], size: [1, 1, 1], color444: 0x444 }]);
assert.ok(forgeRenderer.pickWorkpiece(0, 0), "workpiece picking should succeed when the bench is behind the selected material");

const releaseHit = { ...highlightedHit, point: [0, 0, 0], localPoint: [0, 0, 0] };
forgeRenderer.pick = () => releaseHit;
forgeRenderer.pickWorkpiece = () => releaseHit;
forgeRenderer.setWorkpieceDragEnabled(false);
forgeRenderer.pointerDown(forgePointerEvent({ x: 10, y: 10 }));
forgeRenderer.pointerMove(forgePointerEvent({ x: 30, y: 24 }));
forgeRenderer.pointerUp(forgePointerEvent({ x: 30, y: 24 }));
forgeRenderer.cancelScheduledHover();
assert.deepEqual(interactionEvents, [["pick", 0]], "construction tools should pick once on release without emitting material drag events");
assert.equal(forgeRenderer.snapshot().dragPreview, null, "construction tool release should leave no material drag preview");
const axisDragEvents = [];
forgeRenderer.onWorkpieceDrag = (interaction) => axisDragEvents.push(interaction);
forgeRenderer.setWorkpieceDragEnabled(true);
forgeRenderer.setActiveTool("gloves");
forgeRenderer.setCamera({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5 });
forgeRenderer.pickTransformGizmo = () => ({
  axis: 1,
  index: 0,
  center: [0, 0, 0],
  scale: 1,
  hit: releaseHit,
});
forgeRenderer.screenRay = (_x, y) => ({ origin: [0, (y - 10) / 10, 5], direction: [0, 0, -1] });
forgeRenderer.pointerDown(forgePointerEvent({ x: 10, y: 10 }));
forgeRenderer.pointerMove(forgePointerEvent({ x: 10, y: 30 }));
forgeRenderer.pointerUp(forgePointerEvent({ x: 10, y: 30 }));
forgeRenderer.cancelScheduledHover();
assert.deepEqual(axisDragEvents.map((event) => event.phase), ["start", "move", "end"], "axis handles should use the normal material drag lifecycle");
assert.equal(axisDragEvents[1].axis, 1, "axis drag events should expose the selected Y axis");
assertVectorNear(axisDragEvents[1].deltaWorld, [0, 2, 0], "Y-axis dragging should keep X and Z fixed");
forgeRenderer.setActiveTool("hammer");
forgeRenderer.setHoveredFace(releaseHit);
assert.equal(forgeRenderer.snapshot().toolPreview.index, 0, "non-glove hover should synchronize the face-relative tool preview");
forgeRenderer.setHoveredFace(null);
assert.equal(forgeRenderer.snapshot().toolPreview, null, "clearing hover should also clear its tool preview");
forgeRenderer.setToolPreview(releaseHit);
assert.equal(forgeRenderer.snapshot().toolPreview.index, 0, "renderer should also retain an explicitly supplied tool preview");
forgeRenderer.setHoveredFace(null);
forgeRenderer.setConstructionPreview(null);
forgeRendererInvalidations = 0;
forgeRenderer.onHover = ({ hit }) => {
  if (!hit) return;
  forgeRenderer.setConstructionPreview({ toolId: "hammer", ...releaseHit, cell: [7, 5, 7], plane: 10 });
  forgeRenderer.setToolPreview(releaseHit);
};
forgeRenderer.setHoveredFace({ ...releaseHit, point: [0.01, 0, 0] });
const firstSnappedHoverInvalidations = forgeRendererInvalidations;
forgeRenderer.setHoveredFace({ ...releaseHit, point: [0.02, 0, 0] });
assert.equal(
  forgeRendererInvalidations,
  firstSnappedHoverInvalidations,
  "pointer movement inside one snapped construction cell should not schedule another draw",
);
forgeRenderer.onHover = null;
forgeRenderer.setHoveredFace(null);
forgeRenderer.setConstructionPreview(null);
forgeRenderer.setToolPreview(releaseHit);
const toolActionId = forgeRenderer.playToolAction({ toolId: "hammer", hit: releaseHit });
assert.ok(Number.isInteger(toolActionId), "renderer should return a stable tool action id");
const activeToolSnapshot = forgeRenderer.snapshot().toolAction;
assert.equal(activeToolSnapshot.toolId, "hammer", "renderer snapshots should expose the active tool animation");
assert.ok(forgeRenderer.toolVisualState(activeToolSnapshot.startTime + activeToolSnapshot.duration * 500), "tool animation should remain visible before its deadline");
assert.equal(forgeRenderer.toolVisualState(activeToolSnapshot.startTime + activeToolSnapshot.duration * 1000 + 1), null, "tool animation should clear itself at its deadline");
assert.equal(forgeRenderer.snapshot().toolAction, null, "completed tool animations should leave no active RAF-driving state");

const groupedRenderer = new ForgeWorkbenchRenderer(createForgeRendererTestCanvas(), {
  controls: false,
  workpieceFloorY: 0,
  workpieceOffset: [0, 0, 0],
  benchCuboids: [],
  workpieceCuboids: [
    { id: "group-left", center: [-1, 0.5, 0], size: [1, 1, 1], color444: 0xaaa },
    { id: "group-right", center: [1, 2, 0], size: [1, 1, 1], color444: 0xbbb },
  ],
});
groupedRenderer.invalidate = () => true;
const groupedDynamicMesh = groupedRenderer.dynamicMesh;
assert.equal(groupedDynamicMesh.pickBounds.length, 2, "an ungrouped workpiece should retain one pick bound per component");
groupedRenderer.setTransformTarget(1);
groupedRenderer.setComponentVisualOffsets([[0, 0, 0], [0, 1, 0]]);
groupedRenderer.setWorkpieceGrouped(true);
assert.equal(groupedRenderer.dynamicMesh, groupedDynamicMesh, "grouping should not rebuild the shared workpiece mesh");
assert.equal(groupedRenderer.dynamicMesh.pickBounds.length, 1, "a grouped workpiece should expose one combined pick bound");
assert.equal(groupedRenderer.dynamicMesh.pickBounds[0].index, 0, "the combined workpiece pick bound should use external object index zero");
assertVectorNear(groupedRenderer.dynamicMesh.pickBounds[0].min, [-1.5, 0, -0.5], "the combined pick bound should include the first component");
assertVectorNear(groupedRenderer.dynamicMesh.pickBounds[0].max, [1.5, 2.5, 0.5], "the combined pick bound should include the last component");
assert.equal(groupedRenderer.snapshot().workpieceGrouped, true, "renderer snapshots should expose grouped workpiece state");
assert.equal(groupedRenderer.snapshot().transformTargetIndex, 0, "grouping should map a selected component to the external object target");
assertVectorNear(
  groupedRenderer.axisGizmoState().center,
  [0, 1.75, 0],
  "the grouped transform gizmo should center on all visually offset components",
);
groupedRenderer.screenRay = () => ({ origin: [1, 3, 5], direction: [0, 0, -1] });
const groupedHit = groupedRenderer.pickWorkpiece(0, 0);
assert.equal(groupedHit?.index, 0, "picking any grouped component should return the external object index");
assert.equal(groupedHit?.sourceComponentIndex, 1, "group picking should retain the exact source component for face visuals and tools");
groupedRenderer.dragPreview = { index: 0, deltaWorld: [0.5, 0.25, -0.5] };
assertVectorNear(
  groupedRenderer.axisGizmoState().center,
  [0.5, 2, -0.5],
  "the grouped transform preview should move the overall gizmo once",
);
const groupedMeshBeforeOffset = groupedRenderer.dynamicMesh;
groupedRenderer.setWorkpieceOffset([2, -10, 3]);
assertVectorNear(groupedRenderer.snapshot().workpieceOffset, [2, 0, 3], "global workpiece offsets should honor the forge floor by default");
groupedRenderer.setWorkpieceOffset([2, -10, 3], { constrainToFloor: false });
assertVectorNear(groupedRenderer.snapshot().workpieceOffset, [2, -10, 3], "global workpiece offsets should allow explicit UI-only free placement");
assert.equal(groupedRenderer.dynamicMesh, groupedMeshBeforeOffset, "global workpiece offsets should not rebuild the GPU mesh");
groupedRenderer.setWorkpieceOffset([0, 0, 0], { constrainToFloor: false });
groupedRenderer.setTransformTarget(-1);
const groupedDrawGl = armForgeRendererForDrawTest(groupedRenderer);
groupedRenderer.dragPreview = { index: 0, deltaWorld: [0.5, 0, 0] };
const groupedDynamicHandle = groupedRenderer.dynamicHandle;
assert.equal(groupedRenderer.render().drawCalls, 1, "group drag preview should retain one batched workpiece draw call");
assert.ok(groupedDrawGl.dragComponentIndexUploads.includes(-2), "group drag preview should select every component in the shared vertex shader");
assert.equal(groupedRenderer.dynamicHandle, groupedDynamicHandle, "group drag preview should not upload another workpiece mesh");
groupedRenderer.setWorkpieceGrouped(false);
assert.equal(groupedRenderer.dynamicMesh.pickBounds.length, 2, "disabling grouping should restore per-component pick bounds");
assert.equal(groupedRenderer.snapshot().transformTargetIndex, 1, "disabling grouping should restore the prior component transform target");
assert.equal(groupedRenderer.snapshot().workpieceGrouped, false, "renderer snapshots should expose restored component mode");
assert.equal(groupedRenderer.dynamicHandle, groupedDynamicHandle, "changing pick grouping should not replace the GPU handle");

const forgeDrawGl = armForgeRendererForDrawTest(forgeRenderer);
forgeRenderer.setToolPreview(null);
forgeRenderer.setComponentVisualOffsets([[0, 0.75, 0]]);
forgeRenderer.dragPreview = { index: 0, deltaWorld: [0.5, 0, 0] };
const visualDynamicHandle = forgeRenderer.dynamicHandle;
assert.equal(forgeRenderer.render().drawCalls, 2, "component animation and drag preview should retain one batched workpiece draw call");
assert.equal(forgeRenderer.dynamicHandle, visualDynamicHandle, "drawing component offsets should not upload another workpiece mesh");
assert.deepEqual(
  forgeDrawGl.componentVisualOffsetUploads.at(-1)?.slice(0, 3),
  [0, 0.75, 0],
  "the dynamic batch should upload its fixed component-offset uniform table",
);
forgeRenderer.dragPreview = null;
forgeRenderer.setComponentVisualOffsets(null);
assert.equal(forgeRenderer.render().drawCalls, 2, "idle forge rendering should retain only bench and workpiece draw calls");
forgeRenderer.setActiveTool("gloves");
forgeRenderer.setTransformTarget(0);
assert.equal(forgeRenderer.render().drawCalls, 3, "a selected glove target should add one batched XYZ gizmo draw call");
forgeRenderer.setTransformTarget(-1);
forgeRenderer.setActiveTool("hammer");
forgeRenderer.setConstructionPreview({ toolId: "hammer", ...releaseHit, cell: [7, 5, 7], plane: 10 });
forgeRenderer.setToolPreview(releaseHit);
assert.equal(forgeRenderer.render().drawCalls, 4, "a snapped reticle and tool model should each add one overlay draw call");
forgeRenderer.setConstructionPreview(null);
forgeRenderer.setToolPreview(releaseHit);
assert.equal(forgeRenderer.render().drawCalls, 3, "a visible batched tool preview should add exactly one draw call");
forgeRenderer.setToolPreview(null);
assert.equal(forgeRenderer.render().drawCalls, 2, "clearing a tool preview should restore the idle draw-call budget");
const drawActionId = forgeRenderer.playToolAction({ toolId: "handDrill", hit: releaseHit, durationSeconds: 0.08 });
const drawAction = forgeRenderer.snapshot().toolAction;
assert.ok(drawActionId && forgeRenderer.render(drawAction.startTime + 20).drawCalls === 3, "an active tool animation should render one additional batched pass");
assert.equal(forgeRenderer.render(drawAction.startTime + 100).drawCalls, 2, "the deadline frame should hide the tool without an idle draw-call penalty");
assert.equal(forgeRenderer.snapshot().toolAction, null, "the deadline frame should stop the tool animation scheduler");
console.log("chunk.js smoke tests passed");

function floatArraysDiffer(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index] - b[index]) > 1e-6) return true;
  }
  return false;
}

function basisDeterminant(value) {
  return value[0] * (value[4] * value[8] - value[7] * value[5])
    - value[3] * (value[1] * value[8] - value[7] * value[2])
    + value[6] * (value[1] * value[5] - value[4] * value[2]);
}

function createForgeRendererTestCanvas() {
  const captured = new Set();
  return {
    style: {},
    width: 100,
    height: 100,
    clientWidth: 100,
    clientHeight: 100,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture(pointerId) { captured.add(pointerId); },
    hasPointerCapture(pointerId) { return captured.has(pointerId); },
    releasePointerCapture(pointerId) { captured.delete(pointerId); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  };
}

function armForgeRendererForDrawTest(renderer) {
  const gl = {
    COLOR_BUFFER_BIT: 1,
    DEPTH_BUFFER_BIT: 2,
    DEPTH_TEST: 3,
    CULL_FACE: 4,
    BLEND: 5,
    SRC_ALPHA: 6,
    ONE_MINUS_SRC_ALPHA: 7,
    TRIANGLES: 8,
    UNSIGNED_SHORT: 9,
    clearColor() {},
    clear() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniformMatrix3fv() {},
    uniform1f() {},
    dragComponentIndexUploads: [],
    uniform1i(location, value) {
      if (location?.key === "dragComponentIndex") this.dragComponentIndexUploads.push(value);
    },
    uniform2f() {},
    uniform3f() {},
    componentVisualOffsetUploads: [],
    uniform3fv(location, value) {
      if (location?.key === "componentVisualOffsets") this.componentVisualOffsetUploads.push(Array.from(value));
    },
    enable() {},
    disable() {},
    depthMask() {},
    blendFunc() {},
    bindVertexArray() {},
    drawElements() {},
  };
  const handle = (mesh) => ({
    vao: {},
    indexCount: mesh.indexCount,
    indexType: gl.UNSIGNED_SHORT,
    triangleCount: mesh.triangleCount,
    byteLength: mesh.byteLength,
  });
  renderer.gl = gl;
  renderer.program = {};
  renderer.uniforms = Object.fromEntries([
    "viewProjection", "offset", "objectBasis", "componentVisualOffsetsEnabled", "componentVisualOffsets",
    "dragComponentIndex", "dragOffset", "spinComponentIndex", "spinRadians",
    "exposure", "opacity", "colorTint", "colorTintMix", "fogColor", "fogNearFar", "lightDirection", "ambientColor",
    "keyLightColor", "unlit", "selectedComponentIndex", "selectedFaceAxis", "selectedFaceSide", "hoveredComponentIndex",
    "hoveredFaceAxis", "hoveredFaceSide",
  ].map((key) => [key, { key }]));
  renderer.staticHandle = handle(renderer.staticMesh);
  renderer.dynamicHandle = handle(renderer.dynamicMesh);
  renderer.toolHandles = new Map(Array.from(renderer.toolMeshes, ([toolId, mesh]) => [toolId, handle(mesh)]));
  renderer.guideHandles = {
    transform: handle(renderer.guideMeshes.transform),
    reticle: handle(renderer.guideMeshes.reticle),
  };
  renderer.resize = () => false;
  renderer.initialized = true;
  return gl;
}

function forgePointerEvent({ x, y, pointerId = 1 }) {
  return {
    button: 0,
    pointerId,
    pointerType: "mouse",
    clientX: x,
    clientY: y,
    preventDefault() {},
  };
}

function assertVectorNear(actual, expected, message, epsilon = 1e-7) {
  assert.equal(actual?.length, expected.length, `${message}: vector length`);
  for (let axis = 0; axis < expected.length; axis += 1) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) <= epsilon, `${message}: axis ${axis}`);
  }
}

function forgeMeshBoundsRelativeToGripP(mesh, gripQ) {
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.vertexCount; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = view.getInt16(index * FORGE_MESH_VERTEX_STRIDE_BYTES + axis * 2, true) - gripQ[axis] * 2;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

function forgeComponentFaceRay(component, axis, side) {
  const center = component.offsetQ.map((value) => value / 64);
  const half = component.dimsQ.map((value) => value / 128);
  const normal = [0, 0, 0];
  normal[axis] = side ? 1 : -1;
  const point = [...center];
  point[axis] += normal[axis] * half[axis];
  const tangentAxes = [0, 1, 2].filter((candidate) => candidate !== axis);
  point[tangentAxes[0]] += half[tangentAxes[0]] * 0.17;
  point[tangentAxes[1]] -= half[tangentAxes[1]] * 0.11;
  const origin = [...point];
  origin[axis] += normal[axis] * 2;
  return { origin, direction: normal.map((value) => -value) };
}

function forgeComponentCellFaceRay(component, axis, side, cell) {
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  const center = component.offsetQ.map((value) => value / 64);
  const half = component.dimsQ.map((value) => value / 128);
  const point = center.map((value, candidate) => (
    value - half[candidate] + (cell[candidate] + 0.5) * half[candidate] * 2 / sizes[candidate]
  ));
  const normal = [0, 0, 0];
  normal[axis] = side ? 1 : -1;
  point[axis] = center[axis] + normal[axis] * half[axis];
  const origin = [...point];
  origin[axis] += normal[axis] * 2;
  return { origin, direction: normal.map((value) => -value) };
}

function forgeMachiningStampRay(component, stamp, side) {
  const axis = stamp.axis;
  const center = stamp.centerQ.map((value, candidate) => (
    (value + component.offsetQ[candidate]) / 64
  ));
  const halfExtent = component.dimsQ[axis] / 128;
  const normal = [0, 0, 0];
  normal[axis] = side ? 1 : -1;
  const origin = [...center];
  origin[axis] = component.offsetQ[axis] / 64 + normal[axis] * (halfExtent + 2);
  return { origin, direction: normal.map((value) => -value) };
}

function assertForgeMachiningCenterFollowsDeformation(
  previousComponent,
  previousStamp,
  component,
  stamp,
  label,
) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (axis === stamp.axis) {
      assert.ok(
        Math.abs(Math.abs(stamp.centerQ[axis]) * 2 - component.dimsQ[axis]) <= 2,
        `${label} on surface axis ${axis}`,
      );
      continue;
    }
    const ratioError = Math.abs(
      stamp.centerQ[axis] * previousComponent.dimsQ[axis]
      - previousStamp.centerQ[axis] * component.dimsQ[axis]
    );
    assert.ok(
      ratioError <= previousComponent.dimsQ[axis],
      `${label} on axis ${axis}`,
    );
  }
}

function forgeComponentAxisBoundsQ2(component, axis) {
  return [
    component.offsetQ[axis] * 2 - component.dimsQ[axis],
    component.offsetQ[axis] * 2 + component.dimsQ[axis],
  ];
}

function forgeRemovedCellCount(before, after) {
  let removed = 0;
  for (let index = 0; index < before.solid.length; index += 1) {
    if (before.solid[index] && !after.solid[index]) removed += 1;
  }
  return removed;
}

function forgeRemovedCellIndices(before, after) {
  const removed = [];
  for (let index = 0; index < before.solid.length; index += 1) {
    if (before.solid[index] && !after.solid[index]) removed.push(index);
  }
  return removed;
}

function forgeMachinedBoundsQ2(component) {
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  const baseSolid = component.machining?.baseSolid;
  assert.ok(baseSolid, "machined bounds require a workbench machining checkpoint");
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let z = 0; z < sizes[2]; z += 1) {
    for (let y = 0; y < sizes[1]; y += 1) {
      for (let x = 0; x < sizes[0]; x += 1) {
        const cell = [x, y, z];
        const index = forgeVoxelIndex(x, y, z);
        if (!baseSolid[index] || component.solid[index]) continue;
        for (let axis = 0; axis < 3; axis += 1) {
          const low = component.offsetQ[axis] * 2 - component.dimsQ[axis]
            + Math.round(cell[axis] * component.dimsQ[axis] * 2 / sizes[axis]);
          const high = component.offsetQ[axis] * 2 - component.dimsQ[axis]
            + Math.round((cell[axis] + 1) * component.dimsQ[axis] * 2 / sizes[axis]);
          min[axis] = Math.min(min[axis], low);
          max[axis] = Math.max(max[axis], high);
        }
      }
    }
  }
  assert.ok(min.every(Number.isFinite) && max.every(Number.isFinite), "machining should remove at least one measurable cell");
  return { min, max };
}

function forgeComponentCellPitchQ2(component, axis) {
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  return Math.ceil(component.dimsQ[axis] * 2 / sizes[axis]);
}

function forgePaintCellsForTest(component) {
  const cells = new Map();
  for (const quad of component.paintQuads ?? []) {
    for (let v = quad.v0; v < quad.v1; v += 1) {
      for (let u = quad.u0; u < quad.u1; u += 1) {
        cells.set(forgePaintCellKeyForTest(quad.axis, quad.side, quad.plane, u, v), quad.color444);
      }
    }
  }
  return cells;
}

function forgePaintCellKeyForTest(axis, side, plane, u, v) {
  return `${axis}:${side}:${plane}:${u}:${v}`;
}

function minAlpha(pixels) {
  let min = 255;
  for (let i = 3; i < pixels.length; i += 4) min = Math.min(min, pixels[i]);
  return min;
}

function floatAttributeRange(values, stride, offset) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = offset; i < values.length; i += stride) {
    min = Math.min(min, values[i]);
    max = Math.max(max, values[i]);
  }
  return { min, max };
}

function meshHasTopFace(mesh, localX, planeY, localZ) {
  assert.ok(mesh?.vertices?.byteLength, "mesh must be present for top-face regression check");
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  for (let i = 0; i < mesh.indices.length; i += 6) {
    const corners = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2], mesh.indices[i + 5]].map((index) => {
      const offset = index * CHUNK_VERTEX_STRIDE_BYTES;
      return {
        x: view.getInt16(offset, true) / POSITION_PACK_SCALE,
        y: view.getInt16(offset + 2, true) / POSITION_PACK_SCALE,
        z: view.getInt16(offset + 4, true) / POSITION_PACK_SCALE,
        ny: view.getInt8(offset + 9),
      };
    });
    if (!corners.every((corner) => corner.ny > 100 && Math.abs(corner.y - planeY) < 0.001)) continue;
    const minX = Math.min(...corners.map((corner) => corner.x));
    const maxX = Math.max(...corners.map((corner) => corner.x));
    const minZ = Math.min(...corners.map((corner) => corner.z));
    const maxZ = Math.max(...corners.map((corner) => corner.z));
    if (minX <= localX + 0.001 && maxX >= localX + 0.999 && minZ <= localZ + 0.001 && maxZ >= localZ + 0.999) return true;
  }
  return false;
}

function meshHasSideFace(mesh, faceName, localX, localY, localZ) {
  assert.ok(mesh?.vertices?.byteLength, "mesh must be present for side-face regression check");
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  const expected = {
    px: { axis: "x", normal: "nx", sign: 1, plane: localX + 1, uAxis: "z", u: localZ, vAxis: "y", v: localY },
    nx: { axis: "x", normal: "nx", sign: -1, plane: localX, uAxis: "z", u: localZ, vAxis: "y", v: localY },
    pz: { axis: "z", normal: "nz", sign: 1, plane: localZ + 1, uAxis: "x", u: localX, vAxis: "y", v: localY },
    nz: { axis: "z", normal: "nz", sign: -1, plane: localZ, uAxis: "x", u: localX, vAxis: "y", v: localY },
  }[faceName];
  assert.ok(expected, `unsupported side face ${faceName}`);
  for (let i = 0; i < mesh.indices.length; i += 6) {
    const corners = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2], mesh.indices[i + 5]].map((index) => {
      const offset = index * CHUNK_VERTEX_STRIDE_BYTES;
      return {
        x: view.getInt16(offset, true) / POSITION_PACK_SCALE,
        y: view.getInt16(offset + 2, true) / POSITION_PACK_SCALE,
        z: view.getInt16(offset + 4, true) / POSITION_PACK_SCALE,
        nx: view.getInt8(offset + 8),
        nz: view.getInt8(offset + 10),
      };
    });
    if (!corners.every((corner) => corner[expected.normal] * expected.sign > 100 && Math.abs(corner[expected.axis] - expected.plane) < 0.001)) continue;
    const minU = Math.min(...corners.map((corner) => corner[expected.uAxis]));
    const maxU = Math.max(...corners.map((corner) => corner[expected.uAxis]));
    const minV = Math.min(...corners.map((corner) => corner[expected.vAxis]));
    const maxV = Math.max(...corners.map((corner) => corner[expected.vAxis]));
    if (minU <= expected.u + 0.001 && maxU >= expected.u + 0.999 && minV <= expected.v + 0.001 && maxV >= expected.v + 0.999) return true;
  }
  return false;
}

function meshTriangleCountForLayerInCell(mesh, layer, localX, localY, localZ, height = 1) {
  assert.ok(mesh?.vertices?.byteLength, "mesh must be present for layer geometry regression check");
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  let triangles = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    let inside = true;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = mesh.indices[i + corner] * CHUNK_VERTEX_STRIDE_BYTES;
      const x = view.getInt16(offset, true) / POSITION_PACK_SCALE;
      const y = view.getInt16(offset + 2, true) / POSITION_PACK_SCALE;
      const z = view.getInt16(offset + 4, true) / POSITION_PACK_SCALE;
      const vertexLayer = view.getUint16(offset + 16, true);
      if (vertexLayer !== layer
        || x < localX || x > localX + 1
        || y < localY || y > localY + height
        || z < localZ || z > localZ + 1) {
        inside = false;
        break;
      }
    }
    if (inside) triangles += 1;
  }
  return triangles;
}

function quantizedUsableTriangleCount(asset, scale) {
  const position = (index) => asset.vertices[index].p.map((value) => Math.round(value * scale) / scale);
  let usable = 0;
  for (let i = 0; i < asset.indices.length; i += 3) {
    const a = position(asset.indices[i]);
    const b = position(asset.indices[i + 1]);
    const c = position(asset.indices[i + 2]);
    const abX = b[0] - a[0];
    const abY = b[1] - a[1];
    const abZ = b[2] - a[2];
    const acX = c[0] - a[0];
    const acY = c[1] - a[1];
    const acZ = c[2] - a[2];
    const crossX = abY * acZ - abZ * acY;
    const crossY = abZ * acX - abX * acZ;
    const crossZ = abX * acY - abY * acX;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-12) usable += 1;
  }
  return usable;
}
