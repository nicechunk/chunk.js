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

const BLOCK_SIZE_METERS = 0.4;
const AVATAR_SCALE = (1.75 / BLOCK_SIZE_METERS) / 2.52;
const dimensionsQ = [32, 64, 16];
const runtime = createForgeRuntimeAsset(createForgeDesign({
  equipment: { mass5g: 40, volumeCm3: 125, attributes6: new Uint8Array(12).fill(24) },
  components: [createForgeComponent({
    resourceId: "iron",
    dimsQ: dimensionsQ,
    grip: { offsetQ: [0, -16, 8], axis: 2, sign: 1, rotation: 1 },
  })],
}));
const mesh = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
  scale: AVATAR_SCALE,
  attachIronPickaxe: true,
  attachForgedPickaxe: true,
  forgeRuntime: runtime,
  forgeMetersToWorldUnits: 1 / BLOCK_SIZE_METERS,
});
const forgedPart = mesh.parts.find((part) => part.forgeDesignHash === runtime.designHash);

assert.ok(forgedPart, "the exact forged geometry must be attached to the avatar");
assert.deepEqual(
  [forgedPart.sx, forgedPart.sy, forgedPart.sz]
    .map((value) => Number((value * BLOCK_SIZE_METERS).toFixed(6)))
    .sort((left, right) => left - right),
  dimensionsQ
    .map((value) => value / 64)
    .sort((left, right) => left - right),
  "the avatar mount must preserve the NCF1 dimensions expressed in metres",
);

console.log("forge avatar equipment scale tests passed");
