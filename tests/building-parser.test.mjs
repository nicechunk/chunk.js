import assert from "node:assert/strict";
import { createBlueprint, encodeNcm3 } from "../ncm/blueprint-codec.js";
import {
  buildingFootprint,
  createBuildingPlacement,
  parseNcm3Building,
  rotateLocalVoxel,
  voxelKey,
} from "../construction/building-parser.js";
import { createBuildingChunkMeshes } from "../construction/building-mesher.js";

const source = createBlueprint({ x: 3, y: 2, z: 4 }, "One-to-one fixture")
  .box(3, 0, 0, 0, 1, 1, 1)
  .box(96, 2, 1, 3, 1, 1, 1);
const parsed = parseNcm3Building(encodeNcm3(source));
assert.equal(parsed.scale, 1);
assert.equal(parsed.voxelCount, 2);
assert.deepEqual(buildingFootprint(parsed.size, 1), { width: 4, depth: 3, height: 2, quarterTurns: 1 });
assert.deepEqual(rotateLocalVoxel(0, 0, parsed.size, 1), { x: 3, z: 0 });
assert.deepEqual(rotateLocalVoxel(2, 3, parsed.size, 1), { x: 0, z: 2 });

const placement = createBuildingPlacement(parsed, {
  id: "foundation:1",
  minX: 100,
  minZ: 200,
  surfaceY: 30,
  width: 4,
  depth: 3,
}, { quarterTurns: 1 });
assert.equal(placement.scale, 1);
assert.deepEqual(placement.origin, { x: 100, y: 30, z: 200 });
assert.equal(placement.worldVoxels.get(voxelKey(103, 30, 200)).material, 3);
assert.equal(placement.worldVoxels.get(voxelKey(100, 31, 202)).material, 96);
const shiftedPlacement = createBuildingPlacement(parsed, {
  id: "foundation:shifted",
  minX: 100,
  minZ: 200,
  surfaceY: 30,
  width: 8,
  depth: 7,
}, { quarterTurns: 1, offsetX: 2, offsetZ: -2 });
assert.deepEqual(shiftedPlacement.origin, { x: 104, y: 30, z: 200 });
assert.deepEqual(shiftedPlacement.offset, { x: 2, z: -2 });
assert.equal(shiftedPlacement.fitsFoundation, true);
const shiftedOverflow = createBuildingPlacement(parsed, {
  id: "foundation:shifted-overflow",
  minX: 100,
  minZ: 200,
  surfaceY: 30,
  width: 8,
  depth: 7,
}, { quarterTurns: 1, offsetX: 3, offsetZ: -2, allowFoundationOverflow: true });
assert.equal(shiftedOverflow.fitsFoundation, false);
assert.deepEqual(shiftedOverflow.origin, { x: 105, y: 30, z: 200 });
assert.throws(
  () => createBuildingPlacement(parsed, {
    id: "foundation:unsafe-offset",
    minX: Number.MAX_SAFE_INTEGER - 2,
    minZ: 0,
    surfaceY: 0,
    width: 3,
    depth: 4,
  }, { offsetX: 1, allowFoundationOverflow: true }),
  (error) => error?.code === "unsafe-coordinate",
  "placement offsets must not move a building beyond safe world coordinates",
);
assert.throws(
  () => createBuildingPlacement(parsed, {
    id: "foundation:unsafe-height",
    minX: 0,
    minZ: 0,
    surfaceY: Number.MAX_SAFE_INTEGER,
    width: 3,
    depth: 4,
  }),
  (error) => error?.code === "unsafe-coordinate",
  "a building's vertical range must remain within safe world coordinates",
);
assert.throws(
  () => createBuildingPlacement(parsed, { minX: 0, minZ: 0, surfaceY: 1, width: 3, depth: 3 }, { quarterTurns: 1 }),
  (error) => error?.code === "building-does-not-fit",
  "an undersized foundation must reject the building instead of scaling it",
);
const overflowPreview = createBuildingPlacement(parsed, {
  id: "foundation:preview-overflow",
  minX: 0,
  minZ: 0,
  surfaceY: 1,
  width: 3,
  depth: 3,
}, { quarterTurns: 1, allowFoundationOverflow: true });
assert.equal(overflowPreview.fitsFoundation, false, "preview placement must report that it exceeds the foundation");
assert.equal(overflowPreview.scale, 1, "an oversized preview must remain at exact 1:1 scale");
assert.deepEqual(overflowPreview.origin, { x: -1, y: 1, z: 0 }, "an oversized preview must stay centered on its foundation");
assert.ok(createBuildingChunkMeshes(overflowPreview).length > 0, "an oversized preview must still produce visible building chunks");

const twoVoxelCode = encodeNcm3(createBlueprint({ x: 2, y: 1, z: 1 }).box(96, 0, 0, 0, 2, 1, 1));
const twoVoxelPlacement = createBuildingPlacement(parseNcm3Building(twoVoxelCode), {
  id: "foundation:split",
  minX: 15,
  minZ: 0,
  surfaceY: 4,
  width: 2,
  depth: 1,
});
const chunkMeshes = createBuildingChunkMeshes(twoVoxelPlacement);
assert.equal(chunkMeshes.length, 2, "building meshes must partition across world chunks");
assert.equal(chunkMeshes.reduce((sum, chunk) => sum + chunk.mesh.quadCount, 0), 10, "the shared face must be culled across chunk boundaries");
for (const chunk of chunkMeshes) {
  const view = new DataView(chunk.mesh.vertices.buffer, chunk.mesh.vertices.byteOffset, chunk.mesh.vertices.byteLength);
  for (let offset = 0; offset < chunk.mesh.vertices.byteLength; offset += 20) {
    assert.equal(view.getUint16(offset + 16, true), 96, "canonical roof material layers must survive meshing");
  }
}

const glassCode = encodeNcm3(createBlueprint({ x: 2, y: 1, z: 1 })
  .box(3, 0, 0, 0)
  .box(58, 1, 0, 0));
const glassPlacement = createBuildingPlacement(parseNcm3Building(glassCode), {
  id: "foundation:glass",
  minX: 0,
  minZ: 0,
  surfaceY: 4,
  width: 2,
  depth: 1,
});
const [glassChunk] = createBuildingChunkMeshes(glassPlacement);
assert.equal(glassChunk.mesh.quadCount, 6, "opaque walls behind glass must retain their facing surface");
assert.equal(glassChunk.visualMesh.quadCount, 5, "glass must omit the hidden face touching an opaque block");
assert.equal(glassChunk.visualMeshVersion, glassChunk.meshVersion);
assert.equal(glassChunk.mesh.blockCount, 1);
assert.equal(glassChunk.visualMesh.blockCount, 1);
assert.deepEqual(meshLayers(glassChunk.mesh), [3]);
assert.deepEqual(meshLayers(glassChunk.visualMesh), [58]);

console.log("NCM3 one-to-one building parser tests passed");

function meshLayers(mesh) {
  const layers = new Set();
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  for (let offset = 0; offset < mesh.vertices.byteLength; offset += 20) layers.add(view.getUint16(offset + 16, true));
  return [...layers].sort((left, right) => left - right);
}
