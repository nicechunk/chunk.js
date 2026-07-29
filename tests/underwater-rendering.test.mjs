import assert from "node:assert/strict";
import test from "node:test";

import { CHUNK_VERTEX_STRIDE_BYTES, meshChunkVisual } from "../chunk/chunk-mesher.js";
import { ChunkState } from "../chunk/chunk-state.js";
import { createUnderwaterLighting, createWorldLighting } from "../renderer/lighting.js";
import { OPAQUE_FRAGMENT_SHADER } from "../renderer/shader-manager.js";
import { advanceUnderwaterBlend, cameraIsInsideFluid } from "../renderer/webgl2-renderer.js";
import { BLOCK_ID } from "../world/block-registry.js";

test("water surfaces include batched upward and downward faces", () => {
  const chunk = waterChunk();
  const mesh = meshChunkVisual(chunk);
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  const normalY = [];
  for (let offset = 0; offset < mesh.vertices.byteLength; offset += CHUNK_VERTEX_STRIDE_BYTES) {
    normalY.push(view.getInt8(offset + 9));
  }

  assert.equal(mesh.quadCount, 2, "a flat water patch should merge into one face per viewing side");
  assert.equal(mesh.indexCount, 12);
  assert.equal(normalY.filter((value) => value === 127).length, 4);
  assert.equal(normalY.filter((value) => value === -127).length, 4);
});

test("camera fluid detection follows the loaded chunk at negative world coordinates", () => {
  const chunk = waterChunk({ chunkX: -1 });
  const underwaterCamera = {
    worldX: -2,
    worldY: 1,
    worldZ: 0,
    localOffsetX: 0.25,
    localOffsetY: 0.25,
    localOffsetZ: 0.25,
  };

  assert.equal(cameraIsInsideFluid(underwaterCamera, [chunk]), true);
  assert.equal(cameraIsInsideFluid({ ...underwaterCamera, worldY: 2 }, [chunk]), false);
  assert.equal(cameraIsInsideFluid({ ...underwaterCamera, underwater: false }, [chunk]), false);
  const lavaChunk = waterChunk({ chunkX: -1, fluidBlockId: BLOCK_ID.lava });
  assert.equal(cameraIsInsideFluid(underwaterCamera, [lavaChunk]), false);
});

test("underwater lighting adds absorption without mutating world lighting", () => {
  const world = createWorldLighting({}, { mobile: false });
  assert.equal(createUnderwaterLighting(world, 0), world);

  const underwater = createUnderwaterLighting(world, 1);
  assert.notEqual(underwater, world);
  assert.deepEqual(underwater.fogNearFar, [6, 72]);
  assert.ok(underwater.fogColor[2] > underwater.fogColor[0]);
  assert.equal(underwater.sunDiscOpacity, 0);
  assert.equal(underwater.cloudOpacity, 0);
  assert.equal(world.underwaterBlend, 0);
  assert.equal(underwater.underwaterBlend, 1);
});

test("underwater transitions are smooth and the shader distinguishes the water underside", () => {
  const entering = advanceUnderwaterBlend(0, true, 100);
  const leaving = advanceUnderwaterBlend(entering, false, 100);

  assert.ok(entering > 0 && entering < 1);
  assert.ok(leaving > 0 && leaving < entering);
  assert.match(OPAQUE_FRAGMENT_SHADER, /uniform float uUnderwater;/);
  assert.match(OPAQUE_FRAGMENT_SHADER, /isWaterUnderside/);
  assert.match(OPAQUE_FRAGMENT_SHADER, /normal\.y < -0\.5/);
});

function waterChunk({ chunkX = 0, chunkZ = 0, fluidBlockId = BLOCK_ID.water } = {}) {
  return new ChunkState({
    chunkX,
    chunkZ,
    chunkSize: 2,
    height: 4,
    minY: 0,
    baseBlocksReady: true,
    baseBlockResolver: (_x, y) => y === 1 ? fluidBlockId : BLOCK_ID.air,
  });
}
