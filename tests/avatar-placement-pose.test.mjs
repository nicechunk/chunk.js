import assert from "node:assert/strict";

import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  resolveAvatarPlacementPose,
  updateAvatarMeshVertices,
} from "../renderer/avatar-mesh.js";

const mesh = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
  scale: (1.75 / 0.4) / 2.52,
  attachIronPickaxe: true,
});
const equipment = {
  rightHand: "block",
  equipmentId: "held_block",
  color: [0.2, 0.6, 0.3, 1],
};

assert.equal(resolveAvatarPlacementPose(0).active, false);
assert.equal(resolveAvatarPlacementPose(1).active, false);
assert.ok(resolveAvatarPlacementPose(0.22).armX > 0.8, "the hand must rise before extending");
assert.ok(resolveAvatarPlacementPose(0.52).armX > 1.1, "the hand must extend toward the placement target");
assert.ok(resolveAvatarPlacementPose(0.9).armX < 0.25, "the hand must recover smoothly after release");
assert.ok(
  resolveAvatarPlacementPose(0.52, 0.4).armX > resolveAvatarPlacementPose(0.52, -0.4).armX,
  "vertical placement aim must follow the target height",
);

const idleCenter = heldBlockCenter(snapshotVertices({ placementProgress: 0 }));
const extendedCenter = heldBlockCenter(snapshotVertices({ placementProgress: 0.52 }));
const recoveredCenter = heldBlockCenter(snapshotVertices({ placementProgress: 0.99 }));
assert.ok(extendedCenter[2] < idleCenter[2] - 0.8, "the held block must move forward with the hand");
assert.ok(extendedCenter[1] > idleCenter[1] + 0.7, "the held block must visibly rise during placement");
assert.ok(Math.abs(recoveredCenter[2] - idleCenter[2]) < 0.02, "the held block must return to its carry pose");

console.log("avatar placement pose tests passed");

function snapshotVertices(animation) {
  return new Float32Array(updateAvatarMeshVertices(mesh, { timeMs: 0, equipment, ...animation }));
}

function heldBlockCenter(vertices) {
  const center = [0, 0, 0];
  let count = 0;
  let vertexCursor = 0;
  for (const part of mesh.parts) {
    const vertexCount = part.geometry ? part.geometry.vertices.length / 10 : 24;
    if (part.equipmentId === "held_block") {
      for (let vertex = vertexCursor; vertex < vertexCursor + vertexCount; vertex += 1) {
        const offset = vertex * 10;
        center[0] += vertices[offset];
        center[1] += vertices[offset + 1];
        center[2] += vertices[offset + 2];
        count += 1;
      }
    }
    vertexCursor += vertexCount;
  }
  return center.map((value) => value / Math.max(1, count));
}

