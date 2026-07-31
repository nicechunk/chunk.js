import assert from "node:assert/strict";
import {
  createForgeComponent,
  createForgeDesign,
} from "../forge/forge-core.js";
import { createForgeRuntimeAsset } from "../forge/forge-runtime-cache.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
} from "../renderer/avatar-mesh.js";
import { ForgeWorkbenchRenderer } from "../renderer/forge-workbench-renderer.js";

const BLOCK_SIZE_METERS = 0.4;
const AVATAR_HEIGHT_METERS = 1.75;
const AVATAR_SOURCE_HEIGHT_UNITS = 2.52;
const AVATAR_SCALE = (AVATAR_HEIGHT_METERS / BLOCK_SIZE_METERS) / AVATAR_SOURCE_HEIGHT_UNITS;
const dimensionsQ = [32, 64, 16];
const runtime = createForgeRuntimeAsset(createForgeDesign({
  equipment: { mass5g: 40, volumeCm3: 125, attributes6: new Uint8Array(12).fill(24) },
  components: [createForgeComponent({
    resourceId: "iron",
    dimsQ: dimensionsQ,
    grip: { offsetQ: [0, -16, 8], axis: 2, sign: 1, rotation: 1 },
  })],
}));
const gameMesh = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
  scale: AVATAR_SCALE,
  attachIronPickaxe: true,
  attachForgedPickaxe: true,
  forgeRuntime: runtime,
  forgeMetersToWorldUnits: 1 / BLOCK_SIZE_METERS,
});
const gameForgedPart = gameMesh.parts.find((part) => part.forgeDesignHash === runtime.designHash);

assert.ok(gameForgedPart, "the exact forged geometry must be attached to the game avatar");
assert.deepEqual(
  [gameForgedPart.sx, gameForgedPart.sy, gameForgedPart.sz]
    .map((value) => Number((value * BLOCK_SIZE_METERS).toFixed(6)))
    .sort((left, right) => left - right),
  dimensionsInMeters(),
  "the avatar mount must preserve the NCF1 dimensions expressed in metres",
);

const previewRenderer = new ForgeWorkbenchRenderer(fakeCanvas(), {
  controls: false,
  toolVisuals: false,
});
previewRenderer.invalidate = () => previewRenderer;
previewRenderer.setSceneAvatar(runtime);
const previewMesh = previewRenderer.avatar.mesh;
const previewForgedPart = previewMesh.parts.find(
  (part) => part.forgeDesignHash === runtime.designHash,
);
const previewMetersPerUnit = AVATAR_HEIGHT_METERS / previewMesh.bounds.height;

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
