import assert from "node:assert/strict";
import { smeltingRules } from "../../src/data/smeltingRules.js";
import {
  SMELTING_MATERIAL_MODEL_IDS,
  SMELTING_MATERIAL_VISUAL_REVISION,
  createSmeltingMaterialPreviewMesh,
  hasSmeltingMaterialPreviewModel,
  smeltingMaterialModelDefinition,
  smeltingMaterialSurfaceProfile,
} from "../renderer/smelting-material-models.js";

const recipeIds = smeltingRules.materials.map((material) => material.id).sort();
const modelIds = [...SMELTING_MATERIAL_MODEL_IDS].sort();
assert.deepEqual(modelIds, recipeIds, "every public smelting recipe must have exactly one Chunk.js visual model");

const signatures = new Set();
const surfaceSignatures = new Set();
let totalTriangles = 0;
for (const materialId of modelIds) {
  assert.equal(hasSmeltingMaterialPreviewModel(materialId), true, `${materialId} should be registered`);
  const definition = smeltingMaterialModelDefinition(materialId);
  const surfaceProfile = smeltingMaterialSurfaceProfile(materialId);
  const mesh = createSmeltingMaterialPreviewMesh({ materialId });
  assert.equal(mesh.materialId, materialId);
  assert.equal(mesh.vertexFormat, "chunk-object");
  assert.ok(definition?.shape, `${materialId} should describe its silhouette`);
  assert.equal(surfaceProfile?.materialId, materialId);
  assert.equal(surfaceProfile?.visualRevision, SMELTING_MATERIAL_VISUAL_REVISION);
  assert.strictEqual(smeltingMaterialSurfaceProfile(materialId), surfaceProfile, `${materialId} should cache its surface profile`);
  assert.deepEqual(surfaceProfile?.palette, mesh.colors, `${materialId} surface colors must come from its canonical model palette`);
  assert.deepEqual(surfaceProfile?.baseColor, mesh.colors[0]);
  assert.deepEqual(surfaceProfile?.finish, {
    roughness: definition.roughness,
    translucency: definition.translucency,
    emissive: definition.emissive,
  });
  assert.ok(Object.isFrozen(surfaceProfile));
  assert.ok(Object.isFrozen(surfaceProfile.palette));
  surfaceSignatures.add(surfaceProfile.cacheSignature);
  assert.ok(mesh.vertexCount >= 72, `${materialId} should not fall back to one generic cube`);
  assert.ok(mesh.triangleCount >= 36 && mesh.triangleCount <= 120, `${materialId} must stay inside the icon geometry budget`);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3);
  assert.equal(mesh.vertexCount, mesh.vertices.length);
  assert.ok(mesh.colors.length >= 3, `${materialId} needs a material-specific baked palette`);
  for (const vertex of mesh.vertices) {
    assert.equal(vertex.p.length, 3);
    assert.ok(vertex.p.every(Number.isFinite), `${materialId} contains an invalid position`);
    assert.ok(vertex.n.every(Number.isFinite), `${materialId} contains an invalid normal`);
    assert.equal(vertex.color.length, 4);
    assert.ok(vertex.color.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255));
  }
  totalTriangles += mesh.triangleCount;
  signatures.add(JSON.stringify({
    triangles: mesh.triangleCount,
    colors: mesh.colors,
    sample: mesh.vertices.slice(0, 20).map((vertex) => vertex.p.map((value) => Number(value.toFixed(4)))),
  }));
}

assert.equal(signatures.size, modelIds.length, "smelting materials should not share duplicate baked models");
assert.equal(surfaceSignatures.size, modelIds.length, "smelting materials should expose unique surface cache signatures");
assert.ok(totalTriangles <= modelIds.length * 90, "the complete preview library should remain lightweight");
assert.equal(createSmeltingMaterialPreviewMesh({ materialId: "unknown" }).triangleCount, 0);
assert.equal(smeltingMaterialSurfaceProfile("unknown"), null);

const cottonCloth = smeltingMaterialSurfaceProfile("cotton_cloth");
assert.equal(cottonCloth?.className, "fiber");
assert.ok(cottonCloth?.finish.roughness >= 0.9, "cotton cloth should retain a rough woven finish");
for (const materialId of ["white_dye", "yellow_dye", "red_dye", "blue_dye", "pink_dye"]) {
  const dye = smeltingMaterialSurfaceProfile(materialId);
  assert.equal(dye?.className, "chemical", `${materialId} should use the chemical dye finish`);
  assert.ok(dye?.palette.length >= 3, `${materialId} should expose a saturated canonical palette`);
  const rgb = dye.baseColor.slice(0, 3);
  if (materialId === "white_dye") assert.ok(Math.min(...rgb) >= 220, "white dye should remain visibly pale");
  else assert.ok(Math.max(...rgb) - Math.min(...rgb) >= 100, `${materialId} should remain visibly saturated`);
}

console.log(`smelting material model tests passed: ${modelIds.length} models, ${totalTriangles} triangles`);
