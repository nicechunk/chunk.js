import assert from "node:assert/strict";

import {
  createForgeComponent,
  createForgeDesign,
} from "../forge/forge-core.js";
import { createForgeRuntimeAsset } from "../forge/forge-runtime-cache.js";
import { ForgeWorkbenchRenderer } from "../renderer/forge-workbench-renderer.js";

const runtimeA = createGripRuntime([8, -8, 0]);
const runtimeB = createGripRuntime([8, 8, 0]);

assert.equal(runtimeA.designHash, runtimeB.designHash, "grip-only edits must preserve the geometry hash fixture");
assert.deepEqual(runtimeA.mesh.vertices, runtimeB.mesh.vertices, "grip metadata must not change workpiece geometry");
assert.notDeepEqual(runtimeA.grip, runtimeB.grip, "the regression fixture must move the grip");

const renderer = new ForgeWorkbenchRenderer(fakeCanvas(), { controls: false, toolVisuals: false });
renderer.invalidate = () => renderer;

renderer.setSceneAvatar(runtimeA);
const packedA = renderer.avatar.packedMesh;
const verticesA = new Uint8Array(packedA.vertices);

renderer.setSceneAvatar(runtimeB);
const packedB = renderer.avatar.packedMesh;
const verticesB = new Uint8Array(packedB.vertices);

assert.notStrictEqual(packedB, packedA, "moving a grip must rebuild the scene avatar preview");
assert.notDeepEqual(verticesB, verticesA, "moving a grip must change the placed equipment geometry");

renderer.setSceneAvatar(runtimeB);
assert.strictEqual(renderer.avatar.packedMesh, packedB, "an unchanged grip must keep using the cached avatar preview");
renderer.dispose();

console.log("forge scene avatar cache tests passed");

function createGripRuntime(offsetQ) {
  const component = createForgeComponent({
    resourceId: "handle",
    dimsQ: [16, 64, 16],
    grip: { offsetQ, axis: 0, sign: 1, rotation: 0 },
  });
  return createForgeRuntimeAsset(createForgeDesign({
    equipment: { mass5g: 1, volumeCm3: 1, attributes6: new Uint8Array(12) },
    components: [component],
  }));
}

function fakeCanvas() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
}
