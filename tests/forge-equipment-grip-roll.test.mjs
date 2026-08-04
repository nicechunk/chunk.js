import assert from "node:assert/strict";

import { restoreForgeRuntime } from "../forge/forge-runtime-cache.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  forgeAvatarTargetGrip,
  forgeRuntimeAvatarCollisionReport,
  updateAvatarMeshVertices,
} from "../renderer/avatar-mesh.js";

const BLACKSMITH_HAMMER_NCF1 = "NCF1.825G15tyxeSwrYZctlEkGJAbAP8wAIgACakICBYAALAAQABEyFBQKAAFvyIAAiZCgoFAACwHEAA";
const runtime = restoreForgeRuntime(BLACKSMITH_HAMMER_NCF1);
const equipment = {
  rightHand: "forged_pickaxe",
  forged: true,
  designHash: runtime.designHash,
};

const standard = createHammerAvatar(0);
const rolled = createHammerAvatar(1);
const standardComponents = forgedComponentBounds(standard);
const rolledComponents = forgedComponentBounds(rolled);

assert.equal(standardComponents.length, 4);
assert.equal(rolledComponents.length, 4);
assertComponentSpansAlmostEqual(
  rolledComponents[0],
  standardComponents[0],
  "rolling the head must preserve the handle axis",
);
assert.ok(axisSpan(standardComponents.slice(1), 0) > axisSpan(standardComponents.slice(1), 1) * 1.8);
assert.ok(axisSpan(rolledComponents.slice(1), 1) > axisSpan(rolledComponents.slice(1), 0) * 1.8);
assert.ok(axisSpan(rolledComponents.slice(1), 1) > axisSpan(rolledComponents.slice(1), 2) * 1.8);

const standardGrip = forgeAvatarTargetGrip(standard.handAnchors.right_hand_item, standard.modelScale);
const rolledGrip = forgeAvatarTargetGrip(rolled.handAnchors.right_hand_item, rolled.modelScale);
assert.deepEqual(rolledGrip, standardGrip, "rolling a tool must not move its hand grip");
assert.equal(
  forgeRuntimeAvatarCollisionReport(runtime, {
    avatarMesh: rolled,
    forgeMetersToWorldUnits: 1 / 0.4,
    forgeGripRollQuarterTurns: 1,
  }).collides,
  false,
  "the corrected hammer orientation must stay clear of the avatar",
);

for (const progress of [0.05, 0.2, 0.55, 0.82, 0.98]) {
  const vertices = updateAvatarMeshVertices(rolled, {
    miningProgress: progress,
    miningAimPitch: -0.34,
    timeMs: 0,
    equipment,
  });
  assertGripTouchesHand(rolled, vertices, `rolled forging frame ${progress}`);
}

console.log("forge equipment grip roll tests passed");

function createHammerAvatar(forgeGripRollQuarterTurns) {
  return createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
    scale: (1.75 / 0.4) / 2.52,
    attachIronPickaxe: true,
    attachForgedPickaxe: true,
    forgeRuntime: runtime,
    forgeMetersToWorldUnits: 1 / 0.4,
    forgeGripRollQuarterTurns,
  });
}

function forgedComponentBounds(mesh) {
  const part = mesh.parts.find((candidate) => candidate.forgedTool);
  assert.ok(part?.geometry?.vertices);
  const vertices = part.geometry.vertices;
  const componentVertexCount = vertices.length / 10 / runtime.componentCount;
  assert.equal(componentVertexCount, 24);
  return Array.from({ length: runtime.componentCount }, (_, componentIndex) => {
    const bounds = emptyBounds();
    const start = componentIndex * componentVertexCount;
    for (let index = start; index < start + componentVertexCount; index += 1) {
      const offset = index * 10;
      includePoint(bounds, [vertices[offset], vertices[offset + 1], vertices[offset + 2]]);
    }
    return bounds;
  });
}

function axisSpan(boundsList, axis) {
  const minimum = Math.min(...boundsList.map((bounds) => bounds.min[axis]));
  const maximum = Math.max(...boundsList.map((bounds) => bounds.max[axis]));
  return maximum - minimum;
}

function assertComponentSpansAlmostEqual(actual, expected, message) {
  for (let axis = 0; axis < 3; axis += 1) {
    const actualSpan = actual.max[axis] - actual.min[axis];
    const expectedSpan = expected.max[axis] - expected.min[axis];
    assert.ok(Math.abs(actualSpan - expectedSpan) < 1e-6, `${message}: axis ${axis}`);
  }
}

function assertGripTouchesHand(mesh, vertices, label) {
  const tool = animatedPartBounds(mesh, vertices, (part) => part.forgedTool);
  const hand = animatedPartBounds(mesh, vertices, (part) => part.bone === "right_arm");
  for (let axis = 0; axis < 3; axis += 1) {
    const contact = Math.min(tool.max[axis], hand.max[axis]) - Math.max(tool.min[axis], hand.min[axis]);
    assert.ok(contact > 0, `${label}: forged grip detached from the hand on axis ${axis}`);
  }
}

function animatedPartBounds(mesh, vertices, predicate) {
  const bounds = emptyBounds();
  let vertexCursor = 0;
  for (const part of mesh.parts) {
    const vertexCount = part.geometry ? part.geometry.vertices.length / 10 : 24;
    if (predicate(part)) {
      for (let index = vertexCursor; index < vertexCursor + vertexCount; index += 1) {
        const offset = index * 10;
        includePoint(bounds, [vertices[offset], vertices[offset + 1], vertices[offset + 2]]);
      }
    }
    vertexCursor += vertexCount;
  }
  return bounds;
}

function emptyBounds() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function includePoint(bounds, point) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}
