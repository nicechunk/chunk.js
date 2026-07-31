import assert from "node:assert/strict";
import {
  PEASANT_GUY_GAME_SCALE,
  PLAYER_AVATAR_HEIGHT_METERS,
  WORLD_BLOCK_SIZE_METERS,
  WORLD_UNITS_PER_METER,
} from "../core/constants.js";
import {
  createForgeComponent,
  createForgeDesign,
} from "../forge/forge-core.js";
import { createForgeRuntimeAsset } from "../forge/forge-runtime-cache.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
} from "../renderer/avatar-mesh.js";
import {
  FORGE_SCENE_UNITS_PER_METER,
  ForgeWorkbenchRenderer,
} from "../renderer/forge-workbench-renderer.js";

const dimensionsQ = [32, 64, 16];
const design = createForgeDesign({
  equipment: { mass5g: 40, volumeCm3: 125, attributes6: new Uint8Array(12).fill(24) },
  components: [createForgeComponent({
    resourceId: "iron",
    dimsQ: dimensionsQ,
    grip: { offsetQ: [0, -16, 8], axis: 2, sign: 1, rotation: 1 },
  })],
});
const runtime = createForgeRuntimeAsset(design);
const gameMesh = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
  scale: PEASANT_GUY_GAME_SCALE,
  attachIronPickaxe: true,
  attachForgedPickaxe: true,
  forgeRuntime: runtime,
  forgeMetersToWorldUnits: WORLD_UNITS_PER_METER,
});
const gameForgedPart = gameMesh.parts.find((part) => part.forgeDesignHash === runtime.designHash);

assert.ok(gameForgedPart, "the exact forged geometry must be attached to the game avatar");
assert.deepEqual(
  [gameForgedPart.sx, gameForgedPart.sy, gameForgedPart.sz]
    .map((value) => Number((value * WORLD_BLOCK_SIZE_METERS).toFixed(6)))
    .sort((left, right) => left - right),
  dimensionsInMeters(),
  "the avatar mount must preserve the NCF1 dimensions expressed in metres",
);

const previewRenderer = new ForgeWorkbenchRenderer(fakeCanvas(), {
  controls: false,
  toolVisuals: false,
});
previewRenderer.invalidate = () => previewRenderer;
previewRenderer.setDesign(design, { offset: [0, 0, 0], constrainToFloor: false });
previewRenderer.setSceneAvatar(runtime);
const previewMesh = previewRenderer.avatar.mesh;
const previewForgedPart = previewMesh.parts.find(
  (part) => part.forgeDesignHash === runtime.designHash,
);
const previewMetersPerUnit = 1 / FORGE_SCENE_UNITS_PER_METER;

assert.equal(
  Number(previewMesh.bounds.height.toFixed(6)),
  PLAYER_AVATAR_HEIGHT_METERS,
  "the forge reference avatar must use the same 1.75 metre height as Play",
);
assert.deepEqual(
  previewRenderer.dynamicMesh.pickBounds[0].max.map((value, axis) => (
    Number((value - previewRenderer.dynamicMesh.pickBounds[0].min[axis]).toFixed(6))
  )).sort((left, right) => left - right),
  dimensionsInMeters(),
  "the editable forge workpiece must preserve raw NCF1 metre dimensions",
);

assert.ok(previewForgedPart, "the exact forged geometry must be attached to the forge avatar");
assert.deepEqual(
  [previewForgedPart.sx, previewForgedPart.sy, previewForgedPart.sz]
    .map((value) => Number((value * previewMetersPerUnit).toFixed(6)))
    .sort((left, right) => left - right),
  dimensionsInMeters(),
  "the forge avatar preview must preserve the same NCF1 metre dimensions as Play",
);
assert.deepEqual(
  normalizedDimensions(previewForgedPart, previewMesh.bounds.height),
  normalizedDimensions(gameForgedPart, gameMesh.bounds.height),
  "forge and Play avatars must show identical equipment-to-character proportions",
);
previewRenderer.dispose();

console.log("forge avatar equipment scale tests passed");

function dimensionsInMeters() {
  return dimensionsQ
    .map((value) => value / 64)
    .sort((left, right) => left - right);
}

function normalizedDimensions(part, avatarHeight) {
  return [part.sx, part.sy, part.sz]
    .map((value) => Number((value / avatarHeight).toFixed(6)))
    .sort((left, right) => left - right);
}

function fakeCanvas() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
}
