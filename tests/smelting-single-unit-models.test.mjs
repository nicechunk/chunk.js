import assert from "node:assert/strict";
import {
  SMELTING_MATERIAL_VISUAL_REVISION,
  createSmeltingMaterialPreviewMesh,
  smeltingMaterialModelDefinition,
} from "../renderer/smelting-material-models.js";

const singleUnitMaterialIds = [
  "ceramic_brick",
  "lime_ceramic",
  "carbon_plate",
  "wooden_plank",
  "wooden_stick",
  "clear_glass_panel",
  "ice_blue_glass_panel",
  "amber_glass_panel",
  "fired_clay_brick",
  "adobe_brick",
  "stone_brick",
  "deep_stone_brick",
  "basalt_brick",
  "polished_stone_slab",
  "white_ceramic_tile",
  "blue_ceramic_tile",
  "roof_tile_terracotta",
  "roof_tile_ice_blue",
  "roof_tile_shell_white",
  "roof_tile_charcoal",
  "roof_tile_ash_gray",
  "roof_tile_mycelium",
];

assert.equal(SMELTING_MATERIAL_VISUAL_REVISION, "nicechunk-smelting-material-visuals-v3");
for (const materialId of singleUnitMaterialIds) {
  const definition = smeltingMaterialModelDefinition(materialId);
  const mesh = createSmeltingMaterialPreviewMesh({ materialId });
  assert.ok(definition, `${materialId} should remain registered`);
  assert.doesNotMatch(definition.shape, /\b(?:stack(?:ed)?|bundle)\b/i, `${materialId} must describe one finished unit`);
  assert.ok(mesh.vertexCount >= 72, `${materialId} should retain readable single-unit surface detail`);
  assert.ok(mesh.triangleCount <= 120, `${materialId} must stay inside the icon geometry budget`);
}

const plankSize = meshSize(createSmeltingMaterialPreviewMesh({ materialId: "wooden_plank" }));
assert.ok(Math.abs(plankSize.x - plankSize.z) <= 0.01, "the wooden plank should be square in plan view");
assert.ok(plankSize.y * 3 < Math.min(plankSize.x, plankSize.z), "the wooden plank should remain visibly thin");

const stickSize = meshSize(createSmeltingMaterialPreviewMesh({ materialId: "wooden_stick" }));
assert.ok(stickSize.x >= Math.max(stickSize.y, stickSize.z) * 3, "the wooden stick should be one long rectangular unit");

function meshSize(mesh) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const vertex of mesh.vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], vertex.p[axis]);
      maximum[axis] = Math.max(maximum[axis], vertex.p[axis]);
    }
  }
  return {
    x: maximum[0] - minimum[0],
    y: maximum[1] - minimum[1],
    z: maximum[2] - minimum[2],
  };
}
