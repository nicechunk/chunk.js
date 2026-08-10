import assert from "node:assert/strict";

import {
  AVATAR_TEXTURE_LAYER_NONE,
  AVATAR_TEXTURE_SURFACE_OPAQUE,
  AVATAR_TEXTURE_SURFACE_TRANSPARENT,
  AVATAR_VERTEX_STRIDE_FLOATS,
  avatarHoldsTransparentBlock,
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  resolveAvatarPlacementPose,
  updateAvatarMeshVertices,
} from "../renderer/avatar-mesh.js";
import { blockMaterialIdForFace, BLOCK_ID } from "../world/block-registry.js";
import { materialDef } from "../world/material-registry.js";

const mesh = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
  scale: (1.75 / 0.4) / 2.52,
  attachIronPickaxe: true,
});
const equipment = {
  rightHand: "block",
  equipmentId: "held_block",
  blockId: BLOCK_ID.grass,
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

const texturedVertices = snapshotVertices({ placementProgress: 0 });
const worldFaceUvs = [
  [[1, 0], [1, 1], [0, 1], [0, 0]],
  [[0, 0], [0, 1], [1, 1], [1, 0]],
  [[0, 1], [0, 0], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [1, 1], [1, 0]],
  [[0, 0], [0, 1], [1, 1], [1, 0]],
  [[1, 0], [1, 1], [0, 1], [0, 0]],
];
const heldBlockStart = mesh.parts
  .slice(0, mesh.parts.findIndex((part) => part.equipmentId === "held_block"))
  .reduce((count, part) => count + (part.geometry ? part.geometry.vertices.length / AVATAR_VERTEX_STRIDE_FLOATS : 24), 0);
for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
  const expectedLayer = materialDef(blockMaterialIdForFace(BLOCK_ID.grass, faceIndex)).textureLayer;
  for (let vertexIndex = 0; vertexIndex < 4; vertexIndex += 1) {
    const offset = (heldBlockStart + faceIndex * 4 + vertexIndex) * AVATAR_VERTEX_STRIDE_FLOATS;
    assert.equal(texturedVertices[offset + 12], expectedLayer, `held face ${faceIndex} must reuse the world material layer`);
    assert.deepEqual(
      Array.from(texturedVertices.slice(offset + 10, offset + 12)),
      worldFaceUvs[faceIndex][vertexIndex],
      `held face ${faceIndex} must reuse the world face UV orientation`,
    );
  }
}
assert.equal(texturedVertices[12], AVATAR_TEXTURE_LAYER_NONE, "ordinary avatar geometry must remain color-rendered");
assert.equal(texturedVertices[13], AVATAR_TEXTURE_SURFACE_OPAQUE, "ordinary avatar geometry must stay in the opaque pass");

const iceVertices = snapshotVertices({
  placementProgress: 0,
  equipment: { ...equipment, blockId: BLOCK_ID.ice },
});
for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
  for (let vertexIndex = 0; vertexIndex < 4; vertexIndex += 1) {
    const offset = (heldBlockStart + faceIndex * 4 + vertexIndex) * AVATAR_VERTEX_STRIDE_FLOATS;
    assert.equal(
      iceVertices[offset + 13],
      AVATAR_TEXTURE_SURFACE_TRANSPARENT,
      `held ice face ${faceIndex} must use the transparent avatar pass`,
    );
  }
}
assert.equal(avatarHoldsTransparentBlock({ equipment }), false);
assert.equal(avatarHoldsTransparentBlock({ equipment: { ...equipment, blockId: BLOCK_ID.ice } }), true);

console.log("avatar placement pose tests passed");

function snapshotVertices(animation) {
  return new Float32Array(updateAvatarMeshVertices(mesh, { timeMs: 0, equipment, ...animation }));
}

function heldBlockCenter(vertices) {
  const center = [0, 0, 0];
  let count = 0;
  let vertexCursor = 0;
  for (const part of mesh.parts) {
    const vertexCount = part.geometry ? part.geometry.vertices.length / AVATAR_VERTEX_STRIDE_FLOATS : 24;
    if (part.equipmentId === "held_block") {
      for (let vertex = vertexCursor; vertex < vertexCursor + vertexCount; vertex += 1) {
        const offset = vertex * AVATAR_VERTEX_STRIDE_FLOATS;
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
