import assert from "node:assert/strict";
import { restoreForgeRuntime } from "../forge/forge-runtime-cache.js";
import { createAvatarToolCollisionResolver } from "../physics/voxel-item-collision.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  avatarRightHandRotations,
  createAvatarMeshFromNcm,
  updateAvatarMeshVertices,
} from "../renderer/avatar-mesh.js";

const REAL_FORGED_EQUIPMENT_NCF1 = "NCF1.4AvwB0ale2J0el73B1BMVH_55QIAbAUEBkZGBB4xUCahAiUxsiMxA04xBF4xAAA";
const runtime = restoreForgeRuntime(REAL_FORGED_EQUIPMENT_NCF1);
const equipment = {
  rightHand: "pickaxe",
  equipmentId: "forged_pickaxe",
  forged: true,
  designHash: runtime.designHash,
};
const mesh = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
  scale: (1.75 / 0.4) / 2.52,
  attachIronPickaxe: true,
  attachForgedPickaxe: true,
  forgeRuntime: runtime,
});
const forgedPose = mesh.equipmentPoses.forged_pickaxe;

assert.equal(runtime.designHash, 100840364, "the regression fixture must remain the user's actual forged design");
assert.deepEqual(runtime.grip.offsetQ, [-49, 32, 113], "Play must convert the component-local grip into design space");
assert.equal(forgedPose.adaptive, true);
assert.ok(forgedPose.carryZ > 0 && forgedPose.carryZ < 0.2, "long forged equipment should use only the minimum safe carry abduction");
assert.ok(forgedPose.miningZ > 0 && forgedPose.miningZ < 0.2, "the mining swing should use a volume-safe shoulder angle");

for (const frame of [
  { label: "idle", moving: false, timeMs: 0 },
  { label: "walk-forward-swing", moving: true, timeMs: Math.PI * 0.5 / 0.011 },
  { label: "walk-back-swing", moving: true, timeMs: Math.PI * 1.5 / 0.011 },
]) {
  const vertices = snapshotVertices(mesh, { ...frame, equipment });
  assertToolClearOfBody(mesh, vertices, frame.label);
  assertGripTouchesHand(mesh, vertices, frame.label);
}

const collision = createAvatarToolCollisionResolver({
  getAvatarMesh: () => mesh,
  getAvatar: () => ({ worldX: 0, worldY: 0, worldZ: 0, yaw: 0 }),
  getPlayer: () => ({ worldX: 0, worldY: 0, worldZ: 0, avatarYaw: 0 }),
  getPlayerWorldFloat: () => [0, 0, 0],
  getSelectedEquipment: () => equipment,
  playerBodyHeight: 4.375,
});

for (const pitchOffset of [-0.96, 0, 0.96]) {
  for (const progress of [0.01, 0.1, 0.2, 0.35, 0.55, 0.75, 0.95, 0.999]) {
    const label = `mine pitch=${pitchOffset} progress=${progress}`;
    const vertices = snapshotVertices(mesh, {
      timeMs: 0,
      equipment,
      miningProgress: progress,
      miningAimPitch: pitchOffset,
    });
    assertToolClearOfBody(mesh, vertices, label);
    assertGripTouchesHand(mesh, vertices, label);

    const visualBounds = unionBounds(partBounds(mesh, vertices, (part) => part.forgedTool));
    const physicalBounds = unionWorldBoxes(collision.toolCollisionFrame({ progress, pitchOffset }).boxes);
    assertBoundsNear(physicalBounds, visualBounds, 0.00001, `${label} visual and physical poses`);
  }
}

const defaultCarry = avatarRightHandRotations(mesh, "basic_iron_pickaxe");
const defaultMining = avatarRightHandRotations(mesh, "basic_iron_pickaxe", { mining: true });
assert.equal(defaultCarry.right_hand_item.z, 0, "ordinary held items must preserve their carry pose");
assert.equal(defaultMining.right_hand_item.z, -0.2, "ordinary mining tools must preserve their existing swing pose");

console.log("forge avatar equipment pose tests passed");

function snapshotVertices(avatarMesh, animation) {
  return new Float32Array(updateAvatarMeshVertices(avatarMesh, animation));
}

function assertToolClearOfBody(avatarMesh, vertices, label) {
  const tools = partBounds(avatarMesh, vertices, (part) => part.forgedTool);
  const body = partBounds(avatarMesh, vertices, (part) => (
    !part.equipment && !["left_arm", "right_arm", "right_hand_item"].includes(part.bone)
  ));
  for (const tool of tools) {
    for (const bodyPart of body) {
      assert.equal(boundsOverlap(tool, bodyPart, 0.00001), false, `${label}: forged equipment intersects ${bodyPart.name}`);
    }
  }
}

function assertGripTouchesHand(avatarMesh, vertices, label) {
  const tool = unionBounds(partBounds(avatarMesh, vertices, (part) => part.forgedTool));
  const hand = unionBounds(partBounds(avatarMesh, vertices, (part) => part.bone === "right_arm"));
  for (let axis = 0; axis < 3; axis += 1) {
    const contact = Math.min(tool.max[axis], hand.max[axis]) - Math.max(tool.min[axis], hand.min[axis]);
    assert.ok(contact > 0, `${label}: forged grip detached from the hand on axis ${axis}`);
  }
}

function partBounds(avatarMesh, vertices, predicate) {
  const result = [];
  let vertexCursor = 0;
  for (const part of avatarMesh.parts) {
    const vertexCount = part.geometry ? part.geometry.vertices.length / 10 : 24;
    if (predicate(part)) {
      const bounds = { name: part.name || part.bone || "part", min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let index = vertexCursor; index < vertexCursor + vertexCount; index += 1) {
        const offset = index * 10;
        for (let axis = 0; axis < 3; axis += 1) {
          bounds.min[axis] = Math.min(bounds.min[axis], vertices[offset + axis]);
          bounds.max[axis] = Math.max(bounds.max[axis], vertices[offset + axis]);
        }
      }
      result.push(bounds);
    }
    vertexCursor += vertexCount;
  }
  return result;
}

function unionBounds(boundsList) {
  const result = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const bounds of boundsList) {
    for (let axis = 0; axis < 3; axis += 1) {
      result.min[axis] = Math.min(result.min[axis], bounds.min[axis]);
      result.max[axis] = Math.max(result.max[axis], bounds.max[axis]);
    }
  }
  return result;
}

function unionWorldBoxes(boxes) {
  return unionBounds(boxes.map((box) => ({
    min: [box.minX, box.minY, box.minZ],
    max: [box.maxX, box.maxY, box.maxZ],
  })));
}

function assertBoundsNear(actual, expected, tolerance, label) {
  for (const edge of ["min", "max"]) {
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(
        Math.abs(actual[edge][axis] - expected[edge][axis]) <= tolerance,
        `${label}: ${edge}[${axis}] differs (${actual[edge][axis]} vs ${expected[edge][axis]})`,
      );
    }
  }
}

function boundsOverlap(left, right, margin = 0) {
  return [0, 1, 2].every((axis) => (
    Math.min(left.max[axis], right.max[axis]) - Math.max(left.min[axis], right.min[axis]) > margin
  ));
}
