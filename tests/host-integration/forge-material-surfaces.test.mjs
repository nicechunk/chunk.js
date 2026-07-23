import assert from "node:assert/strict";
import { smeltingRules } from "../../../src/data/smeltingRules.js";
import {
  createForgeComponent,
  createForgeDesign,
  encodeNcf1Bytes,
} from "../../forge/forge-core.js";
import {
  FORGE_MESH_MATERIAL_LAYER_NONE,
  FORGE_MESH_MATERIAL_LAYER_OFFSET,
  FORGE_MESH_VERTEX_STRIDE_BYTES,
  buildForgeCuboidMesh,
  buildForgeDesignMesh,
} from "../../forge/forge-mesher.js";
import { ForgeWorkbenchRenderer } from "../../renderer/forge-workbench-renderer.js";

const paintedComponent = createForgeComponent({
  resourceId: "iron",
  color444: 0x789,
  dimsQ: [64, 64, 64],
  paintQuads: [{
    axis: 0,
    side: 1,
    plane: 14,
    u0: 0,
    u1: 10,
    v0: 0,
    v1: 14,
    color444: 0xf20,
  }],
});
const design = createForgeDesign({ components: [paintedComponent] });
const canonicalBytes = encodeNcf1Bytes(design);
const fallbackMesh = buildForgeDesignMesh(design);
const materialMesh = buildForgeDesignMesh(design, { componentMaterialLayers: [3] });

assert.equal(materialMesh.vertexStrideBytes, 16);
assert.equal(FORGE_MESH_VERTEX_STRIDE_BYTES, 16);
assert.equal(FORGE_MESH_MATERIAL_LAYER_OFFSET, 9);
assert.equal(materialMesh.byteLength, fallbackMesh.byteLength, "material layers must reuse the existing packed padding byte");
assert.deepEqual(encodeNcf1Bytes(design), canonicalBytes, "render-only material layers must not mutate canonical NCF1 data");

const materialView = new DataView(materialMesh.vertices.buffer, materialMesh.vertices.byteOffset, materialMesh.vertices.byteLength);
const fallbackView = new DataView(fallbackMesh.vertices.buffer, fallbackMesh.vertices.byteOffset, fallbackMesh.vertices.byteLength);
let paintedVertices = 0;
let texturedVertices = 0;
for (let vertex = 0; vertex < materialMesh.vertexCount; vertex += 1) {
  const cursor = vertex * FORGE_MESH_VERTEX_STRIDE_BYTES;
  const normalX = materialView.getInt8(cursor + 6);
  const normalY = materialView.getInt8(cursor + 7);
  const normalZ = materialView.getInt8(cursor + 8);
  const layer = materialView.getUint8(cursor + FORGE_MESH_MATERIAL_LAYER_OFFSET);
  assert.equal(fallbackView.getUint8(cursor + FORGE_MESH_MATERIAL_LAYER_OFFSET), FORGE_MESH_MATERIAL_LAYER_NONE);
  if (normalX === 127 && normalY === 0 && normalZ === 0) {
    assert.equal(layer, FORGE_MESH_MATERIAL_LAYER_NONE, "painted faces must preserve explicit RGB444 color");
    paintedVertices += 1;
  } else {
    assert.equal(layer, 3, "unpainted faces should sample the component material tile");
    texturedVertices += 1;
  }
}
assert.equal(paintedVertices, 4);
assert.equal(texturedVertices, 20);

const cuboid = buildForgeCuboidMesh([{ center: [0, 0, 0], size: [1, 1, 1], color444: 0x888 }]);
for (let cursor = FORGE_MESH_MATERIAL_LAYER_OFFSET; cursor < cuboid.vertices.length; cursor += FORGE_MESH_VERTEX_STRIDE_BYTES) {
  assert.equal(cuboid.vertices[cursor], FORGE_MESH_MATERIAL_LAYER_NONE, "bench, tools, and guides must remain vertex-colored");
}

const previousRequestFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = () => 1;
try {
  const renderer = new ForgeWorkbenchRenderer(fakeCanvas(), {
    controls: false,
    toolVisuals: false,
    forgeMaterialCatalog: smeltingRules,
  });
  renderer.setDesign(design, { componentMaterialIds: ["iron_bloom"] });
  assert.deepEqual(renderer.snapshot().componentMaterialIds, ["iron_bloom"]);
  assert.deepEqual(renderer.snapshot().materialIds, ["iron_bloom"]);
  assert.equal(renderer.snapshot().materialRuleSet, "nicechunk-smelting-v1");
  assert.equal(renderer.snapshot().materialCatalogSize, smeltingRules.materials.length);
  assert.ok(vertexLayers(renderer.dynamicMesh).every((layer) => layer === 0 || layer === FORGE_MESH_MATERIAL_LAYER_NONE));
  renderer.setDesign(design, { componentMaterialIds: ["iron"] });
  assert.deepEqual(renderer.snapshot().materialIds, []);
  assert.ok(vertexLayers(renderer.dynamicMesh).every((layer) => layer === FORGE_MESH_MATERIAL_LAYER_NONE));
  renderer.dispose();
} finally {
  if (previousRequestFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = previousRequestFrame;
}

console.log("forge material surface mesh tests passed");

function vertexLayers(mesh) {
  const layers = [];
  for (let cursor = FORGE_MESH_MATERIAL_LAYER_OFFSET; cursor < mesh.vertices.length; cursor += FORGE_MESH_VERTEX_STRIDE_BYTES) {
    layers.push(mesh.vertices[cursor]);
  }
  return layers;
}

function fakeCanvas() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
}
