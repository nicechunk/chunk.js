import assert from "node:assert/strict";
import {
  canTranslateForgeWorkbenchComponent,
  constrainForgeWorkbenchComponentTranslation,
  forgeComponentSolidVoxelBoxesQ2,
  forgeComponentsOverlapQ2,
  forgeWorkbenchComponentsConnected,
  settleForgeWorkbenchComponents,
} from "../forge/forge-workbench.js";
import {
  FORGE_COMPONENT_GRID,
  createForgeComponent,
  forgeVoxelIndex,
} from "../forge/forge-core.js";

function component({ dimsQ = [64, 64, 64], offsetQ = [0, 0, 0], solid } = {}) {
  return createForgeComponent({ resourceId: "iron", dimsQ, offsetQ, solid });
}

const lower = component();
const upper = component({ offsetQ: [0, 200, 0] });
const stacked = settleForgeWorkbenchComponents([lower, upper], { floorQ2: 0 });
assert.deepEqual(stacked.map((entry) => entry.offsetQ[1]), [32, 96], "gravity should stack actual occupied volumes on the floor");
assert.equal(forgeComponentsOverlapQ2(stacked[0], stacked[1]), false, "settled components must not overlap");
assert.equal(forgeWorkbenchComponentsConnected(stacked), true, "positive-area support contact should form one assembly");
assert.strictEqual(settleForgeWorkbenchComponents(stacked, { floorQ2: 0 }), stacked, "settling should be idempotent and preserve the stable array");
assert.strictEqual(stacked[0].solid, lower.solid, "settling should structurally share immutable voxel masks");

const suspended = [component({ offsetQ: [0, 200, 0] })];
assert.strictEqual(
  settleForgeWorkbenchComponents(suspended, { floorQ2: 0, gravity: false }),
  suspended,
  "disabled gravity should preserve a valid suspended glove placement",
);
const repairedWithoutGravity = settleForgeWorkbenchComponents([
  component({ offsetQ: [0, 0, 0] }),
  component({ offsetQ: [0, 0, 0] }),
], { floorQ2: 0, gravity: false });
assert.deepEqual(
  repairedWithoutGravity.map((entry) => entry.offsetQ[1]),
  [32, 96],
  "disabled gravity must still repair floor penetration and component overlap",
);
assert.equal(
  forgeComponentsOverlapQ2(repairedWithoutGravity[0], repairedWithoutGravity[1]),
  false,
  "glove placement repair must never retain penetrations",
);

const separated = settleForgeWorkbenchComponents([
  component(),
  component({ offsetQ: [100, 200, 0] }),
], { floorQ2: 0 });
assert.deepEqual(separated.map((entry) => entry.offsetQ[1]), [32, 32], "a component without XZ support should fall to the forge surface");
assert.equal(forgeWorkbenchComponentsConnected(separated), false, "spatially separated components should not form an assembly");

const supportSolid = new Uint8Array(
  FORGE_COMPONENT_GRID.x * FORGE_COMPONENT_GRID.y * FORGE_COMPONENT_GRID.z,
).fill(1);
for (let z = 5; z <= 8; z += 1) {
  for (let y = 0; y < FORGE_COMPONENT_GRID.y; y += 1) {
    for (let x = 5; x <= 8; x += 1) supportSolid[forgeVoxelIndex(x, y, z)] = 0;
  }
}
const perforatedSupport = component({ dimsQ: [128, 32, 128], solid: supportSolid });
const holeInsert = component({ dimsQ: [24, 24, 24], offsetQ: [0, 200, 0] });
const throughHole = settleForgeWorkbenchComponents([perforatedSupport, holeInsert], { floorQ2: 0 });
assert.deepEqual(throughHole.map((entry) => entry.offsetQ[1]), [16, 12], "an insert should fall through a real voxel opening instead of resting on an envelope");
assert.equal(forgeComponentsOverlapQ2(throughHole[0], throughHole[1]), false, "a fitted insert should occupy only empty spatial structure");
assert.equal(
  forgeComponentSolidVoxelBoxesQ2(perforatedSupport).length,
  supportSolid.reduce((sum, value) => sum + value, 0),
  "collision boxes should follow every positive-volume occupied voxel",
);

const obstacle = component({ offsetQ: [100, 32, 0] });
const mover = component({ offsetQ: [0, 32, 0] });
const swept = constrainForgeWorkbenchComponentTranslation([mover, obstacle], 0, [200, 0, 0], { floorQ2: 0 });
assert.equal(swept.valid, false, "a large endpoint delta should detect an obstacle crossed along the path");
assert.equal(swept.reason, "component", "a swept collision should identify the component constraint");
assert.deepEqual(swept.constrainedDeltaQ, [36, 0, 0], "a blocked drag should stop at the last safe integer-Q contact point");
assert.equal(canTranslateForgeWorkbenchComponent([mover, obstacle], 0, [36, 0, 0], { floorQ2: 0 }), true);
assert.equal(canTranslateForgeWorkbenchComponent([mover, obstacle], 0, [37, 0, 0], { floorQ2: 0 }), false);
const floorBlocked = constrainForgeWorkbenchComponentTranslation([mover], 0, [0, -20, 0], { floorQ2: 0 });
assert.deepEqual(floorBlocked.constrainedDeltaQ, [0, 0, 0], "downward dragging should stop exactly at the flat forge surface");

const quantizedStack = settleForgeWorkbenchComponents([
  component({ dimsQ: [64, 63, 64] }),
  component({ dimsQ: [64, 64, 64], offsetQ: [0, 200, 0] }),
], { floorQ2: 0 });
const lowerTopQ2 = quantizedStack[0].offsetQ[1] * 2 + quantizedStack[0].dimsQ[1];
const upperBottomQ2 = quantizedStack[1].offsetQ[1] * 2 - quantizedStack[1].dimsQ[1];
assert.equal(upperBottomQ2 - lowerTopQ2, 1, "integer-Q landing may leave only the unavoidable one-Q2 quantization gap");
assert.equal(forgeWorkbenchComponentsConnected(quantizedStack), true, "a one-Q2 landing gap should retain physical assembly connectivity");

const faceConnected = settleForgeWorkbenchComponents([
  component({ offsetQ: [0, 32, 0] }),
  component({ offsetQ: [64, 32, 0] }),
], { floorQ2: 0 });
const edgeOnly = settleForgeWorkbenchComponents([
  component({ offsetQ: [0, 32, 0] }),
  component({ offsetQ: [64, 32, 64] }),
], { floorQ2: 0 });
assert.equal(forgeWorkbenchComponentsConnected(faceConnected), true, "shared faces should connect components");
assert.equal(forgeWorkbenchComponentsConnected(edgeOnly), false, "edge-only contact should not connect components");

const threeHigh = settleForgeWorkbenchComponents([
  component({ offsetQ: [0, 200, 0] }),
  component({ offsetQ: [0, 300, 0] }),
  component({ offsetQ: [0, 400, 0] }),
], { floorQ2: 0 });
const afterSupportRemoval = settleForgeWorkbenchComponents([threeHigh[0], threeHigh[2]], { floorQ2: 0 });
assert.deepEqual(afterSupportRemoval.map((entry) => entry.offsetQ[1]), [32, 96], "removing a lower support should deterministically settle the remaining stack");

console.log("forge spatial tests passed");
