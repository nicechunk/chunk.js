import assert from "node:assert/strict";

import {
  RESOURCE_DROP_MODEL_BLOCK_IDS,
  buildDebugVisualModelAssets,
  createResourceDropPreviewMesh,
  hasResourceDropPreviewModel,
} from "../chunk/chunk-mesher.js";
import { blockDef } from "../world/block-registry.js";
import { materialDef } from "../world/material-registry.js";
import { resourceDropRules } from "../../src/data/resourceDropRules.js";

const configuredDropIds = [...new Set(resourceDropRules.map((rule) => rule.dropBlockId))]
  .sort((left, right) => left - right);

assert.deepEqual(
  RESOURCE_DROP_MODEL_BLOCK_IDS,
  configuredDropIds,
  "every block referenced by ResourceDropTable must have one Chunk.js model",
);

const debugAssets = new Map(buildDebugVisualModelAssets().map((asset) => [asset.id, asset]));
for (const blockId of configuredDropIds) {
  assert.equal(hasResourceDropPreviewModel(blockId), true, `drop block ${blockId} must resolve a resource model`);
  const mesh = createResourceDropPreviewMesh({ blockId });
  const expectedLayer = materialDef(blockDef(blockId).materialId).textureLayer;
  assert.strictEqual(
    createResourceDropPreviewMesh({ blockId }),
    mesh,
    `drop block ${blockId} should reuse its cached mesh`,
  );
  assert.ok(mesh.vertexCount > 8, `drop block ${blockId} must contain recognizable geometry`);
  assert.ok(mesh.triangleCount > 12, `drop block ${blockId} must not fall back to one cube`);
  assert.ok(mesh.triangleCount <= 200, `drop block ${blockId} must stay inside the 200-triangle icon budget`);
  assert.ok(mesh.layers.includes(expectedLayer), `drop block ${blockId} must use its real baked world material`);
  assert.strictEqual(debugAssets.get(mesh.id), mesh, `drop block ${blockId} must be exposed in baked-material diagnostics`);
}

assert.equal(hasResourceDropPreviewModel(0), false);
assert.equal(createResourceDropPreviewMesh({ blockId: 0 }).triangleCount, 0);

console.log(`resource drop model tests passed (${configuredDropIds.length} models)`);
