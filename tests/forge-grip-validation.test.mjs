import assert from "node:assert/strict";
import {
  createForgeComponent,
  createForgeDesign,
} from "../forge/forge-core.js";
import {
  forgeComponentsWithSingleGrip,
  validateForgeGripBindings,
  validateForgeGripPlacement,
  validateForgeGripSurface,
} from "../forge/forge-grip-validation.js";
import {
  createForgeRuntimeAsset,
  forgeRuntimeGripFromDesign,
} from "../forge/forge-runtime-cache.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  updateAvatarMeshVertices,
} from "../renderer/avatar-mesh.js";

const handleGrip = { offsetQ: [8, 0, 0], axis: 0, sign: 1, rotation: 0 };
const handle = createForgeComponent({
  resourceId: "handle",
  dimsQ: [16, 64, 16],
  offsetQ: [0, 0, 0],
  grip: handleGrip,
});
const handleValidation = validateForgeGripPlacement([handle], 0, handleGrip);
assert.equal(handleValidation.valid, true, "a palm-sized handle surface should equip without body penetration");
assert.equal(handleValidation.collision.collides, false, "intentional hand contact must not count as avatar collision");

const oversizedGrip = { offsetQ: [32, 0, 0], axis: 0, sign: 1, rotation: 0 };
const oversized = createForgeComponent({ dimsQ: [64, 64, 64], grip: oversizedGrip });
const oversizedValidation = validateForgeGripSurface(oversized, oversizedGrip);
assert.equal(oversizedValidation.valid, false, "a full block cross-section must not fit in the hand");
assert.equal(oversizedValidation.reason, "grip-too-large");

const tinyGrip = { offsetQ: [4, 0, 0], axis: 0, sign: 1, rotation: 0 };
const tiny = createForgeComponent({ dimsQ: [8, 8, 8], grip: tinyGrip });
const tinyValidation = validateForgeGripSurface(tiny, tinyGrip);
assert.equal(tinyValidation.valid, false, "a tiny isolated surface must not provide enough palm contact");
assert.equal(tinyValidation.reason, "contact-too-small");

const penetratingGrip = { offsetQ: [0, 0, 8], axis: 2, sign: 1, rotation: 0 };
const penetratingBar = createForgeComponent({ dimsQ: [255, 16, 16], grip: penetratingGrip });
const penetratingValidation = validateForgeGripPlacement([penetratingBar], 0, penetratingGrip);
assert.equal(penetratingValidation.valid, false, "a model crossing the avatar must be rejected");
assert.equal(penetratingValidation.reason, "avatar-collision");
assert.ok(penetratingValidation.collision.collisionParts.length > 0);

const enlargedHandle = createForgeComponent({
  resourceId: "handle",
  dimsQ: [64, 64, 64],
  grip: handleGrip,
});
assert.equal(
  validateForgeGripPlacement([enlargedHandle], 0, handleGrip).valid,
  false,
  "geometry changes must invalidate a grip that no longer lies on a legal surface",
);

const shifted = createForgeComponent({
  resourceId: "handle",
  dimsQ: [16, 64, 16],
  offsetQ: [80, 24, -40],
  grip: handleGrip,
});
const design = createForgeDesign({ components: [shifted] });
assert.deepEqual(
  forgeRuntimeGripFromDesign(design).offsetQ,
  [88, 24, -40],
  "runtime grip coordinates must include the owning component offset",
);
assert.deepEqual(createForgeRuntimeAsset(design).grip.offsetQ, [88, 24, -40]);

const equippedRuntime = createForgeRuntimeAsset(createForgeDesign({ components: [handle] }));
const equippedAvatar = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
  attachIronPickaxe: true,
  attachForgedPickaxe: true,
  forgeRuntime: equippedRuntime,
});
const equippedVertices = updateAvatarMeshVertices(equippedAvatar, {
  moving: false,
  timeMs: 0,
  equipment: { rightHand: "forged_pickaxe", forged: true, designHash: equippedRuntime.designHash },
});
const handBounds = animatedPartBounds(equippedAvatar, equippedVertices, (part) => part.bone === "right_arm");
const toolBounds = animatedPartBounds(equippedAvatar, equippedVertices, (part) => part.forgedTool);
assert.ok(toolBounds.max[1] >= handBounds.min[1], "the grip must touch or slightly enter the avatar hand");
assert.ok(overlap(toolBounds.min[0], toolBounds.max[0], handBounds.min[0], handBounds.max[0]) > 0);
assert.ok(overlap(toolBounds.min[2], toolBounds.max[2], handBounds.min[2], handBounds.max[2]) > 0);

const alternate = createForgeComponent({ dimsQ: [16, 64, 16], offsetQ: [64, 0, 0], grip: handleGrip });
const unique = forgeComponentsWithSingleGrip([handle, alternate], 1, handleGrip);
assert.equal(unique[0].grip, null, "setting a grip must remove every previous grip from the design");
assert.deepEqual(unique[1].grip, handleGrip);
assert.equal(validateForgeGripBindings([createForgeComponent()]).valid, true, "placeable items may omit a hand grip");
const duplicateGripValidation = validateForgeGripBindings([handle, alternate]);
assert.equal(duplicateGripValidation.valid, false, "an equipment design cannot bind more than one grip");
assert.equal(duplicateGripValidation.reason, "multiple-grips");

console.log("forge grip validation tests passed");

function animatedPartBounds(mesh, vertices, predicate) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let vertexCursor = 0;
  for (const part of mesh.parts) {
    const vertexCount = part.geometry ? part.geometry.vertices.length / 10 : 24;
    if (predicate(part)) {
      for (let index = vertexCursor; index < vertexCursor + vertexCount; index += 1) {
        const offset = index * 10;
        for (let axis = 0; axis < 3; axis += 1) {
          bounds.min[axis] = Math.min(bounds.min[axis], vertices[offset + axis]);
          bounds.max[axis] = Math.max(bounds.max[axis], vertices[offset + axis]);
        }
      }
    }
    vertexCursor += vertexCount;
  }
  return bounds;
}

function overlap(leftMin, leftMax, rightMin, rightMax) {
  return Math.min(leftMax, rightMax) - Math.max(leftMin, rightMin);
}
